import { Resend } from 'resend';
import { config, resendConfigured } from '../config';
import type { EventRow, GuestRow } from '../../shared/types';
import { escapeHtml } from './text';
import { formatDate, formatTime, renderTemplate, templateVars } from '../../shared/template';
import { guestUrl } from './qr';

let client: Resend | null = null;
const resend = () => (client ??= new Resend(config.resend.apiKey));

export function buildEmail(event: EventRow, guest: GuestRow) {
  const vars = templateVars(event, guest);
  const subject = renderTemplate(event.email_subject, vars);
  const link = guestUrl(guest.token);
  const when = `${formatDate(event.date)} · ${formatTime(event.time)}`;
  const phone = config.senderPhoneDisplay;
  const e = escapeHtml;

  const waLine = guest.phone && phone
    ? `<p style="margin:0 0 16px">También te la enviaremos por WhatsApp desde el <strong>${e(phone)}</strong>. Guárdalo en tus contactos para recibirla sin problemas.</p>`
    : '';

  const html = `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#EEF2F9;font-family:Manrope,'Segoe UI',Helvetica,Arial,sans-serif;color:#0B1B3F">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden">
        <tr><td style="background:#021D59;padding:20px 28px;color:#FAB822;font-size:22px;font-weight:800;letter-spacing:.5px">Urbby</td></tr>
        <tr><td style="padding:28px 28px 8px;font-size:16px;line-height:1.55">
          <p style="margin:0 0 16px;font-size:20px;font-weight:700">Hola ${e(vars.primer_nombre)},</p>
          <p style="margin:0 0 16px">Te invitamos a <strong>${e(event.name)}</strong>${guest.business ? ` como parte de <strong>${e(guest.business)}</strong>` : ''}.</p>
          <p style="margin:0 0 4px"><strong>📅 ${e(when)}</strong></p>
          <p style="margin:0 0 20px"><strong>📍 ${e(event.venue)}</strong>${event.address ? `<br><span style="color:#51607D">${e(event.address)}</span>` : ''}</p>
          <p style="margin:0 0 16px">Esta es tu tarjeta de invitación. <strong>Presenta el código QR en la entrada</strong> para poder ingresar.</p>
        </td></tr>
        <tr><td align="center" style="padding:0 28px 8px">
          <img src="cid:invitacion" width="504" alt="Tarjeta de invitación de ${e(guest.name)}" style="display:block;width:100%;max-width:504px;height:auto;border-radius:12px">
        </td></tr>
        <tr><td style="padding:20px 28px 28px;font-size:16px;line-height:1.55">
          <p style="margin:0 0 16px">Si la imagen no carga, abre tu invitación aquí: <a href="${e(link)}" style="color:#1F4FA3">${e(link)}</a></p>
          ${waLine}
          <p style="margin:0">¡Te esperamos!<br><strong>Equipo Urbby</strong></p>
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
    `Hola ${vars.primer_nombre},`,
    '',
    `Te invitamos a ${event.name}${guest.business ? ` como parte de ${guest.business}` : ''}.`,
    `Fecha: ${when}`,
    `Lugar: ${event.venue}${event.address ? `, ${event.address}` : ''}`,
    '',
    'Tu tarjeta de invitación va adjunta. Presenta el código QR en la entrada para poder ingresar.',
    `También puedes abrirla aquí: ${link}`,
    guest.phone && phone ? `\nTambién te la enviaremos por WhatsApp desde el ${phone}. Guárdalo en tus contactos.` : '',
    '',
    '¡Te esperamos!',
    'Equipo Urbby',
  ].join('\n');

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
