import { describe, expect, it } from 'vitest';
import { normalizeHeader, readMarketingFile } from '../src/server/services/excel';
import { extractTemplateVariables, renderTemplate, validateCampaignVariables } from '../src/shared/template';
import ExcelJS from 'exceljs';

describe('normalización de encabezados de marketing', () => {
  it.each([
    ['Nombre', 'nombre'],
    ['Nombre Completo', 'nombre_completo'],
    ['Teléfono / WhatsApp', 'telefono_whatsapp'],
    ['Código Descuento ($)', 'codigo_descuento'],
    ['Fecha Límite', 'fecha_limite'],
    ['Ciudad / País', 'ciudad_pais'],
    ['   Empresa ó Negocio   ', 'empresa_o_negocio'],
  ])('normaliza "%s" a "%s"', (raw, expected) => {
    expect(normalizeHeader(raw)).toBe(expected);
  });
});

describe('validación de variables de campaña', () => {
  it('extrae las variables usadas en la plantilla', () => {
    const template = '¡Hola {nombre}! Tu código es {codigo} y tienes {descuento}% hasta el {fecha_limite}.';
    expect(extractTemplateVariables(template)).toEqual(['nombre', 'codigo', 'descuento', 'fecha_limite']);
  });

  it('valida variables conocidas y deriva primer_nombre desde nombre', () => {
    const template = '¡Hola {primer_nombre}! Tu negocio {negocio} tiene promo.';
    const cols = ['nombre', 'negocio'];
    const rows = [
      { row: 1, variables: { nombre: 'Carlos Mario Perez', negocio: 'Restaurante El Roble' } },
      { row: 2, variables: { nombre: 'Ana Gomez', negocio: 'Boutique Glam' } },
    ];
    const res = validateCampaignVariables(template, cols, rows);
    expect(res.valid).toBe(true);
    expect(res.unknownVariables).toEqual([]);
    expect(res.missingByRow).toEqual([]);
  });

  it('detecta variables desconocidas', () => {
    const template = 'Hola {nombre}, descuento de {descuento} y cupón {cupon_inexistente}.';
    const cols = ['nombre', 'descuento'];
    const rows = [{ row: 1, variables: { nombre: 'Ana', descuento: '20%' } }];
    const res = validateCampaignVariables(template, cols, rows);
    expect(res.valid).toBe(false);
    expect(res.unknownVariables).toEqual(['cupon_inexistente']);
  });

  it('detecta filas con valores faltantes o vacíos', () => {
    const template = 'Hola {nombre}, tu saldo es {saldo}.';
    const cols = ['nombre', 'saldo'];
    const rows = [
      { row: 1, variables: { nombre: 'Ana', saldo: '$50' } },
      { row: 2, variables: { nombre: 'Carlos', saldo: '' } }, // vacío
      { row: 3, variables: { nombre: 'Beatriz', saldo: '   ' } }, // espacios
    ];
    const res = validateCampaignVariables(template, cols, rows);
    expect(res.valid).toBe(false);
    expect(res.missingByRow).toEqual([
      { row: 2, missing: ['saldo'] },
      { row: 3, missing: ['saldo'] },
    ]);
  });
});

describe('importación de listas de marketing', () => {
  it('lee archivo CSV con columnas dinámicas, detecta teléfono y extrae variables', async () => {
    const csv =
      'Nombre Completo,Teléfono,Empresa,Descuento,Código\n' +
      'Ana María López,+503 7123-4567,Café Central,20%,DESC20\n' +
      'CARLOS HERNANDEZ,7840-0819,Taller Don Carlos,15%,DESC15\n' +
      'Pedro Gómez,invalido,Panadería Santa Fe,10%,DESC10\n' +
      'Ana López,7123-4567,Café Central Sucursal,20%,DESC20DUP\n';

    const buffer = new TextEncoder().encode(csv).buffer as ArrayBuffer;
    const preview = await readMarketingFile(buffer);

    expect(preview.needsPhoneColumn).toBe(false);
    expect(preview.phoneColumn).toBe('telefono');
    expect(preview.columns.map((c) => c.key)).toEqual([
      'nombre_completo',
      'telefono',
      'empresa',
      'descuento',
      'codigo',
    ]);

    expect(preview.stats.total).toBe(4);
    expect(preview.stats.valid).toBe(2);
    expect(preview.stats.invalidPhone).toBe(1);
    expect(preview.stats.duplicates).toBe(1);

    // Primera fila válida
    const r1 = preview.rows[0];
    expect(r1.phone).toBe('50371234567');
    expect(r1.status).toBe('ok');
    expect(r1.variables.descuento).toBe('20%');
    expect(r1.variables.codigo).toBe('DESC20');

    // Segunda fila (nombre normalizado tidyName)
    const r2 = preview.rows[1];
    expect(r2.name).toBe('Carlos Hernandez');
    expect(r2.phone).toBe('50378400819');
    expect(r2.status).toBe('ok');

    // Tercera fila (teléfono inválido)
    const r3 = preview.rows[2];
    expect(r3.phone).toBeNull();
    expect(r3.status).toBe('error');

    // Cuarta fila (teléfono duplicado)
    const r4 = preview.rows[3];
    expect(r4.phone).toBe('50371234567');
    expect(r4.status).toBe('duplicate');
  });

  it('pide seleccionar columna de teléfono cuando no se detecta automáticamente', async () => {
    const csv =
      'Cliente,Contacto Móvil Directo,Puntos\n' +
      'Laura Santos,+503 7234-5678,500\n';

    const buffer = new TextEncoder().encode(csv).buffer as ArrayBuffer;
    const preview = await readMarketingFile(buffer);

    expect(preview.needsPhoneColumn).toBe(true);
    expect(preview.phoneColumn).toBeNull();
    expect(preview.columns.map((c) => c.key)).toEqual(['cliente', 'contacto_movil_directo', 'puntos']);

    // Si luego se especifica la columna seleccionada:
    const previewResolved = await readMarketingFile(buffer, 'contacto_movil_directo');
    expect(previewResolved.needsPhoneColumn).toBe(false);
    expect(previewResolved.phoneColumn).toBe('contacto_movil_directo');
    expect(previewResolved.rows[0].phone).toBe('50372345678');
    expect(previewResolved.rows[0].status).toBe('ok');
  });

  it('detecta encabezados vacíos o duplicados', async () => {
    const csvConVacio = 'Nombre,,Teléfono\nAna,x,71234567\n';
    await expect(readMarketingFile(new TextEncoder().encode(csvConVacio).buffer as ArrayBuffer)).rejects.toThrow(
      /no tiene encabezado/,
    );

    const csvConDuplicados = 'Teléfono,Descuento,Telefono\n71234567,10%,71234567\n';
    await expect(readMarketingFile(new TextEncoder().encode(csvConDuplicados).buffer as ArrayBuffer)).rejects.toThrow(
      /Encabezados duplicados/,
    );
  });

  it('lee libro Excel .xlsx con columnas y variables de marketing', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Campana');
    ws.addRow(['Nombre', 'Teléfono', 'Cupón']);
    ws.addRow(['David Rivas', '+503 7500-1122', 'SUPER2026']);
    const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;

    const preview = await readMarketingFile(buffer);
    expect(preview.needsPhoneColumn).toBe(false);
    expect(preview.stats.valid).toBe(1);
    expect(preview.rows[0].name).toBe('David Rivas');
    expect(preview.rows[0].phone).toBe('50375001122');
    expect(preview.rows[0].variables.cupon).toBe('SUPER2026');

    // Sustitución de variables
    const msg = renderTemplate('¡Hola {nombre}! Tu cupón es {cupon}', preview.rows[0].variables);
    expect(msg).toBe('¡Hola David Rivas! Tu cupón es SUPER2026');
  });
});
