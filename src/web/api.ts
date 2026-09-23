import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown; form?: FormData };

export async function api<T>(path: string, { method, body, form }: Options = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: method ?? (body !== undefined || form ? 'POST' : 'GET'),
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('urbby:unauthorized'));

  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.blob();
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? `Error ${res.status}`, res.status);
  return data as T;
}

/** Carga un recurso y, opcionalmente, lo refresca cada `pollMs`. */
export function useApi<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const next = await api<T>(path);
      if (alive.current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError((err as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = pollMs ? setInterval(() => void reload(), pollMs) : null;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [reload, pollMs]);

  return { data, error, loading, reload, setData };
}
