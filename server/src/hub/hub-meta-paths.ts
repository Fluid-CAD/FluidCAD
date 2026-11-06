import { posix } from 'path';

/**
 * A feature's metadata from a hub version's manifest, with every image it
 * declares moved onto the engine's file proxy (hub-plan H11): the icon,
 * each option's `image`, and the images of its `layout`, its `aside` and
 * each value's `aside`, which are exactly what `listFeatureAssets` lists
 * and what `fluidcad pack` ships.
 *
 * A declared path is relative to the feature's module (`./icons/m3.svg`
 * beside `features/fastener.feature.js` is `features/icons/m3.svg`), and
 * pack refuses one that leaves the module's directory, so a path that
 * does, or isn't text, is dropped rather than rewritten: the UI then shows
 * no image, never one from elsewhere. The result is a deep copy; the
 * manifest is left as it came.
 */
export class HubMetaPaths {
  /** `meta` with its image paths on `api/hub/files/@s/n/<version>/…`; null when it isn't an object. */
  static rewrite(meta: unknown, module: string, name: string, version: string): Record<string, unknown> | null {
    if (!HubMetaPaths.isRecord(meta)) {
      return null;
    }
    const resolver = new HubMetaPaths(module, name, version);
    const copy = HubMetaPaths.clone(meta) as Record<string, unknown>;
    resolver.replace(copy, 'icon');
    if (HubMetaPaths.isRecord(copy.params)) {
      for (const spec of Object.values(copy.params)) {
        if (!HubMetaPaths.isRecord(spec)) {
          continue;
        }
        if (Array.isArray(spec.options)) {
          for (const option of spec.options) {
            if (HubMetaPaths.isRecord(option)) {
              resolver.replace(option, 'image');
            }
          }
        }
        resolver.items(spec.aside);
      }
    }
    resolver.items(copy.layout);
    resolver.items(copy.aside);
    return copy;
  }

  /**
   * The archive path `path` names, declared by the feature in `module`;
   * null when it leaves the module's directory (or isn't a relative path).
   */
  static resolve(module: string, path: string): string | null {
    if (path === '' || path.startsWith('/') || path.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
      return null;
    }
    const directory = posix.dirname(module);
    const resolved = posix.normalize(posix.join(directory, path));
    const inside = directory === '.' ? !resolved.startsWith('../') && resolved !== '..' : resolved.startsWith(`${directory}/`);
    if (!inside || resolved.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return null;
    }
    return resolved;
  }

  /** The engine's proxy path for a file of `name@version` (relative, like every engine URL the page uses). */
  static fileUrl(name: string, version: string, path: string): string {
    const segments = path.split('/').map((part) => encodeURIComponent(part)).join('/');
    return `api/hub/files/${name}/${encodeURIComponent(version)}/${segments}`;
  }

  private constructor(private readonly module: string, private readonly name: string, private readonly version: string) {}

  /** `holder[key]` rewritten, or removed when it can't be. */
  private replace(holder: Record<string, unknown>, key: string): void {
    if (!(key in holder)) {
      return;
    }
    const value = holder[key];
    const resolved = typeof value === 'string' ? HubMetaPaths.resolve(this.module, value) : null;
    if (resolved === null) {
      delete holder[key];
      return;
    }
    holder[key] = HubMetaPaths.fileUrl(this.name, this.version, resolved);
  }

  /** A layout or aside list: each item's `image`, and the items inside rows, sections and tabs (as `FeatureLayouts.images` walks them). */
  private items(list: unknown): void {
    if (!Array.isArray(list)) {
      return;
    }
    for (const item of list) {
      if (!HubMetaPaths.isRecord(item)) {
        continue;
      }
      this.replace(item, 'image');
      this.items(item.row);
      this.items(item.items);
      this.items(item.tabs);
    }
  }

  private static clone(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => HubMetaPaths.clone(entry));
    }
    if (HubMetaPaths.isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, HubMetaPaths.clone(entry)]));
    }
    return value;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}
