import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAppearance,
  checkApplyPinResult,
  checkEngineOptions,
  checkFeed,
  checkHello,
  checkProjectList,
  checkUpgradePreview,
  checkUpgradeProgress,
  checkWindowState,
} from '../../ui/src/start/contract-guards';
import { START_SCREEN_PROTOCOL as PAGE_PROTOCOL } from '../../ui/src/start/host';
import { EngineUpgrade } from '../src/engine-upgrade';
import { UpgradeDiffer, type EngineSnapshot } from '../src/engine/upgrade-diff';
import { writeProjectPin } from '../src/engine/project-pin';
import { FeedService } from '../src/feed';
import { START_SCREEN_PROTOCOL as SHELL_PROTOCOL, helloReply, type UpgradeProgressMessage } from '../src/start/contract';
import { engineOptionsFor, listStartProjects } from '../src/start/projects';
import { readSavedTheme } from '../src/start/theme';
import { rememberProject } from '../src/state';
import { thumbnailFileFor } from '../src/thumbnails';
import { INITIAL_STATE, pageStateOf, transition, type WindowEvent } from '../src/window/window-state';

/**
 * The start screen is engine UI and its data comes from the shell: the page's
 * types live in `ui/src/start/host.ts`, the shell keeps its own copies. This
 * builds every payload the shell sends with the shell's real functions —
 * against a throwaway FLUIDCAD_HOME and a fake built-in engine — and runs it
 * through the page's own runtime guards. A field renamed on one side only
 * fails here, not on a user's screen.
 */

let home: string;
let workspaces: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function fakeEngine(root: string, version: string): void {
  const packageRoot = path.join(root, 'node_modules', 'fluidcad');
  fs.mkdirSync(path.join(packageRoot, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'fluidcad', version }));
  fs.writeFileSync(path.join(packageRoot, 'server', 'dist', 'index.js'), '');
}

function workspace(name: string): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-contract-ws-')), name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'part.part.js'), '');
  workspaces.push(path.dirname(dir));
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-contract-home-'));
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
  for (const dir of workspaces) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  workspaces = [];
});

describe('the start screen contract', () => {
  it('has one protocol number on both sides', () => {
    expect(SHELL_PROTOCOL).toBe(PAGE_PROTOCOL);
    expect(checkHello(helloReply(PAGE_PROTOCOL, { version: '0.0.45', platform: 'linux', home: '/home/you' }))).toEqual({
      ok: true,
      appVersion: '0.0.45',
      platform: 'linux',
      home: '/home/you',
    });
    expect(helloReply(PAGE_PROTOCOL + 1, { version: '0.0.45', platform: 'linux', home: '/h' }).ok).toBe(false);
  });

  it('lists recents in the shape the page reads, previews as scheme URLs', () => {
    const lagging = workspace('lantern');
    writeProjectPin(lagging, '0.0.42');
    rememberProject(lagging, '0.0.42');
    const current = workspace('bracket');
    writeProjectPin(current, '0.0.45');
    rememberProject(current, '0.0.45');
    const unpinned = workspace('scratch');
    rememberProject(unpinned, null);
    fs.mkdirSync(path.dirname(thumbnailFileFor(current)), { recursive: true });
    fs.writeFileSync(thumbnailFileFor(current), 'png');

    const list = checkProjectList(listStartProjects((candidate) => candidate === lagging));
    expect(list.projects.map((project) => project.name)).toEqual(['scratch', 'bracket', 'lantern']);
    const [scratch, bracket, lantern] = list.projects;
    expect(scratch).toMatchObject({ engine: null, engineSource: null, thumbnail: null, open: false });
    expect(bracket).toMatchObject({ engine: '0.0.45', engineSource: 'pin', latest: true, upgradeTo: null });
    expect(bracket.thumbnail).toMatch(/^fluidcad-app:\/\/thumbnails\/[0-9a-f]{40}\.png\?v=\d+$/);
    expect(lantern).toMatchObject({ engine: '0.0.42', latest: false, upgradeTo: '0.0.45', open: true });
  });

  it("describes a project's engine choices", () => {
    const lagging = workspace('lantern');
    writeProjectPin(lagging, '0.0.42');
    expect(checkEngineOptions(engineOptionsFor(lagging))).toEqual({
      current: '0.0.42',
      currentSource: 'pin',
      latest: '0.0.45',
      choices: [{ version: '0.0.45', builtin: true, installed: true }],
    });
  });

  it('sends every window state the page can draw', () => {
    const project = { path: '/home/you/cad/bracket', name: 'bracket' };
    const walk: WindowEvent[] = [
      { type: 'open', project },
      { type: 'progress', attempt: 1, status: { step: 'downloading', version: '0.0.42', receivedBytes: 10, totalBytes: null } },
      { type: 'progress', attempt: 1, status: { step: 'downloading', version: '0.0.42', receivedBytes: 10, totalBytes: 40 } },
      { type: 'progress', attempt: 1, status: { step: 'starting', version: '0.0.42', source: 'downloaded' } },
      { type: 'fail', attempt: 1, message: 'The engine exited with code 1.' },
      { type: 'cancel' },
    ];
    let state = INITIAL_STATE;
    const phases: string[] = [];
    for (const event of [{ type: 'cancel' } as WindowEvent, ...walk]) {
      state = transition(state, event);
      const sent = pageStateOf(state)!;
      expect(checkWindowState(sent)).toEqual(sent);
      phases.push(sent.phase);
    }
    expect(phases).toEqual(['home', 'opening', 'opening', 'opening', 'opening', 'failed', 'home']);
  });

  it('sends a feed the page accepts, filtered for this app version', () => {
    const raw = {
      tutorials: [{ id: 't', title: 'First part', description: 'Sketch and extrude', url: 'https://fluidcad.io/t', thumbnail: 'https://feed.fluidcad.io/t.png' }],
      notifications: [
        { id: 'n1', body: '<p>Hello</p>' },
        { id: 'n2', body: '<p>Future</p>', minVersion: '0.1.0' },
        { id: 'n3', body: '<p>Old</p>', expiresAt: '2020-01-01T00:00:00Z' },
      ],
    };
    const feed = checkFeed(FeedService.visibleTo(FeedService.parseFeed(raw), '0.0.45'));
    expect(feed.notifications.map((entry) => entry.id)).toEqual(['n1']);
    expect(feed.tutorials[0].thumbnail).toBe('https://feed.fluidcad.io/t.png');
  });

  it('sends comparisons, progress and pin results the page accepts', async () => {
    const lagging = workspace('lantern');
    writeProjectPin(lagging, '0.0.42');
    const snapshot = (version: string, volumeMm3: number): EngineSnapshot => ({
      version,
      models: [{ file: 'part.part.js', state: 'rendered', compileError: null, features: [], solids: 1, volumeMm3, surfaceAreaMm2: 10 }],
    });
    const diff = UpgradeDiffer.compare(lagging, snapshot('0.0.42', 100), snapshot('0.0.45', 120), ['extra.part.js']);
    expect(checkUpgradePreview({ diff }).diff!.models[0].status).toBe('changed');
    // 0.0.42 is not installed in this home: the error half of a preview.
    expect(checkUpgradePreview(await EngineUpgrade.preview(lagging, '0.0.45', () => undefined))).toEqual({
      diff: undefined,
      error: expect.stringContaining('open it once first'),
    });

    const progress: UpgradeProgressMessage = { workspacePath: lagging, message: 'Building with engine 0.0.45…' };
    expect(checkUpgradeProgress(progress)).toEqual(progress);

    const switched = await EngineUpgrade.apply(lagging, '0.0.45', { openWindowFor: () => null });
    expect(checkApplyPinResult(switched)).toEqual({ ok: true, error: undefined });
    const refused = await EngineUpgrade.apply(lagging, '0.0.45', {
      openWindowFor: () => ({ confirmTeardown: async () => false, reopenProject: async () => undefined }),
    });
    expect(checkApplyPinResult(refused)).toMatchObject({ ok: false });
  });

  it('sends the saved theme', () => {
    expect(checkAppearance({ theme: readSavedTheme(path.join(home, 'no-preferences.json')) })).toEqual({ theme: 'fluidcad-dark' });
  });
});
