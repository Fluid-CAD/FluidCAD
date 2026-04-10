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
//   2. Each .js file is a complete, runnable FluidCAD script
//   3. Starts a FluidCAD server, sends each file's code, and captures a screenshot
//   4. Saves screenshots to website/static/img/docs/<section>/<name>.png
//
// Screenshot options:
//   Add "// @screenshot showAxes" as the first line of a .js file to enable axes.
//   Add "// @screenshot skip" to skip screenshot generation for that file.
//
// Prerequisites:
//   - Run `npm run build` first (server + UI must be built)
//   - Open a browser to the server URL when prompted

import { fork } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
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
  margin: 20,
};

const PORT = 3200;
const RENDER_DELAY_MS = 2000;

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
    const showAxes = firstLines.includes('// @screenshot showAxes') ||
      SHOW_AXES_MARKERS.some(marker => code.includes(marker));

    // Compute output path
    const outputPath = examplePathToImagePath(filePath, docsDir);
    const name = basename(filePath, '.js');
    const relPath = relative(docsDir, filePath);
    const section = outputPath.replace(OUTPUT_ROOT + '/', '').replace(`/${name}.png`, '');

    examples.push({
      id: `${section}-${name}`.replace(/\//g, '-'),
      code,
      outputPath,
      showAxes,
      source: relPath,
    });
  }

  return examples;
}

function examplePathToImagePath(filePath, docsDir) {
  // Convert: docs/guides/3d-operations/_examples/extrude-basic.js
  //      to: static/img/docs/3d-operations/extrude-basic.png
  //
  // Rules:
  //   - Strip "guides/" prefix when followed by a subdirectory (3d-operations/, sketching/)
  //   - Keep "guides/" when _examples/ is directly under guides/
  //   - getting-started/ and tutorials/ pass through as-is
  const relPath = relative(docsDir, filePath);
  const parts = relPath.split('/');

  // Remove the _examples segment
  const examplesIdx = parts.indexOf('_examples');
  parts.splice(examplesIdx, 1);

  // Strip "guides/" prefix if it's followed by a subdirectory
  // e.g., guides/3d-operations/foo.js -> 3d-operations/foo.js
  // but guides/foo.js stays as guides/foo.js
  if (parts[0] === 'guides' && parts.length > 2) {
    parts.shift();
  }

  // Change extension
  const fileName = parts[parts.length - 1].replace('.js', '.png');
  parts[parts.length - 1] = fileName;

  return join(OUTPUT_ROOT, ...parts);
}

// ─── Server helpers ─────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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

  console.log(`Starting server on port ${PORT}...`);

  // Fork server
  const server = fork(SERVER_ENTRY, [], {
    env: {
      ...process.env,
      FLUIDCAD_SERVER_PORT: String(PORT),
      FLUIDCAD_WORKSPACE_PATH: WORKSPACE_DIR,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  server.stdout.on('data', (d) => process.stdout.write(d));
  server.stderr.on('data', (d) => process.stderr.write(d));

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
      const { id, outputPath, code, showAxes } = config;

      mkdirSync(dirname(outputPath), { recursive: true });

      process.stdout.write(`[${++done}/${allScreenshots.length}] ${id}... `);

      // Send code to server via live-update
      const sceneRendered = waitForIPC(server, 'scene-rendered', 30000);
      server.send({
        type: 'live-update',
        fileName: join(WORKSPACE_DIR, 'test.fluid.js'),
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
      await sleep(RENDER_DELAY_MS);

      // Capture screenshot
      try {
        const options = {
          ...DEFAULT_SCREENSHOT_OPTIONS,
          ...(showAxes ? { showAxes: true } : {}),
        };
        const png = await takeScreenshot(PORT, options);
        writeFileSync(outputPath, png);
        console.log(`OK (${(png.length / 1024).toFixed(1)} KB)`);
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
