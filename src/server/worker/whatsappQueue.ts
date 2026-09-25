import { config, evolutionConfigured, LOCAL_URL_BLOCK, publicUrlIsLocal, telnyxConfigured } from '../config';
import { exec, getEvent, kvGet, kvSet, nowIso, one, query } from '../db';
import type { EventRow, GuestRow, WaProvider, WaSettings, WaState, WaStatusResponse } from '../../shared/types';
import { getCardPng } from '../services/card';
import { connectionState, EvolutionError, sendImage } from '../services/evolution';
import { guestUrl } from '../services/qr';
import { sendTemplate, telnyxWebhookUrl, templateApproval } from '../services/telnyx';
import { renderTemplate, templateVars } from '../../shared/template';
import { APPROVAL_LABEL, templateValues } from '../../shared/telnyxTemplate';
import {
  DEFAULT_SETTINGS,
  gateReason,
  INITIAL_STATE,
  inWindow,
  localParts,
  MAX_CONSECUTIVE_ERRORS,
  nextDelay,
  randInt,
} from './pacing';

// Cola de WhatsApp. Envía de a un mensaje, con pausas largas y al azar, solo en horario
// y hasta un tope diario. Todo el estado vive en la base de datos para sobrevivir reinicios.

const SETTINGS_KEY = 'wa_settings';
const STATE_KEY = 'wa_state';
const CONNECTION_KEY = 'wa_connection';

export const getSettings = () => kvGet<WaSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
export const getState = () => kvGet<WaState>(STATE_KEY, INITIAL_STATE);

export async function saveSettings(s: WaSettings) {
  await kvSet(SETTINGS_KEY, s);
  // Si cambió el rango de la pausa larga, el contador actual se vuelve a sortear dentro del nuevo rango.
  const { breakAfter } = await getState();
  if (breakAfter < s.breakEveryMin || breakAfter > s.breakEveryMax) {
    await saveState({ breakAfter: randInt(s.breakEveryMin, s.breakEveryMax) });
  }
}

async function saveState(patch: Partial<WaState>): Promise<WaState> {
  const next = { ...(await getState()), ...patch };
  await kvSet(STATE_KEY, next);
  return next;
}

export const setConnection = (state: string) => kvSet(CONNECTION_KEY, { state, checkedAt: nowIso() });
export const getConnection = () => kvGet<{ state: string; checkedAt: string | null }>(CONNECTION_KEY, { state: 'unknown', checkedAt: null });

/** En cola de un evento. La campaña envía un evento a la vez, así las listas nunca se mezclan. */
const queuedCount = async (eventId: number | null) =>
  eventId === null
    ? 0
    : (await one<{ n: number }>(`SELECT count(*) AS n FROM guests WHERE wa_status = 'queued' AND event_id = $1`, [eventId]))!.n;

const queuedByEvent = () =>
  query<{ eventId: number; name: string; date: string; queued: number }>(
    `SELECT e.id AS "eventId", e.name, e.date, count(g.id) AS queued
     FROM events e LEFT JOIN guests g ON g.event_id = e.id AND g.wa_status = 'queued'
     GROUP BY e.id ORDER BY e.date, e.id`,
  );

/**
 * Mensajes enviados hoy (hora de El Salvador) por un canal, sumando todos los eventos. Cada canal sale de su
 * propio número y tiene su propio tope. Los enviados a mano cuentan para Evolution, por si salieron de ese número.
 */
const sentToday = async (provider: WaProvider) =>
  (await one<{ n: number }>(
    `SELECT count(*) AS n FROM guests
     WHERE (wa_sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
       AND (COALESCE(wa_provider, 'evolution') = 'telnyx') = $2`,
    [config.tz, provider === 'telnyx'],
  ))!.n;

/** Tope diario del canal: el de los ajustes para Evolution; el de TELNYX_DAILY_CAP para Telnyx. */
const dailyCap = (provider: WaProvider, settings: WaSettings) => (provider === 'telnyx' ? config.telnyx.dailyCap : settings.dailyCap);

/** Con Telnyx (API oficial) no hacen falta las pausas largas ni el "escribiendo…": unos segundos entre mensajes. */
const TELNYX_DELAY_SEC: [number, number] = [3, 8];

export async function waStatus(): Promise<WaStatusResponse> {
  const state = await getState();
  const [settings, queued, byEvent, sentEvolution, sentTelnyx, connection] = await Promise.all([
    getSettings(),
    queuedCount(state.eventId),
    queuedByEvent(),
    sentToday('evolution'),
    sentToday('telnyx'),
    getConnection(),
  ]);
  const now = Date.now();
  const { date, time } = localParts(new Date(now), config.tz);
  const sent = state.provider === 'telnyx' ? sentTelnyx : sentEvolution;
  return {
    state,
    settings,
    queued,
    queuedByEvent: byEvent,
    sentToday: sent,
    today: {
      evolution: { sent: sentEvolution, cap: settings.dailyCap },
      telnyx: { sent: sentTelnyx, cap: config.telnyx.dailyCap },
    },
    inWindow: inWindow(time, settings.windowStart, settings.windowEnd),
    nowLocal: `${date} ${time}`,
    connection,
    gate: gateReason({
      state,
      settings: { ...settings, dailyCap: dailyCap(state.provider, settings) },
      now,
      localTime: time,
      sentToday: sent,
      queued,
    }),
  };
}

// ── Control ──────────────────────────────────────────────────────

export async function startCampaign(eventId: number, provider: WaProvider = 'evolution'): Promise<string | null> {
  if (provider === 'telnyx' && !telnyxConfigured()) {
    return 'Configura TELNYX_ACCOUNT_SID, TELNYX_AUTH_TOKEN y TELNYX_WHATSAPP_FROM antes de empezar.';
  }
  if (provider === 'evolution' && !evolutionConfigured()) {
    return 'Configura EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE antes de empezar.';
  }
  if (publicUrlIsLocal()) return LOCAL_URL_BLOCK;
  const event = Number.isInteger(eventId) && eventId > 0 ? await getEvent(eventId) : undefined;
  if (!event) return 'Elige el evento que quieres enviar.';
  if ((await queuedCount(eventId)) === 0) return `No hay invitados en la cola de "${event.name}". Encólalos desde el evento.`;
  if (provider === 'telnyx') {
    const problem = await telnyxTemplateProblem(event);
    if (problem) return problem;
  }
  const state = await getState();
  await saveState({
    eventId,
    provider,
    running: true,
    pauseReason: null,
    consecutiveErrors: 0,
    // Reanudar por Evolution no se salta la pausa que estaba corriendo: pausar y reanudar no debe acelerar el ritmo.
    nextSendAt: provider === 'telnyx' ? Date.now() : Math.max(state.nextSendAt, Date.now()),
  });
  kick();
  return null;
}

/** Por qué no se puede enviar este evento por Telnyx, o null si su plantilla está aprobada. */
export async function telnyxTemplateProblem(event: EventRow): Promise<string | null> {
  if (!event.telnyx_template) {
    return `"${event.name}" no tiene plantilla de WhatsApp en Telnyx. Créala desde el evento y espera a que Meta la apruebe.`;
  }
  const { status, reason } = await templateApproval(event.telnyx_template.id);
  if (status === 'approved') return null;
  return `La plantilla de "${event.name}" no se puede usar todavía (estado: ${APPROVAL_LABEL[status]}${reason ? `: ${reason}` : ''}).`;
}

export async function pauseCampaign(reason = 'Pausada por el admin') {
  await saveState({ running: false, pauseReason: reason });
}

export const enqueueEvent = (eventId: number) =>
  exec(
    `UPDATE guests SET wa_status = 'queued', wa_queued_at = $1, wa_error = NULL
     WHERE event_id = $2 AND wa_status = 'pending' AND phone IS NOT NULL`,
    [nowIso(), eventId],
  );

/** Encola a un invitado puntual (reintento o reenvío). No aplica a quien no tiene teléfono ni a quien ya está en curso. */
export const enqueueGuest = async (guestId: number) =>
  (await exec(
    `UPDATE guests SET wa_status = 'queued', wa_queued_at = $1, wa_error = NULL
     WHERE id = $2 AND phone IS NOT NULL AND wa_status NOT IN ('queued', 'sending', 'skipped')`,
    [nowIso(), guestId],
  )) === 1;

export const dequeueGuest = async (guestId: number) =>
  (await exec(`UPDATE guests SET wa_status = 'pending', wa_queued_at = NULL WHERE id = $1 AND wa_status = 'queued'`, [guestId])) === 1;

/**
 * Marca el WhatsApp como enviado: un "incierto" que sí llegó según el chat, o una invitación que el admin
 * mandó a mano desde su teléfono. Así la campaña no se la vuelve a enviar.
 */
export const markSent = async (guestId: number) =>
  (await exec(
    `UPDATE guests SET wa_status = 'sent', wa_sent_at = COALESCE(wa_sent_at, $1), wa_error = NULL,
       wa_provider = CASE WHEN wa_status IN ('pending', 'queued') THEN 'manual' ELSE wa_provider END
     WHERE id = $2 AND wa_status IN ('pending', 'queued', 'uncertain', 'failed')`,
    [nowIso(), guestId],
  )) === 1;

/**
 * Envía ya mismo por Telnyx a un invitado, fuera de la campaña (para probar o para alguien que se sumó tarde).
 * Con la API oficial no hace falta esperar turno. Devuelve el error como texto, o null si salió.
 */
export async function sendGuestNowTelnyx(guestId: number): Promise<string | null> {
  if (!telnyxConfigured()) return 'Telnyx no está configurado en el servidor.';
  if (publicUrlIsLocal()) return 'Telnyx descarga la tarjeta desde PUBLIC_BASE_URL, y en desarrollo apunta a localhost: prueba en producción.';
  const current = await one<GuestRow>('SELECT * FROM guests WHERE id = $1', [guestId]);
  if (!current?.phone) return 'El invitado no tiene teléfono.';
  const event = (await getEvent(current.event_id))!;
  const problem = await telnyxTemplateProblem(event);
  if (problem) return problem;

  // Mismo cuidado que la campaña: se marca "sending" antes de llamar, y en un solo paso para no chocar con ella.
  const guest = await one<GuestRow>(
    `UPDATE guests SET wa_status = 'sending' WHERE id = $1 AND phone IS NOT NULL AND wa_status <> 'sending' RETURNING *`,
    [guestId],
  );
  if (!guest) return 'Se le está enviando ahora mismo; espera un momento.';
  try {
    const messageId = await sendViaTelnyx(event, guest);
    await recordSent(guest.id, 'telnyx', messageId);
    return null;
  } catch (err) {
    await recordFailure(guest.id, err);
    return (err as Error).message;
  }
}

async function sendViaTelnyx(event: EventRow, guest: GuestRow): Promise<string> {
  const tpl = event.telnyx_template;
  if (!tpl) throw new Error('El evento ya no tiene plantilla de Telnyx');
  // Telnyx descarga la tarjeta de esta app al enviar: se deja generada antes para que responda al instante.
  await getCardPng(event, guest);
  const { id } = await sendTemplate({
    to: guest.phone!,
    name: tpl.name,
    language: tpl.language,
    imageUrl: `${guestUrl(guest.token)}/card.png`,
    bodyValues: templateValues(tpl.variables, templateVars(event, guest)),
    webhookUrl: telnyxWebhookUrl(),
  });
  return id;
}

async function sendViaEvolution(event: EventRow, guest: GuestRow, settings: WaSettings): Promise<string | null> {
  const { messageId } = await sendImage({
    number: guest.phone!,
    caption: renderTemplate(event.wa_template, templateVars(event, guest)),
    png: await getCardPng(event, guest),
    fileName: 'invitacion.png',
    delayMs: randInt(settings.typingMinMs, settings.typingMaxMs),
  });
  return messageId;
}

const recordSent = (guestId: number, provider: WaProvider, messageId: string | null) =>
  exec(`UPDATE guests SET wa_status = 'sent', wa_provider = $1, wa_message_id = $2, wa_sent_at = $3, wa_error = NULL WHERE id = $4`, [
    provider,
    messageId,
    nowIso(),
    guestId,
  ]);

/** Guarda el fallo en el invitado y devuelve en qué estado quedó. */
async function recordFailure(guestId: number, err: unknown): Promise<'no_whatsapp' | 'uncertain' | 'failed'> {
  const e = err as Error & { notOnWhatsApp?: boolean; uncertain?: boolean };
  const status = e.notOnWhatsApp ? 'no_whatsapp' : e.uncertain ? 'uncertain' : 'failed';
  await exec(`UPDATE guests SET wa_status = $1, wa_error = $2 WHERE id = $3`, [status, e.message, guestId]);
  return status;
}

// ── Bucle de envío ───────────────────────────────────────────────

let current: Promise<void> | null = null;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

export async function startWorker() {
  // Un "sending" al arrancar significa que el proceso murió a mitad de una llamada: no se sabe si
  // el mensaje salió. Se marca como incierto y NO se reenvía solo, para no escribirle dos veces a nadie.
  const interrupted = await exec(
    `UPDATE guests SET wa_status = 'uncertain',
       wa_error = 'El servidor se reinició durante el envío: revisa el chat antes de reintentar'
     WHERE wa_status = 'sending'`,
  );
  if (interrupted) console.warn(`[wa] ${interrupted} envío(s) quedaron inciertos tras el reinicio`);

  stopped = false;
  timer ??= setInterval(() => void tick(), 10_000);
  kick();
}

/** Detiene el bucle y resuelve cuando termina el envío en curso (sin empezar otro). */
export async function stopWorker(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  await current;
}

const kick = () => setTimeout(() => void tick(), 200);

export function tick(): Promise<void> {
  if (stopped) return Promise.resolve();
  current ??= step()
    .catch((err) => console.error('[wa] error en el bucle de envío', err))
    .finally(() => {
      current = null;
    });
  return current;
}

async function step() {
  const settings = await getSettings();
  const state = await getState();
  if (!state.running) return;

  const now = Date.now();
  const { time } = localParts(new Date(now), config.tz);

  // Al abrir la ventana no se envía en el minuto exacto: se sortea un arranque de 0 a 15 min.
  if (!inWindow(time, settings.windowStart, settings.windowEnd)) {
    if (!state.waitingWindow) await saveState({ waitingWindow: true });
    return;
  }
  if (state.waitingWindow) {
    await saveState({ waitingWindow: false, nextSendAt: Math.max(state.nextSendAt, now + randInt(0, 900) * 1000) });
    return;
  }

  const queued = await queuedCount(state.eventId);
  const reason = gateReason({
    state,
    settings: { ...settings, dailyCap: dailyCap(state.provider, settings) },
    now,
    localTime: time,
    sentToday: await sentToday(state.provider),
    queued,
  });
  if (reason) {
    if (queued === 0) await saveState({ running: false, pauseReason: 'Terminado: no quedan invitados en la cola de este evento' });
    return;
  }

  if (state.provider === 'telnyx') {
    if (!telnyxConfigured()) {
      await pauseCampaign('Telnyx no está configurado en el servidor. Revisa las variables TELNYX_* y reanuda.');
      return;
    }
  } else {
    let conn: string;
    try {
      conn = await connectionState();
    } catch (err) {
      conn = err instanceof EvolutionError ? `error: ${err.message}` : 'error';
    }
    await setConnection(conn);
    if (conn !== 'open') {
      await pauseCampaign(`WhatsApp no está conectado (${conn}). Revisa la instancia en Evolution y reanuda.`);
      return;
    }
  }

  // Se toma al siguiente y se marca "sending" en un solo paso, ANTES de llamar a la API:
  // si el proceso muere aquí, al reiniciar queda incierto en vez de reenviarse.
  const guest = await one<GuestRow>(
    `UPDATE guests SET wa_status = 'sending'
     WHERE id = (SELECT id FROM guests WHERE wa_status = 'queued' AND phone IS NOT NULL AND event_id = $1
                 ORDER BY wa_queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [state.eventId],
  );
  if (!guest?.phone) return;
  const event = await getEvent(guest.event_id);
  if (!event) return;

  try {
    const messageId = state.provider === 'telnyx' ? await sendViaTelnyx(event, guest) : await sendViaEvolution(event, guest, settings);
    await recordSent(guest.id, state.provider, messageId);
    const d =
      state.provider === 'telnyx'
        ? { delayMs: randInt(...TELNYX_DELAY_SEC) * 1000, sendsSinceBreak: state.sendsSinceBreak, breakAfter: state.breakAfter, isBreak: false }
        : nextDelay(state, settings);
    await saveState({
      consecutiveErrors: 0,
      lastError: null,
      lastSendAt: Date.now(),
      nextSendAt: Date.now() + d.delayMs,
      sendsSinceBreak: d.sendsSinceBreak,
      breakAfter: d.breakAfter,
    });
    console.log(`[wa] enviado a ${guest.name}; siguiente en ${Math.round(d.delayMs / 1000)} s${d.isBreak ? ' (pausa larga)' : ''}`);
  } catch (err) {
    const message = (err as Error).message;
    if ((await recordFailure(guest.id, err)) === 'no_whatsapp') {
      // No salió ningún mensaje, pero igual hubo una consulta a WhatsApp: pausa corta.
      await saveState({ nextSendAt: Date.now() + randInt(30, 90) * 1000 });
      return;
    }
    const errors = state.consecutiveErrors + 1;
    await saveState({
      consecutiveErrors: errors,
      lastError: message,
      nextSendAt:
        Date.now() +
        (state.provider === 'telnyx' ? randInt(30, 60) : randInt(settings.minDelaySec, settings.maxDelaySec)) * 1000,
      ...(errors >= MAX_CONSECUTIVE_ERRORS
        ? { running: false, pauseReason: `Pausada tras ${errors} errores seguidos. Último: ${message}` }
        : {}),
    });
    console.error(`[wa] fallo al enviar a ${guest.name}: ${message}`);
  }
}
