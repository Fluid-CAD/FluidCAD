import type { PackageTypesPayload } from './editor-api';

/** Monaco's `javascriptDefaults.addExtraLib`, as the package types use it. */
export type ExtraLibRegistrar = (content: string, uri: string) => { dispose(): void };

/**
 * Make the language service resolve every import again. A program keeps a
 * model's failed resolution of `@acme/gears` until the model itself
 * changes, so files registered after it looked are not seen without this.
 */
export type LanguageServiceRestart = () => void;

/**
 * The pinned packages' sources in the in-page editor's language service, so
 * `import { standoff } from '@acme/gears'` completes and hovers with the
 * types inferred from the package's own JavaScript. The server publishes
 * them under `file:///node_modules/@scope/name/…` (`GET /api/packages/types`),
 * beside the engine's declarations under `file:///node_modules/fluidcad`,
 * which is where the package's own `fluidcad/*` imports find them.
 *
 * The pins change while the page is open — a pin written by adoption or by
 * `fluidcad install`, a package installed, copied into the project or
 * removed — and every one of those refreshes the page's package overview,
 * which calls {@link refresh}. The files are registered again only when the
 * server's `key` (which packages, where, with which contents) changes; the
 * previous ones are disposed first, so an unpinned package stops
 * completing, and the language service is restarted so the models resolve
 * the name again. The latest refresh wins. Monaco-free, so it tests without
 * the editor: the caller hands in the registrar, the fetch and the restart.
 */
export class PackageTypes {
  private key: string | null = null;
  private libs: { dispose(): void }[] = [];
  /** The latest refresh: an older one's answer is dropped. */
  private ticket = 0;

  constructor(
    private readonly register: ExtraLibRegistrar,
    private readonly fetch: () => Promise<PackageTypesPayload>,
    private readonly restart: LanguageServiceRestart,
  ) {}

  /** Fetch the pins' sources and register them if they changed. Never throws: a page without them still edits. */
  async refresh(): Promise<void> {
    const ticket = ++this.ticket;
    let payload: PackageTypesPayload;
    try {
      payload = await this.fetch();
    } catch (err) {
      console.warn('FluidCAD: the packages\' types are unavailable:', err);
      return;
    }
    if (ticket !== this.ticket || payload.key === this.key) {
      return;
    }
    const had = this.libs.length > 0;
    this.clear();
    this.key = payload.key;
    for (const file of payload.files) {
      this.libs.push(this.register(file.content, file.uri));
    }
    if (had || this.libs.length > 0) {
      this.restart();
    }
    if (payload.files.length > 0) {
      console.info(`FluidCAD: loaded ${payload.files.length} package files (${Math.round(payload.bytes / 1024)} KB) for the editor`);
    }
  }

  /** The `file:///…` URIs registered now. */
  get registered(): number {
    return this.libs.length;
  }

  private clear(): void {
    for (const lib of this.libs.splice(0)) {
      lib.dispose();
    }
  }
}
