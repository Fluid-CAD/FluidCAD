// Assembly load timings, no browser: drives the real FluidCadServer over a
// workspace and reports what each way of arriving at the assembly costs.
//
//   npm run build:lib && npm run build:server
//   node --enable-source-maps scripts/perf/assembly-load.mjs <workspace> <assembly-file> [dependency-file] > /dev/null
//
// Timings go to stderr; the engine's own console output goes to stdout, so
// redirect it. `dependency-file` is any file the assembly imports (a part):
// opening it and coming back is the "switch back" scenario. Paths may be
// relative to the workspace. STEPS=cold,warm,dep,back,recompute picks steps.
import { resolve } from 'node:path';
import { FluidCadServer } from '../../server/dist/api.js';

process.setSourceMapsEnabled(true);

const [workspaceArg, assemblyArg, dependencyArg] = process.argv.slice(2);
if (!workspaceArg || !assemblyArg) {
  process.stderr.write('usage: assembly-load.mjs <workspace> <assembly-file> [dependency-file]\n');
  process.exit(2);
}
const WORKSPACE = resolve(workspaceArg);
const ASSEMBLY = resolve(WORKSPACE, assemblyArg);
const DEPENDENCY = dependencyArg ? resolve(WORKSPACE, dependencyArg) : null;

function report(label, ms, extra = '') {
  process.stderr.write(`${label.padEnd(44)} ${ms.toFixed(0).padStart(8)} ms  ${extra}\n`);
}

async function timed(label, fn) {
  const start = performance.now();
  const data = await fn();
  const ms = performance.now() - start;
  const rows = data?.result ?? [];
  const cached = rows.filter(o => o.fromCache).length;
  const visible = rows.filter(o => o.visible !== false && (o.sceneShapes?.length ?? 0) > 0).length;
  const instances = data?.assembly?.instances?.length ?? 0;
  const bytes = data ? JSON.stringify(data).length : 0;
  report(label, ms, `objects=${rows.length} withShapes=${visible} fromCache=${cached} instances=${instances} payload=${(bytes / 1e6).toFixed(1)}MB`);
  return data;
}

const server = new FluidCadServer();
const initStart = performance.now();
await server.init(WORKSPACE);
report('init (vite + OCCT wasm)', performance.now() - initStart);

const steps = (process.env.STEPS ?? 'cold,warm,dep,back,recompute').split(',');
for (const step of steps) {
  if (step === 'cold') {
    await timed('cold open', () => server.processFile(ASSEMBLY));
  } else if (step === 'warm') {
    await timed('re-open, nothing else touched', () => server.processFile(ASSEMBLY));
  } else if (step === 'dep' && DEPENDENCY) {
    await timed('open dependency', () => server.processFile(DEPENDENCY));
  } else if (step === 'back' && DEPENDENCY) {
    await timed('switch back to the assembly', () => server.processFile(ASSEMBLY));
  } else if (step === 'recompute') {
    await timed('recompute (compare baseline kept)', () => server.recomputeCurrentFile(false));
  }
}
process.exit(0);
