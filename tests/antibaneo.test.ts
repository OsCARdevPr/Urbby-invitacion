import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config';
import { sendImage } from '../src/server/services/evolution';
import { crc32, detectarTipoImagen, hacerImagenUnica } from '../src/server/services/imagenUnica';
import { resolverSpintax } from '../src/shared/spintax';
import { renderTemplate } from '../src/shared/template';

/** Generador determinista: devuelve los valores dados en orden, en bucle. */
const secuencia = (...valores: number[]) => {
  let i = 0;
  return () => valores[i++ % valores.length];
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// PNG mínimo válido de 1×1 (IHDR + IDAT + IEND).
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082',
  'hex',
);
// JPEG mínimo: SOI + APP0 (JFIF) + EOI. Basta para comprobar la estructura de marcadores.
const JPEG_JFIF = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

/** Recorre los chunks de un PNG y devuelve [tipo, datos, crcGuardado]. */
function chunksPng(png: Buffer) {
  const out: { tipo: string; datos: Buffer; crc: number }[] = [];
  let off = 8;
  while (off < png.length) {
    const largo = png.readUInt32BE(off);
    const tipo = png.subarray(off + 4, off + 8).toString('latin1');
    const datos = png.subarray(off + 8, off + 8 + largo);
    out.push({ tipo, datos, crc: png.readUInt32BE(off + 8 + largo) });
    off += 12 + largo;
  }
  return out;
}

describe('resolverSpintax', () => {
  it('elige una opción de cada grupo según el generador', () => {
    expect(resolverSpintax('{Hola|Buenas|Qué tal}, amigo', secuencia(0))).toBe('Hola, amigo');
    expect(resolverSpintax('{Hola|Buenas|Qué tal}, amigo', secuencia(0.5))).toBe('Buenas, amigo');
    expect(resolverSpintax('{Hola|Buenas|Qué tal}, amigo', secuencia(0.99))).toBe('Qué tal, amigo');
    expect(resolverSpintax('{a|b} y {c|d}', secuencia(0, 0.9))).toBe('a y d');
  });

  it('no se sale del rango aunque el generador devuelva 1', () => {
    expect(resolverSpintax('{x|y}', () => 1)).toBe('y');
  });

  it('deja intactos los datos del invitado para la plantilla', () => {
    const texto = resolverSpintax('{Hola|Buenas} {primer_nombre}, nos vemos en {lugar}.', secuencia(0.7));
    expect(texto).toBe('Buenas {primer_nombre}, nos vemos en {lugar}.');
    expect(renderTemplate(texto, { primer_nombre: 'Ana', lugar: 'Urbby Hub' })).toBe('Buenas Ana, nos vemos en Urbby Hub.');
  });

  it('permite opciones vacías', () => {
    expect(resolverSpintax('{Hola|} Ana', secuencia(0.9))).toBe(' Ana');
    expect(resolverSpintax('{Hola|} Ana', secuencia(0))).toBe('Hola Ana');
  });

  it('termina y deja tal cual las llaves sueltas o raras', () => {
    const raros = ['{', '}', '{{', '}}', '{|', '|}', 'a { b | c', '{nombre', '}{a|b', '{{{{{{{{{{', '|||', ''];
    for (const t of raros) expect(typeof resolverSpintax(t, secuencia(0))).toBe('string');
    expect(resolverSpintax('a { b | c', secuencia(0))).toBe('a { b | c');
    expect(resolverSpintax('}{a|b}{', secuencia(0))).toBe('}a{');
    expect(resolverSpintax('{|}', secuencia(0))).toBe('');
  });

  it('con grupos anidados resuelve solo el interior (sin anidación)', () => {
    expect(resolverSpintax('{a|{b|c}}', secuencia(0))).toBe('{a|b}');
  });

  it('termina rápido con textos largos llenos de llaves', () => {
    const largo = '{nombre} {a|b} {'.repeat(2000);
    const inicio = Date.now();
    resolverSpintax(largo);
    expect(Date.now() - inicio).toBeLessThan(1000);
  });
});

describe('hacerImagenUnica', () => {
  it('calcula el CRC32 estándar', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });

  it('detecta el tipo por la firma del archivo', () => {
    expect(detectarTipoImagen(PNG_1x1)).toBe('image/png');
    expect(detectarTipoImagen(JPEG_JFIF)).toBe('image/jpeg');
    expect(detectarTipoImagen(Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'latin1'))).toBe('image/webp');
    expect(detectarTipoImagen(Buffer.from('GIF89a'))).toBeNull();
    expect(detectarTipoImagen(Buffer.alloc(0))).toBeNull();
  });

  it('PNG: agrega un tEXt con CRC correcto antes de IEND y sigue siendo PNG', () => {
    const a = hacerImagenUnica(PNG_1x1, 'image/png', secuencia(0.1, 0.2, 0.3));
    const b = hacerImagenUnica(PNG_1x1, 'image/png', secuencia(0.9, 0.8, 0.7));
    expect(detectarTipoImagen(a)).toBe('image/png');
    expect(sha(a)).not.toBe(sha(b));
    expect(sha(a)).not.toBe(sha(PNG_1x1));

    const chunks = chunksPng(a);
    expect(chunks.map((c) => c.tipo)).toEqual(['IHDR', 'IDAT', 'tEXt', 'IEND']);
    for (const c of chunks) expect(crc32(Buffer.concat([Buffer.from(c.tipo, 'latin1'), c.datos]))).toBe(c.crc);
    // Los píxeles (IDAT) no cambian.
    expect(chunks[1].datos.equals(chunksPng(PNG_1x1)[1].datos)).toBe(true);
  });

  it('JPEG: agrega un comentario (COM) sin romper la estructura', () => {
    const a = hacerImagenUnica(JPEG_JFIF, 'image/jpeg', secuencia(0.1));
    const b = hacerImagenUnica(JPEG_JFIF, 'image/jpeg', secuencia(0.6));
    expect(detectarTipoImagen(a)).toBe('image/jpeg');
    expect(sha(a)).not.toBe(sha(b));
    // SOI, luego el APP0 (JFIF) sigue primero, luego el COM.
    expect(a.subarray(0, 4).toString('hex')).toBe('ffd8ffe0');
    const finApp0 = 4 + JPEG_JFIF.readUInt16BE(4);
    expect(a.subarray(finApp0, finApp0 + 2).toString('hex')).toBe('fffe');
    const largoCom = a.readUInt16BE(finApp0 + 2);
    expect(a.subarray(finApp0 + 2 + largoCom).equals(JPEG_JFIF.subarray(finApp0))).toBe(true);
  });

  it('WebP extendido (VP8X): agrega un chunk desconocido y actualiza el tamaño RIFF', () => {
    const vp8x = Buffer.concat([Buffer.from('VP8X', 'latin1'), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10)]);
    const cuerpo = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x]);
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), cuerpo]);
    webp.writeUInt32LE(cuerpo.length, 4);

    const a = hacerImagenUnica(webp, 'image/webp', secuencia(0.2));
    const b = hacerImagenUnica(webp, 'image/webp', secuencia(0.7));
    expect(sha(a)).not.toBe(sha(b));
    expect(a.readUInt32LE(4)).toBe(a.length - 8);
    expect(a.length % 2).toBe(0);
    expect(a.subarray(0, webp.length).subarray(8).equals(webp.subarray(8))).toBe(true);
  });

  it('WebP simple: lo devuelve igual (agregar chunks no es válido en ese formato)', () => {
    const simple = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(4)]);
    expect(hacerImagenUnica(simple, 'image/webp').equals(simple)).toBe(true);
  });

  it('devuelve el archivo igual si no reconoce su estructura', () => {
    const roto = Buffer.from('no es una imagen');
    expect(hacerImagenUnica(roto, 'image/png').equals(roto)).toBe(true);
  });
});

describe('sendImage con otros formatos', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('manda el mimetype indicado (JPEG) y por defecto PNG', async () => {
    Object.assign(config.evolution, { url: 'https://evolution.example', apiKey: 'KEY', instance: 'urbby' });
    const cuerpos: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      cuerpos.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ key: { id: 'WAMID2' } }), { status: 201 });
    });

    const { messageId } = await sendImage({
      number: '50371234567',
      caption: 'Hola',
      png: JPEG_JFIF,
      mimetype: 'image/jpeg',
      fileName: 'foto.jpg',
      delayMs: 0,
    });
    await sendImage({ number: '50371234567', caption: '', png: PNG_1x1, fileName: 'invitacion.png', delayMs: 0 });

    expect(messageId).toBe('WAMID2');
    expect(cuerpos[0]).toMatchObject({ mediatype: 'image', mimetype: 'image/jpeg', media: JPEG_JFIF.toString('base64'), fileName: 'foto.jpg' });
    expect(cuerpos[1]).toMatchObject({ mimetype: 'image/png' });
  });
});
