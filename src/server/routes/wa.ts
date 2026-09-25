import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole, type AppEnv } from '../auth';
import { config, evolutionConfigured } from '../config';
import { connectionState, setWebhook } from '../services/evolution';
import { validateSettings } from '../worker/pacing';
import {
  pauseCampaign,
  saveSettings,
  setConnection,
  startCampaign,
  waStatus,
} from '../worker/whatsappQueue';

const settingsSchema = z.object({
  dailyCap: z.number().int(),
  minDelaySec: z.number().int(),
  maxDelaySec: z.number().int(),
  typingMinMs: z.number().int(),
  typingMaxMs: z.number().int(),
  breakEveryMin: z.number().int(),
  breakEveryMax: z.number().int(),
  breakMinSec: z.number().int(),
  breakMaxSec: z.number().int(),
  windowStart: z.string(),
  windowEnd: z.string(),
});

export const webhookUrl = () => `${config.publicBaseUrl}/api/webhooks/evolution/${config.webhookSecret}`;

export const waRoutes = new Hono<AppEnv>()
  .use('*', requireRole('admin'))
  .get('/status', async (c) => c.json(await waStatus()))

  .post('/start', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { eventId?: unknown; broadcastId?: unknown };
    const error = await startCampaign(
      body.broadcastId !== undefined ? { broadcastId: Number(body.broadcastId) } : { eventId: Number(body.eventId) },
    );
    return error ? c.json({ error }, 400) : c.json(await waStatus());
  })

  .post('/pause', async (c) => {
    await pauseCampaign();
    return c.json(await waStatus());
  })

  .put('/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Ajustes no válidos' }, 400);
    const error = validateSettings(parsed.data);
    if (error) return c.json({ error }, 400);
    await saveSettings(parsed.data);
    return c.json(await waStatus());
  })

  // Consulta en vivo a Evolution, a pedido del panel.
  .get('/connection', async (c) => {
    if (!evolutionConfigured()) return c.json({ state: 'no configurado' });
    try {
      const state = await connectionState();
      await setConnection(state);
      return c.json({ state });
    } catch (err) {
      return c.json({ state: 'error', error: (err as Error).message });
    }
  })

  .post('/webhook-setup', async (c) => {
    if (!config.webhookSecret) return c.json({ error: 'Configura WEBHOOK_SECRET primero.' }, 400);
    if (!config.publicBaseUrl.startsWith('https://')) {
      return c.json({ error: 'PUBLIC_BASE_URL debe ser la URL pública con https para que Evolution pueda llamar al webhook.' }, 400);
    }
    try {
      await setWebhook(webhookUrl());
      return c.json({ ok: true, url: webhookUrl() });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });
