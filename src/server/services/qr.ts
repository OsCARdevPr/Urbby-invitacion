import QRCode from 'qrcode';
import { config } from '../config';

/** URL que va dentro del QR. Abierta por el invitado muestra su invitación; leída por el escáner registra el ingreso. */
export const guestUrl = (token: string) => `${config.publicBaseUrl}/i/${token}`;

export async function qrPngDataUrl(text: string, size: number): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 0,
    width: size,
    color: { dark: '#021D59', light: '#FFFFFF' },
  });
}
