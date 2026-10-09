import {
  featureAssetUrl, getFeatureCatalog, type FeatureCatalogEntry, type FeatureMetaSnapshot,
} from '../../../api';
import { iconUrl } from '../../../ui/icon-url';
import { DEFAULT_ICON_SRC, ObjectIcons } from '../../../ui/object-icons';
import type { Navbar } from '../../../ui/navbar';
import type { FeatureDialogRegistry } from '../../feature-dialog-registry';
import { FeatureButton, type FeatureLauncher } from '../feature-button';
import { CustomFeaturesMenu, type CustomFeatureCell } from './custom-features-menu';
import { FeatureSchema } from './feature-schema';
import type { SchemaFeatureService } from './schema-feature-service';

/**
 * Builds one feature's dialog; the page supplies the hooks it shares with
 * every dialog. `launcher`: where the dialog opens from — a cell of the
 * custom features menu; absent, its own button in its metadata's group.
 */
export type SchemaDialogFactory = (schema: FeatureSchema, iconSrc: string, launcher?: FeatureLauncher) => SchemaFeatureService;

/** How every {@link featureAssetUrl} starts. */
const FEATURE_ASSET_PREFIX = 'api/features/asset?';

/** A catalog entry the page can offer: one feature, with its metadata. */
type OfferedEntry = FeatureCatalogEntry & { id: string; meta: FeatureMetaSnapshot };

/**
 * The catalog's features on the page — the workspace's custom features and
 * the engine's own that describe themselves the same way (Draft): one
 * schema dialog (with its timeline rows) per feature the catalog offers,
 * registered with the page's dialog registry like the built-ins, and each
 * feature's icon for its timeline rows. A refresh (the engine coming up, a
 * `features-changed`) rebuilds only the dialogs whose metadata changed, so a
 * dialog open on an unrelated feature stays open; after a module changed, an
 * open dialog it kept asks for its preview again, as the saved code builds it.
 *
 * The workspace's features open from one toolbar button, the custom
 * features {@link menu}: a cell apiece. A built-in keeps a regular button in
 * its group, as the product's own tools do.
 *
 * An entry the catalog can't offer — a module that fails to load, an id two
 * builders share, a module exporting no feature — gets a greyed cell (a
 * greyed button for a built-in) whose tooltip says why, and a console
 * warning; nothing louder.
 */
export class FeatureCatalogDialogs {
  /** What the page offers changed — the Finish Sketch swap and the timeline re-read it. */
  onChange?: () => void;

  /** The toolbar's Custom dropdown, listing the workspace's features. */
  readonly menu: CustomFeaturesMenu;

  private readonly dialogs = new Map<string, {
    service: SchemaFeatureService; signature: string; builtIn: boolean;
    /** The icon file a workspace feature declares, as declared. */
    icon: string | null;
    /** Its cell in the Custom dropdown; null for a built-in's own button. */
    cell: CustomFeatureCell | null;
  }>();
  private readonly broken = new Map<string, { launcher: FeatureLauncher; error: string }>();
  /** Bumped on every module change, so an image shown after one — a rebuilt dialog's, a kept one's — is fetched fresh. */
  private revision = 0;
  /** The latest refresh — an older one's answer is dropped. */
  private ticket = 0;

  constructor(
    private readonly registry: FeatureDialogRegistry,
    private readonly navbar: Navbar,
    private readonly create: SchemaDialogFactory,
  ) {
    this.menu = new CustomFeaturesMenu(navbar);
  }

  /** The registered dialogs, by feature id. */
  get services(): SchemaFeatureService[] {
    return [...this.dialogs.values()].map(d => d.service);
  }

  /** The greyed toolbar buttons of built-ins that can't be offered (the Finish Sketch swap hides them too). */
  get brokenButtons(): FeatureButton[] {
    return [...this.broken.values()].flatMap(b => (b.launcher instanceof FeatureButton ? [b.launcher] : []));
  }

  /** Fetch the catalog and bring the page in line with it. `changed`: a module changed since the last fetch. */
  async refresh(opts: { changed?: boolean } = {}): Promise<void> {
    const ticket = ++this.ticket;
    if (opts.changed) {
      this.revision++;
    }
    const entries = await getFeatureCatalog();
    if (entries === null || ticket !== this.ticket) {
      return;
    }
    const kept = opts.changed ? new Set(this.services) : null;
    this.apply(entries);
    // A dialog its metadata didn't rebuild previews the module's old code.
    for (const service of this.services) {
      if (kept?.has(service)) {
        service.codeChanged();
      }
    }
    if (opts.changed) {
      this.reloadImages(kept ?? new Set());
    }
  }

  /**
   * A saved image leaves the metadata as it was, so no dialog is rebuilt for
   * it: every image a kept dialog, the menu and the timeline show is asked
   * for again at the new revision — the icons where they stand, an option's
   * image through its row.
   */
  private reloadImages(kept: ReadonlySet<SchemaFeatureService>): void {
    for (const [id, held] of this.dialogs) {
      if (!held.builtIn && held.icon !== null) {
        ObjectIcons.register(id, featureAssetUrl(id, held.icon, this.revision));
      }
      if (kept.has(held.service)) {
        held.service.assetsChanged();
      }
    }
    FeatureCatalogDialogs.repoint(document, this.revision);
    // A closed dropdown's cells are off the page.
    for (const cell of this.menu.entries) {
      FeatureCatalogDialogs.repoint(cell.el, this.revision);
    }
  }

  /** Point every feature image under `root` at `revision`, so the browser fetches the file again. */
  private static repoint(root: ParentNode, revision: number): void {
    for (const img of root.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      if (src?.startsWith(FEATURE_ASSET_PREFIX)) {
        img.setAttribute('src', `${src.replace(/&v=\d+$/, '')}&v=${revision}`);
      }
    }
  }

  /** Bring the page in line with `entries`. */
  apply(entries: readonly FeatureCatalogEntry[]): void {
    const offered = new Map<string, OfferedEntry>();
    const broken: FeatureCatalogEntry[] = [];
    for (const entry of entries) {
      if (entry.error === undefined && entry.id && entry.meta) {
        offered.set(entry.id, entry as OfferedEntry);
      } else {
        broken.push(entry);
      }
    }
    let changed = false;
    for (const [id, held] of [...this.dialogs]) {
      const entry = offered.get(id);
      if (!entry || FeatureCatalogDialogs.signatureOf(entry) !== held.signature) {
        this.remove(id);
        changed = true;
      } else {
        // Same metadata, same dialog — but a library package the project
        // just pinned by using it is now a dependency: its cell follows.
        held.cell?.setPackage(entry.package);
      }
    }
    for (const [id, entry] of offered) {
      if (this.dialogs.has(id)) {
        continue;
      }
      const icon = FeatureCatalogDialogs.iconOf(entry, this.revision);
      // Read at each ask, so an image shown after a save is the saved one.
      const schema = new FeatureSchema(entry.meta, {
        assetUrl: entry.builtIn ? undefined : path => featureAssetUrl(id, path, this.revision),
      });
      const cell = entry.builtIn ? null : this.menu.add({
        id, label: schema.label, iconSrc: icon, tip: schema.tip, group: FeatureCatalogDialogs.groupOf(entry.meta),
        ...(entry.package ? { package: entry.package } : {}),
      });
      const service = cell ? this.create(schema, icon, cell) : this.create(schema, icon);
      this.registry.register(service);
      // A built-in's rows already read the product's own icon by their type.
      if (!entry.builtIn) {
        ObjectIcons.register(id, icon);
      }
      this.dialogs.set(id, {
        service, signature: FeatureCatalogDialogs.signatureOf(entry), builtIn: entry.builtIn,
        icon: entry.builtIn ? null : entry.meta.icon ?? null,
        cell,
      });
      changed = true;
    }
    changed = this.syncBroken(broken) || changed;
    if (changed) {
      this.onChange?.();
    }
  }

  private remove(id: string): void {
    const held = this.dialogs.get(id);
    if (!held) {
      return;
    }
    this.registry.unregister(held.service.id);
    held.service.destroy();
    if (!held.builtIn) {
      ObjectIcons.unregister(id);
    }
    this.dialogs.delete(id);
  }

  /**
   * A feature's icon: a built-in's is the product's own artwork, by its id
   * (`icons/draft.png`); a workspace feature's is the file its metadata
   * names, served from its module's directory; the generic icon otherwise.
   */
  private static iconOf(entry: OfferedEntry, revision: number): string {
    if (entry.builtIn) {
      return iconUrl(entry.id);
    }
    return entry.meta.icon ? featureAssetUrl(entry.id, entry.meta.icon, revision) : DEFAULT_ICON_SRC;
  }

  /** One greyed cell (a built-in's: button) per entry that can't be offered; answers whether the set changed. */
  private syncBroken(entries: readonly FeatureCatalogEntry[]): boolean {
    const keep = new Set<string>();
    let changed = false;
    for (const entry of entries) {
      const key = `${entry.modulePath}#${entry.id ?? ''}#${entry.exportName ?? ''}`;
      const error = entry.error ?? 'the feature cannot be offered';
      keep.add(key);
      if (this.broken.get(key)?.error === error) {
        continue;
      }
      this.broken.get(key)?.launcher.remove();
      const label = entry.meta?.label ?? FeatureCatalogDialogs.moduleLabel(entry.modulePath);
      const tip = `${label} can't be offered: ${error}`;
      this.broken.set(key, { launcher: this.brokenLauncher(entry, label, tip), error });
      console.warn(`[feature catalog] ${entry.modulePath}: ${error}`);
      changed = true;
    }
    for (const [key, held] of [...this.broken]) {
      if (!keep.has(key)) {
        held.launcher.remove();
        this.broken.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** A workspace entry greys in the menu; a built-in greys on the bar, where its button would be. */
  private brokenLauncher(entry: FeatureCatalogEntry, label: string, tip: string): FeatureLauncher {
    if (!entry.builtIn) {
      return this.menu.add({
        id: entry.id, label, iconSrc: DEFAULT_ICON_SRC, tip, group: FeatureCatalogDialogs.groupOf(entry.meta), disabled: true,
        ...(entry.package ? { package: entry.package } : {}),
      });
    }
    const group = this.navbar.getGroup('create') ?? this.navbar.addGroup('create', { visible: false, immune: true });
    const button = new FeatureButton(group, {
      icon: DEFAULT_ICON_SRC,
      label,
      tip,
      ariaLabel: `${label} can't be offered`,
    });
    button.setDisabled(true);
    return button;
  }

  /** Which half of the menu a feature lists in: modify, or create (also for an entry with no metadata). */
  private static groupOf(meta: FeatureMetaSnapshot | null | undefined): 'create' | 'modify' {
    return meta?.group === 'modify' ? 'modify' : 'create';
  }

  /** What a dialog is built from: a change here rebuilds it. */
  private static signatureOf(entry: OfferedEntry): string {
    return JSON.stringify({ meta: entry.meta });
  }

  /** `…/bolt-boss.feature.js` → `bolt-boss`. */
  private static moduleLabel(modulePath: string): string {
    const file = modulePath.split(/[\\/]/).pop() ?? modulePath;
    return file.replace(/\.feature\.js$/, '');
  }
}
