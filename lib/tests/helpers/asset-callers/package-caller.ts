import load from "../../../core/load.js";
import { Text } from "../../../features/2d/text.js";
import { AssetRoots } from "../../../io/asset-roots.js";
import type { FontOptions, ILoadFile, LoadOptions } from "../../../core/interfaces.js";

/**
 * Calls written in a file of their own, so a test can install an asset-root
 * source that maps this file — and only this one — to a package directory,
 * the way the server maps an installed package's files.
 */
export class PackageCaller {
  /** This file's path as the engine reads it off a stack. */
  static file(): string | null {
    return AssetRoots.callerFile();
  }

  static load(name: string, options?: LoadOptions): ILoadFile {
    return load(name, options);
  }

  static text(label: string, font: string, options?: FontOptions): Text {
    return new Text(label).font(font, options);
  }

  /** Runs `body` from this file: a callback the model passes in stays the model's. */
  static run<T>(body: () => T): T {
    return body();
  }
}
