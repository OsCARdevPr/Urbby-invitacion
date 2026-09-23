import { createContext, useContext } from 'react';
import type { Role } from '../shared/types';

export interface AppConfig {
  role: Role;
  evolutionConfigured: boolean;
  resendConfigured: boolean;
  publicBaseUrl: string;
  senderPhoneDisplay: string;
  webhookUrl: string | null;
  defaults: { waTemplate: string; emailSubject: string };
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
