import { LOCAL_URL_BLOCK, publicUrlIsLocal, resendConfigured } from '../config';
import { exec, getEvent, nowIso, query } from '../db';
import type { EventRow, GuestRow } from '../../shared/types';
import { getCardPng } from '../services/card';
import { sendInvitationEmail } from '../services/email';

// Envío masivo de correos. Resend permite 2 peticiones por segundo; se va algo más lento.

export interface EmailJob {
  id: number;
  running: boolean;
  eventId: number | null;
  total: number;
  done: number;
  failed: number;
  lastError: string | null;
  finishedAt: string | null;
}

let job: EmailJob = { id: 0, running: false, eventId: null, total: 0, done: 0, failed: 0, lastError: null, finishedAt: null };

export const emailJobStatus = () => job;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Al arrancar, un "sending" es un correo interrumpido: se reintenta sin riesgo gracias a la clave de idempotencia. */
export async function recoverEmails() {
  await exec(`UPDATE guests SET email_status = 'pending' WHERE email_status = 'sending'`);
}

export async function sendOneEmail(event: EventRow, guest: GuestRow, idempotencyKey: string) {
  await exec(`UPDATE guests SET email_status = 'sending' WHERE id = $1`, [guest.id]);
  try {
    const png = await getCardPng(event, guest);
    for (let attempt = 1; ; attempt++) {
      try {
        await sendInvitationEmail(event, guest, png, idempotencyKey);
        break;
      } catch (err) {
        // Límite de velocidad de Resend: espera y reintenta, hasta 3 veces.
        if ((err as Error).name === 'rate_limit_exceeded' && attempt < 3) {
          await sleep(1500 * attempt);
          continue;
        }
        throw err;
      }
    }
    await exec(`UPDATE guests SET email_status = 'sent', email_sent_at = $1, email_error = NULL WHERE id = $2`, [nowIso(), guest.id]);
  } catch (err) {
    await exec(`UPDATE guests SET email_status = 'failed', email_error = $1 WHERE id = $2`, [(err as Error).message, guest.id]);
    throw err;
  }
}

/** Devuelve el id del trabajo iniciado, o un mensaje de error. */
export async function startEmailJob(eventId: number): Promise<{ id: number } | { error: string }> {
  if (job.running) return { error: 'Ya hay un envío de correos en curso.' };
  if (publicUrlIsLocal()) return { error: LOCAL_URL_BLOCK };
  if (!resendConfigured()) return { error: 'Configura RESEND_API_KEY antes de enviar correos.' };
  // Se marca como en curso antes de consultar, para que dos clics seguidos no arranquen dos envíos.
  const previous = job;
  job = { ...job, id: job.id + 1, running: true, eventId, total: 0, done: 0, failed: 0, lastError: null, finishedAt: null };
  const event = await getEvent(eventId);
  const guests = event
    ? await query<GuestRow>(
        `SELECT * FROM guests WHERE event_id = $1 AND email IS NOT NULL AND email_status = 'pending' ORDER BY id`,
        [eventId],
      )
    : [];
  if (!event || guests.length === 0) {
    job = previous;
    return { error: event ? 'No hay correos pendientes en este evento.' : 'Evento no encontrado.' };
  }

  job.total = guests.length;
  void run(event, guests);
  return { id: job.id };
}

async function run(event: EventRow, guests: GuestRow[]) {
  for (const guest of guests) {
    try {
      await sendOneEmail(event, guest, `invitacion-${guest.token}`);
      job.done++;
    } catch (err) {
      job.failed++;
      job.lastError = `${guest.name}: ${(err as Error).message}`;
    }
    await sleep(700);
  }
  job.running = false;
  job.finishedAt = nowIso();
}
