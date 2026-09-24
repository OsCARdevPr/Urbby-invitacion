import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import '@fontsource/archivo/700.css';
import '@fontsource/archivo/800.css';
import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import './styles.css';
import { api } from './api';
import { SessionContext, type AppConfig, type Session } from './session';
import { Spinner, ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Events } from './pages/Events';
import { EventForm } from './pages/EventForm';
import { EventDetail } from './pages/EventDetail';
import { WhatsApp } from './pages/WhatsApp';
import { Scan } from './pages/Scan';
import { Connections } from './pages/Connections';

function App() {
  const [config, setConfig] = useState<AppConfig | null | 'loading'>('loading');

  const load = useCallback(async () => {
    try {
      setConfig(await api<AppConfig>('/config'));
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const onUnauthorized = () => setConfig(null);
    window.addEventListener('urbby:unauthorized', onUnauthorized);
    return () => window.removeEventListener('urbby:unauthorized', onUnauthorized);
  }, [load]);

  const session = useMemo<Session | null>(
    () =>
      config && config !== 'loading'
        ? {
            config,
            logout: async () => {
              await api('/auth/logout', { method: 'POST' }).catch(() => {});
              setConfig(null);
            },
          }
        : null,
    [config],
  );

  if (config === 'loading') return <Spinner />;
  if (!session) return <Login onLogin={load} />;

  return (
    <SessionContext.Provider value={session}>
      <Routes>
        <Route path="/scan" element={<Scan />} />
        {session.config.role === 'admin' ? (
          <Route element={<Layout />}>
            <Route index element={<Events />} />
            <Route path="/events/new" element={<EventForm />} />
            <Route path="/events/:id" element={<EventDetail />} />
            <Route path="/events/:id/edit" element={<EventForm />} />
            <Route path="/whatsapp" element={<WhatsApp />} />
            <Route path="/conexiones" element={<Connections />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          // El portero solo tiene el escáner.
          <Route path="*" element={<Navigate to="/scan" replace />} />
        )}
      </Routes>
    </SessionContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
