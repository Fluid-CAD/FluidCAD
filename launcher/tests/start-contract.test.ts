import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkActionResult,
  checkAppearance,
  checkApplyPinResult,
  checkEngineOptions,
  checkFeed,
  checkFolderCheck,
  checkFolderListing,
  checkHello,
  checkProjectList,
  checkSessionEvent,
  checkUpgradePreview,
  checkUpgradeProgress,
  checkWindowState,
} from '../../ui/src/start/contract-guards';
import { START_SCREEN_PROTOCOL as PAGE_PROTOCOL } from '../../ui/src/start/host';
import { EngineUpgrade } from '../src/engine/upgrade';
import { UpgradeDiffer, type EngineSnapshot } from '../src/engine/upgrade-diff';
import { writeProjectPin } from '../src/engine/project-pin';
import { FeedService } from '../src/start/feed';
import { START_SCREEN_PROTOCOL as SHELL_PROTOCOL, helloReply, type UpgradeProgressMessage } from '../src/start/contract';
import { engineOptionsFor, listStartProjects } from '../src/projects/listing';
import { readSavedTheme } from '../src/start/theme';
import { rememberProject } from '../src/projects/app-state';
import { thumbnailFileFor, type ThumbnailStamp } from '../src/previews/thumbnails';
import { INITIAL_STATE, pageStateOf, transition, type OpenEvent } from '../src/projects/open-state';
import { setBuiltinEngineLocation } from '../src/engine/cache';
import { checkNewProject, listFolder } from '../src/server/folders';
import { SessionRegistry } from '../src/server/session-registry';
import { thumbnailUrl as launcherThumbnailUrl } from '../src/server/start-page';
import type { SessionEvent } from '../src/start/contract';
import { eventually, setDirtyFiles, writeFakePackage } from './fake-package';

/**
 * The start screen is engine UI and its data comes from a launcher (the
 * desktop app, or `npx fluidcad`): the page's types live in
 * `ui/src/start/host.ts`, the launcher keeps its own copies. This builds every
 * payload a launcher sends with the launcher's real functions — against a
 * throwaway FLUIDCAD_HOME and a fake built-in engine — and runs it through the
 * page's own runtime guards. A field renamed on one side only fails here, not
 * on a user's screen.
 */

/** Previews as the desktop app's start page loads them. */
const appThumbnailUrl = (stamp: ThumbnailStamp) => `fluidcad-app://thumbnails/${stamp.fileName}?v=${Math.round(stamp.mtimeMs)}`;

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
  for (const key of ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE']) {
    savedEnv[key] = process.env[key];
  }
  process.env.FLUIDCAD_HOME = home;
  process.env.FLUIDCAD_BUILTIN_ENGINE = path.join(home, 'builtin');
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

    const list = checkProjectList(
      listStartProjects({ isOpen: (candidate) => candidate === lagging, thumbnailUrl: appThumbnailUrl }),
    );
    expect(list.projects.map((project) => project.name)).toEqual(['scratch', 'bracket', 'lantern']);
    const [scratch, bracket, lantern] = list.projects;
    expect(scratch).toMatchObject({ engine: null, engineSource: null, thumbnail: null, open: false });
    expect(bracket).toMatchObject({ engine: '0.0.45', engineSource: 'pin', latest: true, upgradeTo: null });
    expect(bracket.thumbnail).toMatch(/^fluidcad-app:\/\/thumbnails\/[0-9a-f]{40}\.png\?v=\d+$/);
    expect(lantern).toMatchObject({ engine: '0.0.42', latest: false, upgradeTo: '0.0.45', open: true });

    // `npx fluidcad` serves the same list with its own preview URLs.
    const served = checkProjectList(listStartProjects({ isOpen: () => false, thumbnailUrl: launcherThumbnailUrl }));
    expect(served.projects[1].thumbnail).toMatch(/^\/thumbnails\/[0-9a-f]{40}\.png\?v=\d+$/);
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
    const walk: OpenEvent[] = [
      { type: 'open', project, status: { step: 'creating' } },
      { type: 'progress', attempt: 1, status: { step: 'resolving' } },
      { type: 'progress', attempt: 1, status: { step: 'downloading', version: '0.0.42', receivedBytes: 10, totalBytes: null } },
      { type: 'progress', attempt: 1, status: { step: 'downloading', version: '0.0.42', receivedBytes: 10, totalBytes: 40 } },
      { type: 'progress', attempt: 1, status: { step: 'starting', version: '0.0.42', source: 'downloaded' } },
      { type: 'fail', attempt: 1, message: 'The engine exited with code 1.' },
      { type: 'cancel' },
    ];
    let state = INITIAL_STATE;
    const phases: string[] = [];
    for (const event of [{ type: 'cancel' } as OpenEvent, ...walk]) {
      state = transition(state, event);
      const sent = pageStateOf(state)!;
      expect(checkWindowState(sent)).toEqual(sent);
      phases.push(sent.phase);
    }
    expect(phases).toEqual(['home', 'opening', 'opening', 'opening', 'opening', 'opening', 'failed', 'home']);
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

    const switched = await EngineUpgrade.apply(lagging, '0.0.45', { openProjectFor: () => null });
    expect(checkApplyPinResult(switched)).toEqual({ ok: true, error: undefined });
    const refused = await EngineUpgrade.apply(lagging, '0.0.45', {
      openProjectFor: () => ({ confirmTeardown: async () => false, reopenProject: async () => undefined }),
    });
    expect(checkApplyPinResult(refused)).toMatchObject({ ok: false });
  });

  it("sends npx fluidcad's sessions, close results and folder picker replies the page accepts", async () => {
    writeFakePackage(path.join(home, 'package'), '0.0.45');
    setBuiltinEngineLocation({ kind: 'package', packageRoot: path.join(home, 'package') });
    delete process.env.FLUIDCAD_BUILTIN_ENGINE;
    const events: SessionEvent[] = [];
    const registry = new SessionRegistry({ onView: (path, view) => events.push({ path, view }), changed: () => undefined, log: () => undefined });
    try {
      const parent = workspace('cad');
      const created = path.join(parent, 'bracket');
      registry.open(created, { create: true });
      await eventually(() => events.some((event) => event.view.phase === 'running'));
      setDirtyFiles(created, ['box.part.js']);
      expect(checkActionResult(await registry.close(created))).toMatchObject({ ok: false, error: expect.any(String) });
      setDirtyFiles(created, []);
      expect(checkActionResult(await registry.close(created))).toEqual({ ok: true, error: undefined });
      const phases = events.map((event) => checkSessionEvent(event).view.phase);
      expect(phases).toEqual(expect.arrayContaining(['opening', 'running', 'closed']));

      expect(checkFolderListing(listFolder(parent)).entries).toMatchObject([{ name: 'bracket', project: true }]);
      for (const name of ['lantern', 'bracket', 'a/b']) {
        const check = checkNewProject(parent, name);
        expect(checkFolderCheck(check)).toEqual(check);
      }
    } finally {
      await registry.shutdown();
      setBuiltinEngineLocation(null);
    }
  });

  it('sends the saved theme', () => {
    expect(checkAppearance({ theme: readSavedTheme(path.join(home, 'no-preferences.json')) })).toEqual({ theme: 'fluidcad-dark' });
  });
});
