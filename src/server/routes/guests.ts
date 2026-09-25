import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { exec, getEvent, getGuest, one } from '../db';
import type { GuestRow } from '../../shared/types';
import { tidyName } from '../services/excel';
import { normalizePhone } from '../services/phone';
import { clean, isEmail } from '../services/text';
import { sendOneEmail } from '../worker/emailJob';
import { dequeueGuest, enqueueGuest, markSent, sendGuestNowTelnyx } from '../worker/whatsappQueue';
import { removeCards } from './events';
import { parseId } from './util';

const editSchema = z.object({
  name: z.string(),
  business: z.string(),
  phone: z.string(),
  email: z.string(),
});

const createSchema = editSchema.extend({ eventId: z.number().int().positive() });

type GuestForm = { name: string; business: string; phone: string | null; email: string | null };

/**
 * Valida y normaliza el formulario de un invitado (al agregarlo o editarlo). Devuelve el error como texto.
 * `selfId` es el propio invitado al editar, para que su teléfono no cuente como repetido.
 */
async function readGuestForm(input: z.infer<typeof editSchema>, eventId: number, selfId = 0): Promise<GuestForm | string> {
  const name = clean(input.name);
  const business = clean(input.business);
  if (!name) return 'El nombre no puede quedar vacío';

  let phone: string | null = null;
  if (input.phone.trim()) {
    const p = normalizePhone(input.phone);
    if (!p.ok) return p.error;
    phone = p.phone;
    const taken = await one('SELECT id FROM guests WHERE event_id = $1 AND phone = $2 AND id != $3', [eventId, phone, selfId]);
    if (taken) return 'Otro invitado del evento ya tiene ese teléfono';
  }

  let email: string | null = null;
  if (input.email.trim()) {
    email = input.email.trim().toLowerCase();
    if (!isEmail(email)) return 'Correo no válido';
  }
  if (!phone && !email) return 'Necesita al menos un teléfono o un correo';
  return { name, business, phone, email };
}

export const guestRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))

  // Un invitado suelto, sin pasar por la importación (por ejemplo, alguien que se suma a última hora).
  .post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Datos no válidos' }, 400);
    const event = await getEvent(parsed.data.eventId);
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);

    const form = await readGuestForm(parsed.data, event.id);
    if (typeof form === 'string') return c.json({ error: form }, 400);
    // Igual que en la importación: sin teléfono, el correo es lo que identifica al invitado.
    if (!form.phone && form.email && (await one('SELECT id FROM guests WHERE event_id = $1 AND email = $2', [event.id, form.email]))) {
      return c.json({ error: 'Otro invitado del evento ya tiene ese correo' }, 400);
    }

    const created = await one<GuestRow>(
      `INSERT INTO guests (event_id, name, business, phone, email, token, email_status, wa_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        event.id,
        tidyName(form.name),
        form.business,
        form.phone,
        form.email,
        nanoid(21),
        form.email ? 'pending' : 'skipped',
        form.phone ? 'pending' : 'skipped',
      ],
    );
    return c.json(created, 201);
  })

  .patch('/:id', async (c) => {
    const guest = await getGuest(parseId(c.req.param('id')));
    if (!guest) return c.json({ error: 'Invitado no encontrado' }, 404);
    const parsed = editSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Datos no válidos' }, 400);

    const form = await readGuestForm(parsed.data, guest.event_id, guest.id);
    if (typeof form === 'string') return c.json({ error: form }, 400);
    const { name, business, phone, email } = form;

    // Si se agrega o quita un canal, su estado pasa a pendiente u omitido. Lo ya enviado no se toca.
    const waStatus = !phone ? (guest.wa_status === 'pending' ? 'skipped' : guest.wa_status) : guest.wa_status === 'skipped' ? 'pending' : guest.wa_status;
    const emailStatus = !email ? (guest.email_status === 'pending' ? 'skipped' : guest.email_status) : guest.email_status === 'skipped' ? 'pending' : guest.email_status;

    const updated = await one(
      `UPDATE guests SET name = $1, business = $2, phone = $3, email = $4, wa_status = $5, email_status = $6 WHERE id = $7 RETURNING *`,
      [name, business, phone, email, waStatus, emailStatus, guest.id],
    );
    return c.json(updated);
  })

  .delete('/:id', async (c) => {
    const guest = await getGuest(parseId(c.req.param('id')));
    if (!guest) return c.json({ error: 'Invitado no encontrado' }, 404);
    if (guest.wa_status === 'sending') return c.json({ error: 'Se le está enviando el WhatsApp ahora mismo; espera un momento' }, 409);
    await exec('DELETE FROM guests WHERE id = $1', [guest.id]);
    removeCards([guest.token]);
    return c.json({ ok: true });
  })

  .post('/:id/email/send', async (c) => {
    const guest = await getGuest(parseId(c.req.param('id')));
    if (!guest) return c.json({ error: 'Invitado no encontrado' }, 404);
    if (!guest.email) return c.json({ error: 'El invitado no tiene correo' }, 400);
    const event = (await getEvent(guest.event_id))!;
    try {
      // Clave nueva: es un reenvío intencional, no un reintento.
      await sendOneEmail(event, guest, `invitacion-${guest.token}-${Date.now()}`);
      return c.json(await getGuest(guest.id));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  })

  .post('/:id/wa/enqueue', async (c) => {
    const id = parseId(c.req.param('id'));
    return (await enqueueGuest(id)) ? c.json(await getGuest(id)) : c.json({ error: 'No se puede encolar a este invitado' }, 400);
  })

  .post('/:id/wa/dequeue', async (c) => {
    const id = parseId(c.req.param('id'));
    return (await dequeueGuest(id)) ? c.json(await getGuest(id)) : c.json({ error: 'El invitado no está en la cola' }, 400);
  })

  .post('/:id/wa/mark-sent', async (c) => {
    const id = parseId(c.req.param('id'));
    return (await markSent(id))
      ? c.json(await getGuest(id))
      : c.json({ error: 'No aplica: ya figura como enviado, se está enviando o no tiene teléfono' }, 400);
  })

  // Envío inmediato por la API oficial: sin cola ni pausas, con la plantilla aprobada del evento.
  .post('/:id/wa/telnyx-send', async (c) => {
    const id = parseId(c.req.param('id'));
    if (!(await getGuest(id))) return c.json({ error: 'Invitado no encontrado' }, 404);
    const error = await sendGuestNowTelnyx(id);
    return error ? c.json({ error }, 400) : c.json(await getGuest(id));
  })

  .post('/:id/checkin/undo', async (c) => {
    const id = parseId(c.req.param('id'));
    const updated = await one(
      'UPDATE guests SET checked_in_at = NULL, checked_in_role = NULL, checked_in_by = NULL WHERE id = $1 RETURNING *',
      [id],
    );
    return c.json(updated);
  });
