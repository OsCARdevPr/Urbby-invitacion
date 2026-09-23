import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { config } from '../config';
import { db, eventStats, getEvent, listGuests, normalizeStats, nowIso } from '../db';
import type { EventRow } from '../../shared/types';
import { renderCardPng } from '../services/card';
import { readGuestsXlsx, validateRows } from '../services/excel';
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
  wa_template: z.string().trim().min(1, 'Escribe el mensaje de WhatsApp').max(1500, 'El mensaje de WhatsApp es muy largo'),
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

export const eventRoutes = new Hono<AppEnv>()
  // La lista la ve también el portero, para elegir el evento en el escáner.
  .get('/', (c) => {
    const events = db.prepare('SELECT * FROM events ORDER BY date DESC, time DESC').all() as EventRow[];
    const isAdmin = c.get('role') === 'admin';
    return c.json(
      events.map((e) => {
        const stats = normalizeStats(eventStats(e.id));
        return isAdmin
          ? { ...e, stats }
          : { id: e.id, name: e.name, date: e.date, time: e.time, venue: e.venue, stats: { total: stats.total, checkedIn: stats.checkedIn } };
      }),
    );
  })

  .post('/', admin, async (c) => {
    const parsed = eventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const e = parsed.data;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO events (name, date, time, venue, address, wa_template, email_subject, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.name, e.date, e.time, e.venue, e.address, e.wa_template, e.email_subject, nowIso());
    return c.json(getEvent(Number(lastInsertRowid)), 201);
  })

  .get('/:id', admin, (c) => {
    const event = getEvent(parseId(c.req.param('id')));
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);
    return c.json({ event, stats: normalizeStats(eventStats(event.id)) });
  })

  .put('/:id', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    if (!getEvent(id)) return c.json({ error: 'Evento no encontrado' }, 404);
    const parsed = eventSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const e = parsed.data;
    db.prepare(
      `UPDATE events SET name = ?, date = ?, time = ?, venue = ?, address = ?, wa_template = ?, email_subject = ? WHERE id = ?`,
    ).run(e.name, e.date, e.time, e.venue, e.address, e.wa_template, e.email_subject, id);
    return c.json(getEvent(id));
  })

  .delete('/:id', admin, (c) => {
    const id = parseId(c.req.param('id'));
    const tokens = (db.prepare('SELECT token FROM guests WHERE event_id = ?').all(id) as { token: string }[]).map((g) => g.token);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    removeCards(tokens);
    return c.json({ ok: true });
  })

  .get('/:id/guests', admin, (c) => c.json(listGuests(parseId(c.req.param('id')))))

  // ── Importación en dos pasos: vista previa (no guarda nada) y confirmación ──

  .post('/:id/import/preview', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    if (!getEvent(id)) return c.json({ error: 'Evento no encontrado' }, 404);
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return c.json({ error: 'Sube un archivo .xlsx' }, 400);
    if (file.size > 5 * 1024 * 1024) return c.json({ error: 'El archivo pesa más de 5 MB' }, 400);
    try {
      const raw = await readGuestsXlsx(await file.arrayBuffer());
      return c.json({ rows: validateRows(raw, existingContacts(id)) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })

  .post('/:id/import/commit', admin, async (c) => {
    const id = parseId(c.req.param('id'));
    if (!getEvent(id)) return c.json({ error: 'Evento no encontrado' }, 404);
    const parsed = commitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Datos de importación no válidos' }, 400);

    // Se vuelve a validar en el servidor: el panel solo propone las filas.
    const rows = validateRows(
      parsed.data.rows.map((r) => ({ row: r.row, name: r.name.trim(), business: r.business.trim(), phone: r.phone ?? '', email: r.email ?? '' })),
      existingContacts(id),
    ).filter((r) => r.status === 'ok' || r.status === 'warning');

    const insert = db.prepare(
      `INSERT INTO guests (event_id, name, business, phone, email, token, email_status, wa_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = nowIso();
    db.transaction(() => {
      for (const r of rows) {
        insert.run(id, r.name, r.business, r.phone, r.email, nanoid(21), r.email ? 'pending' : 'skipped', r.phone ? 'pending' : 'skipped', now);
      }
    })();
    return c.json({ inserted: rows.length });
  })

  .get('/:id/contacts.vcf', admin, (c) => {
    const event = getEvent(parseId(c.req.param('id')));
    if (!event) return c.json({ error: 'Evento no encontrado' }, 404);
    const vcf = guestsToVcf(listGuests(event.id), `Invitado a ${event.name}`);
    return c.body(vcf, 200, {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="invitados-${event.id}.vcf"`,
    });
  })

  .post('/:id/email/send-pending', admin, (c) => {
    const result = startEmailJob(parseId(c.req.param('id')));
    return 'error' in result ? c.json(result, 400) : c.json(result);
  })

  .post('/:id/wa/enqueue', admin, (c) => {
    const id = parseId(c.req.param('id'));
    if (!getEvent(id)) return c.json({ error: 'Evento no encontrado' }, 404);
    return c.json({ queued: enqueueEvent(id) });
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
      },
      { name: str(body.guestName, 'María José Hernández'), business: str(body.guestBusiness, 'Pupusería La Esquina'), token: 'vista-previa' },
    );
    return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
  });

function existingContacts(eventId: number) {
  const rows = db.prepare('SELECT phone, email FROM guests WHERE event_id = ?').all(eventId) as { phone: string | null; email: string | null }[];
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
