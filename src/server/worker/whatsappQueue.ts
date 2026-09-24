import { config, evolutionConfigured, LOCAL_URL_BLOCK, publicUrlIsLocal } from '../config';
import { db, getEvent, kvGet, kvSet, nowIso } from '../db';
import type { GuestRow, WaSettings, WaState, WaStatusResponse } from '../../shared/types';
import { getCardPng } from '../services/card';
import { connectionState, EvolutionError, sendImage } from '../services/evolution';
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
// y hasta un tope diario. Todo el estado vive en SQLite para sobrevivir reinicios.

const SETTINGS_KEY = 'wa_settings';
const STATE_KEY = 'wa_state';
const CONNECTION_KEY = 'wa_connection';

export const getSettings = () => kvGet<WaSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
export const getState = () => kvGet<WaState>(STATE_KEY, INITIAL_STATE);

export function saveSettings(s: WaSettings) {
  kvSet(SETTINGS_KEY, s);
  // Si cambió el rango de la pausa larga, el contador actual se vuelve a sortear dentro del nuevo rango.
  const { breakAfter } = getState();
  if (breakAfter < s.breakEveryMin || breakAfter > s.breakEveryMax) {
    saveState({ breakAfter: randInt(s.breakEveryMin, s.breakEveryMax) });
  }
}

function saveState(patch: Partial<WaState>): WaState {
  const next = { ...getState(), ...patch };
  kvSet(STATE_KEY, next);
  return next;
}

export function setConnection(state: string) {
  kvSet(CONNECTION_KEY, { state, checkedAt: nowIso() });
}
export const getConnection = () => kvGet<{ state: string; checkedAt: string | null }>(CONNECTION_KEY, { state: 'unknown', checkedAt: null });

const queuedCount = () =>
  (db.prepare(`SELECT COUNT(*) AS n FROM guests WHERE wa_status = 'queued'`).get() as { n: number }).n;

/** Mensajes enviados hoy (hora de El Salvador) desde este número, sumando todos los eventos. */
function sentToday(): number {
  const today = localParts(new Date(), config.tz).date;
  const rows = db.prepare(`SELECT wa_sent_at FROM guests WHERE wa_sent_at IS NOT NULL`).all() as { wa_sent_at: string }[];
  return rows.filter((r) => localParts(new Date(r.wa_sent_at), config.tz).date === today).length;
}

export function waStatus(): WaStatusResponse {
  const state = getState();
  const settings = getSettings();
  const now = Date.now();
  const { date, time } = localParts(new Date(now), config.tz);
  const queued = queuedCount();
  const sent = sentToday();
  return {
    state,
    settings,
    queued,
    sentToday: sent,
    inWindow: inWindow(time, settings.windowStart, settings.windowEnd),
    nowLocal: `${date} ${time}`,
    connection: getConnection(),
    gate: gateReason({ state, settings, now, localTime: time, sentToday: sent, queued }),
  };
}

// ── Control ──────────────────────────────────────────────────────

export function startCampaign(): string | null {
  if (!evolutionConfigured()) return 'Configura EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE antes de empezar.';
  if (publicUrlIsLocal()) return LOCAL_URL_BLOCK;
  if (queuedCount() === 0) return 'No hay invitados en la cola. Encola primero a los de un evento.';
  const state = getState();
  // Reanudar no se salta la pausa que estaba corriendo: pausar y reanudar no debe acelerar el ritmo.
  saveState({ running: true, pauseReason: null, consecutiveErrors: 0, nextSendAt: Math.max(state.nextSendAt, Date.now()) });
  kick();
  return null;
}

export function pauseCampaign(reason = 'Pausada por el admin') {
  saveState({ running: false, pauseReason: reason });
}

export function enqueueEvent(eventId: number): number {
  return db
    .prepare(
      `UPDATE guests SET wa_status = 'queued', wa_queued_at = ?, wa_error = NULL
       WHERE event_id = ? AND wa_status = 'pending' AND phone IS NOT NULL`,
    )
    .run(nowIso(), eventId).changes;
}

/** Encola a un invitado puntual (reintento o reenvío). No aplica a quien no tiene teléfono ni a quien ya está en curso. */
export function enqueueGuest(guestId: number): boolean {
  return (
    db
      .prepare(
        `UPDATE guests SET wa_status = 'queued', wa_queued_at = ?, wa_error = NULL
         WHERE id = ? AND phone IS NOT NULL AND wa_status NOT IN ('queued', 'sending', 'skipped')`,
      )
      .run(nowIso(), guestId).changes === 1
  );
}

export function dequeueGuest(guestId: number): boolean {
  return (
    db.prepare(`UPDATE guests SET wa_status = 'pending', wa_queued_at = NULL WHERE id = ? AND wa_status = 'queued'`).run(guestId)
      .changes === 1
  );
}

/** Para los "inciertos": el admin revisó el chat y el mensaje sí llegó. */
export function markSent(guestId: number): boolean {
  return (
    db
      .prepare(
        `UPDATE guests SET wa_status = 'sent', wa_sent_at = COALESCE(wa_sent_at, ?), wa_error = NULL
         WHERE id = ? AND wa_status IN ('uncertain', 'failed')`,
      )
      .run(nowIso(), guestId).changes === 1
  );
}

// ── Bucle de envío ───────────────────────────────────────────────

let current: Promise<void> | null = null;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

export function startWorker() {
  // Un "sending" al arrancar significa que el proceso murió a mitad de una llamada: no se sabe si
  // el mensaje salió. Se marca como incierto y NO se reenvía solo, para no escribirle dos veces a nadie.
  const interrupted = db
    .prepare(
      `UPDATE guests SET wa_status = 'uncertain',
         wa_error = 'El servidor se reinició durante el envío: revisa el chat antes de reintentar'
       WHERE wa_status = 'sending'`,
    )
    .run().changes;
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
  const settings = getSettings();
  let state = getState();
  if (!state.running) return;

  const now = Date.now();
  const { time } = localParts(new Date(now), config.tz);

  // Al abrir la ventana no se envía en el minuto exacto: se sortea un arranque de 0 a 15 min.
  if (!inWindow(time, settings.windowStart, settings.windowEnd)) {
    if (!state.waitingWindow) saveState({ waitingWindow: true });
    return;
  }
  if (state.waitingWindow) {
    saveState({ waitingWindow: false, nextSendAt: Math.max(state.nextSendAt, now + randInt(0, 900) * 1000) });
    return;
  }

  const queued = queuedCount();
  const reason = gateReason({ state, settings, now, localTime: time, sentToday: sentToday(), queued });
  if (reason) {
    if (queued === 0) saveState({ running: false, pauseReason: 'Terminado: no quedan invitados en la cola' });
    return;
  }

  let conn: string;
  try {
    conn = await connectionState();
  } catch (err) {
    conn = err instanceof EvolutionError ? `error: ${err.message}` : 'error';
  }
  setConnection(conn);
  if (conn !== 'open') {
    pauseCampaign(`WhatsApp no está conectado (${conn}). Revisa la instancia en Evolution y reanuda.`);
    return;
  }

  const guest = db
    .prepare(`SELECT * FROM guests WHERE wa_status = 'queued' ORDER BY wa_queued_at, id LIMIT 1`)
    .get() as GuestRow | undefined;
  if (!guest?.phone) return;
  const event = getEvent(guest.event_id);
  if (!event) return;

  // Se marca "sending" ANTES de llamar a la API: si el proceso muere aquí, al reiniciar queda incierto.
  const claimed = db.prepare(`UPDATE guests SET wa_status = 'sending' WHERE id = ? AND wa_status = 'queued'`).run(guest.id);
  if (claimed.changes !== 1) return;

  try {
    const png = await getCardPng(event, guest);
    const caption = renderTemplate(event.wa_template, templateVars(event, guest));
    const { messageId } = await sendImage({
      number: guest.phone,
      caption,
      png,
      fileName: 'invitacion.png',
      delayMs: randInt(settings.typingMinMs, settings.typingMaxMs),
    });
    db.prepare(`UPDATE guests SET wa_status = 'sent', wa_message_id = ?, wa_sent_at = ?, wa_error = NULL WHERE id = ?`).run(
      messageId,
      nowIso(),
      guest.id,
    );
    const d = nextDelay(state, settings);
    state = saveState({
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
    if (err instanceof EvolutionError && err.notOnWhatsApp) {
      db.prepare(`UPDATE guests SET wa_status = 'no_whatsapp', wa_error = ? WHERE id = ?`).run(message, guest.id);
      // No salió ningún mensaje, pero igual hubo una consulta a WhatsApp: pausa corta.
      saveState({ nextSendAt: Date.now() + randInt(30, 90) * 1000 });
      return;
    }
    const status = err instanceof EvolutionError && err.uncertain ? 'uncertain' : 'failed';
    db.prepare(`UPDATE guests SET wa_status = ?, wa_error = ? WHERE id = ?`).run(status, message, guest.id);
    const errors = state.consecutiveErrors + 1;
    saveState({
      consecutiveErrors: errors,
      lastError: message,
      nextSendAt: Date.now() + randInt(settings.minDelaySec, settings.maxDelaySec) * 1000,
      ...(errors >= MAX_CONSECUTIVE_ERRORS
        ? { running: false, pauseReason: `Pausada tras ${errors} errores seguidos. Último: ${message}` }
        : {}),
    });
    console.error(`[wa] fallo al enviar a ${guest.name}: ${message}`);
  }
}
