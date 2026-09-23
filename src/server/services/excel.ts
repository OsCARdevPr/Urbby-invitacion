import ExcelJS from 'exceljs';
import type { ImportRow } from '../../shared/types';
import { clean, fold, isEmail } from './text';
import { normalizePhone } from './phone';

type Field = 'name' | 'business' | 'phone' | 'email';

// Encabezados aceptados, ya "doblados" (minúsculas y sin acentos).
const HEADER_ALIASES: Record<Field, string[]> = {
  name: ['nombre', 'nombres', 'nombre completo', 'invitado', 'invitada', 'name'],
  business: ['negocio', 'nombre del negocio', 'empresa', 'comercio', 'tienda', 'marca', 'business'],
  phone: ['telefono', 'tel', 'celular', 'whatsapp', 'movil', 'numero', 'numero de telefono', 'phone'],
  email: ['correo', 'correo electronico', 'email', 'e-mail', 'mail'],
};

function fieldForHeader(header: string): Field | null {
  const h = fold(header).replace(/[:.*]/g, '').trim();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

/** Convierte cualquier valor de celda de exceljs (texto enriquecido, hipervínculo, fórmula, número) a texto. */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('hyperlink' in value && typeof value.hyperlink === 'string') return value.hyperlink.replace(/^mailto:/i, '');
    if ('result' in value && value.result !== undefined) return cellText(value.result as ExcelJS.CellValue);
  }
  return String(value);
}

export interface RawRow {
  row: number;
  name: string;
  business: string;
  phone: string;
  email: string;
}

/** Lee la primera hoja con encabezados reconocibles. Devuelve las filas crudas, sin validar. */
export async function readGuestsXlsx(buffer: ArrayBuffer): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('No se pudo leer el archivo. Guárdalo como Excel (.xlsx) e inténtalo de nuevo.');
  }

  for (const sheet of workbook.worksheets) {
    // El encabezado puede no estar en la fila 1 (títulos, logos…): busca en las primeras 10.
    for (let headerRow = 1; headerRow <= Math.min(10, sheet.rowCount); headerRow++) {
      const columns = new Map<Field, number>();
      sheet.getRow(headerRow).eachCell((cell, col) => {
        const field = fieldForHeader(cellText(cell.value));
        if (field && !columns.has(field)) columns.set(field, col);
      });
      if (!columns.has('name') || !(columns.has('phone') || columns.has('email'))) continue;

      const rows: RawRow[] = [];
      const read = (r: ExcelJS.Row, f: Field) => {
        const col = columns.get(f);
        return col ? clean(cellText(r.getCell(col).value)) : '';
      };
      for (let i = headerRow + 1; i <= sheet.rowCount; i++) {
        const r = sheet.getRow(i);
        const raw = { row: i, name: read(r, 'name'), business: read(r, 'business'), phone: read(r, 'phone'), email: read(r, 'email') };
        if (raw.name || raw.phone || raw.email) rows.push(raw);
      }
      return rows;
    }
  }
  throw new Error('No encontré los encabezados. La primera fila debe tener: Nombre, Negocio, Teléfono, Correo.');
}

/**
 * Valida y normaliza las filas. `existing` son los teléfonos y correos que ya están en el evento,
 * para marcar duplicados sin tocar la base de datos.
 */
export function validateRows(rows: RawRow[], existing: { phones: Set<string>; emails: Set<string> }): ImportRow[] {
  const seenPhones = new Map<string, number>();
  const seenEmails = new Map<string, number>();

  return rows.map((raw) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    let duplicate: string | null = null;

    if (!raw.name) errors.push('Falta el nombre');

    let phone: string | null = null;
    if (raw.phone) {
      const p = normalizePhone(raw.phone);
      if (p.ok) {
        phone = p.phone;
        if (p.warning) warnings.push(p.warning);
      } else {
        warnings.push(`${p.error}: no se enviará por WhatsApp`);
      }
    }

    let email: string | null = null;
    if (raw.email) {
      const e = raw.email.toLowerCase();
      if (isEmail(e)) email = e;
      else warnings.push('Correo no válido: no se enviará por correo');
    }

    if (!phone && !email) errors.push('Necesita al menos un teléfono o un correo válido');
    if (!raw.business) warnings.push('Sin negocio: la tarjeta mostrará solo el nombre');

    if (errors.length === 0) {
      const dupRow = (phone && seenPhones.get(phone)) || (!phone && email && seenEmails.get(email));
      if (phone && existing.phones.has(phone)) duplicate = 'Este teléfono ya está en el evento';
      else if (!phone && email && existing.emails.has(email)) duplicate = 'Este correo ya está en el evento';
      else if (dupRow) duplicate = `Repetido: igual que la fila ${dupRow}`;
      if (phone && !seenPhones.has(phone)) seenPhones.set(phone, raw.row);
      if (email && !seenEmails.has(email)) seenEmails.set(email, raw.row);
    }

    const status: ImportRow['status'] = errors.length
      ? 'error'
      : duplicate
        ? 'duplicate'
        : warnings.length
          ? 'warning'
          : 'ok';
    const messages = errors.length ? [...errors, ...warnings] : duplicate ? [duplicate] : warnings;

    return {
      row: raw.row,
      name: raw.name,
      business: raw.business,
      phone,
      email,
      rawPhone: raw.phone,
      rawEmail: raw.email,
      status,
      messages,
    };
  });
}
