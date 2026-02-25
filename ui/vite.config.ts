import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  server: {
    port: 3200
  },
  build: {
    outDir: 'dist'
  }
});
