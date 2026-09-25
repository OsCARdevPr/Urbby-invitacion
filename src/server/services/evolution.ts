import { config } from '../config';

// Cliente mínimo de Evolution API v2. La campaña usa sendMedia (que ya verifica si el número
// tiene WhatsApp), connectionState y webhook/set; el diagnóstico agrega consultas de solo lectura.
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
  // Cada variable se revisa por separado para que el diagnóstico diga exactamente cuál falta.
  if (!config.evolution.url) throw new EvolutionError('Falta EVOLUTION_URL', 0, null);
  if (path !== '/' && !config.evolution.apiKey) throw new EvolutionError('Falta EVOLUTION_API_KEY', 0, null);
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

const inst = () => {
  if (!config.evolution.instance) throw new EvolutionError('Falta EVOLUTION_INSTANCE', 0, null);
  return encodeURIComponent(config.evolution.instance);
};

// ── Diagnóstico (solo lectura) ───────────────────────────────────
// Varias respuestas de Evolution traen datos sensibles (tokens de la instancia o de Facebook):
// estas funciones devuelven solo los campos que el panel necesita.

/** GET / no requiere API key: confirma que el servidor responde y da la versión. */
export async function serverInfo(): Promise<{ version: string | null }> {
  const data = await call<{ version?: string }>('GET', '/', undefined, 10_000);
  return { version: typeof data?.version === 'string' ? data.version : null };
}

/** POST /verify-creds responde 200 solo si la API key es válida. */
export async function verifyApiKey(): Promise<void> {
  await call('POST', '/verify-creds', {}, 10_000);
}

/** Estado de la instancia y el número vinculado (ownerJid = 50371234567@s.whatsapp.net). */
export async function instanceInfo(): Promise<{ exists: boolean; state: string; number: string | null; profileName: string | null }> {
  const name = inst();
  const list = await call<unknown>('GET', `/instance/fetchInstances?instanceName=${name}`, undefined, 10_000).catch((err) => {
    if (err instanceof EvolutionError && err.status === 404) return [];
    throw err;
  });
  const items = (Array.isArray(list) ? list : [list]) as Record<string, any>[];
  const raw = items.map((i) => i?.instance ?? i).find((i) => (i?.name ?? i?.instanceName) === config.evolution.instance);
  if (!raw) return { exists: false, state: 'unknown', number: null, profileName: null };
  const owner = String(raw.ownerJid ?? raw.owner ?? '');
  return {
    exists: true,
    state: String(raw.connectionStatus ?? raw.status ?? 'unknown'),
    number: owner ? owner.split('@')[0].split(':')[0] : raw.number ? String(raw.number) : null,
    profileName: raw.profileName ? String(raw.profileName) : null,
  };
}

/** Webhook que tiene configurada la instancia, o null. */
export async function findWebhook(): Promise<{ enabled: boolean; url: string | null; events: string[] } | null> {
  const data = await call<Record<string, any> | null>('GET', `/webhook/find/${inst()}`, undefined, 10_000);
  const w = data?.webhook ?? data;
  if (!w || !w.url) return null;
  return { enabled: Boolean(w.enabled), url: String(w.url), events: Array.isArray(w.events) ? w.events.map(String) : [] };
}

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

/** Envía un mensaje de texto (difusiones). Igual que con la tarjeta, muestra "escribiendo…" durante `delayMs`. */
export async function sendText(opts: { number: string; text: string; delayMs: number }): Promise<{ messageId: string | null }> {
  const data = await call<{ key?: { id?: string } }>(
    'POST',
    `/message/sendText/${inst()}`,
    { number: opts.number, text: opts.text, delay: opts.delayMs, linkPreview: false },
    opts.delayMs + 90_000,
  );
  return { messageId: data?.key?.id ?? null };
}

// Solo estados de entrega y conexión: los mensajes entrantes no se escuchan.
export const WEBHOOK_EVENTS = ['MESSAGES_UPDATE', 'CONNECTION_UPDATE'];

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
