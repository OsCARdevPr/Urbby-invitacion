import { Hono } from 'hono';
import { getEvent, getGuestByToken } from '../db';
import { getCardPng } from '../services/card';
import { formatDate, formatTime } from '../../shared/template';
import { escapeHtml as e } from '../services/text';

// Lo que ve el invitado si escanea su propio QR o abre el enlace del correo.
// Solo lectura: abrir esta página NO registra el ingreso.

const TOKEN_RE = /^[A-Za-z0-9_-]{21}$/;

const page = (title: string, body: string) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 25% 20%, #3670AE 0%, #0E306D 35%, #021D59 75%);
         color: #fff; font-family: Manrope, "Segoe UI", system-ui, sans-serif; display: flex; justify-content: center; }
  main { width: 100%; max-width: 480px; padding: 28px 16px 40px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { color: #C6D4EC; margin: 0 0 20px; line-height: 1.5; }
  img { width: 100%; height: auto; border-radius: 16px; display: block; box-shadow: 0 16px 40px rgba(0,0,0,.35); }
  a.btn { display: block; margin-top: 20px; text-align: center; background: #FAB822; color: #021D59; font-weight: 800;
          padding: 14px; border-radius: 12px; text-decoration: none; }
  .tip { font-size: 14px; margin-top: 16px; text-align: center; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

export const publicRoutes = new Hono()
  .get('/:token', (c) => {
    const token = c.req.param('token');
    const guest = TOKEN_RE.test(token) ? getGuestByToken(token) : undefined;
    const event = guest && getEvent(guest.event_id);
    if (!guest || !event) {
      return c.html(page('Invitación no encontrada', '<h1>Invitación no encontrada</h1><p>Revisa que el enlace esté completo.</p>'), 404);
    }
    return c.html(
      page(
        `Invitación · ${event.name}`,
        `<h1>Hola, ${e(guest.name.split(' ')[0])}</h1>
         <p>${e(formatDate(event.date))} · ${e(formatTime(event.time))}<br>${e(event.venue)}</p>
         <img src="/i/${token}/card.png" alt="Tarjeta de invitación de ${e(guest.name)}">
         <a class="btn" href="/i/${token}/card.png" download="invitacion-urbby.png">Descargar invitación</a>
         <p class="tip">Presenta el código QR en la entrada. Sube el brillo de la pantalla para que se lea más rápido.</p>`,
      ),
    );
  })

  .get('/:token/card.png', async (c) => {
    const token = c.req.param('token');
    const guest = TOKEN_RE.test(token) ? getGuestByToken(token) : undefined;
    const event = guest && getEvent(guest.event_id);
    if (!guest || !event) return c.notFound();
    const png = await getCardPng(event, guest);
    return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
  });
