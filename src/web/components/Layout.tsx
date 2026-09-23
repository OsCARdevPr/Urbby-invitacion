import type { ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { CalendarDays, LogOut, MessageCircle, ScanLine } from 'lucide-react';
import { useSession } from '../session';
import { cx } from './ui';

// "Eventos" también queda activo dentro de /events/…
const NAV = [
  { to: '/', label: 'Eventos', icon: CalendarDays, match: (p: string) => p === '/' || p.startsWith('/events') },
  { to: '/whatsapp', label: 'WhatsApp', icon: MessageCircle, match: (p: string) => p.startsWith('/whatsapp') },
  { to: '/scan', label: 'Escáner', icon: ScanLine, match: (p: string) => p.startsWith('/scan') },
];

export function Layout() {
  const { logout } = useSession();
  const { pathname } = useLocation();
  return (
    <div className="min-h-dvh pb-20 sm:pb-0">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-navy text-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-3" aria-label="Inicio">
            <img src="/urbby-wordmark.png" alt="Urbby" className="h-7 w-auto" />
            <span className="hidden text-sm font-semibold text-white/60 sm:inline">Invitaciones</span>
          </Link>
          <nav className="hidden flex-1 items-center gap-1 sm:flex">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                aria-current={n.match(pathname) ? 'page' : undefined}
                className={cx(
                  'rounded-md px-3 py-2 text-sm font-semibold transition',
                  n.match(pathname) ? 'bg-white/12 text-brand' : 'text-white/75 hover:text-white',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <button
            onClick={() => void logout()}
            className="ml-auto flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-semibold text-white/75 hover:text-white sm:ml-0"
          >
            <LogOut className="size-4" /> <span className="hidden sm:inline">Salir</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">
        <Outlet />
      </main>

      {/* Pestañas inferiores en el celular */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden">
        <div className="grid grid-cols-3">
          {NAV.map((n) => {
            const active = n.match(pathname);
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cx('flex h-16 flex-col items-center justify-center gap-1 text-xs font-bold', active ? 'text-ink' : 'text-ink-mute')}
              >
                <span className={cx('grid h-7 w-12 place-items-center rounded-full', active && 'bg-brand text-brand-ink')}>
                  <n.icon className="size-5" />
                </span>
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6">
      {back}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold sm:text-3xl">{title}</h1>
          {subtitle ? <p className="mt-1 text-ink-mute">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
