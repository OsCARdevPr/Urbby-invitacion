import { describe, expect, it } from 'vitest';
import { normalizePhone, formatPhone } from '../src/server/services/phone';
import { DEFAULT_WA_TEMPLATE, formatDate, formatTime, renderTemplate, templateVars } from '../src/shared/template';
import { waToHtml } from '../src/server/services/email';
import { decodeText, parseCsv, readGuestsFile, tidyName, validateRows, type RawRow } from '../src/server/services/excel';
import { DEFAULT_SETTINGS, INITIAL_STATE, gateReason, inWindow, localParts, nextDelay, validateSettings } from '../src/server/worker/pacing';
import { mapAck } from '../src/server/services/webhook';
import { guestsToVcf } from '../src/server/services/vcf';

describe('normalizePhone', () => {
  it.each([
    ['7123-4567', '50371234567'],
    ['7123 4567', '50371234567'],
    ['+503 7123 4567', '50371234567'],
    ['50371234567', '50371234567'],
    ['00503 6123 4567', '50361234567'],
  ])('%s → %s', (input, expected) => {
    const r = normalizePhone(input);
    expect(r).toEqual({ ok: true, phone: expected });
  });

  it('advierte los fijos de El Salvador', () => {
    const r = normalizePhone('2250-1234');
    expect(r.ok && r.warning).toMatch(/fijo/);
  });

  it('acepta extranjeros válidos con advertencia', () => {
    const r = normalizePhone('+1 202 555 0123');
    expect(r).toMatchObject({ ok: true, phone: '12025550123' });
  });

  it.each(['', '123', '7123-456', '+503 9123 4567', 'abc'])('rechaza %j', (input) => {
    expect(normalizePhone(input).ok).toBe(false);
  });

  it('formatea para mostrar', () => {
    expect(formatPhone('50371234567')).toBe('+503 7123 4567');
  });
});

describe('plantillas', () => {
  const event = {
    name: 'Pre-lanzamiento Urbby App',
    date: '2026-10-10',
    time: '17:30',
    venue: 'Urbby Hub',
    address: 'Col. Escalón',
    dress_code: 'Business Casual',
    maps_url: '',
  };

  it('formatea fecha y hora como en la invitación', () => {
    expect(formatDate('2026-10-10')).toMatch(/s[áa]bado.*10.*octubre/i);
    expect(formatTime('17:30')).toBe('5:30 PM');
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
  });

  it('el texto por defecto lleva todo lo de la invitación y ningún enlace', () => {
    const text = renderTemplate(DEFAULT_WA_TEMPLATE, templateVars(event, { name: 'Ana López', business: 'Café Central' }));
    expect(text).toContain('¡Hola Ana López!');
    expect(text).toContain('50 seleccionados');
    expect(text).toContain('*Lugar:* Urbby Hub');
    expect(text).toContain('*Hora:* 5:30 PM');
    expect(text).toContain('*Dress code:* Business Casual');
    expect(text).toContain('válida para una persona');
    expect(text).not.toMatch(/\{\w+\}|https?:/);
    expect(text).not.toMatch(/confirm/i);
    expect(text.trim().endsWith('¡Te esperamos!')).toBe(true);
  });

  it('el correo convierte el formato de WhatsApp y escapa HTML', () => {
    expect(waToHtml('*Hola* <b>\nhttps://maps.app.goo.gl/x?a=1&b=2')).toBe(
      '<strong>Hola</strong> &lt;b&gt;<br><a href="https://maps.app.goo.gl/x?a=1&amp;b=2" style="color:#1F4FA3">https://maps.app.goo.gl/x?a=1&amp;b=2</a>',
    );
  });

  it('reemplaza los placeholders y deja los desconocidos a la vista', () => {
    const vars = templateVars(event, { name: 'Ana María López', business: 'Café Central' });
    expect(renderTemplate('Hola {primer_nombre} de {negocio} en {lugar} {x}', vars)).toBe('Hola Ana de Café Central en Urbby Hub {x}');
  });

  it('sin negocio, {negocio} usa el nombre', () => {
    expect(templateVars(event, { name: 'Ana', business: '' }).negocio).toBe('Ana');
  });
});

describe('lectura de CSV', () => {
  it('lee el formato del registro (con columnas extra, comas y caracteres invisibles)', async () => {
    const csv =
      '﻿#,Fecha de registro,Nombre,Negocio,Correo,Teléfono,Confirmaciones\n' +
      '1,22/09/2026 9:29 a.m.,Ana López,"Café, Pan y Más",ana@example.com,+503 7528-3037,\n' +
      '2,,GENESIS DE CARCAMO,GIGI SV,,+503 ‪7840-0819‬,\n';
    const rows = await readGuestsFile(new TextEncoder().encode(csv).buffer as ArrayBuffer);
    expect(rows).toEqual([
      { row: 2, name: 'Ana López', business: 'Café, Pan y Más', phone: '+503 7528-3037', email: 'ana@example.com' },
      { row: 3, name: 'Genesis de Carcamo', business: 'GIGI SV', phone: '+503 ‪7840-0819‬', email: '' },
    ]);
    expect(normalizePhone(rows[1].phone)).toEqual({ ok: true, phone: '50378400819' });
  });

  it('detecta punto y coma y comillas escapadas', () => {
    expect(parseCsv('Nombre;Negocio\r\n"Pedro ""El Rey""";Tienda\r\n')).toEqual([
      ['Nombre', 'Negocio'],
      ['Pedro "El Rey"', 'Tienda'],
    ]);
  });

  it('decodifica CSV de Excel en Windows-1252', () => {
    expect(decodeText(new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]))).toBe('José');
  });

  it('ordena mayúsculas solo si el nombre viene todo en mayúsculas o minúsculas', () => {
    expect(tidyName('GENESIS GEORGINA DE CARCAMO')).toBe('Genesis Georgina de Carcamo');
    expect(tidyName('danir arias')).toBe('Danir Arias');
    expect(tidyName('Carlos Hernandez.')).toBe('Carlos Hernandez');
    expect(tidyName('Glendy Zuleyma campos')).toBe('Glendy Zuleyma campos');
    expect(tidyName('maría-josé del carmen')).toBe('María-José del Carmen');
  });
});

describe('validateRows', () => {
  const row = (r: Partial<RawRow> & { row: number }): RawRow => ({ name: 'X', business: 'B', phone: '', email: '', ...r });
  const empty = { phones: new Set<string>(), emails: new Set<string>() };

  it('marca ok, advertencias, errores y duplicados', () => {
    const out = validateRows(
      [
        row({ row: 2, phone: '71234567', email: 'A@B.com' }),
        row({ row: 3, phone: '7123-4567' }),
        row({ row: 4, name: '', phone: '71111111' }),
        row({ row: 5, phone: '123', email: 'malo' }),
        row({ row: 6, email: 'solo@correo.com', business: '' }),
      ],
      empty,
    );
    expect(out.map((r) => r.status)).toEqual(['ok', 'duplicate', 'error', 'error', 'warning']);
    expect(out[0].email).toBe('a@b.com');
    expect(out[1].messages[0]).toMatch(/fila 2/);
    expect(out[3].messages.join(' ')).toMatch(/Teléfono no válido/);
  });

  it('marca como duplicado lo que ya está en el evento', () => {
    const out = validateRows([row({ row: 2, phone: '71234567' })], { phones: new Set(['50371234567']), emails: new Set() });
    expect(out[0].status).toBe('duplicate');
  });
});

describe('ritmo de envío', () => {
  const base = { settings: DEFAULT_SETTINGS, now: 1_000_000, localTime: '10:00', sentToday: 0, queued: 5 };
  const running = { ...INITIAL_STATE, running: true };

  it('la ventana horaria excluye la hora de cierre', () => {
    expect(inWindow('09:00', '09:00', '19:00')).toBe(true);
    expect(inWindow('18:59', '09:00', '19:00')).toBe(true);
    expect(inWindow('19:00', '09:00', '19:00')).toBe(false);
    expect(inWindow('08:59', '09:00', '19:00')).toBe(false);
  });

  it('deja enviar solo cuando se cumplen todas las condiciones', () => {
    expect(gateReason({ ...base, state: running })).toBeNull();
    expect(gateReason({ ...base, state: INITIAL_STATE })).toMatch(/detenida/);
    expect(gateReason({ ...base, state: { ...running, running: false, pauseReason: 'Pausada por el admin' } })).toBe('Pausada por el admin');
    expect(gateReason({ ...base, state: running, queued: 0 })).toMatch(/cola/);
    expect(gateReason({ ...base, state: running, localTime: '20:00' })).toMatch(/horario/);
    expect(gateReason({ ...base, state: running, sentToday: 20 })).toMatch(/Tope diario/);
    expect(gateReason({ ...base, state: { ...running, nextSendAt: base.now + 1 } })).toMatch(/pausa/);
  });

  it('la pausa normal cae entre el mínimo y el máximo', () => {
    const low = nextDelay({ ...INITIAL_STATE, breakAfter: 99 }, DEFAULT_SETTINGS, () => 0);
    const high = nextDelay({ ...INITIAL_STATE, breakAfter: 99 }, DEFAULT_SETTINGS, () => 0.999999);
    expect(low.delayMs).toBe(180_000);
    expect(high.delayMs).toBe(420_000);
    expect(low.isBreak).toBe(false);
  });

  it('cada N envíos toca una pausa larga y se sortea el siguiente N', () => {
    const d = nextDelay({ ...INITIAL_STATE, sendsSinceBreak: 5, breakAfter: 6 }, DEFAULT_SETTINGS, () => 0);
    expect(d).toMatchObject({ isBreak: true, sendsSinceBreak: 0, delayMs: 900_000, breakAfter: 5 });
  });

  it('valida los ajustes', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toBeNull();
    expect(validateSettings({ ...DEFAULT_SETTINGS, windowStart: '19:00', windowEnd: '09:00' })).toMatch(/anterior/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, minDelaySec: 5 })).toMatch(/10 s/);
  });

  it('calcula fecha y hora locales de El Salvador (UTC-6)', () => {
    expect(localParts(new Date('2026-10-11T02:30:00Z'), 'America/El_Salvador')).toEqual({ date: '2026-10-10', time: '20:30' });
  });
});

describe('webhook', () => {
  it('traduce los acks de texto y numéricos', () => {
    expect(mapAck('SERVER_ACK')).toBe('sent');
    expect(mapAck('DELIVERY_ACK')).toBe('delivered');
    expect(mapAck(4)).toBe('read');
    expect(mapAck('PENDING')).toBeNull();
  });
});

describe('vcf', () => {
  it('genera vCards solo para quien tiene teléfono y escapa caracteres', () => {
    const vcf = guestsToVcf(
      [
        { name: 'Ana', business: 'Café; Pan, y más', phone: '50371234567', email: null },
        { name: 'Sin tel', business: '', phone: null, email: 'x@y.com' },
      ],
      'Invitado',
    );
    expect(vcf.match(/BEGIN:VCARD/g)).toHaveLength(1);
    expect(vcf).toContain('FN:Ana – Café\\; Pan\\, y más');
    expect(vcf).toContain('TEL;TYPE=CELL:+50371234567');
  });
});
