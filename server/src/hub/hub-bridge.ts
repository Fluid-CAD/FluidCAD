import { SDK_VERSION } from '../../../lib/dist/sdk/version.js';
import type { PackageInspection } from '../packages/package-archive.ts';
import { PackageName } from '../packages/package-name.ts';
import { PackagePinError, PackagePins } from '../packages/package-pins.ts';
import { PackageRoots, type PackageTarget } from '../packages/package-roots.ts';
import { Semver } from '../packages/semver.ts';
import { HubClient, type HubLikeState, type HubPackageDetail, type HubPackageSocialState, type HubSearchResponse, type HubSearchResult, type HubVersionDetail } from './hub-client.ts';
import { HubConfig } from './hub-config.ts';
import { HubCredentials } from './hub-credentials.ts';
import { HubFileCache, type HubCachedFile } from './hub-file-cache.ts';
import { HubInstaller } from './hub-installer.ts';
import { HubLocalState, type HubLocalMarks } from './hub-local-state.ts';
import { HubMetaPaths } from './hub-meta-paths.ts';
import { HubProxyPaths } from './hub-proxy-paths.ts';
import { HubRequestError } from './hub-request-error.ts';
import type { HubSearchQuery } from './hub-search-query.ts';
import { HubTransport, type HubClientKind } from './hub-transport.ts';

/**
 * The hub as the engine's UI and `fluidcad search` see it (hub-plan H10,
 * HD15): the UI never calls the hub, it calls the engine's `/api/hub/*`
 * routes, which this class answers; the CLI's `search` prints the same
 * answer.
 *
 * - {@link status}: which hub, whether it answers, and who this machine is
 *   signed in as (the credentials `fluidcad login` and the app's Sign in,
 *   `HubAppLogin`, write).
 * - {@link search}: `GET /api/v1/search` with this engine's version and SDK,
 *   every package listed (`HubSearchQuery`; a row this FluidCAD can't run
 *   comes `compatible: false`), each row with the local marks
 *   (`HubLocalState`), its images on the engine's proxy paths
 *   (`HubProxyPaths`) and no publisher avatar.
 * - {@link package}: the detail, with the same marks and proxy paths.
 * - {@link version}: one version's manifest (its features' metadata with
 *   every image on the file proxy, `HubMetaPaths`), notes and README path,
 *   for the Hub panel's parameter tables and Readme tab (H11).
 * - {@link file}, {@link media}: a version's file and a package's
 *   screenshot through the disk cache (`HubFileCache`), which keeps what
 *   the hub calls immutable.
 * - {@link inspect}: the download, verified and inspected
 *   (`HubInstaller.resolve` then `fetch`), answered as the `PackageInspection`
 *   the consent dialog shows and whose token `POST /api/packages/install`
 *   takes.
 * - {@link socialState}, {@link setLiked}: the signed-in account's own state
 *   on a package and its like (H13), for the Hub panel's Like.
 *
 * Reads carry the signed-in token where an owner or reviewer sees more
 * (the detail, files, screenshots, the download), never for search. A
 * token the hub refuses (401) is dropped and the read goes again
 * anonymously, as `HubInstaller` does. What acts as the account (the
 * social routes) never goes anonymous: no credentials, or a refused token,
 * is `signed-out` (`HubBridge.social`).
 *
 * Refusals: the hub's own as {@link HubRequestError} (no answer at all is
 * status 0), the installer's as `HubInstallError`, the bridge's own (a bad
 * name, a project target with no project) as {@link HubBridgeError}.
 */

export type HubBridgeOptions = {
  /** `--hub <url>`; else `FLUIDCAD_HUB_URL`, else the default (`HubConfig`). */
  hub?: string | null;
  /** Where the hub URL and the token are read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The open project: the pins and its `packages/` copy for the local marks; null outside one. */
  project: string | null;
  /** This engine's FluidCAD version, sent as `engine`. */
  engineVersion: string;
  /** Defaults to the lib's `SDK_VERSION`, sent as `sdk`. */
  sdkVersion?: number;
  /** Which FluidCAD is asking, for the user agent. */
  client: HubClientKind;
  /** Defaults to a transport for `client`. */
  transport?: HubTransport;
  /** Defaults to `$FLUIDCAD_HOME/cache/hub`. */
  cache?: HubFileCache;
};

/** `GET /api/hub/status`. */
export type HubStatus = {
  hubUrl: string;
  /** `GET /api/v1` answered. */
  reachable: boolean;
  /** Who the stored (or `FLUIDCAD_HUB_TOKEN`) credential is; `handle` null when the hub couldn't say. Null when signed out. */
  signedIn: { handle: string | null } | null;
  /** What every search sends: this engine's version and feature SDK. */
  engine: string;
  sdk: number;
};

/** A search row as the engine hands it on: proxy paths, no avatar, the local marks. */
export type HubBridgeSearchResult = Omit<HubSearchResult, 'publisher'> & {
  publisher: { handle: string };
  local: HubLocalMarks;
};

/** `GET /api/hub/search`: the hub's `SearchResponse`, changed only in its rows. */
export type HubBridgeSearchResponse = Omit<HubSearchResponse, 'results'> & { results: HubBridgeSearchResult[] };

/** `GET /api/hub/packages/@s/n`: the hub's detail with its images on proxy paths, plus the local marks. */
export type HubBridgePackage = HubPackageDetail & { local: HubLocalMarks };

/** One feature of a version, its metadata's images on the engine's file proxy. */
export type HubBridgeVersionFeature = { id: string; exportName: string; module: string; meta: Record<string, unknown> };

/** One part or assembly of a version, with its parameters as the manifest declares them. */
export type HubBridgeVersionPart = NonNullable<HubVersionDetail['manifest']>['parts'][number];

/**
 * `GET /api/hub/packages/@s/n/versions/<v>`: what the Hub panel reads of one
 * version beyond the detail: its features' full metadata (for the parameter
 * table), its parts' parameters, its release notes and where its README is.
 */
export type HubBridgeVersion = {
  name: string;
  version: string;
  status: HubVersionDetail['status'];
  /** Who the hub answered for: an owner also sees their open version. */
  access: HubVersionDetail['access'];
  integrity: string | null;
  engine: string | null;
  minEngine: string | null;
  sdkVersion: number | null;
  unit: string | null;
  size: number | null;
  notes: string;
  publishedAt: string | null;
  yanked: HubVersionDetail['yanked'];
  isLatest: boolean;
  /** The archive's root `README.md` on the file proxy, or null when it has none. */
  readmeUrl: string | null;
  /** Null only while the version is still uploading. */
  manifest: { features: HubBridgeVersionFeature[]; parts: HubBridgeVersionPart[] } | null;
  local: HubLocalMarks;
};

/**
 * `GET /api/hub/packages/@s/n/me`: what only the signed-in account sees about
 * a package, as the hub answers it (`liked`, its lists, its Helpful marks).
 */
export type HubBridgeSocialState = HubPackageSocialState;

/** `PUT`/`DELETE /api/hub/packages/@s/n/like`: whether the account likes it now, and the package's count after the change. */
export type HubBridgeLikeState = HubLikeState;

/** A file or screenshot the bridge serves, and whether the disk cache answered it (`hit`), kept it (`miss`) or may not keep it (`none`). */
export type HubProxiedFile = HubCachedFile & { cache: 'hit' | 'miss' | 'none' };

/** `POST /api/hub/inspect`'s body. */
export type HubInspectRequest = {
  name: string;
  /** Null: the version an install by name gets (the latest this engine runs). */
  version: string | null;
  /** The root the download is inspected under, and where the dialog proposes to install it. */
  target: PackageTarget;
};

/**
 * `POST /api/hub/inspect`: the `PackageInspection` the consent dialog shows
 * (its `token` goes to `POST /api/packages/install`), plus what the hub's
 * resolution has to say beside the warnings.
 */
export type HubBridgeInspection = PackageInspection & {
  /** The target asked for: the dialog's preselected choice. */
  defaultTarget: PackageTarget;
  /** The resolution's sentences: a yanked or unpublished version, an older one picked for this engine, a refused token. */
  notes: string[];
  /** Which hub it came from, and the version's state there. */
  source: { hub: string; status: string; access: 'public' | 'owner' | 'admin' };
};

/** A refusal decided by the bridge itself, with the HTTP status the route answers. */
export class HubBridgeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'HubBridgeError';
  }
}

export class HubBridge {
  /** `GET /api/hub/status` waits at most this long for the hub. */
  static readonly STATUS_TIMEOUT_MS = 5_000;
  /** The largest file or screenshot the bridge passes on. */
  static readonly MAX_FILE_BYTES = 64 * 1024 * 1024;
  private static readonly MEDIA_ID = /^[A-Za-z0-9-]{1,64}$/;
  /** What acts as the account refused for want of one: no credentials, or a token the hub refused. */
  static readonly SIGNED_OUT = 'signed-out';
  /** A CLI sign-in made before the scope the request needs: a new sign-in grants it. */
  static readonly SIGN_IN_AGAIN = 'sign-in-again';

  readonly project: string | null;
  readonly engineVersion: string;
  readonly sdkVersion: number;
  readonly cache: HubFileCache;
  private readonly options: HubBridgeOptions;
  private readonly transport: HubTransport;
  /** A file or screenshot being fetched, by its hub URL: a second ask waits for the first. */
  private readonly inflight = new Map<string, Promise<HubProxiedFile>>();

  constructor(options: HubBridgeOptions) {
    this.options = options;
    this.project = options.project || null;
    this.engineVersion = options.engineVersion;
    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.transport = options.transport ?? new HubTransport({ version: options.engineVersion, client: options.client });
    this.cache = options.cache ?? new HubFileCache();
  }

  /** Which hub (`--hub`, `FLUIDCAD_HUB_URL`, the default), resolved at each ask; a bad URL throws `HubConfigError`. */
  config(): HubConfig {
    return HubConfig.resolve({ hub: this.options.hub, env: this.options.env });
  }

  async status(): Promise<HubStatus> {
    const config = this.config();
    const quick = new HubTransport({ version: this.engineVersion, client: this.options.client, timeoutMs: HubBridge.STATUS_TIMEOUT_MS });
    const client = new HubClient(config, this.options.transport ?? quick);
    let reachable = true;
    try {
      await client.meta();
    } catch (err) {
      if (!(err instanceof HubRequestError)) {
        throw err;
      }
      reachable = false;
    }
    return {
      hubUrl: config.origin,
      reachable,
      signedIn: await this.signedIn(config, client, reachable),
      engine: this.engineVersion,
      sdk: this.sdkVersion,
    };
  }

  async search(query: HubSearchQuery, request: { signal?: AbortSignal } = {}): Promise<HubBridgeSearchResponse> {
    const config = this.config();
    // Anonymous: the hub's answer depends on the query alone.
    const answer = await new HubClient(config, this.transport).search(query.hubParams(this.engineVersion, this.sdkVersion), request);
    const local = HubLocalState.read(this.project);
    return { ...answer, results: answer.results.map((row) => HubBridge.row(row, config.origin, local)) };
  }

  async package(name: string): Promise<HubBridgePackage> {
    HubBridge.checkName(name);
    const config = this.config();
    const detail = await this.read(config, (client) => client.package(name, { engine: this.engineVersion, sdk: this.sdkVersion }));
    if (!detail) {
      throw new HubBridgeError(404, 'not-found', `${name} isn't on ${config.origin}.`);
    }
    const offered = detail.compatibility ? detail.compatibility.newestCompatible : detail.latestVersion;
    return {
      ...detail,
      latest: detail.latest
        ? { ...detail.latest, features: detail.latest.features.map((f) => ({ ...f, iconUrl: HubProxyPaths.rewrite(f.iconUrl, config.origin) })) }
        : null,
      listing: { ...detail.listing, media: HubBridge.proxiedMedia(detail.listing.media, config.origin) },
      local: HubLocalState.read(this.project).marks(name, offered),
    };
  }

  /**
   * One version as the Hub panel reads it: the hub's `VersionDetail`
   * (with the signed-in token, so a publisher sees their open version),
   * its features' metadata with every image on the file proxy, and the
   * README's proxy path. Not kept on disk: a version's `yanked` can change,
   * while its images go through {@link file}'s cache.
   */
  async version(name: string, version: string): Promise<HubBridgeVersion> {
    HubBridge.checkName(name);
    if (!Semver.isValid(version)) {
      throw new HubBridgeError(400, 'bad-request', `${JSON.stringify(version)} is not a version, as in 1.2.0.`);
    }
    const config = this.config();
    const detail = await this.read(config, (client) => client.version(name, version));
    if (!detail) {
      throw new HubBridgeError(404, 'not-found', `${name} ${version} isn't on ${config.origin}.`);
    }
    const readme = detail.entries.find((entry) => /^readme\.md$/i.test(entry.path)) ?? null;
    return {
      name,
      version: detail.version,
      status: detail.status,
      access: detail.access,
      integrity: detail.integrity,
      engine: detail.engine,
      minEngine: detail.minEngine,
      sdkVersion: detail.sdkVersion,
      unit: detail.unit,
      size: detail.size,
      notes: detail.notes,
      publishedAt: detail.publishedAt,
      yanked: detail.yanked,
      isLatest: detail.isLatest,
      readmeUrl: readme ? HubMetaPaths.fileUrl(name, detail.version, readme.path) : null,
      manifest: detail.manifest
        ? {
          features: detail.manifest.features.map((feature) => ({
            id: feature.id,
            exportName: feature.exportName,
            module: feature.module,
            meta: HubMetaPaths.rewrite(feature.meta, feature.module, name, detail.version) ?? {},
          })),
          parts: detail.manifest.parts,
        }
        : null,
      local: HubLocalState.read(this.project).marks(name, null),
    };
  }

  /** A file inside `name@version`'s archive (`path` as the archive holds it), through the disk cache. */
  async file(name: string, version: string, path: string): Promise<HubProxiedFile> {
    HubBridge.checkName(name);
    if (!Semver.isValid(version)) {
      throw new HubBridgeError(400, 'bad-request', `${JSON.stringify(version)} is not a version, as in 1.2.0.`);
    }
    const parts = path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
      throw new HubBridgeError(400, 'bad-request', `${JSON.stringify(path)} is not a file path inside a package.`);
    }
    const config = this.config();
    return this.proxied(config.api(HubClient.fileRoute(name, version, path)), config, (client) => client.file(name, version, path));
  }

  /** A screenshot of `name` (a row's card image), through the disk cache. */
  async media(name: string, id: string): Promise<HubProxiedFile> {
    HubBridge.checkName(name);
    if (!HubBridge.MEDIA_ID.test(id)) {
      throw new HubBridgeError(400, 'bad-request', `${JSON.stringify(id)} is not a screenshot id.`);
    }
    const config = this.config();
    return this.proxied(config.api(HubClient.mediaRoute(name, id)), config, (client) => client.media(name, id));
  }

  /**
   * Downloads, verifies and inspects `name` (at `version`, else the latest
   * this engine runs) into `target`'s scratch, checked against the open
   * project's pin of that version when there is one. Nothing is installed:
   * the answer's token waits for `POST /api/packages/install` (or
   * `discard`).
   */
  async inspect(request: HubInspectRequest, options: { signal?: AbortSignal } = {}): Promise<HubBridgeInspection> {
    HubBridge.checkName(request.name);
    if (request.version !== null && !Semver.isValid(request.version)) {
      throw new HubBridgeError(400, 'bad-request', `${JSON.stringify(request.version)} is not a version, as in ${request.name}@1.2.0.`);
    }
    if (request.target === 'project' && !this.project) {
      throw new HubBridgeError(400, 'no-project', 'There is no open project to install into.');
    }
    const config = this.config();
    const installer = new HubInstaller({
      config,
      token: HubCredentials.read(config.origin, this.options.env)?.token ?? null,
      engineVersion: this.engineVersion,
      sdkVersion: this.sdkVersion,
      transport: this.transport,
    });
    const resolved = await installer.resolve({ name: request.name, version: request.version });
    const fetched = await installer.fetch(resolved, {
      root: PackageRoots.rootFor(request.target, this.project),
      pin: this.pinOf(resolved.name, resolved.version),
      signal: options.signal,
    });
    return {
      ...fetched.inspection,
      defaultTarget: request.target,
      notes: resolved.notes,
      source: { hub: resolved.hub, status: resolved.status, access: resolved.access },
    };
  }

  /** The signed-in account's own state on `name`: whether it likes it, its lists, its Helpful marks. */
  async socialState(name: string): Promise<HubBridgeSocialState> {
    HubBridge.checkName(name);
    return this.social((client) => client.socialState(name));
  }

  /** Like (`liked`) or stop liking `name` as the signed-in account; idempotent, as the hub's routes are. */
  async setLiked(name: string, liked: boolean): Promise<HubBridgeLikeState> {
    HubBridge.checkName(name);
    return this.social((client) => client.setLiked(name, liked));
  }

  // Shaping

  private static row(row: HubSearchResult, origin: string, local: HubLocalState): HubBridgeSearchResult {
    const { publisher, ...rest } = row;
    return {
      ...rest,
      cardImageUrl: HubProxyPaths.rewrite(row.cardImageUrl, origin),
      features: row.features.map((chip) => ({ ...chip, iconUrl: HubProxyPaths.rewrite(chip.iconUrl, origin) })),
      publisher: { handle: publisher.handle },
      // A version this engine can't run is no update.
      local: local.marks(row.fullName, row.compatible === false ? null : row.version),
    };
  }

  /** The screenshots on their proxy paths; one served from anywhere but the hub is left out (the UI never loads a third-party image). */
  private static proxiedMedia(media: HubPackageDetail['listing']['media'], origin: string): HubPackageDetail['listing']['media'] {
    const proxied: HubPackageDetail['listing']['media'] = [];
    for (const shot of media) {
      const url = HubProxyPaths.rewrite(shot.url, origin);
      if (url) {
        proxied.push({ ...shot, url });
      }
    }
    return proxied;
  }

  /** The open project's pinned integrity for `name@version`, when it pins exactly that version. */
  private pinOf(name: string, version: string): string | null {
    if (!this.project || !PackagePins.isProject(this.project)) {
      return null;
    }
    try {
      const pin = PackagePins.of(this.project)[name];
      return pin && pin.version === version ? pin.integrity : null;
    } catch (err) {
      if (err instanceof PackagePinError) {
        return null;
      }
      throw err;
    }
  }

  private static checkName(name: string): void {
    if (!PackageName.isValid(name)) {
      throw new HubBridgeError(400, 'bad-request', `${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
    }
  }

  // Requests

  /** Signed in as: the stored handle with no request; a token without one asks `GET /me` (a refused token is signed out). */
  private async signedIn(config: HubConfig, client: HubClient, reachable: boolean): Promise<{ handle: string | null } | null> {
    const credential = HubCredentials.read(config.origin, this.options.env);
    if (!credential) {
      return null;
    }
    if (credential.handle || !reachable) {
      return { handle: credential.handle };
    }
    try {
      const me = await client.withToken(credential.token).me();
      return { handle: me.account.handle };
    } catch (err) {
      if (err instanceof HubRequestError && err.unauthorized) {
        return null;
      }
      if (err instanceof HubRequestError) {
        return { handle: null };
      }
      throw err;
    }
  }

  /**
   * A request that acts as the signed-in account (the hub's social routes,
   * H13). Unlike a read it never goes anonymous: no credentials, or a token
   * the hub refuses (401), is 401 `signed-out`; a CLI sign-in older than the
   * `social` scope (the hub's 403 with `details.signInAgain`) is 403
   * `sign-in-again`, the hub's sentence kept. Every other refusal is the
   * hub's own: 403 `forbidden` (a personal token without the scope, a
   * suspended account), 404 `not-found` (no such public package), 429
   * `rate-limited`, status 0 (no answer).
   */
  private async social<T>(request: (client: HubClient) => Promise<T>): Promise<T> {
    const config = this.config();
    const credential = HubCredentials.read(config.origin, this.options.env);
    if (!credential) {
      throw new HubBridgeError(401, HubBridge.SIGNED_OUT, `Not signed in to ${config.origin}. Sign in to like packages.`, { reason: 'no-credentials' });
    }
    try {
      return await request(new HubClient(config, this.transport, credential.token));
    } catch (err) {
      if (err instanceof HubRequestError && err.unauthorized) {
        throw new HubBridgeError(401, HubBridge.SIGNED_OUT, `${config.origin} didn't accept this computer's sign-in. Sign in again.`, { reason: 'token-refused' });
      }
      if (err instanceof HubRequestError && err.status === 403 && HubBridge.asksToSignInAgain(err.details)) {
        throw new HubBridgeError(403, HubBridge.SIGN_IN_AGAIN, err.message, err.details);
      }
      throw err;
    }
  }

  /** The hub's 403 for a sign-in made before a scope it now grants (`details.signInAgain`). */
  private static asksToSignInAgain(details: unknown): boolean {
    return typeof details === 'object' && details !== null && (details as { signInAgain?: unknown }).signInAgain === true;
  }

  /** A client for `config`, sending the signed-in token. */
  private client(config: HubConfig): HubClient {
    return new HubClient(config, this.transport, HubCredentials.read(config.origin, this.options.env)?.token ?? null);
  }

  /** A read with the token; when the hub refuses the token, the same read again without it. */
  private async read<T>(config: HubConfig, request: (client: HubClient) => Promise<T>): Promise<T> {
    const client = this.client(config);
    try {
      return await request(client);
    } catch (err) {
      if (err instanceof HubRequestError && err.unauthorized && client.hasToken) {
        return request(client.withToken(null));
      }
      throw err;
    }
  }

  /**
   * `url` from the disk cache, else from the hub (kept when the hub calls
   * it immutable). The hub unreachable and nothing cached: the hub's error.
   */
  private async proxied(url: string, config: HubConfig, request: (client: HubClient) => Promise<Response>): Promise<HubProxiedFile> {
    const cached = await this.cache.read(url);
    if (cached) {
      return { ...cached, cache: 'hit' };
    }
    const running = this.inflight.get(url);
    if (running) {
      return running;
    }
    const fetching = this.fetchFile(url, config, request).finally(() => this.inflight.delete(url));
    this.inflight.set(url, fetching);
    return fetching;
  }

  private async fetchFile(url: string, config: HubConfig, request: (client: HubClient) => Promise<Response>): Promise<HubProxiedFile> {
    const response = await this.read(config, request);
    const body = await HubBridge.readCapped(response, config.origin);
    const headers: Record<string, string> = {};
    for (const name of HubBridge.PASSED_HEADERS) {
      const value = response.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }
    const file: HubCachedFile = { body, contentType: response.headers.get('content-type') ?? 'application/octet-stream', headers };
    if (!HubFileCache.isImmutable(response.headers.get('cache-control'))) {
      return { ...file, cache: 'none' };
    }
    await this.cache.write(url, file);
    return { ...file, cache: 'miss' };
  }

  /** The hub's headers a proxied file keeps. */
  private static readonly PASSED_HEADERS = ['content-security-policy', 'content-disposition'];

  /** The whole body, refused past {@link MAX_FILE_BYTES}. */
  private static async readCapped(response: Response, origin: string): Promise<Buffer> {
    const tooLarge = () => new HubBridgeError(502, 'too-large', `${origin} answered with a file over ${HubBridge.MAX_FILE_BYTES / (1024 * 1024)} MB.`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > HubBridge.MAX_FILE_BYTES) {
      await response.body?.cancel();
      throw tooLarge();
    }
    if (!response.body) {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > HubBridge.MAX_FILE_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
}
