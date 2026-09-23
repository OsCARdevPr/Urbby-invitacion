import type { EventRow, GuestRow } from './types';

export const DEFAULT_WA_TEMPLATE = `Hola {nombre} 👋

Te invitamos al *Prelaunch de Urbby* 🎉
📅 {fecha} · {hora}
📍 {lugar}

Esta es la invitación de *{negocio}*: presenta el código QR de la imagen en la entrada.

Respóndenos *CONFIRMO* para apartar tu lugar 🙌`;

export const DEFAULT_EMAIL_SUBJECT = '{nombre}, tu invitación al Prelaunch de Urbby';

export const PLACEHOLDERS = ['nombre', 'primer_nombre', 'negocio', 'fecha', 'hora', 'lugar', 'direccion', 'evento'] as const;

/** "2026-10-10" → "sábado 10 de octubre" */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Intl.DateTimeFormat('es-SV', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "19:30" → "7:30 p. m." */
export function formatTime(time: string): string {
  const [h, min] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(min)) return time;
  const suffix = h < 12 ? 'a. m.' : 'p. m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${suffix}`;
}

export function templateVars(event: Pick<EventRow, 'name' | 'date' | 'time' | 'venue' | 'address'>, guest: Pick<GuestRow, 'name' | 'business'>) {
  return {
    nombre: guest.name,
    primer_nombre: guest.name.split(' ')[0] ?? guest.name,
    negocio: guest.business || guest.name,
    fecha: formatDate(event.date),
    hora: formatTime(event.time),
    lugar: event.venue,
    direccion: event.address,
    evento: event.name,
  };
}

/** Reemplaza {clave}. Las claves desconocidas se dejan tal cual para que se note el error en la vista previa. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}
