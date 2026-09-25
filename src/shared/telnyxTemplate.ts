import { PLACEHOLDERS } from './template';
import type { TelnyxApproval } from './types';

// Conversión del texto de la invitación ({nombre}, {lugar}…) a una plantilla de WhatsApp ({{1}}, {{2}}…).
// Lógica pura: la usan el servidor al crear la plantilla y el panel para avisar de problemas antes de enviarla.

/** WhatsApp no acepta cuerpos de plantilla más largos. */
export const TEMPLATE_BODY_MAX = 1024;

export interface TemplateBody {
  body: string;
  /** "1" → placeholder que la llena. Cada aparición lleva su propio número: Meta exige variables consecutivas. */
  variables: Record<string, string>;
}

/** Cambia cada {placeholder} conocido por {{n}}, en orden de aparición. Los desconocidos quedan como texto. */
export function toTemplateBody(text: string): TemplateBody {
  const variables: Record<string, string> = {};
  let n = 0;
  const body = text.trim().replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(key)) return match;
    n += 1;
    variables[String(n)] = key;
    return `{{${n}}}`;
  });
  return { body, variables };
}

/**
 * Problemas que harían que Meta rechace la plantilla, en palabras del panel. Lista vacía si se ve bien.
 * No cubre todo (Meta revisa el contenido), solo las reglas de forma que se pueden comprobar aquí.
 */
export function templateBodyProblems(text: string): string[] {
  const { body, variables } = toTemplateBody(text);
  const problems: string[] = [];
  if (body.length > TEMPLATE_BODY_MAX) problems.push(`El texto tiene ${body.length} caracteres y WhatsApp acepta hasta ${TEMPLATE_BODY_MAX}.`);
  if (/^\{\{\d+\}\}/.test(body)) problems.push('El texto no puede empezar con un dato variable (por ejemplo {nombre}): agrega algo antes, como "Hola".');
  if (/\{\{\d+\}\}$/.test(body)) problems.push('El texto no puede terminar con un dato variable: agrega un cierre después.');
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) problems.push('Dos datos variables no pueden ir seguidos: sepáralos con texto.');
  if (Object.values(variables).includes('mapa')) problems.push('{mapa} pone un enlace variable: Meta suele rechazarlo. Quítalo del texto.');
  return problems;
}

/**
 * Valores de las variables para un invitado, en orden ({{1}}, {{2}}…). WhatsApp rechaza valores con saltos de
 * línea, tabuladores o más de 4 espacios seguidos, y valores vacíos: se limpian y los vacíos llevan un guion.
 */
export function templateValues(variables: Record<string, string>, vars: Record<string, string>): string[] {
  return Object.keys(variables)
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => (vars[variables[n]] ?? '').replace(/\s+/g, ' ').trim() || '-');
}

/** Estado de aprobación de Meta, en palabras del panel. */
export const APPROVAL_LABEL: Record<TelnyxApproval, string> = {
  pending: 'En revisión de Meta',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  paused: 'Pausada por Meta',
  disabled: 'Desactivada por Meta',
  unknown: 'Estado desconocido',
};
