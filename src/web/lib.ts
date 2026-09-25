// Los nombres de los estados se comparten con el servidor (lista exportada a Excel).
export { EMAIL_LABEL, WA_LABEL, type Tone } from '../shared/labels';

/** 50371234567 → +503 7123 4567 */
export function formatPhone(phone: string | null): string {
  if (!phone) return '—';
  if (phone.startsWith('503') && phone.length === 11) return `+503 ${phone.slice(3, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}

const timeFmt = new Intl.DateTimeFormat('es-SV', { hour: 'numeric', minute: '2-digit', timeZone: 'America/El_Salvador' });
const dateTimeFmt = new Intl.DateTimeFormat('es-SV', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/El_Salvador',
});

export const fmtTime = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '');
export const fmtDateTime = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)) : '');

/** 125 s → "2 min 5 s"; 3 700 s → "1 h 2 min" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/**
 * El evento "actual" según las fechas guardadas en la base: el de hoy; si no hay, el próximo;
 * si ya pasaron todos, el más reciente. Así nada depende de lo que recuerde cada navegador.
 */
export function pickCurrentEvent<T extends { id: number; date: string }>(events: T[]): T | undefined {
  if (events.length === 0) return undefined;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/El_Salvador' }).format(new Date());
  const byDate = [...events].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  return byDate.find((e) => e.date === today) ?? byDate.find((e) => e.date > today) ?? byDate[byDate.length - 1];
}

/** Minúsculas y sin acentos, para buscar. */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
