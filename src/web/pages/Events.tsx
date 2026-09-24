import { Link } from 'react-router';
import { CalendarPlus, ChevronRight, MapPin } from 'lucide-react';
import { useApi } from '../api';
import { PageHeader } from '../components/Layout';
import { Card, Notice, Spinner } from '../components/ui';
import type { EventRow, EventStats } from '../../shared/types';
import { formatDate, formatTime } from '../../shared/template';

type EventWithStats = EventRow & { stats: EventStats };

export function Events() {
  const { data, error, loading } = useApi<EventWithStats[]>('/events');

  return (
    <>
      <PageHeader
        title="Eventos"
        subtitle="Cada evento tiene su lista de invitados, sus envíos y su control de ingreso."
        actions={
          <Link
            to="/events/new"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 font-bold text-brand-ink hover:brightness-95"
          >
            <CalendarPlus className="size-4" /> Nuevo evento
          </Link>
        }
      />

      {loading ? <Spinner /> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}

      {data && data.length === 0 ? (
        <Card className="p-8 text-center">
          <h2 className="text-xl font-bold">Todavía no hay eventos</h2>
          <p className="mx-auto mt-2 max-w-md text-ink-mute">
            Crea el evento con su fecha, lugar y el mensaje de WhatsApp. Después importas la lista de invitados desde Excel.
          </p>
          <Link to="/events/new" className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand px-4 font-bold text-brand-ink">
            <CalendarPlus className="size-4" /> Crear el primer evento
          </Link>
        </Card>
      ) : null}

      <div className="grid gap-3">
        {data?.map((e) => (
          <Link key={e.id} to={`/events/${e.id}`} className="group block">
            <Card className="flex items-center gap-4 p-4 transition group-hover:border-ink-mute sm:p-5">
              <div className="grid w-14 shrink-0 place-items-center rounded-lg bg-navy py-2 text-white ring-1 ring-white/10">
                <span className="text-[11px] font-bold tracking-wider text-brand uppercase">{monthShort(e.date)}</span>
                <span className="font-display text-2xl leading-none font-extrabold">{Number(e.date.slice(8, 10))}</span>
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-bold">{e.name}</h2>
                <p className="flex items-center gap-1 truncate text-sm text-ink-mute">
                  {formatDate(e.date)} · {formatTime(e.time)}
                  <MapPin className="ml-1 size-3.5 shrink-0" /> <span className="truncate">{e.venue}</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
                  <span>
                    <b className="tabular-nums">{e.stats.total}</b> invitados
                  </span>
                  <span>
                    <b className="tabular-nums">{e.stats.emailSent}</b> correos
                  </span>
                  <span>
                    <b className="tabular-nums">{e.stats.waSent}</b> WhatsApp
                  </span>
                  <span>
                    <b className="tabular-nums">{e.stats.checkedIn}</b> ingresaron
                  </span>
                </div>
              </div>
              <ChevronRight className="size-5 shrink-0 text-ink-mute" />
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

const monthShort = (date: string) =>
  new Intl.DateTimeFormat('es-SV', { month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`)).replace('.', '');
