/**
 * The wording the parameter and property dialogs share for a delete: what
 * deleting a declaration does to every file that reads it, or why it cannot
 * be done yet. The server plans the delete (`deletion` on a usage answer);
 * this only puts the plan into a sentence.
 */

import type { DeletionPlan, UsageFileSummary } from '../api';

export type DeclarationNoun = 'parameter' | 'property';

/** The dialog's delete prompt: a warning to confirm, or a refusal that blocks the delete. */
export type DeletionWording = { blocked: boolean; text: string };

/** A file as the dialog names it: its name alone. */
function fileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

/** `plate.part.js (lines 8, 11) and frame.assembly.js (line 5)` */
function describeFiles(files: UsageFileSummary[]): string {
  const parts = files.map((file) => {
    const more = file.count > file.lines.length ? ', …' : '';
    const noun = file.lines.length === 1 && file.count === 1 ? 'line' : 'lines';
    return `${fileName(file.filePath)} (${noun} ${file.lines.join(', ')}${more})`;
  });
  if (parts.length <= 1) {
    return parts[0] ?? '';
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function count(files: UsageFileSummary[]): number {
  return files.reduce((sum, file) => sum + file.count, 0);
}

/**
 * Word a delete from its plan. A read the value cannot replace blocks the
 * delete outright — the model would stop building — so the wording names
 * the reads to rewrite instead of asking for confirmation. Otherwise it
 * says what the reads become and which overrides go.
 */
export function describeDeletionPlan(noun: DeclarationNoun, key: string, plan: DeletionPlan): DeletionWording {
  const quoted = `“${key}”`;
  if (plan.blocked.length > 0) {
    const value = plan.value === null
      ? 'It has no value to put in place of its reads'
      : `Its value (${plan.value}) reads names that are out of scope`;
    return {
      blocked: true,
      text: `${quoted} cannot be deleted yet. ${value} in ${describeFiles(plan.blocked)}. `
        + `Rewrite those reads by hand, then delete the ${noun}.`,
    };
  }
  const replaced = count(plan.replaced);
  const dropped = count(plan.dropped);
  if (replaced === 0 && dropped === 0) {
    return { blocked: false, text: `Delete ${quoted}? Its declaration is removed from the code.` };
  }
  const effects: string[] = [];
  if (replaced > 0) {
    const reads = replaced === 1 ? 'Its read' : `Its ${replaced} reads`;
    const what = noun === 'parameter' ? 'default value' : 'value';
    effects.push(`${reads} in ${describeFiles(plan.replaced)} become${replaced === 1 ? 's' : ''} its ${what} ${plan.value}`);
  }
  if (dropped > 0) {
    const inserts = dropped === 1 ? 'one insert' : `${dropped} inserts`;
    const subject = effects.length === 0 ? 'The' : 'the';
    effects.push(`${subject} ${key} override on ${inserts} in ${describeFiles(plan.dropped)} is dropped`);
  }
  return { blocked: false, text: `Delete ${quoted}? ${effects.join(', and ')}.` };
}
