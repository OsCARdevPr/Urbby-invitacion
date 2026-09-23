import { useRef, useState } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, cx, Modal, Notice } from './ui';
import { formatPhone, type Tone } from '../lib';
import type { ImportRow, ImportRowStatus } from '../../shared/types';

const STATUS: Record<ImportRowStatus, [string, Tone]> = {
  ok: ['Lista', 'ok'],
  warning: ['Con aviso', 'warn'],
  duplicate: ['Repetida', 'neutral'],
  error: ['No se importa', 'bad'],
};

export function ImportModal({
  open,
  eventId,
  onClose,
  onImported,
}: {
  open: boolean;
  eventId: number;
  onClose: () => void;
  onImported: (inserted: number) => void;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setRows(null);
    setFileName('');
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  async function upload(file: File) {
    reset();
    setFileName(file.name);
    setLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const { rows } = await api<{ rows: ImportRow[] }>(`/events/${eventId}/import/preview`, { form });
      setRows(rows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function commit() {
    if (!rows) return;
    setLoading(true);
    try {
      const importable = rows.filter((r) => r.status === 'ok' || r.status === 'warning');
      const { inserted } = await api<{ inserted: number }>(`/events/${eventId}/import/commit`, {
        body: { rows: importable.map(({ row, name, business, phone, email }) => ({ row, name, business, phone, email })) },
      });
      reset();
      onImported(inserted);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const count = (s: ImportRowStatus) => rows?.filter((r) => r.status === s).length ?? 0;
  const importable = count('ok') + count('warning');

  return (
    <Modal open={open} onClose={close} title="Importar invitados" wide>
      {!rows ? (
        <>
          <p className="mb-4 text-ink-soft">
            Sube un Excel (.xlsx) con las columnas <b>Nombre</b>, <b>Negocio</b>, <b>Teléfono</b> y <b>Correo</b>. Los teléfonos pueden
            venir con o sin +503. Antes de guardar vas a ver una vista previa.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void upload(file);
            }}
            className={cx(
              'flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-center transition',
              dragging ? 'border-brand bg-brand/10' : 'border-line hover:border-ink-mute',
            )}
          >
            {loading ? (
              <span className="font-semibold">Leyendo {fileName}…</span>
            ) : (
              <>
                <Upload className="size-7 text-ink-mute" />
                <span className="font-bold">Elegir archivo o arrastrarlo aquí</span>
                <span className="text-sm text-ink-mute">Solo .xlsx, hasta 5 MB</span>
              </>
            )}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
          {error ? (
            <div className="mt-4">
              <Notice tone="bad">{error}</Notice>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <FileSpreadsheet className="size-4 text-ink-mute" />
            <b className="mr-2">{fileName}</b>
            <Badge tone="ok">{count('ok')} listas</Badge>
            {count('warning') ? <Badge tone="warn">{count('warning')} con aviso</Badge> : null}
            {count('duplicate') ? <Badge tone="neutral">{count('duplicate')} repetidas</Badge> : null}
            {count('error') ? <Badge tone="bad">{count('error')} no se importan</Badge> : null}
          </div>

          <div className="max-h-[50vh] overflow-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface-2 text-xs font-bold tracking-wide text-ink-mute uppercase">
                <tr>
                  <th className="px-3 py-2">Fila</th>
                  <th className="px-3 py-2">Invitado</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Contacto</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.row} className={cx(r.status === 'error' && 'bg-bad-bg/40', r.status === 'duplicate' && 'opacity-60')}>
                    <td className="px-3 py-2 align-top text-ink-mute tabular-nums">{r.row}</td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-semibold">{r.name || <i className="text-ink-mute">sin nombre</i>}</div>
                      <div className="text-ink-mute">{r.business}</div>
                      <div className="text-ink-mute sm:hidden">{r.phone ? formatPhone(r.phone) : r.rawPhone}</div>
                    </td>
                    <td className="hidden px-3 py-2 align-top text-ink-soft sm:table-cell">
                      <div className="tabular-nums">{r.phone ? formatPhone(r.phone) : r.rawPhone || '—'}</div>
                      <div className="text-ink-mute">{r.email ?? (r.rawEmail || '—')}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>
                      {r.messages.map((m) => (
                        <div key={m} className="mt-1 text-xs text-ink-mute">
                          {m}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {error ? (
            <div className="mt-4">
              <Notice tone="bad">{error}</Notice>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={reset}>
              Elegir otro archivo
            </Button>
            <Button variant="primary" onClick={() => void commit()} loading={loading} disabled={!importable}>
              Importar {importable} invitados
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
