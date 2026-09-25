import { Hono, type Context } from 'hono';
import { requireRole, type AppEnv } from '../auth';
import { config, publicUrlIsLocal, telnyxConfigured } from '../config';
import { exec, getEvent, nowIso } from '../db';
import type { EventRow, TelnyxApproval, TelnyxTemplate } from '../../shared/types';
import { templateVars } from '../../shared/template';
import { templateBodyProblems, templateValues, toTemplateBody } from '../../shared/telnyxTemplate';
import { renderCardPng } from '../services/card';
import { createTemplate, describeErrors, mapTelnyxStatus, templateApproval, uploadSampleImage, validSignature } from '../services/telnyx';
import { advanceByMessageId, failByMessageId } from '../services/webhook';
import { parseId } from './util';

// WhatsApp por la API oficial (Telnyx): la plantilla de cada evento y los avisos de entrega.

const LANGUAGE = 'es';

/** Invitado ficticio para la muestra que revisa Meta: nunca se usa el nombre de un invitado real. */
const SAMPLE_GUEST = { name: 'María José Hernández', business: 'Pupusería La Esquina', token: 'muestra' };

async function templateInfo(event: EventRow) {
  const template = event.telnyx_template;
  let approval: { status: TelnyxApproval; reason: string | null } | null = null;
  let checkError: string | null = null;
  if (template) {
    try {
      approval = await templateApproval(template.id);
    } catch (err) {
      checkError = `No se pudo consultar el estado en Telnyx: ${(err as Error).message}`;
    }
  }
  return {
    template,
    approval,
    checkError,
    textChanged: Boolean(template && template.text !== event.wa_template),
    problems: templateBodyProblems(event.wa_template),
  };
}

export const telnyxRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))

  .get('/events/:id/template', async (c) => {
    const event = await getEvent(parseId(c.req.param('id')));
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);
    return c.json(await templateInfo(event));
  })

  // Crea la plantilla con el texto actual del evento y la envía a revisión de Meta como MARKETING.
  .post('/events/:id/template', async (c) => {
    const event = await getEvent(parseId(c.req.param('id')));
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);
    if (!telnyxConfigured()) return c.json({ error: 'Configura TELNYX_API_KEY y TELNYX_WHATSAPP_FROM en el servidor.' }, 400);
    if (!config.telnyx.wabaId) {
      return c.json({ error: 'Falta TELNYX_WABA_ID: es la cuenta de WhatsApp Business donde se crean las plantillas.' }, 400);
    }
    const problems = templateBodyProblems(event.wa_template);
    if (problems.length) return c.json({ error: problems[0] }, 400);

    const { body, variables } = toTemplateBody(event.wa_template);
    const example = templateValues(variables, templateVars(event, SAMPLE_GUEST));
    try {
      // Meta revisa la plantilla con una imagen de muestra: la tarjeta del evento con un invitado ficticio.
      const handle = await uploadSampleImage(await renderCardPng(event, SAMPLE_GUEST));
      // Nombre único: una plantilla de Meta no se puede editar sin volver a revisión, así que cada versión es nueva.
      const name = `invitacion_${event.id}_${Date.now().toString(36)}`;
      const { id } = await createTemplate({ name, language: LANGUAGE, body, bodyExample: example, imageHandle: handle });
      const template: TelnyxTemplate = { id, name, language: LANGUAGE, text: event.wa_template, variables, createdAt: nowIso() };
      await exec('UPDATE events SET telnyx_template = $1 WHERE id = $2', [JSON.stringify(template), event.id]);
      return c.json(await templateInfo({ ...event, telnyx_template: template }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

/**
 * Avisos de estado de Telnyx (enviado, entregado, leído, fallido). Se verifica la firma Ed25519 sobre el cuerpo
 * crudo antes de tocar nada. Telnyx espera respuesta en menos de 2 s.
 */
export async function handleTelnyxWebhook(c: Context) {
  const raw = await c.req.text();
  if (!validSignature(raw, c.req.header('telnyx-timestamp'), c.req.header('telnyx-signature-ed25519'))) {
    return c.json({ error: 'firma no válida' }, 401);
  }
  let body: { data?: { event_type?: string; payload?: Record<string, any> } };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ ok: true });
  }
  const payload = body.data?.payload;
  const id = typeof payload?.id === 'string' ? payload.id : null;
  if (!id) return c.json({ ok: true });

  const errors = Array.isArray(payload?.errors) ? payload.errors : undefined;
  const update = mapTelnyxStatus(String(body.data?.event_type ?? ''), String(payload?.to?.[0]?.status ?? ''), errors);
  if (update === 'failed' || update === 'no_whatsapp') {
    await failByMessageId(id, update, describeErrors(errors, 'Telnyx no pudo entregar el mensaje'));
  } else if (update) {
    await advanceByMessageId(id, update);
  }
  return c.json({ ok: true });
}

/** Para el diagnóstico: ¿Telnyx puede descargar las tarjetas de esta app? */
export const cardsReachable = () => !publicUrlIsLocal() && config.publicBaseUrl.startsWith('https://');
