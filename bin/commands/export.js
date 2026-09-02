import { existsSync, writeFileSync } from 'fs';
import { basename, dirname, resolve } from 'path';
import open from 'open';
import { findEntry } from '../lib/workspace.js';
import {
  discoverInstance,
  getFreePort,
  getJson,
  postForBuffer,
  probeHealth,
  responseError,
  sleep,
  startEphemeralServer,
} from '../lib/server-client.js';

/**
 * `fluidcad export step|stl|png` — the export and screenshot HTTP APIs from a
 * terminal. Against a running server the scene it already serves is the one
 * exported; with nothing running the CLI forks a server, renders the entry
 * file, exports, and reaps it.
 *
 * PNG is the exception to "fully headless": the screenshot pipeline renders in
 * a connected browser, so a UI client must be on the other end.
 */

const NAMED_VIEWS = [
  'front', 'back', 'left', 'right', 'top', 'bottom',
  'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
  'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
];

const STL_RESOLUTIONS = ['coarse', 'medium', 'fine', 'custom'];
/** STL has no unit; slicers assume mm, so that is the default target. */
const STL_SCALE_TARGETS = ['mm', 'document'];

/** Grace for a freshly-connected UI to build the scene before we capture it. */
const UI_SETTLE_MS = 2000;

/** Cheap capture used only to detect that a UI client is answering. */
const UI_PROBE = { width: 64, height: 64, autoCrop: false, fitToModel: false, transparent: true };

// ─── Command wiring ─────────────────────────────────────────────────────

export function registerExportCommand(program) {
  const exportCommand = program
    .command('export')
    .description('Export the model to a STEP, STL, or PNG file');

  withCommonOptions(exportCommand.command('step'))
    .description('Export the model as a STEP file')
    .option('--shapes <ids...>', 'shapes to export by position, feature name, or id (defaults to all)')
    .option('--list-shapes', 'print the scene\'s shapes and exit without exporting')
    .option('--no-colors', 'write plain geometry instead of per-shape colors')
    .action(runner(runStepExport));

  withCommonOptions(exportCommand.command('stl'))
    .description('Export the model as an STL mesh')
    .option('--shapes <ids...>', 'shapes to export by position, feature name, or id (defaults to all)')
    .option('--list-shapes', 'print the scene\'s shapes and exit without exporting')
    .option('--resolution <r>', `mesh resolution: ${STL_RESOLUTIONS.join(', ')} (default: medium)`)
    .option('--linear-deflection <length>', 'custom linear deflection in document units (implies --resolution custom)')
    .option('--angular-deflection <deg>', 'custom angular deflection in degrees (implies --resolution custom)')
    .option('--scale-to <target>', 'write the mesh in mm (what slicers expect) or in the document\'s units: mm, document', 'mm')
    .action(runner(runStlExport));

  withCommonOptions(exportCommand.command('png'))
    .description('Capture the model as a PNG (renders in a connected browser)')
    .option('--width <px>', 'image width in pixels', '800')
    .option('--height <px>', 'image height in pixels', '800')
    .option('--view <name>', `camera view: current, ${NAMED_VIEWS.join(', ')}`, 'iso-ftr')
    .option('--no-grid', 'hide the ground grid')
    .option('--show-axes', 'show the origin axes')
    .option('--transparent', 'transparent background')
    .option('--no-auto-crop', 'keep the full frame instead of cropping to the model')
    .option('--no-fit', 'do not fit the camera to the model')
    .option('--margin <px>', 'crop/fit margin in pixels', '20')
    .option('--open', 'open the viewport in the default browser to render the capture')
    .action(runner(runPngExport));
}

function withCommonOptions(command) {
  return command
    .option('-w, --workspace <path>', 'workspace directory (defaults to cwd)')
    .option('-e, --entry <file>', 'entry model file: .part.js, .assembly.js or .fluid.js (auto-detected if only one exists)')
    .option('-o, --out <path>', 'output file (defaults to <entry>.<ext> in the current directory)')
    .option('-p, --port <port>', 'export from the running server on this port instead of discovering one')
    .option('--timeout <sec>', 'seconds to wait for the server to come up (and for a UI client, for png)', '60');
}

/**
 * Every failure reaches the user as one line, never a stack trace. The `await`
 * matters: flag validation throws before its command returns a promise.
 */
function runner(fn) {
  return async (opts) => {
    try {
      await fn(opts);
    } catch (err) {
      console.error(err?.message ?? err);
      process.exit(1);
    }
  };
}

// ─── step / stl ─────────────────────────────────────────────────────────

function runStepExport(opts) {
  return runShapeExport('step', opts, { includeColors: opts.colors !== false });
}

function runStlExport(opts) {
  // Flag combinations are settled before anything is spawned.
  return runShapeExport('stl', opts, stlBody(opts));
}

async function runShapeExport(format, opts, formatBody) {
  const requested = parseShapeIds(opts.shapes);

  await withServer(opts, async (ctx) => {
    const shapes = await fetchShapes(ctx);
    const owners = await fetchOwners(ctx, shapes);
    if (opts.listShapes) {
      printShapes(shapes, owners);
      return;
    }

    const shapeIds = selectShapes(shapes, requested, owners);
    const result = await postForBuffer(ctx.port, '/api/export', { format, shapeIds, ...formatBody });
    if (!result.ok) {
      throw new Error(`Export failed: ${responseError(result)}`);
    }

    const outPath = resolveOut(opts.out, ctx.modelName, format === 'step' ? '.step' : '.stl');
    writeOutput(outPath, result.buffer, `${shapeIds.length} shape${shapeIds.length === 1 ? '' : 's'}`);
  });
}

function stlBody(opts) {
  const scaleTo = opts.scaleTo ?? 'mm';
  if (!STL_SCALE_TARGETS.includes(scaleTo)) {
    throw new Error(`Invalid --scale-to "${scaleTo}". Expected one of: ${STL_SCALE_TARGETS.join(', ')}.`);
  }
  return { scaleTo, ...stlResolutionBody(opts) };
}

function stlResolutionBody(opts) {
  const linear = parseNumberOption(opts.linearDeflection, '--linear-deflection', { min: 0, exclusive: true });
  const angular = parseNumberOption(opts.angularDeflection, '--angular-deflection', { min: 0, exclusive: true });
  const requested = opts.resolution;

  if (requested !== undefined && !STL_RESOLUTIONS.includes(requested)) {
    throw new Error(`Invalid --resolution "${requested}". Expected one of: ${STL_RESOLUTIONS.join(', ')}.`);
  }

  const hasDeflection = linear !== undefined || angular !== undefined;
  if (hasDeflection && requested !== undefined && requested !== 'custom') {
    throw new Error(
      `--resolution ${requested} conflicts with the deflection flags, which imply --resolution custom.`,
    );
  }
  if (requested !== 'custom' && !hasDeflection) {
    return { resolution: requested ?? 'medium' };
  }
  if (linear === undefined || angular === undefined) {
    throw new Error(
      'Custom resolution needs both --linear-deflection <length> and --angular-deflection <deg>.',
    );
  }
  return {
    resolution: 'custom',
    customLinearDeflection: linear,
    customAngularDeflectionDeg: angular,
  };
}

function parseShapeIds(shapes) {
  if (shapes === undefined) {
    return null;
  }
  const tokens = shapes
    .flatMap((value) => String(value).split(','))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new Error('--shapes needs at least one shape.');
  }
  return [...new Set(tokens)];
}

async function fetchShapes(ctx) {
  const result = await getJson(ctx.port, '/api/scene/shapes');
  if (result.status === 404) {
    throw new Error(
      `The server on port ${ctx.port} has not rendered a model yet — open a model file in it first.`,
    );
  }
  if (!result.ok) {
    throw new Error(`Could not list the scene's shapes: ${result.body?.error ?? `HTTP ${result.status}`}`);
  }
  return result.body?.shapes ?? [];
}

/** The feature each shape came out of, by scene-object id. */
async function fetchOwners(ctx, shapes) {
  if (shapes.length === 0) {
    return new Map();
  }
  const summary = await getJson(ctx.port, '/api/scene/summary');
  const owners = new Map();
  for (const object of summary.body?.objects ?? []) {
    if (typeof object?.id === 'string') {
      owners.set(object.id, object.name || object.kind || '');
    }
  }
  return owners;
}

function selectShapes(shapes, requested, owners) {
  if (shapes.length === 0) {
    throw new Error('The scene has no shapes to export.');
  }
  const available = shapes.map((s) => s.shapeId);
  if (!requested) {
    return available;
  }

  const selected = [];
  const unknown = [];
  for (const token of requested) {
    const matched = resolveShapeToken(shapes, owners, token);
    if (matched === null) {
      unknown.push(token);
      continue;
    }
    selected.push(...matched);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown shape${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.\n` +
        `Available ids: ${available.join(', ')}\n` +
        `Or pass a position (1-${shapes.length}) or a feature name (${featureNames(shapes, owners).join(', ')}).`,
    );
  }
  return [...new Set(selected)];
}

/**
 * A `--shapes` token is a shape id, a 1-based position in `--list-shapes`
 * order, or the name of the feature that produced it. Ids are minted fresh on
 * every render, so position and name are the handles that survive a re-run.
 * Returns the matching ids, or null when the token names nothing.
 */
function resolveShapeToken(shapes, owners, token) {
  const byId = shapes.filter((s) => s.shapeId === token);
  if (byId.length > 0) {
    return byId.map((s) => s.shapeId);
  }
  if (/^\d+$/.test(token)) {
    const position = Number(token);
    return position >= 1 && position <= shapes.length ? [shapes[position - 1].shapeId] : null;
  }
  const wanted = token.toLowerCase();
  const byName = shapes.filter((s) => (owners.get(s.sceneObjectId) ?? '').toLowerCase() === wanted);
  return byName.length > 0 ? byName.map((s) => s.shapeId) : null;
}

function featureNames(shapes, owners) {
  const names = shapes.map((s) => owners.get(s.sceneObjectId)).filter((name) => !!name);
  return [...new Set(names)];
}

/** `--list-shapes`: position, id, type, and the feature each shape came from. */
function printShapes(shapes, owners) {
  if (shapes.length === 0) {
    console.log('The scene has no shapes.');
    return;
  }

  const idWidth = Math.max(...shapes.map((s) => s.shapeId.length));
  const typeWidth = Math.max(...shapes.map((s) => (s.type ?? '').length));
  const positionWidth = String(shapes.length).length;
  console.log(`${shapes.length} shape${shapes.length === 1 ? '' : 's'}:`);
  shapes.forEach((shape, index) => {
    const position = String(index + 1).padStart(positionWidth);
    const owner = owners.get(shape.sceneObjectId) ?? '';
    console.log(
      `  ${position}  ${shape.shapeId.padEnd(idWidth)}  ${(shape.type ?? '').padEnd(typeWidth)}  ${owner}`.trimEnd(),
    );
  });
  console.log('\nPass --shapes a position, a feature name, or an id (ids change on every render).');
}

// ─── png ────────────────────────────────────────────────────────────────

async function runPngExport(opts) {
  const body = screenshotBody(opts);

  await withServer(opts, async (ctx) => {
    const png = await capturePng(ctx, opts, body);
    const outPath = resolveOut(opts.out, ctx.modelName, '.png');
    writeOutput(outPath, png, `${body.view.kind === 'named' ? body.view.name : 'current'} view`);
  });
}

function screenshotBody(opts) {
  const view = opts.view ?? 'iso-ftr';
  if (view !== 'current' && !NAMED_VIEWS.includes(view)) {
    throw new Error(`Invalid --view "${view}". Expected one of: current, ${NAMED_VIEWS.join(', ')}.`);
  }
  return {
    width: parseIntegerOption(opts.width, '--width', { min: 1, max: 8192 }) ?? 800,
    height: parseIntegerOption(opts.height, '--height', { min: 1, max: 8192 }) ?? 800,
    margin: parseNumberOption(opts.margin, '--margin', { min: 0 }) ?? 20,
    showGrid: opts.grid !== false,
    showAxes: opts.showAxes === true,
    transparent: opts.transparent === true,
    autoCrop: opts.autoCrop !== false,
    fitToModel: opts.fit !== false,
    view: view === 'current' ? { kind: 'current' } : { kind: 'named', name: view },
  };
}

/**
 * PNGs are rendered by a connected browser, so a capture either lands right
 * away (a UI is already there) or we wait for one to show up.
 */
async function capturePng(ctx, opts, body) {
  const first = await postForBuffer(ctx.port, '/api/screenshot', body);
  if (first.ok) {
    return first.buffer;
  }
  if (first.status !== 503) {
    throw new Error(`Screenshot failed: ${responseError(first)}`);
  }

  const url = `http://localhost:${ctx.port}`;
  if (ctx.mode === 'attached' && !opts.open) {
    throw new Error(
      `No FluidCAD UI is connected to the server on port ${ctx.port}, and PNGs are rendered in the browser.\n` +
        `Open ${url} in a browser, re-run with --open, or stop that server so the CLI can spawn its own.`,
    );
  }

  await waitForUiClient(ctx, opts, url);
  // The UI connects before it has built the scene; give it a moment.
  await sleep(UI_SETTLE_MS);

  const capture = await postForBuffer(ctx.port, '/api/screenshot', body);
  if (!capture.ok) {
    throw new Error(`Screenshot failed: ${responseError(capture)}`);
  }
  return capture.buffer;
}

async function waitForUiClient(ctx, opts, url) {
  process.stderr.write(`Waiting for a browser at ${url} to render the capture...\n`);
  if (opts.open) {
    open(url).catch((err) => {
      process.stderr.write(`Could not open a browser: ${err.message}\n`);
    });
  }

  const deadline = Date.now() + ctx.timeoutMs;
  for (;;) {
    const probe = await postForBuffer(ctx.port, '/api/screenshot', UI_PROBE);
    if (probe.status !== 503) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(ctx.timeoutMs / 1000)}s waiting for a UI client at ${url}. ` +
          'Open that URL in a browser (or pass --open) — FluidCAD renders PNGs in the browser.',
      );
    }
    await sleep(1000);
  }
}

// ─── Server resolution ──────────────────────────────────────────────────

/**
 * Hand `run` a server to export from: the one already serving this workspace,
 * or a fresh one that dies with the command.
 */
async function withServer(opts, run) {
  const workspace = resolve(opts.workspace ?? process.cwd());
  const timeoutMs = parseTimeout(opts.timeout);

  const attachedPort = await resolveAttachedPort(workspace, opts.port);
  if (attachedPort !== null) {
    const modelName = await attachedModelName(attachedPort, workspace, opts.entry);
    return run({ mode: 'attached', port: attachedPort, workspace, timeoutMs, modelName });
  }

  const entry = findEntry(workspace, opts.entry);
  const port = await getFreePort();
  process.stderr.write(`Starting FluidCAD and rendering ${basename(entry)}...\n`);
  const server = await startEphemeralServer({
    workspacePath: workspace,
    entry,
    port,
    deadlineAt: Date.now() + timeoutMs,
  });

  try {
    return await run({
      mode: 'ephemeral',
      port,
      workspace,
      timeoutMs,
      entry,
      modelName: modelName(entry),
    });
  } finally {
    server.kill();
  }
}

async function resolveAttachedPort(workspace, portOption) {
  if (portOption !== undefined) {
    const port = parseIntegerOption(portOption, '--port', { min: 1, max: 65535 });
    if (!(await probeHealth(port))) {
      throw new Error(
        `No FluidCAD server is responding on port ${port}. ` +
          'Start one with `fluidcad serve`, or drop --port to let the CLI spawn its own.',
      );
    }
    return port;
  }
  const instance = await discoverInstance(workspace);
  return instance ? instance.port : null;
}

/**
 * Name the output after whatever the running server is serving — that scene is
 * what gets exported, whether or not `--entry` agrees.
 */
async function attachedModelName(port, workspace, entryOption) {
  const summary = await getJson(port, '/api/scene/summary');
  const served = summary.ok && typeof summary.body?.file === 'string' ? summary.body.file : null;

  if (entryOption) {
    const entry = findEntry(workspace, entryOption);
    if (served && resolve(served) !== entry) {
      process.stderr.write(
        `Warning: a FluidCAD server is already running on port ${port} — exporting ${basename(served)}, ` +
          `not ${basename(entry)}. Stop that server to export a different file.\n`,
      );
    }
    return modelName(served ?? entry);
  }
  if (served) {
    return modelName(served);
  }
  const entry = tryFindEntry(workspace);
  return entry ? modelName(entry) : 'model';
}

function tryFindEntry(workspace) {
  try {
    return findEntry(workspace);
  } catch {
    // Zero or several candidates: the running server's scene is what counts,
    // and we only wanted a name for the output file.
    return null;
  }
}

// ─── Output ─────────────────────────────────────────────────────────────

function modelName(filePath) {
  const base = basename(filePath).replace(/\.fluid\.js$/i, '').replace(/\.js$/i, '');
  return base || 'model';
}

function resolveOut(outOption, name, extension) {
  return outOption ? resolve(outOption) : resolve(process.cwd(), `${name}${extension}`);
}

function writeOutput(outPath, bytes, detail) {
  const parent = dirname(outPath);
  if (!existsSync(parent)) {
    throw new Error(`Output directory does not exist: ${parent}`);
  }
  writeFileSync(outPath, bytes);
  console.log(`Wrote ${outPath} (${bytes.length} bytes, ${detail})`);
}

// ─── Option parsing ─────────────────────────────────────────────────────

function parseTimeout(value) {
  const seconds = parseNumberOption(value, '--timeout', { min: 0, exclusive: true }) ?? 60;
  return seconds * 1000;
}

function parseNumberOption(value, flag, { min, exclusive = false } = {}) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${flag} "${value}": expected a number.`);
  }
  if (min !== undefined && (exclusive ? parsed <= min : parsed < min)) {
    throw new Error(`Invalid ${flag} "${value}": expected a number ${exclusive ? 'greater than' : 'of at least'} ${min}.`);
  }
  return parsed;
}

function parseIntegerOption(value, flag, { min, max } = {}) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${flag} "${value}": expected a whole number.`);
  }
  if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
    throw new Error(`Invalid ${flag} "${value}": expected a whole number between ${min} and ${max}.`);
  }
  return parsed;
}
