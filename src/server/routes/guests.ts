import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { exec, getEvent, getGuest, one } from '../db';
import { normalizePhone } from '../services/phone';
import { clean, isEmail } from '../services/text';
import { sendOneEmail } from '../worker/emailJob';
import { dequeueGuest, enqueueGuest, markSent } from '../worker/whatsappQueue';
import { removeCards } from './events';
import { parseId } from './util';

const editSchema = z.object({
  name: z.string(),
  business: z.string(),
  phone: z.string(),
  email: z.string(),
});

export const guestRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))

  .patch('/:id', async (c) => {
    const guest = await getGuest(parseId(c.req.param('id')));
    if (!guest) return c.json({ error: 'Invitado no encontrado' }, 404);
    const parsed = editSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Datos no válidos' }, 400);

    const name = clean(parsed.data.name);
    const business = clean(parsed.data.business);
    if (!name) return c.json({ error: 'El nombre no puede quedar vacío' }, 400);

    let phone: string | null = null;
    if (parsed.data.phone.trim()) {
      const p = normalizePhone(parsed.data.phone);
      if (!p.ok) return c.json({ error: p.error }, 400);
      phone = p.phone;
      const taken = await one('SELECT id FROM guests WHERE event_id = $1 AND phone = $2 AND id != $3', [guest.event_id, phone, guest.id]);
      if (taken) return c.json({ error: 'Otro invitado del evento ya tiene ese teléfono' }, 400);
    }

    let email: string | null = null;
    if (parsed.data.email.trim()) {
      email = parsed.data.email.trim().toLowerCase();
      if (!isEmail(email)) return c.json({ error: 'Correo no válido' }, 400);
    }
    if (!phone && !email) return c.json({ error: 'Necesita al menos un teléfono o un correo' }, 400);

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
    return (await markSent(id)) ? c.json(await getGuest(id)) : c.json({ error: 'Solo aplica a envíos inciertos o fallidos' }, 400);
  })

  .post('/:id/checkin/undo', async (c) => {
    const id = parseId(c.req.param('id'));
    const updated = await one(
      'UPDATE guests SET checked_in_at = NULL, checked_in_role = NULL, checked_in_by = NULL WHERE id = $1 RETURNING *',
      [id],
    );
    return c.json(updated);
  });
