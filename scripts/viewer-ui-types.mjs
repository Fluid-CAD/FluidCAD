#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * The `fluidcad/viewer-ui` declarations, after `npm run build:viewer-ui`'s
 * vite build: `tsc -p ui/tsconfig.lib.json` writes `.d.ts` files for
 * `ui/src/viewer-ui.ts` and everything it reaches under
 * `ui/dist-lib/types/` (the tree mirrors the repo, `ui/src/...` and the
 * `lib/solver-core`/`lib/sketch-solver` sources the UI compiles in), then
 * this fixes what a consumer can't resolve from there:
 * - a type the UI takes from the compiled lib (`../../lib/dist/...`) points
 *   at the package's own `lib/dist`, which ships beside `ui/dist-lib`;
 * - a stylesheet import (`import './styles.css'`) is dropped: the styles are
 *   `fluidcad/viewer-ui/style.css`, imported by the host.
 * The package's `exports` names the entry for TypeScript (`types`).
 */
class ViewerUiTypes {
  static ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  static OUT = path.join(ViewerUiTypes.ROOT, 'ui', 'dist-lib', 'types');
  static SPECIFIER = /(from\s+|import\s*\(\s*|import\s+)(['"])(\.[^'"]*)\2/g;
  static STYLESHEET = /^import\s+['"][^'"]+\.css['"];\s*$/gm;

  static run() {
    fs.rmSync(ViewerUiTypes.OUT, { recursive: true, force: true });
    execFileSync(process.execPath, [path.join(ViewerUiTypes.ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ViewerUiTypes.ROOT, 'ui', 'tsconfig.lib.json')], {
      stdio: 'inherit',
    });
    let files = 0;
    let rewritten = 0;
    for (const file of ViewerUiTypes.declarations(ViewerUiTypes.OUT)) {
      const before = fs.readFileSync(file, 'utf8');
      const after = ViewerUiTypes.fix(file, before);
      files += 1;
      if (after !== before) {
        fs.writeFileSync(file, after);
        rewritten += 1;
      }
    }
    console.log(`viewer-ui declarations: ${files} files in ${path.relative(ViewerUiTypes.ROOT, ViewerUiTypes.OUT)}, ${rewritten} rewritten`);
  }

  static fix(file, text) {
    const dir = path.dirname(file);
    const withoutStyles = text.replace(ViewerUiTypes.STYLESHEET, '');
    return withoutStyles.replace(ViewerUiTypes.SPECIFIER, (whole, lead, quote, specifier) => {
      const target = path.resolve(dir, specifier);
      const inTypes = path.relative(ViewerUiTypes.OUT, target).split(path.sep).join('/');
      if (!inTypes.startsWith('lib/dist/')) {
        return whole;
      }
      const real = path.join(ViewerUiTypes.ROOT, inTypes);
      let relative = path.relative(dir, real).split(path.sep).join('/');
      if (!relative.startsWith('.')) {
        relative = `./${relative}`;
      }
      return `${lead}${quote}${relative}${quote}`;
    });
  }

  static *declarations(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* ViewerUiTypes.declarations(full);
      } else if (entry.name.endsWith('.d.ts')) {
        yield full;
      }
    }
  }
}

ViewerUiTypes.run();
