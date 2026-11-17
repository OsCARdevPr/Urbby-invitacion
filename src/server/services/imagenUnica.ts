// Imagen única por destinatario: se le agrega al archivo un metadato aleatorio que no cambia los píxeles.
// Así cada envío tiene un hash distinto y WhatsApp no ve el mismo archivo repetido cientos de veces.
// Reduce el riesgo de bloqueo; no lo elimina.

export type MimeImagen = 'image/jpeg' | 'image/png' | 'image/webp';
export const MIMES_IMAGEN: MimeImagen[] = ['image/jpeg', 'image/png', 'image/webp'];

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tipo real del archivo según su firma (los primeros bytes), o null si no es JPEG, PNG ni WebP. */
export function detectarTipoImagen(buf: Buffer): MimeImagen | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(FIRMA_PNG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// CRC32 (polinomio 0xEDB88320), el que usan los chunks de PNG. Hecho a mano: `zlib.crc32` no existe en Node 22.0–22.1.
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 16 caracteres hexadecimales al azar (64 bits). */
function marcaAleatoria(rand: () => number): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.min(15, Math.floor(rand() * 16)).toString(16);
  return s;
}

/** PNG: chunk tEXt ("Comment" + marca) con su CRC, justo antes de IEND (que siempre es el último). */
function unicaPng(buf: Buffer, marca: string): Buffer {
  const iend = buf.length - 12;
  if (iend < 8 || buf.toString('latin1', iend + 4, iend + 8) !== 'IEND') return buf;
  const tipoYDatos = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(`Comment\0${marca}`, 'latin1')]);
  const chunk = Buffer.alloc(tipoYDatos.length + 8);
  chunk.writeUInt32BE(tipoYDatos.length - 4, 0);
  tipoYDatos.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(tipoYDatos), chunk.length - 4);
  return Buffer.concat([buf.subarray(0, iend), chunk, buf.subarray(iend)]);
}

/**
 * JPEG: segmento de comentario (COM, 0xFFFE). Va después de SOI y de los APPn iniciales (JFIF/Exif),
 * porque esos estándares piden que su segmento sea el primero; los lectores ignoran los COM.
 */
function unicaJpeg(buf: Buffer, marca: string): Buffer {
  let off = 2;
  while (off + 4 <= buf.length && buf[off] === 0xff && buf[off + 1] >= 0xe0 && buf[off + 1] <= 0xef) {
    const siguiente = off + 2 + buf.readUInt16BE(off + 2);
    if (siguiente > buf.length) {
      off = 2; // estructura rara: se inserta justo después de SOI
      break;
    }
    off = siguiente;
  }
  const texto = Buffer.from(marca, 'latin1');
  const com = Buffer.alloc(4 + texto.length);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(2 + texto.length, 2);
  texto.copy(com, 4);
  return Buffer.concat([buf.subarray(0, off), com, buf.subarray(off)]);
}

/**
 * WebP: solo el formato extendido (VP8X) admite chunks extra; la especificación pide ignorar los desconocidos.
 * El formato simple (un único chunk VP8/VP8L) no los permite, así que se devuelve igual: es lo seguro.
 */
function unicaWebp(buf: Buffer, marca: string): Buffer {
  if (buf.length < 20 || buf.toString('latin1', 12, 16) !== 'VP8X' || buf.readUInt32LE(4) !== buf.length - 8) return buf;
  const datos = Buffer.from(marca, 'latin1'); // 16 bytes: largo par, sin relleno
  const chunk = Buffer.alloc(8 + datos.length);
  chunk.write('UNIQ', 0, 'latin1');
  chunk.writeUInt32LE(datos.length, 4);
  datos.copy(chunk, 8);
  const out = Buffer.concat([buf, chunk]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** Copia del archivo con un metadato aleatorio. Si no reconoce la estructura, lo devuelve igual. */
export function hacerImagenUnica(buf: Buffer, mime: string, rand: () => number = Math.random): Buffer {
  const tipo = detectarTipoImagen(buf);
  if (tipo !== mime) return buf;
  const marca = marcaAleatoria(rand);
  if (tipo === 'image/png') return unicaPng(buf, marca);
  if (tipo === 'image/jpeg') return unicaJpeg(buf, marca);
  return unicaWebp(buf, marca);
}
