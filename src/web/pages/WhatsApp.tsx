import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Pause, Play, RefreshCw, ShieldCheck, Webhook } from 'lucide-react';
import { Link } from 'react-router';
import { api, useApi } from '../api';
import { PageHeader } from '../components/Layout';
import { Badge, Button, Card, cx, Field, inputClass, Notice, Spinner, useToast } from '../components/ui';
import { fmtDateTime, fmtDuration } from '../lib';
import { useSession } from '../session';
import type { WaSettings, WaStatusResponse } from '../../shared/types';

export function WhatsApp() {
  const { config } = useSession();
  const toast = useToast();
  const status = useApi<WaStatusResponse>('/wa/status', 5000);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const now = useNow();

  // Evento por defecto: el de la campaña, o el que tenga invitados en cola.
  useEffect(() => {
    const d = status.data;
    if (!d || selectedId !== null) return;
    const byId = (id: number | null) => d.queuedByEvent.find((e) => e.eventId === id);
    const pick = byId(d.state.eventId) ?? d.queuedByEvent.find((e) => e.queued > 0) ?? d.queuedByEvent[0];
    if (pick) setSelectedId(pick.eventId);
  }, [status.data, selectedId]);

  if (status.error) return <Notice tone="bad">{status.error}</Notice>;
  if (!status.data) return <Spinner />;
  const s = status.data;
  const campaignEvent = s.queuedByEvent.find((e) => e.eventId === s.state.eventId);
  const selected = s.queuedByEvent.find((e) => e.eventId === selectedId);
  // Lo que se muestra: el evento que está enviando, o el elegido para empezar.
  const shownQueued = s.state.running ? s.queued : (selected?.queued ?? 0);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setBusy(null);
    }
  }

  const start = () =>
    run('start', async () => {
      status.setData(await api<WaStatusResponse>('/wa/start', { body: { eventId: selectedId } }));
      toast(`Campaña en marcha: ${selected?.name ?? ''}`);
    });
  const pause = () =>
    run('pause', async () => {
      status.setData(await api<WaStatusResponse>('/wa/pause', { method: 'POST' }));
      toast('Campaña pausada', 'info');
    });
  const checkConnection = () =>
    run('conn', async () => {
      const r = await api<{ state: string; error?: string }>('/wa/connection');
      toast(r.state === 'open' ? 'WhatsApp conectado' : `Estado: ${r.error ?? r.state}`, r.state === 'open' ? 'ok' : 'bad');
      await status.reload();
    });
  const setupWebhook = () =>
    run('webhook', async () => {
      await api('/wa/webhook-setup', { method: 'POST' });
      toast('Webhook configurado en Evolution');
    });

  const waitMs = s.state.nextSendAt - now;
  const sending = s.state.running && s.gate === null;
  const connected = s.connection.state === 'open';

  return (
    <>
      <PageHeader
        title="Campaña de WhatsApp"
        subtitle="Se envía un evento a la vez. El tope diario es uno solo para todos, porque todo sale del mismo número."
      />

      {config.localUrl ? (
        <div className="mb-6">
          <Notice tone="warn">Estás en desarrollo: el QR de las invitaciones apunta a localhost, así que la campaña no se puede iniciar.</Notice>
        </div>
      ) : null}
      {!config.evolutionConfigured ? (
        <div className="mb-6">
          <Notice tone="bad">Evolution API no está configurada. Define EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE en el servidor.</Notice>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid content-start gap-6">
          {/* Estado */}
          <Card className="overflow-hidden">
            <div className={cx('flex flex-col gap-4 p-5 sm:flex-row sm:items-center', s.state.running ? 'bg-navy text-white' : '')}>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className={cx('size-2.5 rounded-full', s.state.running ? 'animate-pulse bg-brand' : 'bg-ink-mute')} />
                  <h2 className="text-xl font-extrabold">{s.state.running ? 'En marcha' : 'Detenida'}</h2>
                </div>
                {s.state.running && campaignEvent ? (
                  <p className="mt-1 font-semibold text-brand">Enviando: {campaignEvent.name}</p>
                ) : null}
                <p className={cx('mt-1', s.state.running ? 'text-white/75' : 'text-ink-mute')}>
                  {sending
                    ? 'Enviando el siguiente mensaje…'
                    : s.gate === 'Esperando la pausa entre mensajes'
                      ? `Siguiente envío en ${fmtDuration(waitMs)}`
                      : (s.gate ?? '')}
                </p>
              </div>
              {s.state.running ? (
                <Button variant="secondary" icon={<Pause className="size-4" />} onClick={() => void pause()} loading={busy === 'pause'}>
                  Pausar
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon={<Play className="size-4" />}
                  onClick={() => void start()}
                  loading={busy === 'start'}
                  disabled={!shownQueued || !config.evolutionConfigured || config.localUrl}
                >
                  {selectedId === s.state.eventId && shownQueued > 0 && s.state.lastSendAt && !s.state.pauseReason?.startsWith('Terminado')
                    ? 'Reanudar'
                    : 'Empezar'}
                </Button>
              )}
            </div>

            {!s.state.running ? (
              <div className="border-t border-line px-5 py-4">
                <Field label="Evento a enviar" hint="Solo se envía a los invitados en cola de este evento. Encólalos desde el detalle del evento.">
                  <select className={inputClass} value={selectedId ?? ''} onChange={(e) => setSelectedId(Number(e.target.value))}>
                    {s.queuedByEvent.length === 0 ? <option value="">No hay eventos</option> : null}
                    {s.queuedByEvent.map((e) => (
                      <option key={e.eventId} value={e.eventId}>
                        {e.name} · {e.date} — {e.queued} en cola
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : null}

            <div className="grid grid-cols-2 divide-x divide-line border-t border-line sm:grid-cols-3">
              <Metric label="En cola" value={shownQueued} />
              <Metric label="Hoy" value={`${s.sentToday} / ${s.settings.dailyCap}`}>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-brand" style={{ width: `${Math.min(100, (s.sentToday / s.settings.dailyCap) * 100)}%` }} />
                </div>
              </Metric>
              <Metric label="Horario" value={`${s.settings.windowStart}–${s.settings.windowEnd}`} hint={s.inWindow ? 'Dentro del horario' : 'Fuera de horario'} />
            </div>

            {shownQueued > 0 ? (
              <p className="border-t border-line px-5 py-3 text-sm text-ink-mute">
                A este ritmo, la cola de este evento termina en unos <b className="text-ink">{estimateDays(s, shownQueued)}</b>.
                {s.state.lastSendAt ? ` Último envío: ${fmtDateTime(new Date(s.state.lastSendAt).toISOString())}.` : ''}
              </p>
            ) : null}
            {s.state.lastError ? (
              <div className="border-t border-line px-5 py-3">
                <Notice tone="bad">Último error: {s.state.lastError}</Notice>
              </div>
            ) : null}
          </Card>

          <SettingsForm settings={s.settings} onSaved={(next) => status.setData(next)} />
        </div>

        <aside className="grid content-start gap-6">
          <Card className="p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">Conexión</h2>
              <Badge tone={connected ? 'ok' : s.connection.state === 'unknown' ? 'neutral' : 'bad'}>
                {connected ? 'Conectado' : s.connection.state === 'unknown' ? 'Sin revisar' : s.connection.state}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-ink-mute">
              {s.connection.checkedAt ? `Revisada ${fmtDateTime(s.connection.checkedAt)}.` : 'Aún no se ha revisado.'} Antes de cada envío se
              vuelve a comprobar; si se cae, la campaña se pausa sola.
            </p>
            <Button className="mt-3 w-full" icon={<RefreshCw className="size-4" />} onClick={() => void checkConnection()} loading={busy === 'conn'}>
              Comprobar ahora
            </Button>
            <Link to="/conexiones" className="mt-2 block text-center text-sm font-semibold text-ink-soft hover:text-ink">
              Diagnóstico completo y envío de prueba →
            </Link>
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Webhook className="size-5" /> Estados de entrega
            </h2>
            <p className="mt-1 text-sm text-ink-mute">
              El webhook avisa cuando un mensaje se entrega o se lee, para verlo en la lista de invitados.
            </p>
            {config.webhookUrl ? (
              <>
                <code className="mt-3 block rounded-md bg-surface-2 p-2 text-xs break-all text-ink-soft">{config.webhookUrl}</code>
                <Button className="mt-3 w-full" onClick={() => void setupWebhook()} loading={busy === 'webhook'}>
                  Configurar en Evolution
                </Button>
                <p className="mt-2 text-xs text-ink-mute">Reemplaza el webhook que tenga la instancia.</p>
              </>
            ) : (
              <div className="mt-3">
                <Notice tone="warn">Define WEBHOOK_SECRET en el servidor para activarlo.</Notice>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <ShieldCheck className="size-5" /> Para cuidar el número
            </h2>
            <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-sm text-ink-soft">
              <li>Usa el número secundario unos días a mano antes de la campaña (chats reales, respuestas).</li>
              <li>Importa el .vcf en ese teléfono antes de enviar.</li>
              <li>Manda primero los correos: piden guardar el número.</li>
              <li>No subas el tope diario de golpe. Si ves errores o bloqueos, pausa un día.</li>
              <li>Responde a quien conteste: las conversaciones de ida y vuelta protegen el número.</li>
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Metric({ label, value, hint, children }: { label: string; value: string | number; hint?: string; children?: ReactNode }) {
  return (
    <div className="p-4 [&:nth-child(3)]:col-span-2 [&:nth-child(3)]:border-t [&:nth-child(3)]:border-line sm:[&:nth-child(3)]:col-span-1 sm:[&:nth-child(3)]:border-t-0">
      <div className="text-xs font-bold tracking-wide text-ink-mute uppercase">{label}</div>
      <div className="mt-1 font-display text-2xl font-extrabold tabular-nums">{value}</div>
      {hint ? <div className="text-sm text-ink-mute">{hint}</div> : null}
      {children}
    </div>
  );
}

/** Días hábiles de envío que faltan, según el tope diario (lo que manda es el tope, no las pausas). */
function estimateDays(s: WaStatusResponse, queued: number): string {
  const leftToday = Math.max(0, s.settings.dailyCap - s.sentToday);
  const rest = Math.max(0, queued - leftToday);
  const days = rest === 0 ? 1 : 1 + Math.ceil(rest / s.settings.dailyCap);
  return days === 1 ? 'hoy o mañana' : `${days} días`;
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ── Ajustes de ritmo ─────────────────────────────────────────────

/** En pantalla, las pausas van en minutos y "escribiendo" en segundos; el servidor guarda segundos y ms. */
function SettingsForm({ settings, onSaved }: { settings: WaSettings; onSaved: (s: WaStatusResponse) => void }) {
  const toast = useToast();
  const toForm = (x: WaSettings) => ({
    dailyCap: String(x.dailyCap),
    minDelayMin: String(round(x.minDelaySec / 60)),
    maxDelayMin: String(round(x.maxDelaySec / 60)),
    typingMinSec: String(round(x.typingMinMs / 1000)),
    typingMaxSec: String(round(x.typingMaxMs / 1000)),
    breakEveryMin: String(x.breakEveryMin),
    breakEveryMax: String(x.breakEveryMax),
    breakMinMin: String(round(x.breakMinSec / 60)),
    breakMaxMin: String(round(x.breakMaxSec / 60)),
    windowStart: x.windowStart,
    windowEnd: x.windowEnd,
  });
  const [form, setForm] = useState(toForm(settings));
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const n = (v: string) => Number(v.replace(',', '.'));
    try {
      const next = await api<WaStatusResponse>('/wa/settings', {
        method: 'PUT',
        body: {
          dailyCap: Math.round(n(form.dailyCap)),
          minDelaySec: Math.round(n(form.minDelayMin) * 60),
          maxDelaySec: Math.round(n(form.maxDelayMin) * 60),
          typingMinMs: Math.round(n(form.typingMinSec) * 1000),
          typingMaxMs: Math.round(n(form.typingMaxSec) * 1000),
          breakEveryMin: Math.round(n(form.breakEveryMin)),
          breakEveryMax: Math.round(n(form.breakEveryMax)),
          breakMinSec: Math.round(n(form.breakMinMin) * 60),
          breakMaxSec: Math.round(n(form.breakMaxMin) * 60),
          windowStart: form.windowStart,
          windowEnd: form.windowEnd,
        },
      });
      onSaved(next);
      setForm(toForm(next.settings));
      toast('Ajustes guardados');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const pair = (a: keyof typeof form, b: keyof typeof form, unit: string) => (
    <div className="flex items-center gap-2">
      <input className={inputClass} inputMode="decimal" value={form[a]} onChange={set(a)} aria-label="mínimo" />
      <span className="text-ink-mute">a</span>
      <input className={inputClass} inputMode="decimal" value={form[b]} onChange={set(b)} aria-label="máximo" />
      <span className="shrink-0 text-sm text-ink-mute">{unit}</span>
    </div>
  );

  return (
    <Card>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 p-5 text-left">
        <div>
          <h2 className="text-lg font-bold">Ritmo de envío</h2>
          <p className="text-sm text-ink-mute">
            {settings.dailyCap} al día · cada {round(settings.minDelaySec / 60)}–{round(settings.maxDelaySec / 60)} min · pausa larga cada{' '}
            {settings.breakEveryMin}–{settings.breakEveryMax}
          </p>
        </div>
        <span className="text-sm font-semibold text-ink-soft">{open ? 'Cerrar' : 'Cambiar'}</span>
      </button>
      {open ? (
        <form onSubmit={submit} className="grid gap-4 border-t border-line p-5">
          <Notice tone="warn">
            Los valores por defecto son conservadores a propósito. Hay reportes de bloqueos con 15–20 mensajes al día a personas que no tienen
            guardado el número.
          </Notice>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Máximo por día">
              <input className={inputClass} inputMode="numeric" value={form.dailyCap} onChange={set('dailyCap')} />
            </Field>
            <Field label="Horario (El Salvador)">
              <div className="flex items-center gap-2">
                <input type="time" className={inputClass} value={form.windowStart} onChange={set('windowStart')} />
                <span className="text-ink-mute">a</span>
                <input type="time" className={inputClass} value={form.windowEnd} onChange={set('windowEnd')} />
              </div>
            </Field>
          </div>
          <Field label="Pausa entre mensajes" hint="Se sortea un valor al azar dentro del rango.">
            {pair('minDelayMin', 'maxDelayMin', 'min')}
          </Field>
          <Field label="Tiempo mostrando “escribiendo…”">{pair('typingMinSec', 'typingMaxSec', 's')}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pausa larga cada">{pair('breakEveryMin', 'breakEveryMax', 'envíos')}</Field>
            <Field label="Duración de la pausa larga">{pair('breakMinMin', 'breakMaxMin', 'min')}</Field>
          </div>
          {error ? <Notice tone="bad">{error}</Notice> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving}>
              Guardar ajustes
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
