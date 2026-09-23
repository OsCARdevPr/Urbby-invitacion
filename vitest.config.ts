import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Config propia para no heredar el root de Vite (src/web). Los tests que tocan módulos
// con base de datos usan una carpeta temporal, nunca ./data.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    env: { DATA_DIR: path.join(os.tmpdir(), 'urbby-invitaciones-test') },
  },
});
