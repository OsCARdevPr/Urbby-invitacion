import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { exec, one, query, tx } from '../db';
import type { CampaignRecipient, CampaignSummary, MarketingImportPreview } from '../../shared/types';
import { readMarketingFile } from '../services/excel';
import { normalizePhone } from '../services/phone';
import { validateCampaignVariables } from '../../shared/template';
import { getState, startCampaign, waStatus } from '../worker/whatsappQueue';
import { firstError, parseId } from './util';

const SUMMARY_SQL = `
  SELECT c.id, c.name, c.message, c.image_id, img.filename AS image_filename, c.created_at,
         count(r.id)                                                              AS total,
         count(*) FILTER (WHERE r.status IN ('queued', 'sending'))                AS queued,
         count(*) FILTER (WHERE r.status IN ('sent', 'delivered', 'read'))        AS sent,
         count(*) FILTER (WHERE r.status IN ('delivered', 'read'))                AS delivered,
         count(*) FILTER (WHERE r.status = 'read')                                AS read,
         count(*) FILTER (WHERE r.status IN ('failed', 'no_whatsapp', 'uncertain')) AS problems,
         count(*) FILTER (WHERE r.status = 'cancelled')                           AS cancelled
  FROM campaigns c
  LEFT JOIN campaign_images img ON img.id = c.image_id
  LEFT JOIN campaign_recipients r ON r.campaign_id = c.id`;

const getSummary = (id: number) =>
  one<CampaignSummary>(`${SUMMARY_SQL} WHERE c.id = $1 GROUP BY c.id, img.filename`, [id]);

const isRunning = async (id: number) => {
  const s = await getState();
  return s.running && s.campaignId === id;
};

const createSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el nombre de la campaña').max(80, 'El nombre es muy largo'),
  message: z.string().trim().min(1, 'Escribe el mensaje').max(1500, 'El mensaje es muy largo'),
  imageId: z.string().trim().nullable().optional(),
  rows: z
    .array(
      z.object({
        row: z.number().int().optional(),
        phone: z.string(),
        name: z.string().default(''),
        variables: z.record(z.string(), z.string()),
      }),
    )
    .min(1, 'La lista debe tener al menos un contacto válido'),
});

export const campaignRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))

  // Lista de campañas con sus estadísticas
  .get('/', async (c) =>
    c.json(await query<CampaignSummary>(`${SUMMARY_SQL} GROUP BY c.id, img.filename ORDER BY c.created_at DESC, c.id DESC`)),
  )

  // Servir imagen guardada
  .get('/images/:id', async (c) => {
    const id = c.req.param('id');
    const image = await one<{ data: Buffer; mimetype: string; filename: string }>(
      'SELECT data, mimetype, filename FROM campaign_images WHERE id = $1',
      [id],
    );
    if (!image) return c.json({ error: 'Imagen no encontrada' }, 404);
    return new Response(new Uint8Array(image.data), {
      status: 200,
      headers: {
        'Content-Type': image.mimetype,
        'Content-Disposition': `inline; filename="${encodeURIComponent(image.filename)}"`,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  })

  // Subir imagen para la campaña (JPEG o PNG, máx 5 MB)
  .post('/upload-image', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('image');
    if (!(file instanceof File)) return c.json({ error: 'Sube un archivo de imagen (JPEG o PNG)' }, 400);

    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) return c.json({ error: 'La imagen no puede pesar más de 5 MB' }, 400);

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    let mimetype: string | null = null;
    const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

    if (isPng) mimetype = 'image/png';
    else if (isJpg) mimetype = 'image/jpeg';
    else return c.json({ error: 'Formato no permitido. Solo se aceptan imágenes JPEG y PNG' }, 400);

    const id = nanoid(16);
    await tx(async (client) => {
      await client.query(
        'INSERT INTO campaign_images (id, filename, mimetype, data, size) VALUES ($1, $2, $3, $4, $5)',
        [id, file.name || 'imagen', mimetype, Buffer.from(buffer), file.size],
      );
    });

    return c.json({ imageId: id, filename: file.name, mimetype });
  })

  // Vista previa de importación de contactos (Excel o CSV)
  .post('/import/preview', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    const selectedPhoneCol = form?.get('phoneColumn')?.toString().trim() || undefined;

    if (!(file instanceof File)) return c.json({ error: 'Sube un archivo Excel (.xlsx) o CSV' }, 400);
    if (file.size > 5 * 1024 * 1024) return c.json({ error: 'El archivo pesa más de 5 MB' }, 400);

    try {
      const preview: MarketingImportPreview = await readMarketingFile(await file.arrayBuffer(), selectedPhoneCol);
      return c.json(preview);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  })

  // Crear campaña
  .post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
    const { name, message, imageId, rows } = parsed.data;

    // Verificar que la imagen exista si se especificó
    if (imageId) {
      const img = await one('SELECT id FROM campaign_images WHERE id = $1', [imageId]);
      if (!img) return c.json({ error: 'La imagen seleccionada no existe o fue eliminada' }, 400);
    }

    // Obtener las columnas disponibles de las variables
    const availableCols = Object.keys(rows[0]?.variables ?? {});
    const rowsWithNumber = rows.map((r, i) => ({ row: r.row ?? i + 1, variables: r.variables }));

    // Validar que no haya variables desconocidas ni valores faltantes
    const validation = validateCampaignVariables(message, availableCols, rowsWithNumber);
    if (!validation.valid) {
      if (validation.unknownVariables.length > 0) {
        return c.json(
          {
            error: `Variables desconocidas en el mensaje: ${validation.unknownVariables.map((v) => `{${v}}`).join(', ')}. Solo puedes usar las columnas de la lista.`,
          },
          400,
        );
      }
      if (validation.missingByRow.length > 0) {
        const first = validation.missingByRow[0];
        return c.json(
          {
            error: `La fila ${first.row} tiene valores faltantes para: ${first.missing.map((v) => `{${v}}`).join(', ')}. Todas las filas deben tener valor para las variables usadas.`,
            missingRows: validation.missingByRow,
          },
          400,
        );
      }
    }

    // Filtrar filas con teléfono válido
    const validRecipients: { phone: string; name: string; variables: Record<string, string> }[] = [];
    const seenPhones = new Set<string>();

    for (const r of rows) {
      const norm = normalizePhone(r.phone);
      if (norm.ok && !seenPhones.has(norm.phone)) {
        seenPhones.add(norm.phone);
        validRecipients.push({
          phone: norm.phone,
          name: r.name || '',
          variables: r.variables,
        });
      }
    }

    if (validRecipients.length === 0) {
      return c.json({ error: 'Ningún contacto de la lista tiene un teléfono válido.' }, 400);
    }

    const campaignId = await tx(async (client) => {
      const { rows: insertedCampaign } = await client.query<{ id: number }>(
        'INSERT INTO campaigns (name, message, image_id) VALUES ($1, $2, $3) RETURNING id',
        [name, message, imageId ?? null],
      );
      const id = insertedCampaign[0].id;

      for (const r of validRecipients) {
        await client.query(
          'INSERT INTO campaign_recipients (campaign_id, phone, name, variables, status) VALUES ($1, $2, $3, $4, $5)',
          [id, r.phone, r.name, JSON.stringify(r.variables), 'queued'],
        );
      }

      return id;
    });

    return c.json(await getSummary(campaignId), 201);
  })

  // Detalle de una campaña
  .get('/:id', async (c) => {
    const summary = await getSummary(parseId(c.req.param('id')));
    return summary ? c.json(summary) : c.json({ error: 'Campaña no encontrada' }, 404);
  })

  // Lista de destinatarios
  .get('/:id/recipients', async (c) => {
    const id = parseId(c.req.param('id'));
    const recipients = await query<CampaignRecipient>(
      `SELECT id, campaign_id, phone, name, variables, status, message_id, sent_at, error
       FROM campaign_recipients WHERE campaign_id = $1 ORDER BY id`,
      [id],
    );
    return c.json(recipients);
  })

  // Iniciar o reanudar envío de la campaña
  .post('/:id/start', async (c) => {
    const error = await startCampaign({ campaignId: parseId(c.req.param('id')) });
    return error ? c.json({ error }, 400) : c.json(await waStatus());
  })

  // Cancelar pendientes en cola
  .post('/:id/cancel', async (c) => {
    const id = parseId(c.req.param('id'));
    const n = await exec(
      `UPDATE campaign_recipients SET status = 'cancelled' WHERE campaign_id = $1 AND status = 'queued'`,
      [id],
    );
    return c.json({ cancelled: n, campaign: await getSummary(id) });
  })

  // Reintentar solo los fallidos confirmados
  .post('/:id/retry', async (c) => {
    const id = parseId(c.req.param('id'));
    const n = await exec(
      `UPDATE campaign_recipients SET status = 'queued', error = NULL WHERE campaign_id = $1 AND status = 'failed'`,
      [id],
    );
    return c.json({ requeued: n, campaign: await getSummary(id) });
  })

  // Eliminar campaña (solo si ningún mensaje salió)
  .delete('/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (await isRunning(id)) {
      return c.json({ error: 'La campaña se está enviando ahora mismo: pausa primero.' }, 409);
    }
    const went = await one(
      `SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('sending', 'sent', 'delivered', 'read', 'uncertain')`,
      [id],
    );
    if (went) {
      return c.json(
        {
          error:
            'Ya salieron mensajes de esta campaña: queda en el historial. Puedes cancelar los que siguen en cola.',
        },
        409,
      );
    }
    await exec('DELETE FROM campaigns WHERE id = $1', [id]);
    return c.json({ ok: true });
  });
