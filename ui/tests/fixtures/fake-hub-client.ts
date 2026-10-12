import { vi } from 'vitest';
import type {
  HubClient,
  HubInspection,
  HubLoginState,
  HubLogoutResult,
  HubPackage,
  HubResult,
  HubSearchAnswer,
  HubSearchParams,
  HubSearchRow,
  HubStatus,
  HubVersion,
  PackageTarget,
} from '../../src/api';
import { FakePackagesClient } from './fake-packages-client';
import versionFixture from './hub-feature-tests-version.json';

/**
 * A {@link HubClient} for the Hub panel's tests (hub-plan H11): each route
 * is a `vi.fn` answering what the test put in its field, in the bridge's
 * shapes. `search` records its params and the abort signal, and can be
 * held (`holdSearches`) so a test decides when each answer lands.
 */
export class FakeHubClient implements HubClient {
  statusValue: HubStatus = FakeHubClient.status();
  answer: HubSearchAnswer = FakeHubClient.answer([FakeHubClient.row()]);
  /** A refusal the next searches answer instead (`hub-unreachable` for the offline state). */
  searchRefusal: { status: number; error: string; code?: string } | null = null;
  packages = new Map<string, HubPackage>();
  versions = new Map<string, HubVersion>();
  texts = new Map<string, string>();
  inspectRefusal: { status: number; error: string; code?: string } | null = null;
  /** The engine's sign-in, as `GET api/hub/login` answers it; tests move it on with {@link endLogin}. */
  loginValue: HubLoginState | null = null;
  /** A refusal the next `login()` answers (`hub-unreachable`). */
  loginRefusal: { status: number; error: string; code?: string } | null = null;
  /** Whether a cancel finds the browser already back (the engine keeps it pending). */
  cancelTooLate = false;
  /** What the next `logout()` answers beyond the defaults (the outcome, `envToken`…). */
  logoutResult: Partial<HubLogoutResult> = {};
  /** A refusal the next `logout()` answers (the engine didn't sign out). */
  logoutRefusal: { status: number; error: string; code?: string } | null = null;
  /** While set, `logout()` waits for it: the test sees "Signing out…". */
  logoutGate: Promise<void> | null = null;
  private logins = 0;
  /** Searches wait for {@link releaseSearches} while set. */
  holdSearches = false;
  private held: (() => void)[] = [];

  status = vi.fn(async (): Promise<HubResult<{ status: HubStatus }>> => ({ ok: true, status: this.statusValue }));

  search = vi.fn(async (params: HubSearchParams, signal?: AbortSignal): Promise<HubResult<{ answer: HubSearchAnswer }>> => {
    if (this.holdSearches) {
      await new Promise<void>((resolve) => this.held.push(resolve));
    }
    if (signal?.aborted) {
      return { ok: false, status: 0, error: 'Cancelled.', code: 'aborted' };
    }
    if (this.searchRefusal) {
      return { ok: false, ...this.searchRefusal };
    }
    return { ok: true, answer: { ...this.answer, page: params.page, request: { ...this.answer.request, page: params.page } } };
  });

  package = vi.fn(async (name: string): Promise<HubResult<{ pkg: HubPackage }>> => {
    const pkg = this.packages.get(name);
    return pkg ? { ok: true, pkg } : { ok: false, status: 404, error: `${name} isn't on http://localhost:8787.`, code: 'not-found' };
  });

  version = vi.fn(async (name: string, version: string): Promise<HubResult<{ version: HubVersion }>> => {
    const found = this.versions.get(`${name}@${version}`);
    return found ? { ok: true, version: found } : { ok: false, status: 404, error: 'not found', code: 'not-found' };
  });

  text = vi.fn(async (url: string): Promise<HubResult<{ text: string }>> => {
    const text = this.texts.get(url);
    return text === undefined ? { ok: false, status: 404, error: 'no such file', code: 'not-found' } : { ok: true, text };
  });

  inspect = vi.fn(async (request: { name: string; version: string | null; target: PackageTarget }): Promise<HubResult<{ inspection: HubInspection }>> => {
    if (this.inspectRefusal) {
      return { ok: false, ...this.inspectRefusal };
    }
    const base = FakePackagesClient.inspection();
    return {
      ok: true,
      inspection: {
        ...base,
        token: `token-${request.name}-${request.version}-${request.target}`,
        manifest: { ...base.manifest, name: request.name, version: request.version ?? '0.1.1' },
        defaultTarget: request.target,
        notes: [],
        source: { hub: 'http://localhost:8787', status: 'published', access: 'public' },
      },
    };
  });

  login = vi.fn(async (): Promise<HubResult<{ login: HubLoginState; resumed: boolean }>> => {
    if (this.loginRefusal) {
      return { ok: false, ...this.loginRefusal };
    }
    if (this.loginValue?.status === 'pending') {
      return { ok: true, login: { ...this.loginValue }, resumed: true };
    }
    this.loginValue = FakeHubClient.loginState({ id: `login-${++this.logins}` });
    return { ok: true, login: { ...this.loginValue }, resumed: false };
  });

  loginState = vi.fn(async (): Promise<HubResult<{ login: HubLoginState | null }>> => ({
    ok: true,
    login: this.loginValue ? { ...this.loginValue } : null,
  }));

  cancelLogin = vi.fn(async (): Promise<HubResult<{ login: HubLoginState | null }>> => {
    if (this.loginValue?.status === 'pending' && !this.cancelTooLate) {
      this.endLogin({ status: 'cancelled', error: 'Sign-in cancelled. Nothing was saved.' });
    }
    return { ok: true, login: this.loginValue ? { ...this.loginValue } : null };
  });

  /** The engine signs out as `fluidcad logout` does: the status is signed out after, unless FLUIDCAD_HUB_TOKEN still signs in. */
  logout = vi.fn(async (): Promise<HubResult<{ logout: HubLogoutResult }>> => {
    if (this.logoutGate) {
      await this.logoutGate;
    }
    if (this.logoutRefusal) {
      return { ok: false, ...this.logoutRefusal };
    }
    const signedIn = this.statusValue.signedIn;
    const logout: HubLogoutResult = {
      hub: this.statusValue.hubUrl,
      outcome: signedIn ? 'revoked' : 'not-signed-in',
      handle: signedIn?.handle ?? null,
      email: null,
      reason: null,
      unreachable: false,
      envToken: false,
      ...this.logoutResult,
    };
    if (!logout.envToken) {
      this.statusValue = { ...this.statusValue, signedIn: null };
    }
    return { ok: true, logout };
  });

  /** The engine's sign-in ends as `outcome` says (the browser came back, the time ran out…). */
  endLogin(outcome: Partial<HubLoginState>): void {
    this.loginValue = { ...this.loginValue!, authorizeUrl: null, ...outcome };
  }

  static loginState(extra: Partial<HubLoginState> = {}): HubLoginState {
    return {
      id: 'login-1',
      hub: 'http://localhost:8787',
      status: 'pending',
      authorizeUrl: 'http://localhost:8787/cli/authorize?response_type=code&client_id=fluidcad-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A50123%2Fcallback',
      startedAt: '2026-10-12T12:00:00.000Z',
      expiresAt: '2026-10-12T12:05:00.000Z',
      handle: null,
      code: null,
      error: null,
      ...extra,
    };
  }

  /** Let every held search answer, in order. */
  releaseSearches(): void {
    for (const release of this.held.splice(0)) {
      release();
    }
  }

  static status(extra: Partial<HubStatus> = {}): HubStatus {
    return { hubUrl: 'http://localhost:8787', reachable: true, signedIn: null, engine: '0.0.46', sdk: 1, ...extra };
  }

  static row(extra: Partial<HubSearchRow> = {}): HubSearchRow {
    const fullName = extra.fullName ?? '@acme/feature-tests';
    const [scope, name] = fullName.slice(1).split('/');
    return {
      fullName,
      scope,
      name,
      version: '0.1.1',
      description: 'The custom-feature test bench.',
      cardImageUrl: `api/hub/media/${fullName}/card-1`,
      features: [
        { id: 'boltCircle', label: 'Bolt circle', iconUrl: `api/hub/files/${fullName}/0.1.1/features/bolt-circle.svg` },
        { id: 'boss', label: 'Boss', iconUrl: null },
        { id: 'fastener', label: 'Fastener hole', iconUrl: null },
      ],
      moreFeatures: 2,
      counts: { features: 5, parts: 5, assemblies: 1 },
      likes: 0,
      installs: 2,
      publisher: { handle: scope },
      updatedAt: '2026-10-11T10:00:00.000Z',
      license: 'MIT',
      deprecated: null,
      minEngine: '0.0.45',
      sdkVersion: 1,
      compatible: true,
      local: { installed: [], pinned: null, updateAvailable: null },
      ...extra,
    };
  }

  static answer(results: HubSearchRow[], extra: Partial<HubSearchAnswer> = {}): HubSearchAnswer {
    return {
      request: {
        q: '', words: [], scopes: [], contents: [], keywords: [], units: [], licenses: [],
        engine: '0.0.46', sdk: 1, compatible: false, sort: 'likes', order: 'desc', page: 1, limit: 20,
      },
      total: results.length,
      capped: false,
      page: 1,
      limit: 20,
      results,
      facets: {
        contents: { features: 9, parts: 7, assemblies: 3 },
        units: { metric: 10, imperial: 4 },
        licenses: [{ value: 'MIT', count: 8, label: 'MIT License' }, { value: 'Apache-2.0', count: 4, label: 'Apache License 2.0' }],
        compatible: { count: 11 },
      },
      ...extra,
    };
  }

  /** `@acme/feature-tests` as the bridge details it: two versions, five features, parts then an assembly. */
  static pkg(extra: Partial<HubPackage> = {}): HubPackage {
    return {
      name: '@acme/feature-tests',
      access: 'public',
      publisher: 'acme',
      description: 'The custom-feature test bench.',
      keywords: ['e2e-search'],
      homepage: null,
      deprecatedMessage: null,
      counts: { installs: 2, likes: 0, comments: 0 },
      latestVersion: '0.1.1',
      latest: {
        version: '0.1.1',
        integrity: 'sha256-OxEErIDdT',
        size: 24_100,
        unpackedSize: 60_000,
        engine: '0.0.46',
        minEngine: '0.0.45',
        sdkVersion: 1,
        unit: 'mm',
        notes: 'H9 E2E: a keyword to search for.',
        license: 'MIT',
        publishedAt: '2026-10-11T10:00:00.000Z',
        features: [
          { id: 'fastener', exportName: 'fastener', label: 'Fastener hole', description: 'A screw clearance hole', module: 'features/fastener.feature.js', group: 'create', kind: 'tool', icon: 'fastener.svg', iconUrl: 'api/hub/files/@acme/feature-tests/0.1.1/features/fastener.svg', paramCount: 7 },
          { id: 'standoff', exportName: 'standoff', label: 'Standoff', description: null, module: 'features/standoff.feature.js', group: 'create', kind: 'tool', icon: null, iconUrl: null, paramCount: 4 },
        ],
        models: [
          { exportName: 'plateStack', name: 'Plate stack', module: 'assemblies/plate-stack.assembly.js', folder: 'assemblies', kind: 'assembly', exportKind: 'value', paramCount: 1 },
          { exportName: 'hubFlange', name: 'Hub flange', module: 'parts/hub-flange.part.js', folder: 'parts', kind: 'part', exportKind: 'value', paramCount: 1 },
          { exportName: 'pinion', name: 'Pinion', module: 'parts/pinion.part.js', folder: 'parts', kind: 'part', exportKind: 'factory', paramCount: 0 },
        ],
      },
      versions: [
        { version: '0.1.1', status: 'published', prerelease: false, integrity: 'sha256-OxEErIDdT', size: 24_100, engine: '0.0.46', minEngine: '0.0.45', sdkVersion: 1, notes: 'A keyword.', publishedAt: '2026-10-11T10:00:00.000Z', yanked: null, removed: null, isLatest: true },
        { version: '0.1.0', status: 'published', prerelease: false, integrity: 'sha256-SCTD2', size: 24_000, engine: '0.0.46', minEngine: '0.0.45', sdkVersion: 1, notes: 'First release.', publishedAt: '2026-10-10T10:00:00.000Z', yanked: null, removed: null, isLatest: false },
      ],
      compatibility: { engine: '0.0.46', sdk: 1, latestCompatible: true, newestCompatible: '0.1.1' },
      listing: {
        license: 'MIT',
        homepageUrl: null,
        repositoryUrl: null,
        media: [
          { id: 'card-1', url: 'api/hub/media/@acme/feature-tests/card-1', caption: 'pcbPlate', isCard: true, modelModule: null, width: 1600, height: 1200, position: 0 },
          { id: 'shot-2', url: 'api/hub/media/@acme/feature-tests/shot-2', caption: '', isCard: false, modelModule: 'parts/hub-flange.part.js', width: 1600, height: 1200, position: 1 },
        ],
      },
      updatedAt: '2026-10-11T10:00:00.000Z',
      local: { installed: [], pinned: null, updateAvailable: null },
      ...extra,
    };
  }

  /** The real bridge answer for `@acme/feature-tests` 0.1.1 (captured from the local dev hub). */
  static version(): HubVersion {
    return JSON.parse(JSON.stringify(versionFixture)) as HubVersion;
  }
}
