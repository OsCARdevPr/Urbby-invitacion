import type { GuestRow } from '../../shared/types';

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r?\n/g, '\\n');

/**
 * Contactos en vCard 3.0 para importar en el teléfono que envía. El nombre lleva el negocio
 * ("Nombre – Negocio") para reconocer a cada invitado en la lista de chats.
 */
export function guestsToVcf(guests: Pick<GuestRow, 'name' | 'business' | 'phone' | 'email'>[], note: string): string {
  return guests
    .filter((g) => g.phone)
    .map((g) => {
      const display = g.business ? `${g.name} – ${g.business}` : g.name;
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:;${escape(display)};;;`,
        `FN:${escape(display)}`,
        g.business ? `ORG:${escape(g.business)}` : null,
        `TEL;TYPE=CELL:+${g.phone}`,
        g.email ? `EMAIL:${escape(g.email)}` : null,
        `NOTE:${escape(note)}`,
        'END:VCARD',
      ];
      return lines.filter(Boolean).join('\r\n');
    })
    .join('\r\n');
}
