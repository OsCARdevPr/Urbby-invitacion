import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { EventRow } from '../../shared/types';
import { renderTemplate, templateVars } from '../../shared/template';

export type PreviewEvent = Pick<EventRow, 'name' | 'date' | 'time' | 'venue' | 'address' | 'dress_code' | 'maps_url' | 'wa_template'>;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Tarjeta renderizada en el servidor con los datos dados. Se pide con una pausa para no generar
 * una imagen por cada tecla.
 */
export function CardPreview({ event, guestName, guestBusiness }: { event: PreviewEvent; guestName: string; guestBusiness: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { name, date, time, venue, dress_code } = event;

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const blob = await api<Blob>('/events/card-preview', {
          body: { name, date: date || today(), time, venue, dress_code, guestName, guestBusiness },
        });
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        setUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return next;
        });
      } catch {
        /* la vista previa es solo informativa */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, date, time, venue, dress_code, guestName, guestBusiness]);

  return (
    <div className="relative aspect-[4/5] overflow-hidden rounded-md bg-[#021d59]">
      {url ? <img src={url} alt="Vista previa de la tarjeta" className={`size-full object-cover transition ${loading ? 'opacity-60' : ''}`} /> : null}
      {loading && !url ? <div className="absolute inset-0 grid place-items-center text-sm text-white/70">Generando tarjeta…</div> : null}
    </div>
  );
}

/** Maqueta del mensaje tal como llega por WhatsApp: la tarjeta con el texto de la invitación debajo. */
export function WhatsAppPreview({ event, guestName, guestBusiness }: { event: PreviewEvent; guestName: string; guestBusiness: string }) {
  const text = renderTemplate(event.wa_template, templateVars({ ...event, date: event.date || today() }, { name: guestName, business: guestBusiness }));
  return (
    // Colores de WhatsApp fijos: es una maqueta del chat, no parte del tema del panel.
    <div className="rounded-xl bg-[#efe7dd] p-3">
      <div className="ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#d9fdd3] p-2 text-[15px] leading-snug whitespace-pre-wrap text-[#111b21] shadow-sm">
        <CardPreview event={event} guestName={guestName} guestBusiness={guestBusiness} />
        <div className="px-1 pt-2">{waFormat(text)}</div>
      </div>
    </div>
  );
}

/** Formato de WhatsApp: *negrita*, _cursiva_, ~tachado~. */
export function waFormat(text: string): ReactNode[] {
  return text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g).map((part, i) => {
    if (/^\*[^*]+\*$/.test(part)) return <b key={i}>{part.slice(1, -1)}</b>;
    if (/^_[^_]+_$/.test(part)) return <i key={i}>{part.slice(1, -1)}</i>;
    if (/^~[^~]+~$/.test(part)) return <s key={i}>{part.slice(1, -1)}</s>;
    return part;
  });
}
