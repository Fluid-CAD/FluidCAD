// Hub and package tools: an agent searches the FluidCAD hub, reads what a
// package offers, installs it into the open project, and reads an installed
// package's files (docs/agent-hub-plan.md).
//
// Every call goes to the running engine's hub bridge (`/api/hub/*`,
// `/api/packages*`), never to the hub itself: the hub URL, the sign-in, the
// proxy settings, the disk cache and the marks of what this machine already
// has are the engine's, so the in-app agent and an external MCP client see
// the same thing the Hub panel does.
//
// What the hub answers is written by package publishers. These tools hand it
// on as data (descriptions, READMEs, doc pages); the server instructions tell
// the agent to read it as such.

import type { FluidCadClient } from '../client.ts';
import type { ToolResult } from '../types.ts';
import { err, ok } from '../types.ts';
import { resolveClient, type WorkspaceArg } from './inspection.ts';

/** `@handle/name`, as the engine's `PackageName.PATTERN` has it. */
const PACKAGE_NAME = /^@[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAME_RULE = '`name` is a package name with its publisher, as in "@acme/gears".';
const VERSION_RULE = '`version` is an exact version, as in "1.2.0".';

/** A description on a search row is cut here. */
const ROW_DESCRIPTION_CHARS = 300;
/** A README inside `get_hub_package` is cut here; `read_package_file` reads the rest. */
const README_CHARS = 12_000;
/** The versions `get_hub_package` lists. */
const VERSIONS_LISTED = 15;
/** `read_package_file`'s default and largest window. */
const FILE_CHARS = 40_000;
const FILE_CHARS_MAX = 100_000;
/** The largest file `read_package_file` reads from the hub (the engine's own limit for an installed one). */
const FILE_BYTES_MAX = 512 * 1024;
/**
 * How long an install may take to answer: the engine gives a download ten
 * minutes (`HubDownload.TIMEOUT_MS`), and the answer comes only once the
 * package is installed.
 */
const INSTALL_TIMEOUT_MS = 12 * 60 * 1000;

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** An engine answer read whatever its status: its JSON when it is JSON. */
type EngineAnswer = { status: number; json: any; bytes: Buffer; contentType: string };

class Engine {
  static async get(client: FluidCadClient, path: string): Promise<EngineAnswer> {
    return Engine.read(await client.getRaw(path));
  }

  static async post(client: FluidCadClient, path: string, body: unknown, timeoutMs?: number): Promise<EngineAnswer> {
    return Engine.read(await client.postRaw(path, body, { timeoutMs }));
  }

  private static read(raw: { statusCode: number; data: Buffer; contentType: string }): EngineAnswer {
    let json: any = null;
    if (raw.contentType.includes('application/json')) {
      try {
        json = JSON.parse(raw.data.toString('utf8'));
      } catch {
        json = null;
      }
    }
    return { status: raw.statusCode, json, bytes: raw.data, contentType: raw.contentType };
  }

  /**
   * The engine's refusal (`{ error, code, details? }`) as a tool error: the
   * hub unreachable, nothing by that name, a bad argument, else `fallback`
   * with the engine's own code in `details.code`.
   */
  static refusal(answer: EngineAnswer, fallback: 'hub-refused' | 'install-refused'): ToolResult<never> {
    const sentence = typeof answer.json?.error === 'string' ? answer.json.error : null;
    if (sentence === null) {
      if (answer.status === 404) {
        // Not the engine's refusal shape: an engine from before these routes.
        return err('http-error', 'The running FluidCAD has no route for this (HTTP 404): it is older than this MCP server. Update FluidCAD, then try again.', { statusCode: 404 });
      }
      return err('http-error', `HTTP ${answer.status}: ${answer.bytes.toString('utf8').slice(0, 200)}`, { statusCode: answer.status });
    }
    const code = typeof answer.json.code === 'string' ? answer.json.code : null;
    const details: Record<string, unknown> = { statusCode: answer.status };
    if (code) {
      details.code = code;
    }
    if (answer.json.details !== undefined && answer.json.details !== null) {
      details.hub = answer.json.details;
    }
    if (code === 'hub-unreachable') {
      return err('hub-unreachable', sentence, details);
    }
    if (code === 'bad-request') {
      return err('invalid-input', sentence, details);
    }
    if (answer.status === 404) {
      return err('not-found', sentence, details);
    }
    return err(fallback, sentence, details);
  }
}

/** Run `fn` against the workspace's engine, closing the client after. */
async function withEngine<T>(input: WorkspaceArg, fn: (client: FluidCadClient) => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  const resolved = resolveClient(input);
  if (resolved.ok === false) {
    return resolved as ToolResult<T>;
  }
  const { client } = resolved.data;
  try {
    return await fn(client);
  } catch (e: any) {
    return err('internal', e?.message ?? String(e));
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// What a package offers
// ---------------------------------------------------------------------------

/** One value of a feature or of a generated definition, less what only its dialog needs. */
export type PackageValue = Record<string, unknown>;

export type PackageFeature = {
  /** The name to import. */
  export: string;
  id: string;
  /** The file that declares it, inside the package: what `read_package_file` reads for its source. */
  module?: string;
  label: string;
  description?: string;
  kind?: string;
  /** The call, values by id: `standoff(face, { height, outer, hole })`. */
  usage?: string;
  operations?: string[];
  defaultOperation?: string;
  values: Record<string, PackageValue>;
};

export type PackagePartParam = {
  label: string;
  default: unknown;
  type?: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
};

export type PackagePart = {
  /** The name to import. */
  export: string;
  name: string;
  kind: 'part' | 'assembly';
  /** The file that declares it, inside the package. */
  module?: string;
  /** How an assembly places it: `insert(pcbPlate)`, `insert(gearPart, { teeth, width })`. */
  usage: string;
  description?: string;
  /** A `definePart` / `defineAssembly` definition: `insert()` takes `values` by id. */
  generated?: true;
  /** A `part()` / `assembly()` definition's `param()`s: `insert(def, { '<label>': value })` overrides one by its label. */
  params?: PackagePartParam[];
  /** A generated definition's values, by id. */
  values?: Record<string, PackageValue>;
  /** A generated part's connectors, by name. */
  connectors?: string[];
  /** The rows of its `configurations()` table: `insert(def, '<name>')`. */
  configurations?: string[];
};

/** What a package exports, as a model uses it. */
export type PackageApiSummary = {
  /** The import line naming every export; null when the package exports nothing readable. */
  import: string | null;
  features: PackageFeature[];
  /** Parts, then assemblies. */
  parts: PackagePart[];
};

/**
 * A manifest's features and parts as an agent needs them: what to import,
 * how to call it, and each value's type, default, range, options and
 * description. What only a dialog needs (layout, icons, pictures, groups,
 * widths) is left out.
 */
export class PackageApi {
  /** Keys of a value's spec that only its dialog reads. */
  private static readonly DIALOG_KEYS = new Set(['group', 'tab', 'picture', 'pictures', 'image', 'icon', 'width', 'placeholder']);
  private static readonly IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  static of(name: string, manifest: unknown): PackageApiSummary {
    const source = (manifest && typeof manifest === 'object' ? manifest : {}) as { features?: unknown; parts?: unknown };
    const features = (Array.isArray(source.features) ? source.features : [])
      .map((feature) => PackageApi.feature(feature))
      .filter((feature): feature is PackageFeature => feature !== null);
    const parts = (Array.isArray(source.parts) ? source.parts : [])
      .map((part) => PackageApi.part(part))
      .filter((part): part is PackagePart => part !== null)
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'part' ? -1 : 1));
    const exports = [...features.map((feature) => feature.export), ...parts.map((part) => part.export)]
      .filter((exportName) => PackageApi.IDENTIFIER.test(exportName));
    return {
      import: exports.length > 0 ? `import { ${exports.join(', ')} } from '${name}';` : null,
      features,
      parts,
    };
  }

  /** The doc pages a file list holds: markdown under `docs/`. */
  static docs(files: unknown): string[] {
    return (Array.isArray(files) ? files : [])
      .map((file) => (typeof file === 'string' ? file : typeof file?.path === 'string' ? file.path : ''))
      .filter((file) => /^docs\/.+\.md$/i.test(file))
      .sort();
  }

  /** The root README of a file list, by its own spelling; null without one. */
  static readme(files: unknown): string | null {
    const paths = (Array.isArray(files) ? files : []).map((file) => (typeof file === 'string' ? file : typeof file?.path === 'string' ? file.path : ''));
    return paths.find((file) => /^readme\.md$/i.test(file)) ?? null;
  }

  private static feature(raw: any): PackageFeature | null {
    if (!raw || typeof raw.exportName !== 'string' || typeof raw.id !== 'string') {
      return null;
    }
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    const usage = PackageApi.callOf(raw.exportName, meta.call);
    const operations = Array.isArray(meta.operations) ? meta.operations.filter((op: unknown) => typeof op === 'string') : [];
    return {
      export: raw.exportName,
      id: raw.id,
      ...(typeof raw.module === 'string' ? { module: raw.module } : {}),
      label: typeof meta.label === 'string' ? meta.label : raw.exportName,
      ...(typeof meta.description === 'string' && meta.description !== '' ? { description: meta.description } : {}),
      ...(typeof meta.kind === 'string' ? { kind: meta.kind } : {}),
      ...(usage ? { usage } : {}),
      ...(operations.length > 0 ? { operations } : {}),
      ...(typeof meta.defaultOperation === 'string' ? { defaultOperation: meta.defaultOperation } : {}),
      values: PackageApi.values(meta.params),
    };
  }

  private static part(raw: any): PackagePart | null {
    if (!raw || typeof raw.exportName !== 'string') {
      return null;
    }
    const kind = raw.kind === 'assembly' ? 'assembly' : 'part';
    const configurations = Array.isArray(raw.configurations)
      ? raw.configurations.map((row: any) => row?.name).filter((name: unknown): name is string => typeof name === 'string')
      : [];
    const base = {
      export: raw.exportName,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.exportName,
      kind,
      ...(typeof raw.module === 'string' ? { module: raw.module } : {}),
    } as const;
    if (raw.definitionKind === 'generated' && raw.schema && typeof raw.schema === 'object') {
      const values = PackageApi.values(raw.schema.params);
      const ids = Object.keys(values);
      const connectors = Array.isArray(raw.schema.connectors) ? raw.schema.connectors.filter((c: unknown) => typeof c === 'string') : [];
      return {
        ...base,
        name: typeof raw.schema.label === 'string' && raw.schema.label !== '' ? raw.schema.label : base.name,
        usage: ids.length > 0 ? `insert(${raw.exportName}, { ${ids.join(', ')} })` : `insert(${raw.exportName})`,
        ...(typeof raw.schema.description === 'string' && raw.schema.description !== '' ? { description: raw.schema.description } : {}),
        generated: true,
        values,
        ...(connectors.length > 0 ? { connectors } : {}),
      };
    }
    const params = (Array.isArray(raw.params) ? raw.params : [])
      .map((param: any) => PackageApi.param(param))
      .filter((param: PackagePartParam | null): param is PackagePartParam => param !== null);
    return {
      ...base,
      usage: raw.exportKind === 'factory' ? `insert(${raw.exportName}())` : `insert(${raw.exportName})`,
      ...(params.length > 0 ? { params } : {}),
      ...(configurations.length > 0 ? { configurations } : {}),
    };
  }

  private static param(raw: any): PackagePartParam | null {
    if (!raw || typeof raw.label !== 'string') {
      return null;
    }
    return {
      label: raw.label,
      default: raw.defaultValue,
      ...(typeof raw.controlType === 'string' && raw.controlType !== 'auto' ? { type: raw.controlType } : {}),
      ...(typeof raw.description === 'string' && raw.description !== '' ? { description: raw.description } : {}),
      ...(typeof raw.min === 'number' ? { min: raw.min } : {}),
      ...(typeof raw.max === 'number' ? { max: raw.max } : {}),
      ...(typeof raw.step === 'number' ? { step: raw.step } : {}),
      ...(Array.isArray(raw.options) && raw.options.length > 0 ? { options: raw.options } : {}),
    };
  }

  /** Each value's spec, in declaration order, without the dialog's keys. */
  private static values(params: unknown): Record<string, PackageValue> {
    const values: Record<string, PackageValue> = {};
    if (!params || typeof params !== 'object') {
      return values;
    }
    for (const [id, spec] of Object.entries(params as Record<string, unknown>)) {
      if (spec && typeof spec === 'object') {
        values[id] = PackageApi.strip(spec as Record<string, unknown>);
      }
    }
    return values;
  }

  private static strip(spec: Record<string, unknown>): PackageValue {
    const kept: PackageValue = {};
    for (const [key, value] of Object.entries(spec)) {
      if (PackageApi.DIALOG_KEYS.has(key)) {
        continue;
      }
      kept[key] = key === 'options' && Array.isArray(value)
        ? value.map((option) => (option && typeof option === 'object' ? PackageApi.strip(option as Record<string, unknown>) : option))
        : value;
    }
    return kept;
  }

  /** `standoff(face, { height, outer })` from a call shape (positional ids, then the options object's keys). */
  private static callOf(exportName: string, call: unknown): string | null {
    if (!Array.isArray(call)) {
      return null;
    }
    const slots: string[] = [];
    for (const slot of call) {
      if (typeof slot === 'string') {
        slots.push(slot);
      } else if (slot && typeof slot === 'object') {
        const keys = Object.keys(slot);
        slots.push(keys.length > 0 ? `{ ${keys.join(', ')} }` : '{}');
      }
    }
    return `${exportName}(${slots.join(', ')})`;
  }
}

// ---------------------------------------------------------------------------
// search_hub
// ---------------------------------------------------------------------------

export type SearchHubInput = WorkspaceArg & {
  query?: string;
  contents?: string[];
  units?: string;
  license?: string[];
  sort?: string;
  order?: string;
  page?: number;
  limit?: number;
};

export type HubSearchRow = {
  name: string;
  /** The latest version: what an install by name gets, unless this FluidCAD can't run it. */
  version: string;
  description: string | null;
  publisher: string;
  contents: { features: number; parts: number; assemblies: number };
  /** Up to three feature labels; `moreFeatures` counts the rest. */
  featureLabels: string[];
  moreFeatures?: number;
  installs: number;
  likes: number;
  license: string | null;
  updatedAt: string;
  /** Whether this FluidCAD runs the latest version; `requires` says what it needs when not. */
  compatible: boolean | null;
  requires?: string;
  /** The publisher's deprecation message. */
  deprecated?: string;
  /** Versions already on this machine, where the open project resolves packages from. */
  installed: string[];
  /** The version the open project uses. */
  pinned: string | null;
  updateAvailable: string | null;
};

export type SearchHubOutput = {
  total: number;
  /** More than `total` match; only the first `total` can be paged to. */
  capped: boolean;
  page: number;
  limit: number;
  /** Whether `page + 1` has more. */
  more: boolean;
  results: HubSearchRow[];
};

export async function searchHub(input: SearchHubInput): Promise<ToolResult<SearchHubOutput>> {
  const params = new URLSearchParams();
  const query = (input.query ?? '').trim();
  if (query !== '') {
    params.set('q', query);
  }
  for (const value of input.contents ?? []) {
    params.append('contents', value);
  }
  if (input.units) {
    params.append('units', input.units);
  }
  for (const value of input.license ?? []) {
    params.append('license', value);
  }
  if (input.sort) {
    params.set('sort', input.sort);
  }
  if (input.order) {
    params.set('order', input.order);
  }
  if (input.page !== undefined) {
    params.set('page', String(input.page));
  }
  params.set('limit', String(input.limit ?? 10));
  return withEngine(input, async (client) => {
    const answer = await Engine.get(client, `/api/hub/search?${params.toString()}`);
    if (answer.status !== 200 || !answer.json) {
      return Engine.refusal(answer, 'hub-refused');
    }
    const body = answer.json;
    const results: HubSearchRow[] = (Array.isArray(body.results) ? body.results : []).map((row: any) => searchRow(row, body.request));
    const page = Number(body.page) || 1;
    const limit = Number(body.limit) || results.length;
    const total = Number(body.total) || 0;
    return ok({ total, capped: body.capped === true, page, limit, more: (page - 1) * limit + results.length < total, results });
  });
}

function searchRow(row: any, asked: any): HubSearchRow {
  const labels: string[] = (Array.isArray(row.features) ? row.features : []).map((chip: any) => String(chip?.label ?? '')).filter((label: string) => label !== '');
  const local = row.local ?? {};
  return {
    name: String(row.fullName),
    version: String(row.version),
    description: clip(row.description, ROW_DESCRIPTION_CHARS),
    publisher: String(row.publisher?.handle ?? row.scope ?? ''),
    contents: {
      features: Number(row.counts?.features) || 0,
      parts: Number(row.counts?.parts) || 0,
      assemblies: Number(row.counts?.assemblies) || 0,
    },
    featureLabels: labels,
    ...(Number(row.moreFeatures) > 0 ? { moreFeatures: Number(row.moreFeatures) } : {}),
    installs: Number(row.installs) || 0,
    likes: Number(row.likes) || 0,
    license: typeof row.license === 'string' ? row.license : null,
    updatedAt: String(row.updatedAt ?? ''),
    compatible: typeof row.compatible === 'boolean' ? row.compatible : null,
    ...(row.compatible === false ? { requires: requirementOf(row, asked) } : {}),
    ...(typeof row.deprecated === 'string' && row.deprecated !== '' ? { deprecated: row.deprecated } : {}),
    installed: Array.isArray(local.installed) ? local.installed : [],
    pinned: typeof local.pinned === 'string' ? local.pinned : null,
    updateAvailable: typeof local.updateAvailable === 'string' ? local.updateAvailable : null,
  };
}

/** What a row this FluidCAD can't run needs, beside what this FluidCAD is. */
function requirementOf(row: any, asked: any): string {
  const needs = `FluidCAD ${row.minEngine} or newer (feature SDK ${row.sdkVersion})`;
  return asked?.engine ? `${needs}; this FluidCAD is ${asked.engine} (feature SDK ${asked.sdk})` : needs;
}

function clip(text: unknown, max: number): string | null {
  if (typeof text !== 'string') {
    return null;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// get_hub_package
// ---------------------------------------------------------------------------

export type GetHubPackageInput = WorkspaceArg & { name: string; version?: string };

export type HubPackageVersionView = PackageApiSummary & {
  version: string;
  status: string;
  isLatest: boolean;
  minEngine: string | null;
  unit: string | null;
  publishedAt: string | null;
  /** Its release notes. */
  notes: string;
  /** Doc pages `read_package_file` reads. */
  docs: string[];
  /** The README's text, cut at a few thousand characters (`readmeTruncated`); null without one. */
  readme: string | null;
  readmeTruncated?: true;
};

export type GetHubPackageOutput = {
  name: string;
  description: string | null;
  publisher: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  keywords: string[];
  installs: number;
  likes: number;
  deprecated?: string;
  latestVersion: string | null;
  /** The version `install_package({ name })` installs on this FluidCAD; null when none runs on it. */
  installVersion: string | null;
  installed: string[];
  pinned: string | null;
  updateAvailable: string | null;
  /** Published versions, newest first as the hub lists them. */
  versions: { version: string; publishedAt: string | null; minEngine: string | null; notes?: string }[];
  /** The version described: the one asked for, else `installVersion`, else the latest. Null when nothing is published. */
  described: HubPackageVersionView | null;
};

export async function getHubPackage(input: GetHubPackageInput): Promise<ToolResult<GetHubPackageOutput>> {
  if (typeof input?.name !== 'string' || !PACKAGE_NAME.test(input.name)) {
    return err('invalid-input', NAME_RULE);
  }
  if (input.version !== undefined && (typeof input.version !== 'string' || !VERSION.test(input.version))) {
    return err('invalid-input', VERSION_RULE);
  }
  const { name } = input;
  return withEngine(input, async (client) => {
    const detailAnswer = await Engine.get(client, `/api/hub/packages/${name}`);
    if (detailAnswer.status !== 200 || !detailAnswer.json) {
      return Engine.refusal(detailAnswer, 'hub-refused');
    }
    const detail = detailAnswer.json;
    const latestVersion: string | null = typeof detail.latestVersion === 'string' ? detail.latestVersion : null;
    const installVersion: string | null = detail.compatibility ? detail.compatibility.newestCompatible ?? null : latestVersion;
    const describedVersion = input.version ?? installVersion ?? latestVersion;
    let described: HubPackageVersionView | null = null;
    if (describedVersion) {
      const versionAnswer = await Engine.get(client, `/api/hub/packages/${name}/versions/${encodeURIComponent(describedVersion)}`);
      if (versionAnswer.status !== 200 || !versionAnswer.json) {
        return Engine.refusal(versionAnswer, 'hub-refused');
      }
      described = await versionView(client, name, versionAnswer.json);
    }
    const local = detail.local ?? {};
    const listing = detail.listing ?? {};
    const deprecated = detail.deprecatedMessage ?? listing.deprecatedMessage ?? null;
    return ok({
      name,
      description: typeof detail.description === 'string' ? detail.description : null,
      publisher: typeof detail.publisher === 'string' ? detail.publisher : null,
      license: listing.license ?? detail.latest?.license ?? null,
      homepage: listing.homepageUrl ?? detail.homepage ?? null,
      repository: listing.repositoryUrl ?? null,
      keywords: Array.isArray(detail.keywords) ? detail.keywords : [],
      installs: Number(detail.counts?.installs) || 0,
      likes: Number(detail.counts?.likes) || 0,
      ...(typeof deprecated === 'string' && deprecated !== '' ? { deprecated } : {}),
      latestVersion,
      installVersion,
      installed: Array.isArray(local.installed) ? local.installed : [],
      pinned: typeof local.pinned === 'string' ? local.pinned : null,
      updateAvailable: typeof local.updateAvailable === 'string' ? local.updateAvailable : null,
      versions: (Array.isArray(detail.versions) ? detail.versions : [])
        .filter((version: any) => version?.status === 'published' && !version.removed)
        .slice(0, VERSIONS_LISTED)
        .map((version: any) => ({
          version: String(version.version),
          publishedAt: version.publishedAt ?? null,
          minEngine: version.minEngine ?? null,
          ...(typeof version.notes === 'string' && version.notes !== '' ? { notes: version.notes } : {}),
        })),
      described,
    });
  });
}

/** One version as the engine's bridge answers it, with its README read through the file proxy. */
async function versionView(client: FluidCadClient, name: string, version: any): Promise<HubPackageVersionView> {
  let readme: string | null = null;
  let truncated = false;
  if (typeof version.readmeUrl === 'string' && version.readmeUrl !== '') {
    const file = await Engine.get(client, `/${version.readmeUrl.replace(/^\/+/, '')}`);
    if (file.status === 200 && !file.bytes.includes(0)) {
      const text = file.bytes.toString('utf8');
      truncated = text.length > README_CHARS;
      readme = truncated ? text.slice(0, README_CHARS) : text;
    }
  }
  return {
    version: String(version.version),
    status: String(version.status ?? ''),
    isLatest: version.isLatest === true,
    minEngine: version.minEngine ?? null,
    unit: version.unit ?? null,
    publishedAt: version.publishedAt ?? null,
    notes: typeof version.notes === 'string' ? version.notes : '',
    ...PackageApi.of(name, version.manifest),
    docs: Array.isArray(version.docs) ? version.docs : PackageApi.docs(version.files),
    readme,
    ...(truncated ? { readmeTruncated: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// install_package
// ---------------------------------------------------------------------------

export type InstallPackageInput = WorkspaceArg & {
  name: string;
  version?: string;
  target?: 'library' | 'project';
  upgrade?: boolean;
};

export type InstallPackageOutput = PackageApiSummary & {
  name: string;
  version: string;
  /** `hub`: downloaded and verified now. `installed`: a copy already on this machine was used. */
  source: 'hub' | 'installed';
  /** `installed`: its files are new here; `unchanged`: they were already there. */
  status: string;
  /** Where the project loads it from: the user's library, or the project's `packages/` folder. */
  target: 'library' | 'project';
  /** `pinned`: fluidcad.json records it now; `unchanged`: it already did; null: no project is open. */
  pin: 'pinned' | 'unchanged' | null;
  /** The version the project used before, when the install moved it up. */
  upgradedFrom?: string;
  /** What to tell the user: deprecated, an older version picked for this FluidCAD, the hub unreachable. */
  notes: string[];
  docs: string[];
  readme: string | null;
};

export async function installPackage(input: InstallPackageInput): Promise<ToolResult<InstallPackageOutput>> {
  if (typeof input?.name !== 'string' || input.name.trim() === '') {
    return err('invalid-input', NAME_RULE);
  }
  if (input.version !== undefined && (typeof input.version !== 'string' || !VERSION.test(input.version))) {
    return err('invalid-input', VERSION_RULE);
  }
  if (input.target !== undefined && input.target !== 'library' && input.target !== 'project') {
    return err('invalid-input', '`target` must be "library" or "project".');
  }
  if (input.upgrade !== undefined && typeof input.upgrade !== 'boolean') {
    return err('invalid-input', '`upgrade` must be a boolean.');
  }
  const body: Record<string, unknown> = { name: input.name.trim() };
  if (input.version !== undefined) {
    body.version = input.version;
  }
  if (input.target !== undefined) {
    body.target = input.target;
  }
  if (input.upgrade === true) {
    body.upgrade = true;
  }
  return withEngine(input, async (client) => {
    const answer = await Engine.post(client, '/api/hub/install', body, INSTALL_TIMEOUT_MS);
    if (answer.status !== 200 || !answer.json) {
      return Engine.refusal(answer, 'install-refused');
    }
    const installed = answer.json;
    const files = installed.manifest?.files;
    return ok({
      name: String(installed.name),
      version: String(installed.version),
      source: installed.source === 'installed' ? 'installed' : 'hub',
      status: String(installed.status),
      target: installed.target === 'project' ? 'project' : 'library',
      pin: installed.pin === 'pinned' || installed.pin === 'unchanged' ? installed.pin : null,
      ...(typeof installed.upgradedFrom === 'string' ? { upgradedFrom: installed.upgradedFrom } : {}),
      notes: Array.isArray(installed.notes) ? installed.notes : [],
      ...PackageApi.of(String(installed.name), installed.manifest),
      docs: PackageApi.docs(files),
      readme: PackageApi.readme(files),
    });
  });
}

// ---------------------------------------------------------------------------
// list_packages
// ---------------------------------------------------------------------------

export type ListPackagesInput = WorkspaceArg & { name?: string; version?: string };

export type PackageRow = {
  name: string;
  version: string;
  description?: string;
  features: number;
  parts: number;
};

export type ListPackagesOverview = {
  /** The packages the open project uses (fluidcad.json `dependencies`); empty when it uses none. */
  uses: {
    name: string;
    version: string;
    /** Where it loads from; `missing`: installed nowhere, so models importing it fail until it is installed. */
    installedIn: 'library' | 'project' | 'missing';
    /** A newer version, in the library or on the hub. */
    updateAvailable?: string;
    deprecated?: string;
  }[];
  /** Why the project's pins couldn't be read. */
  usesProblem?: string;
  /** Copies in the project's own `packages/` folder. */
  projectCopies: PackageRow[];
  /** Everything in the user's library, used by this project or not: installing one of these needs no download. */
  library: PackageRow[];
};

export type InstalledPackageDetail = PackageApiSummary & {
  name: string;
  version: string;
  /** Whether the open project uses this version. */
  usedByProject: boolean;
  installedIn: 'library' | 'project';
  description?: string;
  license?: string;
  unit?: string;
  /** Other versions installed here. */
  otherVersions: string[];
  docs: string[];
  readme: string | null;
};

export type ListPackagesOutput = ListPackagesOverview | InstalledPackageDetail;

export async function listPackages(input: ListPackagesInput): Promise<ToolResult<ListPackagesOutput>> {
  if (input.name !== undefined && (typeof input.name !== 'string' || !PACKAGE_NAME.test(input.name))) {
    return err('invalid-input', NAME_RULE);
  }
  if (input.version !== undefined && (typeof input.version !== 'string' || !VERSION.test(input.version))) {
    return err('invalid-input', VERSION_RULE);
  }
  if (input.version !== undefined && input.name === undefined) {
    return err('invalid-input', '`version` needs a `name`.');
  }
  return withEngine<ListPackagesOutput>(input, async (client) => {
    const answer = await Engine.get(client, '/api/packages');
    if (answer.status !== 200 || !answer.json) {
      return Engine.refusal(answer, 'hub-refused');
    }
    const overview = answer.json;
    if (input.name !== undefined) {
      return installedDetail(overview, input.name, input.version ?? null);
    }
    const pins: any[] = Array.isArray(overview.pins) ? overview.pins : [];
    return ok({
      uses: pins.map((pin) => ({
        name: String(pin.name),
        version: String(pin.version),
        installedIn: pin.availability === 'project' || pin.availability === 'library' ? pin.availability : 'missing',
        ...(typeof overview.updates?.[pin.name] === 'string' ? { updateAvailable: overview.updates[pin.name] } : {}),
        ...(typeof overview.hubMarks?.[pin.name]?.deprecated === 'string' ? { deprecated: overview.hubMarks[pin.name].deprecated } : {}),
      })),
      ...(typeof overview.pinsProblem === 'string' ? { usesProblem: overview.pinsProblem } : {}),
      projectCopies: packageRows(overview.project?.packages),
      library: packageRows(overview.library?.packages),
    });
  });
}

function packageRows(packages: unknown): PackageRow[] {
  return (Array.isArray(packages) ? packages : []).map((pkg: any) => {
    const parts: any[] = Array.isArray(pkg.manifest?.parts) ? pkg.manifest.parts : [];
    const description = clip(pkg.manifest?.description, ROW_DESCRIPTION_CHARS);
    return {
      name: String(pkg.name),
      version: String(pkg.version),
      ...(description ? { description } : {}),
      features: Array.isArray(pkg.manifest?.features) ? pkg.manifest.features.length : 0,
      parts: parts.length,
    };
  });
}

/** One installed package from the overview: the version asked for, else the one the project uses, else the newest installed. */
function installedDetail(overview: any, name: string, asked: string | null): ToolResult<InstalledPackageDetail> {
  const copies: { pkg: any; installedIn: 'project' | 'library' }[] = [
    ...(Array.isArray(overview.project?.packages) ? overview.project.packages : []).map((pkg: any) => ({ pkg, installedIn: 'project' as const })),
    ...(Array.isArray(overview.library?.packages) ? overview.library.packages : []).map((pkg: any) => ({ pkg, installedIn: 'library' as const })),
  ].filter((copy) => copy.pkg?.name === name);
  const pinned: string | null = (Array.isArray(overview.pins) ? overview.pins : []).find((pin: any) => pin?.name === name)?.version ?? null;
  if (copies.length === 0) {
    const used = pinned ? ` The project uses ${name} ${pinned}, which isn't installed: install_package downloads it.` : '';
    return err('not-found', `${name} isn't installed on this machine.${used} search_hub and get_hub_package look on the hub.`, { pinned });
  }
  const versions = [...new Set(copies.map((copy) => String(copy.pkg.version)))].sort(compareVersions);
  const version = asked ?? (pinned && versions.includes(pinned) ? pinned : versions[versions.length - 1]);
  // The project copy wins over the library, as it does when the engine loads the package.
  const chosen = copies.find((copy) => copy.pkg.version === version);
  if (!chosen) {
    return err('not-found', `${name} ${version} isn't installed on this machine; installed: ${versions.join(', ')}.`, { installed: versions, pinned });
  }
  const manifest = chosen.pkg.manifest;
  if (!manifest) {
    return err('internal', `${name} ${version} is installed, but its manifest can't be read${chosen.pkg.problem ? `: ${chosen.pkg.problem}` : '.'}`);
  }
  return ok({
    name,
    version,
    usedByProject: pinned === version,
    installedIn: chosen.installedIn,
    ...(typeof manifest.description === 'string' && manifest.description !== '' ? { description: manifest.description } : {}),
    ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
    ...(typeof manifest.unit === 'string' ? { unit: manifest.unit } : {}),
    otherVersions: versions.filter((other) => other !== version),
    ...PackageApi.of(name, manifest),
    docs: PackageApi.docs(manifest.files),
    readme: PackageApi.readme(manifest.files),
  });
}

/** Semver precedence on the numeric core; a prerelease sorts before its release. */
function compareVersions(a: string, b: string): number {
  const parse = (text: string) => {
    const [core, pre = ''] = text.split('+')[0].split('-', 2);
    return { numbers: core.split('.').map((part) => Number(part) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  if (left.pre === '') {
    return 1;
  }
  if (right.pre === '') {
    return -1;
  }
  return left.pre < right.pre ? -1 : 1;
}

// ---------------------------------------------------------------------------
// read_package_file
// ---------------------------------------------------------------------------

export type ReadPackageFileInput = WorkspaceArg & {
  name: string;
  path: string;
  version?: string;
  offset?: number;
  maxChars?: number;
};

export type ReadPackageFileOutput = {
  name: string;
  version: string;
  path: string;
  /** `installed`: read from the copy on this machine. `hub`: read from the hub's archive. */
  source: 'installed' | 'hub';
  content: string;
  /** The whole file's length in characters. */
  totalChars: number;
  offset: number;
  /** Set when the file goes on past `content`: the `offset` of the next read. */
  nextOffset?: number;
};

export async function readPackageFile(input: ReadPackageFileInput): Promise<ToolResult<ReadPackageFileOutput>> {
  if (typeof input?.name !== 'string' || !PACKAGE_NAME.test(input.name)) {
    return err('invalid-input', NAME_RULE);
  }
  if (input.version !== undefined && (typeof input.version !== 'string' || !VERSION.test(input.version))) {
    return err('invalid-input', VERSION_RULE);
  }
  const segments = typeof input.path === 'string' ? input.path.replace(/^\.\//, '').split('/') : [];
  if (segments.length === 0 || segments.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    return err('invalid-input', '`path` is a file inside the package, as in "docs/standoff.md" or "README.md".');
  }
  const offset = input.offset ?? 0;
  const maxChars = Math.min(input.maxChars ?? FILE_CHARS, FILE_CHARS_MAX);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxChars) || maxChars < 1) {
    return err('invalid-input', '`offset` is a whole number from 0, and `maxChars` one from 1.');
  }
  const { name } = input;
  const relative = segments.join('/');
  const encoded = segments.map(encodeURIComponent).join('/');
  return withEngine(input, async (client) => {
    let version = input.version ?? null;
    if (version === null) {
      const resolved = await defaultVersion(client, name);
      if (resolved.ok === false) {
        return resolved as ToolResult<ReadPackageFileOutput>;
      }
      version = resolved.data;
    }
    const window = (text: string, source: 'installed' | 'hub'): ToolResult<ReadPackageFileOutput> => {
      const content = text.slice(offset, offset + maxChars);
      const end = offset + content.length;
      return ok({ name, version: version!, path: relative, source, content, totalChars: text.length, offset, ...(end < text.length ? { nextOffset: end } : {}) });
    };

    const local = await Engine.get(client, `/api/packages/file/${name}/${encodeURIComponent(version)}/${encoded}`);
    if (local.status === 200 && typeof local.json?.content === 'string') {
      return window(local.json.content, 'installed');
    }
    // Anything but "not installed here" (or an engine without the route) is the answer: no such file, not text, too large.
    const notInstalled = local.json?.code === 'not-installed' || (local.status === 404 && typeof local.json?.error !== 'string');
    if (!notInstalled) {
      return Engine.refusal(local, 'hub-refused');
    }

    const remote = await Engine.get(client, `/api/hub/files/${name}/${encodeURIComponent(version)}/${encoded}`);
    if (remote.status !== 200) {
      return Engine.refusal(remote, 'hub-refused');
    }
    if (remote.bytes.length > FILE_BYTES_MAX) {
      return err('hub-refused', `${relative} is ${remote.bytes.length} bytes, over the ${FILE_BYTES_MAX / 1024} kB this tool reads.`, { code: 'too-large' });
    }
    if (remote.bytes.includes(0)) {
      return err('hub-refused', `${relative} is not a text file.`, { code: 'not-text' });
    }
    return window(remote.bytes.toString('utf8'), 'hub');
  });
}

/** The version a read without one means: the one the project uses, else the newest installed, else the one an install would get. */
async function defaultVersion(client: FluidCadClient, name: string): Promise<ToolResult<string>> {
  const local = await Engine.get(client, '/api/packages');
  if (local.status === 200 && local.json) {
    const overview = local.json;
    const pinned = (Array.isArray(overview.pins) ? overview.pins : []).find((pin: any) => pin?.name === name)?.version;
    if (typeof pinned === 'string') {
      return ok(pinned);
    }
    const installed = [
      ...(Array.isArray(overview.project?.packages) ? overview.project.packages : []),
      ...(Array.isArray(overview.library?.packages) ? overview.library.packages : []),
    ].filter((pkg: any) => pkg?.name === name).map((pkg: any) => String(pkg.version)).sort(compareVersions);
    if (installed.length > 0) {
      return ok(installed[installed.length - 1]);
    }
  }
  const detail = await Engine.get(client, `/api/hub/packages/${name}`);
  if (detail.status !== 200 || !detail.json) {
    return Engine.refusal(detail, 'hub-refused');
  }
  const offered = detail.json.compatibility ? detail.json.compatibility.newestCompatible ?? detail.json.latestVersion : detail.json.latestVersion;
  if (typeof offered !== 'string') {
    return err('not-found', `${name} has no published version to read.`);
  }
  return ok(offered);
}
