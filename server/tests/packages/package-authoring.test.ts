import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PackageAuthoring, PackageAuthoringError } from '../../src/packages/package-authoring.ts';
import { PROJECT_CONFIG_FILENAME, readProjectConfig } from '../../src/project-config.ts';

let workspace: string;

function write(rel: string, contents = ''): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function writeConfig(value: unknown): void {
  write(PROJECT_CONFIG_FILENAME, JSON.stringify(value, null, 2) + '\n');
}

function readStored(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'));
}

async function refusal(run: () => unknown): Promise<PackageAuthoringError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(PackageAuthoringError);
    return err as PackageAuthoringError;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-package-authoring-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('PackageAuthoring.init', () => {
  it('writes name, version 0.1.0 and every feature module as exports, keeping the rest of the file', async () => {
    writeConfig({ engine: '0.0.46', unit: 'in', materials: { pine: { name: 'Pine', density: 0.5 } } });
    write('init.js');
    write('standoff.feature.js');
    write('features/boss.feature.js');
    write('plate.part.js');
    write('helpers/sizes.js');
    write('node_modules/other/x.feature.js');
    write('.hidden/y.feature.js');
    write('ignored/z.feature.js');
    write('.gitignore', 'ignored/\n');

    const { info, configPath } = await PackageAuthoring.init(workspace, '@acme/demo');

    expect(configPath).toBe(path.join(workspace, PROJECT_CONFIG_FILENAME));
    expect(info).toEqual({
      name: '@acme/demo',
      version: '0.1.0',
      exports: ['features/boss.feature.js', 'standoff.feature.js'],
    });
    expect(readStored()).toEqual({
      engine: '0.0.46',
      unit: 'in',
      materials: { pine: { name: 'Pine', density: 0.5 } },
      package: info,
    });
    expect(readProjectConfig(workspace).package).toEqual(info);
  });

  it('writes an empty exports list in a workspace with no feature modules', async () => {
    writeConfig({ engine: '0.0.46' });
    write('plate.part.js');

    const { info } = await PackageAuthoring.init(workspace, '@acme/parts');

    expect(info.exports).toEqual([]);
    expect(readProjectConfig(workspace).package?.exports).toEqual([]);
  });

  it('leaves out the feature modules of an installed project copy of another package', async () => {
    writeConfig({ engine: '0.0.46' });
    write('mine.feature.js');
    write('packages/@acme/kit/0.1.0/manifest.json', '{}');
    write('packages/@acme/kit/0.1.0/standoff.feature.js');
    // The user's own models under packages/ stay ordinary workspace code.
    write('packages/brackets/bracket.feature.js');
    write('packages/@acme/draft/0.1.0/draft.feature.js');

    const { info } = await PackageAuthoring.init(workspace, '@acme/demo');

    expect(info.exports).toEqual([
      'mine.feature.js',
      'packages/@acme/draft/0.1.0/draft.feature.js',
      'packages/brackets/bracket.feature.js',
    ]);
  });

  it('works in a workspace pinned through init.js alone, creating fluidcad.json', async () => {
    write('init.js');

    await PackageAuthoring.init(workspace, '@acme/demo');

    expect(readStored()).toEqual({ package: { name: '@acme/demo', version: '0.1.0', exports: [] } });
  });

  it.each(['demo', '@Acme/demo', '@acme/demo_x', '@acme/', ''])('refuses the name %j', async (name) => {
    writeConfig({ engine: '0.0.46' });

    const err = await refusal(() => PackageAuthoring.init(workspace, name));

    expect(err.message).toContain('is not a package name');
    expect(readStored()).toEqual({ engine: '0.0.46' });
  });

  it('refuses a directory that is not a workspace', async () => {
    const err = await refusal(() => PackageAuthoring.init(workspace, '@acme/demo'));

    expect(err.message).toContain('not a FluidCAD workspace');
    expect(fs.existsSync(path.join(workspace, PROJECT_CONFIG_FILENAME))).toBe(false);
  });

  it('refuses a workspace that is already a package, keeping its identity', async () => {
    const existing = { name: '@acme/demo', version: '1.4.0', exports: [] };
    writeConfig({ engine: '0.0.46', package: existing });

    const err = await refusal(() => PackageAuthoring.init(workspace, '@acme/other'));

    expect(err.message).toContain('already the package @acme/demo 1.4.0');
    expect(readStored().package).toEqual(existing);
  });

  it('refuses a workspace whose package block is broken, naming the problem', async () => {
    writeConfig({ engine: '0.0.46', package: { name: '@acme/demo', version: 'one' } });

    const err = await refusal(() => PackageAuthoring.init(workspace, '@acme/demo'));

    expect(err.message).toContain('"version" "one"');
    expect(readStored().package).toEqual({ name: '@acme/demo', version: 'one' });
  });

  it('refuses a fluidcad.json that is not JSON instead of overwriting it', async () => {
    write(PROJECT_CONFIG_FILENAME, '{ "engine": "0.0.46", ');

    const err = await refusal(() => PackageAuthoring.init(workspace, '@acme/demo'));

    expect(err.message).toContain('not valid JSON');
    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8')).toBe('{ "engine": "0.0.46", ');
  });
});

describe('PackageAuthoring.bumpVersion', () => {
  const BLOCK = {
    name: '@acme/demo',
    version: '0.1.0',
    exports: ['standoff.feature.js'],
    license: 'MIT',
  };

  it.each([
    ['patch', '0.1.1'],
    ['minor', '0.2.0'],
    ['major', '1.0.0'],
    ['0.3.0-beta.1', '0.3.0-beta.1'],
    ['0.0.9', '0.0.9'],
  ])('%s takes 0.1.0 to %s, keeping the rest of the block and the file', (spec, to) => {
    writeConfig({ engine: '0.0.46', unit: 'in', package: { ...BLOCK, futureField: 1 } });

    const change = PackageAuthoring.bumpVersion(workspace, spec);

    expect(change).toEqual({
      name: '@acme/demo', from: '0.1.0', to, configPath: path.join(workspace, PROJECT_CONFIG_FILENAME),
    });
    expect(readStored()).toEqual({ engine: '0.0.46', unit: 'in', package: { ...BLOCK, version: to, futureField: 1 } });
  });

  it('releases a prerelease', () => {
    writeConfig({ package: { ...BLOCK, version: '1.0.0-rc.2' } });

    expect(PackageAuthoring.bumpVersion(workspace, 'major').to).toBe('1.0.0');
  });

  it('refuses a workspace that is not a package', async () => {
    writeConfig({ engine: '0.0.46' });

    const err = await refusal(() => PackageAuthoring.bumpVersion(workspace, 'patch'));

    expect(err.message).toBe("This workspace isn't a package — run `fluidcad package init` first.");
  });

  it('refuses a broken package block, naming the problem', async () => {
    writeConfig({ package: { ...BLOCK, exports: 'standoff.feature.js' } });

    const err = await refusal(() => PackageAuthoring.bumpVersion(workspace, 'patch'));

    expect(err.message).toContain('"exports" is not a list');
  });

  it.each(['1.2', 'v1.0.0', 'prerelease', '^1.0.0', ''])('refuses the spec %j', async (spec) => {
    writeConfig({ package: BLOCK });

    const err = await refusal(() => PackageAuthoring.bumpVersion(workspace, spec));

    expect(err.message).toContain('is not a version or a bump');
    expect(readStored().package.version).toBe('0.1.0');
  });

  it('refuses the version it already has', async () => {
    writeConfig({ package: BLOCK });

    const err = await refusal(() => PackageAuthoring.bumpVersion(workspace, '0.1.0'));

    expect(err.message).toBe('@acme/demo is already at 0.1.0.');
  });

  it('refuses a fluidcad.json that is not JSON instead of overwriting it', async () => {
    write(PROJECT_CONFIG_FILENAME, 'nope');

    const err = await refusal(() => PackageAuthoring.bumpVersion(workspace, 'patch'));

    expect(err.message).toContain('not valid JSON');
    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8')).toBe('nope');
  });
});
