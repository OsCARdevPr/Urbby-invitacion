import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { config, publicUrlIsLocal, resendConfigured } from '../config';
import { getEvent, nowIso } from '../db';
import type { GuestRow } from '../../shared/types';
import { renderTemplate, templateVars } from '../../shared/template';
import { renderCardPng } from '../services/card';
import { resendDomainStatus, sendInvitationEmail } from '../services/email';
import { EvolutionError, findWebhook, instanceInfo, sendImage, serverInfo, verifyApiKey } from '../services/evolution';
import { formatPhone, normalizePhone } from '../services/phone';
import { clean, isEmail } from '../services/text';
import { webhookUrl } from './wa';
import { accountBalance, listApprovedTemplates, publicKeyValid } from '../services/telnyx';
import { cardsReachable } from './telnyx';

// Prueba de conexiones: revisa Evolution y Resend paso por paso, y envía una invitación de prueba
// con los datos que escriba el admin. Nada de esto toca la base de datos ni la cola de la campaña.

/** ok: true = bien · false = falla · null = no se pudo probar (depende de un paso anterior) o es solo un aviso. */
export interface Step {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
  ms?: number;
}

async function timed(fn: () => Promise<string>): Promise<{ ok: boolean; detail: string; ms: number }> {
  const t = Date.now();
  try {
    return { ok: true, detail: await fn(), ms: Date.now() - t };
  } catch (err) {
    return { ok: false, detail: (err as Error).message, ms: Date.now() - t };
  }
}

const describeEvolutionError = (err: unknown) => {
  if (err instanceof EvolutionError && (err.status === 401 || err.status === 403)) return 'Evolution rechazó la API key';
  return (err as Error).message;
};

// Una prueba cada 20 s: es para probar, no un atajo para saltarse el ritmo de la campaña.
let lastTestAt = 0;
const TEST_COOLDOWN_MS = 20_000;

const testSchema = z.object({
  eventId: z.number().int(),
  name: z.string(),
  business: z.string(),
  phone: z.string(),
  email: z.string(),
  whatsapp: z.boolean(),
  sendEmail: z.boolean(),
});

export const diagnosticsRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))

  .get('/evolution', async (c) => {
    const e = config.evolution;
    const missing = [!e.url && 'EVOLUTION_URL', !e.apiKey && 'EVOLUTION_API_KEY', !e.instance && 'EVOLUTION_INSTANCE'].filter(Boolean);
    const steps: Step[] = [
      {
        key: 'config',
        label: 'Variables de entorno',
        ok: missing.length === 0,
        detail: missing.length ? `Falta ${missing.join(', ')} en el .env` : `Instancia "${e.instance}"`,
      },
    ];
    const skip = (key: string, label: string, why: string) => steps.push({ key, label, ok: null, detail: why });

    // 1. Servidor
    let serverOk = false;
    if (!e.url) {
      skip('server', 'Servidor de Evolution', 'Sin EVOLUTION_URL no se puede probar');
    } else {
      const r = await timed(async () => {
        const { version } = await serverInfo();
        return version ? `Responde · Evolution API v${version}` : 'Responde';
      });
      serverOk = r.ok;
      steps.push({ key: 'server', label: 'Servidor de Evolution', ...r });
    }

    // 2. API key
    let keyOk = false;
    if (!serverOk || !e.apiKey) {
      skip('apikey', 'API key', !e.apiKey ? 'Falta EVOLUTION_API_KEY' : 'Primero tiene que responder el servidor');
    } else {
      const t = Date.now();
      try {
        await verifyApiKey();
        keyOk = true;
        steps.push({ key: 'apikey', label: 'API key', ok: true, detail: 'Aceptada', ms: Date.now() - t });
      } catch (err) {
        steps.push({ key: 'apikey', label: 'API key', ok: false, detail: describeEvolutionError(err), ms: Date.now() - t });
      }
    }

    // 3. Instancia y 4. WhatsApp vinculado
    let linkedNumber: string | null = null;
    let connected = false;
    let instanceExists = false;
    if (!keyOk || !e.instance) {
      skip('instance', 'Instancia', !e.instance ? 'Falta EVOLUTION_INSTANCE' : 'Primero tiene que aceptarse la API key');
      skip('whatsapp', 'WhatsApp vinculado', 'Depende de la instancia');
    } else {
      const t = Date.now();
      try {
        const info = await instanceInfo();
        if (!info.exists) {
          steps.push({ key: 'instance', label: 'Instancia', ok: false, detail: `No existe una instancia llamada "${e.instance}"`, ms: Date.now() - t });
          skip('whatsapp', 'WhatsApp vinculado', 'Depende de la instancia');
        } else {
          instanceExists = true;
          steps.push({ key: 'instance', label: 'Instancia', ok: true, detail: `"${e.instance}" existe`, ms: Date.now() - t });
          linkedNumber = info.number;
          connected = info.state === 'open';
          steps.push({
            key: 'whatsapp',
            label: 'WhatsApp vinculado',
            ok: connected,
            detail: connected
              ? `Conectado${info.number ? ` al ${formatPhone(info.number)}` : ''}${info.profileName ? ` (${info.profileName})` : ''}`
              : `Estado "${info.state}": abre el manager de Evolution y escanea el QR con el teléfono secundario`,
          });
        }
      } catch (err) {
        steps.push({ key: 'instance', label: 'Instancia', ok: false, detail: describeEvolutionError(err), ms: Date.now() - t });
        skip('whatsapp', 'WhatsApp vinculado', 'Depende de la instancia');
      }
    }

    // 5. Webhook: solo aviso, la campaña funciona sin él (pero sin estados de entrega)
    const expected = config.webhookSecret ? webhookUrl() : null;
    if (!instanceExists) {
      skip('webhook', 'Webhook', 'Depende de la instancia');
    } else {
      try {
        const w = await findWebhook();
        const pointsHere = Boolean(w?.enabled && expected && w.url === expected);
        steps.push({
          key: 'webhook',
          label: 'Webhook',
          ok: pointsHere ? true : null,
          detail: pointsHere
            ? 'Apunta a esta app: llegan los estados de entrega y lectura'
            : publicUrlIsLocal()
              ? 'En desarrollo Evolution no puede llamar a tu PC: los estados de entrega solo llegarán en producción'
              : !w
                ? 'No está configurado: usa "Configurar en Evolution" en la página de WhatsApp'
                : `Apunta a otra URL (${w.url}): usa "Configurar en Evolution" en la página de WhatsApp`,
        });
      } catch (err) {
        steps.push({ key: 'webhook', label: 'Webhook', ok: null, detail: `No se pudo consultar: ${describeEvolutionError(err)}` });
      }
    }

    const display = config.senderPhoneDisplay.replace(/\D/g, '');
    return c.json({
      steps,
      ready: connected,
      linkedNumber: linkedNumber ? formatPhone(linkedNumber) : null,
      senderPhoneMismatch: Boolean(linkedNumber && display !== linkedNumber),
    });
  })

  .get('/telnyx', async (c) => {
    const t = config.telnyx;
    const missing = [!t.apiKey && 'TELNYX_API_KEY', !t.from && 'TELNYX_WHATSAPP_FROM'].filter(Boolean);
    const steps: Step[] = [
      {
        key: 'config',
        label: 'Variables de entorno',
        ok: missing.length === 0,
        detail: missing.length ? `Falta ${missing.join(', ')} en el .env` : `Envía desde el ${t.from}`,
      },
    ];

    // 1. API key (y saldo: cada mensaje de marketing tiene costo)
    let keyOk = false;
    if (!t.apiKey) {
      steps.push({ key: 'apikey', label: 'API key', ok: null, detail: 'Falta TELNYX_API_KEY' });
    } else {
      const r = await timed(async () => {
        const { balance, currency } = await accountBalance();
        return `Aceptada · saldo ${balance} ${currency}`.trim();
      });
      keyOk = r.ok;
      steps.push({ key: 'apikey', label: 'API key', ...r });
    }

    // 2. Cuenta de WhatsApp Business: hace falta para crear las plantillas
    if (!keyOk) {
      steps.push({ key: 'waba', label: 'Cuenta de WhatsApp Business', ok: null, detail: 'Primero tiene que aceptarse la API key' });
    } else if (!t.wabaId) {
      steps.push({ key: 'waba', label: 'Cuenta de WhatsApp Business', ok: false, detail: 'Falta TELNYX_WABA_ID: sin ella no se pueden crear las plantillas' });
    } else {
      const r = await timed(async () => {
        const n = await listApprovedTemplates();
        return `Accesible · ${n} plantilla${n === 1 ? '' : 's'} aprobada${n === 1 ? '' : 's'}`;
      });
      steps.push({ key: 'waba', label: 'Cuenta de WhatsApp Business', ...r });
    }

    // 3. Tarjetas: Telnyx descarga la de cada invitado de PUBLIC_BASE_URL
    const reachable = cardsReachable();
    steps.push({
      key: 'cards',
      label: 'Tarjetas públicas',
      ok: reachable,
      detail: reachable
        ? `Telnyx descarga cada tarjeta de ${config.publicBaseUrl}/i/…`
        : 'PUBLIC_BASE_URL debe ser la URL pública con https: Telnyx descarga de ahí la tarjeta de cada invitado',
    });

    // 4. Avisos de entrega: solo aviso, el envío funciona sin ellos
    steps.push({
      key: 'webhook',
      label: 'Estados de entrega',
      ok: !t.publicKey ? null : publicKeyValid(),
      detail: !t.publicKey
        ? 'Sin TELNYX_PUBLIC_KEY no se reciben los estados de entrega y lectura (el envío funciona igual)'
        : publicKeyValid()
          ? reachable
            ? 'Cada mensaje pide sus avisos a esta app, con la firma verificada'
            : 'La llave es válida, pero los avisos solo llegan con PUBLIC_BASE_URL pública con https'
          : 'TELNYX_PUBLIC_KEY no tiene el formato esperado (base64 de 32 bytes, del portal → Keys & Credentials → Public Key)',
    });

    return c.json({ steps, ready: steps.every((s) => s.ok !== false) });
  })

  .get('/email', async (c) => {
    const from = config.resend.from;
    const domain = from.match(/@([^>\s]+)/)?.[1] ?? '';
    const steps: Step[] = [
      {
        key: 'config',
        label: 'Variables de entorno',
        ok: resendConfigured(),
        detail: resendConfigured() ? `Remitente: ${from}` : 'Falta RESEND_API_KEY en el .env',
      },
    ];
    if (!resendConfigured()) {
      steps.push({ key: 'domain', label: `Dominio ${domain || 'remitente'}`, ok: null, detail: 'Sin RESEND_API_KEY no se puede probar' });
      return c.json({ steps, ready: false });
    }
    const t = Date.now();
    try {
      const { status, restricted } = await resendDomainStatus(domain);
      const ms = Date.now() - t;
      steps.push(
        restricted
          ? { key: 'domain', label: `Dominio ${domain}`, ok: null, ms, detail: 'La clave es "solo envío" y no puede ver dominios (es lo normal). Envía un correo de prueba para confirmar.' }
          : status === 'verified'
            ? { key: 'domain', label: `Dominio ${domain}`, ok: true, ms, detail: 'Verificado: los correos pueden salir' }
            : status === 'missing'
              ? { key: 'domain', label: `Dominio ${domain}`, ok: false, ms, detail: `${domain} no está agregado en Resend → Domains` }
              : { key: 'domain', label: `Dominio ${domain}`, ok: false, ms, detail: `Estado "${status}": faltan registros DNS o aún se están verificando` },
      );
    } catch (err) {
      steps.push({ key: 'domain', label: `Dominio ${domain}`, ok: false, ms: Date.now() - t, detail: (err as Error).message });
    }
    return c.json({ steps, ready: steps.every((s) => s.ok !== false) });
  })

  // Envía la invitación real (tarjeta + texto del evento) a los datos de prueba. No se guarda nada.
  .post('/test-send', async (c) => {
    const parsed = testSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Datos no válidos' }, 400);
    const input = parsed.data;
    const event = await getEvent(input.eventId);
    if (!event) return c.json({ error: 'Elige un evento' }, 400);
    if (!input.whatsapp && !input.sendEmail) return c.json({ error: 'Elige al menos un canal' }, 400);

    const name = clean(input.name);
    if (!name) return c.json({ error: 'Escribe un nombre' }, 400);
    let phone: string | null = null;
    if (input.whatsapp) {
      const p = normalizePhone(input.phone);
      if (!p.ok) return c.json({ error: `Teléfono: ${p.error}` }, 400);
      phone = p.phone;
    }
    const email = input.email.trim().toLowerCase();
    if (input.sendEmail && !isEmail(email)) return c.json({ error: 'Correo no válido' }, 400);

    const wait = lastTestAt + TEST_COOLDOWN_MS - Date.now();
    if (wait > 0) return c.json({ error: `Espera ${Math.ceil(wait / 1000)} s antes de otra prueba` }, 429);
    lastTestAt = Date.now();

    // Invitado de prueba en memoria. Su QR usa un código que no existe en la base: al escanearlo dice "QR no válido".
    const guest = {
      id: 0,
      event_id: event.id,
      name,
      business: clean(input.business),
      phone,
      email: input.sendEmail ? email : null,
      token: nanoid(21),
      created_at: nowIso(),
    } as GuestRow;

    const png = await renderCardPng(event, guest);
    const result: { whatsapp?: { ok: boolean; detail: string }; email?: { ok: boolean; detail: string } } = {};

    if (input.whatsapp && phone) {
      try {
        const { messageId } = await sendImage({
          number: phone,
          caption: renderTemplate(event.wa_template, templateVars(event, guest)),
          png,
          fileName: 'invitacion.png',
          delayMs: 2000,
        });
        result.whatsapp = { ok: true, detail: `Enviado al ${formatPhone(phone)}${messageId ? ` · id ${messageId}` : ''}` };
      } catch (err) {
        result.whatsapp = { ok: false, detail: describeEvolutionError(err) };
      }
    }

    if (input.sendEmail) {
      try {
        const { id } = await sendInvitationEmail(event, guest, png, `prueba-${guest.token}`);
        result.email = { ok: true, detail: `Enviado a ${email}${id ? ` · id ${id}` : ''}` };
      } catch (err) {
        result.email = { ok: false, detail: (err as Error).message };
      }
    }

    return c.json(result);
  });
