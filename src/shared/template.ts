import type { EventRow, GuestRow } from './types';

/**
 * Texto de la invitación. Es el mismo para el WhatsApp (va como pie de la imagen) y para el cuerpo del correo.
 * El link de Google Maps ({mapa}) no va aquí a propósito: un enlace en el primer mensaje de WhatsApp a alguien
 * que no tiene guardado el número sube el riesgo de bloqueo. El mapa sale como botón en el correo y en la página
 * de la invitación.
 */
export const DEFAULT_WA_TEMPLATE = `¡Hola {nombre}! Has sido uno de los 50 seleccionados al pre-lanzamiento exclusivo de *Urbby App*.

*Lugar:* {lugar}
*Hora:* {hora}
*Dress code:* {dresscode}

La invitación es válida para una persona. Presenta el código QR de la imagen en la entrada.

¡Te esperamos! Respóndenos *CONFIRMO* por WhatsApp para apartar tu lugar.`;

export const DEFAULT_EMAIL_SUBJECT = '{primer_nombre}, tu invitación al pre-lanzamiento de Urbby App';

/** Valores con los que arranca el formulario de "Nuevo evento". */
export const DEFAULT_EVENT = {
  name: 'Pre-lanzamiento Urbby App',
  time: '17:30',
  venue: 'Urbby Hub',
  dress_code: 'Business Casual',
};

export const PLACEHOLDERS = [
  'nombre',
  'primer_nombre',
  'negocio',
  'fecha',
  'hora',
  'lugar',
  'direccion',
  'dresscode',
  'mapa',
  'evento',
] as const;

/** "2026-10-10" → "sábado, 10 de octubre" */
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

/** "17:30" → "5:30 PM" */
export function formatTime(time: string): string {
  const [h, min] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(min)) return time;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${suffix}`;
}

type TemplateEvent = Pick<EventRow, 'name' | 'date' | 'time' | 'venue' | 'address' | 'dress_code' | 'maps_url'>;

export function templateVars(event: TemplateEvent, guest: Pick<GuestRow, 'name' | 'business'>) {
  return {
    nombre: guest.name,
    primer_nombre: guest.name.split(' ')[0] ?? guest.name,
    negocio: guest.business || guest.name,
    fecha: formatDate(event.date),
    hora: formatTime(event.time),
    lugar: event.venue,
    direccion: event.address,
    dresscode: event.dress_code,
    mapa: event.maps_url,
    evento: event.name,
  };
}

/** Reemplaza {clave}. Las claves desconocidas se dejan tal cual para que se note el error en la vista previa. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key] : match));
}
