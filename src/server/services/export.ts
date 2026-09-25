import ExcelJS from 'exceljs';
import { config } from '../config';
import type { GuestRow } from '../../shared/types';
import { EMAIL_LABEL, WA_LABEL } from '../../shared/labels';
import { formatPhone } from './phone';

type ExportGuest = Pick<
  GuestRow,
  'name' | 'business' | 'phone' | 'email' | 'email_status' | 'wa_status' | 'checked_in_at' | 'checked_in_by'
>;

// Las cuatro primeras columnas llevan los mismos encabezados que la importación: el archivo sirve para
// cargar la misma lista en otro evento. Las de estado se ignoran al importar.
const COLUMNS: { header: string; width: number; value: (g: ExportGuest) => string }[] = [
  { header: 'Nombre', width: 30, value: (g) => g.name },
  { header: 'Negocio', width: 30, value: (g) => g.business },
  { header: 'Teléfono', width: 18, value: (g) => (g.phone ? formatPhone(g.phone) : '') },
  { header: 'Correo', width: 32, value: (g) => g.email ?? '' },
  { header: 'Estado del correo', width: 18, value: (g) => EMAIL_LABEL[g.email_status][0] },
  { header: 'Estado del WhatsApp', width: 20, value: (g) => WA_LABEL[g.wa_status][0] },
  { header: 'Ingresó', width: 18, value: (g) => (g.checked_in_at ? localDateTime(g.checked_in_at) : '') },
  { header: 'Registró el ingreso', width: 22, value: (g) => g.checked_in_by ?? '' },
];

const dateTimeFmt = new Intl.DateTimeFormat('es-SV', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: config.tz,
});

/** "2026-10-10T23:45:00Z" → "10/10/2026, 17:45" (hora de El Salvador). */
const localDateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

/** Lista de invitados del evento en Excel (.xlsx), con encabezado fijo y filtros. Todo va como texto. */
export async function guestsToXlsx(guests: ExportGuest[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invitados', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  for (const g of guests) sheet.addRow(COLUMNS.map((c) => c.value(g)));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Nombre de archivo sin acentos ni espacios: "invitados-pre-lanzamiento-urbby-app-2026-10-10.xlsx". */
export function exportFileName(eventName: string, date: string): string {
  const slug = eventName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return `invitados-${slug || 'evento'}-${date}.xlsx`;
}
