import { useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { api, useApi } from '../api';
import { Badge, Button, Card, Notice, useToast } from './ui';
import { fmtDateTime, type Tone } from '../lib';
import type { TelnyxApproval, TelnyxTemplate } from '../../shared/types';
import { APPROVAL_LABEL } from '../../shared/telnyxTemplate';

export interface TelnyxTemplateInfo {
  template: TelnyxTemplate | null;
  approval: { status: TelnyxApproval; reason: string | null } | null;
  /** No se pudo consultar el estado en Telnyx. */
  checkError: string | null;
  /** El texto del evento cambió después de crear la plantilla. */
  textChanged: boolean;
  /** Problemas del texto actual que harían que Meta lo rechace. */
  problems: string[];
}

const APPROVAL_TONE: Record<TelnyxApproval, Tone> = {
  pending: 'info',
  approved: 'ok',
  rejected: 'bad',
  paused: 'bad',
  disabled: 'bad',
  unknown: 'neutral',
};

/** Plantilla de WhatsApp del evento en Telnyx: crearla a partir del texto de la invitación y ver si Meta la aprobó. */
export function TelnyxTemplatePanel({ eventId }: { eventId: number }) {
  const toast = useToast();
  const info = useApi<TelnyxTemplateInfo>(`/telnyx/events/${eventId}/template`);
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);

  const d = info.data;
  const status = d?.approval?.status;
  const canCreate = d && (!d.template || d.textChanged || status === 'rejected' || status === 'disabled');

  async function create() {
    if (d?.template && !window.confirm('Se creará una plantilla nueva con el texto actual y Meta tendrá que aprobarla otra vez. ¿Continuar?')) return;
    setCreating(true);
    try {
      info.setData(await api<TelnyxTemplateInfo>(`/telnyx/events/${eventId}/template`, { method: 'POST' }));
      toast('Plantilla enviada a revisión de Meta');
    } catch (err) {
      toast((err as Error).message, 'bad');
    } finally {
      setCreating(false);
    }
  }

  async function refresh() {
    setChecking(true);
    await info.reload();
    setChecking(false);
  }

  return (
    <Card className="mb-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <ShieldCheck className="size-5" /> Plantilla de WhatsApp · Telnyx
          </h2>
          <p className="mt-1 text-sm text-ink-mute">
            Con la API oficial, Meta tiene que aprobar el mensaje antes de enviarlo. Se crea como plantilla de marketing con el texto de la
            invitación del evento, y cada invitado recibe su propia tarjeta como imagen. Meta suele responder en 24 a 48 horas.
          </p>
        </div>
        {status ? <Badge tone={APPROVAL_TONE[status]}>{APPROVAL_LABEL[status]}</Badge> : d && !d.template ? <Badge tone="neutral">Sin plantilla</Badge> : null}
      </div>

      {info.error ? (
        <div className="mt-3">
          <Notice tone="bad">{info.error}</Notice>
        </div>
      ) : null}

      {d ? (
        <div className="mt-3 grid gap-3">
          {d.checkError ? <Notice tone="bad">{d.checkError}</Notice> : null}
          {d.approval?.reason ? <Notice tone="bad">Motivo de Meta: {d.approval.reason}</Notice> : null}
          {d.template && d.textChanged ? (
            <Notice tone="warn">
              Cambiaste el texto de la invitación después de crear la plantilla. Por Telnyx se envía el texto aprobado: crea una plantilla nueva
              para usar el actual.
            </Notice>
          ) : null}
          {canCreate && d.problems.length ? (
            <Notice tone="warn">
              Antes de crearla, corrige el texto de la invitación (en Editar):
              <ul className="mt-1 list-disc pl-5">
                {d.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {d.template ? (
            <p className="text-xs text-ink-mute">
              <code>{d.template.name}</code> · creada {fmtDateTime(d.template.createdAt)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canCreate ? (
              <Button variant={d.template ? 'secondary' : 'primary'} onClick={() => void create()} loading={creating} disabled={d.problems.length > 0}>
                {d.template ? 'Crear plantilla nueva' : 'Crear plantilla y enviarla a revisión'}
              </Button>
            ) : null}
            {d.template ? (
              <Button icon={<RefreshCw className="size-4" />} onClick={() => void refresh()} loading={checking}>
                Revisar estado
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
