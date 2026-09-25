// Nombres de los estados, iguales en el panel y en la lista exportada.

import type { EmailStatus, WaStatus } from './types';

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
