import { db } from '../db';
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

export function handleMessagesUpdate(data: unknown) {
  const find = db.prepare(`SELECT id, wa_status FROM guests WHERE wa_message_id = ?`);
  const update = db.prepare(`UPDATE guests SET wa_status = ? WHERE id = ?`);
  for (const d of asArray(data)) {
    const status = mapAck(d.status ?? d.update?.status);
    if (!status) continue;
    const ids = [d.keyId, d.key?.id, d.messageId].filter((v): v is string => typeof v === 'string');
    for (const id of ids) {
      const guest = find.get(id) as Pick<GuestRow, 'id' | 'wa_status'> | undefined;
      if (!guest) continue;
      // Solo avanza (enviado → entregado → leído); un ack atrasado no hace retroceder el estado.
      const current = RANK[guest.wa_status];
      if (current !== undefined && RANK[status]! > current) update.run(status, guest.id);
      break;
    }
  }
}

export function handleConnectionUpdate(data: unknown) {
  const state = String((data as Json)?.state ?? 'unknown');
  setConnection(state);
  if (state === 'close' && getState().running) {
    pauseCampaign('WhatsApp se desconectó. Vuelve a vincular el número en Evolution y reanuda.');
  }
}

export function handleEvolutionEvent(event: string, data: unknown) {
  const name = event.toLowerCase().replace(/_/g, '.');
  if (name === 'messages.update') handleMessagesUpdate(data);
  else if (name === 'connection.update') handleConnectionUpdate(data);
}
