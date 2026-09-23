import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import QrScanner from 'qr-scanner';
import { AlertTriangle, CheckCircle2, LayoutDashboard, LogOut, Search, XCircle } from 'lucide-react';
import { api, useApi } from '../api';
import { Button, inputClass, Modal } from '../components/ui';
import { fmtTime } from '../lib';
import { useSession } from '../session';
import type { CheckinGuest, CheckinResult } from '../../shared/types';

interface EventLite {
  id: number;
  name: string;
  date: string;
  stats: { total: number; checkedIn: number };
}

type Shown = CheckinResult | { result: 'not_invitation' } | { result: 'error'; message: string };

const STORAGE_KEY = 'urbby:scan-event';
const TOKEN_IN_URL = /\/i\/([A-Za-z0-9_-]{21})(?:[/?#]|$)/;
const BARE_TOKEN = /^[A-Za-z0-9_-]{21}$/;

/** El QR trae la URL https://…/i/<token>; se acepta también el token solo. */
export function extractToken(text: string): string | null {
  const t = text.trim();
  return t.match(TOKEN_IN_URL)?.[1] ?? (BARE_TOKEN.test(t) ? t : null);
}

const store = {
  get: () => {
    try {
      return Number(localStorage.getItem(STORAGE_KEY)) || null;
    } catch {
      return null;
    }
  },
  set: (id: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      /* sin almacenamiento: se elige de nuevo al recargar */
    }
  },
};

export function Scan() {
  const { config, logout } = useSession();
  const events = useApi<EventLite[]>('/events');
  const [eventId, setEventId] = useState<number | null>(store.get);
  const stats = useApi<{ total: number; checkedIn: number }>(eventId ? `/checkin/stats?eventId=${eventId}` : null, 15000);
  const [shown, setShown] = useState<Shown | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const eventIdRef = useRef(eventId);
  const busy = useRef(false);
  const ignore = useRef<{ key: string; until: number } | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Evento por defecto: el guardado, o el próximo a partir de hoy, o el más reciente.
  useEffect(() => {
    const list = events.data;
    if (!list?.length) return;
    if (eventId && list.some((e) => e.id === eventId)) return;
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = [...list].filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
    choose((upcoming ?? list[0]).id);
  }, [events.data, eventId]);

  const choose = (id: number) => {
    setEventId(id);
    eventIdRef.current = id;
    store.set(id);
  };

  const dismiss = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    setShown(null);
    // El mismo QR suele seguir frente a la cámara: se ignora unos segundos para no mostrar "ya ingresó" de inmediato.
    if (ignore.current) ignore.current.until = Date.now() + 5000;
    busy.current = false;
  }, []);

  const show = useCallback(
    (r: Shown) => {
      setShown(r);
      feedback(r.result);
      void stats.reload();
      dismissTimer.current = setTimeout(dismiss, r.result === 'ok' ? 3500 : 6000);
    },
    [dismiss, stats],
  );

  const onDecode = useCallback(
    async (text: string) => {
      const id = eventIdRef.current;
      if (busy.current || !id) return;
      const token = extractToken(text);
      const key = token ?? text;
      if (ignore.current && ignore.current.key === key && Date.now() < ignore.current.until) return;
      ignore.current = { key, until: Number.POSITIVE_INFINITY };
      busy.current = true;

      if (!token) return show({ result: 'not_invitation' });
      try {
        show(await api<CheckinResult>('/checkin', { body: { token, eventId: id } }));
      } catch (err) {
        show({ result: 'error', message: (err as Error).message });
      }
    },
    [show],
  );

  // Cámara
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!window.isSecureContext) {
      setCameraError('La cámara solo funciona con HTTPS. Abre el panel desde https://…');
      return;
    }
    const scanner = new QrScanner(video, (r) => void onDecodeRef.current(r.data), {
      returnDetailedScanResult: true,
      preferredCamera: 'environment',
      highlightScanRegion: true,
      highlightCodeOutline: true,
      maxScansPerSecond: 8,
    });
    scanner.start().catch((err: unknown) => {
      const name = err instanceof Error ? err.name : String(err);
      setCameraError(
        /NotAllowed|Permission/i.test(name)
          ? 'No hay permiso para usar la cámara. Actívalo en los ajustes del navegador para este sitio y recarga.'
          : /NotFound|no camera/i.test(name)
            ? 'No se encontró una cámara en este dispositivo.'
            : `No se pudo abrir la cámara (${name}).`,
      );
    });
    return () => {
      scanner.stop();
      scanner.destroy();
    };
  }, []);

  const current = events.data?.find((e) => e.id === eventId);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white" onPointerDown={unlockAudio}>
      {/* Barra superior */}
      <header className="relative z-20 flex items-center gap-2 bg-[#021d59]/95 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
        <select
          value={eventId ?? ''}
          onChange={(e) => choose(Number(e.target.value))}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-3 font-bold text-white"
          aria-label="Evento"
        >
          {!events.data?.length ? <option value="">Sin eventos</option> : null}
          {events.data?.map((e) => (
            <option key={e.id} value={e.id} className="text-black">
              {e.name} · {e.date}
            </option>
          ))}
        </select>
        <div className="shrink-0 rounded-lg bg-[#fab822] px-3 py-2 text-center leading-none font-extrabold text-[#021d59] tabular-nums" title="Ingresaron / invitados">
          {stats.data ? `${stats.data.checkedIn}/${stats.data.total}` : '—'}
        </div>
        <button
          onClick={() => setSearchOpen(true)}
          className="grid size-11 shrink-0 place-items-center rounded-lg bg-white/10"
          aria-label="Buscar por nombre"
        >
          <Search className="size-5" />
        </button>
        {config.role === 'admin' ? (
          <Link to="/" className="grid size-11 shrink-0 place-items-center rounded-lg bg-white/10" aria-label="Ir al panel">
            <LayoutDashboard className="size-5" />
          </Link>
        ) : (
          <button onClick={() => void logout()} className="grid size-11 shrink-0 place-items-center rounded-lg bg-white/10" aria-label="Salir">
            <LogOut className="size-5" />
          </button>
        )}
      </header>

      {/* Cámara */}
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 size-full object-cover" muted playsInline />
        {cameraError ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-sm">
              <AlertTriangle className="mx-auto mb-3 size-10 text-[#fab822]" />
              <p className="text-lg font-bold">{cameraError}</p>
              <p className="mt-2 text-white/70">Mientras tanto puedes buscar a los invitados por nombre.</p>
              <Button variant="primary" className="mt-4" icon={<Search className="size-4" />} onClick={() => setSearchOpen(true)}>
                Buscar por nombre
              </Button>
            </div>
          </div>
        ) : (
          <p className="pointer-events-none absolute inset-x-0 bottom-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-sm font-semibold text-white/80">
            {current ? `Apunta al código QR de la invitación · ${current.name}` : 'Elige el evento arriba'}
          </p>
        )}
        {shown ? <ResultOverlay shown={shown} onDismiss={dismiss} /> : null}
      </div>

      <ManualSearch
        open={searchOpen}
        eventId={eventId}
        onClose={() => setSearchOpen(false)}
        onResult={(r) => {
          setSearchOpen(false);
          busy.current = true;
          show(r);
        }}
      />
    </div>
  );
}

// ── Resultado ─────────────────────────────────────────────────────

function ResultOverlay({ shown, onDismiss }: { shown: Shown; onDismiss: () => void }) {
  const r = shown;
  let bg = 'bg-[#b42318]';
  let icon = <XCircle className="size-16" />;
  let title = 'QR no válido';
  let guest: CheckinGuest | null = null;
  let detail = 'Este código no corresponde a ninguna invitación.';

  if (r.result === 'ok') {
    bg = 'bg-[#0f7a4a]';
    icon = <CheckCircle2 className="size-16" />;
    title = 'Bienvenido/a';
    guest = r.guest;
    detail = r.guest.confirmed ? 'Confirmó su asistencia' : '';
  } else if (r.result === 'already') {
    bg = 'bg-[#fab822] text-[#021d59]';
    icon = <AlertTriangle className="size-16" />;
    title = 'Ya ingresó';
    guest = r.guest;
    detail = `Entró a las ${fmtTime(r.guest.checkedInAt)} · verifica que sea la misma persona`;
  } else if (r.result === 'wrong_event') {
    title = 'Es de otro evento';
    guest = r.guest;
    detail = `Esta invitación es para: ${r.eventName}`;
  } else if (r.result === 'not_invitation') {
    detail = 'Ese código no es una invitación de Urbby.';
  } else if (r.result === 'error') {
    title = 'No se pudo registrar';
    detail = `${r.message}. Revisa la conexión e intenta de nuevo.`;
  }

  return (
    <button
      onClick={onDismiss}
      className={`animate-rise absolute inset-x-0 bottom-0 z-10 flex min-h-[55%] flex-col items-center justify-center gap-2 rounded-t-3xl px-6 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] text-center ${bg}`}
      aria-live="assertive"
    >
      {icon}
      <div className="text-lg font-bold tracking-wide uppercase opacity-90">{title}</div>
      {guest ? (
        <>
          <div className="font-display text-4xl leading-tight font-extrabold">{guest.name}</div>
          {guest.business ? <div className="text-xl font-bold opacity-90">{guest.business}</div> : null}
        </>
      ) : null}
      {detail ? <div className="mt-1 max-w-sm text-base opacity-90">{detail}</div> : null}
      <div className="mt-4 text-sm font-semibold opacity-70">Toca para seguir escaneando</div>
    </button>
  );
}

// ── Búsqueda manual ───────────────────────────────────────────────

function ManualSearch({
  open,
  eventId,
  onClose,
  onResult,
}: {
  open: boolean;
  eventId: number | null;
  onClose: () => void;
  onResult: (r: CheckinResult) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<CheckinGuest[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    if (!open || !eventId || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api<CheckinGuest[]>(`/checkin/search?eventId=${eventId}&q=${encodeURIComponent(q.trim())}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, eventId, open]);

  async function checkIn(g: CheckinGuest) {
    setBusyId(g.id);
    try {
      onResult(await api<CheckinResult>(`/checkin/guest/${g.id}`, { body: { eventId } }));
      setQ('');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Buscar invitado">
      <input
        autoFocus
        className={inputClass}
        placeholder="Nombre o negocio"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="mt-3 divide-y divide-line">
        {results.map((g) => (
          <li key={g.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-bold">{g.name}</div>
              <div className="truncate text-sm text-ink-mute">
                {g.business || '—'}
                {g.checkedInAt ? ` · ingresó ${fmtTime(g.checkedInAt)}` : ''}
              </div>
            </div>
            <Button variant={g.checkedInAt ? 'secondary' : 'primary'} loading={busyId === g.id} onClick={() => void checkIn(g)}>
              {g.checkedInAt ? 'Ver' : 'Marcar ingreso'}
            </Button>
          </li>
        ))}
      </ul>
      {q.trim().length >= 2 && results.length === 0 ? <p className="py-6 text-center text-ink-mute">Nadie coincide.</p> : null}
    </Modal>
  );
}

// ── Vibración y sonido ────────────────────────────────────────────

let audio: AudioContext | null = null;
function unlockAudio() {
  // Los navegadores solo permiten sonido después de un toque del usuario.
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    /* sin audio */
  }
}

function beep(freq: number, ms: number, delay = 0) {
  if (!audio || audio.state !== 'running') return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.15;
  osc.connect(gain).connect(audio.destination);
  const t = audio.currentTime + delay / 1000;
  osc.start(t);
  osc.stop(t + ms / 1000);
}

function feedback(result: Shown['result']) {
  if (result === 'ok') {
    navigator.vibrate?.(80);
    beep(880, 120);
  } else if (result === 'already') {
    navigator.vibrate?.([60, 60, 60]);
    beep(520, 120);
    beep(520, 120, 180);
  } else {
    navigator.vibrate?.(300);
    beep(220, 350);
  }
}
