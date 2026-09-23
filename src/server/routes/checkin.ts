import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { db, getEvent, getGuest, getGuestByToken, nowIso } from '../db';
import type { CheckinGuest, CheckinResult, GuestRow } from '../../shared/types';
import { fold } from '../services/text';
import { parseId } from './util';

// Check-in en la puerta. Lo usan el portero y el admin.

const toCheckinGuest = (g: GuestRow): CheckinGuest => ({
  id: g.id,
  name: g.name,
  business: g.business,
  checkedInAt: g.checked_in_at,
  confirmed: Boolean(g.confirmed_at),
});

/** Marca el ingreso. El UPDATE condicionado evita que dos celulares registren a la misma persona a la vez. */
function checkIn(guest: GuestRow, eventId: number, role: string): CheckinResult {
  if (guest.event_id !== eventId) {
    return { result: 'wrong_event', guest: toCheckinGuest(guest), eventName: getEvent(guest.event_id)?.name ?? 'otro evento' };
  }
  const updated = db
    .prepare('UPDATE guests SET checked_in_at = ?, checked_in_role = ? WHERE id = ? AND checked_in_at IS NULL')
    .run(nowIso(), role, guest.id);
  const fresh = getGuest(guest.id)!;
  return { result: updated.changes === 1 ? 'ok' : 'already', guest: toCheckinGuest(fresh) };
}

export const checkinRoutes = new Hono<AppEnv>()
  .post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string; eventId?: number };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const eventId = Number(body.eventId);
    if (!token || !Number.isInteger(eventId)) return c.json({ result: 'invalid' } satisfies CheckinResult);
    const guest = getGuestByToken(token);
    if (!guest) return c.json({ result: 'invalid' } satisfies CheckinResult);
    return c.json(checkIn(guest, eventId, c.get('role')));
  })

  // Respaldo si el QR no se lee: buscar por nombre o negocio y marcar a mano.
  .get('/search', (c) => {
    const eventId = parseId(c.req.query('eventId'));
    const q = fold(c.req.query('q') ?? '');
    if (q.length < 2) return c.json([]);
    const guests = db.prepare('SELECT * FROM guests WHERE event_id = ?').all(eventId) as GuestRow[];
    const matches = guests
      .filter((g) => fold(`${g.name} ${g.business}`).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
      .slice(0, 20)
      .map(toCheckinGuest);
    return c.json(matches);
  })

  .post('/guest/:id', async (c) => {
    const guest = getGuest(parseId(c.req.param('id')));
    const body = (await c.req.json().catch(() => ({}))) as { eventId?: number };
    if (!guest) return c.json({ result: 'invalid' } satisfies CheckinResult);
    return c.json(checkIn(guest, Number(body.eventId), c.get('role')));
  })

  .get('/stats', (c) => {
    const eventId = parseId(c.req.query('eventId'));
    const row = db
      .prepare('SELECT COUNT(*) AS total, SUM(checked_in_at IS NOT NULL) AS checkedIn FROM guests WHERE event_id = ?')
      .get(eventId) as { total: number; checkedIn: number | null };
    return c.json({ total: row.total, checkedIn: row.checkedIn ?? 0 });
  });
