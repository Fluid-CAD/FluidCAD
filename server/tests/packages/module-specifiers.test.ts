import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ModuleSpecifiers } from '../../src/files/module-specifiers.ts';
import { specifierReaches } from '../../src/declaration-usages.ts';
import { PackageManifests } from '../../src/packages/package-manifests.ts';
import { PackageProject } from './package-project.ts';

// Stage P6: one answer to "which specifier reaches module M from file F",
// and the reverse. A workspace module is reached by a relative path, an
// installed package's module by the package's bare name (only for a name
// its entry exports, at the version the project pins), the engine's own
// builders by `fluidcad/core`. The reverse of a bare name goes through the
// project's pins, never the library alone (K7).

let project: PackageProject;
let model: string;

beforeEach(() => {
  project = new PackageProject('fluidcad-module-specifiers-');
  model = project.at('parts/model.part.js');
  PackageManifests.forget();
});

afterEach(() => {
  project.dispose();
});

describe('which specifier reaches a module', () => {
  it('writes a relative path for a workspace module, and the core for a built-in', () => {
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.specifierFor(model, project.at('standoff.feature.js'), 'standoff')).toBe('../standoff.feature.js');
    expect(specifiers.specifierFor(model, project.at('parts/bolt.feature.js'), 'bolt')).toBe('./bolt.feature.js');
    expect(specifiers.specifierFor(model, 'fluidcad/core', 'draft')).toBe('fluidcad/core');
    expect(specifiers.specifierFor(model, 'fluidcad', 'draft')).toBe('fluidcad/core');
  });

  it('writes the bare name for a module the package entry exports the name from, pinned or not', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.specifierFor(model, `${dir}/standoff.feature.js`, 'standoff')).toBe('@acme/kit');
    expect(specifiers.specifierFor(model, `${dir}/parts/spacer.part.js`, 'spacer')).toBe('@acme/kit');
    expect(specifiers.unreachableReason(`${dir}/standoff.feature.js`, 'standoff')).toBeNull();
  });

  it('refuses a name the entry does not export, and a helper module, with a sentence', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.specifierFor(model, `${dir}/standoff.feature.js`, 'spacer')).toBeNull();
    expect(specifiers.specifierFor(model, `${dir}/helpers/sizes.js`, 'SPACER_LENGTH')).toBeNull();
    expect(specifiers.unreachableReason(`${dir}/helpers/sizes.js`, 'SPACER_LENGTH'))
      .toBe("`@acme/kit` 0.1.0 doesn't export `SPACER_LENGTH` from helpers/sizes.js, so it can't be imported by the package's name.");
  });

  it('refuses a version other than the pinned one, since the bare name would load the pinned one', async () => {
    const pinned = await project.install('@acme/kit', '0.1.0');
    const other = await project.install('@acme/kit', '0.2.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity: pinned.integrity } });
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.specifierFor(model, `${pinned.dir}/standoff.feature.js`, 'standoff')).toBe('@acme/kit');
    expect(specifiers.specifierFor(model, `${other.dir}/standoff.feature.js`, 'standoff')).toBeNull();
    expect(specifiers.unreachableReason(`${other.dir}/standoff.feature.js`, 'standoff'))
      .toBe("This project uses `@acme/kit` 0.1.0, not 0.2.0; switching the version it pins isn't supported yet.");
  });

  it('treats a project copy like the library, and a fork in vendor/ as workspace code', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0', { target: 'project' });
    project.config(null);
    fs.cpSync(dir, project.at('vendor/kit'), { recursive: true });
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.specifierFor(model, `${dir}/standoff.feature.js`, 'standoff')).toBe('@acme/kit');
    expect(specifiers.specifierFor(model, project.at('vendor/kit/standoff.feature.js'), 'standoff')).toBe('../vendor/kit/standoff.feature.js');
  });

  it('knows no packages without a project', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0');
    expect(ModuleSpecifiers.LOCAL.specifierFor(model, `${dir}/standoff.feature.js`, 'standoff')).toMatch(/^\.\.\//);
    expect(ModuleSpecifiers.LOCAL.moduleOf('@acme/kit', model, 'standoff')).toBeNull();
  });
});

describe('which module a specifier names', () => {
  it('resolves relative paths as written, and both spellings of the core', () => {
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.moduleOf('../standoff.feature.js', model)).toEqual({ kind: 'workspace', path: project.at('standoff.feature.js') });
    expect(specifiers.moduleOf('./sub/../bolt.feature.js', model)).toEqual({ kind: 'workspace', path: project.at('parts/bolt.feature.js') });
    expect(specifiers.moduleOf('fluidcad/core', model)).toEqual({ kind: 'built-in' });
    expect(specifiers.moduleOf('fluidcad', model)).toEqual({ kind: 'built-in' });
    expect(specifiers.moduleOf('lodash', model)).toBeNull();
  });

  it('follows a pinned bare name to the module the imported name is declared in', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    const specifiers = new ModuleSpecifiers(project.root);
    const feature = specifiers.moduleOf('@acme/kit', model, 'standoff');
    expect(feature).toMatchObject({ kind: 'package', path: `${dir}/standoff.feature.js`, package: { name: '@acme/kit', version: '0.1.0', target: 'library' } });
    expect(specifiers.moduleOf('@acme/kit', model, 'spacer')).toMatchObject({ kind: 'package', path: `${dir}/parts/spacer.part.js` });
    expect(specifiers.moduleOf('@acme/kit', model)).toMatchObject({ kind: 'package', path: `${dir}/index.js` });
    // A name the entry doesn't export names nothing.
    expect(specifiers.moduleOf('@acme/kit', model, 'SPACER_LENGTH')).toBeNull();
  });

  it('names nothing for a package the project does not pin, or cannot load', async () => {
    const { integrity } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    expect(new ModuleSpecifiers(project.root).moduleOf('@acme/kit', model, 'standoff')).toBeNull();
    // Pinned with another hash: the render refuses it, so no catalog follows it either.
    project.config({ '@acme/kit': { version: '0.1.0', integrity: integrity.replace(/.=$/, 'A=') } });
    expect(new ModuleSpecifiers(project.root).moduleOf('@acme/kit', model, 'standoff')).toBeNull();
    // Pinned but installed nowhere.
    project.config({ '@acme/kit': { version: '0.3.0', integrity } });
    expect(new ModuleSpecifiers(project.root).moduleOf('@acme/kit', model, 'standoff')).toBeNull();
  });

  it('reads the pins once per instance, so a fresh one sees a pin written a moment ago', async () => {
    const { integrity } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const before = new ModuleSpecifiers(project.root);
    expect(before.moduleOf('@acme/kit', model, 'standoff')).toBeNull();
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    expect(new ModuleSpecifiers(project.root).moduleOf('@acme/kit', model, 'standoff')).not.toBeNull();
  });
});

describe('whether a specifier reaches a file', () => {
  it('reaches a workspace file with or without its .js, and nothing through a bare name it does not pin', () => {
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.reaches(model, './bracket.part.js', project.at('parts/bracket.part.js'))).toBe(true);
    expect(specifiers.reaches(model, './bracket.part', project.at('parts/bracket.part.js'))).toBe(true);
    expect(specifiers.reaches(model, './bracket', project.at('parts/bracket.part.js'))).toBe(false);
    expect(specifiers.reaches(model, '@acme/kit', project.at('parts/bracket.part.js'))).toBe(false);
    // The free function keeps the rule, workspace-only by default.
    expect(specifierReaches(model, './bracket.part', project.at('parts/bracket.part.js'))).toBe(true);
    expect(specifierReaches(model, '@acme/kit', project.at('parts/bracket.part.js'))).toBe(false);
  });

  it('reaches a pinned package module through the bare name, by the name imported or any it exports', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    const specifiers = new ModuleSpecifiers(project.root);
    expect(specifiers.reaches(model, '@acme/kit', `${dir}/parts/spacer.part.js`, 'spacer')).toBe(true);
    expect(specifiers.reaches(model, '@acme/kit', `${dir}/parts/spacer.part.js`, 'standoff')).toBe(false);
    expect(specifiers.reaches(model, '@acme/kit', `${dir}/parts/spacer.part.js`)).toBe(true);
    expect(specifiers.reaches(model, '@acme/kit', `${dir}/helpers/sizes.js`)).toBe(false);
    expect(specifierReaches(model, '@acme/kit', `${dir}/parts/spacer.part.js`, specifiers)).toBe(true);
  });
});

describe('two specifiers naming one module', () => {
  it('compares relative paths by the file, the core by either spelling, and bare names by name', () => {
    const file = path.posix.join('/ws', 'parts', 'model.part.js');
    expect(ModuleSpecifiers.sameModule('./sub/../a.feature.js', './a.feature.js', file)).toBe(true);
    expect(ModuleSpecifiers.sameModule('../parts/a.feature.js', './a.feature.js', file)).toBe(true);
    expect(ModuleSpecifiers.sameModule('fluidcad', 'fluidcad/core', file)).toBe(true);
    expect(ModuleSpecifiers.sameModule('@acme/kit', '@acme/kit', file)).toBe(true);
    expect(ModuleSpecifiers.sameModule('@acme/kit', '@acme/other', file)).toBe(false);
    expect(ModuleSpecifiers.sameModule('@acme/kit', './kit.js', file)).toBe(false);
    expect(ModuleSpecifiers.sameModule('fluidcad/core', '@acme/kit', file)).toBe(false);
  });
});
