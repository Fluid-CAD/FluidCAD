import { defineConfig, type Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import { buildLogger } from './build-logger.ts';

/**
 * The desktop app's start screen (`ui/start.html` → `ui/dist-start/`), built
 * apart from the product page the way `vite.lib.config.ts` builds the viewer.
 *
 * The two pages never share a document or an origin — the start page is
 * served by the shell over `fluidcad-app://start/`, the product page by each
 * project's own engine over http — so a shared chunk graph would save nothing,
 * and a second input in `vite.config.ts` would only reshuffle the product's
 * chunks. Its own output directory also means a project engine's static
 * route never serves the start page at all.
 *
 * `start.html` carries the literal `data-theme="fluidcad-dark"`: the shell
 * replaces it with the saved theme before the first paint, the same trick as
 * `sendIndexHtml` in `server/src/index.ts`, so keep it exactly as written.
 */

const UI_ROOT = path.resolve(import.meta.dirname);

/**
 * The only `ui/public/` files the start page references. The rest of that
 * folder is the product's toolbar art, which would ride along for nothing.
 */
const START_PUBLIC_FILES = ['logo.svg'];

function startPublicFiles(): Plugin {
  return {
    name: 'fluidcad-start-public-files',
    apply: 'build',
    generateBundle() {
      for (const fileName of START_PUBLIC_FILES) {
        this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(path.join(UI_ROOT, 'public', fileName)) });
      }
    },
  };
}

/**
 * Modules the start page must never bundle: it would load the product's weight
 * for a page that shows a grid of cards. A build that pulls one in fails,
 * naming the import chain, rather than quietly growing by megabytes.
 */
const START_DENYLIST: { pattern: RegExp; what: string }[] = [
  { pattern: /[\\/]node_modules[\\/]three[\\/]/, what: 'three.js' },
  { pattern: /[\\/]node_modules[\\/]monaco-editor[\\/]/, what: 'Monaco' },
  { pattern: /[\\/]ui[\\/]src[\\/]api\.ts$/, what: "the product's server client (ui/src/api.ts)" },
  { pattern: /[\\/]ui[\\/]src[\\/]main\.ts$/, what: "the product page's entry (ui/src/main.ts)" },
];

function startImportDenylist(): Plugin {
  return {
    name: 'fluidcad-start-import-denylist',
    apply: 'build',
    buildEnd(error) {
      if (error) {
        return;
      }
      for (const id of this.getModuleIds()) {
        const denied = START_DENYLIST.find((entry) => entry.pattern.test(id));
        if (!denied) {
          continue;
        }
        // Walk back to the entry through first importers, for a message that
        // says which import to cut.
        const chain = [id];
        for (let current = id; chain.length < 20; ) {
          const importer = this.getModuleInfo(current)?.importers[0];
          if (!importer || chain.includes(importer)) {
            break;
          }
          chain.push(importer);
          current = importer;
        }
        const shown = chain.map((entry) => path.relative(UI_ROOT, entry.split('?')[0]));
        this.error(`The start page must not bundle ${denied.what}. Import chain: ${shown.join(' ← ')}`);
      }
    },
  };
}

export default defineConfig({
  root: UI_ROOT,
  customLogger: buildLogger(),
  publicDir: false,
  plugins: [tailwindcss(), startPublicFiles(), startImportDenylist()],
  build: {
    outDir: 'dist-start',
    reportCompressedSize: false,
    emptyOutDir: true,
    rolldownOptions: {
      input: path.resolve(UI_ROOT, 'start.html'),
    },
  },
});
