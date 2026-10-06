import { defineConfig } from 'vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  // Relative asset links: the built page is served at `/` by an engine and
  // under `/p/<project>/` by the proxy in front of it (`npx fluidcad`).
  base: './',
  plugins: [tailwindcss()],
  server: {
    port: 3200
  },
  build: {
    outDir: 'dist',
    // Monaco's editor API alone is ~2.7 MB minified, so the 500 kB default
    // fires on every build. The limit sits above today's largest chunk to
    // keep flagging real growth.
    chunkSizeWarningLimit: 3500
  }
});
