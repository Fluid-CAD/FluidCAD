import { getScopeVariables } from '../../api';
import { VariableInfo } from '../../ui/expression-core';

/**
 * The async label pass every feature service shares: options bound to
 * variables show their names ("ringAxis — line 5"). The lookup resolves over
 * the live buffer server-side, so the result is applied only if the dialog
 * is still armed on the same option sets when it lands — `sign` is the
 * stable signature that detects a changed set.
 */
export class OptionRelabeler<T> {
  private signature = '';

  constructor(private readonly opts: {
    sign: (value: T) => string;
    load: (value: T) => Promise<T>;
    isArmed: () => boolean;
    apply: (value: T) => void;
  }) {}

  async refresh(value: T): Promise<void> {
    const signature = this.opts.sign(value);
    this.signature = signature;
    const labeled = await this.opts.load(value);
    if (!this.opts.isArmed() || this.signature !== signature) {
      return;
    }
    this.opts.apply(labeled);
  }
}

/**
 * Push the variables in scope at the statement (edit mode) or at the end of
 * the file (create mode) to the dialog's expression fields. A response
 * landing after the dialog closed or re-targeted is dropped — `stillCurrent`
 * re-checks armed state and the edit target's line.
 */
export async function refreshScopeVariables(
  line: number | null,
  panel: { setScopeVariables(variables: VariableInfo[]): void },
  stillCurrent: () => boolean,
): Promise<void> {
  const variables = await getScopeVariables(line);
  if (stillCurrent()) {
    panel.setScopeVariables(variables);
  }
}
