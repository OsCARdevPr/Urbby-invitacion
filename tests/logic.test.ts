import { describe, expect, it } from 'vitest';
import { normalizePhone, formatPhone } from '../src/server/services/phone';
import { formatDate, formatTime, renderTemplate, templateVars } from '../src/shared/template';
import { validateRows, type RawRow } from '../src/server/services/excel';
import { DEFAULT_SETTINGS, INITIAL_STATE, gateReason, inWindow, localParts, nextDelay, validateSettings } from '../src/server/worker/pacing';
import { extractText, isConfirmation, mapAck, phonesFromKey } from '../src/server/services/webhook';
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
  const event = { name: 'Prelaunch Urbby', date: '2026-10-10', time: '19:30', venue: 'Hotel', address: 'Col. Escalón' };

  it('formatea fecha y hora en español', () => {
    expect(formatDate('2026-10-10')).toMatch(/s[áa]bado.*10.*octubre/i);
    expect(formatTime('19:30')).toBe('7:30 p. m.');
    expect(formatTime('00:05')).toBe('12:05 a. m.');
    expect(formatTime('12:00')).toBe('12:00 p. m.');
  });

  it('reemplaza los placeholders y deja los desconocidos a la vista', () => {
    const vars = templateVars(event, { name: 'Ana María López', business: 'Café Central' });
    expect(renderTemplate('Hola {primer_nombre} de {negocio} en {lugar} {x}', vars)).toBe('Hola Ana de Café Central en Hotel {x}');
  });

  it('sin negocio, {negocio} usa el nombre', () => {
    expect(templateVars(event, { name: 'Ana', business: '' }).negocio).toBe('Ana');
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

  it('saca el texto de distintos tipos de mensaje', () => {
    expect(extractText({ conversation: 'hola' })).toBe('hola');
    expect(extractText({ extendedTextMessage: { text: 'CONFIRMO' } })).toBe('CONFIRMO');
    expect(extractText({ ephemeralMessage: { message: { conversation: 'efímero' } } })).toBe('efímero');
  });

  it('encuentra el teléfono aunque el JID sea @lid', () => {
    expect(phonesFromKey({ remoteJid: '123@lid', remoteJidAlt: '50371234567@s.whatsapp.net' }, {})).toEqual(['50371234567']);
    expect(phonesFromKey({ remoteJid: '50371234567:12@s.whatsapp.net' }, {})).toEqual(['50371234567']);
    expect(phonesFromKey({ remoteJid: '123@lid' }, {})).toEqual([]);
  });

  it('detecta confirmaciones', () => {
    expect(isConfirmation('CONFIRMO')).toBe(true);
    expect(isConfirmation('¡Confirmó! 🙌')).toBe(true);
    expect(isConfirmation('confirmado, gracias')).toBe(true);
    expect(isConfirmation('gracias')).toBe(false);
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
