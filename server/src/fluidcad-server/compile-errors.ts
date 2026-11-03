// CompileErrors: a render that threw, as the pages and the render routes report it.

import { extractErrorSourceLocation } from '../../../lib/dist/index.js';
import { normalizePath } from '../normalize-path.ts';
import type { CompileError, PackageProblem } from '../ws-protocol.ts';

/**
 * A render of `filePath` that threw before it had a scene — a syntax error,
 * an import that doesn't resolve, a throw at the module's top level — as
 * the wire carries it: the message, the file, where it was thrown when the
 * stack says (the live-render prefix stripped), and the package imports the
 * render refused, structured, so the missing-package banner can offer to
 * install them. One description for every render path: the live render's
 * error replay and an assembly preview's answer.
 */
export class CompileErrors {
  static describe(filePath: string, err: unknown, packageProblems: PackageProblem[]): CompileError {
    const message = (err as { message?: string } | null)?.message || String(err);
    let sourceLocation = extractErrorSourceLocation(err);
    const normalized = normalizePath(filePath).replace('virtual:live-render:', '');
    if (sourceLocation) {
      sourceLocation = {
        filePath: sourceLocation.filePath.replace('virtual:live-render:', ''),
        line: sourceLocation.line,
        column: sourceLocation.column,
      };
    }
    return {
      message,
      filePath: normalized,
      sourceLocation: sourceLocation ?? undefined,
      ...(packageProblems.length > 0 ? { packageProblems } : {}),
    };
  }
}
