import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import JSZip from 'jszip';
import { PackageName } from '../../src/packages/package-name.ts';
import { Semver } from '../../src/packages/semver.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';

/**
 * An in-process stand-in for the hub, so FluidCAD's tests never touch a
 * network (hub-plan "Tests never touch remote resources"). It mirrors the
 * real hub's shapes and error codes (`/Users/marwan/projects/hub/contract`):
 *
 * - `GET /api/v1`, `GET /api/v1/me` (bearer only), `POST /api/v1/cli/token`
 *   (camelCase body, PKCE S256, `invalid-grant` refusals),
 *   `DELETE /api/v1/me/tokens/current` (204, then 401 `unauthorized`);
 * - `GET /cli/authorize?…` redirects straight back to the loopback with a
 *   code, `state` and `request`, as an approving user would, or with
 *   `error=access_denied` when told to deny;
 * - `GET /cli/done?request=<id>` records the visit and answers a page;
 * - the publish routes (H6): `GET /api/v1/packages/@s/n` (the owner's
 *   `PackageStatus`, 404 for a package it doesn't hold), `GET …/versions/v`,
 *   `PUT …/versions/v` (records the bytes and headers; refuses a chunked
 *   body or one without `Content-Length` with `length-required`, as the
 *   hub does; answers `draft` for a package with nothing published, else
 *   `in_review`, unless {@link FakeHub.nextUpload} says otherwise; refuses
 *   an archive whose manifest names another package than the URL, as the
 *   hub does since HD30: `scope-mismatch` for another scope, else
 *   `name-mismatch`) and `DELETE …/versions/v`
 *   (withdraws an open version). The rest of the archive validation is the
 *   hub's own test;
 * - the read routes (H7, for H8's install): `GET /api/v1/packages/@s/n`
 *   answers the `PackageDetail` shape to anyone (`?engine=&sdk=` adds
 *   `compatibility`), `GET …/versions/v` the `VersionDetail` shape, and
 *   `GET …/versions/v/archive` the archive a test added with
 *   {@link FakeHub.addArchive}, with `Content-Length` and
 *   `x-fluidcad-integrity`. Anonymous readers and other accounts see
 *   published versions only; the owner (the token's handle is the scope)
 *   and admins see every state. A removed version answers 410
 *   `version-removed`. {@link FakeHub.nextDownload} makes the next download
 *   lie about its integrity or length, fail, or stall mid-body.
 * - the bridge's routes (H10): `GET /api/v1/search` answers
 *   {@link FakeHub.searchAnswer} (a fixture `SearchResponse`: no search
 *   logic of its own) and records the query; `GET …/versions/v/files/<path>`
 *   serves a file out of an added archive with the hub's safe type, its
 *   CSP and `Cache-Control` (immutable for a published version, `private,
 *   no-store` otherwise); `GET /api/v1/packages/@s/n/media/<id>` serves a
 *   screenshot added with {@link FakeHub.addMedia} (immutable once the
 *   package has a published version). The detail lists the screenshots and
 *   the latest version's features with their icon URLs.
 *
 * - the owner's lifecycle and listing routes (H12): `POST …/versions/v/yank`
 *   and `…/unyank` (the owner only, a published version only:
 *   `not-published`, `not-yanked`), `PATCH /api/v1/packages/@s/n` (license,
 *   links and `deprecatedMessage`, licenses from the hub's list with its
 *   sentence), `PATCH …/versions/v` (an open version's notes and license),
 *   `GET`/`POST …/media` and `PATCH`/`DELETE …/media/<id>` (caption, place,
 *   card). A stranger's write is 403 on a package with a published version,
 *   404 otherwise, as the hub answers.
 *
 * Tell it what to do next with {@link FakeHub.mode}: `approve` (default),
 * `deny`, `expire` (approves, then refuses the exchange as expired), `fail`
 * (approves, then the exchange answers 500), or `tamper-state` (approves
 * with a state the CLI never sent).
 */

export type FakeHubMode = 'approve' | 'deny' | 'expire' | 'fail' | 'tamper-state';

export type FakeHubUser = {
  id: string;
  handle: string | null;
  name: string;
  email: string;
  /** `Account.canPublish`; true unless set. */
  canPublish?: boolean;
  /** `Account.emailVerified`; true unless set. */
  emailVerified?: boolean;
  /** `admin` reads every package's unpublished versions; `user` unless set. */
  role?: 'user' | 'admin';
};

export type FakeHubVersionState = 'uploading' | 'draft' | 'in_review' | 'rejected' | 'published';

export type FakeHubVersion = {
  version: string;
  status: FakeHubVersionState;
  integrity?: string | null;
  size?: number | null;
  notes?: string;
  reviewNote?: string | null;
  submittedAt?: string | null;
  publishedAt?: string | null;
  /** The `.fluidpkg` the archive route serves ({@link FakeHub.addArchive} sets it with its tree hash). */
  archive?: Buffer | null;
  /** The archive's `manifest.json`, parsed. */
  manifest?: Record<string, unknown> | null;
  /** The archive's files with their sizes, sorted: `VersionDetail.entries`. */
  entries?: { path: string; size: number }[];
  engine?: string;
  minEngine?: string;
  sdkVersion?: number;
  license?: string | null;
  yanked?: { at: string; reason: string | null } | null;
  removed?: { at: string; reason: string | null } | null;
};

/** What the next archive download does instead of answering the archive whole. */
export type FakeHubDownloadPlan = {
  error?: { status: number; code: string; message: string; details?: unknown };
  /** Sent as `x-fluidcad-integrity` instead of the version's own. */
  integrity?: string;
  /** Sent as `Content-Length` instead of the archive's size. */
  contentLength?: number;
  /** Sent instead of the archive (with its own length unless `contentLength` says otherwise). */
  bytes?: Buffer;
  /** Send this many bytes, then nothing more, never ending the body. */
  stallAfterBytes?: number;
  /** Send this many bytes, then end the body short of its `Content-Length`. */
  truncateAfterBytes?: number;
};

/** One archive download the hub served (or refused). */
export type FakeHubDownload = { name: string; version: string; headers: http.IncomingHttpHeaders };

export type FakeHubPackage = {
  status: 'active' | 'hidden' | 'removed';
  versions: FakeHubVersion[];
  /** The listing (H12); the defaults when unset. */
  listing?: { license: string | null; homepageUrl: string | null; repositoryUrl: string | null };
  deprecatedMessage?: string | null;
};

/** One `PUT` the hub took: the archive's bytes, its headers and whether it was a dry run. */
export type FakeHubUpload = { name: string; version: string; bytes: Buffer; headers: http.IncomingHttpHeaders; dryRun: boolean };

/** What the next `PUT` answers instead of the default: a refusal, a state, another integrity, or a delay. */
export type FakeHubUploadPlan = {
  error?: { status: number; code: string; message: string; details?: unknown };
  status?: 'draft' | 'in_review';
  integrity?: string;
  /** Wait this long after the last byte before answering. */
  answerDelayMs?: number;
};

type IssuedToken = { id: string; token: string; kind: 'cli' | 'personal'; scopes: string[]; user: FakeHubUser; revoked: boolean };

type Authorization = {
  id: string;
  challenge: string;
  redirectUri: string;
  state: string;
  code: string | null;
  collected: boolean;
  query: Record<string, string>;
};

export type FakeHubRequest = { method: string; path: string; query: string; headers: http.IncomingHttpHeaders; body: string; bytes: Buffer };

/** A screenshot {@link FakeHub.addMedia} holds. */
export type FakeHubMedia = { id: string; name: string; bytes: Buffer; contentType: string; isCard: boolean; caption?: string; fileName?: string | null };

export class FakeHub {
  static readonly CLIENT_ID = 'fluidcad-cli';
  static readonly DEFAULT_USER: FakeHubUser = {
    id: '6f0d1a52-3c55-4a8e-9a1e-6a1e2f0b7c11',
    handle: 'acme',
    name: 'acme',
    email: 'acme@example.com',
  };
  private static readonly TOKEN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  /** The hub's license list (`SpdxLicenses.IDS`), in its picker's order. */
  static readonly LICENSES = [
    'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense',
    'MPL-2.0', 'LGPL-3.0-only', 'GPL-3.0-only', 'AGPL-3.0-only',
    'CERN-OHL-P-2.0', 'CERN-OHL-W-2.0', 'CERN-OHL-S-2.0',
    'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC0-1.0',
    'LicenseRef-Proprietary',
  ] as const;

  /** The hub's sentence for a license it doesn't offer (`SpdxLicenses.refusal`). */
  static licenseRefusal(id: string): string {
    return `${JSON.stringify(id)} isn't a license the hub offers. Use one of the hub's licenses: ${FakeHub.LICENSES.join(', ')}.`;
  }

  mode: FakeHubMode = 'approve';
  /** How long `POST /cli/token` takes to answer. */
  exchangeDelayMs = 0;
  /** How long `GET /api/v1/packages/@s/n` takes to answer (a slow hub). */
  packageReadDelayMs = 0;
  user: FakeHubUser = { ...FakeHub.DEFAULT_USER };
  /** Limits `GET /api/v1` answers instead of the hub's own (`HubLimits`). */
  limits: Record<string, number> = {};
  /** `GET /api/v1`'s `minCliVersion`; null is no minimum. */
  minCliVersion: string | null = null;
  /** The packages the default user holds, by full name. */
  readonly packages = new Map<string, FakeHubPackage>();
  /** Every `PUT` taken, dry runs included. */
  readonly uploads: FakeHubUpload[] = [];
  /** How the next `PUT` answers; used once. */
  nextUpload: FakeHubUploadPlan | null = null;
  /** Every archive download asked for. */
  readonly downloads: FakeHubDownload[] = [];
  /** How the next archive download answers; used once. */
  nextDownload: FakeHubDownloadPlan | null = null;
  /** Every request, in order. */
  readonly requests: FakeHubRequest[] = [];
  /** What `GET /api/v1/search` answers (any query); the empty shape until a test sets one. */
  searchAnswer: Record<string, unknown> = FakeHub.emptySearch();
  /** A refusal the next search answers instead; used once. */
  nextSearch: { status: number; code: string; message: string; details?: unknown } | null = null;
  /** The screenshots, by id. */
  readonly media = new Map<string, FakeHubMedia>();
  /** The `request` of every `/cli/done` visit. */
  readonly doneVisits: string[] = [];
  readonly authorizations = new Map<string, Authorization>();
  private readonly tokens = new Map<string, IssuedToken>();
  /** Statuses to answer the next requests to a path with, before answering for real. */
  private readonly failures = new Map<string, number[]>();
  private readonly server = http.createServer((req, res) => void this.handle(req, res));
  /** Kept from the start, so a late answer after {@link stop} still knows its origin. */
  private port = 0;

  private constructor() {}

  static async start(): Promise<FakeHub> {
    const hub = new FakeHub();
    await new Promise<void>((resolve) => hub.server.listen(0, '127.0.0.1', () => resolve()));
    hub.port = (hub.server.address() as AddressInfo).port;
    return hub;
  }

  /** `http://127.0.0.1:<port>`. */
  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** A token the hub would accept, as a personal token made on the web would be. */
  issueToken(options: { kind?: 'cli' | 'personal'; scopes?: string[]; user?: FakeHubUser } = {}): IssuedToken {
    const issued: IssuedToken = {
      id: crypto.randomUUID(),
      token: FakeHub.newToken(),
      kind: options.kind ?? 'personal',
      scopes: options.scopes ?? ['account', 'publish'],
      user: options.user ?? this.user,
      revoked: false,
    };
    this.tokens.set(issued.token, issued);
    return issued;
  }

  /** The token record for a token string, revoked or not. */
  tokenOf(token: string): IssuedToken | undefined {
    return this.tokens.get(token);
  }

  /** Answers the next `count` requests to `path` (e.g. `/api/v1`) with `status`. */
  failNext(path: string, status: number, count = 1): void {
    this.failures.set(path, [...(this.failures.get(path) ?? []), ...Array(count).fill(status)]);
  }

  requestsTo(path: string): FakeHubRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  /**
   * Holds `archive` (a `.fluidpkg`) as a version of the package its
   * manifest names — or of `name`, only to serve an archive under another
   * package (the `wrong-package` and HD29-archive tests) — published unless
   * `row` says otherwise, with the tree hash of its files as its integrity
   * and the manifest's engine fields. Answers the version row, which a test
   * may change afterwards (yank it, remove it).
   */
  async addArchive(archive: Buffer, row: Partial<FakeHubVersion> = {}, name?: string): Promise<FakeHubVersion> {
    const zip = await JSZip.loadAsync(archive);
    const files: Record<string, Uint8Array> = {};
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir) {
        files[entry.name] = await entry.async('uint8array');
      }
    }
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8')) as Record<string, unknown>;
    const packageName = name ?? String(manifest.name);
    const version: FakeHubVersion = {
      version: String(manifest.version),
      status: 'published',
      integrity: TreeHash.ofFiles(files),
      size: archive.length,
      publishedAt: '2026-10-10T00:00:00.000Z',
      archive,
      manifest,
      entries: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length })).sort((a, b) => (a.path < b.path ? -1 : 1)),
      engine: String(manifest.engine),
      minEngine: String(manifest.minEngine),
      sdkVersion: Number(manifest.sdkVersion),
      ...row,
    };
    const pkg = this.packages.get(packageName) ?? { status: 'active' as const, versions: [] };
    pkg.versions.push(version);
    this.packages.set(packageName, pkg);
    return version;
  }

  /** Holds a screenshot of `name` (a PNG unless told otherwise); answers its id. */
  addMedia(name: string, bytes: Buffer, options: { contentType?: string; isCard?: boolean; caption?: string; fileName?: string | null } = {}): string {
    const id = crypto.randomUUID();
    this.media.set(id, { id, name, bytes, contentType: options.contentType ?? 'image/png', isCard: options.isCard ?? true, caption: options.caption ?? '', fileName: options.fileName ?? null });
    return id;
  }

  /** The query of every search, in order. */
  searchQueries(): URLSearchParams[] {
    return this.requestsTo('/api/v1/search').map((request) => new URLSearchParams(request.query));
  }

  /** The `SearchResponse` with nothing in it, as the hub answers `q=zzzz`. */
  static emptySearch(): Record<string, unknown> {
    return {
      request: { q: '', words: [], scopes: [], contents: [], keywords: [], units: [], licenses: [], engine: null, sdk: null, compatible: false, sort: 'installs', page: 1, limit: 20 },
      total: 0,
      capped: false,
      page: 1,
      limit: 20,
      results: [],
      facets: { contents: { features: 0, parts: 0, assemblies: 0 }, keywords: [], units: { metric: 0, imperial: 0 }, licenses: [], compatible: null },
    };
  }

  /** The archive downloads of `name@version` asked for. */
  downloadsOf(name: string, version: string): FakeHubDownload[] {
    return this.downloads.filter((download) => download.name === name && download.version === version);
  }

  /** Back to an empty hub: no packages, uploads or requests, the default user, no minimum CLI. */
  reset(): void {
    this.requests.length = 0;
    this.doneVisits.length = 0;
    this.uploads.length = 0;
    this.downloads.length = 0;
    this.packages.clear();
    this.media.clear();
    this.searchAnswer = FakeHub.emptySearch();
    this.nextSearch = null;
    this.nextUpload = null;
    this.nextDownload = null;
    this.minCliVersion = null;
    this.packageReadDelayMs = 0;
    this.limits = {};
    this.mode = 'approve';
    this.user = { ...FakeHub.DEFAULT_USER };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    let bytes: Buffer;
    try {
      bytes = await FakeHub.readBody(req);
    } catch {
      // The client went away mid-body (an upload the test let stall).
      res.destroy();
      return;
    }
    const body = bytes.toString('utf8');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.search, headers: req.headers, body, bytes });

    const queued = this.failures.get(url.pathname);
    if (queued && queued.length > 0) {
      const status = queued.shift()!;
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(`<html><body>${status}</body></html>`);
      return;
    }

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/v1':
        return FakeHub.json(res, 200, this.meta());
      case 'GET /api/v1/me':
        return this.me(req, res);
      case 'GET /api/v1/search':
        return this.search(res);
      case 'POST /api/v1/cli/token':
        if (this.exchangeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.exchangeDelayMs));
        }
        return this.exchange(body, res);
      case 'DELETE /api/v1/me/tokens/current':
        return this.revokeCurrent(req, res);
      case 'GET /cli/authorize':
        return this.authorize(url, res);
      case 'GET /cli/done':
        this.doneVisits.push(url.searchParams.get('request') ?? '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Signed in</title><p>Done.</p>');
        return;
      default: {
        const file = req.method === 'GET' ? FakeHub.FILE_ROUTE.exec(url.pathname) : null;
        if (file) {
          const name = `${decodeURIComponent(file[1])}/${decodeURIComponent(file[2])}`;
          const filePath = file[4].split('/').map((part) => decodeURIComponent(part)).join('/');
          return this.fileRoute(req, res, name, decodeURIComponent(file[3]), filePath);
        }
        const media = FakeHub.MEDIA_ROUTE.exec(url.pathname);
        if (media) {
          const mediaName = `${decodeURIComponent(media[1])}/${decodeURIComponent(media[2])}`;
          if (req.method === 'GET') {
            return this.mediaRoute(res, mediaName, decodeURIComponent(media[3]));
          }
          return this.mediaWrite(req, res, body, mediaName, decodeURIComponent(media[3]));
        }
        const mediaList = FakeHub.MEDIA_LIST_ROUTE.exec(url.pathname);
        if (mediaList) {
          return this.mediaListRoute(req, res, url, bytes, `${decodeURIComponent(mediaList[1])}/${decodeURIComponent(mediaList[2])}`);
        }
        const lifecycle = req.method === 'POST' ? FakeHub.LIFECYCLE_ROUTE.exec(url.pathname) : null;
        if (lifecycle) {
          const name = `${decodeURIComponent(lifecycle[1])}/${decodeURIComponent(lifecycle[2])}`;
          return this.lifecycleRoute(req, res, body, name, decodeURIComponent(lifecycle[3]), lifecycle[4] as 'yank' | 'unyank');
        }
        const publish = FakeHub.PUBLISH_ROUTE.exec(url.pathname);
        if (publish) {
          const name = `${decodeURIComponent(publish[1])}/${decodeURIComponent(publish[2])}`;
          const version = publish[3] === undefined ? null : decodeURIComponent(publish[3]);
          if (publish[4] !== undefined) {
            return req.method === 'GET' ? this.archiveRoute(req, res, name, version!) : FakeHub.error(res, 404, 'not-found', 'No such route.');
          }
          return this.publishRoute(req, res, url, bytes, name, version);
        }
        return FakeHub.error(res, 404, 'not-found', 'No such route.');
      }
    }
  }

  private static readonly FILE_ROUTE = /^\/api\/v1\/packages\/(@[^/]+|%40[^/]+)\/([^/]+)\/versions\/([^/]+)\/files\/(.+)$/;
  private static readonly MEDIA_ROUTE = /^\/api\/v1\/packages\/(@[^/]+|%40[^/]+)\/([^/]+)\/media\/([^/]+)$/;
  private static readonly MEDIA_LIST_ROUTE = /^\/api\/v1\/packages\/(@[^/]+|%40[^/]+)\/([^/]+)\/media$/;
  private static readonly LIFECYCLE_ROUTE = /^\/api\/v1\/packages\/(@[^/]+|%40[^/]+)\/([^/]+)\/versions\/([^/]+)\/(yank|unyank)$/;
  /** The hub's safe types (`ArchiveFiles`): images by extension, text as plain text, anything else as bytes. */
  private static readonly FILE_TYPES: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.js': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
  };
  static readonly IMMUTABLE = 'public, max-age=31536000, immutable';
  static readonly PRIVATE = 'private, no-store';

  private search(res: http.ServerResponse): void {
    const plan = this.nextSearch;
    this.nextSearch = null;
    if (plan) {
      const { status, code, message, details } = plan;
      return FakeHub.json(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30, stale-while-revalidate=60' });
    res.end(JSON.stringify(this.searchAnswer));
  }

  /** `GET …/versions/v/files/<path>`: one file out of the version's archive, as this reader may see it. */
  private async fileRoute(req: http.IncomingMessage, res: http.ServerResponse, name: string, version: string, filePath: string): Promise<void> {
    const access = this.accessOf(req, name);
    if (access === null) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    const row = this.visibleRow(res, name, version, this.packages.get(name), access);
    if (!row) {
      return;
    }
    const entry = row.archive ? (await JSZip.loadAsync(row.archive)).file(filePath) : null;
    if (!entry) {
      return FakeHub.error(res, 404, 'not-found', `${name}@${version} has no file ${filePath}.`);
    }
    const bytes = await entry.async('nodebuffer');
    const dot = filePath.lastIndexOf('.');
    const type = FakeHub.FILE_TYPES[dot === -1 ? '' : filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(bytes.length),
      'cache-control': row.status === 'published' ? FakeHub.IMMUTABLE : FakeHub.PRIVATE,
      'content-security-policy': type === 'image/svg+xml' ? "default-src 'none'; style-src 'unsafe-inline'; sandbox" : "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    });
    res.end(bytes);
  }

  /** `GET /packages/@s/n/media/<id>`: a screenshot, immutable once the package has a published version. */
  private mediaRoute(res: http.ServerResponse, name: string, id: string): void {
    const shot = this.media.get(id);
    if (!shot || shot.name !== name) {
      return FakeHub.error(res, 404, 'not-found', 'No such screenshot.');
    }
    const published = this.packages.get(name)?.versions.some((v) => v.status === 'published') ?? false;
    res.writeHead(200, {
      'content-type': shot.contentType,
      'content-length': String(shot.bytes.length),
      'cache-control': published ? FakeHub.IMMUTABLE : FakeHub.PRIVATE,
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    });
    res.end(shot.bytes);
  }

  private static readonly PUBLISH_ROUTE = /^\/api\/v1\/packages\/(@[^/]+|%40[^/]+)\/([^/]+)(?:\/versions\/([^/]+)(\/archive)?)?$/;

  private async publishRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, bytes: Buffer, name: string, version: string | null): Promise<void> {
    const pkg = this.packages.get(name);
    const route = `${req.method} ${version === null ? 'package' : 'version'}`;
    if (route === 'GET package' || route === 'GET version') {
      const access = this.accessOf(req, name);
      if (access === null) {
        return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
      }
      if (route === 'GET package') {
        if (this.packageReadDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.packageReadDelayMs));
        }
        return this.packageRead(res, url, name, pkg, access);
      }
      const row = this.visibleRow(res, name, version!, pkg, access);
      if (row) {
        FakeHub.json(res, 200, this.versionDetail(name, pkg!, row, access));
      }
      return;
    }
    const token = this.bearer(req);
    if (!token) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    switch (route) {
      case 'PUT version':
        return this.upload(req, res, url, bytes, name, version!);
      case 'PATCH package':
        return this.editPackage(req, res, bytes.toString('utf8'), name);
      case 'PATCH version':
        return this.editVersion(req, res, bytes.toString('utf8'), name, version!);
      case 'DELETE version': {
        const row = pkg?.versions.find((v) => v.version === version && v.status !== 'rejected' && v.status !== 'published');
        if (!pkg || !row) {
          const published = pkg?.versions.some((v) => v.version === version);
          return published
            ? FakeHub.error(res, 409, 'version-not-open', `${name}@${version} is not a draft or in review.`)
            : FakeHub.error(res, 404, 'not-found', `No version ${name}@${version}.`);
        }
        pkg.versions.splice(pkg.versions.indexOf(row), 1);
        res.writeHead(204);
        res.end();
        return;
      }
      default:
        return FakeHub.error(res, 404, 'not-found', 'No such route.');
    }
  }

  private async upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL, bytes: Buffer, name: string, version: string): Promise<void> {
    const dryRun = ['1', 'true'].includes(url.searchParams.get('dryRun') ?? '');
    this.uploads.push({ name, version, bytes, headers: req.headers, dryRun });
    const plan = this.nextUpload ?? {};
    this.nextUpload = null;
    if ((req.headers['content-type'] ?? '') !== 'application/vnd.fluidcad.package+zip') {
      return FakeHub.error(res, 415, 'unsupported-media-type', 'Send the archive as application/vnd.fluidcad.package+zip.');
    }
    if (req.headers['content-length'] === undefined || req.headers['transfer-encoding'] !== undefined) {
      return FakeHub.error(res, 411, 'length-required', 'Send the archive with a Content-Length.');
    }
    if (plan.answerDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, plan.answerDelayMs));
    }
    // As the hub (HD30): the archive's name must be the URL's — another
    // scope first, then any other name. (A manifest name the grammar refuses
    // is the hub's `bad-manifest`, its own test.)
    const archived = await FakeHub.manifestNameOf(bytes);
    if (archived !== null && PackageName.isValid(archived) && archived !== name) {
      const scope = PackageName.scope(name);
      const [code, message] = PackageName.scope(archived) !== scope
        ? ['scope-mismatch', `The archive is ${archived}, but you're publishing as @${scope}.`]
        : ['name-mismatch', `The archive is ${archived}, but it was uploaded as ${name}.`];
      return FakeHub.json(res, 400, { error: { code, message, details: { manifest: archived, url: name } } });
    }
    if (plan.error) {
      const { status, code, message, details } = plan.error;
      return FakeHub.json(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
    }
    const pkg = this.packages.get(name) ?? { status: 'active' as const, versions: [] };
    const published = pkg.versions.some((v) => v.status === 'published');
    const status = plan.status ?? (published ? 'in_review' : 'draft');
    const integrity = plan.integrity ?? String(req.headers['x-fluidcad-integrity'] ?? '');
    const draft = pkg.versions.find((v) => v.version === version && v.status === 'draft');
    if (!dryRun) {
      if (draft) {
        pkg.versions.splice(pkg.versions.indexOf(draft), 1);
      }
      const notes = req.headers['x-fluidcad-release-notes'];
      pkg.versions.push({
        version,
        status,
        integrity,
        size: bytes.length,
        notes: typeof notes === 'string' ? decodeURIComponent(notes) : '',
        submittedAt: status === 'in_review' ? new Date().toISOString() : null,
      });
      this.packages.set(name, pkg);
    }
    FakeHub.json(res, dryRun ? 200 : 201, {
      name,
      version,
      integrity,
      size: bytes.length,
      unpackedSize: bytes.length * 2,
      status,
      wizardUrl: status === 'draft' ? `${this.origin}/publish/${name}/${version}` : null,
      reviewUrl: status === 'in_review' ? `${this.origin}/${name}/status` : null,
      replaced: Boolean(draft),
      dryRun,
    });
  }

  // The owner's lifecycle and listing routes (H12)

  /**
   * The owner's write to `name`, or the refusal already answered: 401
   * without a valid token, 403 for a stranger on a package with a published
   * version, 404 for one that isn't there or that a stranger can't see.
   */
  private owned(req: http.IncomingMessage, res: http.ServerResponse, name: string): FakeHubPackage | null {
    const token = this.bearer(req);
    if (!token) {
      FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
      return null;
    }
    const pkg = this.packages.get(name);
    const owner = token.user.handle !== null && name.startsWith(`@${token.user.handle}/`);
    if (!pkg || (!owner && !pkg.versions.some((v) => v.status === 'published'))) {
      FakeHub.error(res, 404, 'not-found', `No package ${name}.`);
      return null;
    }
    if (!owner || !token.scopes.includes('publish')) {
      FakeHub.error(res, 403, 'forbidden', `Only the owner of ${name} can change it.`);
      return null;
    }
    return pkg;
  }

  /** `POST …/versions/v/yank|unyank`. */
  private lifecycleRoute(req: http.IncomingMessage, res: http.ServerResponse, body: string, name: string, version: string, action: 'yank' | 'unyank'): void {
    const pkg = this.owned(req, res, name);
    if (!pkg) {
      return;
    }
    let reason: string | null = null;
    if (action === 'yank') {
      const parsed = FakeHub.parseJson(body) as { reason?: unknown } | null;
      reason = typeof parsed?.reason === 'string' ? parsed.reason.trim() : '';
      if (reason === '' || reason.length > 280) {
        return FakeHub.json(res, 400, {
          error: { code: 'bad-request', message: 'The request is not valid.', details: { issues: [{ path: ['reason'], message: 'Say why the version is yanked: installers see the reason beside it.' }] } },
        });
      }
    }
    const rows = pkg.versions.filter((v) => v.version === version);
    const row = rows.find((v) => v.status === 'published');
    if (!row) {
      const other = rows.at(-1);
      return other
        ? FakeHub.json(res, 409, { error: { code: 'not-published', message: `${name}@${version} is ${other.status.replace('_', ' ')}: only a published version can be ${action}ed.`, details: { status: other.status } } })
        : FakeHub.error(res, 404, 'not-found', `${name}@${version} doesn't exist.`);
    }
    if (action === 'unyank' && !row.yanked) {
      return FakeHub.error(res, 409, 'not-yanked', `${name}@${version} isn't yanked.`);
    }
    row.yanked = action === 'yank' ? { at: row.yanked?.at ?? new Date().toISOString(), reason } : null;
    const latest = FakeHub.pickLatest(pkg.versions.filter((v) => v.status === 'published'));
    FakeHub.json(res, 200, { name, version, yanked: row.yanked, isLatest: row === latest, latestVersion: latest?.version ?? null });
  }

  /** `PATCH /packages/@s/n`: the license, links and deprecation; null clears one. */
  private editPackage(req: http.IncomingMessage, res: http.ServerResponse, body: string, name: string): void {
    const pkg = this.owned(req, res, name);
    if (!pkg) {
      return;
    }
    const change = (FakeHub.parseJson(body) ?? {}) as Record<string, unknown>;
    const issues: { path: string[]; message: string }[] = [];
    if (typeof change.license === 'string' && !(FakeHub.LICENSES as readonly string[]).includes(change.license)) {
      issues.push({ path: ['license'], message: FakeHub.licenseRefusal(change.license) });
    }
    for (const key of ['homepageUrl', 'repositoryUrl']) {
      const value = change[key];
      if (typeof value === 'string' && !/^https:\/\/[^\s@/]+/.test(value)) {
        issues.push({ path: [key], message: 'Invalid URL' });
      }
    }
    if (typeof change.deprecatedMessage === 'string' && change.deprecatedMessage.trim() === '') {
      issues.push({ path: ['deprecatedMessage'], message: 'Write a message (what to use instead, or why), or send null to clear the deprecation.' });
    }
    if (issues.length > 0) {
      return FakeHub.json(res, 400, { error: { code: 'bad-request', message: 'The request is not valid.', details: { issues } } });
    }
    const listing = { ...FakeHub.listingOf(pkg) };
    for (const key of ['license', 'homepageUrl', 'repositoryUrl'] as const) {
      if (change[key] !== undefined) {
        listing[key] = change[key] as string | null;
      }
    }
    pkg.listing = listing;
    if (change.deprecatedMessage !== undefined) {
      pkg.deprecatedMessage = typeof change.deprecatedMessage === 'string' ? change.deprecatedMessage.trim() : null;
    }
    FakeHub.json(res, 200, { ...listing, deprecatedMessage: pkg.deprecatedMessage ?? null, media: this.mediaOf(name) });
  }

  /** `PATCH …/versions/v`: an open version's notes and license. */
  private editVersion(req: http.IncomingMessage, res: http.ServerResponse, body: string, name: string, version: string): void {
    const pkg = this.owned(req, res, name);
    if (!pkg) {
      return;
    }
    const row = pkg.versions.find((v) => v.version === version && (v.status === 'draft' || v.status === 'in_review'));
    if (!row) {
      const other = pkg.versions.find((v) => v.version === version);
      return other
        ? FakeHub.json(res, 409, { error: { code: 'version-not-open', message: `${name}@${version} is ${other.status.replace('_', ' ')}: only a draft or a version in review can be edited.`, details: { status: other.status } } })
        : FakeHub.error(res, 404, 'not-found', `${name}@${version} doesn't exist.`);
    }
    const change = (FakeHub.parseJson(body) ?? {}) as { notes?: unknown; license?: unknown };
    if (typeof change.license === 'string' && !(FakeHub.LICENSES as readonly string[]).includes(change.license)) {
      return FakeHub.json(res, 400, {
        error: { code: 'bad-request', message: 'The request is not valid.', details: { issues: [{ path: ['license'], message: FakeHub.licenseRefusal(change.license) }] } },
      });
    }
    if (typeof change.notes === 'string') {
      row.notes = change.notes.trim();
    }
    if (typeof change.license === 'string') {
      row.license = change.license;
    }
    FakeHub.json(res, 200, this.versionStatus(name, row));
  }

  /** `GET …/media` (the owner, or anyone once published) and `POST …/media` (the owner). */
  private mediaListRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, bytes: Buffer, name: string): void {
    if (req.method === 'GET') {
      const pkg = this.packages.get(name);
      const access = this.accessOf(req, name);
      if (!pkg || (access === 'public' && !pkg.versions.some((v) => v.status === 'published'))) {
        return FakeHub.error(res, 404, 'not-found', `No package ${name}.`);
      }
      return FakeHub.json(res, 200, { media: this.mediaOf(name), limit: 12 });
    }
    if (req.method !== 'POST' || !this.owned(req, res, name)) {
      if (req.method !== 'POST') {
        FakeHub.error(res, 404, 'not-found', 'No such route.');
      }
      return;
    }
    const type = String(req.headers['content-type'] ?? '');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
      return FakeHub.error(res, 415, 'unsupported-media-type', 'Send a PNG, JPEG or WebP image.');
    }
    if (req.headers['content-length'] === undefined) {
      return FakeHub.error(res, 411, 'length-required', 'Send the image with a Content-Length.');
    }
    if ([...this.media.values()].filter((shot) => shot.name === name).length >= 12) {
      return FakeHub.json(res, 409, { error: { code: 'too-many-screenshots', message: `${name} already has 12 screenshots.`, details: { limit: 12 } } });
    }
    const first = ![...this.media.values()].some((shot) => shot.name === name);
    const id = this.addMedia(name, bytes, { contentType: type, isCard: first, caption: url.searchParams.get('caption') ?? '', fileName: url.searchParams.get('fileName') });
    FakeHub.json(res, 201, this.mediaOf(name).find((shot) => shot.id === id));
  }

  /** `PATCH`/`DELETE …/media/<id>`: a caption, a place, the card; or delete it. */
  private mediaWrite(req: http.IncomingMessage, res: http.ServerResponse, body: string, name: string, id: string): void {
    if (!this.owned(req, res, name)) {
      return;
    }
    const shot = this.media.get(id);
    if (!shot || shot.name !== name) {
      return FakeHub.error(res, 404, 'not-found', 'No such screenshot.');
    }
    const ordered = [...this.media.values()].filter((item) => item.name === name);
    if (req.method === 'DELETE') {
      this.media.delete(id);
      if (shot.isCard) {
        const next = ordered.find((item) => item.id !== id);
        if (next) {
          next.isCard = true;
        }
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'PATCH') {
      return FakeHub.error(res, 404, 'not-found', 'No such route.');
    }
    const change = (FakeHub.parseJson(body) ?? {}) as { caption?: unknown; position?: unknown; isCard?: unknown };
    if (typeof change.caption === 'string') {
      shot.caption = change.caption;
    }
    if (change.isCard === true) {
      for (const item of ordered) {
        item.isCard = item === shot;
      }
    }
    if (typeof change.position === 'number') {
      const others = ordered.filter((item) => item !== shot);
      others.splice(Math.max(0, Math.min(change.position, others.length)), 0, shot);
      for (const item of ordered) {
        this.media.delete(item.id);
      }
      for (const item of others) {
        this.media.set(item.id, item);
      }
    }
    FakeHub.json(res, 200, this.mediaOf(name).find((item) => item.id === id));
  }

  private static listingOf(pkg: FakeHubPackage): { license: string | null; homepageUrl: string | null; repositoryUrl: string | null } {
    return pkg.listing ?? { license: null, homepageUrl: null, repositoryUrl: null };
  }

  private static parseJson(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }

  // The read routes (H7)

  /** Who is reading: `owner` (the token's handle is the scope), `admin`, `public`; null for a token the hub refuses. */
  private accessOf(req: http.IncomingMessage, name: string): 'public' | 'owner' | 'admin' | null {
    if (!req.headers.authorization) {
      return 'public';
    }
    const token = this.bearer(req);
    if (!token) {
      return null;
    }
    if (token.user.role === 'admin') {
      return 'admin';
    }
    return token.user.handle !== null && name.startsWith(`@${token.user.handle}/`) ? 'owner' : 'public';
  }

  /** `GET /packages/@s/n[?engine=&sdk=]`: `PackageDetail`, or 404 when this reader may see nothing of it. */
  private packageRead(res: http.ServerResponse, url: URL, name: string, pkg: FakeHubPackage | undefined, access: 'public' | 'owner' | 'admin'): void {
    const engine = url.searchParams.get('engine');
    const sdkText = url.searchParams.get('sdk');
    if (engine !== null && !Semver.isValid(engine)) {
      return FakeHub.error(res, 400, 'bad-request', `engine ${JSON.stringify(engine)} is not a version: send the engine's FluidCAD version, such as 0.0.46.`);
    }
    if (sdkText !== null && !/^\d{1,6}$/.test(sdkText)) {
      return FakeHub.error(res, 400, 'bad-request', 'the SDK version is a whole number');
    }
    const publicReader = access === 'public';
    const servable = pkg?.versions.some((v) => v.status === 'published' && !v.removed);
    if (!pkg || (publicReader && (pkg.status !== 'active' || !servable))) {
      return FakeHub.error(res, 404, 'not-found', `${name} doesn't exist.`);
    }
    const offer = engine !== null || sdkText !== null ? { engine, sdk: sdkText === null ? null : Number(sdkText) } : null;
    FakeHub.json(res, 200, this.packageDetail(name, pkg, access, offer));
  }

  /** The version row this reader may see, or the refusal already answered (404, 410). */
  private visibleRow(res: http.ServerResponse, name: string, version: string, pkg: FakeHubPackage | undefined, access: 'public' | 'owner' | 'admin'): FakeHubVersion | null {
    const row = pkg?.versions.findLast((v) => v.version === version);
    const publicReader = access === 'public';
    if (!pkg || !row || (publicReader && (row.status !== 'published' || pkg.status === 'removed'))) {
      FakeHub.error(res, 404, 'not-found', `${name}@${version} doesn't exist.`);
      return null;
    }
    if (row.removed) {
      FakeHub.json(res, 410, {
        error: {
          code: 'version-removed',
          message: `${name}@${version} was removed by the hub's admins.`,
          details: { reason: row.removed.reason, removedAt: row.removed.at },
        },
      });
      return null;
    }
    return row;
  }

  /** `GET …/versions/v/archive`: the bytes, as {@link nextDownload} says. */
  private async archiveRoute(req: http.IncomingMessage, res: http.ServerResponse, name: string, version: string): Promise<void> {
    this.downloads.push({ name, version, headers: req.headers });
    const access = this.accessOf(req, name);
    if (access === null) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    const plan = this.nextDownload ?? {};
    this.nextDownload = null;
    if (plan.error) {
      const { status, code, message, details } = plan.error;
      return FakeHub.json(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
    }
    const row = this.visibleRow(res, name, version, this.packages.get(name), access);
    if (!row) {
      return;
    }
    const archive = plan.bytes ?? row.archive;
    if (!archive || row.status === 'rejected') {
      return FakeHub.error(res, 404, 'not-found', `${name}@${version} has no archive.`);
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.fluidcad.package+zip',
      'content-length': String(plan.contentLength ?? archive.length),
      'x-fluidcad-integrity': plan.integrity ?? String(row.integrity ?? ''),
      etag: `"${crypto.createHash('sha256').update(archive).digest('hex')}"`,
    });
    if (plan.stallAfterBytes !== undefined) {
      // Some bytes, then silence on an open connection: `stop()` closes it.
      res.write(archive.subarray(0, plan.stallAfterBytes));
      return;
    }
    if (plan.truncateAfterBytes !== undefined) {
      // After the headers and the first bytes have reached the client, so it can't retry before the body.
      res.write(archive.subarray(0, plan.truncateAfterBytes));
      setTimeout(() => res.destroy(), 50);
      return;
    }
    res.end(archive);
  }

  /**
   * `PackageDetail` (the hub's H7 shape, with the owner's `PackageStatus`
   * fields), derived from the version rows: latest by HD11 (the highest
   * release that is neither yanked nor removed, else the highest such
   * prerelease), and `compatibility` for `offer`.
   */
  private packageDetail(
    name: string,
    pkg: FakeHubPackage,
    access: 'public' | 'owner' | 'admin',
    offer: { engine: string | null; sdk: number | null } | null,
  ): Record<string, unknown> {
    const owner = access !== 'public';
    const published = pkg.versions.filter((v) => v.status === 'published');
    const highest = [...published].sort(FakeHub.byVersion).at(-1) ?? null;
    const latest = FakeHub.pickLatest(published);
    const open = pkg.versions.find((v) => v.status === 'draft' || v.status === 'in_review' || v.status === 'uploading') ?? null;
    const rejected = pkg.versions
      .filter((v) => v.status === 'rejected' && (!highest || Semver.parse(v.version)!.compareTo(Semver.parse(highest.version)!) > 0))
      .at(-1) ?? null;
    const listed = (owner ? pkg.versions : published).slice().sort(FakeHub.byVersion).reverse();
    let compatibility: Record<string, unknown> | null = null;
    if (offer) {
      const runs = (v: FakeHubVersion) => FakeHub.compatible(v, offer);
      const newest = FakeHub.pickLatest(published.filter(runs));
      compatibility = { engine: offer.engine, sdk: offer.sdk, latestCompatible: latest !== null && runs(latest), newestCompatible: newest?.version ?? null };
    }
    return {
      name,
      status: pkg.status,
      highestVersion: highest?.version ?? null,
      latestVersion: latest?.version ?? null,
      openVersion: owner && open ? this.versionStatus(name, open) : null,
      rejectedVersion: owner && rejected ? this.versionStatus(name, rejected) : null,
      createdAt: '2026-10-10T00:00:00.000Z',
      listing: { ...FakeHub.listingOf(pkg), deprecatedMessage: pkg.deprecatedMessage ?? null, media: this.mediaOf(name) },
      access,
      publisher: name.slice(1, name.indexOf('/')),
      description: null,
      keywords: [],
      homepage: null,
      deprecatedMessage: pkg.deprecatedMessage ?? null,
      counts: { installs: 0, likes: 0, comments: 0 },
      latest: latest ? this.latestOf(name, latest) : null,
      versions: listed.map((v) => this.versionSummary(v, latest)),
      compatibility,
      updatedAt: '2026-10-10T00:00:00.000Z',
    };
  }

  private latestOf(name: string, row: FakeHubVersion): Record<string, unknown> {
    return {
      version: row.version,
      integrity: row.integrity ?? '',
      size: row.size ?? 0,
      unpackedSize: (row.size ?? 0) * 2,
      engine: row.engine ?? '0.0.46',
      minEngine: row.minEngine ?? '0.0.46',
      sdkVersion: row.sdkVersion ?? 1,
      unit: 'mm',
      notes: row.notes ?? '',
      license: null,
      publishedAt: row.publishedAt ?? null,
      features: this.featuresOf(name, row),
      models: [],
      archiveUrl: this.archiveUrl(name, row.version),
    };
  }

  /** The detail's screenshots, in the order they were added. */
  private mediaOf(name: string): Record<string, unknown>[] {
    return [...this.media.values()]
      .filter((shot) => shot.name === name)
      .map((shot, position): Record<string, unknown> => ({
        id: shot.id,
        url: `${this.origin}/api/v1/packages/${name}/media/${shot.id}`,
        contentType: shot.contentType,
        width: 800,
        height: 600,
        bytes: shot.bytes.length,
        caption: shot.caption ?? '',
        fileName: shot.fileName ?? null,
        position,
        isCard: shot.isCard,
        modelModule: null,
        createdAt: '2026-10-10T00:00:00.000Z',
      }));
  }

  /** The latest version's features as the hub's `CatalogFeature`s: the icon's path in the archive and where it is served. */
  private featuresOf(name: string, row: FakeHubVersion): Record<string, unknown>[] {
    const features = (row.manifest?.features ?? []) as { id: string; exportName: string; module: string; meta?: { label?: string; icon?: string } }[];
    return features.map((feature): Record<string, unknown> => {
      const folder = feature.module.includes('/') ? feature.module.slice(0, feature.module.lastIndexOf('/') + 1) : '';
      const icon = feature.meta?.icon ? `${folder}${feature.meta.icon.replace(/^\.\//, '')}` : null;
      return {
        id: feature.id,
        exportName: feature.exportName,
        label: feature.meta?.label ?? feature.id,
        description: null,
        module: feature.module,
        group: null,
        kind: null,
        icon,
        iconUrl: icon ? `${this.origin}/api/v1/packages/${name}/versions/${row.version}/files/${icon}` : null,
        paramCount: 0,
      };
    });
  }

  private versionSummary(row: FakeHubVersion, latest: FakeHubVersion | null): Record<string, unknown> {
    return {
      version: row.version,
      status: row.status,
      prerelease: Semver.parse(row.version)!.isPrerelease,
      integrity: row.integrity ?? null,
      size: row.size ?? null,
      engine: row.engine ?? null,
      minEngine: row.minEngine ?? null,
      sdkVersion: row.sdkVersion ?? null,
      notes: row.notes ?? '',
      publishedAt: row.publishedAt ?? null,
      yanked: row.yanked ?? null,
      removed: row.removed ?? null,
      isLatest: row === latest,
    };
  }

  private versionDetail(name: string, pkg: FakeHubPackage, row: FakeHubVersion, access: 'public' | 'owner' | 'admin'): Record<string, unknown> {
    const latest = FakeHub.pickLatest(pkg.versions.filter((v) => v.status === 'published'));
    return {
      ...this.versionStatus(name, row),
      ...(access === 'public' ? { reviewNote: null, wizardUrl: null, reviewUrl: null, submittedAt: null, reviewedAt: null } : {}),
      access,
      engine: row.engine ?? null,
      minEngine: row.minEngine ?? null,
      sdkVersion: row.sdkVersion ?? null,
      unit: 'mm',
      manifest: row.manifest ?? null,
      entries: row.entries ?? [],
      yanked: row.yanked ?? null,
      isLatest: row === latest,
      deprecatedMessage: pkg.deprecatedMessage ?? null,
      archiveUrl: row.archive && row.status !== 'rejected' && row.status !== 'uploading' ? this.archiveUrl(name, row.version) : null,
    };
  }

  private archiveUrl(name: string, version: string): string {
    return `${this.origin}/api/v1/packages/${name}/versions/${version}/archive`;
  }

  private static byVersion(a: FakeHubVersion, b: FakeHubVersion): number {
    return Semver.parse(a.version)!.compareTo(Semver.parse(b.version)!);
  }

  /** HD11 over published rows: the highest release neither yanked nor removed, else the highest such prerelease. */
  private static pickLatest(published: FakeHubVersion[]): FakeHubVersion | null {
    const candidates = published.filter((v) => !v.yanked && !v.removed);
    const releases = candidates.filter((v) => !Semver.parse(v.version)!.isPrerelease);
    return [...(releases.length > 0 ? releases : candidates)].sort(FakeHub.byVersion).at(-1) ?? null;
  }

  /** The hub's `CatalogRules.isCompatible`: `minEngine` at most the engine, the same SDK; a field not offered isn't compared. */
  private static compatible(row: FakeHubVersion, offer: { engine: string | null; sdk: number | null }): boolean {
    if (offer.engine !== null) {
      const minEngine = Semver.parse(row.minEngine ?? '0.0.0');
      if (!minEngine || minEngine.compareTo(Semver.parse(offer.engine)!) > 0) {
        return false;
      }
    }
    return offer.sdk === null || (row.sdkVersion ?? 1) === offer.sdk;
  }

  private versionStatus(name: string, row: FakeHubVersion): Record<string, unknown> {
    return {
      name,
      version: row.version,
      status: row.status,
      integrity: row.integrity ?? null,
      size: row.size ?? null,
      unpackedSize: row.size ? row.size * 2 : null,
      notes: row.notes ?? '',
      license: row.license ?? null,
      reviewNote: row.reviewNote ?? null,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
      draftExpiresAt: row.status === 'draft' ? '2026-11-09T00:00:00.000Z' : null,
      notesEdited: false,
      licenseEdited: false,
      submittedAt: row.submittedAt ?? null,
      reviewedAt: null,
      publishedAt: row.publishedAt ?? null,
      wizardUrl: row.status === 'draft' ? `${this.origin}/publish/${name}/${row.version}` : null,
      reviewUrl: row.status === 'draft' ? null : `${this.origin}/${name}/status`,
    };
  }

  private me(req: http.IncomingMessage, res: http.ServerResponse): void {
    const token = this.bearer(req);
    if (!token) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    FakeHub.json(res, 200, {
      account: {
        id: token.user.id,
        handle: token.user.handle,
        name: token.user.name,
        email: token.user.email,
        emailVerified: token.user.emailVerified ?? true,
        githubLogin: null,
        image: null,
        role: 'user',
        canPublish: token.user.canPublish ?? true,
        handleLocked: false,
        createdAt: '2026-10-10T00:00:00.000Z',
      },
      via: 'token',
      token: { id: token.id, kind: token.kind, scopes: token.scopes, suffix: token.token.slice(-4) },
    });
  }

  private revokeCurrent(req: http.IncomingMessage, res: http.ServerResponse): void {
    const token = this.bearer(req);
    if (!token) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    token.revoked = true;
    res.writeHead(204);
    res.end();
  }

  /** As an approving (or denying) user would: straight back to the loopback. */
  private authorize(url: URL, res: http.ServerResponse): void {
    const query = Object.fromEntries(url.searchParams);
    const redirectUri = query.redirect_uri ?? '';
    const valid =
      query.response_type === 'code' &&
      query.client_id === FakeHub.CLIENT_ID &&
      /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/callback$/.test(redirectUri) &&
      query.code_challenge_method === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? '') &&
      (query.state ?? '') !== '';
    if (!valid) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('This sign-in link is not valid.');
      return;
    }
    const authorization: Authorization = {
      id: crypto.randomBytes(16).toString('base64url'),
      challenge: query.code_challenge,
      redirectUri,
      state: query.state,
      code: null,
      collected: false,
      query,
    };
    this.authorizations.set(authorization.id, authorization);
    const back = new URLSearchParams();
    if (this.mode === 'deny') {
      back.set('error', 'access_denied');
    } else {
      authorization.code = crypto.randomBytes(32).toString('base64url');
      back.set('code', authorization.code);
    }
    back.set('state', this.mode === 'tamper-state' ? `${query.state}x` : query.state);
    back.set('request', authorization.id);
    res.writeHead(302, { location: `${redirectUri}?${back}` });
    res.end();
  }

  private exchange(body: string, res: http.ServerResponse): void {
    let request: Record<string, string>;
    try {
      request = JSON.parse(body);
    } catch {
      return FakeHub.error(res, 400, 'bad-request', 'The body is not JSON.');
    }
    if (request.clientId !== FakeHub.CLIENT_ID) {
      return FakeHub.error(res, 400, 'invalid-grant', "This client can't exchange codes on this hub.");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier ?? '')) {
      return FakeHub.error(res, 400, 'invalid-grant', 'The code verifier is not valid.');
    }
    const authorization = [...this.authorizations.values()].find((a) => a.code !== null && a.code === request.code);
    if (!authorization) {
      return FakeHub.error(res, 400, 'invalid-grant', 'This code is not valid.');
    }
    if (this.mode === 'fail') {
      return FakeHub.error(res, 500, 'internal', 'Something went wrong on the hub.');
    }
    if (this.mode === 'expire') {
      return FakeHub.error(res, 400, 'invalid-grant', 'This sign-in request expired. Run `fluidcad login` again.');
    }
    if (authorization.collected) {
      return FakeHub.error(res, 400, 'invalid-grant', 'This code was already used. Run `fluidcad login` again.');
    }
    if (request.redirectUri !== authorization.redirectUri) {
      return FakeHub.error(res, 400, 'invalid-grant', "The redirect URI doesn't match the one this request was made with.");
    }
    const challenge = crypto.createHash('sha256').update(request.codeVerifier).digest('base64url');
    if (challenge !== authorization.challenge) {
      return FakeHub.error(res, 400, 'invalid-grant', "The code verifier doesn't match the code challenge.");
    }
    authorization.collected = true;
    // The CLI sign-in's scopes, as the hub grants them (its `TokenRules.CLI_SCOPES`).
    const issued = this.issueToken({ kind: 'cli', scopes: ['publish', 'social'] });
    FakeHub.json(res, 200, {
      token: issued.token,
      tokenId: issued.id,
      user: { handle: issued.user.handle, name: issued.user.name, email: issued.user.email },
    });
  }

  private bearer(req: http.IncomingMessage): IssuedToken | null {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) {
      return null;
    }
    const token = this.tokens.get(match[1]);
    return token && !token.revoked ? token : null;
  }

  private meta(): Record<string, unknown> {
    return {
      name: 'FluidCAD Hub',
      apiVersion: 'v1',
      openapi: '/api/v1/openapi.json',
      minCliVersion: this.minCliVersion,
      limits: {
        archiveBytes: 26214400,
        unpackedBytes: 104857600,
        entries: 2000,
        entryBytes: 26214400,
        readmeBytes: 524288,
        releaseNotesChars: 280,
        commentChars: 4000,
        listTitleChars: 60,
        versionsPerPackagePerDay: 20,
        screenshotsPerPackage: 12,
        screenshotBytes: 2097152,
        screenshotMaxSidePx: 4096,
        screenshotCaptionChars: 140,
        screenshotTypes: ['image/png', 'image/jpeg', 'image/webp'],
        openVersionsPerPackage: 1,
        draftDays: 30,
        manifestBytes: 1048576,
        modelsPerVersion: 100,
        paramsPerModel: 100,
        sourcesBytes: 5242880,
        ...this.limits,
      },
    };
  }

  /** `fch_` + 43 base62 characters, the hub's `TokenRules.PATTERN`. */
  private static newToken(): string {
    const bytes = crypto.randomBytes(43);
    let body = '';
    for (const byte of bytes) {
      body += FakeHub.TOKEN_ALPHABET[byte % FakeHub.TOKEN_ALPHABET.length];
    }
    return `fch_${body}`;
  }

  /** The `name` an uploaded archive's `manifest.json` holds; null for bytes that aren't such an archive. */
  private static async manifestNameOf(bytes: Buffer): Promise<string | null> {
    try {
      const zip = await JSZip.loadAsync(bytes);
      const manifest = zip.file('manifest.json');
      if (!manifest) {
        return null;
      }
      const name = JSON.parse(await manifest.async('string'))?.name;
      return typeof name === 'string' ? name : null;
    } catch {
      return null;
    }
  }

  private static json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private static error(res: http.ServerResponse, status: number, code: string, message: string): void {
    FakeHub.json(res, status, { error: { code, message } });
  }

  private static readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}
