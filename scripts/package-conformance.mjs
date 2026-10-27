#!/usr/bin/env node
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import JSZip from 'jszip';

/**
 * `node scripts/package-conformance.mjs --out <dir> [--no-archives]`: the
 * package format's conformance fixtures (hub-research HD12), written from
 * the compiled server (`npm run build:server` first).
 *
 * - `archives/*.fluidpkg`: one valid package packed by `packPackage` from
 *   `server/tests/fixtures/conformance-workspace` (the H3b layout, with a
 *   `docs/` page and image), one archive per `PackageArchive` refusal, and
 *   hand-made archives FluidCAD's check passes but the hub refuses (its
 *   layout, `docs/` and identity rules). The
 *   package is `@acme/kit` (HD30: the manifest holds the scoped name), with
 *   plain feature ids; the hub's tests upload it at `@acme/kit`;
 * - `expected.json`: each archive's verdict from `PackageArchive.inspect`
 *   (`ok` with its integrity and warnings, or the refusal code), and the
 *   verdict the hub must give (`hub`);
 * - `tree-hash-vectors.json`: `TreeHash.ofFiles` cases;
 * - `source.json`: the FluidCAD version and commit the fixtures came from.
 *
 * Every archive is checked against the verdict it is meant to give: one
 * that doesn't is a broken fixture, and the script fails. The hub vendors
 * the output (its `scripts/conformance-sync.mjs`); FluidCAD keeps
 * `expected.json` and `tree-hash-vectors.json` in
 * `server/tests/fixtures/conformance/`, and
 * `server/tests/packages/conformance.test.ts` regenerates and compares
 * them, so a format change fails until the fixtures are re-exported.
 */
class PackageConformance {
  static REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  static WORKSPACE = path.join(PackageConformance.REPO, 'server', 'tests', 'fixtures', 'conformance-workspace');
  static PRE_LAYOUT = path.join(PackageConformance.REPO, 'server', 'tests', 'fixtures', 'pre-layout', 'acme-kit-0.1.0.fluidpkg');
  static DIST = path.join(PackageConformance.REPO, 'server', 'dist', 'packages');

  /**
   * The engine version the valid archive is packed and inspected as: fixed,
   * so a release bump doesn't change the fixtures. A change of the format
   * itself (the manifest, the tree hash, a refusal) still does.
   */
  static ENGINE = '0.0.46';
  /** The package's name (HD30), which the hub's tests upload it at. */
  static NAME = '@acme/kit';
  static VERSION = '0.1.0';
  /** The handle the hub's tests upload it as: `NAME`'s scope. */
  static SCOPE = 'acme';
  /** The zip format's epoch: hand-made archives are dated like packed ones, so they are reproducible too. */
  static DATE = new Date('1980-01-01T00:00:00.000Z');
  /** `PackageArchive.MAX_ENTRIES`, plus one. */
  static TOO_MANY_ENTRIES = 10_001;

  constructor(out, options) {
    this.out = out;
    this.writeArchives = options.archives;
    this.scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-conformance-'));
  }

  static async main(argv) {
    const args = PackageConformance.parseArgs(argv);
    if (!args.out) {
      console.error('Usage: node scripts/package-conformance.mjs --out <dir> [--no-archives]');
      process.exit(1);
    }
    for (const file of ['package-builder.js', 'package-archive.js', 'tree-hash.js']) {
      if (!fs.existsSync(path.join(PackageConformance.DIST, file))) {
        console.error(`server/dist/packages/${file} is missing: run \`npm run build:server\` first.`);
        process.exit(1);
      }
    }
    const run = new PackageConformance(path.resolve(args.out), { archives: args.archives });
    try {
      await run.write();
    } finally {
      run.dispose();
    }
  }

  static parseArgs(argv) {
    const args = { out: null, archives: true };
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--out') {
        args.out = argv[++i] ?? null;
      } else if (argv[i] === '--no-archives') {
        args.archives = false;
      } else {
        console.error(`Unknown argument ${argv[i]}`);
        process.exit(1);
      }
    }
    return args;
  }

  async write() {
    const { PackageArchive, PackageArchiveError } = await import(pathToFileURL(path.join(PackageConformance.DIST, 'package-archive.js')).href);
    const { TreeHash } = await import(pathToFileURL(path.join(PackageConformance.DIST, 'tree-hash.js')).href);
    this.PackageArchive = PackageArchive;
    this.PackageArchiveError = PackageArchiveError;
    this.TreeHash = TreeHash;

    const valid = await this.packValid();
    const archives = {};
    const bytesByFile = {};
    for (const fixture of this.fixtures(valid)) {
      const bytes = await fixture.build();
      const verdict = await this.inspect(bytes);
      if (verdict.verdict !== fixture.fluidcad) {
        throw new Error(`${fixture.file} is meant to give ${fixture.fluidcad} but PackageArchive.inspect says ${verdict.verdict}.`);
      }
      archives[fixture.file] = { about: fixture.about, ...verdict, hub: fixture.hub };
      bytesByFile[fixture.file] = bytes;
    }

    fs.mkdirSync(this.out, { recursive: true });
    if (this.writeArchives) {
      const dir = path.join(this.out, 'archives');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, bytes] of Object.entries(bytesByFile)) {
        fs.writeFileSync(path.join(dir, file), bytes);
      }
      fs.writeFileSync(path.join(this.out, 'source.json'), PackageConformance.json(this.source()));
    }
    const expected = {
      package: { name: PackageConformance.NAME, version: PackageConformance.VERSION, scope: PackageConformance.SCOPE },
      engineVersion: PackageConformance.ENGINE,
      archives,
    };
    fs.writeFileSync(path.join(this.out, 'expected.json'), PackageConformance.json(expected));
    fs.writeFileSync(path.join(this.out, 'tree-hash-vectors.json'), PackageConformance.json(this.vectors()));
    console.log(`Wrote ${Object.keys(archives).length} conformance archives' verdicts${this.writeArchives ? ' and archives' : ''} to ${this.out}.`);
  }

  dispose() {
    fs.rmSync(this.scratch, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------
  // The valid package
  // ---------------------------------------------------------------------------

  /** `packPackage` over a copy of the conformance workspace: `{ zip, files }`, `files` with `manifest.json`. */
  async packValid() {
    const { packPackage } = await import(pathToFileURL(path.join(PackageConformance.DIST, 'package-builder.js')).href);
    const workspace = path.join(this.scratch, 'kit');
    fs.cpSync(PackageConformance.WORKSPACE, workspace, { recursive: true });
    // The engine logs its scene work to stdout; the fixtures' output is the files.
    const log = console.log;
    console.log = () => {};
    let result;
    try {
      result = await packPackage({ workspacePath: workspace, fluidcadVersion: PackageConformance.ENGINE });
    } finally {
      console.log = log;
    }
    const files = {};
    for (const [rel, bytes] of Object.entries(result.files)) {
      files[rel] = new Uint8Array(bytes);
    }
    return { zip: new Uint8Array(result.zip), files };
  }

  // ---------------------------------------------------------------------------
  // The fixtures
  // ---------------------------------------------------------------------------

  /**
   * Every archive: `fluidcad` is the verdict `PackageArchive.inspect` must
   * give, `hub` the one the hub's validator must give (the same code for
   * every FluidCAD refusal; a hub code where only the hub refuses).
   */
  fixtures(valid) {
    const derived = (edit) => () => this.zip(edit(PackageConformance.copy(valid.files)));
    const withManifest = (edit) => derived((files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      edit(manifest, files);
      files['manifest.json'] = PackageConformance.encode(PackageConformance.json(manifest));
      return files;
    });
    const withRaw = (name, contents, options = {}) => () => this.zip(PackageConformance.copy(valid.files), { raw: { [name]: { contents, ...options } } });
    /** The valid package with one more file, listed in `files`: a hand-made archive of what pack refuses to write. */
    const withFile = (name, contents) => withManifest((m, files) => {
      files[name] = contents;
      m.files = Object.keys(files).filter((f) => f !== 'manifest.json').sort();
    });
    const text = (s) => PackageConformance.encode(s);

    return [
      {
        file: 'valid.fluidpkg',
        about: 'packed by packPackage from conformance-workspace: three features (icons, option images, raw OpenCascade), a part with a parameter, a factory part, an assembly, README, CHANGELOG and LICENSE, and docs/standoff.md with its image docs/images/standoff.svg and a link to ../README.md',
        fluidcad: 'ok', hub: 'ok',
        build: async () => valid.zip,
      },
      // ---- PackageArchive refusals ----
      { file: 'not-a-zip.fluidpkg', about: 'plain text', fluidcad: 'not-a-zip', hub: 'not-a-zip', build: async () => text('This is not a zip archive.\n') },
      { file: 'unsafe-path-parent.fluidpkg', about: 'an entry ../evil.js', fluidcad: 'unsafe-path', hub: 'unsafe-path', build: withRaw('../evil.js', 'export const pwned = 1;\n') },
      { file: 'unsafe-path-nested-parent.fluidpkg', about: 'an entry parts/../../evil.js', fluidcad: 'unsafe-path', hub: 'unsafe-path', build: withRaw('parts/../../evil.js', 'export const pwned = 1;\n') },
      { file: 'unsafe-path-absolute.fluidpkg', about: 'an entry /abs.js', fluidcad: 'unsafe-path', hub: 'unsafe-path', build: withRaw('/abs.js', 'export const pwned = 1;\n') },
      { file: 'unsafe-path-backslash.fluidpkg', about: 'an entry features\\evil.js', fluidcad: 'unsafe-path', hub: 'unsafe-path', build: withRaw('features\\evil.js', 'export const pwned = 1;\n') },
      { file: 'unsafe-path-drive.fluidpkg', about: 'an entry C:/evil.js', fluidcad: 'unsafe-path', hub: 'unsafe-path', build: withRaw('C:/evil.js', 'export const pwned = 1;\n') },
      { file: 'unsafe-path-nul.fluidpkg', about: 'an entry with a NUL in its name', fluidcad: 'unsafe-path', hub: 'unsafe-path', build: withRaw('features/evil\u0000.js', 'export const pwned = 1;\n') },
      {
        file: 'unsafe-path-link.fluidpkg', about: 'a symbolic link entry features/link.js', fluidcad: 'unsafe-path', hub: 'unsafe-path',
        build: withRaw('features/link.js', '../../../etc/passwd', { unixPermissions: 0o120777 }),
      },
      {
        file: 'too-large-entries.fluidpkg', about: `${PackageConformance.TOO_MANY_ENTRIES} entries in all`, fluidcad: 'too-large', hub: 'too-large',
        build: async () => {
          const files = PackageConformance.copy(valid.files);
          const count = PackageConformance.TOO_MANY_ENTRIES - PackageConformance.entryCount(files);
          const raw = {};
          for (let i = 0; i < count; i++) {
            raw[`pad/${String(i).padStart(5, '0')}`] = { contents: '' };
          }
          return this.zip(files, { raw });
        },
      },
      {
        file: 'no-manifest.fluidpkg', about: 'the valid package without manifest.json', fluidcad: 'no-manifest', hub: 'no-manifest',
        build: derived((files) => { delete files['manifest.json']; return files; }),
      },
      {
        file: 'model-archive.fluidpkg', about: "an old model packer's manifest (schemaVersion, no manifestVersion)", fluidcad: 'model-archive', hub: 'model-archive',
        build: derived((files) => { files['manifest.json'] = text(JSON.stringify({ schemaVersion: 3, entry: 'part.fluid.js' })); return files; }),
      },
      { file: 'newer-manifest.fluidpkg', about: 'manifestVersion 2', fluidcad: 'newer-manifest', hub: 'newer-manifest', build: withManifest((m) => { m.manifestVersion = 2; }) },
      {
        file: 'bad-manifest-json.fluidpkg', about: 'manifest.json is not JSON', fluidcad: 'bad-manifest', hub: 'bad-manifest',
        build: derived((files) => { files['manifest.json'] = text('{ "manifestVersion": 1, '); return files; }),
      },
      {
        file: 'bad-manifest-bom.fluidpkg', about: 'manifest.json starts with a byte order mark, which JSON.parse refuses', fluidcad: 'bad-manifest', hub: 'bad-manifest',
        build: derived((files) => { files['manifest.json'] = PackageConformance.concat([new Uint8Array([0xef, 0xbb, 0xbf]), files['manifest.json']]); return files; }),
      },
      { file: 'bad-manifest-name.fluidpkg', about: 'name "@acme/3d-kit" (the name part starts with a digit)', fluidcad: 'bad-manifest', hub: 'bad-manifest', build: withManifest((m) => { m.name = '@acme/3d-kit'; }) },
      {
        file: 'bad-manifest-scope.fluidpkg', about: 'name "@3dtools/kit" (the scope starts with a digit, which the pre-H8c grammar accepted)', fluidcad: 'bad-manifest', hub: 'bad-manifest',
        build: withManifest((m) => { m.name = '@3dtools/kit'; }),
      },
      {
        file: 'bare-name.fluidpkg', about: 'name "kit", without a scope: packed under HD29; refused, never converted', fluidcad: 'bad-manifest', hub: 'bad-manifest',
        build: withManifest((m) => { m.name = 'kit'; }),
      },
      { file: 'bad-manifest-version.fluidpkg', about: 'version "1.0"', fluidcad: 'bad-manifest', hub: 'bad-manifest', build: withManifest((m) => { m.version = '1.0'; }) },
      { file: 'bad-manifest-sdk.fluidpkg', about: 'sdkVersion "1" (a string)', fluidcad: 'bad-manifest', hub: 'bad-manifest', build: withManifest((m) => { m.sdkVersion = '1'; }) },
      { file: 'bad-manifest-parts.fluidpkg', about: 'no "parts" list', fluidcad: 'bad-manifest', hub: 'bad-manifest', build: withManifest((m) => { delete m.parts; }) },
      { file: 'files-mismatch-unlisted.fluidpkg', about: 'parts/extra.js is in the archive but not in files', fluidcad: 'files-mismatch', hub: 'files-mismatch', build: withRaw('parts/extra.js', 'export const extra = 1;\n') },
      { file: 'files-mismatch-missing.fluidpkg', about: 'files lists parts/missing.js, which is not in the archive', fluidcad: 'files-mismatch', hub: 'files-mismatch', build: withManifest((m) => { m.files = [...m.files, 'parts/missing.js'].sort(); }) },
      {
        file: 'files-mismatch-no-entry.fluidpkg', about: 'no index.js, in the archive or in files', fluidcad: 'files-mismatch', hub: 'files-mismatch',
        build: withManifest((m, files) => { delete files['index.js']; m.files = m.files.filter((f) => f !== 'index.js'); }),
      },
      {
        file: 'blocked-import-static.fluidpkg', about: "parts/helpers/sizes.js imports 'child_process'", fluidcad: 'blocked-import', hub: 'blocked-import',
        build: derived((files) => {
          files['parts/helpers/sizes.js'] = text("import { execSync } from 'child_process';\n" + new TextDecoder().decode(files['parts/helpers/sizes.js']));
          return files;
        }),
      },
      {
        file: 'blocked-import-dynamic.fluidpkg', about: "features/standoff.feature.js runs import('node:fs')", fluidcad: 'blocked-import', hub: 'blocked-import',
        build: derived((files) => {
          files['features/standoff.feature.js'] = text(new TextDecoder().decode(files['features/standoff.feature.js']) + "\nexport const leak = () => import('node:fs');\n");
          return files;
        }),
      },
      // ---- FluidCAD's archive check passes, but the hub refuses ----
      {
        file: 'scope-mismatch.fluidpkg', about: 'name "@other/kit": another scope than the URL\'s (@acme/kit)', fluidcad: 'ok', hub: 'scope-mismatch',
        build: withManifest((m) => { m.name = '@other/kit'; }),
      },
      {
        file: 'no-models.fluidpkg', about: 'features only: no part and no assembly', fluidcad: 'ok', hub: 'no-models',
        build: withManifest((m, files) => {
          for (const rel of Object.keys(files)) {
            if (rel.startsWith('parts/') || rel.startsWith('assemblies/')) {
              delete files[rel];
            }
          }
          m.parts = [];
          m.contents = ['features'];
          m.fileUnits = {};
          files['index.js'] = text(PackageConformance.entrySource(m));
          m.files = Object.keys(files).filter((f) => f !== 'manifest.json').sort();
        }),
      },
      {
        file: 'outside-layout.fluidpkg', about: 'parts/helpers/sizes.js imports lib/units.js, a script at the root outside the three folders', fluidcad: 'ok', hub: 'outside-layout',
        build: withManifest((m, files) => {
          files['lib/units.js'] = text('// Outside features/, parts/ and assemblies/.\nexport const INCH = 25.4;\n');
          files['parts/helpers/sizes.js'] = text("import { INCH } from '../../lib/units.js';\n" + new TextDecoder().decode(files['parts/helpers/sizes.js']));
          m.files = Object.keys(files).filter((f) => f !== 'manifest.json').sort();
        }),
      },
      {
        file: 'wrong-folder.fluidpkg', about: 'the washer part moved into features/ (features/washer.part.js)', fluidcad: 'ok', hub: 'wrong-folder',
        build: withManifest((m, files) => {
          files['features/washer.part.js'] = files['parts/washer.part.js'];
          delete files['parts/washer.part.js'];
          m.parts.find((p) => p.exportName === 'washer').module = 'features/washer.part.js';
          files['index.js'] = text(PackageConformance.entrySource(m));
          m.files = Object.keys(files).filter((f) => f !== 'manifest.json').sort();
        }),
      },
      {
        file: 'bad-params.fluidpkg', about: 'the spacer part declares 101 parameters, one over the cap', fluidcad: 'ok', hub: 'bad-params',
        build: withManifest((m) => {
          const spacer = m.parts.find((p) => p.exportName === 'spacer');
          for (let i = spacer.params.length; i < 101; i++) {
            spacer.params.push({ label: `Extra ${i}`, defaultValue: i, currentValue: i, controlType: 'number' });
          }
        }),
      },
      {
        file: 'pre-layout.fluidpkg', about: 'packed before the package layout (server/tests/fixtures/pre-layout): modules at the root', fluidcad: 'ok', hub: 'outside-layout',
        build: async () => new Uint8Array(fs.readFileSync(PackageConformance.PRE_LAYOUT)),
      },
      // ---- docs/ (package-docs DOC6): optional; pack refuses these, FluidCAD installs them, the hub refuses them ----
      {
        file: 'no-docs.fluidpkg', about: 'the valid package without its docs/ folder: what pack writes for a workspace with no docs/, as before docs/ shipped', fluidcad: 'ok', hub: 'ok',
        build: withManifest((m, files) => {
          for (const rel of Object.keys(files)) {
            if (rel.startsWith('docs/')) {
              delete files[rel];
            }
          }
          m.files = Object.keys(files).filter((f) => f !== 'manifest.json').sort();
        }),
      },
      {
        file: 'docs-file.fluidpkg', about: 'docs/cad/standoff.zip: a file docs/ can\'t hold (markdown pages and their images only)', fluidcad: 'ok', hub: 'docs-file',
        build: withFile('docs/cad/standoff.zip', PackageConformance.concat([new Uint8Array([0x50, 0x4b, 0x05, 0x06]), new Uint8Array(18)])),
      },
      {
        file: 'docs-too-large.fluidpkg', about: 'docs/huge.md: a 300 KB page, over the 256 KB cap', fluidcad: 'ok', hub: 'docs-too-large',
        build: withFile('docs/huge.md', text(`# Huge\n${'a'.repeat(300 * 1024 - 7)}`)),
      },
      {
        file: 'outside-layout-docs.fluidpkg', about: 'docs/examples/run.js: a script in docs/, which is not one of the three folders', fluidcad: 'ok', hub: 'outside-layout',
        build: withFile('docs/examples/run.js', text('export const run = () => 1;\n')),
      },
    ];
  }

  /** `PackageArchive.inspect`'s verdict: `{ verdict: 'ok', integrity, warnings }` or `{ verdict: <code> }`. */
  async inspect(bytes) {
    const root = path.join(this.scratch, 'library');
    fs.mkdirSync(root, { recursive: true });
    try {
      const inspection = await this.PackageArchive.inspect(bytes, { root, engineVersion: PackageConformance.ENGINE });
      this.PackageArchive.discard(inspection.token);
      return { verdict: 'ok', integrity: inspection.integrity, warnings: inspection.warnings };
    } catch (err) {
      if (err instanceof this.PackageArchiveError) {
        return { verdict: err.code };
      }
      throw err;
    }
  }

  /**
   * A hand-made archive of `files` (path → bytes), deflated and dated like a
   * packed one, folder entries included; `raw` entries are added as named,
   * after the files (hostile paths, links, padding).
   */
  async zip(files, options = {}) {
    const zip = new JSZip();
    const date = PackageConformance.DATE;
    const folders = new Set();
    for (const rel of Object.keys(files).sort()) {
      const parts = rel.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const folder = parts.slice(0, i).join('/') + '/';
        if (!folders.has(folder)) {
          folders.add(folder);
          zip.file(folder, null, { dir: true, date, createFolders: false });
        }
      }
      zip.file(rel, files[rel], { date, createFolders: false });
    }
    for (const [rel, entry] of Object.entries(options.raw ?? {})) {
      zip.file(rel, entry.contents, { date, createFolders: false, ...(entry.unixPermissions !== undefined ? { unixPermissions: entry.unixPermissions } : {}) });
    }
    const hasUnix = Object.values(options.raw ?? {}).some((entry) => entry.unixPermissions !== undefined);
    const bytes = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      ...(hasUnix ? { platform: 'UNIX' } : {}),
    });
    return bytes;
  }

  // ---------------------------------------------------------------------------
  // Tree-hash vectors
  // ---------------------------------------------------------------------------

  vectors() {
    const enc = (s) => PackageConformance.encode(s);
    const all = new Uint8Array(256).map((_, i) => i);
    const cases = [
      { name: 'empty tree', files: [] },
      { name: 'one empty file', files: [{ path: 'empty.txt', bytes: new Uint8Array(0) }] },
      {
        name: 'unicode paths (UTF-8 bytes, NFC as written)',
        files: [
          { path: 'features/größe-ø.svg', bytes: enc('<svg/>') },
          { path: 'parts/日本/部品.part.js', bytes: enc('export const p = 1;\n') },
          { path: 'é.js', bytes: enc('') },
        ],
      },
      {
        name: 'byte order of paths, not locale order',
        files: ['é.js', 'ab.js', 'a/b.js', 'a.b.js', 'a-b.js', 'Z/z.js', 'B.js', 'a_b.js'].map((p) => ({ path: p, bytes: enc(p) })),
      },
      { name: 'binary content: every byte value', files: [{ path: 'bytes.bin', bytes: all }] },
      { name: 'line endings are content', files: [{ path: 'crlf.txt', bytes: enc('a\r\nb\r\n') }, { path: 'lf.txt', bytes: enc('a\nb\n') }] },
    ];
    return {
      about: 'TreeHash.ofFiles: Go dirhash over sha256 — each file\'s sha256 in hex, two spaces, its path, one line per file in byte order of the UTF-8 paths, and the sha256 of those lines, written sha256-<base64>.',
      cases: cases.map((c) => ({
        name: c.name,
        files: c.files.map((f) => ({ path: f.path, base64: Buffer.from(f.bytes).toString('base64') })),
        integrity: this.TreeHash.ofFiles(c.files.map((f) => ({ path: f.path, bytes: f.bytes }))),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  source() {
    const pkg = JSON.parse(fs.readFileSync(path.join(PackageConformance.REPO, 'package.json'), 'utf8'));
    return {
      fluidcadVersion: pkg.version,
      commit: PackageConformance.git(['rev-parse', 'HEAD']),
      dirty: PackageConformance.git(['status', '--porcelain']) !== '',
      generatedBy: 'scripts/package-conformance.mjs',
    };
  }

  static git(args) {
    try {
      return execFileSync('git', args, { cwd: PackageConformance.REPO, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  /** `index.js` as pack writes it, for a manifest whose modules a fixture moved. */
  static entrySource(manifest) {
    const byModule = new Map();
    for (const { module, exportName } of [...manifest.features, ...manifest.parts]) {
      byModule.set(module, [...(byModule.get(module) ?? []), exportName]);
    }
    const lines = [...byModule.keys()].sort().map((module) => `export { ${byModule.get(module).sort().join(', ')} } from ${JSON.stringify(`./${module}`)};`);
    return [`// Generated by \`fluidcad pack\`: every feature, part and assembly ${manifest.name} exports, by name.`, ...lines, ''].join('\n');
  }

  /** The entries a zip of `files` holds: the files and their folders. */
  static entryCount(files) {
    const folders = new Set();
    for (const rel of Object.keys(files)) {
      const parts = rel.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        folders.add(parts.slice(0, i).join('/'));
      }
    }
    return Object.keys(files).length + folders.size;
  }

  static copy(files) {
    return Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [rel, new Uint8Array(bytes)]));
  }

  static encode(text) {
    return new TextEncoder().encode(text);
  }

  static concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  static json(value) {
    return JSON.stringify(value, null, 2) + '\n';
  }
}

PackageConformance.main(process.argv.slice(2)).then(
  () => process.exit(0),
  (err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  },
);
