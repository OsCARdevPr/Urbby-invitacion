import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { exec, getEvent, one, query, tx } from '../db';
import type { BroadcastAudience, BroadcastRecipient, BroadcastSummary } from '../../shared/types';
import { getState, startCampaign, waStatus } from '../worker/whatsappQueue';
import { firstError, parseId } from './util';

// Difusiones: un mensaje de texto por WhatsApp a los invitados de un evento. Los destinatarios se fijan al
// crearla; el envío lo hace la misma cola que las invitaciones (mismo número, mismo ritmo, mismo tope).

/**
 * Quiénes del evento reciben cada tipo de difusión. Siempre solo quienes tienen teléfono y no figuran
 * como "sin WhatsApp". Las condiciones son fijas (no vienen del usuario), por eso van en el SQL.
 */
const AUDIENCE_SQL: Record<BroadcastAudience, string> = {
  all: 'TRUE',
  invited: `wa_status IN ('sent', 'delivered', 'read')`,
  checked_in: 'checked_in_at IS NOT NULL',
  not_checked_in: 'checked_in_at IS NULL',
};
const AUDIENCES = Object.keys(AUDIENCE_SQL) as BroadcastAudience[];
const audienceWhere = (a: BroadcastAudience) => `event_id = $1 AND phone IS NOT NULL AND wa_status <> 'no_whatsapp' AND ${AUDIENCE_SQL[a]}`;

const createSchema = z.object({
  eventId: z.number().int().positive(),
  audience: z.enum(AUDIENCES as [BroadcastAudience, ...BroadcastAudience[]]),
  message: z.string().trim().min(1, 'Escribe el mensaje').max(1500, 'El mensaje es muy largo'),
});

const SUMMARY_SQL = `
  SELECT b.id, b.event_id, e.name AS event_name, b.audience, b.message, b.created_at,
         count(r.guest_id)                                                       AS total,
         count(*) FILTER (WHERE r.status IN ('queued', 'sending'))               AS queued,
         count(*) FILTER (WHERE r.status IN ('sent', 'delivered', 'read'))       AS sent,
         count(*) FILTER (WHERE r.status IN ('delivered', 'read'))               AS delivered,
         count(*) FILTER (WHERE r.status = 'read')                               AS read,
         count(*) FILTER (WHERE r.status IN ('failed', 'no_whatsapp', 'uncertain')) AS problems,
         count(*) FILTER (WHERE r.status = 'cancelled')                          AS cancelled
  FROM broadcasts b
  JOIN events e ON e.id = b.event_id
  LEFT JOIN broadcast_recipients r ON r.broadcast_id = b.id`;

const getSummary = (id: number) => one<BroadcastSummary>(`${SUMMARY_SQL} WHERE b.id = $1 GROUP BY b.id, e.name`, [id]);

/** La difusión que la campaña está enviando ahora mismo, si es esta. */
const isRunning = async (id: number) => {
  const s = await getState();
  return s.running && s.broadcastId === id;
};

export const broadcastRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))

  .get('/', async (c) => c.json(await query<BroadcastSummary>(`${SUMMARY_SQL} GROUP BY b.id, e.name ORDER BY b.created_at DESC, b.id DESC`)))

  // Cuántos recibirían la difusión con cada filtro, para elegir antes de crearla.
  .get('/audience', async (c) => {
    const eventId = parseId(c.req.query('eventId'));
    if (!(await getEvent(eventId))) return c.json({ error: 'Evento no encontrado' }, 404);
    const counts = {} as Record<BroadcastAudience, number>;
    for (const a of AUDIENCES) {
      counts[a] = (await one<{ n: number }>(`SELECT count(*) AS n FROM guests WHERE ${audienceWhere(a)}`, [eventId]))!.n;
    }
    return c.json(counts);
  })

  .post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const { eventId, audience, message } = parsed.data;
    if (!(await getEvent(eventId))) return c.json({ error: 'Evento no encontrado' }, 404);

    const id = await tx(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO broadcasts (event_id, audience, message) VALUES ($1, $2, $3) RETURNING id',
        [eventId, audience, message],
      );
      const inserted = await client.query(
        `INSERT INTO broadcast_recipients (broadcast_id, guest_id) SELECT $2::int, id FROM guests WHERE ${audienceWhere(audience)}`,
        [eventId, rows[0].id],
      );
      if (!inserted.rowCount) throw new Error('empty');
      return rows[0].id;
    }).catch((err: Error) => {
      if (err.message === 'empty') return null;
      throw err;
    });
    if (id === null) return c.json({ error: 'Nadie del evento cumple ese filtro: la difusión no tendría destinatarios.' }, 400);
    return c.json(await getSummary(id), 201);
  })

  .get('/:id/recipients', async (c) =>
    c.json(
      await query<BroadcastRecipient>(
        `SELECT r.guest_id, g.name, g.business, g.phone, r.status, r.error, r.sent_at
         FROM broadcast_recipients r JOIN guests g ON g.id = r.guest_id
         WHERE r.broadcast_id = $1 ORDER BY lower(g.name), g.id`,
        [parseId(c.req.param('id'))],
      ),
    ),
  )

  // Empieza o reanuda la campaña con esta difusión.
  .post('/:id/start', async (c) => {
    const error = await startCampaign({ broadcastId: parseId(c.req.param('id')) });
    return error ? c.json({ error }, 400) : c.json(await waStatus());
  })

  // Cancela los que siguen en cola. Lo ya enviado no se toca.
  .post('/:id/cancel', async (c) => {
    const id = parseId(c.req.param('id'));
    const n = await exec(`UPDATE broadcast_recipients SET status = 'cancelled' WHERE broadcast_id = $1 AND status = 'queued'`, [id]);
    return c.json({ cancelled: n, broadcast: await getSummary(id) });
  })

  // Vuelve a encolar los fallidos. Los inciertos no: pudieron haber llegado, y se le escribiría dos veces a alguien.
  .post('/:id/retry', async (c) => {
    const id = parseId(c.req.param('id'));
    const n = await exec(`UPDATE broadcast_recipients SET status = 'queued', error = NULL WHERE broadcast_id = $1 AND status = 'failed'`, [id]);
    return c.json({ requeued: n, broadcast: await getSummary(id) });
  })

  // Solo si no salió ningún mensaje: lo enviado queda en el historial y cuenta para el tope diario del número.
  .delete('/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (await isRunning(id)) return c.json({ error: 'La campaña está enviando esta difusión: pausa primero.' }, 409);
    const went = await one(
      `SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1 AND status IN ('sending', 'sent', 'delivered', 'read', 'uncertain')`,
      [id],
    );
    if (went) {
      return c.json({ error: 'Ya salieron mensajes de esta difusión: queda en el historial. Puedes cancelar los que siguen en cola.' }, 409);
    }
    await exec('DELETE FROM broadcasts WHERE id = $1', [id]);
    return c.json({ ok: true });
  });
