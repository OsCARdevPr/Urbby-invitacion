import { exec, one } from '../db';
import type { GuestRow, WaStatus } from '../../shared/types';
import { getState, pauseCampaign, setConnection } from '../worker/whatsappQueue';

// Procesa los eventos que Evolution envía al webhook: estados de entrega de los mensajes enviados
// y cambios de conexión del número. Los mensajes entrantes no se escuchan. Los payloads varían
// entre versiones de v2, así que todo se lee a la defensiva.

type Json = Record<string, any>;

const asArray = (data: unknown): Json[] => (Array.isArray(data) ? data : data ? [data as Json] : []);

const RANK: Partial<Record<WaStatus, number>> = { sent: 1, delivered: 2, read: 3 };

/** Estados de mensaje de Baileys/Evolution → estados de la app. Acepta texto o el número crudo de Baileys. */
export function mapAck(status: unknown): 'sent' | 'delivered' | 'read' | null {
  const byNumber: Record<number, string> = { 2: 'SERVER_ACK', 3: 'DELIVERY_ACK', 4: 'READ', 5: 'PLAYED' };
  const s = typeof status === 'number' ? byNumber[status] : String(status ?? '').toUpperCase();
  if (s === 'SERVER_ACK') return 'sent';
  if (s === 'DELIVERY_ACK') return 'delivered';
  if (s === 'READ' || s === 'PLAYED') return 'read';
  return null;
}

/**
 * Avanza el estado del mensaje con este id (enviado → entregado → leído). Un aviso atrasado no hace retroceder
 * el estado. Devuelve false si ningún invitado tiene ese mensaje. Lo usan Evolution y Telnyx.
 */
export async function advanceByMessageId(messageId: string, status: 'sent' | 'delivered' | 'read'): Promise<boolean> {
  const guest = await one<Pick<GuestRow, 'id' | 'wa_status'>>(`SELECT id, wa_status FROM guests WHERE wa_message_id = $1`, [messageId]);
  if (!guest) return false;
  const current = RANK[guest.wa_status];
  if (current !== undefined && RANK[status]! > current) await exec(`UPDATE guests SET wa_status = $1 WHERE id = $2`, [status, guest.id]);
  return true;
}

/** El proveedor avisó que el mensaje no se entregó. Solo aplica si seguía como "enviado": no pisa un entregado o leído. */
export const failByMessageId = (messageId: string, status: 'failed' | 'no_whatsapp', error: string) =>
  exec(`UPDATE guests SET wa_status = $1, wa_error = $2 WHERE wa_message_id = $3 AND wa_status = 'sent'`, [status, error, messageId]);

export async function handleMessagesUpdate(data: unknown) {
  for (const d of asArray(data)) {
    const status = mapAck(d.status ?? d.update?.status);
    if (!status) continue;
    const ids = [d.keyId, d.key?.id, d.messageId].filter((v): v is string => typeof v === 'string');
    for (const id of ids) {
      if (await advanceByMessageId(id, status)) break;
    }
  }
}

export async function handleConnectionUpdate(data: unknown) {
  const state = String((data as Json)?.state ?? 'unknown');
  await setConnection(state);
  if (state === 'close' && (await getState()).running) {
    await pauseCampaign('WhatsApp se desconectó. Vuelve a vincular el número en Evolution y reanuda.');
  }
}

export async function handleEvolutionEvent(event: string, data: unknown) {
  const name = event.toLowerCase().replace(/_/g, '.');
  if (name === 'messages.update') await handleMessagesUpdate(data);
  else if (name === 'connection.update') await handleConnectionUpdate(data);
}
