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

type Grid = string[][];

const HEADERS_MISSING = 'No encontré los encabezados. El archivo debe tener columnas Nombre, Negocio, Teléfono y Correo.';

/**
 * Lee la lista de invitados desde Excel (.xlsx) o CSV. El formato se detecta por el contenido, no por
 * la extensión: un .xlsx es un zip (empieza con "PK"); cualquier otra cosa se intenta como CSV.
 */
export async function readGuestsFile(buffer: ArrayBuffer): Promise<RawRow[]> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    for (const grid of await xlsxGrids(buffer)) {
      const rows = guestsFromGrid(grid);
      if (rows) return rows;
    }
    throw new Error(HEADERS_MISSING);
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new Error('Es un Excel antiguo (.xls). Guárdalo como .xlsx o como CSV e inténtalo de nuevo.');
  }
  const rows = guestsFromGrid(parseCsv(decodeText(bytes)));
  if (!rows) throw new Error(HEADERS_MISSING);
  return rows;
}

/** Cada hoja del libro como tabla de textos. */
async function xlsxGrids(buffer: ArrayBuffer): Promise<Grid[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('No se pudo leer el archivo. Guárdalo como Excel (.xlsx) o CSV e inténtalo de nuevo.');
  }
  return workbook.worksheets.map((sheet) => {
    const grid: Grid = [];
    for (let i = 1; i <= sheet.rowCount; i++) {
      const cells: string[] = [];
      sheet.getRow(i).eachCell({ includeEmpty: true }, (cell, col) => {
        cells[col - 1] = cellText(cell.value);
      });
      grid.push(Array.from(cells, (c) => c ?? ''));
    }
    return grid;
  });
}

/** UTF-8 (con o sin BOM); si no es UTF-8 válido, Windows-1252, que es como exporta Excel en español. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * CSV según RFC 4180 (comillas dobles, saltos de línea dentro de comillas). El separador se deduce de la
 * primera línea: coma, punto y coma (Excel en español) o tabulador.
 */
export function parseCsv(text: string): Grid {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];

  const grid: Grid = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      grid.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    grid.push(row);
  }
  return grid;
}

/**
 * Busca la fila de encabezados en las primeras 10 (puede haber títulos antes) y devuelve los invitados,
 * o null si esta tabla no tiene las columnas necesarias.
 */
function guestsFromGrid(grid: Grid): RawRow[] | null {
  for (let h = 0; h < Math.min(10, grid.length); h++) {
    const columns = new Map<Field, number>();
    grid[h].forEach((header, col) => {
      const field = fieldForHeader(header);
      if (field && !columns.has(field)) columns.set(field, col);
    });
    if (!columns.has('name') || !(columns.has('phone') || columns.has('email'))) continue;

    const read = (cells: string[], f: Field) => {
      const col = columns.get(f);
      return col === undefined ? '' : clean(cells[col] ?? '');
    };
    const rows: RawRow[] = [];
    for (let i = h + 1; i < grid.length; i++) {
      const cells = grid[i];
      const raw = { row: i + 1, name: tidyName(read(cells, 'name')), business: read(cells, 'business'), phone: read(cells, 'phone'), email: read(cells, 'email') };
      if (raw.name || raw.phone || raw.email) rows.push(raw);
    }
    return rows;
  }
  return null;
}

/**
 * Ordena las mayúsculas de un nombre escrito TODO EN MAYÚSCULAS o todo en minúsculas
 * ("GENESIS DE CARCAMO" → "Genesis de Carcamo"). Si ya viene con mayúsculas y minúsculas, se respeta.
 * También quita puntuación suelta al final ("Carlos Hernandez." → "Carlos Hernandez").
 */
export function tidyName(input: string): string {
  const name = clean(input).replace(/[\s.,;:]+$/, '');
  const letters = name.replace(/[^\p{L}]/gu, '');
  if (!letters || (letters !== letters.toUpperCase() && letters !== letters.toLowerCase())) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/ (De|Del|La|Las|Los|Y|E)(?= )/g, (_, p: string) => ` ${p.toLowerCase()}`);
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
