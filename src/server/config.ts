import path from 'node:path';

const env = (key: string, fallback = '') => (process.env[key] ?? fallback).trim();

const isProd = process.env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env('PORT', '3000')),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  assetsDir: path.resolve('assets'),
  webDir: path.resolve('dist/web'),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:5173').replace(/\/+$/, ''),
  tz: 'America/El_Salvador',

  adminPassword: env('ADMIN_PASSWORD'),
  doormanPassword: env('DOORMAN_PASSWORD'),
  sessionSecret: env('SESSION_SECRET'),

  evolution: {
    url: env('EVOLUTION_URL').replace(/\/+$/, ''),
    apiKey: env('EVOLUTION_API_KEY'),
    instance: env('EVOLUTION_INSTANCE'),
  },
  webhookSecret: env('WEBHOOK_SECRET'),
  senderPhoneDisplay: env('SENDER_PHONE_DISPLAY'),

  resend: {
    apiKey: env('RESEND_API_KEY'),
    from: env('EMAIL_FROM', 'Urbby <invitaciones@urbby.app>'),
    replyTo: env('EMAIL_REPLY_TO', 'soporte@urbby.app'),
  },
};

export const evolutionConfigured = () =>
  Boolean(config.evolution.url && config.evolution.apiKey && config.evolution.instance);

export const resendConfigured = () => Boolean(config.resend.apiKey);

/** Falla al arrancar si faltan los secretos imprescindibles, en vez de quedar abierto. */
export function assertConfig() {
  const missing = ['ADMIN_PASSWORD', 'DOORMAN_PASSWORD', 'SESSION_SECRET'].filter((k) => !env(k));
  if (missing.length && isProd) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
  if (missing.length) {
    console.warn(`[config] Faltan ${missing.join(', ')}; en desarrollo se usan valores de prueba.`);
    config.adminPassword ||= 'admin';
    config.doormanPassword ||= 'portero';
    config.sessionSecret ||= 'dev-secret-no-usar-en-produccion';
  }
  if (config.adminPassword === config.doormanPassword) {
    throw new Error('ADMIN_PASSWORD y DOORMAN_PASSWORD deben ser distintas.');
  }
}
