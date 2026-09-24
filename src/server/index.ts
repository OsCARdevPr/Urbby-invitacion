import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { assertConfig, config, evolutionConfigured, publicUrlIsLocal, resendConfigured } from './config';
import { db } from './db';
import { authRoutes, requireRole, type AppEnv } from './auth';
import { eventRoutes } from './routes/events';
import { guestRoutes } from './routes/guests';
import { checkinRoutes } from './routes/checkin';
import { waRoutes, webhookUrl } from './routes/wa';
import { publicRoutes } from './routes/public';
import { diagnosticsRoutes } from './routes/diagnostics';
import { handleEvolutionEvent } from './services/webhook';
import { DEFAULT_EMAIL_SUBJECT, DEFAULT_EVENT, DEFAULT_WA_TEMPLATE, PLACEHOLDERS } from '../shared/template';
import { emailJobStatus, recoverEmails } from './worker/emailJob';
import { startWorker, stopWorker } from './worker/whatsappQueue';

// Los secretos se leen en cada petición, así que basta con validarlos antes de escuchar.
assertConfig();

const api = new Hono<AppEnv>();

// Sin sesión: login y webhook de Evolution (protegido por el secreto en la URL).
api.route('/auth', authRoutes);
api.post('/webhooks/evolution/:secret', async (c) => {
  if (!config.webhookSecret || c.req.param('secret') !== config.webhookSecret) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { event?: string; instance?: string; data?: unknown } | null;
  if (!body) return c.json({ ok: true });
  if (body.instance && config.evolution.instance && body.instance !== config.evolution.instance) {
    return c.json({ ok: true, ignored: 'otra instancia' });
  }
  try {
    handleEvolutionEvent(String(body.event ?? ''), body.data);
  } catch (err) {
    console.error('[webhook] error procesando evento', body.event, err);
  }
  return c.json({ ok: true });
});

// Desde aquí, cualquier sesión (admin o portero). Cada grupo restringe más si hace falta.
api.use('*', requireRole('admin', 'doorman'));
api.get('/config', (c) => {
  const isAdmin = c.get('role') === 'admin';
  return c.json({
    role: c.get('role'),
    evolutionConfigured: evolutionConfigured(),
    resendConfigured: resendConfigured(),
    publicBaseUrl: config.publicBaseUrl,
    localUrl: publicUrlIsLocal(),
    senderPhoneDisplay: config.senderPhoneDisplay,
    webhookUrl: isAdmin && config.webhookSecret ? webhookUrl() : null,
    defaults: { waTemplate: DEFAULT_WA_TEMPLATE, emailSubject: DEFAULT_EMAIL_SUBJECT, event: DEFAULT_EVENT },
    placeholders: PLACEHOLDERS,
  });
});
api.route('/checkin', checkinRoutes);
api.route('/events', eventRoutes);
api.route('/guests', guestRoutes);
api.route('/wa', waRoutes);
api.route('/diagnostics', diagnosticsRoutes);
api.get('/email/job', requireRole('admin'), (c) => c.json(emailJobStatus()));
api.all('*', (c) => c.json({ error: 'Ruta no encontrada' }, 404));

const app = new Hono();
app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin', referrerPolicy: 'same-origin' }));
app.onError((err, c) => {
  console.error('[http]', c.req.method, c.req.path, err);
  return c.json({ error: 'Error interno del servidor' }, 500);
});
app.route('/api', api);
app.route('/i', publicRoutes);
app.get('/healthz', (c) => c.json({ ok: true }));

// Panel compilado (vite build). En desarrollo lo sirve Vite en el puerto 5173.
const indexHtml = path.join(config.webDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  const root = path.relative(process.cwd(), config.webDir) || '.';
  // Archivos que existan en dist/web (assets, favicon, logo); si no existe, sigue al fallback del SPA.
  app.use('*', serveStatic({ root }));
  const html = fs.readFileSync(indexHtml, 'utf8');
  app.get('*', (c) => c.html(html));
}

recoverEmails();
startWorker();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Invitaciones Urbby escuchando en http://localhost:${info.port}`);
  console.log(
    `  Evolution: ${evolutionConfigured() ? 'configurada' : 'NO configurada'} · Resend: ${resendConfigured() ? 'configurado' : 'NO configurado'}`,
  );
});

// Al detener el contenedor se espera a que termine el envío en curso, si lo hay,
// para no dejar a nadie como "incierto" sin necesidad. Docker da 10 s antes de matar el proceso.
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[${signal}] cerrando…`);
  await Promise.race([stopWorker(), new Promise((r) => setTimeout(r, 8000))]);
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
