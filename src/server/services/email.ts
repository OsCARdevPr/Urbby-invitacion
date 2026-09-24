import { Resend } from 'resend';
import { config, resendConfigured } from '../config';
import type { EventRow, GuestRow } from '../../shared/types';
import { escapeHtml } from './text';
import { formatDate, formatTime, renderTemplate, templateVars } from '../../shared/template';
import { guestUrl } from './qr';

let client: Resend | null = null;
const resend = () => (client ??= new Resend(config.resend.apiKey));

/** Formato de WhatsApp → HTML: *negrita*, _cursiva_, ~tachado~, enlaces y saltos de línea. Escapa todo lo demás. */
export function waToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>')
    .replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:#1F4FA3">${url}</a>`)
    .replace(/\n/g, '<br>');
}

/** Formato de WhatsApp → texto plano (quita los asteriscos de negrita). */
const waToText = (text: string) => text.replace(/\*([^*\n]+)\*/g, '$1');

export function buildEmail(event: EventRow, guest: GuestRow) {
  const vars = templateVars(event, guest);
  const subject = renderTemplate(event.email_subject, vars);
  const message = renderTemplate(event.wa_template, vars);
  const link = guestUrl(guest.token);
  const when = `${formatDate(event.date)} · ${formatTime(event.time)}`;
  const phone = config.senderPhoneDisplay;
  const e = escapeHtml;

  const waLine = guest.phone && phone
    ? `<p style="margin:0 0 16px">También te la enviaremos por WhatsApp desde el <strong>${e(phone)}</strong>. Guárdalo en tus contactos para recibirla sin problemas.</p>`
    : '';
  const mapsButton = event.maps_url
    ? `<p style="margin:0 0 20px"><a href="${e(event.maps_url)}" style="display:inline-block;background:#FAB822;color:#021D59;font-weight:800;text-decoration:none;padding:12px 20px;border-radius:10px">📍 Ver ubicación en Google Maps</a></p>`
    : '';

  const html = `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#EEF2F9;font-family:Manrope,'Segoe UI',Helvetica,Arial,sans-serif;color:#0B1B3F">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden">
        <tr><td style="background:#021D59;padding:20px 28px;color:#FAB822;font-size:22px;font-weight:800;letter-spacing:.5px">Urbby</td></tr>
        <tr><td style="padding:28px 28px 12px;font-size:16px;line-height:1.6">
          <p style="margin:0 0 16px">${waToHtml(message)}</p>
          <p style="margin:0 0 16px;color:#51607D">📅 ${e(when)}${event.address ? `<br>📍 ${e(event.address)}` : ''}</p>
          ${mapsButton}
        </td></tr>
        <tr><td align="center" style="padding:0 28px 8px">
          <img src="cid:invitacion" width="504" alt="Tarjeta de invitación de ${e(guest.name)}" style="display:block;width:100%;max-width:504px;height:auto;border-radius:12px">
        </td></tr>
        <tr><td style="padding:20px 28px 28px;font-size:16px;line-height:1.55">
          <p style="margin:0 0 16px">Si la imagen no carga, abre tu invitación aquí: <a href="${e(link)}" style="color:#1F4FA3">${e(link)}</a></p>
          ${waLine}
          <p style="margin:0"><strong>Equipo Urbby</strong></p>
        </td></tr>
        <tr><td style="background:#F5F7FB;padding:16px 28px;font-size:12px;color:#6B7A99">
          Urbby El Salvador, S.A. de C.V. · ¿Dudas? Responde a este correo o escribe a ${e(config.resend.replyTo)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    waToText(message),
    '',
    `Fecha: ${when}`,
    event.address ? `Dirección: ${event.address}` : '',
    event.maps_url ? `Ubicación en Google Maps: ${event.maps_url}` : '',
    '',
    'Tu tarjeta de invitación va adjunta.',
    `También puedes abrirla aquí: ${link}`,
    guest.phone && phone ? `\nTambién te la enviaremos por WhatsApp desde el ${phone}. Guárdalo en tus contactos.` : '',
    '',
    'Equipo Urbby',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');

  return { subject, html, text };
}

/**
 * Envía la invitación con la tarjeta incrustada (cid) y además como adjunto descargable.
 * `idempotencyKey` evita duplicados si un envío masivo se reintenta.
 */
export async function sendInvitationEmail(event: EventRow, guest: GuestRow, png: Buffer, idempotencyKey: string) {
  if (!resendConfigured()) throw new Error('Resend no está configurado (RESEND_API_KEY)');
  if (!guest.email) throw new Error('El invitado no tiene correo');
  const { subject, html, text } = buildEmail(event, guest);

  const { data, error } = await resend().emails.send(
    {
      from: config.resend.from,
      to: guest.email,
      replyTo: config.resend.replyTo,
      subject,
      html,
      text,
      attachments: [
        { filename: 'invitacion.png', content: png, contentId: 'invitacion' },
        { filename: `invitacion-urbby-${slug(guest.name)}.png`, content: png },
      ],
    },
    { idempotencyKey },
  );
  if (error) throw Object.assign(new Error(error.message), { name: error.name });
  return { id: data?.id ?? null };
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'invitado';
