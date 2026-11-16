import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config';
import { sendImage, sendText } from '../src/server/services/evolution';
import { renderTemplate } from '../src/shared/template';

describe('campañas por Evolution API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('envía imagen con pie personalizado (caption) y delay en Evolution sendMedia', async () => {
    Object.assign(config.evolution, { url: 'https://evolution.example', apiKey: 'KEY123', instance: 'urbby-inst' });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ key: { id: 'WAMID_CAMPAIGN_1' } }), { status: 201 });
    });

    const vars = { nombre: 'Lucía', descuento: '30%', codigo: 'LUCIA30' };
    const caption = renderTemplate('¡Hola {nombre}! Aprovecha tu descuento del {descuento} usando el código *{codigo}*.', vars);
    const fakeJpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const res = await sendImage({
      number: '50371234567',
      caption,
      buffer: fakeJpgBuffer,
      fileName: 'promo.jpg',
      mimetype: 'image/jpeg',
      delayMs: 4500,
    });

    expect(res.messageId).toBe('WAMID_CAMPAIGN_1');
    expect(calls[0].url).toBe('https://evolution.example/message/sendMedia/urbby-inst');
    expect((calls[0].init.headers as Record<string, string>).apikey).toBe('KEY123');

    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      number: '50371234567',
      mediatype: 'image',
      mimetype: 'image/jpeg',
      caption: '¡Hola Lucía! Aprovecha tu descuento del 30% usando el código *LUCIA30*.',
      media: fakeJpgBuffer.toString('base64'),
      fileName: 'promo.jpg',
      delay: 4500,
    });
  });

  it('envía solo texto cuando la campaña no incluye imagen', async () => {
    Object.assign(config.evolution, { url: 'https://evolution.example', apiKey: 'KEY123', instance: 'urbby-inst' });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ key: { id: 'WAMID_CAMPAIGN_2' } }), { status: 201 });
    });

    const vars = { nombre: 'Roberto', beneficio: 'envío gratis' };
    const text = renderTemplate('Hola {nombre}, hoy tienes {beneficio} en toda la tienda.', vars);

    const res = await sendText({
      number: '50378889999',
      text,
      delayMs: 3000,
    });

    expect(res.messageId).toBe('WAMID_CAMPAIGN_2');
    expect(calls[0].url).toBe('https://evolution.example/message/sendText/urbby-inst');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.text).toBe('Hola Roberto, hoy tienes envío gratis en toda la tienda.');
  });
});
