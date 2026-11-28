// The load() statement a STEP import writes into the open model.

import { insertLoadCall, loadsModel, quoteForSingleQuotes } from '../../code-editor/index.ts';
import { appendTopLevelStatement } from '../insertion.ts';
import type { ApplyFeatureEditResult } from '../spec.ts';

/**
 * Write `load('<fileName>')` for a model the import just cached. With
 * `partLoc` (the timeline's active part) the statement lands at the end of
 * that `part()`'s callback body, where every other tool's statement goes: a
 * `load()` beside the part is not in the part, so the part exports and
 * inserts without it, and an assembly that inserts the part fails on it.
 * Without one it goes to the file's top level, as {@link insertLoadCall}
 * puts it. A no-op either way when the file already loads that model.
 */
export async function applyImportedLoad(
  code: string,
  fileName: string,
  partLoc?: { line: number; column: number },
): Promise<ApplyFeatureEditResult> {
  if (!partLoc) {
    return insertLoadCall(code, fileName);
  }
  if (await loadsModel(code, fileName)) {
    return { newCode: code };
  }
  return appendTopLevelStatement(
    code,
    () => `load('${quoteForSingleQuotes(fileName)}')`,
    'load',
    undefined,
    partLoc,
  );
}
