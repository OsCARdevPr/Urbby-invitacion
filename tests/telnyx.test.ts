import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WA_TEMPLATE, templateVars } from '../src/shared/template';
import { templateBodyProblems, templateValues, toTemplateBody } from '../src/shared/telnyxTemplate';
import { config } from '../src/server/config';
import { createTemplate, describeErrors, mapTelnyxStatus, publicKeyValid, sendTemplate, validSignature } from '../src/server/services/telnyx';

const event = {
  name: 'Pre-lanzamiento Urbby App',
  date: '2026-10-10',
  time: '17:30',
  venue: 'Urbby Hub',
  address: '',
  dress_code: 'Business Casual',
  maps_url: '',
};

describe('plantilla de WhatsApp a partir del texto del evento', () => {
  it('numera cada dato en orden y deja los desconocidos como texto', () => {
    const { body, variables } = toTemplateBody('Hola {primer_nombre}, te esperamos en {lugar} a las {hora}. Hola otra vez {primer_nombre} {x}.');
    expect(body).toBe('Hola {{1}}, te esperamos en {{2}} a las {{3}}. Hola otra vez {{4}} {x}.');
    expect(variables).toEqual({ 1: 'primer_nombre', 2: 'lugar', 3: 'hora', 4: 'primer_nombre' });
  });

  it('el texto por defecto sirve tal cual para Meta', () => {
    expect(templateBodyProblems(DEFAULT_WA_TEMPLATE)).toEqual([]);
    expect(toTemplateBody(DEFAULT_WA_TEMPLATE).variables).toEqual({ 1: 'nombre', 2: 'lugar', 3: 'hora', 4: 'dresscode' });
  });

  it('avisa lo que Meta rechaza', () => {
    expect(templateBodyProblems('{nombre}, te esperamos')[0]).toMatch(/empezar/);
    expect(templateBodyProblems('Te esperamos, {nombre}')[0]).toMatch(/terminar/);
    expect(templateBodyProblems('Hola {nombre} {negocio}, te esperamos')[0]).toMatch(/seguidos/);
    expect(templateBodyProblems('Hola, ubicación: {mapa}. Gracias')[0]).toMatch(/mapa/);
    expect(templateBodyProblems(`Hola ${'x'.repeat(1030)}`)[0]).toMatch(/1024/);
  });

  it('los valores van en orden, en una línea y nunca vacíos', () => {
    const vars = templateVars({ ...event, dress_code: '' }, { name: 'Ana   María\nLópez', business: '' });
    expect(templateValues({ 2: 'lugar', 1: 'nombre', 3: 'dresscode' }, vars)).toEqual(['Ana María López', 'Urbby Hub', '-']);
  });
});

describe('avisos de estado de Telnyx', () => {
  it('traduce los estados y detecta a quien no tiene WhatsApp', () => {
    expect(mapTelnyxStatus('message.sent', 'sent', undefined)).toBe('sent');
    expect(mapTelnyxStatus('message.finalized', 'delivered', undefined)).toBe('delivered');
    expect(mapTelnyxStatus('message.read', '', undefined)).toBe('read');
    expect(mapTelnyxStatus('message.finalized', 'delivery_failed', [{ code: '40008', detail: 'x' }])).toBe('failed');
    expect(mapTelnyxStatus('message.finalized', 'delivery_failed', [{ code: '41000', detail: '131026 - Message undeliverable' }])).toBe('no_whatsapp');
    expect(mapTelnyxStatus('message.sent', 'queued', undefined)).toBeNull();
  });

  it('explica los errores conocidos de Meta', () => {
    expect(describeErrors([{ code: '41000', title: 'WhatsApp Error', detail: '131049 - This message was not delivered' }], '')).toMatch(/marketing/);
    expect(describeErrors([{ code: '40008', title: 'Error', detail: 'Template is paused' }], '')).toBe('Template is paused');
    expect(describeErrors(undefined, 'por defecto')).toBe('por defecto');
  });

  it('verifica la firma Ed25519 sobre "timestamp|cuerpo" y rechaza la vieja o alterada', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
    const body = '{"data":{"event_type":"message.finalized"}}';
    const now = 1_790_000_000;
    const sign = (t: number, b: string) => crypto.sign(null, Buffer.from(`${t}|${b}`), privateKey).toString('base64');

    expect(publicKeyValid(pub)).toBe(true);
    expect(validSignature(body, String(now), sign(now, body), pub, now + 10)).toBe(true);
    expect(validSignature(body + ' ', String(now), sign(now, body), pub, now + 10)).toBe(false);
    expect(validSignature(body, String(now), sign(now, body), pub, now + 301)).toBe(false);
    expect(validSignature(body, String(now), undefined, pub, now)).toBe(false);
    expect(validSignature(body, String(now), sign(now, body), '', now)).toBe(false);
  });
});

describe('peticiones a Telnyx', () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureFetch(response: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    return calls;
  }

  it('envía la plantilla con la tarjeta del invitado como imagen y los valores del texto', async () => {
    Object.assign(config.telnyx, { apiKey: 'KEY', from: '+50370000000' });
    const calls = captureFetch({ data: { id: 'msg-1' } });
    const { id } = await sendTemplate({
      to: '50371234567',
      name: 'invitacion_1_abc',
      language: 'es',
      imageUrl: 'https://invitaciones.example.app/i/TOKEN/card.png',
      bodyValues: ['Ana', 'Urbby Hub'],
      webhookUrl: 'https://invitaciones.example.app/api/webhooks/telnyx',
    });
    expect(id).toBe('msg-1');
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/messages/whatsapp');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer KEY');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: '+50370000000',
      to: '+50371234567',
      webhook_url: 'https://invitaciones.example.app/api/webhooks/telnyx',
      whatsapp_message: {
        type: 'template',
        template: {
          name: 'invitacion_1_abc',
          language: { policy: 'deterministic', code: 'es' },
          components: [
            { type: 'header', parameters: [{ type: 'image', image: { link: 'https://invitaciones.example.app/i/TOKEN/card.png' } }] },
            { type: 'body', parameters: [{ type: 'text', text: 'Ana' }, { type: 'text', text: 'Urbby Hub' }] },
          ],
        },
      },
    });
  });

  it('crea la plantilla de marketing con imagen de cabecera y ejemplo del texto', async () => {
    Object.assign(config.telnyx, { apiKey: 'KEY', wabaId: 'WABA1' });
    const calls = captureFetch({ data: { id: 'tpl-1', status: 'PENDING' } });
    const r = await createTemplate({ name: 'invitacion_1_abc', language: 'es', body: 'Hola {{1}}, te esperamos.', bodyExample: ['Ana'], imageHandle: '4:abc' });
    expect(r).toEqual({ id: 'tpl-1', status: 'pending' });
    expect(calls[0].url).toBe('https://api.telnyx.com/v2/whatsapp/message_templates');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      waba_id: 'WABA1',
      name: 'invitacion_1_abc',
      category: 'MARKETING',
      language: 'es',
      components: [
        { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4:abc'] } },
        { type: 'BODY', text: 'Hola {{1}}, te esperamos.', example: { body_text: [['Ana']] } },
      ],
    });
  });
});
