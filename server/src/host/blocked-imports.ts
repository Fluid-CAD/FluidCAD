/**
 * Moved to lib/browser so the browser viewer's in-browser bundler can enforce
 * the same deny list without pulling in the server. Re-exported here to keep
 * LocalSceneHost and the model packer import paths unchanged.
 */
import { getBlockedNodeModule } from '../../../lib/dist/browser/blocked-imports.js';

export { BLOCKED_NODE_MODULES, getBlockedNodeModule } from '../../../lib/dist/browser/blocked-imports.js';

/**
 * The source-level scan for blocked imports: LocalSceneHost runs it on every
 * workspace and package module it transforms (research M5), and the package
 * installer on every `.js` file of an archive before it is installed. A
 * regex over `import … from`, `export … from` and `import()`, not a sandbox
 * (research open question 1).
 */
export class BlockedImports {
  private static readonly IMPORT_PATTERN =
    /\b(?:import|export)\s[\s\S]*?from\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  /** The first blocked specifier `code` imports, or null when it imports none. */
  static firstIn(code: string): string | null {
    const pattern = new RegExp(BlockedImports.IMPORT_PATTERN.source, 'g');
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const specifier = match[1] || match[2];
      if (getBlockedNodeModule(specifier)) {
        return specifier;
      }
    }
    return null;
  }

  /** The sentence a blocked `specifier` is refused with. */
  static refusal(specifier: string): string {
    const moduleName = getBlockedNodeModule(specifier) ?? specifier;
    return `Module "${specifier}" is not allowed in FluidCAD scripts. ` +
      `Access to Node.js "${moduleName}" module is restricted for security.`;
  }
}
