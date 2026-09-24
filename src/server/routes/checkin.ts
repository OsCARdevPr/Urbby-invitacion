import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { getEvent, getGuest, getGuestByToken, nowIso, one, query } from '../db';
import type { CheckinGuest, CheckinResult, GuestRow } from '../../shared/types';
import { fold } from '../services/text';
import { parseId } from './util';

// Check-in en la puerta. Lo usan el portero y el admin; cada ingreso guarda el nombre de quien lo registró.

const toCheckinGuest = (g: GuestRow): CheckinGuest => ({
  id: g.id,
  name: g.name,
  business: g.business,
  checkedInAt: g.checked_in_at,
  checkedInBy: g.checked_in_by,
});

/** Marca el ingreso. El UPDATE condicionado evita que dos celulares registren a la misma persona a la vez. */
async function checkIn(guest: GuestRow, eventId: number, role: string, staffName: string): Promise<CheckinResult> {
  if (guest.event_id !== eventId) {
    return { result: 'wrong_event', guest: toCheckinGuest(guest), eventName: (await getEvent(guest.event_id))?.name ?? 'otro evento' };
  }
  const updated = await one<GuestRow>(
    `UPDATE guests SET checked_in_at = $1, checked_in_role = $2, checked_in_by = $3
     WHERE id = $4 AND checked_in_at IS NULL RETURNING *`,
    [nowIso(), role, staffName, guest.id],
  );
  if (updated) return { result: 'ok', guest: toCheckinGuest(updated) };
  return { result: 'already', guest: toCheckinGuest((await getGuest(guest.id))!) };
}

export const checkinRoutes = new Hono<AppEnv>()
  .post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; eventId?: number };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const eventId = Number(body.eventId);
    if (!token || !Number.isInteger(eventId)) return c.json({ result: 'invalid' } satisfies CheckinResult);
    const guest = await getGuestByToken(token);
    if (!guest) return c.json({ result: 'invalid' } satisfies CheckinResult);
    return c.json(await checkIn(guest, eventId, c.get('role'), c.get('staffName')));
  })

  // Respaldo si el QR no se lee: buscar por nombre o negocio y marcar a mano.
  .get('/search', async (c) => {
    const eventId = parseId(c.req.query('eventId'));
    const q = fold(c.req.query('q') ?? '');
    if (q.length < 2) return c.json([]);
    const guests = await query<GuestRow>('SELECT * FROM guests WHERE event_id = $1', [eventId]);
    const matches = guests
      .filter((g) => fold(`${g.name} ${g.business}`).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .slice(0, 20)
      .map(toCheckinGuest);
    return c.json(matches);
  })

  .post('/guest/:id', async (c) => {
    const guest = await getGuest(parseId(c.req.param('id')));
    const body = (await c.req.json().catch(() => ({}))) as { eventId?: number };
    if (!guest) return c.json({ result: 'invalid' } satisfies CheckinResult);
    return c.json(await checkIn(guest, Number(body.eventId), c.get('role'), c.get('staffName')));
  })

  // Totales del evento y cuántos lleva registrados quien está usando el escáner.
  .get('/stats', async (c) => {
    const eventId = parseId(c.req.query('eventId'));
    const row = await one<{ total: number; checkedIn: number; mine: number }>(
      `SELECT count(*) AS "total",
              count(*) FILTER (WHERE checked_in_at IS NOT NULL) AS "checkedIn",
              count(*) FILTER (WHERE checked_in_at IS NOT NULL AND checked_in_by = $2) AS "mine"
       FROM guests WHERE event_id = $1`,
      [eventId, c.get('staffName')],
    );
    return c.json({ ...row!, name: c.get('staffName') });
  });
