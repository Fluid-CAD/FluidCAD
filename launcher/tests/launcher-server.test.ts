import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setBuiltinEngineLocation } from '../src/engine/cache';
import { thumbnailFileFor } from '../src/previews/thumbnails';
import { startLauncherServer, type LauncherServer } from '../src/server/launcher-server';
import { START_PAGE_CSP } from '../src/server/start-page';
import { eventually, fakeEnginePid, processGone, writeFakePackage } from './fake-package';

/**
 * `npx fluidcad`'s start server over real HTTP, against a fake engine: who
 * may call it, what it serves, and a project opened, followed on the event
 * stream, and stopped with the server.
 */

let root: string;
let server: LauncherServer;
let cookie: string;
const savedEnv: Record<string, string | undefined> = {};

/** The start page's own requests: same origin, with the session cookie and the launcher's header. */
function api(route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.url.replace(/\/$/, '')}${route}`, {
    ...init,
    headers: {
      cookie,
      'sec-fetch-site': 'same-origin',
      'x-fluidcad-launcher': '1',
      'content-type': 'application/json',
      ...(init.headers as Record<string, string>),
    },
  });
}

const post = (route: string, body: unknown) => api(route, { method: 'POST', body: JSON.stringify(body) });

/** Everything the event stream sends until `until` says stop. */
async function readEvents(until: (events: { event: string; data: any }[]) => boolean): Promise<{ event: string; data: any }[]> {
  const response = await api('/api/events');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: any }[] = [];
  let buffer = '';
  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) {
        events.push({ event, data: data ? JSON.parse(data) : null });
      }
    }
  }
  await reader.cancel();
  return events;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-launcher-'));
  for (const key of ['FLUIDCAD_HOME', 'FLUIDCAD_BUILTIN_ENGINE', 'XDG_CONFIG_HOME']) {
    savedEnv[key] = process.env[key];
  }
  delete process.env.FLUIDCAD_BUILTIN_ENGINE;
  process.env.FLUIDCAD_HOME = path.join(root, 'home');
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  fs.mkdirSync(path.join(root, 'config', 'fluidcad'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'fluidcad', 'preferences.json'), JSON.stringify({ theme: 'fluidcad-light' }));
  writeFakePackage(path.join(root, 'package'), '0.0.50');
  server = await startLauncherServer({ packageRoot: path.join(root, 'package'), port: 0, log: () => undefined });

  const login = await fetch(server.loginUrl, { redirect: 'manual' });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});

afterEach(async () => {
  await server.close();
  setBuiltinEngineLocation(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('signing in', () => {
  it('trades the link for a cookie, and takes the key out of the address bar', async () => {
    const login = await fetch(`${server.url}?token=${new URL(server.loginUrl).searchParams.get('token')}&project=%2Fp`, {
      redirect: 'manual',
    });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/?project=%2Fp');
    expect(login.headers.get('set-cookie')).toMatch(/^fluidcad-launcher-\d+=[\w-]+; HttpOnly; SameSite=Strict; Path=\/$/);
  });

  it('turns away a wrong key, and a page load or a call without the cookie', async () => {
    expect((await fetch(`${server.url}?token=nope`, { redirect: 'manual' })).status).toBe(401);
    expect((await fetch(server.url)).status).toBe(401);
    expect((await fetch(`${server.url}api/start/projects`, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401);
    expect((await fetch(`${server.url}thumbnails/${'0'.repeat(40)}.png`)).status).toBe(401);
  });

  it('answers only its own origin, and only a changing call that carries its header', async () => {
    expect((await api('/api/start/projects')).status).toBe(200);
    expect((await api('/api/start/projects', { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await api('/api/start/projects', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await post('/api/start/hello', { protocol: 2 })).status).toBe(200);
    expect((await api('/api/start/hello', { method: 'POST', body: '{}', headers: { 'x-fluidcad-launcher': '' } })).status).toBe(403);
    expect(
      (await api('/api/start/hello', { method: 'POST', body: '{}', headers: { origin: 'http://localhost:3100' } })).status,
    ).toBe(403);
  });

  it('answers only to localhost', async () => {
    // `fetch` will not send a Host of its own choosing; a rebound page's browser would.
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.port, path: '/api/launcher/health', headers: { host: 'fluidcad.evil.example' } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(403);
    const health = await (await fetch(`${server.url}api/launcher/health`)).json();
    expect(health).toEqual({ ok: true, app: 'fluidcad-launcher', version: '0.0.50', pid: process.pid });
  });
});

describe('the start page', () => {
  it('is served with the saved theme and its CSP', async () => {
    const response = await api('/');
    expect(response.headers.get('content-security-policy')).toBe(START_PAGE_CSP);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toContain('data-theme="fluidcad-light"');
  });

  it('shows only the start screen when another page links to a project', async () => {
    const response = await api('/?project=%2Fetc', { headers: { 'sec-fetch-site': 'cross-site' }, redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect((await api('/?project=%2Fetc', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(200);
  });

  it('serves its assets to anyone, and nothing outside them', async () => {
    expect((await fetch(`${server.url}assets/start.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await fetch(`${server.url}logo.svg`)).status).toBe(200);
    expect((await fetch(`${server.url}assets/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${server.url}package.json`)).status).toBe(404);
  });

  it('serves a preview by its hashed name only', async () => {
    const workspace = path.join(root, 'projects', 'bracket');
    const file = thumbnailFileFor(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'png');
    const ok = await api(`/thumbnails/${path.basename(file)}?v=1`);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(await ok.text()).toBe('png');
    expect((await api('/thumbnails/desktop.json')).status).toBe(404);
  });
});

describe('projects', () => {
  it('opens a new project, pushes its progress, lists it as open, and stops it with the server', async () => {
    const parent = path.join(root, 'projects');
    fs.mkdirSync(parent, { recursive: true });
    const check = await (await post('/api/folders/check', { parent, name: 'bracket' })).json();
    expect(check).toEqual({ path: path.join(parent, 'bracket'), state: 'missing' });

    const workspace = check.path;
    const events = readEvents((seen) => seen.some((entry) => entry.event === 'session' && entry.data.view.phase === 'running'));
    // The stream is listening before the open, as a project's tab makes sure it is.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = await (await post('/api/sessions', { path: workspace, create: true })).json();
    expect(opened).toMatchObject({ phase: 'opening', status: { step: 'creating' } });

    const seen = await events;
    const steps = seen
      .filter((entry) => entry.event === 'session' && entry.data.view.phase === 'opening')
      .map((entry) => entry.data.view.status.step);
    expect(steps).toEqual(['creating', 'resolving', 'starting']);
    expect(seen.some((entry) => entry.event === 'changed')).toBe(true);

    const view = await (await api(`/api/sessions?${new URLSearchParams({ path: workspace })}`)).json();
    expect(view).toMatchObject({ phase: 'running', version: '0.0.50' });
    const { projects } = await (await api('/api/start/projects')).json();
    expect(projects).toMatchObject([{ path: workspace, open: true, engine: '0.0.50', latest: true }]);

    const pid = fakeEnginePid(workspace);
    await server.close();
    await processGone(pid);
  });

  it('refuses paths that are not absolute, and says why', async () => {
    const relative = 'relative/bracket';
    const responses = [
      await post('/api/sessions', { path: relative }),
      await post('/api/start/forget', { path: relative }),
      await post('/api/start/apply-pin', { path: relative, version: '0.0.50' }),
      await api(`/api/start/engine-options?${new URLSearchParams({ path: relative })}`),
    ];
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Expected a project path as an absolute path.' });
    }
  });

  it('lists folders for the page picker, projects marked', async () => {
    const parent = path.join(root, 'projects');
    fs.mkdirSync(path.join(parent, 'bracket'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'bracket', 'init.js'), '');
    fs.mkdirSync(path.join(parent, 'notes'));
    const listing = await (await api(`/api/folders?${new URLSearchParams({ path: parent })}`)).json();
    expect(listing).toMatchObject({
      path: parent,
      project: false,
      parent: root,
      entries: [
        { name: 'bracket', project: true },
        { name: 'notes', project: false },
      ],
    });
    const missing = await api(`/api/folders?${new URLSearchParams({ path: path.join(parent, 'nope') })}`);
    expect(missing.status).toBe(400);
  });

  it('opens nothing on a close of a project that is not open', async () => {
    expect(await (await post('/api/start/close', { path: path.join(root, 'nowhere') })).json()).toEqual({ ok: true });
    await eventually(() => true);
  });
});

describe('a projects folder', () => {
  let projectsDir: string;

  /** The same server, started again on a projects folder, and signed into. */
  async function restartWithRoot(): Promise<void> {
    await server.close();
    projectsDir = path.join(root, 'cad');
    fs.mkdirSync(projectsDir, { recursive: true });
    server = await startLauncherServer({
      packageRoot: path.join(root, 'package'),
      port: 0,
      log: () => undefined,
      projectsRoot: projectsDir,
    });
    const login = await fetch(server.loginUrl, { redirect: 'manual' });
    cookie = login.headers.get('set-cookie')!.split(';')[0];
  }

  it('has to exist before the server listens', async () => {
    await expect(
      startLauncherServer({ packageRoot: path.join(root, 'package'), port: 0, log: () => undefined, projectsRoot: path.join(root, 'nope') }),
    ).rejects.toThrow('does not exist');
  });

  it('tells the page about the folder, and lists every project in it', async () => {
    await restartWithRoot();
    for (const name of ['arm', 'bracket']) {
      fs.mkdirSync(path.join(projectsDir, name));
      fs.writeFileSync(path.join(projectsDir, name, 'init.js'), '');
    }
    fs.mkdirSync(path.join(projectsDir, 'notes'));
    expect(server.projectsRoot).toBe(projectsDir);
    const hello = await (await post('/api/start/hello', { protocol: 3 })).json();
    expect(hello).toMatchObject({ ok: true, projectsRoot: projectsDir });
    const { projects } = await (await api('/api/start/projects')).json();
    expect(projects).toMatchObject([
      { name: 'arm', path: path.join(projectsDir, 'arm'), open: false, lastOpenedAt: '' },
      { name: 'bracket', path: path.join(projectsDir, 'bracket'), open: false, lastOpenedAt: '' },
    ]);
  });

  it('refuses every path that is not a project in the folder', async () => {
    await restartWithRoot();
    const elsewhere = path.join(root, 'elsewhere');
    const nested = path.join(projectsDir, 'bracket', 'inner');
    for (const workspace of [elsewhere, nested, projectsDir, path.join(projectsDir, '..', 'elsewhere')]) {
      const responses = [
        await post('/api/sessions', { path: workspace, create: true }),
        await post('/api/sessions', { path: workspace }),
        await api(`/api/sessions?${new URLSearchParams({ path: workspace })}`),
        await post('/api/sessions/retry', { path: workspace }),
        await post('/api/sessions/cancel', { path: workspace }),
        await post('/api/start/close', { path: workspace }),
        await post('/api/start/forget', { path: workspace }),
        await post('/api/start/apply-pin', { path: workspace, version: '0.0.50' }),
        await post('/api/start/preview-upgrade', { path: workspace, version: '0.0.50' }),
        await api(`/api/start/engine-options?${new URLSearchParams({ path: workspace })}`),
        await post('/api/folders/check', { path: workspace }),
      ];
      for (const response of responses) {
        expect(response.status, `${response.url} for ${workspace}`).toBe(400);
        expect((await response.json()).error).toContain('is not a project in the projects folder');
      }
    }
    expect(fs.existsSync(elsewhere)).toBe(false);
    expect(fs.existsSync(nested)).toBe(false);
  });

  it('shows the picker the folder itself and nothing else', async () => {
    await restartWithRoot();
    fs.mkdirSync(path.join(projectsDir, 'bracket'));
    fs.writeFileSync(path.join(projectsDir, 'bracket', 'init.js'), '');
    const listing = await (await api('/api/folders')).json();
    expect(listing).toMatchObject({
      path: projectsDir,
      parent: null,
      home: projectsDir,
      roots: [projectsDir],
      entries: [{ name: 'bracket', project: true }],
    });
    expect(await (await api(`/api/folders?${new URLSearchParams({ path: projectsDir })}`)).json()).toEqual(listing);
    for (const other of [root, path.join(projectsDir, 'bracket')]) {
      const response = await api(`/api/folders?${new URLSearchParams({ path: other })}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: `Only the projects folder ${projectsDir} can be listed.` });
      const check = await post('/api/folders/check', { parent: other, name: 'arm' });
      expect(check.status).toBe(400);
    }
    expect(await (await post('/api/folders/check', { parent: projectsDir, name: 'arm' })).json()).toEqual({
      path: path.join(projectsDir, 'arm'),
      state: 'missing',
    });
    expect(await (await post('/api/folders/check', { parent: projectsDir, name: 'bracket' })).json()).toEqual({
      path: path.join(projectsDir, 'bracket'),
      state: 'project',
    });
    expect((await (await post('/api/folders/check', { parent: projectsDir, name: '.hidden' })).json()).state).toBe('invalid-name');
    expect((await (await post('/api/folders/check', { parent: projectsDir, name: 'a/b' })).json()).state).toBe('invalid-name');
  });

  it('creates a new project in the folder by its name, and lists it as opened', async () => {
    await restartWithRoot();
    const workspace = path.join(projectsDir, 'bracket');
    const events = readEvents((seen) => seen.some((entry) => entry.event === 'session' && entry.data.view.phase === 'running'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = await (await post('/api/sessions', { path: workspace, create: true })).json();
    expect(opened).toMatchObject({ phase: 'opening', status: { step: 'creating' } });
    await events;
    expect(fs.existsSync(path.join(workspace, 'init.js'))).toBe(true);
    const { projects } = await (await api('/api/start/projects')).json();
    expect(projects).toMatchObject([{ path: workspace, name: 'bracket', open: true, engine: '0.0.50' }]);
    expect(projects[0].lastOpenedAt).not.toBe('');
    const pid = fakeEnginePid(workspace);
    await server.close();
    await processGone(pid);
  });
});
