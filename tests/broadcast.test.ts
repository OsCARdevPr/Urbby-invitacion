import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/server/config';
import { sendText } from '../src/server/services/evolution';
import { renderTemplate, templateVars } from '../src/shared/template';

describe('difusiones por Evolution', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('envía solo texto, con "escribiendo…" y sin vista previa de enlaces', async () => {
    Object.assign(config.evolution, { url: 'https://evolution.example', apiKey: 'KEY', instance: 'urbby' });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ key: { id: 'WAMID1' } }), { status: 201 });
    });

    const text = renderTemplate(
      '¡Hola {primer_nombre}! Mañana es el {evento} a las {hora}.',
      templateVars(
        { name: 'Pre-lanzamiento', date: '2026-10-10', time: '17:30', venue: 'Urbby Hub', address: '', dress_code: '', maps_url: '' },
        { name: 'Ana López', business: '' },
      ),
    );
    const { messageId } = await sendText({ number: '50371234567', text, delayMs: 5000 });

    expect(messageId).toBe('WAMID1');
    expect(calls[0].url).toBe('https://evolution.example/message/sendText/urbby');
    expect((calls[0].init.headers as Record<string, string>).apikey).toBe('KEY');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      number: '50371234567',
      text: '¡Hola Ana! Mañana es el Pre-lanzamiento a las 5:30 PM.',
      delay: 5000,
      linkPreview: false,
    });
  });

  it('detecta cuando el número no tiene WhatsApp', async () => {
    Object.assign(config.evolution, { url: 'https://evolution.example', apiKey: 'KEY', instance: 'urbby' });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ response: { message: [{ exists: false, number: '503' }] } }), { status: 400 }));
    await expect(sendText({ number: '50379999999', text: 'Hola', delayMs: 0 })).rejects.toMatchObject({ notOnWhatsApp: true });
  });
});
