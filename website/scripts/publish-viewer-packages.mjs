#!/usr/bin/env node

// Packs docs examples into .fluidpkg archives and uploads them to the viewer's
// package store (the fluidcad-viewer-packages R2 bucket, served by the viewer
// at /m/<id>), so a tutorial page can embed a step with
// `<ViewerEmbed packageId={...} />` — including multi-file assemblies, which
// the URL-fragment link cannot carry.
//
// Usage:
//   node website/scripts/publish-viewer-packages.mjs                # every spec under docs/
//   node website/scripts/publish-viewer-packages.mjs getting-started # specs whose path matches
//   node website/scripts/publish-viewer-packages.mjs --dry-run       # pack + hash, no upload
//   node website/scripts/publish-viewer-packages.mjs --force         # re-upload even if present
//
// How it works:
//   1. Finds every `_examples/viewer-packages.json` under website/docs/. Each
//      is a map of key → { entry, as?, name, id? }: `entry` is the example
//      file, `as` the file name the reader knows it by (the entry is renamed
//      in the package; relative imports are staged unchanged), `name` the
//      package's display name.
//   2. Stages the entry plus its transitive `./x.js` imports in a temp
//      workspace (screenshot directives stripped), packs it with the same
//      packer as `npx fluidcad pack`, pinned to this repo's fluidcad version.
//   3. The package id is a hash of the staged sources + version, so an
//      unchanged example maps to the same id run after run; an id already in
//      the store (HEAD 200) is skipped unless --force.
//   4. Uploads through wrangler from the viewer repo checkout (../FluidCAD-Viewer,
//      or $FLUIDCAD_VIEWER_REPO), then writes the id back into the spec file.
//
// Prerequisites: `npm run build` in the repo root (the packer lives in
// server/dist) and a wrangler login with R2 write access in the viewer repo.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const DOCS_ROOT = resolve(__dirname, '..', 'docs');
const VIEWER_REPO = process.env.FLUIDCAD_VIEWER_REPO ?? resolve(ROOT, '..', 'FluidCAD-Viewer');
const VIEWER_URL = process.env.FLUIDCAD_VIEWER_URL ?? 'https://viewer.fluidcad.io';
const BUCKET = 'fluidcad-viewer-packages';
const SPEC_NAME = 'viewer-packages.json';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const filters = args.filter((a) => !a.startsWith('--'));

const fluidcadVersion = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
const packerPath = resolve(ROOT, 'server/dist/model-package/pack.js');
if (!existsSync(packerPath)) {
  console.error(`Packer not built: ${packerPath}. Run \`npm run build\` in the repo root first.`);
  process.exit(1);
}
const { packModel } = await import(packerPath);

function findSpecs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        findSpecs(full, out);
      }
    } else if (entry.name === SPEC_NAME && basename(dir) === '_examples') {
      out.push(full);
    }
  }
  return out;
}

const stripDirectives = (source) => source.replace(/^\/\/ @screenshot.*\r?\n/gm, '');

/** Entry + transitive relative imports, as { fileName → source }. */
function collectSources(examplesDir, entryFile, as) {
  const files = new Map();
  const visit = (fileName, storeAs) => {
    if (files.has(storeAs)) {
      return;
    }
    const full = join(examplesDir, fileName);
    if (!existsSync(full)) {
      throw new Error(`${fileName} not found in ${relative(ROOT, examplesDir)}`);
    }
    const source = stripDirectives(readFileSync(full, 'utf8'));
    files.set(storeAs, source);
    for (const match of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
      const dep = match[1].slice(2);
      visit(dep, dep);
    }
  };
  visit(entryFile, as ?? entryFile);
  return files;
}

function stableId(files, name) {
  const hash = createHash('sha256');
  hash.update(`fluidcad@${fluidcadVersion}\n`);
  hash.update(`name=${name}\n`);
  for (const fileName of [...files.keys()].sort()) {
    hash.update(`${fileName}\n${files.get(fileName)}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

async function isPublished(key) {
  const res = await fetch(`${VIEWER_URL}/pkg/${key}`, { method: 'HEAD' }).catch(() => null);
  return res?.status === 200;
}

function upload(key, filePath) {
  if (!existsSync(join(VIEWER_REPO, 'wrangler.toml'))) {
    throw new Error(`Viewer repo not found at ${VIEWER_REPO} (set FLUIDCAD_VIEWER_REPO)`);
  }
  execFileSync(
    'npx',
    ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', filePath, '--content-type', 'application/zip', '--remote'],
    { stdio: ['ignore', 'inherit', 'inherit'], cwd: VIEWER_REPO },
  );
}

const specs = findSpecs(DOCS_ROOT).filter(
  (p) => filters.length === 0 || filters.some((f) => relative(DOCS_ROOT, p).includes(f)),
);
if (specs.length === 0) {
  console.error('No viewer-packages.json specs matched.');
  process.exit(1);
}

const stagingRoot = mkdtempSync(join(tmpdir(), 'fluidcad-viewer-packages-'));
let uploaded = 0;
let skipped = 0;
try {
  for (const specPath of specs) {
    const examplesDir = dirname(specPath);
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    console.log(`\n${relative(DOCS_ROOT, specPath)} (${Object.keys(spec).length} packages, fluidcad ${fluidcadVersion})`);

    for (const [key, item] of Object.entries(spec)) {
      const entryAs = item.as ?? item.entry;
      const files = collectSources(examplesDir, item.entry, entryAs);
      const name = item.name ?? key;
      const id = stableId(files, name);

      const workspace = join(stagingRoot, key);
      mkdirSync(workspace, { recursive: true });
      for (const [fileName, source] of files) {
        writeFileSync(join(workspace, fileName), source);
      }
      const { zip, manifest } = await packModel({
        entryPath: join(workspace, entryAs),
        workspacePath: workspace,
        fluidcadVersion,
        name,
        unit: 'mm',
      });
      const pkgPath = join(stagingRoot, `${id}.fluidpkg`);
      writeFileSync(pkgPath, zip);

      const fileList = manifest.files?.join(', ') ?? entryAs;
      const objectKey = `${id}.fluidpkg`;
      if (dryRun) {
        console.log(`  ${key}: ${id} (${zip.length} B; ${fileList}) — dry run`);
      } else if (!force && (await isPublished(objectKey))) {
        console.log(`  ${key}: ${id} already in the store (${fileList})`);
        skipped++;
      } else {
        console.log(`  ${key}: ${id} uploading (${zip.length} B; ${fileList})`);
        upload(objectKey, pkgPath);
        uploaded++;
      }
      item.id = id;
    }

    if (!dryRun) {
      writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    }
  }
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}

console.log(`\nDone: ${uploaded} uploaded, ${skipped} already present${dryRun ? ' (dry run, spec not updated)' : ''}.`);
