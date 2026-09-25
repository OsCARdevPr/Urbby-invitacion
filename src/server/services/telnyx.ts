import crypto from 'node:crypto';
import { config } from '../config';
import type { TelnyxApproval } from '../../shared/types';

// Cliente mínimo de Telnyx para WhatsApp por la API oficial: crear la plantilla (con la imagen de muestra que
// pide Meta), consultar si Meta la aprobó y enviar mensajes con ella. Sin SDK: fetch con la API key.

const API = 'https://api.telnyx.com/v2';

export class TelnyxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Código de error de Telnyx ("40008"…), si vino. */
    readonly code: string | null = null,
    readonly notOnWhatsApp = false,
    /** La petición salió pero no hubo respuesta: el mensaje pudo haberse enviado. */
    readonly uncertain = false,
  ) {
    super(message);
  }
}

type TelnyxErrorItem = { code?: string | number; title?: string; detail?: string };

/** Meta: 131026 = el número no puede recibir el mensaje (no tiene WhatsApp, app vieja o no aceptó los términos). */
const NOT_ON_WHATSAPP = /\b131026\b/;

/** Errores de Meta y Telnyx más comunes, en palabras del panel. Los demás se muestran con el texto que venga. */
const KNOWN_ERRORS: [RegExp, string][] = [
  [/\b131049\b/, 'Meta no entregó el mensaje de marketing: limita cuántos recibe cada persona. Prueba otro día'],
  [/\b131026\b/, 'El número no puede recibir WhatsApp (no tiene cuenta, tiene una app muy vieja o no aceptó los términos)'],
  [/\b131047\b/, 'WhatsApp exige una plantilla aprobada para escribirle a alguien que no te ha escrito en 24 h'],
  [/\b(130429|40011)\b/, 'Se superó el ritmo de envío permitido: la campaña esperará y seguirá'],
  [/\b131053\b/, 'WhatsApp no pudo descargar la tarjeta: revisa que PUBLIC_BASE_URL sea pública con https'],
];

/** Texto legible de una lista de errores de Telnyx (o de la parte de Meta que traen). */
export function describeErrors(errors: TelnyxErrorItem[] | undefined, fallback: string): string {
  const e = errors?.[0];
  if (!e) return fallback;
  const raw = [e.code, e.title, e.detail].filter(Boolean).join(' · ');
  for (const [re, text] of KNOWN_ERRORS) if (re.test(raw)) return text;
  return e.detail || e.title || fallback;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: object | FormData, timeoutMs = 30_000): Promise<T> {
  if (!config.telnyx.apiKey) throw new TelnyxError('Falta TELNYX_API_KEY', 0);
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.telnyx.apiKey}`,
        Accept: 'application/json',
        ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    throw new TelnyxError(
      timedOut
        ? 'Telnyx no respondió a tiempo: el mensaje pudo haberse enviado, revísalo en el portal de Telnyx'
        : `No se pudo conectar con Telnyx: ${(err as Error).message}`,
      0,
      null,
      false,
      timedOut && method === 'POST',
    );
  }

  const text = await res.text();
  let data: { data?: unknown; errors?: TelnyxErrorItem[] } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta no JSON */
  }
  if (!res.ok) {
    const first = data?.errors?.[0];
    const code = first?.code !== undefined ? String(first.code) : null;
    const message =
      res.status === 401
        ? 'Telnyx rechazó la API key: revisa TELNYX_API_KEY'
        : describeErrors(data?.errors, `Telnyx respondió ${res.status}: ${text.slice(0, 300)}`);
    const raw = JSON.stringify(data?.errors ?? '');
    throw new TelnyxError(message, res.status, code, NOT_ON_WHATSAPP.test(raw));
  }
  return (data?.data ?? null) as T;
}

// ── Cuenta ───────────────────────────────────────────────────────

/** Confirma la API key y devuelve el saldo de la cuenta (cada mensaje de marketing tiene costo). */
export async function accountBalance(): Promise<{ balance: string; currency: string }> {
  const d = await call<{ balance?: string; currency?: string }>('GET', '/balance', undefined, 10_000);
  return { balance: String(d?.balance ?? '?'), currency: String(d?.currency ?? '') };
}

/** Confirma que la cuenta de WhatsApp Business (TELNYX_WABA_ID) es accesible, contando sus plantillas aprobadas. */
export async function listApprovedTemplates(): Promise<number> {
  const params = new URLSearchParams({ 'filter[waba_id]': config.telnyx.wabaId, 'filter[status]': 'APPROVED', 'page[size]': '50' });
  const d = await call<unknown[]>('GET', `/whatsapp/message_templates?${params}`, undefined, 10_000);
  return Array.isArray(d) ? d.length : 0;
}

// ── Plantillas ───────────────────────────────────────────────────

/**
 * Sube la imagen de muestra de la cabecera. Meta la pide para revisar la plantilla; al enviar, cada invitado
 * recibe su propia tarjeta. Devuelve el "handle" que va en el ejemplo de la plantilla.
 */
export async function uploadSampleImage(png: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'tarjeta-muestra.png');
  const d = await call<{ id?: string; handle?: string }>('POST', '/whatsapp/media/upload', form, 60_000);
  const handle = d?.id ?? d?.handle;
  if (!handle) throw new TelnyxError('Telnyx no devolvió el identificador de la imagen de muestra', 0);
  return handle;
}

/** Crea la plantilla de marketing (imagen + texto) y la envía a revisión de Meta. Devuelve su id en Telnyx. */
export async function createTemplate(opts: {
  name: string;
  language: string;
  body: string;
  bodyExample: string[];
  imageHandle: string;
}): Promise<{ id: string; status: TelnyxApproval }> {
  const d = await call<{ id?: string; status?: string }>('POST', '/whatsapp/message_templates', {
    waba_id: config.telnyx.wabaId,
    name: opts.name,
    category: 'MARKETING',
    language: opts.language,
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: [opts.imageHandle] } },
      { type: 'BODY', text: opts.body, ...(opts.bodyExample.length ? { example: { body_text: [opts.bodyExample] } } : {}) },
    ],
  });
  if (!d?.id) throw new TelnyxError('Telnyx no devolvió el identificador de la plantilla', 0);
  return { id: d.id, status: approvalFrom(d.status) };
}

const approvalFrom = (raw: unknown): TelnyxApproval => {
  const s = String(raw ?? '').toLowerCase();
  return s === 'pending' || s === 'approved' || s === 'rejected' || s === 'paused' || s === 'disabled' ? s : 'unknown';
};

/** Estado de aprobación de Meta, con el motivo si la rechazó. */
export async function templateApproval(id: string): Promise<{ status: TelnyxApproval; reason: string | null }> {
  const d = await call<{ status?: string; rejection_reason?: string | null }>('GET', `/whatsapp/message_templates/${encodeURIComponent(id)}`, undefined, 10_000);
  const reason = d?.rejection_reason && d.rejection_reason !== 'NONE' ? d.rejection_reason : null;
  return { status: approvalFrom(d?.status), reason };
}

// ── Envío ────────────────────────────────────────────────────────

/**
 * Envía la plantilla aprobada: la tarjeta del invitado como imagen de cabecera (Telnyx la descarga de
 * `imageUrl`) y los valores del texto. Devuelve el id del mensaje, que luego llega en los avisos de estado.
 */
export async function sendTemplate(opts: {
  to: string; // solo dígitos con código de país
  name: string;
  language: string;
  imageUrl: string;
  bodyValues: string[];
  webhookUrl: string | null;
}): Promise<{ id: string }> {
  const d = await call<{ id?: string }>('POST', '/messages/whatsapp', {
    from: config.telnyx.from,
    to: `+${opts.to}`,
    ...(opts.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
    whatsapp_message: {
      type: 'template',
      template: {
        name: opts.name,
        language: { policy: 'deterministic', code: opts.language },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: opts.imageUrl } }] },
          ...(opts.bodyValues.length ? [{ type: 'body', parameters: opts.bodyValues.map((text) => ({ type: 'text', text })) }] : []),
        ],
      },
    },
  });
  if (!d?.id) throw new TelnyxError('Telnyx no devolvió el identificador del mensaje', 0, null, false, true);
  return { id: d.id };
}

// ── Avisos de estado ─────────────────────────────────────────────

/** Telnyx avisa aquí de cada cambio de estado. Solo con https y con la llave pública para verificar la firma. */
export const telnyxWebhookUrl = () =>
  config.publicBaseUrl.startsWith('https://') && config.telnyx.publicKey ? `${config.publicBaseUrl}/api/webhooks/telnyx` : null;

/** Máxima diferencia aceptada entre el sello de tiempo del aviso y la hora del servidor (como el SDK oficial). */
const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Verifica la firma Ed25519 de un aviso: Telnyx firma `${telnyx-timestamp}|${cuerpo crudo}` con su llave
 * privada; la llave pública (base64, 32 bytes) está en el portal → Keys & Credentials → Public Key.
 */
export function validSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  publicKey = config.telnyx.publicKey,
  nowSec = Date.now() / 1000,
): boolean {
  if (!timestamp || !signature || !publicKey) return false;
  if (!Number.isFinite(Number(timestamp)) || Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SEC) return false;
  try {
    const key = crypto.createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') },
    });
    return crypto.verify(null, Buffer.from(`${timestamp}|${rawBody}`, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** ¿La llave pública configurada tiene el formato correcto? (para el diagnóstico) */
export function publicKeyValid(publicKey = config.telnyx.publicKey): boolean {
  try {
    return Buffer.from(publicKey, 'base64').length === 32;
  } catch {
    return false;
  }
}

export type MessageUpdate = 'sent' | 'delivered' | 'read' | 'failed' | 'no_whatsapp';

/** Estado de Telnyx (y tipo de aviso) → estado de la app. Los intermedios (queued, sending…) no cambian nada. */
export function mapTelnyxStatus(eventType: string, status: string, errors: TelnyxErrorItem[] | undefined): MessageUpdate | null {
  if (eventType === 'message.read' || status === 'read') return 'read';
  if (status === 'delivered' || eventType === 'message.delivered') return 'delivered';
  if (status === 'sent') return 'sent';
  if (['sending_failed', 'delivery_failed', 'undeliverable', 'expired', 'failed'].includes(status) || eventType === 'message.failed') {
    return status === 'undeliverable' || NOT_ON_WHATSAPP.test(JSON.stringify(errors ?? '')) ? 'no_whatsapp' : 'failed';
  }
  return null;
}
