import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { exportFileName, guestsToXlsx } from '../src/server/services/export';
import { readGuestsFile } from '../src/server/services/excel';

const guests = [
  {
    name: 'Ana López',
    business: 'Café Central',
    phone: '50371234567',
    email: 'ana@example.com',
    email_status: 'sent' as const,
    wa_status: 'read' as const,
    checked_in_at: '2026-10-10T23:45:00.000Z',
    checked_in_by: 'Carlos',
  },
  {
    name: 'Luis Pérez',
    business: '',
    phone: null,
    email: 'luis@example.com',
    email_status: 'pending' as const,
    wa_status: 'skipped' as const,
    checked_in_at: null,
    checked_in_by: null,
  },
];

describe('exportar la lista de invitados', () => {
  it('lleva contacto, estados e ingreso en hora de El Salvador', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await guestsToXlsx(guests)) as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Invitados')!;
    const row = (n: number) => (sheet.getRow(n).values as unknown[]).slice(1);
    expect(row(1)).toEqual(['Nombre', 'Negocio', 'Teléfono', 'Correo', 'Estado del correo', 'Estado del WhatsApp', 'Ingresó', 'Registró el ingreso']);
    expect(row(2)).toEqual(['Ana López', 'Café Central', '+503 7123 4567', 'ana@example.com', 'Enviado', 'Leído', '10/10/2026, 17:45', 'Carlos']);
    expect(row(3).slice(0, 6)).toEqual(['Luis Pérez', '', '', 'luis@example.com', 'Sin enviar', 'Sin teléfono']);
  });

  it('se puede volver a importar en otro evento', async () => {
    const xlsx = await guestsToXlsx(guests);
    const rows = await readGuestsFile(xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer);
    expect(rows).toEqual([
      { row: 2, name: 'Ana López', business: 'Café Central', phone: '+503 7123 4567', email: 'ana@example.com' },
      { row: 3, name: 'Luis Pérez', business: '', phone: '', email: 'luis@example.com' },
    ]);
  });

  it('nombra el archivo sin acentos ni espacios', () => {
    expect(exportFileName('Pre-lanzamiento Urbby App · Edición 1', '2026-10-10')).toBe('invitados-pre-lanzamiento-urbby-app-edicion-1-2026-10-10.xlsx');
    expect(exportFileName('¡¡!!', '2026-10-10')).toBe('invitados-evento-2026-10-10.xlsx');
  });
});
