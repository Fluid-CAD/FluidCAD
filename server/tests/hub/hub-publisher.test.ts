import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { packPackage, PackageBuildError, type PackPackageInputs, type PackPackageResult } from '../../src/packages/package-builder.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { HubConfig } from '../../src/hub/hub-config.ts';
import type { ResolvedHubCredential } from '../../src/hub/hub-credentials.ts';
import { HubPublishError, HubPublishMessages } from '../../src/hub/hub-publish-error.ts';
import { HubPublisher, type HubPublishProgress, type HubPublishSummary } from '../../src/hub/hub-publisher.ts';
import { HubRequestError } from '../../src/hub/hub-request-error.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { FakeHub, type FakeHubVersion } from '../fixtures/fake-hub.ts';

/**
 * `HubPublisher` (hub-plan Stage H6) against the in-process `FakeHub`: the
 * upload's bytes and headers, draft and in-review results, every local
 * refusal (none of them sends an upload), the hub's codes as messages,
 * `status`, `withdraw`, and the scratch directory removed whatever happens.
 *
 * The package is fixtures/package-workspace (`@acme/kit` 0.1.0), packed for
 * real once; the publishes after that reuse the packed result.
 */

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/package-workspace');
const NAME = '@acme/kit';

let hub: FakeHub;
let scratch: string;
let workspace: string;
let home: string;
let packed: PackPackageResult;
let packCalls: number;
let savedHome: string | undefined;

/** The publisher as the CLI makes it, packing with `pack` (the cached result by default). */
function publisher(options: { credential?: ResolvedHubCredential | null; version?: string; pack?: (inputs: PackPackageInputs) => Promise<PackPackageResult> } = {}): HubPublisher {
  const credential = options.credential === undefined ? signedIn() : options.credential;
  return new HubPublisher({
    config: HubConfig.resolve({ hub: hub.origin, env: {} }),
    credential,
    version: options.version ?? '0.0.46',
    transport: new HubTransport({ version: '0.0.46', retryDelayMs: 1 }),
    pack: options.pack ?? (async () => {
      packCalls += 1;
      return packed;
    }),
  });
}

function signedIn(scopes: string[] = ['publish']): ResolvedHubCredential {
  const issued = hub.issueToken({ kind: 'cli', scopes });
  return { token: issued.token, tokenId: issued.id, handle: 'acme', email: 'acme@example.com', source: 'file' };
}

/** `$FLUIDCAD_HOME/.tmp`, where packing writes its scratch directory: gone once a publish ends. */
function scratchRoot(): string {
  return path.join(home, '.tmp');
}

function hold(versions: FakeHubVersion[], status: 'active' | 'hidden' | 'removed' = 'active'): void {
  hub.packages.set(NAME, { status, versions });
}

async function refusal(promise: Promise<unknown>): Promise<HubPublishError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HubPublishError);
    return err as HubPublishError;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  hub = await FakeHub.start();
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-hub-publisher-'));
  workspace = path.join(scratch, 'kit');
  fs.cpSync(FIXTURE, workspace, { recursive: true });
  packed = await packPackage({ workspacePath: workspace, fluidcadVersion: '0.0.46' });
}, 120_000);

afterAll(async () => {
  await hub.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  hub.reset();
  packCalls = 0;
  savedHome = process.env.FLUIDCAD_HOME;
  home = fs.mkdtempSync(path.join(scratch, 'home-'));
  process.env.FLUIDCAD_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.FLUIDCAD_HOME;
  } else {
    process.env.FLUIDCAD_HOME = savedHome;
  }
});

describe('HubPublisher.publish', () => {
  it('uploads the packed bytes with the tree hash, a Content-Length and the package type, and a first version is a draft', async () => {
    const steps: HubPublishProgress[] = [];
    let confirmed: HubPublishSummary | null = null;
    const result = await publisher().publish({
      workspacePath: workspace,
      onProgress: (step) => steps.push(step),
      confirm: (summary) => {
        confirmed = summary;
        expect(fs.readdirSync(scratchRoot())).toHaveLength(1);
        return true;
      },
    });

    expect(hub.uploads).toHaveLength(1);
    const upload = hub.uploads[0];
    expect(upload.name).toBe(NAME);
    expect(upload.version).toBe('0.1.0');
    expect(upload.dryRun).toBe(false);
    expect(Buffer.compare(upload.bytes, packed.zip)).toBe(0);
    expect(upload.headers['x-fluidcad-integrity']).toBe(TreeHash.ofFiles(packed.files));
    expect(upload.headers['content-length']).toBe(String(packed.zip.length));
    expect(upload.headers['transfer-encoding']).toBeUndefined();
    expect(upload.headers['content-type']).toBe('application/vnd.fluidcad.package+zip');
    expect(upload.headers['x-fluidcad-release-notes']).toBeUndefined();
    expect(upload.headers['user-agent']).toMatch(/^fluidcad\/0\.0\.46 \(/);

    expect(result!.upload.status).toBe('draft');
    expect(result!.upload.wizardUrl).toBe(`${hub.origin}/publish/${NAME}/0.1.0`);
    expect(result!.upload.integrity).toBe(TreeHash.ofFiles(packed.files));
    expect(confirmed).toMatchObject({
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
    expect(confirmed!.contents.features.map((f) => f.id)).toEqual(['acme.fastener', 'acme.standoff']);
    expect(confirmed!.contents.parts.map((p) => p.exportName)).toEqual(['spacer']);

    expect(steps.map((s) => s.step)).toEqual(expect.arrayContaining(['checking', 'packing', 'uploading', 'verifying']));
    const last = steps.filter((s) => s.step === 'uploading').at(-1) as { sent: number; total: number };
    expect(last).toEqual({ step: 'uploading', sent: packed.zip.length, total: packed.zip.length });
    expect(fs.existsSync(scratchRoot())).toBe(false);
  });

  it('goes straight to review once a version is published, with the notes percent-encoded', async () => {
    hold([{ version: '0.0.9', status: 'published', publishedAt: '2026-10-01T00:00:00.000Z' }]);
    const result = await publisher().publish({ workspacePath: workspace, notes: '  Adds a spacer — 50% lighter  ' });
    expect(result!.summary.becomes).toBe('in_review');
    expect(result!.upload.status).toBe('in_review');
    expect(result!.upload.reviewUrl).toBe(`${hub.origin}/${NAME}/status`);
    expect(hub.uploads[0].headers['x-fluidcad-release-notes']).toBe(encodeURIComponent('Adds a spacer — 50% lighter'));
  });

  it('replaces a draft of the same version', async () => {
    hold([{ version: '0.1.0', status: 'draft' }]);
    const result = await publisher().publish({ workspacePath: workspace });
    expect(result!.summary.replacesDraft).toBe(true);
    expect(result!.upload.replaced).toBe(true);
  });

  it('sends ?dryRun=1 for a dry run, asks nothing, and the hub stores nothing', async () => {
    let asked = false;
    const result = await publisher().publish({
      workspacePath: workspace,
      dryRun: true,
      confirm: () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
    expect(hub.requestsTo(`/api/v1/packages/${NAME}/versions/0.1.0`)[0].query).toBe('?dryRun=1');
    expect(hub.uploads[0].dryRun).toBe(true);
    expect(result!.upload.dryRun).toBe(true);
    expect(hub.packages.has(NAME)).toBe(false);
  });

  it('sends nothing when the confirmation declines, and removes the scratch directory', async () => {
    const result = await publisher().publish({ workspacePath: workspace, confirm: () => false });
    expect(result).toBeNull();
    expect(hub.uploads).toHaveLength(0);
    expect(fs.existsSync(scratchRoot())).toBe(false);
  });

  it('removes the scratch directory when the pack fails', async () => {
    const error = await publisher({
      pack: async () => {
        throw new PackageBuildError('parts/spacer.part.js does not build.', 'refused');
      },
    })
      .publish({ workspacePath: workspace })
      .then(() => null, (err) => err);
    expect(error).toBeInstanceOf(PackageBuildError);
    expect(fs.existsSync(scratchRoot())).toBe(false);
    expect(hub.uploads).toHaveLength(0);
  });

  it("uploads a package whose scripts and JSON files come to exactly the hub's sourcesBytes", async () => {
    hub.limits = { sourcesBytes: HubPublisher.sourcesBytes(packed.files) };
    expect(await publisher().publish({ workspacePath: workspace, dryRun: true })).not.toBeNull();
    expect(hub.uploads).toHaveLength(1);
  });

  it("refuses an answer whose integrity isn't the packed one, and removes the scratch directory", async () => {
    hub.nextUpload = { integrity: 'sha256-somethingElse=' };
    const error = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(error.code).toBe('integrity-mismatch');
    expect(error.message).toContain('sha256-somethingElse=');
    expect(fs.existsSync(scratchRoot())).toBe(false);
  });
});

describe('HubPublisher.publish refuses locally, before any upload', () => {
  afterEach(() => {
    expect(hub.uploads).toHaveLength(0);
    expect(fs.existsSync(scratchRoot())).toBe(false);
  });

  it('when signed out', async () => {
    const error = await refusal(publisher({ credential: null }).publish({ workspacePath: workspace }));
    expect(error.code).toBe('signed-out');
    expect(error.message).toBe(`Not signed in to ${hub.origin}. Run \`fluidcad login\` first.`);
    expect(hub.requests).toHaveLength(0);
  });

  it("when this CLI is older than the hub's minCliVersion, before packing", async () => {
    hub.minCliVersion = '0.0.47';
    const error = await refusal(publisher({ version: '0.0.46' }).publish({ workspacePath: workspace }));
    expect(error.code).toBe('cli-too-old');
    expect(error.message).toBe(`This FluidCAD is 0.0.46, and ${hub.origin} takes uploads from 0.0.47 or newer: update FluidCAD, then publish again.`);
    expect(packCalls).toBe(0);
  });

  it('not when the CLI is the minimum or newer, or the hub sets none', async () => {
    hub.minCliVersion = '0.0.46';
    await publisher({ version: '0.0.46' }).publish({ workspacePath: workspace, dryRun: true });
    hub.minCliVersion = null;
    await publisher({ version: '0.0.1' }).publish({ workspacePath: workspace, dryRun: true });
    expect(hub.uploads).toHaveLength(2);
    hub.uploads.length = 0;
  });

  it("when the package's scope isn't the account's handle", async () => {
    hub.user = { ...hub.user, handle: 'bea' };
    const error = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe(`${NAME} is under @acme, but you are signed in to ${hub.origin} as @bea, and you can only publish under your own scope.`);
    expect(packCalls).toBe(0);
  });

  it('when the account has no handle', async () => {
    hub.user = { ...hub.user, handle: null };
    const error = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('has no handle yet');
  });

  it("when the token can't publish", async () => {
    const error = await refusal(publisher({ credential: signedIn(['account']) }).publish({ workspacePath: workspace }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('lacks the publish scope');
  });

  it('when the account is not a publisher, or its email is unverified', async () => {
    hub.user = { ...hub.user, canPublish: false };
    const closed = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(closed.code).toBe('publishing-closed');
    expect(closed.message).toContain('invite-only for now, and @acme is not a publisher yet');

    hub.user = { ...hub.user, canPublish: true, emailVerified: false };
    const unverified = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(unverified.code).toBe('email-unverified');
    expect(unverified.message).toContain(`Verify your email address on ${hub.origin} before you publish.`);
  });

  it('when the package has no parts or assemblies (no-models)', async () => {
    const featuresOnly: PackPackageResult = { ...packed, manifest: { ...packed.manifest, parts: [] } };
    const error = await refusal(publisher({ pack: async () => featuresOnly }).publish({ workspacePath: workspace }));
    expect(error.code).toBe('no-models');
    expect(error.message).toContain('@acme/kit has no parts or assemblies. The hub shows a package through the models in its parts/ and assemblies/ folders');
  });

  it("when the archive is over the hub's limit, or the notes are", async () => {
    hub.limits = { archiveBytes: 1024 };
    const big = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(big.code).toBe('archive-too-large');
    expect(big.message).toMatch(/^The archive is [\d.]+ kB; .* takes at most 1\.0 kB\.$/);

    hub.limits = { entries: 3 };
    expect((await refusal(publisher().publish({ workspacePath: workspace }))).code).toBe('too-many-entries');

    hub.limits = {};
    const notes = await refusal(publisher().publish({ workspacePath: workspace, notes: 'x'.repeat(281) }));
    expect(notes.code).toBe('notes-too-long');
    expect(notes.message).toContain('281 characters');
  });

  it("when the scripts and JSON files together are over the hub's sourcesBytes, counted as the hub counts them", async () => {
    const sources = HubPublisher.sourcesBytes(packed.files);
    const scripts = Object.entries(packed.files).filter(([file]) => /\.(js|mjs|json)$/i.test(file));
    expect(scripts.some(([file]) => file === 'manifest.json')).toBe(true);
    expect(sources).toBe(scripts.reduce((sum, [, bytes]) => sum + bytes.length, 0));
    expect(sources).toBeLessThan(Object.values(packed.files).reduce((sum, bytes) => sum + bytes.length, 0));

    hub.limits = { sourcesBytes: sources - 1 };
    const over = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(over.code).toBe('sources-too-large');
    expect(over.local).toBe(true);
    expect(over.details).toEqual({ bytes: sources, limit: sources - 1 });
    expect(over.message).toBe(
      `The package's scripts and JSON files come to ${sources.toLocaleString('en-US')} bytes; ${hub.origin}'s package viewer takes at most ` +
        `${(sources - 1).toLocaleString('en-US')} (${HubPublisher.megabytes(sources - 1)}). ${HubPublishMessages.SOURCES_HINT}`,
    );
    expect(hub.uploads).toHaveLength(0);
  });

  it('when the version is not greater than the highest published one, before packing', async () => {
    hold([{ version: '0.2.0', status: 'published' }]);
    const lower = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(lower.code).toBe('version-not-greater');
    expect(lower.message).toBe(
      `0.1.0 is not greater than 0.2.0, the highest version of ${NAME} published so far. ${HubPublishMessages.BUMP_HINT}`,
    );

    hold([{ version: '0.1.0', status: 'published' }]);
    const same = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(same.code).toBe('version-exists');
    expect(same.message).toContain('Bump the version with `fluidcad version patch`');
    expect(packCalls).toBe(0);
  });

  it('when another version is open, or this one is in review, before packing', async () => {
    hold([{ version: '0.0.9', status: 'published' }, { version: '0.0.10', status: 'in_review' }]);
    const other = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(other.code).toBe('open-version-exists');
    expect(other.message).toBe(
      `${NAME}@0.0.10 is in review: submit, withdraw or finish it before you upload another version. ${HubPublishMessages.STATUS_HINT}`,
    );
    expect(other.details).toEqual({ version: '0.0.10', status: 'in_review' });

    hold([{ version: '0.0.9', status: 'draft' }]);
    expect((await refusal(publisher().publish({ workspacePath: workspace }))).message).toContain(`${NAME}@0.0.9 is a draft`);

    hold([{ version: '0.0.9', status: 'published' }, { version: '0.1.0', status: 'in_review' }]);
    const review = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(review.code).toBe('in-review');
    expect(review.message).toBe(`${NAME}@0.1.0 is in review: withdraw it first to upload it again. ${HubPublishMessages.STATUS_HINT}`);
    expect(packCalls).toBe(0);
  });

  it('when the hub has hidden the package', async () => {
    hold([{ version: '0.0.9', status: 'published' }], 'hidden');
    expect((await refusal(publisher().publish({ workspacePath: workspace }))).code).toBe('package-unavailable');
  });
});

describe("the hub's refusals as messages", () => {
  const cases: [code: string, status: number, message: string, expected: string][] = [
    ['publishing-closed', 403, 'Publishing on the hub is invite-only for now: your account is not a publisher yet.', "The hub's admins grant publishing"],
    ['open-version-exists', 409, '@acme/kit@0.0.9 is a draft: submit, withdraw or finish it before you upload another version.', HubPublishMessages.STATUS_HINT],
    ['in-review', 409, '@acme/kit@0.1.0 is in review: withdraw it first to upload it again.', HubPublishMessages.STATUS_HINT],
    ['version-exists', 409, '@acme/kit@0.1.0 is already published, and a published version never changes: bump the version.', HubPublishMessages.BUMP_HINT],
    ['version-not-greater', 409, '0.1.0 is not greater than 0.2.0: bump the version.', HubPublishMessages.BUMP_HINT],
    ['email-unverified', 403, 'Verify your email address on the hub before you publish.', 'Verify it from the email the hub sent'],
    ['forbidden', 403, 'You can only publish under your own scope, @acme.', 'You can only publish under your own scope, @acme.'],
    ['scope-mismatch', 400, 'Feature id other.standoff is not under the scope acme.', "A package's feature ids start with its scope"],
    ['publish-daily-limit', 429, '@acme/kit had 20 uploads today (UTC), the most the hub takes in a day: try again tomorrow.', 'try again tomorrow.'],
    ['rate-limited', 429, 'Too many uploads in a minute: wait a moment and try again.', 'wait a moment'],
    ['archive-too-large', 413, 'The archive is 30.0 MB; the hub takes at most 25.0 MB.', 'at most 25.0 MB'],
    ['sources-too-large', 422, "The package's scripts and JSON files come to 6,000,000 bytes; the package viewer takes at most 5,242,880 (5.0 MB).", HubPublishMessages.SOURCES_HINT],
  ];

  it.each(cases)('%s keeps the hub sentence and adds its next step', async (code, status, message, expected) => {
    hub.nextUpload = { error: { status, code, message } };
    const error = await refusal(publisher().publish({ workspacePath: workspace }));
    expect(error.code).toBe(code);
    expect(error.local).toBe(false);
    expect(error.message.startsWith(message)).toBe(true);
    expect(error.message).toContain(expected);
    expect(fs.existsSync(scratchRoot())).toBe(false);
  });

  it("the hub's sources-too-large sentence, which already ends with the hint, is not given it twice", () => {
    const sentence = "The package's scripts and JSON files come to 6,000,000 bytes; the package viewer takes at most 5,242,880 (5.0 MB). Move large data out of .js and .json files, or split the package.";
    const error = HubPublishError.fromHub(new HubRequestError(422, 'sources-too-large', sentence, { details: { bytes: 6_000_000, limit: 5_242_880 } }), 'https://hub.test');
    expect(error.message).toBe(sentence);
    expect(error.details).toEqual({ bytes: 6_000_000, limit: 5_242_880 });
  });

  it('a revoked token asks to sign in again', () => {
    const error = HubPublishError.fromHub(new HubRequestError(401, 'unauthorized', 'This API token is not valid.'), 'https://hub.test');
    expect(error.message).toBe('https://hub.test no longer accepts your token (revoked or expired). Run `fluidcad login`, then publish again.');
  });

  it("a timeout after the last byte says the hub may still have stored it", () => {
    const error = HubPublishError.fromHub(new HubRequestError(0, 'timeout', "https://hub.test didn't answer within 2 min of the upload's last byte."), 'https://hub.test');
    expect(error.message).toContain('check with `fluidcad publish --status`');
  });
});

describe('HubPublisher.status', () => {
  it('answers no package when the hub has none for this account', async () => {
    expect(await publisher().status(NAME)).toEqual({ name: NAME, package: null, latest: null });
  });

  it('answers the open version, the latest rejection and the latest published version', async () => {
    hold([
      { version: '0.1.0', status: 'published', publishedAt: '2026-10-02T00:00:00.000Z', integrity: 'sha256-a=' },
      { version: '0.2.0', status: 'rejected', reviewNote: 'The spacer has no fillet.' },
      { version: '0.2.0', status: 'in_review', submittedAt: '2026-10-09T00:00:00.000Z' },
    ]);
    const status = await publisher().status(NAME);
    expect(status.package!.openVersion).toMatchObject({ version: '0.2.0', status: 'in_review', reviewUrl: `${hub.origin}/${NAME}/status` });
    expect(status.package!.rejectedVersion).toMatchObject({ version: '0.2.0', reviewNote: 'The spacer has no fillet.' });
    expect(status.latest).toMatchObject({ version: '0.1.0', status: 'published', integrity: 'sha256-a=' });
  });
});

describe('HubPublisher.withdraw', () => {
  it('withdraws the open version once confirmed', async () => {
    hold([{ version: '0.1.0', status: 'draft' }]);
    const withdrawn = await publisher().withdraw(NAME, { confirm: (open) => open.version === '0.1.0' });
    expect(withdrawn).toMatchObject({ version: '0.1.0', status: 'draft' });
    expect(hub.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([`/api/v1/packages/${NAME}/versions/0.1.0`]);
    expect(hub.packages.get(NAME)!.versions).toHaveLength(0);
  });

  it('withdraws nothing when the confirmation declines', async () => {
    hold([{ version: '0.1.0', status: 'in_review' }]);
    expect(await publisher().withdraw(NAME, { confirm: () => false })).toBeNull();
    expect(hub.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('refuses when nothing is open', async () => {
    hold([{ version: '0.1.0', status: 'published' }]);
    const error = await refusal(publisher().withdraw(NAME));
    expect(error.code).toBe('nothing-open');
    expect(error.message).toBe(`${NAME} has no draft or version in review on ${hub.origin} to withdraw.`);
  });
});
