import { config, evolutionConfigured } from '../config';

// Cliente mínimo de Evolution API v2. Solo usa los endpoints que necesita la campaña:
// sendMedia (que ya verifica si el número tiene WhatsApp), connectionState y webhook/set.
// No se llama a /chat/whatsappNumbers en lote: hay reportes de cuentas restringidas por hacerlo.

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly notOnWhatsApp = false,
    /** La petición salió pero no hubo respuesta: el mensaje pudo haberse enviado. */
    readonly uncertain = false,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!evolutionConfigured()) throw new EvolutionError('Evolution API no está configurada', 0, null);
  let res: Response;
  try {
    res = await fetch(`${config.evolution.url}${path}`, {
      method,
      headers: { apikey: config.evolution.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
    throw new EvolutionError(
      timedOut
        ? 'Evolution no respondió a tiempo: el mensaje pudo haberse enviado, revisa el chat'
        : `No se pudo conectar con Evolution: ${(err as Error).message}`,
      0,
      null,
      false,
      timedOut,
    );
  }

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta no JSON: se deja como texto */
  }
  if (!res.ok) {
    const notOnWhatsApp = res.status === 400 && /"exists"\s*:\s*false/.test(text);
    const detail = typeof data === 'object' && data ? JSON.stringify(data).slice(0, 300) : String(text).slice(0, 300);
    throw new EvolutionError(
      notOnWhatsApp ? 'El número no tiene WhatsApp' : `Evolution respondió ${res.status}: ${detail}`,
      res.status,
      data,
      notOnWhatsApp,
    );
  }
  return data as T;
}

const inst = () => encodeURIComponent(config.evolution.instance);

/** 'open' cuando el teléfono está vinculado y conectado. */
export async function connectionState(): Promise<string> {
  const data = await call<{ instance?: { state?: string }; state?: string }>('GET', `/instance/connectionState/${inst()}`);
  return data?.instance?.state ?? data?.state ?? 'unknown';
}

/**
 * Envía la tarjeta con su texto. Durante `delayMs` WhatsApp muestra "escribiendo…" al invitado,
 * como haría una persona, y luego llega el mensaje. Devuelve el id del mensaje de WhatsApp.
 */
export async function sendImage(opts: {
  number: string;
  caption: string;
  png: Buffer;
  fileName: string;
  delayMs: number;
}): Promise<{ messageId: string | null }> {
  const data = await call<{ key?: { id?: string } }>(
    'POST',
    `/message/sendMedia/${inst()}`,
    {
      number: opts.number,
      mediatype: 'image',
      mimetype: 'image/png',
      caption: opts.caption,
      media: opts.png.toString('base64'),
      fileName: opts.fileName,
      delay: opts.delayMs,
    },
    opts.delayMs + 90_000,
  );
  return { messageId: data?.key?.id ?? null };
}

export const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE'];

/**
 * Apunta el webhook de la instancia a esta app. Las versiones de v2 difieren en la forma del body:
 * primero se intenta la anidada (2.2+) y, si Evolution la rechaza, la plana (2.0–2.1).
 */
export async function setWebhook(url: string): Promise<void> {
  try {
    await call('POST', `/webhook/set/${inst()}`, {
      webhook: { enabled: true, url, byEvents: false, base64: false, events: WEBHOOK_EVENTS },
    });
  } catch (err) {
    if (!(err instanceof EvolutionError) || err.status !== 400) throw err;
    await call('POST', `/webhook/set/${inst()}`, {
      enabled: true,
      url,
      webhookByEvents: false,
      webhookBase64: false,
      events: WEBHOOK_EVENTS,
    });
  }
}
