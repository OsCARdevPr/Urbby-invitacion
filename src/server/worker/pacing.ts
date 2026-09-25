import type { WaSettings, WaState } from '../../shared/types';

// Lógica pura del ritmo de envío: sin base de datos ni red, para poder probarla.

export const DEFAULT_SETTINGS: WaSettings = {
  dailyCap: 20,
  minDelaySec: 180,
  maxDelaySec: 420,
  typingMinMs: 4000,
  typingMaxMs: 9000,
  breakEveryMin: 5,
  breakEveryMax: 8,
  breakMinSec: 900,
  breakMaxSec: 1800,
  windowStart: '09:00',
  windowEnd: '19:00',
};

export const INITIAL_STATE: WaState = {
  eventId: null,
  broadcastId: null,
  running: false,
  pauseReason: null,
  nextSendAt: 0,
  sendsSinceBreak: 0,
  breakAfter: 6,
  consecutiveErrors: 0,
  waitingWindow: false,
  lastSendAt: null,
  lastError: null,
};

export const MAX_CONSECUTIVE_ERRORS = 3;

export type Rand = () => number;

export const randInt = (min: number, max: number, rand: Rand = Math.random) =>
  Math.floor(min + rand() * (Math.max(max, min) - min + 1));

/** Fecha y hora locales en una zona horaria: { date: '2026-10-10', time: '14:05' }. */
export function localParts(at: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** La ventana es [inicio, fin): a las 19:00 en punto ya no se envía. */
export const inWindow = (time: string, start: string, end: string) => time >= start && time < end;

/**
 * Motivo por el que no toca enviar ahora, o null si se puede. El orden importa: una campaña
 * pausada no debe decir "fuera de horario", y el tope diario pesa más que el tiempo de espera.
 */
export function gateReason(input: {
  state: WaState;
  settings: WaSettings;
  now: number;
  localTime: string;
  sentToday: number;
  queued: number;
}): string | null {
  const { state, settings, now, localTime, sentToday, queued } = input;
  if (!state.running) return state.pauseReason ?? 'Campaña detenida';
  if (queued === 0) return 'No hay invitados en la cola';
  if (!inWindow(localTime, settings.windowStart, settings.windowEnd)) {
    return `Fuera de horario: se envía de ${settings.windowStart} a ${settings.windowEnd}`;
  }
  if (sentToday >= settings.dailyCap) return `Tope diario alcanzado (${sentToday}/${settings.dailyCap}): sigue mañana`;
  if (now < state.nextSendAt) return 'Esperando la pausa entre mensajes';
  return null;
}

/**
 * Espera después de un envío: normal entre min y max, y cada 5–8 envíos una pausa larga,
 * para que el ritmo no sea regular. Devuelve el nuevo estado del contador.
 */
export function nextDelay(state: WaState, settings: WaSettings, rand: Rand = Math.random) {
  const sendsSinceBreak = state.sendsSinceBreak + 1;
  if (sendsSinceBreak >= state.breakAfter) {
    return {
      delayMs: randInt(settings.breakMinSec, settings.breakMaxSec, rand) * 1000,
      sendsSinceBreak: 0,
      breakAfter: randInt(settings.breakEveryMin, settings.breakEveryMax, rand),
      isBreak: true,
    };
  }
  return {
    delayMs: randInt(settings.minDelaySec, settings.maxDelaySec, rand) * 1000,
    sendsSinceBreak,
    breakAfter: state.breakAfter,
    isBreak: false,
  };
}

/** Valida los ajustes que llegan del panel. Devuelve el error o null. */
export function validateSettings(s: WaSettings): string | null {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(s.windowStart) || !hhmm.test(s.windowEnd)) return 'El horario debe tener formato HH:MM';
  if (s.windowStart >= s.windowEnd) return 'La hora de inicio debe ser anterior a la de fin';
  if (s.dailyCap < 1 || s.dailyCap > 200) return 'El tope diario debe estar entre 1 y 200';
  if (s.minDelaySec < 10 || s.maxDelaySec < s.minDelaySec) return 'La pausa mínima debe ser de al menos 10 s y no mayor que la máxima';
  if (s.typingMinMs < 0 || s.typingMaxMs < s.typingMinMs || s.typingMaxMs > 20_000) return 'El tiempo "escribiendo" debe estar entre 0 y 20 s';
  if (s.breakEveryMin < 1 || s.breakEveryMax < s.breakEveryMin) return 'Revisa cada cuántos envíos va la pausa larga';
  if (s.breakMinSec < 0 || s.breakMaxSec < s.breakMinSec) return 'Revisa la duración de la pausa larga';
  return null;
}
