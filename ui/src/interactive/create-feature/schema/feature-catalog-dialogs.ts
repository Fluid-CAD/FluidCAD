import {
  featureAssetUrl, getFeatureCatalog, type FeatureCatalogEntry, type FeatureMetaSnapshot,
} from '../../../api';
import { DEFAULT_ICON_SRC, ObjectIcons } from '../../../ui/object-icons';
import type { Navbar } from '../../../ui/navbar';
import type { FeatureDialogRegistry } from '../../feature-dialog-registry';
import { FeatureButton } from '../feature-button';
import { FeatureSchema } from './feature-schema';
import type { SchemaFeatureService } from './schema-feature-service';

/** Builds one feature's dialog; the page supplies the hooks it shares with every dialog. */
export type SchemaDialogFactory = (schema: FeatureSchema, iconSrc: string) => SchemaFeatureService;

/** A catalog entry the page can offer: one feature, with its metadata. */
type OfferedEntry = FeatureCatalogEntry & { id: string; meta: FeatureMetaSnapshot };

/**
 * The workspace's custom features on the page: one schema dialog (with its
 * toolbar button and its timeline rows) per feature the catalog offers,
 * registered with the page's dialog registry like the built-ins, and each
 * feature's icon for its timeline rows. A refresh (the engine coming up, a
 * `features-changed`) rebuilds only the dialogs whose metadata changed, so a
 * dialog open on an unrelated feature stays open.
 *
 * An entry the catalog can't offer — a module that fails to load, an id two
 * builders share, a module exporting no feature — gets a greyed button
 * whose tooltip says why, and a console warning; nothing louder.
 */
export class FeatureCatalogDialogs {
  /** What the page offers changed — the Finish Sketch swap and the timeline re-read it. */
  onChange?: () => void;

  private readonly dialogs = new Map<string, { service: SchemaFeatureService; signature: string }>();
  private readonly broken = new Map<string, { button: FeatureButton; error: string }>();
  /** Bumped on every module change, so a rebuilt dialog's icon is fetched fresh. */
  private revision = 0;
  /** The latest refresh — an older one's answer is dropped. */
  private ticket = 0;

  constructor(
    private readonly registry: FeatureDialogRegistry,
    private readonly navbar: Navbar,
    private readonly create: SchemaDialogFactory,
  ) {}

  /** The registered dialogs, by feature id. */
  get services(): SchemaFeatureService[] {
    return [...this.dialogs.values()].map(d => d.service);
  }

  /** The greyed buttons of the entries that can't be offered (the Finish Sketch swap hides them too). */
  get brokenButtons(): FeatureButton[] {
    return [...this.broken.values()].map(b => b.button);
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
    this.apply(entries);
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
      }
    }
    for (const [id, entry] of offered) {
      if (this.dialogs.has(id)) {
        continue;
      }
      const icon = entry.meta.icon ? featureAssetUrl(id, entry.meta.icon, this.revision) : DEFAULT_ICON_SRC;
      const service = this.create(new FeatureSchema(entry.meta), icon);
      this.registry.register(service);
      ObjectIcons.register(id, icon);
      this.dialogs.set(id, { service, signature: FeatureCatalogDialogs.signatureOf(entry) });
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
    ObjectIcons.unregister(id);
    this.dialogs.delete(id);
  }

  /** One greyed button per entry that can't be offered; answers whether the set changed. */
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
      this.broken.get(key)?.button.remove();
      const label = entry.meta?.label ?? FeatureCatalogDialogs.moduleLabel(entry.modulePath);
      const group = this.navbar.getGroup('create') ?? this.navbar.addGroup('create', { visible: false, immune: true });
      const button = new FeatureButton(group, {
        icon: DEFAULT_ICON_SRC,
        label,
        tip: `${label} can't be offered: ${error}`,
        ariaLabel: `${label} can't be offered`,
      });
      button.setDisabled(true);
      this.broken.set(key, { button, error });
      console.warn(`[feature catalog] ${entry.modulePath}: ${error}`);
      changed = true;
    }
    for (const [key, held] of [...this.broken]) {
      if (!keep.has(key)) {
        held.button.remove();
        this.broken.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** What a dialog is built from: a change here rebuilds it. */
  private static signatureOf(entry: OfferedEntry): string {
    return JSON.stringify(entry.meta);
  }

  /** `…/bolt-boss.feature.js` → `bolt-boss`. */
  private static moduleLabel(modulePath: string): string {
    const file = modulePath.split(/[\\/]/).pop() ?? modulePath;
    return file.replace(/\.feature\.js$/, '');
  }
}
