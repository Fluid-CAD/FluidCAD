import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HubConfig } from '../../src/hub/hub-config.ts';
import { HubMaintainError } from '../../src/hub/hub-maintain-error.ts';
import { HubMaintainer } from '../../src/hub/hub-maintainer.ts';
import { HubTransport } from '../../src/hub/hub-transport.ts';
import { ArchiveFixture } from '../packages/archive-fixture.ts';
import { FakeHub } from '../fixtures/fake-hub.ts';

/**
 * `HubMaintainer` (hub-plan Stage H12) against the in-process FakeHub: yank
 * and unyank, deprecation, and the listing edits after the first publish,
 * each with the account checked first (a package under another handle, a
 * token without `publish`, signed out: refused before any request about the
 * package) and the hub's refusals worded with their next step.
 */

const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000400000003080600000000000000', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

let hub: FakeHub;
let tmp: string;

beforeAll(async () => {
  hub = await FakeHub.start();
});

afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  hub.reset();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-maintainer-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function maintainer(token: string | null = hub.issueToken({ kind: 'cli', scopes: ['publish'] }).token): HubMaintainer {
  return new HubMaintainer({
    config: HubConfig.resolve({ hub: hub.origin, env: {} }),
    credential: token === null ? null : { token, handle: 'acme', source: 'env' } as never,
    version: '0.0.46',
    transport: new HubTransport({ version: '0.0.46', client: 'cli', retryDelayMs: 0 }),
  });
}

async function published(versions: string[] = ['0.1.0', '0.2.0']): Promise<void> {
  for (const version of versions) {
    await hub.addArchive(await ArchiveFixture.zip({ version }));
  }
}

async function refusal(work: Promise<unknown>): Promise<HubMaintainError> {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(HubMaintainError);
    return err as HubMaintainError;
  }
  throw new Error('expected a refusal');
}

function packageRequests(): string[] {
  return hub.requests.filter((request) => request.path.startsWith('/api/v1/packages/')).map((request) => `${request.method} ${request.path}`);
}

describe('naming the package and version', () => {
  it('takes @scope/name@version, a version alone in the package workspace, and refuses the rest with the way to name it', () => {
    const workspace = path.join(tmp, 'ws');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'fluidcad.json'), JSON.stringify({ package: { name: '@acme/kit', version: '0.2.0' } }));
    expect(HubMaintainer.versionRef('@acme/kit@0.2.0', tmp)).toEqual({ name: '@acme/kit', version: '0.2.0' });
    expect(HubMaintainer.versionRef('0.1.0', workspace)).toEqual({ name: '@acme/kit', version: '0.1.0' });
    expect(HubMaintainer.packageName(null, workspace)).toBe('@acme/kit');
    expect(() => HubMaintainer.versionRef('@acme/kit', workspace)).toThrow('Say which version of @acme/kit: @acme/kit@<version>, such as @acme/kit@0.1.0.');
    expect(() => HubMaintainer.versionRef('@acme/kit@latest', workspace)).toThrow('"latest" is not a version');
    expect(() => HubMaintainer.versionRef('@Acme/kit@0.1.0', workspace)).toThrow('is not a package name');
    expect(() => HubMaintainer.packageName(null, tmp)).toThrow('Name the package (@scope/name), or run this in its workspace.');
  });

  it('names a screenshot by its number, its id, or a unique start of its id', () => {
    const media = [{ id: 'aaaa1111-0000' }, { id: 'aaaa2222-0000' }, { id: 'bbbb3333-0000' }] as never[];
    expect((HubMaintainer.mediaOf('@acme/kit', media, '2') as { id: string }).id).toBe('aaaa2222-0000');
    expect((HubMaintainer.mediaOf('@acme/kit', media, 'BBBB') as { id: string }).id).toBe('bbbb3333-0000');
    expect((HubMaintainer.mediaOf('@acme/kit', media, 'aaaa1111-0000') as { id: string }).id).toBe('aaaa1111-0000');
    expect(() => HubMaintainer.mediaOf('@acme/kit', media, 'aaaa')).toThrow('aaaa starts 2 screenshots\' ids: give more of it.');
    expect(() => HubMaintainer.mediaOf('@acme/kit', media, '4')).toThrow('@acme/kit has 3 screenshots: there is no number 4.');
    expect(() => HubMaintainer.mediaOf('@acme/kit', media, 'abc')).toThrow('@acme/kit has no screenshot abc.');
  });

  it('reads an image’s type from its bytes and refuses anything else before sending', () => {
    const png = path.join(tmp, 'shot.png');
    const svg = path.join(tmp, 'shot.svg');
    fs.writeFileSync(png, PNG);
    fs.writeFileSync(svg, '<svg/>');
    expect(HubMaintainer.imageType(PNG)).toBe('image/png');
    expect(HubMaintainer.imageType(JPEG)).toBe('image/jpeg');
    expect(HubMaintainer.imageType(WEBP)).toBe('image/webp');
    expect(HubMaintainer.image(png)).toMatchObject({ type: 'image/png', fileName: 'shot.png' });
    expect(() => HubMaintainer.image(svg)).toThrow("shot.svg isn't a PNG, JPEG or WebP image: export it as one of those, then add it.");
  });
});

describe('the account, checked before anything about the package is sent', () => {
  it('refuses signed out, a package under another handle and a token without publish, with no package request', async () => {
    await published();
    expect((await refusal(maintainer(null).yank({ name: '@acme/kit', version: '0.2.0' }, 'x'))).code).toBe('signed-out');
    const other = await refusal(maintainer().yank({ name: '@bea-tools/kit', version: '0.2.0' }, 'x'));
    expect(other.code).toBe('forbidden');
    expect(other.message).toContain('@bea-tools/kit is under @bea-tools, but you are signed in to');
    const account = hub.issueToken({ kind: 'personal', scopes: ['account'] }).token;
    expect((await refusal(maintainer(account).deprecate('@acme/kit', 'Gone.'))).message).toContain("can't change packages (it lacks the publish scope)");
    expect(packageRequests()).toEqual([]);
  });

  it('words a refused token with the way back', async () => {
    const stale = hub.issueToken({ kind: 'cli', scopes: ['publish'] });
    stale.revoked = true;
    const err = await refusal(maintainer(stale.token).unyank({ name: '@acme/kit', version: '0.1.0' }));
    expect(err.message).toBe(`${hub.origin} no longer accepts your token (revoked or expired). Run \`fluidcad login\`, then try again.`);
  });
});

describe('yank and unyank', () => {
  it('yanks the latest (latest moves back), then unyanks it', async () => {
    await published();
    const yanked = await maintainer().yank({ name: '@acme/kit', version: '0.2.0' }, '  Breaks the bolt circle.  ');
    expect(yanked).toMatchObject({ version: '0.2.0', yanked: { reason: 'Breaks the bolt circle.' }, isLatest: false, latestVersion: '0.1.0' });
    expect(JSON.parse(hub.requestsTo('/api/v1/packages/@acme/kit/versions/0.2.0/yank')[0].body)).toEqual({ reason: 'Breaks the bolt circle.' });
    const restored = await maintainer().unyank({ name: '@acme/kit', version: '0.2.0' });
    expect(restored).toMatchObject({ yanked: null, isLatest: true, latestVersion: '0.2.0' });
  });

  it('refuses an empty reason locally, and passes on the hub’s refusals with their next step', async () => {
    await published(['0.1.0']);
    expect((await refusal(maintainer().yank({ name: '@acme/kit', version: '0.1.0' }, '   '))).message).toBe(
      'Say why with --reason: installers see it as "Yanked: <reason>" beside the version.',
    );
    expect((await refusal(maintainer().unyank({ name: '@acme/kit', version: '0.1.0' }))).message).toBe("@acme/kit@0.1.0 isn't yanked.");
    hub.packages.get('@acme/kit')!.versions.push({ version: '0.2.0', status: 'in_review' });
    const open = await refusal(maintainer().yank({ name: '@acme/kit', version: '0.2.0' }, 'x'));
    expect(open.code).toBe('not-published');
    expect(open.message).toBe(
      '@acme/kit@0.2.0 is in review: only a published version can be yanked. Only a published version can be yanked or unyanked; `fluidcad publish --withdraw` withdraws a draft or a version in review.',
    );
    expect((await refusal(maintainer().yank({ name: '@acme/kit', version: '9.9.9' }, 'x'))).code).toBe('not-found');
  });
});

describe('deprecate', () => {
  it('sets the message, which the package read then carries, and clears it', async () => {
    await published(['0.1.0']);
    expect((await maintainer().deprecate('@acme/kit', ' Use @acme/other. ')).deprecatedMessage).toBe('Use @acme/other.');
    expect(JSON.parse(hub.requestsTo('/api/v1/packages/@acme/kit').at(-1)!.body)).toEqual({ deprecatedMessage: 'Use @acme/other.' });
    expect((await maintainer().listing('@acme/kit')).listing.deprecatedMessage).toBe('Use @acme/other.');
    expect((await maintainer().deprecate('@acme/kit', null)).deprecatedMessage).toBeNull();
    expect((await refusal(maintainer().deprecate('@acme/kit', ''))).code).toBe('bad-request');
  });
});

describe('the listing', () => {
  it('sets the license on the package and on the version in review, and the links (an empty one clears)', async () => {
    await published(['0.1.0']);
    hub.packages.get('@acme/kit')!.versions.push({ version: '0.2.0', status: 'in_review', license: 'MIT' });
    const set = await maintainer().setListing('@acme/kit', { license: 'Apache-2.0', homepageUrl: 'https://acme.example/kit', repositoryUrl: null });
    expect(set.listing).toMatchObject({ license: 'Apache-2.0', homepageUrl: 'https://acme.example/kit', repositoryUrl: null });
    expect(set.openVersion).toMatchObject({ version: '0.2.0', license: 'Apache-2.0' });
    const writes = hub.requests.filter((request) => request.method === 'PATCH').map((request) => request.path);
    expect(writes).toEqual(['/api/v1/packages/@acme/kit/versions/0.2.0', '/api/v1/packages/@acme/kit']);
  });

  it('refuses a license the hub doesn’t offer with the hub’s sentence and list', async () => {
    await published(['0.1.0']);
    const err = await refusal(maintainer().setListing('@acme/kit', { license: 'WTFPL' }));
    expect(err.code).toBe('bad-request');
    expect(err.message).toBe(`The request is not valid: license: ${FakeHub.licenseRefusal('WTFPL')}`);
    expect(err.message).toContain("Use one of the hub's licenses: MIT, Apache-2.0,");
  });

  it('sets the open version’s notes, and refuses when nothing is open', async () => {
    await published(['0.1.0']);
    const none = await refusal(maintainer().notes('@acme/kit', 'New sizes.'));
    expect(none.code).toBe('nothing-open');
    expect(none.message).toContain("a version's release notes are fixed once it is approved");
    hub.packages.get('@acme/kit')!.versions.push({ version: '0.2.0', status: 'in_review', notes: '' });
    expect((await maintainer().notes('@acme/kit', 'New sizes.')).notes).toBe('New sizes.');
  });

  it('adds, orders, picks the card and removes screenshots', async () => {
    await published(['0.1.0']);
    const files = ['a.png', 'b.jpg', 'c.webp'].map((name, index) => {
      const file = path.join(tmp, name);
      fs.writeFileSync(file, [PNG, JPEG, WEBP][index]);
      return file;
    });
    const added = await maintainer().addScreenshots('@acme/kit', files, { caption: 'Hub flange' });
    expect(added.map((media) => [media.fileName, media.contentType, media.isCard, media.caption])).toEqual([
      ['a.png', 'image/png', true, 'Hub flange'],
      ['b.jpg', 'image/jpeg', false, 'Hub flange'],
      ['c.webp', 'image/webp', false, 'Hub flange'],
    ]);
    const upload = hub.requests.find((request) => request.method === 'POST' && request.path.endsWith('/media'))!;
    expect(upload.headers['content-type']).toBe('image/png');
    expect(upload.headers['content-length']).toBe(String(PNG.length));
    expect(upload.bytes.equals(PNG)).toBe(true);

    const ordered = await maintainer().orderScreenshots('@acme/kit', ['3', added[1].id.slice(0, 8)]);
    expect(ordered.media.map((media) => media.fileName)).toEqual(['c.webp', 'b.jpg', 'a.png']);
    expect((await maintainer().cardScreenshot('@acme/kit', '2')).fileName).toBe('b.jpg');
    expect((await maintainer().screenshots('@acme/kit')).media.filter((media) => media.isCard).map((media) => media.fileName)).toEqual(['b.jpg']);
    expect((await maintainer().removeScreenshot('@acme/kit', '1')).fileName).toBe('c.webp');
    expect((await maintainer().screenshots('@acme/kit')).media.map((media) => media.fileName)).toEqual(['b.jpg', 'a.png']);
    expect((await refusal(maintainer().orderScreenshots('@acme/kit', ['1', '1']))).message).toContain('is named twice');
  });
});
