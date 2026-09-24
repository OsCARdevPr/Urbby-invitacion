import crypto from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { config } from './config';
import type { Role } from '../shared/types';

// No hay cuentas: una contraseña de admin y una compartida de porteros. Cada portero escribe su
// nombre al entrar; va en la sesión y queda guardado en cada ingreso que registra.
export type AppEnv = { Variables: { role: Role; staffName: string } };

const COOKIE = 'urbby_session';
const SESSION_HOURS = 12;
const NAME_MAX = 40;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
/** Comparación en tiempo constante (sobre hashes, para que el largo tampoco se filtre). */
const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

// Límite de intentos de login por IP: 10 cada 15 minutos.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

const clientIp = (c: Context) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';

export interface Session {
  role: Role;
  name: string;
}

/** La cookie va firmada: "rol.expiración.nombre-en-base64url". */
export async function readSession(c: Context): Promise<Session | null> {
  const value = await getSignedCookie(c, config.sessionSecret, COOKIE);
  if (!value) return null;
  const [role, exp, encodedName = ''] = value.split('.');
  if (Number(exp) < Date.now()) return null;
  if (role !== 'admin' && role !== 'doorman') return null;
  const name = Buffer.from(encodedName, 'base64url').toString('utf8') || (role === 'admin' ? 'Admin' : 'Portero');
  return { role, name };
}

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const session = await readSession(c);
    if (!session) return c.json({ error: 'Tu sesión expiró. Vuelve a entrar.' }, 401);
    if (!roles.includes(session.role)) return c.json({ error: 'No tienes permiso para esto.' }, 403);
    c.set('role', session.role);
    c.set('staffName', session.name);
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

    const body = (await c.req.json().catch(() => null)) as { password?: unknown; name?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    const typedName = typeof body?.name === 'string' ? body.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
    const role: Role | null = safeEqual(password, config.adminPassword)
      ? 'admin'
      : safeEqual(password, config.doormanPassword)
        ? 'doorman'
        : null;

    if (!role) {
      attempts.set(ip, entry && entry.resetAt > now ? { ...entry, count: entry.count + 1 } : { count: 1, resetAt: now + WINDOW_MS });
      return c.json({ error: 'Contraseña incorrecta.' }, 401);
    }
    // El nombre es lo que cuenta los ingresos de cada portero: sin él no se entra al escáner.
    if (role === 'doorman' && !typedName) return c.json({ error: 'Escribe tu nombre para registrar los ingresos.' }, 400);

    attempts.delete(ip);
    const name = typedName || 'Admin';
    const exp = now + SESSION_HOURS * 3600_000;
    await setSignedCookie(c, COOKIE, `${role}.${exp}.${Buffer.from(name, 'utf8').toString('base64url')}`, config.sessionSecret, {
      httpOnly: true,
      // Secure solo con HTTPS: así también funciona en Docker local (http://localhost:3000).
      secure: config.publicBaseUrl.startsWith('https://'),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_HOURS * 3600,
    });
    return c.json({ role, name });
  })
  .post('/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  })
  .get('/me', async (c) => c.json(await readSession(c)));
