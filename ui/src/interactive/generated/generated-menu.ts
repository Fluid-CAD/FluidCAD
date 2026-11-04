import { getGeneratedCatalog, type GeneratedCatalogEntry } from '../../api';
import type { Navbar } from '../../ui/navbar';
import { CustomFeaturesMenu, type CustomFeatureCell } from '../create-feature/schema/custom-features-menu';
import { GeneratedDefinition } from './generated-definition';

/**
 * The assembly bar's Generate Parts dropdown: every generated part and assembly
 * (`definePart`, `defineAssembly`) the project can insert — its own, its
 * pinned packages', the library's offers (`GET /api/part-catalog/generated`)
 * — a cell apiece, grouped by package with the part bar's headings and pins
 * ({@link CustomFeaturesMenu}, in `'assembly'` mode: it never shows in part
 * mode, and generated definitions never show in the part bar's). A cell
 * opens its definition's dialog ({@link onOpen}); the open dialog's cell
 * reads as armed.
 *
 * The list is fetched when an assembly first shows and refreshed on every
 * open of the dropdown, when a feature module or the packages change — the
 * server answers unchanged files from its scan cache. A refresh keeps the
 * cells whose entry didn't change; an older refresh's answer is dropped.
 */
export class GeneratedDefinitionsMenu {
  /** The navbar group the assembly bar's Generate Parts button sits in. */
  static readonly GROUP = 'assembly-custom';

  /** A cell was pressed: open its definition's dialog. */
  onOpen?: (definition: GeneratedDefinition) => void;

  readonly menu: CustomFeaturesMenu;
  private readonly held = new Map<string, { definition: GeneratedDefinition; cell: CustomFeatureCell }>();
  private ticket = 0;
  private loaded = false;
  private loading: Promise<void> | null = null;
  /** The empty dropdown's way to the hub, handed to the menu once a list says it is empty. */
  private emptyAction: (() => void) | null = null;

  constructor(
    navbar: Navbar,
    private readonly fetch: (signal?: AbortSignal) => Promise<GeneratedCatalogEntry[] | null> = getGeneratedCatalog,
  ) {
    this.menu = new CustomFeaturesMenu(navbar, {
      group: GeneratedDefinitionsMenu.GROUP,
      mode: 'assembly',
      label: 'Generate Parts',
      tip: 'Generate parts and assemblies from installed packages',
      tool: 'assembly-custom',
      role: 'assembly-custom-menu',
      pinnedPrefix: 'assembly-custom-package:',
      emptyText: 'No generated parts or assemblies installed. Check FluidCAD Hub for packages of features and parts.',
      allPinnedText: 'Every generated part and assembly is pinned to the toolbar. Right-click a pinned group to unpin it.',
    });
    this.menu.onOpen = () => void this.refresh();
  }

  /**
   * Keep the button with nothing to list, its dropdown sending the user to
   * `action` (the Hub panel) — once a list has arrived, so the button never
   * says "none" before the server answered.
   */
  setEmptyAction(action: (() => void) | null): void {
    this.emptyAction = action;
    if (this.loaded) {
      this.menu.setEmptyAction(action);
    }
  }

  /** The definitions listed, in no particular order. */
  get definitions(): GeneratedDefinition[] {
    return [...this.held.values()].map(entry => entry.definition);
  }

  /** Whether a list has arrived yet. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Fetch the list once, if it never was (an assembly showed for the first time). */
  ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    return this.loading ?? this.refresh();
  }

  /** Fetch the list and bring the dropdown in line with it. */
  refresh(): Promise<void> {
    const ticket = ++this.ticket;
    const run = (async () => {
      const entries = await this.fetch().catch(() => null);
      if (entries === null || ticket !== this.ticket) {
        return;
      }
      this.apply(entries);
    })();
    this.loading = run.finally(() => {
      if (this.ticket === ticket) {
        this.loading = null;
      }
    });
    return this.loading;
  }

  /** Bring the dropdown in line with `entries`: changed or gone ones leave, new ones get a cell. */
  apply(entries: readonly GeneratedCatalogEntry[]): void {
    if (!this.loaded) {
      this.loaded = true;
      this.menu.setEmptyAction(this.emptyAction);
    }
    const incoming = new Map(entries.map(entry => {
      const definition = new GeneratedDefinition(entry);
      return [definition.key, definition] as const;
    }));
    for (const [key, held] of [...this.held]) {
      const next = incoming.get(key);
      if (!next || next.signature !== held.definition.signature) {
        held.cell.remove();
        this.held.delete(key);
      }
    }
    for (const [key, definition] of incoming) {
      if (this.held.has(key)) {
        continue;
      }
      const cell = this.menu.add({
        id: definition.id,
        tool: `generated:${definition.id}`,
        label: definition.label,
        iconSrc: definition.iconSrc,
        tip: definition.tip,
        group: 'create',
        ...(definition.entry.schema.description ? { description: definition.entry.schema.description } : {}),
        ...(definition.entry.package ? { package: definition.entry.package } : {}),
      });
      cell.onClick = () => this.onOpen?.(definition);
      this.held.set(key, { definition, cell });
    }
  }

  /**
   * The definition that made a record (`generated.definition`): the first
   * listed with that id, the project's own before a package's. Fetched again
   * once when none is listed (the list may predate it).
   */
  async find(definitionId: string): Promise<GeneratedDefinition | null> {
    await this.ensureLoaded();
    const listed = this.lookup(definitionId);
    if (listed) {
      return listed;
    }
    await this.refresh();
    return this.lookup(definitionId);
  }

  /** The cell of the definition whose dialog is open reads as armed (null: none). */
  setActive(definition: GeneratedDefinition | null): void {
    for (const held of this.held.values()) {
      held.cell.setActive(definition !== null && held.definition.key === definition.key);
    }
  }

  private lookup(definitionId: string): GeneratedDefinition | null {
    const matches = this.definitions.filter(definition => definition.id === definitionId);
    return matches.find(definition => !definition.entry.package)
      ?? matches.find(definition => definition.entry.package?.availability !== 'library')
      ?? matches[0]
      ?? null;
  }
}
