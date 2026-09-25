import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Check, Contact, FileSpreadsheet, Mail, MessageCircle, Pencil, Search, UserPlus } from 'lucide-react';
import { api, useApi } from '../api';
import { PageHeader } from '../components/Layout';
import { Badge, Button, Card, cx, inputClass, Notice, Spinner, Stat, useToast } from '../components/ui';
import { ImportModal } from '../components/ImportModal';
import { AddGuestModal } from '../components/AddGuestModal';
import { GuestModal } from '../components/GuestModal';
import { EMAIL_LABEL, fmtTime, fold, formatPhone, WA_LABEL, type Tone } from '../lib';
import { useSession } from '../session';
import type { EventRow, EventStats, GuestRow } from '../../shared/types';
import { formatDate, formatTime } from '../../shared/template';

interface EmailJob {
  id: number;
  running: boolean;
  eventId: number | null;
  total: number;
  done: number;
  failed: number;
  lastError: string | null;
}

const FILTERS = {
  all: { label: 'Todos', test: () => true },
  wa_pending: { label: 'WhatsApp sin enviar', test: (g: GuestRow) => g.wa_status === 'pending' },
  queued: { label: 'En cola', test: (g: GuestRow) => g.wa_status === 'queued' || g.wa_status === 'sending' },
  problems: {
    label: 'Con problemas',
    test: (g: GuestRow) => ['failed', 'no_whatsapp', 'uncertain'].includes(g.wa_status) || g.email_status === 'failed',
  },
  checked_in: { label: 'Ingresaron', test: (g: GuestRow) => Boolean(g.checked_in_at) },
} as const;
type FilterKey = keyof typeof FILTERS;

export function EventDetail() {
  const { id } = useParams();
  const { config } = useSession();
  const toast = useToast();
  const detail = useApi<{ event: EventRow; stats: EventStats; byDoorman: { name: string; count: number }[] }>(`/events/${id}`, 8000);
  const guests = useApi<GuestRow[]>(`/events/${id}/guests`, 8000);
  const [startedJobId, setStartedJobId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<GuestRow | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await Promise.all([detail.reload(), guests.reload()]);
  }, [detail, guests]);

  // Progreso del envío de correos: se consulta seguido mientras hay uno en curso (propio o de otra pestaña).
  const jobPoll = useApi<EmailJob>('/email/job', 1500);
  const emailJob = jobPoll.data?.eventId === Number(id) && jobPoll.data.running ? jobPoll.data : null;
  useEffect(() => {
    const j = jobPoll.data;
    if (startedJobId === null || !j || j.id !== startedJobId || j.running) return;
    setStartedJobId(null);
    void refresh();
    toast(`Correos enviados: ${j.done}${j.failed ? ` · fallaron ${j.failed}` : ''}`, j.failed ? 'warn' : 'ok');
  }, [jobPoll.data, startedJobId, refresh, toast]);

  const list = useMemo(() => {
    const q = fold(query.trim());
    return (guests.data ?? []).filter(
      (g) => FILTERS[filter].test(g) && (!q || fold(`${g.name} ${g.business} ${g.phone ?? ''} ${g.email ?? ''}`).includes(q)),
    );
  }, [guests.data, query, filter]);

  if (detail.error) return <Notice tone="bad">{detail.error}</Notice>;
  if (!detail.data) return <Spinner />;
  const { event, stats, byDoorman } = detail.data;
  const all = guests.data ?? [];
  const emailPending = all.filter((g) => g.email && g.email_status === 'pending').length;
  const waPending = all.filter((g) => g.phone && g.wa_status === 'pending').length;

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

  const sendEmails = () =>
    run('email', async () => {
      if (!window.confirm(`¿Enviar la invitación por correo a ${emailPending} invitados?`)) return;
      const { id: jobId } = await api<{ id: number }>(`/events/${id}/email/send-pending`, { method: 'POST' });
      setStartedJobId(jobId);
      void jobPoll.reload();
    });

  const enqueue = () =>
    run('wa', async () => {
      const { queued } = await api<{ queued: number }>(`/events/${id}/wa/enqueue`, { method: 'POST' });
      toast(`${queued} invitados en la cola de WhatsApp`);
      await refresh();
    });

  return (
    <>
      <PageHeader
        back={
          <Link to="/" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-ink-mute hover:text-ink">
            <ArrowLeft className="size-4" /> Eventos
          </Link>
        }
        title={event.name}
        subtitle={`${formatDate(event.date)} · ${formatTime(event.time)} · ${event.venue}`}
        actions={
          <Link to={`/events/${id}/edit`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 font-semibold hover:bg-surface-2">
            <Pencil className="size-4" /> Editar
          </Link>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Invitados" value={stats.total} />
        <Stat label="Correos" value={stats.emailSent} hint={stats.emailFailed ? `${stats.emailFailed} fallaron` : 'enviados'} />
        <Stat label="WhatsApp" value={stats.waSent} hint={`${stats.waRead} leídos · ${stats.waQueued} en cola`} />
        <Stat
          label="Ingresaron"
          value={stats.checkedIn}
          accent
          hint={byDoorman.length ? byDoorman.map((d) => `${d.name}: ${d.count}`).join(' · ') : undefined}
        />
      </div>

      {/* Pasos en el orden en que se hacen */}
      <Card className="mb-6 divide-y divide-line">
        <Step n={1} title="Importar invitados" done={stats.total > 0} detail="Excel (.xlsx) o CSV con las columnas Nombre, Negocio, Teléfono y Correo.">
          <Button icon={<FileSpreadsheet className="size-4" />} onClick={() => setImportOpen(true)}>
            Importar lista
          </Button>
        </Step>
        <Step n={2} title="Guardar los contactos en el teléfono" detail="Importa este archivo en el celular del número secundario antes de enviar por WhatsApp.">
          <a
            href={`/api/events/${id}/contacts.vcf`}
            className={cx(
              'inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-surface px-4 font-semibold hover:bg-surface-2',
              stats.total === 0 && 'pointer-events-none opacity-50',
            )}
          >
            <Contact className="size-4" /> Descargar contactos (.vcf)
          </a>
        </Step>
        <Step
          n={3}
          title="Enviar correos"
          done={stats.total > 0 && emailPending === 0 && !emailJob?.running}
          detail={
            config.localUrl
              ? 'Desactivado en desarrollo: el QR apunta a localhost y no serviría en la puerta.'
              : config.resendConfigured
                ? 'A todos de una vez. El correo pide guardar el número de WhatsApp desde el que llegará la invitación.'
                : 'Falta configurar RESEND_API_KEY en el servidor.'
          }
        >
          {emailJob?.running ? (
            <Progress done={emailJob.done + emailJob.failed} total={emailJob.total} />
          ) : (
            <Button
              variant={emailPending ? 'primary' : 'secondary'}
              icon={<Mail className="size-4" />}
              onClick={() => void sendEmails()}
              loading={busy === 'email'}
              disabled={!emailPending || !config.resendConfigured || config.localUrl}
            >
              {emailPending ? `Enviar ${emailPending} correos` : 'Sin correos pendientes'}
            </Button>
          )}
        </Step>
        <Step
          n={4}
          title="Enviar por WhatsApp"
          done={stats.total > 0 && waPending === 0}
          detail="Encola a los invitados y la campaña los envía poco a poco: unos 20 al día, con pausas al azar."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant={waPending && emailPending === 0 ? 'primary' : 'secondary'}
              icon={<MessageCircle className="size-4" />}
              onClick={() => void enqueue()}
              loading={busy === 'wa'}
              disabled={!waPending}
            >
              {waPending ? `Encolar ${waPending}` : 'Nadie por encolar'}
            </Button>
            <Link to="/whatsapp" className="inline-flex min-h-11 items-center rounded-lg px-3 font-semibold text-ink-soft hover:bg-surface-2">
              Ver campaña →
            </Link>
          </div>
        </Step>
      </Card>

      {/* Invitados */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Invitados</h2>
          <Button icon={<UserPlus className="size-4" />} onClick={() => setAddOpen(true)}>
            Agregar invitado
          </Button>
        </div>
        <div className="relative sm:ml-auto sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-mute" />
          <input className={`${inputClass} pl-9`} placeholder="Buscar nombre, negocio, teléfono…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className={`${inputClass} sm:w-56`} value={filter} onChange={(e) => setFilter(e.target.value as FilterKey)} aria-label="Filtrar">
          {Object.entries(FILTERS).map(([k, f]) => (
            <option key={k} value={k}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {guests.loading ? <Spinner /> : null}
      {guests.data && all.length === 0 ? (
        <Card className="p-8 text-center text-ink-mute">Aún no hay invitados. Importa el Excel o agrégalos uno por uno.</Card>
      ) : null}
      {all.length > 0 && list.length === 0 ? <Card className="p-6 text-center text-ink-mute">Nadie coincide con el filtro.</Card> : null}

      {list.length > 0 ? (
        <Card className="overflow-hidden">
          {/* Escritorio: tabla */}
          <table className="hidden w-full text-left text-sm md:table">
            <thead className="bg-surface-2 text-xs font-bold tracking-wide text-ink-mute uppercase">
              <tr>
                <th className="px-4 py-3">Invitado</th>
                <th className="px-4 py-3">Contacto</th>
                <th className="px-4 py-3">Correo</th>
                <th className="px-4 py-3">WhatsApp</th>
                <th className="px-4 py-3">Ingresó</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((g) => (
                <tr key={g.id} onClick={() => setSelected(g)} className="cursor-pointer hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <div className="font-bold">{g.name}</div>
                    <div className="text-ink-mute">{g.business || '—'}</div>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">
                    <div className="tabular-nums">{formatPhone(g.phone)}</div>
                    <div className="max-w-56 truncate text-ink-mute">{g.email ?? '—'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge map={EMAIL_LABEL} status={g.email_status} error={g.email_error} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge map={WA_LABEL} status={g.wa_status} error={g.wa_error} />
                  </td>
                  <td className="px-4 py-3 tabular-nums">{g.checked_in_at ? (
                      <>
                        <b className="text-ok">{fmtTime(g.checked_in_at)}</b>
                        {g.checked_in_by ? <div className="text-xs text-ink-mute">{g.checked_in_by}</div> : null}
                      </>
                    ) : (
                      <span className="text-ink-mute">—</span>
                    )}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Celular: lista */}
          <ul className="divide-y divide-line md:hidden">
            {list.map((g) => (
              <li key={g.id}>
                <button onClick={() => setSelected(g)} className="block w-full px-4 py-3 text-left active:bg-surface-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-bold">{g.name}</div>
                      <div className="truncate text-sm text-ink-mute">{g.business || formatPhone(g.phone)}</div>
                    </div>
                    {g.checked_in_at ? (
                      <Badge tone="ok">
                        Ingresó {fmtTime(g.checked_in_at)}
                        {g.checked_in_by ? ` · ${g.checked_in_by}` : ''}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <StatusBadge map={EMAIL_LABEL} status={g.email_status} prefix="Correo" />
                    <StatusBadge map={WA_LABEL} status={g.wa_status} prefix="WA" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <ImportModal
        open={importOpen}
        eventId={Number(id)}
        onClose={() => setImportOpen(false)}
        onImported={(n) => {
          setImportOpen(false);
          toast(`${n} invitados importados`);
          void refresh();
        }}
      />
      <AddGuestModal
        open={addOpen}
        eventId={Number(id)}
        onClose={() => setAddOpen(false)}
        onAdded={(guest) => {
          setAddOpen(false);
          setSelected(guest);
          toast('Invitado agregado: su invitación está lista para compartir');
          void refresh();
        }}
      />
      <GuestModal
        guest={selected ? (all.find((g) => g.id === selected.id) ?? selected) : null}
        event={event}
        onClose={() => setSelected(null)}
        onChanged={refresh}
      />
    </>
  );
}

function Step({ n, title, detail, done, children }: { n: number; title: string; detail: string; done?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-5 sm:p-5">
      <div className="flex items-start gap-3 sm:flex-1">
        <span
          className={cx(
            'grid size-8 shrink-0 place-items-center rounded-full font-display text-sm font-extrabold',
            done ? 'bg-ok-bg text-ok' : 'bg-navy text-brand',
          )}
        >
          {done ? <Check className="size-4" /> : n}
        </span>
        <div>
          <h3 className="font-bold">{title}</h3>
          <p className="text-sm text-ink-mute">{detail}</p>
        </div>
      </div>
      <div className="pl-11 sm:pl-0">{children}</div>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="w-56">
      <div className="mb-1 text-sm font-semibold">
        Enviando… {done}/{total}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function StatusBadge<S extends string>({
  map,
  status,
  error,
  prefix,
}: {
  map: Record<S, [string, Tone]>;
  status: S;
  error?: string | null;
  prefix?: string;
}) {
  const [label, tone] = map[status];
  return (
    <Badge tone={tone} title={error ?? undefined}>
      {prefix ? `${prefix}: ` : ''}
      {label}
    </Badge>
  );
}
