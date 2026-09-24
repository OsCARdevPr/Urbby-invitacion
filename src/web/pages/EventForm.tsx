import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/Layout';
import { Button, Card, Field, inputClass, Notice, Spinner, useToast } from '../components/ui';
import { useSession } from '../session';
import type { EventRow } from '../../shared/types';
import { WhatsAppPreview } from '../components/CardPreview';

type Form = Pick<EventRow, 'name' | 'date' | 'time' | 'venue' | 'address' | 'dress_code' | 'maps_url' | 'wa_template' | 'email_subject'>;

const SAMPLE_GUEST = { name: 'María José Hernández', business: 'Pupusería La Esquina' };

export function EventForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const { config } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const templateRef = useRef<HTMLTextAreaElement>(null);

  const [form, setForm] = useState<Form | null>(
    editing
      ? null
      : {
          ...config.defaults.event,
          date: '',
          address: '',
          maps_url: '',
          wa_template: config.defaults.waTemplate,
          email_subject: config.defaults.emailSubject,
        },
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    api<{ event: EventRow }>(`/events/${id}`)
      .then(({ event }) => setForm(event))
      .catch((err) => setError((err as Error).message));
  }, [editing, id]);

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [key]: e.target.value } : f));

  /** Inserta {placeholder} donde está el cursor del mensaje. */
  function insertPlaceholder(name: string) {
    const el = templateRef.current;
    if (!el || !form) return;
    const token = `{${name}}`;
    const start = el.selectionStart ?? form.wa_template.length;
    const end = el.selectionEnd ?? start;
    const next = form.wa_template.slice(0, start) + token + form.wa_template.slice(end);
    setForm({ ...form, wa_template: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await api<EventRow>(editing ? `/events/${id}` : '/events', { method: editing ? 'PUT' : 'POST', body: form });
      toast(editing ? 'Cambios guardados' : 'Evento creado');
      navigate(`/events/${saved.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm('¿Eliminar el evento y TODOS sus invitados? Esto no se puede deshacer.')) return;
    await api(`/events/${id}`, { method: 'DELETE' });
    toast('Evento eliminado');
    navigate('/');
  }

  if (!form) return error ? <Notice tone="bad">{error}</Notice> : <Spinner />;

  const unknown = [...form.wa_template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !config.placeholders.includes(k));

  return (
    <>
      <PageHeader
        back={
          <Link to={editing ? `/events/${id}` : '/'} className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-ink-mute hover:text-ink">
            <ArrowLeft className="size-4" /> Volver
          </Link>
        }
        title={editing ? 'Editar evento' : 'Nuevo evento'}
      />

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="grid content-start gap-6">
          <Card className="grid gap-4 p-5">
            <h2 className="text-lg font-bold">Datos del evento</h2>
            <Field label="Nombre" hint="Aparece grande en la tarjeta.">
              <input className={inputClass} value={form.name} onChange={set('name')} required maxLength={80} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Fecha">
                <input type="date" className={inputClass} value={form.date} onChange={set('date')} required />
              </Field>
              <Field label="Hora">
                <input type="time" className={inputClass} value={form.time} onChange={set('time')} required />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Lugar" hint="Va en la tarjeta y en el mensaje.">
                <input className={inputClass} value={form.venue} onChange={set('venue')} required maxLength={120} placeholder="Urbby Hub" />
              </Field>
              <Field label="Dress code">
                <input className={inputClass} value={form.dress_code} onChange={set('dress_code')} maxLength={60} placeholder="Business Casual" />
              </Field>
            </div>
            <Field
              label="Link de Google Maps (opcional)"
              hint="Sale como botón en el correo y en la página de la invitación. No va en el WhatsApp a menos que agregues {mapa} al texto."
            >
              <input
                type="url"
                inputMode="url"
                className={inputClass}
                value={form.maps_url}
                onChange={set('maps_url')}
                maxLength={500}
                placeholder="https://maps.app.goo.gl/…"
              />
            </Field>
            <Field label="Dirección (opcional)" hint="Solo se muestra en el correo.">
              <input className={inputClass} value={form.address} onChange={set('address')} maxLength={200} />
            </Field>
          </Card>

          <Card className="grid gap-4 p-5">
            <div>
              <h2 className="text-lg font-bold">Texto de la invitación</h2>
              <p className="mt-1 text-sm text-ink-mute">
                Es el mismo para el WhatsApp (va como texto de la imagen) y para el cuerpo del correo. Evita enlaces: un link en el primer
                mensaje de WhatsApp a alguien que no te tiene guardado sube el riesgo de bloqueo.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {config.placeholders.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => insertPlaceholder(p)}
                  className="min-h-9 rounded-md border border-line bg-surface-2 px-2.5 font-mono text-sm text-ink-soft hover:border-ink-mute"
                >
                  {`{${p}}`}
                </button>
              ))}
            </div>
            <textarea
              ref={templateRef}
              className={`${inputClass} min-h-64 font-mono text-[15px] leading-relaxed`}
              value={form.wa_template}
              onChange={set('wa_template')}
              required
              maxLength={1500}
            />
            {unknown.length ? <Notice tone="warn">No reconozco {unknown.map((u) => `{${u}}`).join(', ')}: se enviaría tal cual.</Notice> : null}
            {/https?:\/\/|www\.|\{mapa\}/i.test(form.wa_template) ? (
              <Notice tone="warn">El texto lleva un enlace. En el WhatsApp sube el riesgo de bloqueo: mejor déjalo solo en el correo.</Notice>
            ) : null}
            <Field label="Asunto del correo">
              <input className={inputClass} value={form.email_subject} onChange={set('email_subject')} required maxLength={150} />
            </Field>
          </Card>

          {error ? <Notice tone="bad">{error}</Notice> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" loading={saving}>
              {editing ? 'Guardar cambios' : 'Crear evento'}
            </Button>
            {editing ? (
              <Button type="button" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => void remove()} className="ml-auto">
                Eliminar evento
              </Button>
            ) : null}
          </div>
        </div>

        <aside className="grid content-start gap-6 lg:sticky lg:top-20">
          <div>
            <h3 className="mb-2 text-sm font-bold tracking-wide text-ink-mute uppercase">Así se verá el WhatsApp</h3>
            <WhatsAppPreview event={form} guestName={SAMPLE_GUEST.name} guestBusiness={SAMPLE_GUEST.business} />
          </div>
        </aside>
      </form>
    </>
  );
}
