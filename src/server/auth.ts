import crypto from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { config } from './config';
import type { Role } from '../shared/types';

export type AppEnv = { Variables: { role: Role } };

const COOKIE = 'urbby_session';
const SESSION_HOURS = 12;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
/** Comparación en tiempo constante (sobre hashes, para que el largo tampoco se filtre). */
const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

// Límite de intentos de login por IP: 10 cada 15 minutos.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

const clientIp = (c: Context) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';

export async function readRole(c: Context): Promise<Role | null> {
  const value = await getSignedCookie(c, config.sessionSecret, COOKIE);
  if (!value) return null;
  const [role, exp] = value.split('.');
  if (Number(exp) < Date.now()) return null;
  return role === 'admin' || role === 'doorman' ? role : null;
}

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const role = await readRole(c);
    if (!role) return c.json({ error: 'Tu sesión expiró. Vuelve a entrar.' }, 401);
    if (!roles.includes(role)) return c.json({ error: 'No tienes permiso para esto.' }, 403);
    c.set('role', role);
    await next();
  };

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const ip = clientIp(c);
    const now = Date.now();
    const entry = attempts.get(ip);
    if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
      return c.json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429);
    }

    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    const role: Role | null = safeEqual(password, config.adminPassword)
      ? 'admin'
      : safeEqual(password, config.doormanPassword)
        ? 'doorman'
        : null;

    if (!role) {
      attempts.set(ip, entry && entry.resetAt > now ? { ...entry, count: entry.count + 1 } : { count: 1, resetAt: now + WINDOW_MS });
      return c.json({ error: 'Contraseña incorrecta.' }, 401);
    }

    attempts.delete(ip);
    const exp = now + SESSION_HOURS * 3600_000;
    await setSignedCookie(c, COOKIE, `${role}.${exp}`, config.sessionSecret, {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_HOURS * 3600,
    });
    return c.json({ role });
  })
  .post('/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  })
  .get('/me', async (c) => c.json({ role: await readRole(c) }));
