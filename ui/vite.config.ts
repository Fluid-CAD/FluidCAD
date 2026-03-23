import { defineConfig } from 'vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [tailwindcss()],
  server: {
    port: 3200
  },
  build: {
    outDir: 'dist'
  }
});
