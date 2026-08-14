// Monaco, assembled by hand rather than imported wholesale. The default
// `monaco-editor` entry registers every language it ships with (~5 MB); this
// page only ever edits JavaScript.
//
// The pieces, in the order they have to load:
import 'monaco-editor/features/register.all.js';                     // editor contributions: find, folding, suggest, hover…
import 'monaco-editor/languages/definitions/javascript/register.js'; // JS tokenizer + language configuration
import 'monaco-editor/languages/definitions/typescript/register.js'; // …and TS, which `.d.ts` extra-libs are parsed as

// The TS language service. Imported for its values, not just its side effect:
// `monaco.languages.typescript` is deprecated in 0.56 and the defaults objects
// are now reached through this module.
import {
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
} from 'monaco-editor/languages/features/typescript/register.js';

import * as monaco from 'monaco-editor/editor/editor.api.js';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { installMonacoTheme, MONACO_THEME_NAME } from './monaco-theme';

/**
 * One-time Monaco configuration: workers, the JS language service, and the
 * theme. Everything here is global to the page, so it runs once and is safe to
 * call from whichever surface needs an editor first.
 *
 * Deliberately no COOP/COEP anywhere near this — those headers exist only for
 * the website's in-browser viewer, and they complicate Monaco's workers
 * (Invariant 6 in `docs/desktop/README.md`).
 */

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) {
    return monaco;
  }
  configured = true;

  // Vite bundles each `?worker` import as its own ESM entry and hands back a
  // constructor — no worker-loader shim, no `workerMain.js` path juggling.
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };

  // Mirrors the `jsconfig.json` that `fluidcad init` scaffolds, so the editor
  // in the page and the editor in VS Code agree about the same file.
  javascriptDefaults.setCompilerOptions({
    allowJs: true,
    checkJs: true,
    allowNonTsExtensions: true,
    target: ScriptTarget.ESNext,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    // The engine's own `.d.ts` files are the point of choosing Monaco (P1-4);
    // without this the service would also pull the bundled DOM/ES libs and
    // report every Node global as missing.
    allowSyntheticDefaultImports: true,
    strict: false,
  });

  // `checkJs` is worth nothing if semantic diagnostics stay off — this is the
  // difference between syntax colouring and knowing that `edge().onPlane` is
  // real.
  javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // A model FluidCAD renders is a module the engine imports; a bare
    // top-level `await` is normal and not an error.
    diagnosticCodesToIgnore: [1375, 1378],
  });

  javascriptDefaults.setEagerModelSync(true);

  installMonacoTheme();

  return monaco;
}

/** Editor options every FluidCAD editor shares. */
export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  language: 'javascript',
  theme: MONACO_THEME_NAME,
  automaticLayout: true,
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  // The gutter carries breakpoints (P1-7), so it is always reserved rather
  // than appearing the first time one is set and shifting the text sideways.
  glyphMargin: true,
  lineNumbersMinChars: 3,
  folding: true,
  tabSize: 2,
  insertSpaces: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  padding: { top: 8, bottom: 8 },
  fixedOverflowWidgets: true,
};

export { monaco };
