import { db, nowIso } from '../db';
import type { GuestRow, WaStatus } from '../../shared/types';
import { addUnmatched, getState, pauseCampaign, setConnection } from '../worker/whatsappQueue';
import { fold } from './text';

// Procesa los eventos que Evolution envía al webhook. Los payloads varían entre versiones
// de v2, así que todo se lee a la defensiva.

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

/** Saca el texto de un mensaje entrante, sea texto simple, extendido, pie de foto o efímero. */
export function extractText(message: Json | undefined): string {
  if (!message) return '';
  if (message.ephemeralMessage?.message) return extractText(message.ephemeralMessage.message);
  return String(
    message.conversation ??
      message.extendedTextMessage?.text ??
      message.imageMessage?.caption ??
      message.buttonsResponseMessage?.selectedDisplayText ??
      message.templateButtonReplyMessage?.selectedDisplayText ??
      '',
  );
}

/** Teléfonos (solo dígitos) que aparecen en la clave del mensaje. Con Baileys 7 el remoteJid puede ser @lid. */
export function phonesFromKey(key: Json, message: Json): string[] {
  const jids = [key.remoteJid, key.remoteJidAlt, key.senderPn, key.participant, key.participantAlt, message.senderPn];
  return [
    ...new Set(
      jids
        .filter((j): j is string => typeof j === 'string' && j.endsWith('@s.whatsapp.net'))
        .map((j) => j.split('@')[0].split(':')[0]),
    ),
  ];
}

export const isConfirmation = (text: string) => /\bconfirm/.test(fold(text));

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

export function handleMessagesUpsert(data: unknown) {
  const d = data as Json;
  const items = Array.isArray(d) ? d : Array.isArray(d?.messages) ? d.messages : asArray(d);
  for (const m of items as Json[]) {
    const key = m?.key as Json | undefined;
    if (!key || key.fromMe) continue;
    if (typeof key.remoteJid === 'string' && key.remoteJid.endsWith('@g.us')) continue; // grupos

    const text = extractText(m.message);
    const phones = phonesFromKey(key, m);
    const guests = phones.length
      ? (db
          .prepare(`SELECT id FROM guests WHERE wa_sent_at IS NOT NULL AND phone IN (${phones.map(() => '?').join(',')})`)
          .all(...phones) as { id: number }[])
      : [];

    if (guests.length === 0) {
      addUnmatched({ jid: String(key.remoteJid ?? ''), pushName: String(m.pushName ?? ''), text: text.slice(0, 200), at: nowIso() });
      continue;
    }

    const now = nowIso();
    const confirms = isConfirmation(text) ? 1 : 0;
    const update = db.prepare(
      `UPDATE guests SET
         wa_replied_at = COALESCE(wa_replied_at, ?),
         wa_status     = CASE WHEN wa_status IN ('sent', 'delivered') THEN 'read' ELSE wa_status END,
         confirmed_at  = CASE WHEN ? = 1 AND confirmed_at IS NULL THEN ? ELSE confirmed_at END
       WHERE id = ?`,
    );
    for (const g of guests) update.run(now, confirms, now, g.id);
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
  else if (name === 'messages.upsert') handleMessagesUpsert(data);
  else if (name === 'connection.update') handleConnectionUpdate(data);
}
