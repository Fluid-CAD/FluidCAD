#!/usr/bin/env node

// Generates documentation screenshots from _examples/*.js files.
//
// Usage:
//   node website/scripts/generate-screenshots.mjs                    # all screenshots
//   node website/scripts/generate-screenshots.mjs extrude            # files matching "extrude"
//   node website/scripts/generate-screenshots.mjs constrained guide  # files matching either
//   node website/scripts/generate-screenshots.mjs --list             # list all examples without generating
//
// Filters match against the example id (e.g. "sketching-compound-rect") and the
// source path (e.g. "guides/sketching/_examples/compound-rect.js"), so you can
// filter by section, filename, or any substring.
//
// How it works:
//   1. Globs all _examples/*.js files under website/docs/
//   2. Each .js file is a complete, runnable FluidCAD script; a file named
//      *.assembly.js renders as an assembly, with every *.part.js sibling
//      staged into the workspace so its relative imports resolve
//   3. Starts a FluidCAD server, sends each file's code, and captures a screenshot
//   4. Saves screenshots to website/static/img/docs/<section>/<name>.png
//      (the section is the first directory under docs/)
//
// Screenshot options:
//   Add "// @screenshot showAxes" as the first line of a .js file to enable axes.
//   Add "// @screenshot hideGrid" to hide the ground grid in the screenshot.
//   Add "// @screenshot hideDimensions" to hide a sketch's dimensional constraints
//   (distance/angle/radius/diameter readouts); "hidePositional" hides the badges.
//   Add "// @screenshot noAxes" to suppress the automatic axes for rotate()/mirror() code.
//   Add "// @screenshot skip" to skip screenshot generation for that file.
//   Add "// @screenshot crop 0,0,100,16" to keep a percent region (x,y,w,h) of the capture.
//   Add "// @screenshot delay 8000" to wait longer for the UI to mesh the scene
//   (examples calling text() wait 10 s by default).
//
// Prerequisites:
//   - Run `npm run build` first (server + UI must be built)
//   - Open a browser to the server URL when prompted

import { fork, spawnSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const DOCS_DIR = resolve(__dirname, '..', 'docs');
const OUTPUT_ROOT = resolve(__dirname, '..', 'static', 'img', 'docs');
const SERVER_ENTRY = resolve(ROOT, 'server', 'dist', 'index.js');
const WORKSPACE_DIR = resolve(ROOT, '.screenshots-tmp');

const INIT_JS = `import { init } from 'fluidcad'\nexport default init()\n`;

const DEFAULT_SCREENSHOT_OPTIONS = {
  transparent: true,
  showGrid: true,
  showAxes: false,
  autoCrop: true,
  margin: 40,
  // Rendered at 2x the display size so the docs' images are crisp on
  // high-DPI screens (pages show them at ~800 px wide). pixelRatio tells the
  // UI so: screen-space overlays (constraint badges, dimension readouts) are
  // sized for an 800 px canvas and come out at their on-screen size once the
  // page halves the image.
  width: 1600,
  height: 1600,
  pixelRatio: 2,
};

const PORT = 3200;
const RENDER_DELAY_MS = 2000;
const TEXT_RENDER_DELAY_MS = 10000;

// Functions that indicate axes should be visible
const SHOW_AXES_MARKERS = ['revolve(', 'mirror(', 'rotate('];

// ─── Example discovery ─────────────────────────────────────────────────

function discoverExamples(docsDir) {
  const jsFiles = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.js') && dir.includes('_examples')) {
        jsFiles.push(fullPath);
      }
    }
  }
  walk(docsDir);

  const examples = [];
  for (const filePath of jsFiles) {
    const code = readFileSync(filePath, 'utf-8');
    const firstLines = code.split('\n').slice(0, 5).join('\n');

    // Check for skip annotation
    if (firstLines.includes('// @screenshot skip')) {
      continue;
    }

    // Determine showAxes from annotation or code content
    // `noAxes` overrides the automatic axes for code that merely mentions
    // rotate()/mirror() (an inserted instance's warm-start pose, say).
    const showAxes = !firstLines.includes('noAxes') && (
      firstLines.includes('// @screenshot showAxes') ||
      SHOW_AXES_MARKERS.some(marker => code.includes(marker)));

    // Determine noAutoCrop from annotation
    const noAutoCrop = firstLines.includes('noAutoCrop');

    // Determine hideGrid from annotation
    const hideGrid = firstLines.includes('hideGrid');

    // The sketch dialog's "Show constraints" toggles: a page about positional
    // constraints hides the dimension readouts so the badges stand out.
    const hideDimensions = firstLines.includes('hideDimensions');
    const hidePositional = firstLines.includes('hidePositional');

    // Determine waitForInput from annotation (pause before screenshot for manual camera adjustment)
    const waitForInput = firstLines.includes('waitForInput');

    // Determine emptyScene from annotation (capture viewport with no code sent)
    const emptyScene = firstLines.includes('emptyScene');

    // Parse aspectRatio annotation, e.g. "// @screenshot aspectRatio 1.67"
    const arMatch = firstLines.match(/\/\/ @screenshot.*aspectRatio\s+([\d.]+)/);
    const aspectRatio = arMatch ? parseFloat(arMatch[1]) : null;

    // Parse size annotation, e.g. "// @screenshot size 2400x1600". A taller
    // render shrinks constant-pixel-size overlays (vertex dots, cursor)
    // relative to the geometry. Takes precedence over aspectRatio.
    const sizeMatch = firstLines.match(/\/\/ @screenshot.*size\s+(\d+)x(\d+)/);
    const size = sizeMatch
      ? { width: parseInt(sizeMatch[1], 10), height: parseInt(sizeMatch[2], 10) }
      : null;

    // Parse delay annotation, e.g. "// @screenshot delay 8000" — extra time
    // for the UI to mesh the scene before the capture. Text glyphs are slow
    // to tessellate in the browser, so text examples get a long wait by
    // default; without it the capture shows the PREVIOUS example's scene.
    const delayMatch = firstLines.match(/\/\/ @screenshot.*delay\s+(\d+)/);
    const renderDelayMs = delayMatch
      ? parseInt(delayMatch[1], 10)
      : (code.includes('text(') ? TEXT_RENDER_DELAY_MS : RENDER_DELAY_MS);

    // Parse crop annotation, e.g. "// @screenshot crop 0,0,100,16" — keep only
    // that region (x, y, width, height in percent of the captured image),
    // applied after auto-crop. For scenes where a far-away construction
    // point (an arc's centre) would otherwise stretch the frame.
    const cropMatch = firstLines.match(/\/\/ @screenshot.*crop\s+([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
    const crop = cropMatch ? cropMatch.slice(1, 5).map(Number) : null;

    // Parse view annotation, e.g. "// @screenshot view iso-ftr". Captures from
    // a fixed named view (front, top, iso-ftr, ...) instead of the UI client's
    // current camera, making the shot reproducible without manual framing.
    const viewMatch = firstLines.match(/\/\/ @screenshot.*view\s+([a-z-]+)/);
    const view = viewMatch ? viewMatch[1] : null;

    // Compute output path
    const outputPath = examplePathToImagePath(filePath, docsDir);
    const name = basename(filePath).replace(/(\.part|\.assembly)?\.js$/, '');
    const relPath = relative(docsDir, filePath);
    const section = outputPath.replace(OUTPUT_ROOT + '/', '').replace(`/${name}.png`, '');

    examples.push({
      id: `${section}-${name}`.replace(/\//g, '-'),
      code,
      // An `.assembly.js` example renders as an assembly scene: the server
      // reads the scene kind off the entry file's extension.
      isAssembly: filePath.endsWith('.assembly.js'),
      outputPath,
      showAxes,
      noAutoCrop,
      hideGrid,
      hideDimensions,
      hidePositional,
      waitForInput,
      emptyScene,
      aspectRatio,
      size,
      view,
      crop,
      renderDelayMs,
      source: relPath,
    });
  }

  return examples;
}

function examplePathToImagePath(filePath, docsDir) {
  // Convert: docs/<section>/.../_examples/<name>.js
  //      to: static/img/docs/<section>/<name>.png
  //
  // The section is the first directory under docs/ (sketching, 3d-operations,
  // assembly, getting-started, tutorials, api, …). Sub-sections share their
  // section's image folder, so a sketching example lives in
  // docs/sketching/_examples/ whichever sub-page shows it.
  const relPath = relative(docsDir, filePath);
  const parts = relPath.split('/');
  const section = parts[0];
  // `asm-lever.part.js` → asm-lever.png, `asm-revolute.assembly.js` → asm-revolute.png
  const fileName = parts[parts.length - 1].replace(/(\.part|\.assembly)?\.js$/, '.png');
  return join(OUTPUT_ROOT, section, fileName);
}

// Assembly examples import their parts relatively (`./hinge-bracket.part.js`),
// so every `*.part.js` under docs/**/_examples/ is copied into the workspace
// root before rendering starts. Names must be unique across sections.
function stagePartFiles(docsDir, workspaceDir) {
  const seen = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.part.js') && dir.includes('_examples')) {
        const prev = seen.get(entry.name);
        if (prev) {
          console.warn(`Warning: two part files named ${entry.name} (${relative(docsDir, prev)} and ${relative(docsDir, fullPath)}) — the later one wins.`);
        }
        seen.set(entry.name, fullPath);
        writeFileSync(join(workspaceDir, entry.name), readFileSync(fullPath, 'utf-8'));
      }
    }
  }
  walk(docsDir);
  if (seen.size > 0) {
    console.log(`Staged ${seen.size} part file(s) for assembly examples.`);
  }
}

// ─── Server helpers ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

function waitForIPC(server, type, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for IPC: ${type}`)), timeoutMs);
    const handler = (msg) => {
      if (msg.type === type) {
        clearTimeout(timer);
        server.removeListener('message', handler);
        resolve(msg);
      }
    };
    server.on('message', handler);
  });
}

// Crops a PNG in place to a percent region [x, y, w, h] with ImageMagick.
let magickWarned = false;
function cropPng(filePath, [x, y, w, h]) {
  const probe = spawnSync('magick', ['identify', '-format', '%w %h', filePath]);
  if (probe.error || probe.status !== 0) {
    if (!magickWarned) {
      console.warn('\n(ImageMagick `magick` unavailable — crop directives ignored)');
      magickWarned = true;
    }
    return;
  }
  const [width, height] = probe.stdout.toString().trim().split(' ').map(Number);
  const geometry = `${Math.round(width * w / 100)}x${Math.round(height * h / 100)}+${Math.round(width * x / 100)}+${Math.round(height * y / 100)}`;
  const result = spawnSync('magick', [filePath, '-crop', geometry, '+repage', filePath]);
  if (result.status !== 0) {
    console.warn(`\n(crop failed for ${filePath}: ${result.stderr})`);
  }
}

let optimizerWarned = false;
// Flat-shaded CAD renders quantize to a palette with no visible loss, and
// pngquant cuts them to roughly a fifth of their size; optipng then squeezes
// the result losslessly. Either tool may be missing — the screenshot is kept
// unoptimized and a single warning is printed.
function optimizePng(filePath) {
  const quant = spawnSync('pngquant', ['--quality=80-98', '--speed', '1', '--force', '--skip-if-larger', '--ext', '.png', filePath]);
  // Exit 98/99 = skipped because the result would not be smaller / quality unmet.
  const quantOk = !quant.error && (quant.status === 0 || quant.status === 98 || quant.status === 99);
  const opti = spawnSync('optipng', ['-o2', '-quiet', '-strip', 'all', filePath]);
  const optiOk = !opti.error && opti.status === 0;
  if (!quantOk || !optiOk) {
    if (!optimizerWarned) {
      const missing = [!quantOk ? 'pngquant' : null, !optiOk ? 'optipng' : null].filter(Boolean).join(' and ');
      console.warn(`\n(${missing} unavailable — PNGs are only partly optimized; brew install optipng pngquant)`);
      optimizerWarned = true;
    }
    if (!quantOk && !optiOk) {
      return null;
    }
  }
  return statSync(filePath).size;
}

async function takeScreenshot(port, options) {
  const res = await fetch(`http://localhost:${port}/api/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Screenshot API ${res.status}: ${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  // Discover all example files
  let allScreenshots = discoverExamples(DOCS_DIR);

  // Parse CLI args
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const filters = args.filter(a => !a.startsWith('--'));

  if (filters.length > 0) {
    allScreenshots = allScreenshots.filter(s =>
      filters.some(f => s.id.includes(f) || s.source.includes(f))
    );
  }

  if (allScreenshots.length === 0) {
    console.error('No screenshots found matching filters:', filters.join(', '));
    process.exit(1);
  }

  if (listOnly) {
    console.log(`${allScreenshots.length} examples:\n`);
    for (const s of allScreenshots) {
      console.log(`  ${s.id}  (${s.source})`);
    }
    process.exit(0);
  }

  console.log(`Found ${allScreenshots.length} screenshots to generate.\n`);

  // Create workspace inside the project so Vite can resolve 'fluidcad'
  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  writeFileSync(join(WORKSPACE_DIR, 'init.js'), INIT_JS);
  writeFileSync(join(WORKSPACE_DIR, 'test.fluid.js'), '');
  writeFileSync(join(WORKSPACE_DIR, 'test.assembly.js'), '');
  stagePartFiles(DOCS_DIR, WORKSPACE_DIR);

  console.log(`Starting server on port ${PORT}...`);

  // Fork server
  const server = fork(SERVER_ENTRY, [], {
    env: {
      ...process.env,
      FLUIDCAD_SERVER_PORT: String(PORT),
      FLUIDCAD_WORKSPACE_PATH: WORKSPACE_DIR,
    },
    // Load-bearing: without it the engine's sourceLocations shift by the SSR
    // transform's line offset, mis-targeting breakpoints and feature edits.
    execArgv: ['--enable-source-maps'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  // A file that fails to compile or build leaves the PREVIOUS scene on
  // screen; the server still reports the render, so the capture would be a
  // silent duplicate of the last example. Watch the server log for the error
  // line and fail the example instead.
  let renderError = null;
  const watchForErrors = (chunk) => {
    const text = chunk.toString();
    const m = text.match(/Error processing file: ([^\n]*)/);
    if (m) {
      renderError = m[1];
    }
  };
  server.stdout.on('data', (d) => { watchForErrors(d); process.stdout.write(d); });
  server.stderr.on('data', (d) => { watchForErrors(d); process.stderr.write(d); });

  const cleanup = () => {
    try { server.kill(); } catch {}
    try { rmSync(WORKSPACE_DIR, { recursive: true, force: true }); } catch {}
  };

  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  try {
    await waitForIPC(server, 'ready');
    console.log(`Server ready at http://localhost:${PORT}`);

    const initMsg = await waitForIPC(server, 'init-complete', 60000);
    if (!initMsg.success) {
      throw new Error(`Init failed: ${initMsg.error}`);
    }
    console.log('FluidCAD initialized.');

    console.log(`\n>>> Open http://localhost:${PORT} in your browser <<<`);
    console.log('Waiting for UI client to connect...\n');
    while (true) {
      try {
        const res = await fetch(`http://localhost:${PORT}/api/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transparent: true }),
        });
        if (res.status !== 503) {
          console.log('UI client connected!\n');
          break;
        }
      } catch {}
      await sleep(1000);
    }

    // Process each screenshot
    let done = 0;
    let failed = 0;
    for (const config of allScreenshots) {
      const { id, outputPath, code, isAssembly, showAxes, noAutoCrop, hideGrid, hideDimensions, hidePositional, waitForInput, emptyScene, aspectRatio, size, view, crop, renderDelayMs } = config;

      mkdirSync(dirname(outputPath), { recursive: true });

      process.stdout.write(`[${++done}/${allScreenshots.length}] ${id}... `);

      if (emptyScene) {
        // Capture the viewport as-is without sending any code
        await sleep(RENDER_DELAY_MS);
      } else {
        // Send code to server via live-update
        renderError = null;
        const sceneRendered = waitForIPC(server, 'scene-rendered', 30000);
        server.send({
          type: 'live-update',
          fileName: join(WORKSPACE_DIR, isAssembly ? 'test.assembly.js' : 'test.fluid.js'),
          code: code.trim(),
        });

        // Wait for the server to finish processing + the UI to receive scene data
        try {
          await sceneRendered;
        } catch {
          console.log('TIMEOUT (scene-rendered) - skipping');
          failed++;
          continue;
        }

        // Wait for the UI to fully render the scene
        await sleep(renderDelayMs);
        if (renderError) {
          console.log(`FAILED (render error) - ${renderError.slice(0, 160)}`);
          failed++;
          continue;
        }
      }

      // Pause for manual camera adjustment if requested
      if (waitForInput) {
        await waitForEnter('\n>>> Adjust the camera, then press Enter to capture <<<\n');
      }

      // Capture screenshot
      try {
        const arSize = size ?? (aspectRatio ? { width: Math.round(1600 * aspectRatio), height: 1600 } : {});
        const options = {
          ...DEFAULT_SCREENSHOT_OPTIONS,
          ...(showAxes ? { showAxes: true } : {}),
          ...(hideGrid ? { showGrid: false } : {}),
          ...(hideDimensions ? { showDimensions: false } : {}),
          ...(hidePositional ? { showPositional: false } : {}),
          ...(noAutoCrop ? { autoCrop: false, fitToModel: false, transparent: false } : {}),
          ...(view ? { view: { kind: 'named', name: view } } : {}),
          ...arSize,
        };
        const png = await takeScreenshot(PORT, options);
        writeFileSync(outputPath, png);
        if (crop) {
          cropPng(outputPath, crop);
        }
        const optimizedSize = optimizePng(outputPath);
        if (optimizedSize !== null) {
          const saved = png.length - optimizedSize;
          const pct = ((saved / png.length) * 100).toFixed(0);
          console.log(`OK (${(optimizedSize / 1024).toFixed(1)} KB, -${pct}%)`);
        } else {
          console.log(`OK (${(png.length / 1024).toFixed(1)} KB, not optimized)`);
        }
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        failed++;
      }
    }

    console.log(`\nDone! ${done - failed}/${done} screenshots generated.`);
    if (failed > 0) {
      console.log(`${failed} failed — re-run with filter to retry.`);
    }
  } finally {
    cleanup();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
