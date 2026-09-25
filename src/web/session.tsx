import { createContext, useContext } from 'react';
import type { Role } from '../shared/types';

export interface AppConfig {
  role: Role;
  /** Nombre que escribió al entrar (los porteros quedan registrados en cada ingreso). */
  name: string;
  evolutionConfigured: boolean;
  /** WhatsApp por la API oficial de Telnyx, con plantillas aprobadas por Meta. */
  telnyxConfigured: boolean;
  resendConfigured: boolean;
  publicBaseUrl: string;
  /** El QR apunta a localhost (desarrollo): los envíos masivos están bloqueados. */
  localUrl: boolean;
  senderPhoneDisplay: string;
  webhookUrl: string | null;
  defaults: {
    waTemplate: string;
    emailSubject: string;
    event: { name: string; time: string; venue: string; dress_code: string };
  };
  placeholders: string[];
}

export interface Session {
  config: AppConfig;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession fuera de SessionContext');
  return s;
}
