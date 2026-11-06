import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { packPackage, type PackPackageInputs, type PackPackageResult } from '../../src/packages/package-builder.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { HubConfig } from '../../src/hub/hub-config.ts';
import { HubCredentials } from '../../src/hub/hub-credentials.ts';
import { HubPublishMessages } from '../../src/hub/hub-publish-error.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { PublishRefusal, PublishSession, PublishSessionError, type HubAppPublishState } from '../../src/hub/hub-app-publish.ts';
import { FakeHub, type FakeHubVersion } from '../fixtures/fake-hub.ts';

/**
 * `PublishSession` (ui-packages-plan N3) against the in-process `FakeHub`
 * and a fake pack: the state sequence the Publish dialog follows, confirm
 * → upload → `done` with the wizard URL, cancel → `declined` with nothing
 * sent and the scratch gone, a refusal before packing → `failed` with its
 * code (and no pack), one session at a time, the confirm timeout, a dry
 * run, and the status and withdraw pass-throughs.
 *
 * The package is fixtures/package-workspace (`@acme/kit` 0.1.0), packed for
 * real once; every publish after that reuses the packed result. The home
 * (credentials, the pack's scratch) is a temp directory.
 */

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/package-workspace');
const NAME = '@acme/kit';
const ENGINE = '0.0.46';
const ENV_KEYS = ['FLUIDCAD_HOME', 'FLUIDCAD_PACKAGES', 'FLUIDCAD_HUB_TOKEN'] as const;

let hub: FakeHub;
let scratch: string;
let workspace: string;
let home: string;
let packed: PackPackageResult;
let packCalls: number;
let saved: Record<string, string | undefined>;
let sessions: PublishSession[];

type SessionOptions = {
  pack?: (inputs: PackPackageInputs) => Promise<PackPackageResult>;
  confirmTimeoutMs?: number;
  workspacePath?: string;
  hubUrl?: string;
};

/** The session as the routes make it: the hub from the env, the credentials read at each call, a transport that doesn't wait. */
function session(options: SessionOptions = {}): PublishSession {
  const env = { FLUIDCAD_HUB_URL: options.hubUrl ?? hub.origin };
  const made = new PublishSession({
    workspacePath: options.workspacePath ?? workspace,
    config: () => HubConfig.resolve({ env }),
    version: ENGINE,
    env,
    transport: new HubTransport({ version: ENGINE, client: 'app', retryDelayMs: 1 }),
    pack: options.pack ?? (async () => {
      packCalls += 1;
      return packed;
    }),
    confirmTimeoutMs: options.confirmTimeoutMs,
  });
  sessions.push(made);
  return made;
}

/** Signed in as @acme with a publishing token, the way `fluidcad login` and the Hub panel leave the credentials file. */
function signIn(scopes: string[] = ['publish']): void {
  const issued = hub.issueToken({ kind: 'cli', scopes });
  HubCredentials.write(hub.origin, { token: issued.token, tokenId: issued.id, handle: 'acme', email: 'acme@example.com' });
}

/** `$FLUIDCAD_HOME/.tmp`, where packing writes its scratch directory: gone once a session ends. */
function scratchEntries(): string[] {
  const root = path.join(home, '.tmp');
  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

function hold(versions: FakeHubVersion[], status: 'active' | 'hidden' | 'removed' = 'active'): void {
  hub.packages.set(NAME, { status, versions });
}

/** `current()` until the status is one of `statuses`, as the page polls. */
async function until(publish: PublishSession, statuses: HubAppPublishState['status'][], deadlineMs = 5000): Promise<HubAppPublishState> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const state = publish.current();
    if (state && statuses.includes(state.status)) {
      return state;
    }
    if (Date.now() > end) {
      throw new Error(`still ${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function refusal(promise: Promise<unknown>): Promise<PublishSessionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PublishSessionError);
    return err as PublishSessionError;
  }
  throw new Error('expected a refusal');
}

function thrown(call: () => unknown): PublishSessionError {
  try {
    call();
  } catch (err) {
    expect(err).toBeInstanceOf(PublishSessionError);
    return err as PublishSessionError;
  }
  throw new Error('expected a refusal');
}

/** A pack held until the test lets it finish. */
function heldPack(): { pack: (inputs: PackPackageInputs) => Promise<PackPackageResult>; release: () => void; started: Promise<void> } {
  let release = () => {};
  let begun = () => {};
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    pack: async () => {
      begun();
      await gate;
      packCalls += 1;
      return packed;
    },
  };
}

beforeAll(async () => {
  hub = await FakeHub.start();
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-hub-app-publish-'));
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
  sessions = [];
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = fs.mkdtempSync(path.join(scratch, 'home-'));
  process.env.FLUIDCAD_HOME = home;
  process.env.FLUIDCAD_PACKAGES = path.join(home, 'library');
  delete process.env.FLUIDCAD_HUB_TOKEN;
  signIn();
});

afterEach(async () => {
  for (const made of sessions) {
    made.dispose();
    await made.settled();
  }
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('PublishSession.start', () => {
  it('checks, packs once, waits to be confirmed with the summary, uploads on confirm and ends done with the wizard URL', async () => {
    const publish = session();
    expect(publish.current()).toBeNull();

    const started = await publish.start({ notes: '  ' });
    expect(started.status).toBe('packing');
    expect(started).toMatchObject({ hub: hub.origin, dryRun: false, notes: null, summary: null, result: null, error: null, confirmBy: null });
    expect(started.id).toMatch(/^[0-9a-f-]{36}$/);

    const waiting = await until(publish, ['awaiting-confirm']);
    expect(packCalls).toBe(1);
    expect(hub.uploads).toHaveLength(0);
    expect(scratchEntries()).toHaveLength(1);
    expect(waiting.summary).toMatchObject({
      hub: hub.origin,
      handle: 'acme',
      name: NAME,
      version: '0.1.0',
      size: packed.zip.length,
      files: packed.manifest.files.length + 1,
      integrity: TreeHash.ofFiles(packed.files),
      becomes: 'draft',
      replacesDraft: false,
      notes: null,
      dryRun: false,
    });
    expect(waiting.confirmBy).not.toBeNull();
    expect(new Date(waiting.confirmBy!).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    const confirmed = publish.confirm();
    expect(confirmed.status).toBe('uploading');
    expect(confirmed.progress).toEqual({ sent: 0, total: packed.zip.length });
    expect(confirmed.confirmBy).toBeNull();

    const done = await until(publish, ['done', 'failed', 'declined']);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ status: 'draft', name: NAME, version: '0.1.0', wizardUrl: `${hub.origin}/publish/${NAME}/0.1.0`, dryRun: false, replaced: false });
    expect(done.result!.integrity).toBe(TreeHash.ofFiles(packed.files));
    expect(done.summary).toEqual(waiting.summary);
    expect(done.progress).toBeNull();
    expect(done.error).toBeNull();
    expect(done.id).toBe(started.id);

    expect(packCalls).toBe(1);
    expect(hub.uploads).toHaveLength(1);
    expect(Buffer.compare(hub.uploads[0].bytes, packed.zip)).toBe(0);
    expect(hub.uploads[0].headers['user-agent']).toMatch(/; app\)$/);
    await publish.settled();
    expect(scratchEntries()).toHaveLength(0);
  });

  it('a later version with notes goes straight to review, and done carries the review URL', async () => {
    hold([{ version: '0.0.9', status: 'published', publishedAt: '2026-10-01T00:00:00.000Z' }]);
    const publish = session();
    await publish.start({ notes: ' Gears. ' });
    const waiting = await until(publish, ['awaiting-confirm']);
    expect(waiting.notes).toBe('Gears.');
    expect(waiting.summary).toMatchObject({ becomes: 'in_review', notes: 'Gears.' });
    publish.confirm();
    const done = await until(publish, ['done', 'failed', 'declined']);
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ status: 'in_review', reviewUrl: expect.stringContaining(hub.origin) });
    expect(hub.uploads[0].headers['x-fluidcad-release-notes']).toBe(encodeURIComponent('Gears.'));
  });

  it('cancel while it waits ends declined, with nothing uploaded and the scratch gone', async () => {
    const publish = session();
    await publish.start();
    await until(publish, ['awaiting-confirm']);
    expect(scratchEntries()).toHaveLength(1);

    const cancelled = publish.cancel();
    expect(cancelled!.status).toBe('declined');
    expect(cancelled!.error).toEqual({ code: 'cancelled', message: 'Publish cancelled. Nothing was uploaded.' });
    expect(cancelled!.summary).not.toBeNull();
    expect(cancelled!.confirmBy).toBeNull();

    const settled = await publish.settled();
    expect(settled!.status).toBe('declined');
    expect(hub.uploads).toHaveLength(0);
    expect(scratchEntries()).toHaveLength(0);
    // Cancelling again, or an ended session, is answered as it is.
    expect(publish.cancel()!.status).toBe('declined');
  });

  it('cancel while it packs ends declined at once, and the pack that finishes is not uploaded', async () => {
    const held = heldPack();
    const publish = session({ pack: held.pack });
    const started = await publish.start();
    expect(started.status).toBe('packing');
    await held.started;

    expect(publish.cancel()!.status).toBe('declined');
    held.release();
    const settled = await publish.settled();
    expect(settled!.status).toBe('declined');
    expect(packCalls).toBe(1);
    expect(hub.uploads).toHaveLength(0);
    expect(scratchEntries()).toHaveLength(0);
  });

  it('a session nobody confirms in time is declined, with nothing uploaded and the scratch gone', async () => {
    const publish = session({ confirmTimeoutMs: 40 });
    await publish.start();
    const waiting = await until(publish, ['awaiting-confirm']);
    expect(new Date(waiting.confirmBy!).getTime() - Date.now()).toBeLessThanOrEqual(40);

    const ended = await until(publish, ['declined', 'done', 'failed'], 2000);
    expect(ended.status).toBe('declined');
    expect(ended.error).toEqual({ code: 'confirm-timeout', message: "Nothing was uploaded: the upload wasn't confirmed within 0 seconds." });
    await publish.settled();
    expect(hub.uploads).toHaveLength(0);
    expect(scratchEntries()).toHaveLength(0);
    expect(() => publish.confirm()).toThrow(PublishSessionError);
  });

  it('a dry run never waits: it uploads with ?dryRun=1 and ends done with the summary and result.dryRun', async () => {
    const publish = session();
    await publish.start({ dryRun: true });
    const done = await until(publish, ['done', 'failed', 'declined', 'awaiting-confirm']);
    expect(done.status).toBe('done');
    expect(done.dryRun).toBe(true);
    expect(done.summary).toMatchObject({ dryRun: true, becomes: 'draft' });
    expect(done.result).toMatchObject({ dryRun: true, status: 'draft' });
    expect(hub.uploads).toHaveLength(1);
    expect(hub.uploads[0].dryRun).toBe(true);
    await publish.settled();
    expect(scratchEntries()).toHaveLength(0);
  });

  it('a refusal before packing ends failed with the publisher\'s code and details, and nothing is packed', async () => {
    hold([{ version: '0.0.9', status: 'published' }, { version: '0.0.10', status: 'in_review' }]);
    const publish = session();
    const failed = await publish.start();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'open-version-exists', details: { version: '0.0.10', status: 'in_review' } });
    expect(failed.error!.message).toBe(
      `${NAME}@0.0.10 is in review: submit, withdraw or finish it before you upload another version. Withdraw it, or finish it on the hub, then publish again.`,
    );
    expect(packCalls).toBe(0);
    expect(hub.uploads).toHaveLength(0);
    expect(scratchEntries()).toHaveLength(0);
  });

  it('a version not above the latest fails with the latest in details and the dialog\'s bump wording', async () => {
    hold([{ version: '0.2.0', status: 'published' }]);
    const failed = await session().start();
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({
      code: 'version-not-greater',
      message: `0.1.0 is not greater than 0.2.0, the highest version of ${NAME} published so far. Bump the version, then publish again.`,
      details: { highest: '0.2.0' },
    });
    expect(packCalls).toBe(0);
  });

  it('signed out, it fails with signed-out in the Hub panel\'s shape, asking the hub nothing', async () => {
    HubCredentials.clear(hub.origin);
    const failed = await session().start();
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'signed-out', message: `Not signed in to ${hub.origin}. Sign in to publish.`, details: { reason: 'no-credentials' } });
    expect(hub.requests).toHaveLength(0);
    expect(packCalls).toBe(0);
  });

  it('a token the hub refuses fails as signed-out too (token-refused)', async () => {
    HubCredentials.write(hub.origin, { token: 'fch_revoked', tokenId: null, handle: 'acme', email: null });
    const failed = await session().start();
    expect(failed.error).toMatchObject({ code: 'signed-out', details: { reason: 'token-refused' } });
    expect(failed.error!.message).toMatch(/no longer accepts your token .* Sign in again, then publish again\.$/);
  });

  it('a sign-in after a signed-out failure is seen by the next start without a restart', async () => {
    HubCredentials.clear(hub.origin);
    const publish = session();
    expect((await publish.start()).error!.code).toBe('signed-out');
    signIn();
    expect((await publish.start()).status).toBe('packing');
    await until(publish, ['awaiting-confirm']);
  });

  it('an account that is not a publisher, or has no handle, fails with the publisher\'s codes', async () => {
    // The fake answers `/me` with the account the token was issued to, so sign in again after each change.
    hub.user = { ...hub.user, canPublish: false };
    signIn();
    expect((await session().start()).error).toMatchObject({ code: 'publishing-closed' });
    hub.user = { ...hub.user, canPublish: true, handle: null };
    signIn();
    expect((await session().start()).error).toMatchObject({ code: 'forbidden', message: expect.stringContaining('has no handle yet') });
    expect(packCalls).toBe(0);
  });

  it('outside a package workspace it fails with not-a-package, and a broken block with bad-config', async () => {
    const plain = path.join(scratch, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'fluidcad.json'), JSON.stringify({ engine: ENGINE }));
    const notPackage = await session({ workspacePath: plain }).start();
    expect(notPackage.status).toBe('failed');
    expect(notPackage.error).toEqual({ code: 'not-a-package', message: "This workspace isn't a package — run `fluidcad package init` first." });

    const broken = path.join(scratch, 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'fluidcad.json'), JSON.stringify({ engine: ENGINE, package: { name: 'kit', version: '0.1.0' } }));
    const badConfig = await session({ workspacePath: broken }).start();
    expect(badConfig.error).toMatchObject({ code: 'bad-config', message: expect.stringMatching(/^fluidcad\.json has a "package" whose "name" "kit" .* Fix it, then try again\.$/) });
    expect(packCalls).toBe(0);
  });

  it('a pack refusal ends failed with the PackageBuildError code (an unsaved buffer: unsaved-changes)', async () => {
    const { PackageBuildError } = await import('../../src/packages/package-builder.ts');
    const publish = session({
      pack: async () => {
        throw new PackageBuildError('parts/demo.part.js has unsaved changes: save it, then pack again.', 'unsaved-changes');
      },
    });
    // The preflight passes (the start answers `packing`); the pack is what refuses.
    expect((await publish.start()).status).toBe('packing');
    const failed = await until(publish, ['done', 'failed', 'declined']);
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'unsaved-changes', message: 'parts/demo.part.js has unsaved changes: save it, then pack again.' });
    expect(hub.uploads).toHaveLength(0);
    await publish.settled();
    expect(scratchEntries()).toHaveLength(0);
  });

  it('a hub that refuses the upload ends failed with the hub\'s code, after the upload', async () => {
    hub.nextUpload = { error: { status: 422, code: 'bad-manifest', message: 'manifest.json: "engine" is not a version.' } };
    const publish = session();
    await publish.start();
    await until(publish, ['awaiting-confirm']);
    publish.confirm();
    const failed = await until(publish, ['done', 'failed', 'declined']);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'bad-manifest', message: expect.stringContaining('"engine" is not a version') });
    await publish.settled();
    expect(scratchEntries()).toHaveLength(0);
  });

  it('a hub that cannot be reached fails as hub-unreachable', async () => {
    const closed = await (async () => {
      const net = await import('net');
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const { port } = server.address() as { port: number };
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return `http://127.0.0.1:${port}`;
    })();
    const issued = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
    HubCredentials.write(closed, { token: issued.token, tokenId: issued.id, handle: 'acme', email: null });
    const failed = await session({ hubUrl: closed }).start();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'hub-unreachable', details: { hub: closed, cause: 'network' } });
  });

  it('refuses a second start while one runs (publish-running), and runs a new one after the last ended', async () => {
    const publish = session();
    const first = await publish.start();
    await until(publish, ['awaiting-confirm']);
    const busy = await refusal(publish.start());
    expect(busy.status).toBe(409);
    expect(busy.code).toBe('publish-running');
    expect(busy.details).toEqual({ id: first.id, status: 'awaiting-confirm' });
    expect(busy.message).toBe('A publish is already running (awaiting-confirm): wait for it to end, or cancel it first.');

    publish.cancel();
    await publish.settled();
    const second = await publish.start();
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('packing');
    expect(publish.current()!.id).toBe(second.id);
  });

  it('confirm is refused unless the session waits to be confirmed', async () => {
    const publish = session();
    expect(thrown(() => publish.confirm())).toMatchObject({ status: 409, code: 'nothing-to-confirm', message: 'No publish is waiting to be confirmed.' });
    hold([{ version: '0.2.0', status: 'published' }]);
    await publish.start();
    expect(thrown(() => publish.confirm())).toMatchObject({ code: 'nothing-to-confirm', message: 'The publish is failed, not waiting to be confirmed.' });
  });
});

describe('PublishSession.status and withdraw', () => {
  it('status passes through to the publisher, with the credentials read now', async () => {
    hold([{ version: '0.1.0', status: 'draft' }]);
    const status = await session().status(NAME);
    expect(status.name).toBe(NAME);
    expect(status.package?.openVersion).toMatchObject({ version: '0.1.0', status: 'draft' });
    expect(status.latest).toBeNull();

    HubCredentials.clear(hub.origin);
    await expect(session().status(NAME)).rejects.toMatchObject({ code: 'signed-out' });
  });

  it('withdraw deletes the open version without a second confirmation, and refuses nothing-open', async () => {
    hold([{ version: '0.1.0', status: 'in_review' }]);
    const withdrawn = await session().withdraw(NAME);
    expect(withdrawn).toMatchObject({ version: '0.1.0', status: 'in_review' });
    expect(hub.packages.get(NAME)!.versions.find((row) => row.version === '0.1.0')).toBeUndefined();

    await expect(session().withdraw(NAME)).rejects.toMatchObject({ code: 'nothing-open' });
  });
});

describe('PublishSession.packageIn', () => {
  it('answers the block, its problem, or neither', () => {
    expect(PublishSession.packageIn(workspace)).toEqual({ package: { name: NAME, version: '0.1.0' }, problem: null });
    const broken = path.join(scratch, 'broken-identity');
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'fluidcad.json'), JSON.stringify({ package: { name: NAME } }));
    expect(PublishSession.packageIn(broken)).toEqual({ package: null, problem: expect.stringContaining('without a "version"') });
    expect(PublishSession.packageIn(scratch)).toEqual({ package: null, problem: null });
  });
});

describe('PublishRefusal.appWording', () => {
  it('swaps the CLI\'s hints for the dialog\'s', () => {
    expect(PublishRefusal.appWording(`Taken. ${HubPublishMessages.BUMP_HINT}`)).toBe('Taken. Bump the version, then publish again.');
    expect(PublishRefusal.appWording(`Open. ${HubPublishMessages.STATUS_HINT}`)).toBe('Open. Withdraw it, or finish it on the hub, then publish again.');
    expect(PublishRefusal.appWording(`Gone. ${HubPublishMessages.LOGIN_HINT}`)).toBe('Gone. Sign in again, then publish again.');
    expect(PublishRefusal.appWording('Slow. The hub may still have stored it: check with `fluidcad publish --status`.')).toBe('Slow. The hub may still have stored it: check its status.');
    expect(PublishRefusal.appWording('Plain.')).toBe('Plain.');
  });
});
