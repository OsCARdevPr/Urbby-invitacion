import { useEffect, useState, type FormEvent } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Field, inputClass, Modal, Notice, useToast } from './ui';
import { EMAIL_LABEL, fmtDateTime, formatPhone, WA_LABEL } from '../lib';
import type { EventRow, GuestRow } from '../../shared/types';

/** Ficha del invitado: tarjeta, estados, acciones y edición. */
export function GuestModal({
  guest,
  event,
  onClose,
  onChanged,
}: {
  guest: GuestRow | null;
  event: EventRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => setEditing(false), [guest?.id]);

  if (!guest) return null;
  const g = guest;
  const [waLabel, waTone] = WA_LABEL[g.wa_status];
  const [emailLabel, emailTone] = EMAIL_LABEL[g.email_status];

  async function act(key: string, path: string, body?: unknown, done?: string) {
    setBusy(key);
    try {
      await api(`/guests/${g.id}${path}`, { method: 'POST', body: body ?? {} });
      if (done) toast(done);
      await onChanged();
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`¿Eliminar a ${g.name} de la lista?`)) return;
    try {
      await api(`/guests/${g.id}`, { method: 'DELETE' });
      toast('Invitado eliminado');
      onClose();
      await onChanged();
    } catch (err) {
      toast((err as Error).message, 'bad');
    }
  }

  const canEnqueue = g.phone && !['queued', 'sending', 'skipped'].includes(g.wa_status);
  const alreadySent = ['sent', 'delivered', 'read'].includes(g.wa_status);

  return (
    <Modal open onClose={onClose} title={g.name} wide>
      {editing ? (
        <EditGuest
          guest={g}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            toast('Datos actualizados');
            await onChanged();
          }}
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-[240px_1fr]">
          <div>
            <img
              src={`/i/${g.token}/card.png?v=${encodeURIComponent(`${event.name}${event.date}${event.time}${event.venue}${g.name}${g.business}`)}`}
              alt={`Tarjeta de ${g.name}`}
              className="w-full rounded-lg border border-line bg-navy"
            />
            <div className="mt-2 flex gap-2">
              <a
                href={`/i/${g.token}/card.png`}
                download={`invitacion-${g.name}.png`}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-line text-sm font-semibold hover:bg-surface-2"
              >
                <Download className="size-4" /> PNG
              </a>
              <a
                href={`/i/${g.token}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-line text-sm font-semibold hover:bg-surface-2"
              >
                <ExternalLink className="size-4" /> Página
              </a>
            </div>
          </div>

          <div className="grid content-start gap-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-ink-mute">Negocio</dt>
              <dd className="font-semibold">{g.business || '—'}</dd>
              <dt className="text-ink-mute">Teléfono</dt>
              <dd className="font-semibold tabular-nums">{formatPhone(g.phone)}</dd>
              <dt className="text-ink-mute">Correo</dt>
              <dd className="font-semibold break-all">{g.email ?? '—'}</dd>
            </dl>

            <section className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold">Correo</h3>
                <Badge tone={emailTone}>{emailLabel}</Badge>
              </div>
              {g.email_sent_at ? <p className="mt-1 text-sm text-ink-mute">Enviado {fmtDateTime(g.email_sent_at)}</p> : null}
              {g.email_error ? <p className="mt-1 text-sm text-bad">{g.email_error}</p> : null}
              {g.email ? (
                <Button
                  className="mt-2"
                  loading={busy === 'email'}
                  onClick={() => void act('email', '/email/send', undefined, 'Correo enviado')}
                >
                  {g.email_status === 'sent' ? 'Reenviar correo' : 'Enviar correo ahora'}
                </Button>
              ) : null}
            </section>

            <section className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold">WhatsApp</h3>
                <Badge tone={waTone}>{waLabel}</Badge>
              </div>
              {g.wa_sent_at ? <p className="mt-1 text-sm text-ink-mute">Enviado {fmtDateTime(g.wa_sent_at)}</p> : null}
              {g.wa_error ? <p className="mt-1 text-sm text-bad">{g.wa_error}</p> : null}
              {g.wa_status === 'uncertain' ? (
                <div className="mt-2">
                  <Notice tone="warn">
                    No se sabe si el mensaje salió. Revisa el chat en el teléfono: si llegó, márcalo como enviado; si no, vuelve a encolarlo.
                  </Notice>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {g.wa_status === 'queued' ? (
                  <Button loading={busy === 'dequeue'} onClick={() => void act('dequeue', '/wa/dequeue', undefined, 'Quitado de la cola')}>
                    Quitar de la cola
                  </Button>
                ) : null}
                {canEnqueue ? (
                  <Button
                    loading={busy === 'enqueue'}
                    onClick={() => {
                      if (alreadySent && !window.confirm('Ya se le envió. ¿Encolarlo para enviarlo otra vez?')) return;
                      void act('enqueue', '/wa/enqueue', undefined, 'Agregado a la cola');
                    }}
                  >
                    {alreadySent ? 'Reenviar' : g.wa_status === 'pending' ? 'Encolar' : 'Reintentar'}
                  </Button>
                ) : null}
                {g.wa_status === 'uncertain' || g.wa_status === 'failed' ? (
                  <Button loading={busy === 'mark'} onClick={() => void act('mark', '/wa/mark-sent', undefined, 'Marcado como enviado')}>
                    Sí le llegó
                  </Button>
                ) : null}
              </div>
            </section>

            <section className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-3">
              <h3 className="mr-auto font-bold">
                Asistencia
                <span className="block text-sm font-normal text-ink-mute">
                  {g.checked_in_at
                    ? `Ingresó ${fmtDateTime(g.checked_in_at)}${g.checked_in_by ? ` · lo registró ${g.checked_in_by}` : ''}`
                    : 'Aún no ingresa'}
                </span>
              </h3>
              {g.checked_in_at ? (
                <Button loading={busy === 'undo'} onClick={() => void act('undo', '/checkin/undo', undefined, 'Ingreso deshecho')}>
                  Deshacer ingreso
                </Button>
              ) : null}
            </section>

            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setEditing(true)}>
                Editar datos
              </Button>
              <Button variant="danger" onClick={() => void remove()} className="ml-auto">
                Eliminar
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditGuest({ guest, onCancel, onSaved }: { guest: GuestRow; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({
    name: guest.name,
    business: guest.business,
    phone: guest.phone ? formatPhone(guest.phone) : '',
    email: guest.email ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/guests/${guest.id}`, { method: 'PATCH', body: form });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Nombre">
        <input className={inputClass} value={form.name} onChange={set('name')} required />
      </Field>
      <Field label="Negocio">
        <input className={inputClass} value={form.business} onChange={set('business')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Teléfono" hint="Con o sin +503">
          <input className={inputClass} value={form.phone} onChange={set('phone')} inputMode="tel" />
        </Field>
        <Field label="Correo">
          <input className={inputClass} value={form.email} onChange={set('email')} type="email" />
        </Field>
      </div>
      {(guest.wa_status !== 'pending' && guest.wa_status !== 'skipped') || guest.email_status === 'sent' ? (
        <Notice tone="info">La tarjeta se regenera con los datos nuevos. Lo que ya se envió no cambia: reenvíalo si hace falta.</Notice>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          Guardar
        </Button>
      </div>
    </form>
  );
}
