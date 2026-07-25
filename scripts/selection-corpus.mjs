// Phase-0 corpus metric for select→apply-feature (docs/select-apply-feature.md §6).
//
// Executes every website example as a real .fluid.js module (package
// self-reference resolves `fluidcad/*`; files are copied verbatim into
// <repo>/.corpus-tmp so source-location capture sees a .fluid.js path with the
// original line numbers), then runs every edge of every rendered solid through
// explainSelection + synthesizeApplyFeature and aggregates:
//   - attribution: direct bucket / lineage-only / unattributed
//   - synthesis: which tier wins (0 bucket, 1 qualitative filter, 2 numeric
//     filter, 3 scene-wide select(), 4 bucket index) or the refusal reason
//
// The corpus is processed in child-process chunks: a long single-process run
// degrades the OCC wasm heap after ~140 models (null-function / unaligned-
// access crashes), so the orchestrator spawns a fresh worker per chunk and
// bisects any chunk whose worker dies to attribute the crash to a file.
//
// Usage: node scripts/selection-corpus.mjs [--limit N] [--only substring]
//        [--max-edges N] [--chunk N] [--json out.json]

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(selfPath));
const tmpDir = join(repoRoot, '.corpus-tmp');
process.env.FLUIDCAD_WORKSPACE_PATH = tmpDir;

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const limit = Number(argValue('--limit', Infinity));
const only = argValue('--only', null);
const maxEdgesPerSolid = Number(argValue('--max-edges', 300));
const chunkSize = Number(argValue('--chunk', 20));
const jsonOut = argValue('--json', null);
const workerFiles = argValue('--files', null);
const isWorker = args.includes('--worker');

function collectExamples(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectExamples(p));
    } else if (entry.isFile() && p.includes('_examples') && p.endsWith('.js')) {
      found.push(p);
    }
  }
  return found;
}

function emptyTotals() {
  return {
    files: { ok: 0, failed: 0, noSolids: 0 },
    edges: 0,
    truncated: 0,
    attribution: { direct: 0, lineage: 0, unattributed: 0 },
    sharedCallSite: 0,
    clones: 0,
    tiers: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
    refusals: {},
    alternatives: 0,
  };
}

function mergeTotals(into, from) {
  into.files.ok += from.files.ok;
  into.files.failed += from.files.failed;
  into.files.noSolids += from.files.noSolids;
  into.edges += from.edges;
  into.truncated += from.truncated;
  into.attribution.direct += from.attribution.direct;
  into.attribution.lineage += from.attribution.lineage;
  into.attribution.unattributed += from.attribution.unattributed;
  into.sharedCallSite += from.sharedCallSite;
  into.clones += from.clones;
  for (const tier of [0, 1, 2, 3, 4]) {
    into.tiers[tier] += from.tiers[tier];
  }
  for (const [reason, count] of Object.entries(from.refusals)) {
    into.refusals[reason] = (into.refusals[reason] ?? 0) + count;
  }
  into.alternatives += from.alternatives;
}

// ---------------------------------------------------------------------------
// Worker: process a list of example files in this process
// ---------------------------------------------------------------------------

async function runWorker(files) {
  const { init } = await import(pathToFileURL(join(repoRoot, 'lib/dist/index.js')));
  const { getSceneManager, getCurrentScene, setCurrentFile } =
    await import(pathToFileURL(join(repoRoot, 'lib/dist/scene-manager.js')));
  const { SceneRenderer } = await import(pathToFileURL(join(repoRoot, 'lib/dist/rendering/render.js')));
  const { DEFAULT_MESH_CONFIG } = await import(pathToFileURL(join(repoRoot, 'lib/dist/oc/mesh.js')));
  const { Explorer } = await import(pathToFileURL(join(repoRoot, 'lib/dist/oc/explorer.js')));
  const { explainSelection, synthesizeApplyFeature } =
    await import(pathToFileURL(join(repoRoot, 'lib/dist/selection/explain.js')));

  mkdirSync(tmpDir, { recursive: true });
  await init();
  const renderer = new SceneRenderer(DEFAULT_MESH_CONFIG);

  function findSolids(scene) {
    const solids = [];
    const seen = new Set();
    for (const obj of scene.getAllSceneObjects()) {
      if (obj.isContainer()) {
        continue;
      }
      for (const shape of obj.getShapes()) {
        if (shape.getType() === 'solid' && !seen.has(shape.id)) {
          seen.add(shape.id);
          solids.push(shape);
        }
      }
    }
    return solids;
  }

  function tierOfPart(part) {
    if (part.producer === null) {
      return 3;
    }
    if (part.filterArgs !== null) {
      return /[0-9]/.test(part.filterArgs) ? 2 : 1;
    }
    if (part.indices !== null) {
      return 4;
    }
    return 0;
  }

  const totals = emptyTotals();
  const perFile = [];
  const failures = [];

  for (const examplePath of files) {
    const slug = basename(examplePath, '.js');
    const tmpFile = join(tmpDir, `${slug}.fluid.js`);
    writeFileSync(tmpFile, readFileSync(examplePath, 'utf8'));

    const fileStats = {
      file: slug,
      edges: 0,
      tiers: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
      refused: 0,
      unattributed: 0,
      lineage: 0,
      ms: 0,
    };
    const started = Date.now();

    try {
      getSceneManager().startScene();
      setCurrentFile(tmpFile);
      const mod = await import(pathToFileURL(tmpFile));
      for (const value of Object.values(mod)) {
        if (typeof value === 'function') {
          await value();
        }
      }
      const scene = renderer.render(getCurrentScene());
      const solids = findSolids(scene);
      if (solids.length === 0) {
        totals.files.noSolids++;
        console.log(`— ${slug}: no solids (sketch-only)`);
        continue;
      }

      for (const solid of solids) {
        const edgeCount = Explorer.findEdgesWrapped(solid).length;
        let indices = Array.from({ length: edgeCount }, (_, i) => i);
        if (indices.length > maxEdgesPerSolid) {
          totals.truncated += indices.length - maxEdgesPerSolid;
          console.log(`  ! ${slug}: solid has ${indices.length} edges, sampling first ${maxEdgesPerSolid}`);
          indices = indices.slice(0, maxEdgesPerSolid);
        }
        const refs = indices.map(index => ({ shapeId: solid.id, sub: { type: 'edge', index } }));

        const explained = explainSelection(scene, refs);
        for (const pick of explained.picks) {
          totals.edges++;
          fileStats.edges++;
          if (pick.attributed) {
            totals.attribution.direct++;
          } else if (pick.lineage !== undefined) {
            totals.attribution.lineage++;
            fileStats.lineage++;
          } else {
            totals.attribution.unattributed++;
            fileStats.unattributed++;
          }
          if (pick.producer?.sharedCallSite) {
            totals.sharedCallSite++;
          }
          if (pick.producer?.isClone) {
            totals.clones++;
          }
        }

        for (const ref of refs) {
          const synthesis = synthesizeApplyFeature(scene, [ref], 'fillet', 1);
          if (synthesis.ok === true) {
            const tier = Math.max(...synthesis.spec.parts.map(tierOfPart));
            totals.tiers[tier]++;
            fileStats.tiers[tier]++;
            totals.alternatives += synthesis.alternatives.length;
          } else {
            totals.refusals[synthesis.reason] = (totals.refusals[synthesis.reason] ?? 0) + 1;
            fileStats.refused++;
          }
        }
      }

      totals.files.ok++;
      fileStats.ms = Date.now() - started;
      perFile.push(fileStats);
      const t = fileStats.tiers;
      console.log(
        `✓ ${slug}: ${fileStats.edges} edges — t0:${t[0]} t1:${t[1]} t2:${t[2]} t3:${t[3]} t4:${t[4]}` +
        ` refused:${fileStats.refused} lineage:${fileStats.lineage} unattr:${fileStats.unattributed}` +
        ` (${fileStats.ms}ms)`,
      );
    } catch (error) {
      totals.files.failed++;
      failures.push({ file: slug, error: String(error && error.message ? error.message : error) });
      console.log(`✗ ${slug}: ${error && error.message ? error.message : error}`);
      if (process.env.CORPUS_STACKS) {
        console.log(error && error.stack ? error.stack : '(no stack)');
      }
      // A failed model can leave the OCC wasm state corrupted (observed:
      // stack-overflow → every later plane read throws). Abort this worker;
      // the orchestrator resumes the remaining files in a fresh process.
      return { totals, perFile, failures, processed: files.indexOf(examplePath) + 1, aborted: true };
    }
  }

  return { totals, perFile, failures, processed: files.length, aborted: false };
}

// ---------------------------------------------------------------------------
// Orchestrator: fresh worker process per chunk, bisect crashed chunks
// ---------------------------------------------------------------------------

function spawnWorker(files, outPath) {
  const listPath = join(tmpdir(), `corpus-files-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(listPath, JSON.stringify(files));
  const result = spawnSync(
    process.execPath,
    [selfPath, '--worker', '--files', listPath, '--json', outPath, '--max-edges', String(maxEdgesPerSolid)],
    { stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
  );
  rmSync(listPath, { force: true });
  return result.status === 0;
}

async function runOrchestrator() {
  const examples = collectExamples(join(repoRoot, 'website/docs'))
    .filter(p => (only ? p.includes(only) : true))
    .slice(0, limit);

  const totals = emptyTotals();
  const perFile = [];
  const failures = [];

  const mergeResult = outPath => {
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    mergeTotals(totals, result.totals);
    perFile.push(...result.perFile);
    failures.push(...result.failures);
    return result;
  };

  const outPath = join(tmpdir(), `corpus-chunk-${process.pid}.json`);
  let next = 0;
  while (next < examples.length) {
    const chunk = examples.slice(next, next + chunkSize);
    console.log(`\n--- files ${next + 1}-${next + chunk.length} of ${examples.length} ---`);
    if (spawnWorker(chunk, outPath)) {
      const result = mergeResult(outPath);
      // A worker that failed a file aborts (its wasm state is suspect); the
      // remaining files of the chunk continue in a fresh process.
      next += result.aborted ? result.processed : chunk.length;
      continue;
    }
    // The worker died without writing results (hard wasm crash). Re-run file
    // by file so the crashing model is attributed precisely.
    console.log('worker crashed — bisecting chunk file-by-file');
    for (const file of chunk) {
      if (spawnWorker([file], outPath)) {
        mergeResult(outPath);
      } else {
        totals.files.failed++;
        failures.push({ file: basename(file, '.js'), error: 'crashed the corpus worker process' });
        console.log(`✗ ${basename(file, '.js')}: crashed the corpus worker process`);
      }
    }
    next += chunk.length;
  }
  rmSync(outPath, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });

  const pct = (n, d) => (d === 0 ? '0.0' : ((100 * n) / d).toFixed(1));
  console.log('\n================ corpus summary ================');
  console.log(`files: ${totals.files.ok} ok, ${totals.files.noSolids} sketch-only, ${totals.files.failed} failed`);
  console.log(`edges: ${totals.edges} (${totals.truncated} skipped by --max-edges cap)`);
  console.log(
    `attribution: direct ${pct(totals.attribution.direct, totals.edges)}%` +
    ` | lineage ${pct(totals.attribution.lineage, totals.edges)}%` +
    ` | unattributed ${pct(totals.attribution.unattributed, totals.edges)}%`,
  );
  console.log(`picks on shared call sites: ${totals.sharedCallSite}, on clones: ${totals.clones}`);
  const synthesized = Object.values(totals.tiers).reduce((a, b) => a + b, 0);
  const refused = Object.values(totals.refusals).reduce((a, b) => a + b, 0);
  console.log(`synthesis: ${synthesized} ok, ${refused} refused (${pct(refused, totals.edges)}% of edges)`);
  for (const tier of [0, 1, 2, 3, 4]) {
    console.log(`  tier ${tier}: ${totals.tiers[tier]} (${pct(totals.tiers[tier], synthesized)}%)`);
  }
  console.log(`  avg alternatives per synthesized pick: ${(totals.alternatives / Math.max(1, synthesized)).toFixed(2)}`);
  console.log('refusal reasons:');
  for (const [reason, count] of Object.entries(totals.refusals).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}× ${reason}`);
  }
  if (failures.length > 0) {
    console.log('failed files:');
    for (const f of failures) {
      console.log(`  ${f.file}: ${f.error}`);
    }
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ totals, perFile, failures }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
}

if (isWorker) {
  const files = JSON.parse(readFileSync(workerFiles, 'utf8'));
  const result = await runWorker(files);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(result));
  }
  // The OCC wasm runtime can throw during teardown finalizers; results are
  // already on disk, so exit deliberately rather than risking a bogus crash.
  process.exit(0);
} else {
  await runOrchestrator();
}
