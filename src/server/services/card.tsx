import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import satori, { type Font } from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { config } from '../config';
import type { EventRow, GuestRow } from '../../shared/types';
import { formatDate, formatTime } from '../../shared/template';
import { guestUrl, qrPngDataUrl } from './qr';

// Tarjeta vertical 1080×1350: se ve completa en WhatsApp sin recortes.
const WIDTH = 1080;
const HEIGHT = 1350;
const QR_SIZE = 420;

const NAVY = '#021D59';
const YELLOW = '#FAB822';
const INK_SOFT = '#C6D4EC';
const INK_MUTE = '#9BB0D4';

type CardEvent = Pick<EventRow, 'name' | 'date' | 'time' | 'venue'>;
type CardGuest = Pick<GuestRow, 'name' | 'business' | 'token'>;

// ── Recursos que se cargan una sola vez ──────────────────────────

let cached: { fonts: Font[]; wordmark: string; ring: string; plus: string; swoosh: string } | null = null;

function loadAssets() {
  if (cached) return cached;
  const asset = (p: string) => fs.readFileSync(path.join(config.assetsDir, p));
  const svgUri = (p: string) => `data:image/svg+xml;base64,${asset(p).toString('base64')}`;

  const fonts: Font[] = [];
  for (const [name, file, weight] of [
    ['Archivo', 'archivo', 700],
    ['Archivo', 'archivo', 800],
    ['Manrope', 'manrope', 500],
    ['Manrope', 'manrope', 700],
  ] as const) {
    for (const subset of ['latin', 'latin-ext']) {
      fonts.push({ name, weight, style: 'normal', data: asset(`fonts/${file}-${subset}-${weight}-normal.woff`) });
    }
  }

  cached = {
    fonts,
    wordmark: cropWordmark(asset('Urbby_SFY.png')),
    ring: svgUri('anillo-arriba.svg'),
    plus: svgUri('mas-arriba.svg'),
    swoosh: svgUri('swoosh-izquierda.svg'),
  };
  return cached;
}

/** El PNG del logo es de 4500×4500 con mucho aire: se recorta y reduce una vez con resvg. */
function cropWordmark(png: Buffer): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="440 1420 3470 1510" width="3470" height="1510">
    <image href="data:image/png;base64,${png.toString('base64')}" x="0" y="0" width="4500" height="4500"/>
  </svg>`;
  const out = new Resvg(svg, { fitTo: { mode: 'width', value: 460 } }).render().asPng();
  return `data:image/png;base64,${out.toString('base64')}`;
}

/** Tamaño de letra según el largo del texto, para que casi nunca parta en dos líneas. */
function fitSize(text: string, steps: [number, number][], min: number): number {
  for (const [maxLen, size] of steps) if (text.length <= maxLen) return size;
  return min;
}

// ── Diseño ────────────────────────────────────────────────────────

function Card({ event, guest, qr }: { event: CardEvent; guest: CardGuest; qr: string }) {
  const a = loadAssets();
  const nameSize = fitSize(guest.name, [[18, 66], [24, 56], [32, 46]], 40);
  const titleSize = fitSize(event.name, [[16, 84], [24, 66]], 52);
  const businessSize = fitSize(guest.business, [[26, 36], [36, 30]], 26);

  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        position: 'relative',
        backgroundColor: NAVY,
        backgroundImage: 'radial-gradient(circle at 28% 34%, #3670AE 0%, #19417E 22%, #072561 46%, #021D59 78%)',
        fontFamily: 'Manrope',
        color: '#FFFFFF',
      }}
    >
      {/* Decoración tomada de la landing */}
      <img src={a.swoosh} width={900} height={1243} style={{ position: 'absolute', left: -470, top: 520 }} />
      <img src={a.ring} width={150} height={150} style={{ position: 'absolute', right: -44, top: 372 }} />
      <img src={a.plus} width={54} height={54} style={{ position: 'absolute', left: 92, top: 1004 }} />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          padding: '64px 80px 60px',
        }}
      >
        {/* Encabezado */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <img src={a.wordmark} width={220} height={96} />
          <div
            style={{
              display: 'flex',
              border: `2px solid ${YELLOW}`,
              borderRadius: 999,
              padding: '10px 24px',
              color: YELLOW,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: 4,
            }}
          >
            TARJETA DE INVITACIÓN
          </div>
        </div>

        {/* Evento e invitado */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: titleSize, lineHeight: 1.02, letterSpacing: -1 }}>
            {event.name}
          </div>
          <div style={{ display: 'flex', marginTop: 40, paddingLeft: 26, borderLeft: `6px solid ${YELLOW}`, flexDirection: 'column' }}>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 4, color: INK_MUTE }}>INVITACIÓN PARA</div>
            <div
              style={{
                fontFamily: 'Archivo',
                fontWeight: 800,
                fontSize: nameSize,
                lineHeight: 1.05,
                marginTop: 6,
                maxWidth: 820,
              }}
            >
              {guest.name}
            </div>
            {guest.business ? (
              <div style={{ fontSize: businessSize, fontWeight: 700, color: YELLOW, marginTop: 8, maxWidth: 820 }}>
                {guest.business}
              </div>
            ) : null}
          </div>
        </div>

        {/* QR. El bloque amarillo desplazado hace de sombra: un box-shadow difuso cuesta ~2 s por render en resvg. */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div style={{ display: 'flex', position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: 16,
                top: 16,
                right: -16,
                bottom: -16,
                backgroundColor: YELLOW,
                borderRadius: 40,
              }}
            />
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                backgroundColor: '#FFFFFF',
                borderRadius: 40,
                padding: 32,
              }}
            >
              <img src={qr} width={QR_SIZE} height={QR_SIZE} />
              <div
                style={{
                  marginTop: 20,
                  width: QR_SIZE,
                  textAlign: 'center',
                  justifyContent: 'center',
                  color: NAVY,
                  fontSize: 26,
                  fontWeight: 700,
                  lineHeight: 1.3,
                }}
              >
                Presenta este código QR para poder ingresar
              </div>
            </div>
          </div>
        </div>

        {/* Fecha y lugar */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: 1 }}>
            {`${formatDate(event.date)} · ${formatTime(event.time)}`.toUpperCase()}
          </div>
          <div style={{ fontSize: 26, fontWeight: 500, color: INK_SOFT, marginTop: 8, textAlign: 'center' }}>{event.venue}</div>
        </div>
      </div>
    </div>
  );
}

// ── Render y caché ───────────────────────────────────────────────

export async function renderCardPng(event: CardEvent, guest: CardGuest): Promise<Buffer> {
  const { fonts } = loadAssets();
  const qr = await qrPngDataUrl(guestUrl(guest.token), QR_SIZE * 2);
  const svg = await satori(<Card event={event} guest={guest} qr={qr} />, { width: WIDTH, height: HEIGHT, fonts });
  return new Resvg(svg, { fitTo: { mode: 'original' } }).render().asPng();
}

const cardsDir = () => path.join(config.dataDir, 'cards');

/**
 * Devuelve la tarjeta del invitado, generándola solo si cambió algún dato que aparece en ella.
 * El nombre del archivo lleva un hash de esos datos, así que editar el evento invalida la caché sola.
 */
export async function getCardPng(event: CardEvent, guest: CardGuest): Promise<Buffer> {
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify([event.name, event.date, event.time, event.venue, guest.name, guest.business, config.publicBaseUrl, 3]))
    .digest('hex')
    .slice(0, 10);
  const dir = cardsDir();
  const file = path.join(dir, `${guest.token}-${hash}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);

  const png = await renderCardPng(event, guest);
  fs.mkdirSync(dir, { recursive: true });
  for (const old of fs.readdirSync(dir)) {
    if (old.startsWith(`${guest.token}-`)) fs.rmSync(path.join(dir, old), { force: true });
  }
  fs.writeFileSync(file, png);
  return png;
}
