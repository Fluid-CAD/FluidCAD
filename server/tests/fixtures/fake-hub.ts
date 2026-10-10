import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import JSZip from 'jszip';
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
 *   `in_review`, unless {@link FakeHub.nextUpload} says otherwise) and
 *   `DELETE …/versions/v` (withdraws an open version). The real archive
 *   validation is the hub's own test;
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
  engine?: string;
  minEngine?: string;
  sdkVersion?: number;
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

export type FakeHubPackage = { status: 'active' | 'hidden' | 'removed'; versions: FakeHubVersion[] };

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

export class FakeHub {
  static readonly CLIENT_ID = 'fluidcad-cli';
  static readonly DEFAULT_USER: FakeHubUser = {
    id: '6f0d1a52-3c55-4a8e-9a1e-6a1e2f0b7c11',
    handle: 'acme',
    name: 'acme',
    email: 'acme@example.com',
  };
  private static readonly TOKEN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

  mode: FakeHubMode = 'approve';
  /** How long `POST /cli/token` takes to answer. */
  exchangeDelayMs = 0;
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
   * manifest names, published unless `row` says otherwise, with the tree
   * hash of its files as its integrity and the manifest's engine fields.
   * Answers the version row, which a test may change afterwards (yank it,
   * remove it).
   */
  async addArchive(archive: Buffer, row: Partial<FakeHubVersion> = {}): Promise<FakeHubVersion> {
    const zip = await JSZip.loadAsync(archive);
    const files: Record<string, Uint8Array> = {};
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir) {
        files[entry.name] = await entry.async('uint8array');
      }
    }
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8')) as Record<string, unknown>;
    const name = String(manifest.name);
    const version: FakeHubVersion = {
      version: String(manifest.version),
      status: 'published',
      integrity: TreeHash.ofFiles(files),
      size: archive.length,
      publishedAt: '2026-10-10T00:00:00.000Z',
      archive,
      manifest,
      engine: String(manifest.engine),
      minEngine: String(manifest.minEngine),
      sdkVersion: Number(manifest.sdkVersion),
      ...row,
    };
    const pkg = this.packages.get(name) ?? { status: 'active' as const, versions: [] };
    pkg.versions.push(version);
    this.packages.set(name, pkg);
    return version;
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
    this.nextUpload = null;
    this.nextDownload = null;
    this.minCliVersion = null;
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
      warnings: [],
    });
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
      listing: { license: null, homepageUrl: null, repositoryUrl: null, media: [] },
      access,
      publisher: name.slice(1, name.indexOf('/')),
      description: null,
      keywords: [],
      homepage: null,
      deprecatedMessage: null,
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
      usesOcct: false,
      notes: row.notes ?? '',
      license: null,
      publishedAt: row.publishedAt ?? null,
      features: [],
      models: [],
      archiveUrl: this.archiveUrl(name, row.version),
    };
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
      usesOcct: false,
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
      entries: [],
      yanked: row.yanked ?? null,
      isLatest: row === latest,
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
      license: null,
      reviewNote: row.reviewNote ?? null,
      usesOcct: false,
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
    const issued = this.issueToken({ kind: 'cli', scopes: ['publish'] });
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
