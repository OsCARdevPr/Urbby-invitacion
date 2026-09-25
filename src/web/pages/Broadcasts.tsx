import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, Megaphone, Pause, Play, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { api, useApi } from '../api';
import { PageHeader } from '../components/Layout';
import { waFormat } from '../components/CardPreview';
import { Badge, Button, Card, cx, Field, inputClass, Notice, Spinner, useToast } from '../components/ui';
import { fmtDateTime, formatPhone, pickCurrentEvent } from '../lib';
import { useSession } from '../session';
import type { BroadcastAudience, BroadcastRecipient, BroadcastSummary, EventRow, WaStatusResponse } from '../../shared/types';
import { AUDIENCE_LABEL, BROADCAST_LABEL } from '../../shared/labels';
import { renderTemplate, templateVars } from '../../shared/template';

const SAMPLE_GUEST = { name: 'María José Hernández', business: 'Pupusería La Esquina' };
const AUDIENCES: BroadcastAudience[] = ['invited', 'not_checked_in', 'checked_in', 'all'];

/** Difusiones: un mensaje de texto por WhatsApp a los invitados de un evento, por la misma cola que las invitaciones. */
export function Broadcasts() {
  const { config } = useSession();
  const list = useApi<BroadcastSummary[]>('/broadcasts', 5000);
  const wa = useApi<WaStatusResponse>('/wa/status', 5000);

  return (
    <>
      <PageHeader
        title="Difusiones"
        subtitle="Un mensaje de texto por WhatsApp a los invitados de un evento. Sale por el mismo número y al mismo ritmo que las invitaciones, y comparte su tope diario."
      />

      {config.localUrl ? (
        <div className="mb-6">
          <Notice tone="warn">Estás en desarrollo (PUBLIC_BASE_URL apunta a localhost): puedes crear difusiones, pero no enviarlas.</Notice>
        </div>
      ) : null}
      {!config.evolutionConfigured ? (
        <div className="mb-6">
          <Notice tone="bad">Evolution API no está configurada. Define EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE en el servidor.</Notice>
        </div>
      ) : null}

      <NewBroadcast dailyCap={wa.data?.settings.dailyCap} onCreated={() => void list.reload()} />

      <h2 className="mt-8 mb-3 text-xl font-bold">Enviadas y en curso</h2>
      {list.error ? <Notice tone="bad">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Spinner /> : null}
      {list.data?.length === 0 ? <Card className="p-8 text-center text-ink-mute">Aún no hay difusiones.</Card> : null}
      <div className="grid gap-4">
        {list.data?.map((b) => (
          <BroadcastCard
            key={b.id}
            b={b}
            wa={wa.data}
            onChanged={async () => {
              await Promise.all([list.reload(), wa.reload()]);
            }}
          />
        ))}
      </div>
    </>
  );
}

// ── Nueva difusión ───────────────────────────────────────────────

function NewBroadcast({ dailyCap, onCreated }: { dailyCap?: number; onCreated: () => void }) {
  const { config } = useSession();
  const toast = useToast();
  const events = useApi<EventRow[]>('/events');
  const [eventId, setEventId] = useState<number | null>(null);
  const [audience, setAudience] = useState<BroadcastAudience>('invited');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const counts = useApi<Record<BroadcastAudience, number>>(eventId ? `/broadcasts/audience?eventId=${eventId}` : null);

  useEffect(() => {
    const current = eventId === null && events.data ? pickCurrentEvent(events.data) : undefined;
    if (current) setEventId(current.id);
  }, [events.data, eventId]);

  const event = events.data?.find((e) => e.id === eventId);
  const recipients = counts.data?.[audience] ?? 0;
  const unknown = [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !config.placeholders.includes(k));
  const preview = event && message.trim() ? renderTemplate(message.trim(), templateVars(event, SAMPLE_GUEST)) : '';

  function insertPlaceholder(name: string) {
    const el = textRef.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? message.length;
    const end = el?.selectionEnd ?? start;
    setMessage(message.slice(0, start) + token + message.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!event) return;
    if (!window.confirm(`Se creará una difusión para ${recipients} invitados de "${event.name}". Queda en cola hasta que la envíes. ¿Continuar?`)) return;
    setSaving(true);
    setError(null);
    try {
      await api<BroadcastSummary>('/broadcasts', { body: { eventId: event.id, audience, message } });
      setMessage('');
      toast('Difusión creada: envíala desde la lista de abajo');
      onCreated();
      void counts.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (events.data && events.data.length === 0) {
    return <Card className="p-5 text-ink-mute">Primero crea un evento e importa sus invitados.</Card>;
  }

  return (
    <Card>
      <div className="border-b border-line p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Megaphone className="size-5" /> Nueva difusión
        </h2>
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

          <fieldset>
            <legend className="mb-1.5 text-sm font-bold text-ink-soft">Para quién</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {AUDIENCES.map((a) => (
                <label
                  key={a}
                  className={cx('flex cursor-pointer gap-3 rounded-lg border p-3', audience === a ? 'border-brand bg-brand/10' : 'border-line')}
                >
                  <input type="radio" name="audience" className="mt-1 size-4 accent-[#fab822]" checked={audience === a} onChange={() => setAudience(a)} />
                  <span>
                    <span className="block font-semibold">
                      {AUDIENCE_LABEL[a].label}
                      <span className="ml-1.5 font-normal text-ink-mute tabular-nums">· {counts.data ? counts.data[a] : '…'}</span>
                    </span>
                    <span className="block text-sm text-ink-mute">{AUDIENCE_LABEL[a].hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-sm text-ink-mute">Solo cuenta a quienes tienen teléfono y no figuran “Sin WhatsApp”.</p>
          </fieldset>

          <Field label="Mensaje" hint="Solo texto. Los datos entre llaves se llenan con los de cada invitado y del evento.">
            <div className="mb-2 flex flex-wrap gap-2">
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
              ref={textRef}
              className={`${inputClass} min-h-44 font-mono text-[15px] leading-relaxed`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              maxLength={1500}
              placeholder={'¡Hola {primer_nombre}! Te recordamos que mañana es el {evento} a las {hora} en {lugar}. ¡Te esperamos!'}
            />
          </Field>
          {unknown.length ? <Notice tone="warn">No reconozco {unknown.map((u) => `{${u}}`).join(', ')}: se enviaría tal cual.</Notice> : null}
          {/https?:\/\/|www\.|\{mapa\}/i.test(message) ? (
            <Notice tone="warn">El mensaje lleva un enlace: en WhatsApp sube el riesgo de bloqueo del número.</Notice>
          ) : null}
          {audience === 'all' ? (
            <Notice tone="warn">
              “Todos” incluye a quienes quizá aún no recibieron nada de este número. Escribirle primero con un texto sin invitación sube el
              riesgo de que te reporten.
            </Notice>
          ) : null}
          {error ? <Notice tone="bad">{error}</Notice> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" loading={saving} disabled={!event || !message.trim() || recipients === 0}>
              {recipients ? `Crear difusión para ${recipients}` : 'Nadie cumple el filtro'}
            </Button>
            {dailyCap ? (
              <span className="text-sm text-ink-mute">
                Al ritmo actual salen unos {dailyCap} mensajes al día entre invitaciones y difusiones.
              </span>
            ) : null}
          </div>
        </div>

        <aside>
          <h3 className="mb-2 text-sm font-bold tracking-wide text-ink-mute uppercase">Así le llegará</h3>
          {/* Colores de WhatsApp fijos: es una maqueta del chat, no parte del tema del panel. */}
          <div className="rounded-xl bg-[#efe7dd] p-3">
            <div className="ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-[15px] leading-snug whitespace-pre-wrap text-[#111b21] shadow-sm">
              {preview ? waFormat(preview) : <span className="text-[#667781]">Escribe el mensaje para verlo aquí.</span>}
            </div>
          </div>
        </aside>
      </form>
    </Card>
  );
}

// ── Cada difusión ────────────────────────────────────────────────

function BroadcastCard({ b, wa, onChanged }: { b: BroadcastSummary; wa: WaStatusResponse | null; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const recipients = useApi<BroadcastRecipient[]>(open ? `/broadcasts/${b.id}/recipients` : null, open ? 5000 : undefined);

  const running = Boolean(wa?.state.running && wa.state.broadcastId === b.id);
  const busyElsewhere = Boolean(wa?.state.running && wa.state.broadcastId !== b.id);
  const done = b.total - b.queued;
  const pct = b.total ? Math.round((done / b.total) * 100) : 0;
  const status = running ? 'Enviando' : b.queued === 0 ? 'Terminada' : done > 0 ? 'Pausada' : 'En cola';

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    try {
      const msg = await fn();
      if (msg) toast(msg);
      await onChanged();
      if (open) await recipients.reload();
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="grid gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-bold">{b.event_name}</h3>
            <p className="text-sm text-ink-mute">
              {AUDIENCE_LABEL[b.audience].label} · creada {fmtDateTime(b.created_at)}
            </p>
          </div>
          <Badge tone={running ? 'info' : b.queued === 0 ? 'ok' : 'neutral'}>{status}</Badge>
        </div>

        <p className="line-clamp-3 rounded-md bg-surface-2 p-3 text-sm whitespace-pre-wrap">{waFormat(b.message)}</p>

        <div>
          <div className="mb-1 flex flex-wrap justify-between gap-2 text-sm">
            <span className="font-semibold tabular-nums">
              {b.sent} de {b.total} enviados
            </span>
            <span className="text-ink-mute tabular-nums">
              {b.delivered} entregados · {b.read} leídos
              {b.problems ? ` · ${b.problems} con problemas` : ''}
              {b.cancelled ? ` · ${b.cancelled} cancelados` : ''}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
          {running && wa?.gate ? <p className="mt-1 text-sm text-ink-mute">{wa.gate}</p> : null}
          {busyElsewhere && b.queued > 0 ? (
            <p className="mt-1 text-sm text-ink-mute">La campaña está enviando otra cosa: páusala o espera a que termine para enviar esta.</p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {running ? (
            <Button
              icon={<Pause className="size-4" />}
              loading={busy === 'pause'}
              onClick={() => void run('pause', async () => void (await api('/wa/pause', { method: 'POST' })))}
            >
              Pausar
            </Button>
          ) : b.queued > 0 ? (
            <Button
              variant="primary"
              icon={<Play className="size-4" />}
              loading={busy === 'start'}
              disabled={busyElsewhere}
              onClick={() =>
                void run('start', async () => {
                  if (!window.confirm(`¿Enviar la difusión a ${b.queued} invitados por WhatsApp?`)) return;
                  await api(`/broadcasts/${b.id}/start`, { method: 'POST' });
                  return 'Difusión en marcha';
                })
              }
            >
              {done > 0 ? 'Reanudar' : 'Enviar'}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            icon={open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            onClick={() => setOpen(!open)}
          >
            Destinatarios
          </Button>
          {b.problems > 0 ? (
            <Button
              variant="ghost"
              icon={<RotateCcw className="size-4" />}
              loading={busy === 'retry'}
              onClick={() =>
                void run('retry', async () => {
                  const { requeued } = await api<{ requeued: number }>(`/broadcasts/${b.id}/retry`, { method: 'POST' });
                  return requeued
                    ? `${requeued} vueltos a la cola`
                    : 'No hay fallidos para reintentar: los “Revisar” y “Sin WhatsApp” no se reintentan solos';
                })
              }
            >
              Reintentar fallidos
            </Button>
          ) : null}
          {b.queued > 0 && !running ? (
            <Button
              variant="ghost"
              icon={<XCircle className="size-4" />}
              loading={busy === 'cancel'}
              onClick={() =>
                void run('cancel', async () => {
                  if (!window.confirm(`¿Cancelar los ${b.queued} mensajes que siguen en cola? Lo ya enviado no cambia.`)) return;
                  const { cancelled } = await api<{ cancelled: number }>(`/broadcasts/${b.id}/cancel`, { method: 'POST' });
                  return `${cancelled} cancelados`;
                })
              }
            >
              Cancelar pendientes
            </Button>
          ) : null}
          {!running && b.sent === 0 ? (
            <Button
              variant="danger"
              className="ml-auto"
              icon={<Trash2 className="size-4" />}
              loading={busy === 'delete'}
              onClick={() =>
                void run('delete', async () => {
                  if (!window.confirm('¿Eliminar esta difusión? Aún no se ha enviado ningún mensaje.')) return;
                  await api(`/broadcasts/${b.id}`, { method: 'DELETE' });
                  return 'Difusión eliminada';
                })
              }
            >
              Eliminar
            </Button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="border-t border-line">
          {!recipients.data ? <Spinner /> : null}
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {recipients.data?.map((r) => {
              const [label, tone] = BROADCAST_LABEL[r.status];
              return (
                <li key={r.guest_id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{r.name}</div>
                    <div className="truncate text-ink-mute tabular-nums">
                      {formatPhone(r.phone)}
                      {r.error ? <span className="text-bad"> · {r.error}</span> : null}
                    </div>
                  </div>
                  <Badge tone={tone}>{label}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
