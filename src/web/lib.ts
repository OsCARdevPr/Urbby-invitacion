import type { EmailStatus, WaStatus } from '../shared/types';

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'neutral';

export const WA_LABEL: Record<WaStatus, [string, Tone]> = {
  pending: ['Sin enviar', 'neutral'],
  queued: ['En cola', 'info'],
  sending: ['Enviando…', 'info'],
  sent: ['Enviado', 'ok'],
  delivered: ['Entregado', 'ok'],
  read: ['Leído', 'ok'],
  no_whatsapp: ['Sin WhatsApp', 'bad'],
  failed: ['Falló', 'bad'],
  uncertain: ['Revisar', 'warn'],
  skipped: ['Sin teléfono', 'neutral'],
};

export const EMAIL_LABEL: Record<EmailStatus, [string, Tone]> = {
  pending: ['Sin enviar', 'neutral'],
  sending: ['Enviando…', 'info'],
  sent: ['Enviado', 'ok'],
  failed: ['Falló', 'bad'],
  skipped: ['Sin correo', 'neutral'],
};

/** 50371234567 → +503 7123 4567 */
export function formatPhone(phone: string | null): string {
  if (!phone) return '—';
  if (phone.startsWith('503') && phone.length === 11) return `+503 ${phone.slice(3, 7)} ${phone.slice(7)}`;
  return `+${phone}`;
}

const timeFmt = new Intl.DateTimeFormat('es-SV', { hour: 'numeric', minute: '2-digit', timeZone: 'America/El_Salvador' });
const dateTimeFmt = new Intl.DateTimeFormat('es-SV', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/El_Salvador',
});

export const fmtTime = (iso: string | null) => (iso ? timeFmt.format(new Date(iso)) : '');
export const fmtDateTime = (iso: string | null) => (iso ? dateTimeFmt.format(new Date(iso)) : '');

/** 125 s → "2 min 5 s"; 3 700 s → "1 h 2 min" */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Minúsculas y sin acentos, para buscar. */
export const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
