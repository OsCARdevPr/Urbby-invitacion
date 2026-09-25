import { config, evolutionConfigured, LOCAL_URL_BLOCK, publicUrlIsLocal } from '../config';
import { exec, getEvent, kvGet, kvSet, nowIso, one, query } from '../db';
import type { GuestRow, WaSettings, WaState, WaStatusResponse } from '../../shared/types';
import { getCardPng } from '../services/card';
import { connectionState, EvolutionError, sendImage, sendText } from '../services/evolution';
import { renderTemplate, templateVars } from '../../shared/template';
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
// Envía las invitaciones de un evento o una difusión, nunca las dos a la vez: salen del mismo número,
// así que comparten el ritmo y el tope diario.

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

/** En cola de lo que envía la campaña: la difusión, si hay una, o las invitaciones del evento. */
async function queuedCount(target: Pick<WaState, 'eventId' | 'broadcastId'>): Promise<number> {
  if (target.broadcastId !== null) {
    return (await one<{ n: number }>(`SELECT count(*) AS n FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'queued'`, [
      target.broadcastId,
    ]))!.n;
  }
  if (target.eventId === null) return 0;
  return (await one<{ n: number }>(`SELECT count(*) AS n FROM guests WHERE wa_status = 'queued' AND event_id = $1`, [target.eventId]))!.n;
}

const queuedByEvent = () =>
  query<{ eventId: number; name: string; date: string; queued: number }>(
    `SELECT e.id AS "eventId", e.name, e.date, count(g.id) AS queued
     FROM events e LEFT JOIN guests g ON g.event_id = e.id AND g.wa_status = 'queued'
     GROUP BY e.id ORDER BY e.date, e.id`,
  );

/** Mensajes enviados hoy (hora de El Salvador) desde este número: invitaciones y difusiones de todos los eventos. */
const sentToday = async () =>
  (await one<{ n: number }>(
    `SELECT (SELECT count(*) FROM guests WHERE (wa_sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)
          + (SELECT count(*) FROM broadcast_recipients WHERE (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date) AS n`,
    [config.tz],
  ))!.n;

export async function waStatus(): Promise<WaStatusResponse> {
  const state = await getState();
  const [settings, queued, byEvent, sent, connection] = await Promise.all([
    getSettings(),
    queuedCount(state),
    queuedByEvent(),
    sentToday(),
    getConnection(),
  ]);
  const now = Date.now();
  const { date, time } = localParts(new Date(now), config.tz);
  return {
    state,
    settings,
    queued,
    queuedByEvent: byEvent,
    sentToday: sent,
    inWindow: inWindow(time, settings.windowStart, settings.windowEnd),
    nowLocal: `${date} ${time}`,
    connection,
    gate: gateReason({ state, settings, now, localTime: time, sentToday: sent, queued }),
  };
}

// ── Control ──────────────────────────────────────────────────────

/** Empieza (o reanuda) la campaña con las invitaciones de un evento o con una difusión. */
export async function startCampaign(target: { eventId: number } | { broadcastId: number }): Promise<string | null> {
  if (!evolutionConfigured()) return 'Configura EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE antes de empezar.';
  let next: Pick<WaState, 'eventId' | 'broadcastId'>;
  if ('broadcastId' in target) {
    if (publicUrlIsLocal()) {
      return 'PUBLIC_BASE_URL apunta a localhost (desarrollo): las difusiones están bloqueadas para no escribirle a invitados reales desde una copia de prueba.';
    }
    const b = Number.isInteger(target.broadcastId)
      ? await one<{ id: number; event_id: number }>('SELECT id, event_id FROM broadcasts WHERE id = $1', [target.broadcastId])
      : undefined;
    if (!b) return 'Difusión no encontrada.';
    next = { eventId: b.event_id, broadcastId: b.id };
    if ((await queuedCount(next)) === 0) return 'Esta difusión no tiene mensajes en cola.';
  } else {
    if (publicUrlIsLocal()) return LOCAL_URL_BLOCK;
    const event = Number.isInteger(target.eventId) && target.eventId > 0 ? await getEvent(target.eventId) : undefined;
    if (!event) return 'Elige el evento que quieres enviar.';
    next = { eventId: event.id, broadcastId: null };
    if ((await queuedCount(next)) === 0) return `No hay invitados en la cola de "${event.name}". Encólalos desde el evento.`;
  }
  const state = await getState();
  // Reanudar no se salta la pausa que estaba corriendo: pausar y reanudar no debe acelerar el ritmo.
  await saveState({
    ...next,
    running: true,
    pauseReason: null,
    consecutiveErrors: 0,
    nextSendAt: Math.max(state.nextSendAt, Date.now()),
  });
  kick();
  return null;
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
    `UPDATE guests SET wa_status = 'sent', wa_sent_at = COALESCE(wa_sent_at, $1), wa_error = NULL
     WHERE id = $2 AND wa_status IN ('pending', 'queued', 'uncertain', 'failed')`,
    [nowIso(), guestId],
  )) === 1;

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
  const interruptedBroadcast = await exec(
    `UPDATE broadcast_recipients SET status = 'uncertain',
       error = 'El servidor se reinició durante el envío: revisa el chat antes de reintentar'
     WHERE status = 'sending'`,
  );
  if (interrupted + interruptedBroadcast) {
    console.warn(`[wa] ${interrupted + interruptedBroadcast} envío(s) quedaron inciertos tras el reinicio`);
  }

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

  const queued = await queuedCount(state);
  const reason = gateReason({ state, settings, now, localTime: time, sentToday: await sentToday(), queued });
  if (reason) {
    if (queued === 0) {
      await saveState({
        running: false,
        pauseReason:
          state.broadcastId !== null ? 'Terminado: la difusión ya se envió a todos' : 'Terminado: no quedan invitados en la cola de este evento',
      });
    }
    return;
  }

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

  // Se toma al siguiente y se marca "sending" en un solo paso, ANTES de llamar a la API:
  // si el proceso muere aquí, al reiniciar queda incierto en vez de reenviarse.
  const job = state.broadcastId !== null ? await nextBroadcastJob(state.broadcastId, settings) : await nextInvitationJob(state.eventId, settings);
  if (!job) return;

  try {
    await job.done(await job.send());
    const d = nextDelay(state, settings);
    await saveState({
      consecutiveErrors: 0,
      lastError: null,
      lastSendAt: Date.now(),
      nextSendAt: Date.now() + d.delayMs,
      sendsSinceBreak: d.sendsSinceBreak,
      breakAfter: d.breakAfter,
    });
    console.log(`[wa] enviado a ${job.name}; siguiente en ${Math.round(d.delayMs / 1000)} s${d.isBreak ? ' (pausa larga)' : ''}`);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof EvolutionError && err.notOnWhatsApp) {
      await job.fail('no_whatsapp', message);
      // No salió ningún mensaje, pero igual hubo una consulta a WhatsApp: pausa corta.
      await saveState({ nextSendAt: Date.now() + randInt(30, 90) * 1000 });
      return;
    }
    await job.fail(err instanceof EvolutionError && err.uncertain ? 'uncertain' : 'failed', message);
    const errors = state.consecutiveErrors + 1;
    await saveState({
      consecutiveErrors: errors,
      lastError: message,
      nextSendAt: Date.now() + randInt(settings.minDelaySec, settings.maxDelaySec) * 1000,
      ...(errors >= MAX_CONSECUTIVE_ERRORS
        ? { running: false, pauseReason: `Pausada tras ${errors} errores seguidos. Último: ${message}` }
        : {}),
    });
    console.error(`[wa] fallo al enviar a ${job.name}: ${message}`);
  }
}

/** Lo siguiente por enviar, ya marcado "sending": cómo enviarlo y dónde guardar el resultado. */
interface Job {
  name: string;
  send: () => Promise<string | null>;
  done: (messageId: string | null) => Promise<unknown>;
  fail: (status: 'no_whatsapp' | 'uncertain' | 'failed', error: string) => Promise<unknown>;
}

/** La siguiente invitación del evento: la tarjeta con el texto de la invitación. */
async function nextInvitationJob(eventId: number | null, settings: WaSettings): Promise<Job | null> {
  const guest = await one<GuestRow>(
    `UPDATE guests SET wa_status = 'sending'
     WHERE id = (SELECT id FROM guests WHERE wa_status = 'queued' AND phone IS NOT NULL AND event_id = $1
                 ORDER BY wa_queued_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [eventId],
  );
  if (!guest?.phone) return null;
  const event = await getEvent(guest.event_id);
  if (!event) return null;
  return {
    name: guest.name,
    send: async () =>
      (
        await sendImage({
          number: guest.phone!,
          caption: renderTemplate(event.wa_template, templateVars(event, guest)),
          png: await getCardPng(event, guest),
          fileName: 'invitacion.png',
          delayMs: randInt(settings.typingMinMs, settings.typingMaxMs),
        })
      ).messageId,
    done: (messageId) =>
      exec(`UPDATE guests SET wa_status = 'sent', wa_message_id = $1, wa_sent_at = $2, wa_error = NULL WHERE id = $3`, [
        messageId,
        nowIso(),
        guest.id,
      ]),
    fail: (status, error) => exec(`UPDATE guests SET wa_status = $1, wa_error = $2 WHERE id = $3`, [status, error, guest.id]),
  };
}

/** El siguiente mensaje de la difusión: solo texto, con los datos del invitado. */
async function nextBroadcastJob(broadcastId: number, settings: WaSettings): Promise<Job | null> {
  const picked = await one<{ guest_id: number }>(
    `UPDATE broadcast_recipients SET status = 'sending'
     WHERE broadcast_id = $1 AND guest_id = (
       SELECT guest_id FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'queued'
       ORDER BY guest_id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING guest_id`,
    [broadcastId],
  );
  if (!picked) return null;
  const setRecipient = (sql: string, params: unknown[]) =>
    exec(`UPDATE broadcast_recipients SET ${sql} WHERE broadcast_id = $1 AND guest_id = $2`, [broadcastId, picked.guest_id, ...params]);

  const row = await one<GuestRow & { message: string }>(
    `SELECT g.*, b.message FROM guests g JOIN broadcasts b ON b.id = $1 WHERE g.id = $2`,
    [broadcastId, picked.guest_id],
  );
  const event = row && (await getEvent(row.event_id));
  if (!row || !event) return null;
  if (!row.phone) {
    // Le quitaron el teléfono después de crear la difusión: no hay a dónde enviarlo.
    await setRecipient(`status = 'failed', error = $3`, ['El invitado ya no tiene teléfono']);
    return null;
  }
  return {
    name: `${row.name} (difusión)`,
    send: async () =>
      (
        await sendText({
          number: row.phone!,
          text: renderTemplate(row.message, templateVars(event, row)),
          delayMs: randInt(settings.typingMinMs, settings.typingMaxMs),
        })
      ).messageId,
    done: (messageId) => setRecipient(`status = 'sent', message_id = $3, sent_at = $4, error = NULL`, [messageId, nowIso()]),
    fail: (status, error) => setRecipient(`status = $3, error = $4`, [status, error]),
  };
}
