import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2, X } from 'lucide-react';
import type { Tone } from '../lib';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ── Botón ─────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  // Amarillo solo para la acción principal de cada pantalla.
  primary: 'bg-brand text-brand-ink hover:brightness-95 font-bold',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2 font-semibold',
  ghost: 'text-ink-soft hover:bg-surface-2 font-semibold',
  danger: 'bg-surface text-bad border border-line hover:bg-bad-bg font-semibold',
};

export function Button({
  variant = 'secondary',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[15px] transition disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ── Etiquetas de estado ───────────────────────────────────────────

const TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok',
  info: 'bg-info-bg text-info',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  neutral: 'bg-surface-2 text-ink-mute',
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold whitespace-nowrap', TONES[tone])}>
      {children}
    </span>
  );
}

// ── Superficies ───────────────────────────────────────────────────

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-xl border border-line bg-surface', className)}>{children}</section>;
}

export function Stat({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: ReactNode; accent?: boolean }) {
  return (
    <div className={cx('rounded-xl border border-line bg-surface p-4', accent && 'border-l-4 border-l-brand')}>
      <div className="text-xs font-bold tracking-wide text-ink-mute uppercase">{label}</div>
      <div className="mt-1 font-display text-3xl font-extrabold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-sm text-ink-mute">{hint}</div> : null}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cx('rounded-lg px-4 py-3 text-sm leading-relaxed', TONES[tone])}>{children}</div>;
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-ink-mute">
      <Loader2 className="size-5 animate-spin" /> {label}
    </div>
  );
}

// ── Formularios ───────────────────────────────────────────────────

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-bold text-ink-soft">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-sm text-ink-mute">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full min-h-11 rounded-lg border border-line bg-surface px-3 py-2 text-ink placeholder:text-ink-mute focus:border-ink-soft focus:outline-none focus:ring-2 focus:ring-brand/50';

// ── Modal (hoja inferior en el celular, diálogo centrado en escritorio) ──

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cx(
          'animate-rise flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-surface shadow-2xl sm:rounded-2xl',
          wide ? 'sm:max-w-4xl' : 'sm:max-w-lg',
        )}
      >
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button onClick={onClose} className="-mr-2 grid size-11 place-items-center rounded-lg text-ink-mute hover:bg-surface-2" aria-label="Cerrar">
            <X className="size-5" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}

// ── Avisos flotantes ──────────────────────────────────────────────

type ToastItem = { id: number; text: string; tone: Tone };
const TOAST_EDGE: Record<Tone, string> = {
  ok: 'border-l-ok',
  info: 'border-l-info',
  warn: 'border-l-warn',
  bad: 'border-l-bad',
  neutral: 'border-l-line',
};
const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, tone: Tone = 'ok') => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, text, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'animate-rise pointer-events-auto max-w-md rounded-lg border border-l-4 border-line bg-surface px-4 py-3 text-sm font-semibold text-ink shadow-lg',
              TOAST_EDGE[t.tone],
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
