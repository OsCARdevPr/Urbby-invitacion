import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Image as ImageIcon,
  Pause,
  Play,
  RotateCcw,
  Send,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { api, useApi } from '../api';
import { PageHeader } from '../components/Layout';
import { waFormat } from '../components/CardPreview';
import { Badge, Button, Card, cx, Field, inputClass, Notice, Spinner, useToast } from '../components/ui';
import { fmtDateTime, formatPhone } from '../lib';
import { useSession } from '../session';
import type {
  CampaignRecipient,
  CampaignSummary,
  MarketingImportPreview,
  MarketingImportRow,
  WaStatusResponse,
} from '../../shared/types';
import { BROADCAST_LABEL } from '../../shared/labels';
import { renderTemplate, validateCampaignVariables } from '../../shared/template';

export function Marketing() {
  const { config } = useSession();
  const list = useApi<CampaignSummary[]>('/campaigns', 5000);
  const wa = useApi<WaStatusResponse>('/wa/status', 5000);

  return (
    <>
      <PageHeader
        title="Marketing"
        subtitle="Envía campañas personalizadas con imagen opcional a una lista independiente. Utiliza la conexión y límites existentes de WhatsApp."
      />

      {config.localUrl ? (
        <div className="mb-6">
          <Notice tone="warn">
            Estás en desarrollo (PUBLIC_BASE_URL apunta a localhost): puedes crear campañas, pero no enviarlas.
          </Notice>
        </div>
      ) : null}
      {!config.evolutionConfigured ? (
        <div className="mb-6">
          <Notice tone="bad">
            Evolution API no está configurada. Define EVOLUTION_URL, EVOLUTION_API_KEY y EVOLUTION_INSTANCE en el
            servidor.
          </Notice>
        </div>
      ) : null}

      <NewCampaign onCreated={() => void list.reload()} />

      <h2 className="mt-8 mb-3 text-xl font-bold">Campañas enviadas y en curso</h2>
      {list.error ? <Notice tone="bad">{list.error}</Notice> : null}
      {!list.data && !list.error ? <Spinner /> : null}
      {list.data?.length === 0 ? (
        <Card className="p-8 text-center text-ink-mute">Aún no hay campañas de marketing.</Card>
      ) : null}
      <div className="grid gap-4">
        {list.data?.map((c) => (
          <CampaignCard
            key={c.id}
            campaign={c}
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

// ── Nueva Campaña ──────────────────────────────────────────────────────────

function NewCampaign({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // Archivo de lista
  const [listFile, setListFile] = useState<File | null>(null);
  const [phoneColumn, setPhoneColumn] = useState<string>('');
  const [importPreview, setImportPreview] = useState<MarketingImportPreview | null>(null);
  const [readingList, setReadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Vista previa de contacto
  const [previewContactIdx, setPreviewContactIdx] = useState(0);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Cargar/analizar archivo de lista
  async function loadList(file: File, selectedPhone?: string) {
    setReadingList(true);
    setListError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (selectedPhone) formData.append('phoneColumn', selectedPhone);
      const res = await api<MarketingImportPreview>('/campaigns/import/preview', { form: formData });
      setImportPreview(res);
      setPhoneColumn(res.phoneColumn || '');
      setPreviewContactIdx(0);
    } catch (err) {
      setListError((err as Error).message);
      setImportPreview(null);
    } finally {
      setReadingList(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setListFile(file);
    void loadList(file);
  }

  function handlePhoneColumnChange(col: string) {
    setPhoneColumn(col);
    if (listFile) {
      void loadList(listFile, col);
    }
  }

  // Manejo de imagen
  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await api<{ imageId: string; filename: string }>('/campaigns/upload-image', { form: formData });
      setImageId(res.imageId);
    } catch (err) {
      toast((err as Error).message);
      removeImage();
    } finally {
      setUploadingImage(false);
    }
  }

  function removeImage() {
    setImageFile(null);
    setImageId(null);
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(null);
    }
  }

  // Insertar variable en el mensaje
  function insertPlaceholder(varName: string) {
    const el = textRef.current;
    const token = `{${varName}}`;
    const start = el?.selectionStart ?? message.length;
    const end = el?.selectionEnd ?? start;
    setMessage(message.slice(0, start) + token + message.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  // Filas válidas listas para importar
  const validRows = importPreview?.rows.filter((r) => r.status === 'ok' || r.status === 'warning') ?? [];
  const availableCols = importPreview?.columns.map((c) => c.key) ?? [];

  // Validación de variables usadas
  const validation = validateCampaignVariables(
    message,
    availableCols,
    validRows.map((r) => ({ row: r.row, variables: r.variables })),
  );

  // Destinatario actual para la vista previa
  const currentPreviewContact: MarketingImportRow | undefined = validRows[previewContactIdx] ?? validRows[0];
  const renderedPreview =
    currentPreviewContact && message.trim()
      ? renderTemplate(message.trim(), currentPreviewContact.variables)
      : message.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!message.trim()) return;
    if (validRows.length === 0) {
      setError('Importa una lista con contactos válidos');
      return;
    }
    if (!validation.valid) {
      if (validation.unknownVariables.length > 0) {
        setError(`Variables desconocidas: ${validation.unknownVariables.map((v) => `{${v}}`).join(', ')}`);
        return;
      }
      if (validation.missingByRow.length > 0) {
        const first = validation.missingByRow[0];
        setError(`Fila ${first.row} no tiene valor para: ${first.missing.map((v) => `{${v}}`).join(', ')}`);
        return;
      }
    }

    if (
      !window.confirm(
        `Se creará la campaña "${name.trim()}" para ${validRows.length} contactos. Queda en cola hasta que la envíes. ¿Continuar?`,
      )
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api('/campaigns', {
        body: {
          name: name.trim(),
          message: message.trim(),
          imageId: imageId || null,
          rows: validRows.map((r) => ({
            row: r.row,
            phone: r.phone!,
            name: r.name,
            variables: r.variables,
          })),
        },
      });
      toast('Campaña creada: puedes iniciar el envío desde la lista');
      setName('');
      setMessage('');
      removeImage();
      setListFile(null);
      setImportPreview(null);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-4 text-lg font-bold">Nueva campaña de marketing</h2>
      <form onSubmit={(e) => void submit(e)} className="grid gap-6">
        {/* Paso 1: Lista de contactos */}
        <div className="rounded-lg border border-line bg-surface-2/40 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-bold text-ink">1. Lista de contactos</span>
            {importPreview ? (
              <span className="text-xs font-semibold text-ok">
                ✓ {validRows.length} contacto(s) listo(s)
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-2 transition">
              <Upload className="size-4" />
              <span>{listFile ? listFile.name : 'Subir Excel (.xlsx) o CSV'}</span>
              <input type="file" accept=".xlsx,.csv,text/csv" onChange={handleFileChange} className="hidden" />
            </label>
            {readingList ? <span className="text-xs text-ink-mute">Leyendo archivo…</span> : null}
          </div>

          {listError ? <div className="mt-3"><Notice tone="bad">{listError}</Notice></div> : null}

          {importPreview?.needsPhoneColumn ? (
            <div className="mt-3 rounded-lg border border-warn/40 bg-warn-bg p-3">
              <p className="mb-2 text-xs font-bold text-warn">
                No pudimos detectar la columna de teléfono automáticamente. Elige cuál es:
              </p>
              <select
                value={phoneColumn}
                onChange={(e) => handlePhoneColumnChange(e.target.value)}
                className={inputClass}
              >
                <option value="">-- Elige la columna del teléfono --</option>
                {importPreview.columns.map((col) => (
                  <option key={col.key} value={col.key}>
                    {col.label} ({col.key})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {importPreview && !importPreview.needsPhoneColumn ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-surface px-2 py-1 text-ink-soft">
                  Total filas: <b>{importPreview.stats.total}</b>
                </span>
                <span className="rounded bg-ok-bg px-2 py-1 text-ok">
                  Válidas: <b>{importPreview.stats.valid}</b>
                </span>
                {importPreview.stats.invalidPhone > 0 ? (
                  <span className="rounded bg-bad-bg px-2 py-1 text-bad">
                    Teléfonos inválidos: <b>{importPreview.stats.invalidPhone}</b>
                  </span>
                ) : null}
                {importPreview.stats.duplicates > 0 ? (
                  <span className="rounded bg-warn-bg px-2 py-1 text-warn">
                    Duplicados: <b>{importPreview.stats.duplicates}</b>
                  </span>
                ) : null}
              </div>

              {/* Variables disponibles */}
              <div className="pt-2">
                <span className="text-xs font-bold text-ink-mute uppercase">Variables detectadas en la lista:</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {importPreview.columns.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => insertPlaceholder(c.key)}
                      className="inline-flex items-center gap-1 rounded bg-brand/15 px-2 py-0.5 text-xs font-bold text-brand-ink hover:bg-brand/25 transition"
                      title={`Insertar {${c.key}} en el mensaje`}
                    >
                      +{`{${c.key}}`}
                    </button>
                  ))}
                  {importPreview.columns.some((c) => c.key === 'nombre' || c.key === 'name') ? (
                    <button
                      type="button"
                      onClick={() => insertPlaceholder('primer_nombre')}
                      className="inline-flex items-center gap-1 rounded bg-brand/15 px-2 py-0.5 text-xs font-bold text-brand-ink hover:bg-brand/25 transition"
                      title="Insertar {primer_nombre} en el mensaje"
                    >
                      +{`{primer_nombre}`}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Paso 2: Datos de la campaña */}
        <div className="grid gap-4">
          <Field label="Nombre de la campaña" hint="Para tu referencia interna (ej. Promoción Fin de Año)">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. Descuentos de Noviembre"
              maxLength={80}
              className={inputClass}
              required
            />
          </Field>

          {/* Carga de imagen opcional */}
          <div>
            <span className="mb-1.5 block text-sm font-bold text-ink-soft">
              Imagen (opcional, JPEG o PNG hasta 5 MB)
            </span>
            {imagePreviewUrl ? (
              <div className="flex items-center gap-4 rounded-lg border border-line bg-surface p-3">
                <img
                  src={imagePreviewUrl}
                  alt="Vista previa adjunto"
                  className="size-16 rounded object-cover border border-line"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink">{imageFile?.name}</div>
                  <div className="text-xs text-ink-mute">
                    {uploadingImage ? 'Subiendo imagen…' : 'Imagen lista para enviar'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={removeImage}
                  className="rounded p-1 text-ink-mute hover:bg-surface-2 hover:text-bad"
                  title="Quitar imagen"
                >
                  <X className="size-5" />
                </button>
              </div>
            ) : (
              <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-2 transition">
                <ImageIcon className="size-4" />
                <span>Adjuntar imagen</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  onChange={(e) => void handleImageChange(e)}
                  className="hidden"
                />
              </label>
            )}
          </div>

          {/* Mensaje */}
          <Field
            label="Mensaje"
            hint="Si adjuntas imagen irá como pie de foto. Puedes hacer clic en las variables de arriba para insertarlas."
          >
            <textarea
              ref={textRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={5}
              maxLength={1500}
              placeholder="¡Hola {nombre}! Te invitamos a conocer nuestras novedades..."
              className={cx(inputClass, 'h-auto font-sans leading-relaxed')}
              required
            />
            <div className="mt-1 flex items-center justify-between text-xs text-ink-mute">
              <span>{message.length} / 1500 caracteres</span>
              {message.trim() && !validation.valid && validation.unknownVariables.length > 0 ? (
                <span className="font-semibold text-bad">
                  Variables no reconocidas: {validation.unknownVariables.map((v) => `{${v}}`).join(', ')}
                </span>
              ) : null}
            </div>
          </Field>
        </div>

        {/* Paso 3: Vista previa de WhatsApp */}
        {message.trim() || imagePreviewUrl ? (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold text-ink-soft uppercase">Vista previa de WhatsApp</span>
              {validRows.length > 1 ? (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-ink-mute">
                    Contacto {previewContactIdx + 1} de {validRows.length}:{' '}
                    <b>{currentPreviewContact?.name || currentPreviewContact?.phone}</b>
                  </span>
                  <button
                    type="button"
                    disabled={previewContactIdx <= 0}
                    onClick={() => setPreviewContactIdx((p) => p - 1)}
                    className="rounded p-1 text-ink-soft hover:bg-surface-2 disabled:opacity-30"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  <button
                    type="button"
                    disabled={previewContactIdx >= validRows.length - 1}
                    onClick={() => setPreviewContactIdx((p) => p + 1)}
                    className="rounded p-1 text-ink-soft hover:bg-surface-2 disabled:opacity-30"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>
              ) : null}
            </div>

            <div className="rounded-xl bg-[#efe7dd] p-3">
              <div className="ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#d9fdd3] p-2 text-[15px] leading-snug whitespace-pre-wrap text-[#111b21] shadow-sm">
                {imagePreviewUrl ? (
                  <div className="mb-2 overflow-hidden rounded-md">
                    <img
                      src={imagePreviewUrl}
                      alt="Adjunto de la campaña"
                      className="max-h-72 w-full object-cover"
                    />
                  </div>
                ) : null}
                <div className="px-1">{waFormat(renderedPreview)}</div>
              </div>
            </div>
          </div>
        ) : null}

        {error ? <Notice tone="bad">{error}</Notice> : null}

        <div className="flex justify-end pt-2">
          <Button
            type="submit"
            variant="primary"
            loading={saving || uploadingImage}
            disabled={
              !name.trim() ||
              !message.trim() ||
              validRows.length === 0 ||
              !validation.valid ||
              uploadingImage
            }
          >
            Crear campaña ({validRows.length} destinatarios)
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Tarjeta de Campaña ─────────────────────────────────────────────────────

function CampaignCard({
  campaign,
  wa,
  onChanged,
}: {
  campaign: CampaignSummary;
  wa?: WaStatusResponse | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [openRecipients, setOpenRecipients] = useState(false);
  const [busy, setBusy] = useState(false);

  const isCurrent = wa?.state.running && wa?.state.campaignId === campaign.id;
  const hasFinished = campaign.queued === 0;

  async function handleStart() {
    setBusy(true);
    try {
      await api(`/campaigns/${campaign.id}/start`, { method: 'POST' });
      toast('Envío de campaña iniciado');
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePause() {
    setBusy(true);
    try {
      await api('/wa/pause', { method: 'POST', body: { reason: 'Pausada por el usuario' } });
      toast('Campaña pausada');
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry() {
    setBusy(true);
    try {
      const res = await api<{ requeued: number }>(`/campaigns/${campaign.id}/retry`, { method: 'POST' });
      toast(`${res.requeued} mensaje(s) fallidos re-encolados`);
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!window.confirm('¿Cancelar los mensajes que siguen en cola? Lo ya enviado no se tocará.')) return;
    setBusy(true);
    try {
      const res = await api<{ cancelled: number }>(`/campaigns/${campaign.id}/cancel`, { method: 'POST' });
      toast(`${res.cancelled} mensaje(s) cancelados`);
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`¿Eliminar la campaña "${campaign.name}"?`)) return;
    setBusy(true);
    try {
      await api(`/campaigns/${campaign.id}`, { method: 'DELETE' });
      toast('Campaña eliminada');
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-bold text-ink">{campaign.name}</h3>
            {isCurrent ? <Badge tone="info">Enviando ahora</Badge> : null}
            {hasFinished && campaign.total > 0 ? <Badge tone="ok">Completada</Badge> : null}
          </div>
          <div className="mt-1 text-xs text-ink-mute">
            Creada el {fmtDateTime(campaign.created_at)} · {campaign.total} destinatarios
            {campaign.image_id ? ' · con imagen' : ''}
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-ink-soft whitespace-pre-wrap">{campaign.message}</p>
        </div>

        {/* Acciones */}
        <div className="flex flex-wrap items-center gap-2">
          {isCurrent ? (
            <Button variant="secondary" onClick={() => void handlePause()} loading={busy} icon={<Pause className="size-4" />}>
              Pausar
            </Button>
          ) : campaign.queued > 0 ? (
            <Button variant="primary" onClick={() => void handleStart()} loading={busy} icon={<Play className="size-4" />}>
              Empezar envío
            </Button>
          ) : null}

          {campaign.problems > 0 ? (
            <Button
              variant="secondary"
              onClick={() => void handleRetry()}
              loading={busy}
              icon={<RotateCcw className="size-4" />}
              title="Reintentar solo los fallidos"
            >
              Reintentar ({campaign.problems})
            </Button>
          ) : null}

          {campaign.queued > 0 ? (
            <Button
              variant="secondary"
              onClick={() => void handleCancel()}
              loading={busy}
              icon={<XCircle className="size-4" />}
              title="Cancelar pendientes"
            >
              Cancelar pendientes
            </Button>
          ) : null}

          {campaign.sent === 0 && campaign.queued === campaign.total ? (
            <Button
              variant="ghost"
              onClick={() => void handleDelete()}
              loading={busy}
              icon={<Trash2 className="size-4 text-bad" />}
              title="Eliminar campaña"
            >
              Eliminar
            </Button>
          ) : null}
        </div>
      </div>

      {/* Barra de progreso / métricas */}
      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-3 sm:grid-cols-6 text-xs">
        <div>
          <span className="text-ink-mute block">En cola</span>
          <span className="font-bold tabular-nums text-ink">{campaign.queued}</span>
        </div>
        <div>
          <span className="text-ink-mute block">Enviados</span>
          <span className="font-bold tabular-nums text-ok">{campaign.sent}</span>
        </div>
        <div>
          <span className="text-ink-mute block">Entregados</span>
          <span className="font-bold tabular-nums text-ok">{campaign.delivered}</span>
        </div>
        <div>
          <span className="text-ink-mute block">Leídos</span>
          <span className="font-bold tabular-nums text-ok">{campaign.read}</span>
        </div>
        <div>
          <span className="text-ink-mute block">Problemas</span>
          <span className={cx('font-bold tabular-nums', campaign.problems ? 'text-bad' : 'text-ink-mute')}>
            {campaign.problems}
          </span>
        </div>
        <div>
          <span className="text-ink-mute block">Cancelados</span>
          <span className="font-bold tabular-nums text-ink-mute">{campaign.cancelled}</span>
        </div>
      </div>

      {/* Desplegable de destinatarios */}
      <div className="mt-3 border-t border-line/60 pt-2">
        <button
          type="button"
          onClick={() => setOpenRecipients((o) => !o)}
          className="flex items-center gap-1.5 text-xs font-semibold text-ink-soft hover:text-ink"
        >
          {openRecipients ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span>{openRecipients ? 'Ocultar destinatarios' : `Ver destinatarios (${campaign.total})`}</span>
        </button>
        {openRecipients ? <RecipientsTable campaignId={campaign.id} /> : null}
      </div>
    </Card>
  );
}

function RecipientsTable({ campaignId }: { campaignId: number }) {
  const recipients = useApi<CampaignRecipient[]>(`/campaigns/${campaignId}/recipients`);

  if (recipients.loading) return <div className="py-4 text-xs text-ink-mute"><Spinner label="Cargando contactos…" /></div>;
  if (!recipients.data || recipients.data.length === 0) return null;

  return (
    <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-line">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface-2 text-ink-mute">
          <tr>
            <th className="p-2 font-semibold">Contacto</th>
            <th className="p-2 font-semibold">Teléfono</th>
            <th className="p-2 font-semibold">Estado</th>
            <th className="p-2 font-semibold">Enviado</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {recipients.data.map((r) => {
            const [label, tone] = BROADCAST_LABEL[r.status] ?? ['Desconocido', 'neutral'];
            return (
              <tr key={r.id} className="hover:bg-surface-2/40">
                <td className="p-2 font-semibold text-ink">{r.name || 'Sin nombre'}</td>
                <td className="p-2 font-mono text-ink-soft">{formatPhone(r.phone)}</td>
                <td className="p-2">
                  <Badge tone={tone} title={r.error ?? undefined}>
                    {label}
                  </Badge>
                </td>
                <td className="p-2 text-ink-mute">{r.sent_at ? fmtDateTime(r.sent_at) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
