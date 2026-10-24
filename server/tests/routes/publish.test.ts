import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { createPublishRouter } from '../../src/routes/publish.ts';
import type { PublishSession } from '../../src/hub/hub-app-publish.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { packPackage, type PackPackageResult } from '../../src/packages/package-builder.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { FakeHub, type FakeHubVersion } from '../fixtures/fake-hub.ts';

/**
 * The Publish dialog's routes (ui-packages-plan N3) against the in-process
 * FakeHub and a fake pack: every route, the JSON-body guard on the POSTs,
 * the session followed as the page follows it, the refusal shape the hub
 * routes answer (signed out → 401 `signed-out`), the bump route and its
 * refusals. The workspace is a copy of fixtures/package-workspace
 * (`@acme/kit` 0.1.0), fresh for each test; the home (credentials, the
 * pack's scratch) is a temp directory.
 */

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/package-workspace');
const NAME = '@acme/kit';
const ENGINE = '0.0.46';
const ENV_KEYS = ['FLUIDCAD_HOME', 'FLUIDCAD_PACKAGES', 'FLUIDCAD_HUB_TOKEN'] as const;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let hub: FakeHub;
let scratch: string;
let workspace: string;
let home: string;
let packed: PackPackageResult;
let packCalls: number;
let saved: Record<string, string | undefined>;
let servers: http.Server[];
let sessions: PublishSession[];

async function serve(options: { workspacePath?: string; hubUrl?: string; confirmTimeoutMs?: number } = {}): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPublishRouter({
    workspacePath: options.workspacePath ?? workspace,
    engineVersion: ENGINE,
    env: { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin },
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
    pack: async () => {
      packCalls += 1;
      return packed;
    },
    confirmTimeoutMs: options.confirmTimeoutMs,
    onSession: (session) => sessions.push(session),
  }));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api`;
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

function post(url: string, body: unknown = {}) {
  return call(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** A POST without a JSON body, as a form on another site would send one. */
function postPlain(url: string) {
  return call(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
}

/** `GET /api/publish` until the session's status is one of `statuses`, as the dialog polls. */
async function until(api: string, statuses: string[], deadlineMs = 5000): Promise<any> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await call(`${api}/publish`);
    if (body.publish && statuses.includes(body.publish.status)) {
      return body.publish;
    }
    if (Date.now() > end) {
      throw new Error(`still ${JSON.stringify(body.publish)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function signIn(): void {
  const issued = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
  HubCredentials.write(hub.origin, { token: issued.token, tokenId: issued.id, handle: 'acme', email: 'acme@example.com' });
}

function hold(versions: FakeHubVersion[]): void {
  hub.packages.set(NAME, { status: 'active', versions });
}

function writeConfig(edit: (config: Record<string, any>) => void, dir: string = workspace): void {
  const file = path.join(dir, 'fluidcad.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(config);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** A workspace beside the package: a plain project, or one with the block `edit` leaves. */
function otherWorkspace(name: string, config: Record<string, unknown>): string {
  const dir = path.join(scratch, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fluidcad.json'), JSON.stringify(config, null, 2));
  return dir;
}

/** A local port nothing listens on: an offline hub. */
async function closedPort(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  hub = await FakeHub.start();
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-publish-routes-'));
  workspace = path.join(scratch, 'kit');
  fs.cpSync(FIXTURE, workspace, { recursive: true });
  packed = await packPackage({ workspacePath: workspace, fluidcadVersion: ENGINE });
}, 120_000);

afterAll(async () => {
  await hub.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  hub.reset();
  packCalls = 0;
  servers = [];
  sessions = [];
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.cpSync(FIXTURE, workspace, { recursive: true });
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(scratch, 'home-'));
  process.env.FLUIDCAD_HOME = home;
  process.env.FLUIDCAD_PACKAGES = path.join(home, 'library');
  delete process.env.FLUIDCAD_HUB_TOKEN;
  signIn();
});

afterEach(async () => {
  for (const session of sessions) {
    session.dispose();
    await session.settled();
  }
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('GET /api/publish/package', () => {
  it('answers the block for the dialog\'s header', async () => {
    const api = await serve();
    const answer = await call(`${api}/publish/package`);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ package: { name: NAME, version: '0.1.0' }, problem: null });
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  it('answers the problem sentence for a block that can\'t be read (U7), and neither for a plain project', async () => {
    writeConfig((config) => {
      config.package = { name: 'kit', version: '0.1.0' };
    });
    const broken = await call(`${await serve()}/publish/package`);
    expect(broken.body.package).toBeNull();
    expect(broken.body.problem).toMatch(/^fluidcad\.json has a "package" whose "name" "kit" needs your hub handle/);

    const plain = await call(`${await serve({ workspacePath: otherWorkspace('plain', { engine: ENGINE }) })}/publish/package`);
    expect(plain.body).toEqual({ package: null, problem: null });
  });
});

describe('GET /api/publish/status', () => {
  it('answers 401 signed-out in the Hub panel\'s shape when there are no credentials, asking the hub nothing', async () => {
    HubCredentials.clear(hub.origin);
    const answer = await call(`${await serve()}/publish/status`);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ error: `Not signed in to ${hub.origin}. Sign in to publish.`, code: 'signed-out', details: { reason: 'no-credentials' } });
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(hub.requests).toHaveLength(0);
  });

  it('answers where the package stands: not on the hub yet, then with its draft', async () => {
    const api = await serve();
    const fresh = await call(`${api}/publish/status`);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ name: NAME, package: null, latest: null });

    hold([{ version: '0.0.9', status: 'published', publishedAt: '2026-10-01T00:00:00.000Z', integrity: 'sha256-x' }, { version: '0.1.0', status: 'draft' }]);
    const held = await call(`${api}/publish/status`);
    expect(held.body.package.openVersion).toMatchObject({ version: '0.1.0', status: 'draft', wizardUrl: `${hub.origin}/publish/${NAME}/0.1.0` });
    expect(held.body.latest).toMatchObject({ version: '0.0.9', status: 'published' });
  });

  it('sees a sign-in from the Hub panel without a restart', async () => {
    HubCredentials.clear(hub.origin);
    const api = await serve();
    expect((await call(`${api}/publish/status`)).status).toBe(401);
    signIn();
    expect((await call(`${api}/publish/status`)).status).toBe(200);
  });

  it('answers 400 not-a-package outside a package workspace, and bad-config for a broken block', async () => {
    const plain = await call(`${await serve({ workspacePath: otherWorkspace('plain-status', { engine: ENGINE }) })}/publish/status`);
    expect(plain.status).toBe(400);
    expect(plain.body).toEqual({ error: "This workspace isn't a package — run `fluidcad package init` first.", code: 'not-a-package' });

    writeConfig((config) => {
      delete config.package.version;
    });
    const broken = await call(`${await serve()}/publish/status`);
    expect(broken.status).toBe(400);
    expect(broken.body).toMatchObject({ code: 'bad-config', error: expect.stringMatching(/without a "version".* Fix it, then try again\.$/) });
  });

  it('answers 503 hub-unreachable when the hub doesn\'t answer', async () => {
    const closed = await closedPort();
    const issued = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
    HubCredentials.write(closed, { token: issued.token, tokenId: issued.id, handle: 'acme', email: null });
    const answer = await call(`${await serve({ hubUrl: closed })}/publish/status`);
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: 'hub-unreachable', details: { hub: closed, cause: 'network' } });
  });
});

describe('POST /api/publish, GET /api/publish, POST /api/publish/confirm, DELETE /api/publish', () => {
  it('needs a JSON body with the right fields', async () => {
    const api = await serve();
    const plain = await postPlain(`${api}/publish`);
    expect(plain.status).toBe(415);
    expect(plain.body).toEqual({ error: 'Send a JSON body ({}).', code: 'bad-request' });
    for (const body of [{ notes: 1 }, { dryRun: 'yes' }, []]) {
      const bad = await post(`${api}/publish`, body);
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'Expected { notes?: string | null, dryRun?: boolean }.', code: 'bad-request' });
    }
    expect((await postPlain(`${api}/publish/confirm`)).status).toBe(415);
    expect((await call(`${api}/publish`)).body).toEqual({ publish: null });
    expect(packCalls).toBe(0);
  });

  it('runs a publish as the dialog drives it: start → awaiting-confirm → confirm → done with the wizard URL, packing once', async () => {
    const api = await serve();
    const started = await post(`${api}/publish`, {});
    expect(started.status).toBe(200);
    expect(started.headers.get('cache-control')).toBe('no-store');
    expect(started.body.publish).toMatchObject({ status: 'packing', hub: hub.origin, dryRun: false, notes: null });

    const waiting = await until(api, ['awaiting-confirm']);
    expect(waiting.summary).toMatchObject({ name: NAME, version: '0.1.0', handle: 'acme', becomes: 'draft', size: packed.zip.length });
    expect(packCalls).toBe(1);

    const busy = await post(`${api}/publish`, {});
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({
      error: 'A publish is already running (awaiting-confirm): wait for it to end, or cancel it first.',
      code: 'publish-running',
      details: { id: started.body.publish.id, status: 'awaiting-confirm' },
    });

    const confirmed = await post(`${api}/publish/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.publish).toMatchObject({ status: 'uploading', progress: { sent: 0, total: packed.zip.length } });

    const done = await until(api, ['done', 'failed', 'declined']);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ status: 'draft', wizardUrl: `${hub.origin}/publish/${NAME}/0.1.0`, integrity: TreeHash.ofFiles(packed.files) });
    expect(done.id).toBe(started.body.publish.id);
    expect(hub.uploads).toHaveLength(1);
    expect(Buffer.compare(hub.uploads[0].bytes, packed.zip)).toBe(0);
    expect(hub.uploads[0].headers['user-agent']).toMatch(/; app\)$/);
    expect(packCalls).toBe(1);

    // Ended: confirming again is refused, cancelling answers it as it is, and a new publish may start.
    const again = await post(`${api}/publish/confirm`);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'The publish is done, not waiting to be confirmed.', code: 'nothing-to-confirm' });
    expect((await call(`${api}/publish`, { method: 'DELETE' })).body.publish.status).toBe('done');
  });

  it('a dry run with notes ends done without a confirmation, storing nothing', async () => {
    hold([{ version: '0.0.9', status: 'published' }]);
    const api = await serve();
    const started = await post(`${api}/publish`, { notes: 'Gears.', dryRun: true });
    expect(started.body.publish).toMatchObject({ dryRun: true, notes: 'Gears.' });
    const done = await until(api, ['done', 'failed', 'declined', 'awaiting-confirm']);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ dryRun: true, status: 'in_review' });
    expect(hub.uploads[0].dryRun).toBe(true);
    expect(hub.uploads[0].headers['x-fluidcad-release-notes']).toBe('Gears.');
  });

  it('DELETE cancels a waiting publish: declined, nothing uploaded; with none it answers null', async () => {
    const api = await serve();
    expect((await call(`${api}/publish`, { method: 'DELETE' })).body).toEqual({ publish: null });
    await post(`${api}/publish`);
    await until(api, ['awaiting-confirm']);
    const cancelled = await call(`${api}/publish`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.publish).toMatchObject({ status: 'declined', error: { code: 'cancelled', message: 'Publish cancelled. Nothing was uploaded.' } });
    await sessions[0].settled();
    expect(hub.uploads).toHaveLength(0);
    expect(fs.existsSync(path.join(home, '.tmp')) ? fs.readdirSync(path.join(home, '.tmp')) : []).toHaveLength(0);
  });

  it('confirm with nothing waiting is 409 nothing-to-confirm', async () => {
    const answer = await post(`${await serve()}/publish/confirm`);
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ error: 'No publish is waiting to be confirmed.', code: 'nothing-to-confirm' });
  });

  it('a preflight refusal comes back in the start\'s answer as a failed session (200), with the code the dialog acts on', async () => {
    hold([{ version: '0.2.0', status: 'published' }]);
    const api = await serve();
    const started = await post(`${api}/publish`);
    expect(started.status).toBe(200);
    expect(started.body.publish).toMatchObject({ status: 'failed', error: { code: 'version-not-greater', details: { highest: '0.2.0' } } });
    expect(packCalls).toBe(0);

    HubCredentials.clear(hub.origin);
    const signedOut = await post(`${api}/publish`);
    expect(signedOut.body.publish).toMatchObject({ status: 'failed', error: { code: 'signed-out', details: { reason: 'no-credentials' } } });

    const notPackage = await post(`${await serve({ workspacePath: otherWorkspace('plain-publish', { engine: ENGINE }) })}/publish`);
    expect(notPackage.body.publish).toMatchObject({ status: 'failed', error: { code: 'not-a-package' } });
  });

  it('a session nobody confirms in time is declined (confirm-timeout)', async () => {
    const api = await serve({ confirmTimeoutMs: 30 });
    await post(`${api}/publish`);
    const ended = await until(api, ['declined', 'done', 'failed'], 2000);
    expect(ended).toMatchObject({ status: 'declined', error: { code: 'confirm-timeout' } });
    expect(hub.uploads).toHaveLength(0);
  });
});

describe('POST /api/publish/withdraw', () => {
  it('needs a JSON body, refuses nothing-open, and withdraws the open version without a second confirmation', async () => {
    const api = await serve();
    expect((await postPlain(`${api}/publish/withdraw`)).status).toBe(415);

    const nothing = await post(`${api}/publish/withdraw`);
    expect(nothing.status).toBe(409);
    expect(nothing.body).toEqual({ error: `${NAME} has no draft or version in review on ${hub.origin} to withdraw.`, code: 'nothing-open' });

    hold([{ version: '0.1.0', status: 'in_review', submittedAt: '2026-10-20T00:00:00.000Z' }]);
    const withdrawn = await post(`${api}/publish/withdraw`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.withdrawn).toMatchObject({ version: '0.1.0', status: 'in_review' });
    expect(hub.packages.get(NAME)!.versions).toHaveLength(0);
  });

  it('is 401 signed-out without credentials, and 400 not-a-package outside a package', async () => {
    HubCredentials.clear(hub.origin);
    const signedOut = await post(`${await serve()}/publish/withdraw`);
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toMatchObject({ code: 'signed-out' });
    const plain = await post(`${await serve({ workspacePath: otherWorkspace('plain-withdraw', { engine: ENGINE }) })}/publish/withdraw`);
    expect(plain.status).toBe(400);
    expect(plain.body.code).toBe('not-a-package');
  });
});

describe('POST /api/publish/version', () => {
  it('bumps the block\'s version, which the header route then reads', async () => {
    const api = await serve();
    const patch = await post(`${api}/publish/version`, { spec: 'patch' });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({ name: NAME, from: '0.1.0', to: '0.1.1', configPath: path.join(workspace, 'fluidcad.json') });
    expect((await call(`${api}/publish/package`)).body.package).toEqual({ name: NAME, version: '0.1.1' });

    const exact = await post(`${api}/publish/version`, { spec: ' 2.0.0 ' });
    expect(exact.body).toMatchObject({ from: '0.1.1', to: '2.0.0' });
    const config = JSON.parse(fs.readFileSync(path.join(workspace, 'fluidcad.json'), 'utf8'));
    expect(config.package).toMatchObject({ name: NAME, version: '2.0.0', license: 'MIT' });
  });

  it('needs a JSON body with a spec, and answers the bump\'s refusals as 400 sentences', async () => {
    const api = await serve();
    expect((await postPlain(`${api}/publish/version`)).status).toBe(415);
    for (const body of [{}, { spec: '' }, { spec: 2 }]) {
      const bad = await post(`${api}/publish/version`, body);
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'Expected { spec: "major" | "minor" | "patch" | "1.2.0" }.', code: 'bad-request' });
    }

    const bogus = await post(`${api}/publish/version`, { spec: 'bogus' });
    expect(bogus.status).toBe(400);
    expect(bogus.body).toEqual({ error: '"bogus" is not a version or a bump: use major, minor, patch, or a version such as 1.2.0.', code: 'refused' });

    const same = await post(`${api}/publish/version`, { spec: '0.1.0' });
    expect(same.status).toBe(400);
    expect(same.body).toEqual({ error: `${NAME} is already at 0.1.0.`, code: 'refused' });

    const plain = await post(`${await serve({ workspacePath: otherWorkspace('plain-version', { engine: ENGINE }) })}/publish/version`, { spec: 'patch' });
    expect(plain.status).toBe(400);
    expect(plain.body).toEqual({ error: "This workspace isn't a package — run `fluidcad package init` first.", code: 'refused' });
  });
});
