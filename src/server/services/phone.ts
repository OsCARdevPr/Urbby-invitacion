import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

export type PhoneResult =
  | { ok: true; phone: string; warning?: string }
  | { ok: false; error: string };

/**
 * Normaliza un teléfono al formato que espera Evolution: solo dígitos con código de país
 * (50371234567). Los números de 8 dígitos se asumen de El Salvador.
 */
export function normalizePhone(raw: string): PhoneResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'Teléfono vacío' };

  const international = input.startsWith('+') || input.startsWith('00');
  let digits = input.replace(/\D/g, '');
  if (input.startsWith('00')) digits = digits.slice(2);

  if (!international && digits.length === 8) digits = `503${digits}`;

  if (digits.startsWith('503')) {
    if (digits.length !== 11) return { ok: false, error: 'Un número de El Salvador debe tener 8 dígitos' };
    const first = digits[3];
    if (first === '6' || first === '7') return { ok: true, phone: digits };
    if (first === '2') return { ok: true, phone: digits, warning: 'Parece un teléfono fijo: probablemente no tiene WhatsApp' };
    return { ok: false, error: 'No parece un número válido de El Salvador' };
  }

  const parsed = parsePhoneNumberFromString(`+${digits}`);
  if (parsed?.isValid()) {
    return { ok: true, phone: digits, warning: `Número extranjero (+${parsed.countryCallingCode})` };
  }
  return { ok: false, error: 'Teléfono no válido' };
}

/** 50371234567 → +503 7123 4567 */
export function formatPhone(phone: string): string {
  if (phone.startsWith('503') && phone.length === 11) {
    return `+503 ${phone.slice(3, 7)} ${phone.slice(7)}`;
  }
  return `+${phone}`;
}
