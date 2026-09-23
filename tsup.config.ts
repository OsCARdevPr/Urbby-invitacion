import { defineConfig } from 'tsup';

// Empaqueta solo el servidor. Las dependencias de package.json quedan externas
// (better-sqlite3 y resvg son módulos nativos y se instalan en la imagen).
export default defineConfig({
  entry: ['src/server/index.ts'],
  outDir: 'dist/server',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
});
