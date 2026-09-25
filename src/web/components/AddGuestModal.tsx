import { api } from '../api';
import { Modal } from './ui';
import { GuestForm } from './GuestModal';
import type { GuestRow } from '../../shared/types';

const EMPTY = { name: '', business: '', phone: '', email: '' };

/** Agrega un invitado suelto, sin importar un Excel. Al guardarlo se abre su ficha con la invitación lista. */
export function AddGuestModal({
  open,
  eventId,
  onClose,
  onAdded,
}: {
  open: boolean;
  eventId: number;
  onClose: () => void;
  onAdded: (guest: GuestRow) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Agregar invitado">
      <GuestForm
        initial={EMPTY}
        submitLabel="Agregar y generar invitación"
        onCancel={onClose}
        onSubmit={async (form) => onAdded(await api<GuestRow>('/guests', { body: { eventId, ...form } }))}
      />
    </Modal>
  );
}
