import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { config } from '../config';
import { eventStats, getEvent, listGuests, one, query, tx } from '../db';
import type { EventRow } from '../../shared/types';
import { renderCardPng } from '../services/card';
import { readGuestsFile, validateRows } from '../services/excel';
import { guestsToVcf } from '../services/vcf';
import { startEmailJob } from '../worker/emailJob';
import { enqueueEvent } from '../worker/whatsappQueue';
import { firstError, parseId } from './util';

const admin = requireRole('admin');

export const eventSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre del evento').max(80, 'El nombre es muy largo'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Elige la fecha'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Elige la hora'),
  venue: z.string().trim().min(1, 'Escribe el lugar').max(120, 'El lugar es muy largo'),
  address: z.string().trim().max(200).default(''),
  dress_code: z.string().trim().max(60, 'El dress code es muy largo').default(''),
  maps_url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https:\/\/\S+$/.test(v), 'El link de Google Maps debe empezar con https://')
    .default(''),
  wa_template: z.string().trim().min(1, 'Escribe el texto de la invitación').max(1500, 'El texto de la invitación es muy largo'),
  email_subject: z.string().trim().min(1, 'Escribe el asunto del correo').max(150),
});

const commitSchema = z.object({
  rows: z
    .array(
      z.object({
        row: z.number().int(),
        name: z.string(),
        business: z.string(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
      }),
    )
    .max(2000),
});

const EVENT_COLUMNS = ['name', 'date', 'time', 'venue', 'address', 'dress_code', 'maps_url', 'wa_template', 'email_subject'] as const;
const eventValues = (e: z.infer<typeof eventSchema>) => EVENT_COLUMNS.map((k) => e[k]);

export const eventRoutes = new Hono<AppEnv>()
  // La lista la ve también el portero, para elegir el evento en el escáner.
  .get('/', async (c) => {
    const events = await query<EventRow>('SELECT * FROM events ORDER BY date DESC, time DESC');
    const isAdmin = c.get('role') === 'admin';
    const withStats = await Promise.all(
      events.map(async (e) => {
        const stats = await eventStats(e.id);
        return isAdmin
          ? { ...e, stats }
          : { id: e.id, name: e.name, date: e.date, time: e.time, venue: e.venue, stats: { total: stats.total, checkedIn: stats.checkedIn } };
      }),
    );
    return c.json(withStats);
  })

  .post('/', admin, async (c) => {
    const parsed = eventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const created = await one<EventRow>(
      `INSERT INTO events (${EVENT_COLUMNS.join(', ')}) VALUES (${EVENT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      eventValues(parsed.data),
    );
    return c.json(created, 201);
  })

  .get('/:id', admin, async (c) => {
    const event = await getEvent(parseId(c.req.param('id')));
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);
    return c.json({ event, stats: await eventStats(event.id), byDoorman: await checkinsByDoorman(event.id) });
  })

  .put('/:id', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    const parsed = eventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const updated = await one<EventRow>(
      `UPDATE events SET ${EVENT_COLUMNS.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${EVENT_COLUMNS.length + 1} RETURNING *`,
      [...eventValues(parsed.data), id],
    );
    return updated ? c.json(updated) : c.json({ error: 'Evento no encontrado' }, 404);
  })

  .delete('/:id', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    const tokens = (await query<{ token: string }>('DELETE FROM guests WHERE event_id = $1 RETURNING token', [id])).map((g) => g.token);
    await query('DELETE FROM events WHERE id = $1', [id]);
    removeCards(tokens);
    return c.json({ ok: true });
  })

  .get('/:id/guests', admin, async (c) => c.json(await listGuests(parseId(c.req.param('id')))))

  // ── Importación en dos pasos: vista previa (no guarda nada) y confirmación ──

  .post('/:id/import/preview', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    if (!(await getEvent(id))) return c.json({ error: 'Evento no encontrado' }, 404);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return c.json({ error: 'Sube un archivo Excel (.xlsx) o CSV' }, 400);
    if (file.size > 5 * 1024 * 1024) return c.json({ error: 'El archivo pesa más de 5 MB' }, 400);
    try {
      const raw = await readGuestsFile(await file.arrayBuffer());
      return c.json({ rows: validateRows(raw, await existingContacts(id)) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })

  .post('/:id/import/commit', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    if (!(await getEvent(id))) return c.json({ error: 'Evento no encontrado' }, 404);
    const parsed = commitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Datos de importación no válidos' }, 400);

    // Se vuelve a validar en el servidor: el panel solo propone las filas.
    const rows = validateRows(
      parsed.data.rows.map((r) => ({ row: r.row, name: r.name.trim(), business: r.business.trim(), phone: r.phone ?? '', email: r.email ?? '' })),
      await existingContacts(id),
    ).filter((r) => r.status === 'ok' || r.status === 'warning');

    await tx(async (client) => {
      for (const r of rows) {
        await client.query(
          `INSERT INTO guests (event_id, name, business, phone, email, token, email_status, wa_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, r.name, r.business, r.phone, r.email, nanoid(21), r.email ? 'pending' : 'skipped', r.phone ? 'pending' : 'skipped'],
        );
      }
    });
    return c.json({ inserted: rows.length });
  })

  .get('/:id/contacts.vcf', admin, async (c) => {
    const event = await getEvent(parseId(c.req.param('id')));
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);
    const vcf = guestsToVcf(await listGuests(event.id), `Invitado a ${event.name}`);
    return c.body(vcf, 200, {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="invitados-${event.id}.vcf"`,
    });
  })

  .post('/:id/email/send-pending', admin, async (c) => {
    const result = await startEmailJob(parseId(c.req.param('id')));
    return 'error' in result ? c.json(result, 400) : c.json(result);
  })

  .post('/:id/wa/enqueue', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    if (!(await getEvent(id))) return c.json({ error: 'Evento no encontrado' }, 404);
    return c.json({ queued: await enqueueEvent(id) });
  })

  // Vista previa de la tarjeta con los datos del formulario (aún sin guardar).
  .post('/card-preview', admin, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
    const png = await renderCardPng(
      {
        name: str(body.name, 'Nombre del evento'),
        date: str(body.date, new Date().toISOString().slice(0, 10)),
        time: str(body.time, '19:00'),
        venue: str(body.venue, 'Lugar del evento'),
        dress_code: typeof body.dress_code === 'string' ? body.dress_code.trim() : '',
      },
      { name: str(body.guestName, 'María José Hernández'), business: str(body.guestBusiness, 'Pupusería La Esquina'), token: 'vista-previa' },
    );
    return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  });

/** Cuántos ingresos registró cada portero en este evento (el nombre que escribió al entrar). */
export const checkinsByDoorman = (eventId: number) =>
  query<{ name: string; count: number }>(
    `SELECT COALESCE(checked_in_by, 'Sin nombre') AS name, count(*) AS count
     FROM guests WHERE event_id = $1 AND checked_in_at IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC, 1`,
    [eventId],
  );

async function existingContacts(eventId: number) {
  const rows = await query<{ phone: string | null; email: string | null }>('SELECT phone, email FROM guests WHERE event_id = $1', [eventId]);
  return {
    phones: new Set(rows.map((r) => r.phone).filter((p): p is string => Boolean(p))),
    emails: new Set(rows.map((r) => r.email).filter((e): e is string => Boolean(e))),
  };
}

export function removeCards(tokens: string[]) {
  const dir = path.join(config.dataDir, 'cards');
  if (!fs.existsSync(dir) || tokens.length === 0) return;
  const set = new Set(tokens);
  for (const file of fs.readdirSync(dir)) {
    if (set.has(file.slice(0, 21))) fs.rmSync(path.join(dir, file), { force: true });
  }
}
