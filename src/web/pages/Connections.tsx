import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Mail, MessageCircle, RefreshCw, Send, XCircle } from 'lucide-react';
import { api, useApi } from '../api';
import { PageHeader } from '../components/Layout';
import { WhatsAppPreview } from '../components/CardPreview';
import { Button, Card, cx, Field, inputClass, Notice, Spinner, useToast } from '../components/ui';
import { useSession } from '../session';
import type { EventRow } from '../../shared/types';

interface Step {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
  ms?: number;
}
interface EvolutionDiag {
  steps: Step[];
  ready: boolean;
  linkedNumber: string | null;
  senderPhoneMismatch: boolean;
}
interface EmailDiag {
  steps: Step[];
  ready: boolean;
}
type ChannelResult = { ok: boolean; detail: string };

export function Connections() {
  const { config } = useSession();
  const evolution = useApi<EvolutionDiag>('/diagnostics/evolution');
  const email = useApi<EmailDiag>('/diagnostics/email');

  return (
    <>
      <PageHeader
        title="Conexiones"
        subtitle="Comprueba que la app puede enviar por WhatsApp (Evolution API) y por correo (Resend), y mándate una invitación de prueba."
      />

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Diagnostic
          title="WhatsApp · Evolution API"
          icon={<MessageCircle className="size-5" />}
          data={evolution.data}
          error={evolution.error}
          onRetry={evolution.reload}
        >
          {evolution.data?.linkedNumber && evolution.data.senderPhoneMismatch ? (
            <Notice tone="warn">
              El número vinculado es <b>{evolution.data.linkedNumber}</b>, pero <code>SENDER_PHONE_DISPLAY</code> dice “
              {config.senderPhoneDisplay || 'vacío'}”. Pon <code>SENDER_PHONE_DISPLAY={evolution.data.linkedNumber}</code> en el .env para que
              el correo pida guardar el número correcto.
            </Notice>
          ) : null}
        </Diagnostic>
        <Diagnostic title="Correo · Resend" icon={<Mail className="size-5" />} data={email.data} error={email.error} onRetry={email.reload} />
      </div>

      <TestSend whatsappReady={Boolean(evolution.data?.ready)} emailReady={Boolean(email.data?.ready)} />

      <Card className="mt-6 p-5 text-sm">
        <h2 className="mb-2 text-lg font-bold">Entorno</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-ink-mute">Modo</dt>
          <dd className="font-semibold">{config.localUrl ? 'Desarrollo (esta PC)' : 'Producción'}</dd>
          <dt className="text-ink-mute">URL del QR</dt>
          <dd className="font-semibold break-all">{config.publicBaseUrl}/i/…</dd>
        </dl>
        {config.localUrl ? (
          <p className="mt-2 text-ink-mute">
            En desarrollo el QR apunta a esta PC: sirve para probar el envío, no para entrar al evento. Los envíos masivos están bloqueados.
          </p>
        ) : null}
      </Card>
    </>
  );
}

// ── Diagnóstico paso a paso ──────────────────────────────────────

function Diagnostic({
  title,
  icon,
  data,
  error,
  onRetry,
  children,
}: {
  title: string;
  icon: ReactNode;
  data: { steps: Step[]; ready: boolean } | null;
  error: string | null;
  onRetry: () => Promise<void>;
  children?: ReactNode;
}) {
  const [checking, setChecking] = useState(false);
  const retry = async () => {
    setChecking(true);
    await onRetry();
    setChecking(false);
  };

  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          {icon} {title}
        </h2>
        {data ? (
          <span className={cx('rounded-md px-2 py-0.5 text-xs font-bold', data.ready ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad')}>
            {data.ready ? 'Lista' : 'Revisar'}
          </span>
        ) : null}
      </div>
      <div className="flex-1 p-5">
        {!data && !error ? <Spinner label="Probando…" /> : null}
        {error ? <Notice tone="bad">{error}</Notice> : null}
        {data ? (
          <ol className="grid gap-3">
            {data.steps.map((s) => (
              <li key={s.key} className="flex gap-3">
                {s.ok === true ? (
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-label="Bien" />
                ) : s.ok === false ? (
                  <XCircle className="mt-0.5 size-5 shrink-0 text-bad" aria-label="Falla" />
                ) : (
                  <CircleDashed className="mt-0.5 size-5 shrink-0 text-ink-mute" aria-label="Sin probar" />
                )}
                <div className="min-w-0">
                  <div className="font-semibold">
                    {s.label}
                    {s.ms !== undefined ? <span className="ml-2 text-xs font-normal text-ink-mute tabular-nums">{s.ms} ms</span> : null}
                  </div>
                  <div className={cx('text-sm break-words', s.ok === false ? 'text-bad' : 'text-ink-mute')}>{s.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {children ? <div className="mt-4">{children}</div> : null}
      </div>
      <div className="border-t border-line p-4">
        <Button icon={<RefreshCw className="size-4" />} onClick={() => void retry()} loading={checking} className="w-full">
          Probar de nuevo
        </Button>
      </div>
    </Card>
  );
}

// ── Envío de prueba con datos de un invitado ─────────────────────

function TestSend({ whatsappReady, emailReady }: { whatsappReady: boolean; emailReady: boolean }) {
  const toast = useToast();
  const events = useApi<EventRow[]>('/events');
  const [eventId, setEventId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', business: '', phone: '', email: '' });
  const [channels, setChannels] = useState({ whatsapp: true, email: true });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ whatsapp?: ChannelResult; email?: ChannelResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (eventId === null && events.data?.length) setEventId(events.data[0].id);
  }, [events.data, eventId]);

  const event = events.data?.find((e) => e.id === eventId);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const useWhatsapp = channels.whatsapp && whatsappReady;
  const useEmail = channels.email && emailReady;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!event) return;
    const targets = [useWhatsapp && `WhatsApp ${form.phone}`, useEmail && `correo ${form.email}`].filter(Boolean).join(' y ');
    if (!window.confirm(`Se enviará la invitación real de "${event.name}" por ${targets}. ¿Continuar?`)) return;
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<{ whatsapp?: ChannelResult; email?: ChannelResult }>('/diagnostics/test-send', {
        body: { eventId: event.id, ...form, whatsapp: useWhatsapp, sendEmail: useEmail },
      });
      setResult(r);
      const ok = [r.whatsapp, r.email].filter(Boolean).every((x) => x!.ok);
      toast(ok ? 'Invitación de prueba enviada' : 'La prueba tuvo errores', ok ? 'ok' : 'bad');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (events.data && events.data.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-lg font-bold">Enviar invitación de prueba</h2>
        <p className="mt-1 text-ink-mute">Primero crea un evento: la prueba usa su texto, su fecha y su lugar.</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="border-b border-line p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Send className="size-5" /> Enviar invitación de prueba
        </h2>
        <p className="mt-1 text-sm text-ink-mute">
          Escribe los datos de un invitado de prueba (usa tu número y tu correo). Se envía la invitación real del evento: la tarjeta con
          su QR y el texto. No se guarda en la lista de invitados y su QR no da acceso en la puerta.
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid content-start gap-4">
          <Field label="Evento">
            <select className={inputClass} value={eventId ?? ''} onChange={(e) => setEventId(Number(e.target.value))} required>
              {events.data?.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.date}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre">
              <input className={inputClass} value={form.name} onChange={set('name')} required maxLength={80} placeholder="Tu nombre" />
            </Field>
            <Field label="Negocio">
              <input className={inputClass} value={form.business} onChange={set('business')} maxLength={80} placeholder="Negocio de prueba" />
            </Field>
            <Field label="Teléfono (WhatsApp)" hint="Con o sin +503">
              <input
                className={inputClass}
                value={form.phone}
                onChange={set('phone')}
                inputMode="tel"
                required={useWhatsapp}
                placeholder="7000 0000"
              />
            </Field>
            <Field label="Correo">
              <input className={inputClass} value={form.email} onChange={set('email')} type="email" required={useEmail} placeholder="tu@correo.com" />
            </Field>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-bold text-ink-soft">Enviar por</legend>
            <Channel
              label="WhatsApp"
              checked={useWhatsapp}
              disabled={!whatsappReady}
              why="WhatsApp no está listo: revisa la conexión de arriba"
              onChange={(v) => setChannels({ ...channels, whatsapp: v })}
            />
            <Channel
              label="Correo"
              checked={useEmail}
              disabled={!emailReady}
              why="El correo no está listo: revisa la conexión de arriba"
              onChange={(v) => setChannels({ ...channels, email: v })}
            />
          </fieldset>

          {error ? <Notice tone="bad">{error}</Notice> : null}
          {result ? (
            <div className="grid gap-2">
              {result.whatsapp ? <ResultLine label="WhatsApp" r={result.whatsapp} /> : null}
              {result.email ? <ResultLine label="Correo" r={result.email} /> : null}
            </div>
          ) : null}

          <div>
            <Button type="submit" variant="primary" icon={<Send className="size-4" />} loading={sending} disabled={!event || (!useWhatsapp && !useEmail)}>
              Enviar prueba
            </Button>
          </div>
        </div>

        <aside>
          <h3 className="mb-2 text-sm font-bold tracking-wide text-ink-mute uppercase">Así le llegará</h3>
          {event ? (
            <WhatsAppPreview event={event} guestName={form.name.trim() || 'Tu nombre'} guestBusiness={form.business.trim()} />
          ) : (
            <Spinner />
          )}
        </aside>
      </form>
    </Card>
  );
}

function Channel({
  label,
  checked,
  disabled,
  why,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  why: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={cx('flex min-h-11 items-center gap-3 rounded-lg border border-line px-3', disabled && 'opacity-60')}>
      <input type="checkbox" className="size-5 accent-[#fab822]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="font-semibold">{label}</span>
      {disabled ? <span className="text-sm text-ink-mute">{why}</span> : null}
    </label>
  );
}

function ResultLine({ label, r }: { label: string; r: ChannelResult }) {
  return (
    <div className={cx('flex gap-2 rounded-lg px-3 py-2 text-sm', r.ok ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad')}>
      {r.ok ? <CheckCircle2 className="size-5 shrink-0" /> : <XCircle className="size-5 shrink-0" />}
      <span>
        <b>{label}:</b> {r.detail}
      </span>
    </div>
  );
}
