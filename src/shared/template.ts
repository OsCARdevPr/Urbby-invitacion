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

¡Te esperamos!`;

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

/** Extrae las variables {clave} usadas en una plantilla (sin llaves ni duplicados). */
export function extractTemplateVariables(template: string): string[] {
  const matches = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return [...new Set(matches)];
}

/**
 * Valida una plantilla frente a las columnas disponibles y las filas de destinatarios.
 * - Verifica que todas las variables usadas existan en las columnas disponibles (o sean derivables, como {primer_nombre} desde {nombre}).
 * - Verifica que ninguna fila tenga valores faltantes o vacíos para las variables usadas.
 */
export function validateCampaignVariables(
  template: string,
  availableColumns: string[],
  rows: { row: number; variables: Record<string, string> }[],
): {
  valid: boolean;
  usedVariables: string[];
  unknownVariables: string[];
  missingByRow: { row: number; missing: string[] }[];
} {
  const used = extractTemplateVariables(template);
  const available = new Set(availableColumns);
  if (available.has('nombre') || available.has('name')) {
    available.add('primer_nombre');
  }

  const unknown = used.filter((v) => !available.has(v));
  const missingByRow: { row: number; missing: string[] }[] = [];

  const validVars = used.filter((v) => available.has(v));
  for (const r of rows) {
    const missing: string[] = [];
    for (const v of validVars) {
      let val = r.variables[v];
      if (v === 'primer_nombre' && (val === undefined || val === '')) {
        const nameVal = r.variables['nombre'] ?? r.variables['name'] ?? '';
        val = nameVal.trim().split(/\s+/)[0] ?? '';
      }
      if (val === undefined || val === null || String(val).trim() === '') {
        missing.push(v);
      }
    }
    if (missing.length > 0) {
      missingByRow.push({ row: r.row, missing });
    }
  }

  return {
    valid: unknown.length === 0 && missingByRow.length === 0,
    usedVariables: used,
    unknownVariables: unknown,
    missingByRow,
  };
}
