import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineUpgrade } from '../src/engine-upgrade';
import { UpgradeDiffer, type EngineSnapshot } from '../src/engine/upgrade-diff';
import { writeProjectPin } from '../src/engine/project-pin';
import { rememberProject, rememberUpgradeChoice, upgradePromptPreference } from '../src/state';

/**
 * The upgrade offer is gated three times over — the project's own install,
 * the pin against the built-in, and what the user already answered — and a
 * wrong answer at any gate is either a nag or a silent kernel change. So each
 * gate gets a case, against a fake FLUIDCAD_HOME and a fake built-in engine.
 */

let home: string;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

/** A directory that `describeEngineAt` accepts as an engine of `version`. */
function fakeEngine(root: string, version: string): void {
  const packageRoot = path.join(root, 'node_modules', 'fluidcad');
  fs.mkdirSync(path.join(packageRoot, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fluidcad', version }));
  fs.writeFileSync(path.join(packageRoot, 'server', 'dist', 'index.js'), '');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-upgrade-home-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-upgrade-ws-'));
  for (const key of ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE', 'FLUIDCAD_RESOURCES_PATH']) {
    savedEnv[key] = process.env[key];
  }
  process.env.FLUIDCAD_HOME = home;
  process.env.FLUIDCAD_BUILTIN_ENGINE = path.join(home, 'builtin');
  delete process.env.FLUIDCAD_RESOURCES_PATH;
  fakeEngine(path.join(home, 'builtin'), '0.0.45');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('EngineUpgrade.pendingFor', () => {
  it('offers the built-in engine to a project pinned below it', () => {
    writeProjectPin(workspace, '0.0.44');
    expect(EngineUpgrade.pendingFor(workspace)).toEqual({ from: '0.0.44', to: '0.0.45' });
  });

  it('offers nothing when the pin is the built-in engine or newer', () => {
    writeProjectPin(workspace, '0.0.45');
    expect(EngineUpgrade.pendingFor(workspace)).toBeNull();
    writeProjectPin(workspace, '0.0.46');
    expect(EngineUpgrade.pendingFor(workspace)).toBeNull();
  });

  it('offers nothing to an unpinned project', () => {
    expect(EngineUpgrade.pendingFor(workspace)).toBeNull();
  });

  it("offers nothing to a project running its own node_modules install", () => {
    writeProjectPin(workspace, '0.0.44');
    fakeEngine(workspace, '0.0.44');
    expect(EngineUpgrade.pendingFor(workspace)).toBeNull();
  });

  it('still offers when node_modules/fluidcad is a link the engine planted', () => {
    writeProjectPin(workspace, '0.0.44');
    const nodeModules = path.join(workspace, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(path.join(nodeModules, '.fluidcad-engine-link'), '');
    fs.symlinkSync(path.join(home, 'builtin', 'node_modules', 'fluidcad'), path.join(nodeModules, 'fluidcad'));
    expect(EngineUpgrade.pendingFor(workspace)).toEqual({ from: '0.0.44', to: '0.0.45' });
  });
});

describe('EngineUpgrade.promptFor', () => {
  beforeEach(() => {
    writeProjectPin(workspace, '0.0.44');
    rememberProject(workspace, '0.0.44');
  });

  it('asks by default', () => {
    expect(EngineUpgrade.promptFor(workspace)).toEqual({ from: '0.0.44', to: '0.0.45' });
  });

  it('stays quiet after "keep" until something newer ships', () => {
    rememberUpgradeChoice(workspace, { declinedUpgradeTo: '0.0.45' });
    expect(EngineUpgrade.promptFor(workspace)).toBeNull();
    // The card still says an update exists — only the prompt is silenced.
    expect(EngineUpgrade.pendingFor(workspace)).toEqual({ from: '0.0.44', to: '0.0.45' });

    fakeEngine(path.join(home, 'builtin'), '0.0.46');
    expect(EngineUpgrade.promptFor(workspace)).toEqual({ from: '0.0.44', to: '0.0.46' });
  });

  it('stays quiet for good after "don\'t ask again"', () => {
    rememberUpgradeChoice(workspace, { muted: true });
    fakeEngine(path.join(home, 'builtin'), '0.0.47');
    expect(EngineUpgrade.promptFor(workspace)).toBeNull();
  });

  it('keeps the preference across later opens of the project', () => {
    rememberUpgradeChoice(workspace, { muted: true });
    rememberProject(workspace, '0.0.44');
    expect(upgradePromptPreference(workspace)).toEqual({ declinedUpgradeTo: null, muted: true });
  });

  it('ignores a choice for a project that is not in the recents', () => {
    const stranger = path.join(workspace, 'elsewhere');
    rememberUpgradeChoice(stranger, { muted: true });
    expect(upgradePromptPreference(stranger)).toEqual({ declinedUpgradeTo: null, muted: false });
  });
});

describe('EngineUpgrade.choices', () => {
  it('lists the built-in first and drops engines below the compat floor', () => {
    fakeEngine(path.join(home, 'engines', '0.0.43'), '0.0.43');
    fakeEngine(path.join(home, 'engines', '0.0.40'), '0.0.40');
    expect(EngineUpgrade.choices()).toEqual([
      { version: '0.0.45', builtin: true, installed: true },
      { version: '0.0.43', builtin: false, installed: true },
    ]);
  });
});

describe('UpgradeDiffer.compare', () => {
  const model = (file: string, overrides: Partial<EngineSnapshot['models'][number]> = {}) => ({
    file,
    state: 'rendered',
    compileError: null,
    features: [],
    solids: 1,
    volumeMm3: 1000,
    surfaceAreaMm2: 600,
    ...overrides,
  });

  it('reports identical models as identical, within the volume epsilon', () => {
    const before: EngineSnapshot = { version: '0.0.44', models: [model('/ws/a.part.js')] };
    const after: EngineSnapshot = {
      version: '0.0.45',
      models: [model('/ws/a.part.js', { volumeMm3: 1000 + 1e-5 })],
    };
    const diff = UpgradeDiffer.compare('/ws', before, after);
    expect(diff.identical).toBe(true);
    expect(diff.models).toEqual([{ file: 'a.part.js', status: 'identical', notes: [] }]);
  });

  it('classifies a model that stops building as broken and one that starts as fixed', () => {
    const before: EngineSnapshot = {
      version: '0.0.44',
      models: [model('/ws/a.part.js'), model('/ws/b.part.js', { compileError: 'boom' })],
    };
    const after: EngineSnapshot = {
      version: '0.0.45',
      models: [model('/ws/a.part.js', { compileError: 'nope' }), model('/ws/b.part.js')],
    };
    const diff = UpgradeDiffer.compare('/ws', before, after);
    expect(diff.identical).toBe(false);
    expect(diff.models.map((entry) => entry.status)).toEqual(['broken', 'fixed']);
    expect(diff.models[0].notes[0]).toBe('Fails to build: nope');
  });

  it('notes feature failures, solid counts and volumes that moved', () => {
    const before: EngineSnapshot = {
      version: '0.0.44',
      models: [model('/ws/a.part.js', { features: [{ index: 2, kind: 'fillet', name: 'edge', error: null }] })],
    };
    const after: EngineSnapshot = {
      version: '0.0.45',
      models: [
        model('/ws/a.part.js', {
          features: [{ index: 2, kind: 'fillet', name: 'edge', error: 'radius too large' }],
          solids: 2,
          volumeMm3: 1010,
        }),
      ],
    };
    const diff = UpgradeDiffer.compare('/ws', before, after, ['deep/c.part.js']);
    expect(diff.models[0].status).toBe('changed');
    expect(diff.models[0].notes).toEqual([
      'fillet "edge" now fails: radius too large',
      'Solids: 1 → 2',
      'Volume: 1000.000 → 1010.000 (+1.000%)',
    ]);
    expect(diff.skipped).toEqual(['deep/c.part.js']);
  });
});
