// Tipos que comparten el servidor y el panel.

export type Role = 'admin' | 'doorman';

export type EmailStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export type WaStatus =
  | 'pending' // importado, aún no está en la cola
  | 'queued' // en la cola de envío
  | 'sending' // la llamada a Evolution está en curso
  | 'sent'
  | 'delivered'
  | 'read'
  | 'no_whatsapp' // Evolution respondió que el número no tiene WhatsApp
  | 'failed'
  | 'uncertain' // el proceso se reinició a mitad de un envío: revisar a mano
  | 'skipped'; // el invitado no tiene teléfono

export interface EventRow {
  id: number;
  name: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  venue: string;
  address: string;
  dress_code: string;
  maps_url: string; // enlace de Google Maps, opcional
  wa_template: string; // texto de la invitación: pie del WhatsApp y cuerpo del correo
  email_subject: string;
  created_at: string;
}

export interface GuestRow {
  id: number;
  event_id: number;
  name: string;
  business: string;
  phone: string | null; // solo dígitos con código de país: 50371234567
  email: string | null;
  token: string;
  email_status: EmailStatus;
  email_sent_at: string | null;
  email_error: string | null;
  wa_status: WaStatus;
  wa_queued_at: string | null;
  wa_message_id: string | null;
  wa_sent_at: string | null;
  wa_error: string | null;
  checked_in_at: string | null;
  checked_in_role: Role | null;
  checked_in_by: string | null; // nombre que escribió el portero al entrar
  created_at: string;
}

export interface EventStats {
  total: number;
  emailSent: number;
  emailFailed: number;
  waQueued: number;
  waSent: number;
  waDelivered: number;
  waRead: number;
  waProblems: number;
  checkedIn: number;
}

export interface WaSettings {
  dailyCap: number;
  minDelaySec: number;
  maxDelaySec: number;
  typingMinMs: number;
  typingMaxMs: number;
  breakEveryMin: number;
  breakEveryMax: number;
  breakMinSec: number;
  breakMaxSec: number;
  windowStart: string; // HH:MM, hora de El Salvador
  windowEnd: string;
}

export interface WaState {
  /** Evento que envía la campaña. Solo se envía a los invitados en cola de este evento. */
  eventId: number | null;
  /** Si no es null, la campaña está enviando esta difusión (de ese mismo evento) en vez de las invitaciones. */
  broadcastId: number | null;
  running: boolean;
  pauseReason: string | null;
  nextSendAt: number; // epoch ms
  sendsSinceBreak: number;
  breakAfter: number;
  consecutiveErrors: number;
  waitingWindow: boolean;
  lastSendAt: number | null;
  lastError: string | null;
}

export interface WaStatusResponse {
  state: WaState;
  settings: WaSettings;
  /** En cola del evento de la campaña. */
  queued: number;
  /** En cola de cada evento, para elegir cuál enviar. */
  queuedByEvent: { eventId: number; name: string; date: string; queued: number }[];
  sentToday: number;
  inWindow: boolean;
  nowLocal: string;
  connection: { state: string; checkedAt: string | null };
  gate: string | null; // por qué no se está enviando ahora mismo, si aplica
}

// ── Difusiones ───────────────────────────────────────────────────

/** A quiénes del evento va una difusión. Siempre solo a quienes tienen teléfono y no figuran sin WhatsApp. */
export type BroadcastAudience = 'all' | 'invited' | 'checked_in' | 'not_checked_in';

export type BroadcastStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'no_whatsapp'
  | 'failed'
  | 'uncertain' // el proceso se reinició a mitad del envío: no se reintenta solo
  | 'cancelled';

export interface BroadcastSummary {
  id: number;
  event_id: number;
  event_name: string;
  audience: BroadcastAudience;
  message: string;
  created_at: string;
  total: number;
  queued: number;
  /** Enviados, entregados o leídos. */
  sent: number;
  /** Entregados o leídos. */
  delivered: number;
  read: number;
  /** Fallidos, sin WhatsApp o inciertos. */
  problems: number;
  cancelled: number;
}

export interface BroadcastRecipient {
  guest_id: number;
  name: string;
  business: string;
  phone: string | null;
  status: BroadcastStatus;
  error: string | null;
  sent_at: string | null;
}

export type ImportRowStatus = 'ok' | 'warning' | 'error' | 'duplicate';

export interface ImportRow {
  row: number;
  name: string;
  business: string;
  phone: string | null;
  email: string | null;
  rawPhone: string;
  rawEmail: string;
  status: ImportRowStatus;
  messages: string[];
}

export type CheckinResult =
  | { result: 'ok'; guest: CheckinGuest }
  | { result: 'already'; guest: CheckinGuest }
  | { result: 'wrong_event'; guest: CheckinGuest; eventName: string }
  | { result: 'invalid' };

export interface CheckinGuest {
  id: number;
  name: string;
  business: string;
  checkedInAt: string | null;
  checkedInBy: string | null;
}
