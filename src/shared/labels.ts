// Nombres de los estados, iguales en el panel y en la lista exportada.

import type { BroadcastAudience, BroadcastStatus, EmailStatus, WaStatus } from './types';

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

export const BROADCAST_LABEL: Record<BroadcastStatus, [string, Tone]> = {
  queued: ['En cola', 'info'],
  sending: ['Enviando…', 'info'],
  sent: ['Enviado', 'ok'],
  delivered: ['Entregado', 'ok'],
  read: ['Leído', 'ok'],
  no_whatsapp: ['Sin WhatsApp', 'bad'],
  failed: ['Falló', 'bad'],
  uncertain: ['Revisar', 'warn'],
  cancelled: ['Cancelado', 'neutral'],
};

export const AUDIENCE_LABEL: Record<BroadcastAudience, { label: string; hint: string }> = {
  invited: {
    label: 'Recibieron la invitación por WhatsApp',
    hint: 'Lo más seguro: ya tienen un mensaje de este número.',
  },
  not_checked_in: { label: 'No han ingresado', hint: 'Por ejemplo, un recordatorio antes del evento.' },
  checked_in: { label: 'Ya ingresaron', hint: 'Por ejemplo, un agradecimiento después del evento.' },
  all: { label: 'Todos con teléfono', hint: 'Incluye a quienes aún no recibieron nada de este número.' },
};
