import { useEffect, useState } from 'react';
import { Copy, ImageIcon, Share2 } from 'lucide-react';
import { api } from '../api';
import { Button, useToast } from './ui';
import { waFormat } from './CardPreview';
import type { EventRow, GuestRow } from '../../shared/types';
import { renderTemplate, templateVars } from '../../shared/template';

/**
 * El mensaje de la invitación (la tarjeta PNG con el texto) listo para mandarlo a mano: desde el celular con
 * "Compartir", o en WhatsApp Web copiando la imagen y el texto.
 */
export function InvitationMessage({
  guest,
  event,
  cardUrl,
  onChanged,
}: {
  guest: GuestRow;
  event: EventRow;
  cardUrl: string;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [marking, setMarking] = useState(false);
  const text = renderTemplate(event.wa_template, templateVars(event, guest));

  // La tarjeta se baja de antemano: el navegador solo abre el menú de compartir si se llama en el mismo toque.
  useEffect(() => {
    let cancelled = false;
    setFile(null);
    fetch(cardUrl)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`Error ${res.status}`))))
      .then((blob) => {
        if (!cancelled) setFile(new File([blob], `invitacion-${guest.name}.png`, { type: 'image/png' }));
      })
      .catch(() => {
        /* sin la tarjeta solo queda copiar el texto y el botón de descarga */
      });
    return () => {
      cancelled = true;
    };
  }, [cardUrl, guest.name]);

  const canShare = file !== null && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  const canCopyImage = file !== null && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  const canMarkSent = Boolean(guest.phone) && (guest.wa_status === 'pending' || guest.wa_status === 'queued');

  async function share() {
    if (!file) return;
    // El texto también se copia: algunas apps reciben la imagen y descartan el texto.
    void navigator.clipboard?.writeText(text).catch(() => {});
    try {
      await navigator.share({ files: [file], text });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast(`No se pudo compartir: ${(err as Error).message}`, 'bad');
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      toast('Texto copiado');
    } catch {
      toast('No se pudo copiar el texto', 'bad');
    }
  }

  async function copyImage() {
    if (!file) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
      toast('Tarjeta copiada: pégala en el chat y luego copia y pega el texto');
    } catch {
      toast('No se pudo copiar la imagen: usa el botón PNG', 'bad');
    }
  }

  async function markSent() {
    setMarking(true);
    try {
      await api(`/guests/${guest.id}/wa/mark-sent`, { method: 'POST', body: {} });
      toast('WhatsApp marcado como enviado');
      await onChanged();
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setMarking(false);
    }
  }

  return (
    <section className="rounded-lg border border-line p-3">
      <h3 className="font-bold">Mensaje de invitación</h3>
      <p className="text-sm text-ink-mute">
        {canShare
          ? 'Compartir abre WhatsApp u otra app con la tarjeta y este texto. El texto también se copia, por si la app no lo pega.'
          : 'Copia la tarjeta y el texto para pegarlos en WhatsApp Web, o descarga el PNG.'}
      </p>
      <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-surface-2 p-3 text-sm leading-snug whitespace-pre-wrap">{waFormat(text)}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {canShare ? (
          <Button variant="primary" icon={<Share2 className="size-4" />} onClick={() => void share()}>
            Compartir
          </Button>
        ) : null}
        {canCopyImage ? (
          <Button icon={<ImageIcon className="size-4" />} onClick={() => void copyImage()}>
            Copiar tarjeta
          </Button>
        ) : null}
        <Button icon={<Copy className="size-4" />} onClick={() => void copyText()}>
          Copiar texto
        </Button>
      </div>
      {canMarkSent ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <p className="mr-auto text-sm text-ink-mute">¿Se la mandaste tú por WhatsApp? Márcalo para que la campaña no se la repita.</p>
          <Button loading={marking} onClick={() => void markSent()}>
            Ya se la envié
          </Button>
        </div>
      ) : null}
    </section>
  );
}
