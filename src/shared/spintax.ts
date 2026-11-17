/**
 * Grupo de spintax: llaves que contienen al menos una barra y ninguna otra llave. Así `{nombre}` (sin barra)
 * queda intacto para `renderTemplate`, y la expresión no puede quedarse colgada con llaves sueltas.
 */
const GRUPO = /\{([^{}]*\|[^{}]*)\}/g;

/**
 * Resuelve el spintax: cada `{Hola|Buenas|Qué tal}` se reemplaza por una de sus opciones al azar.
 * Las opciones pueden estar vacías (`{Hola|}`). No hay anidación: se resuelve una sola pasada.
 * Variar el texto entre destinatarios reduce el riesgo de que WhatsApp lo tome como envío masivo.
 */
export function resolverSpintax(texto: string, rand: () => number = Math.random): string {
  return texto.replace(GRUPO, (_grupo, cuerpo: string) => {
    const opciones = cuerpo.split('|');
    const i = Math.min(opciones.length - 1, Math.max(0, Math.floor(rand() * opciones.length)));
    return opciones[i];
  });
}

/** True si el texto tiene al menos un grupo de spintax. */
export const tieneSpintax = (texto: string) => new RegExp(GRUPO.source).test(texto);
