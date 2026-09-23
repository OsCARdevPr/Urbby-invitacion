import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { Button, inputClass, Notice } from '../components/ui';
import type { Role } from '../../shared/types';

export function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { role } = await api<{ role: Role }>('/auth/login', { body: { password } });
      await onLogin();
      navigate(role === 'doorman' ? '/scan' : '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-navy bg-[radial-gradient(circle_at_25%_25%,#3670ae_0%,#0e306d_35%,#021d59_75%)] px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <img src="/urbby-wordmark.png" alt="Urbby" className="mb-8 h-12 w-auto" />
        <div className="rounded-2xl bg-surface p-6 shadow-2xl">
          <h1 className="text-2xl font-extrabold">Invitaciones</h1>
          <p className="mt-1 mb-5 text-ink-mute">Entra con la contraseña de administración o la de portero.</p>
          <label className="block">
            <span className="mb-1.5 block text-sm font-bold text-ink-soft">Contraseña</span>
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </label>
          {error ? (
            <div className="mt-4">
              <Notice tone="bad">{error}</Notice>
            </div>
          ) : null}
          <Button type="submit" variant="primary" loading={loading} className="mt-5 w-full">
            Entrar
          </Button>
        </div>
      </form>
    </div>
  );
}
