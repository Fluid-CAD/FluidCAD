import {
  endAssemblyPreview, getInsertParamExpressions, getScopeVariables, postPreviewWriter,
  type AssemblyPreviewAnswer, type InsertValue, type NewVariable, type PreviewWriterRequest,
} from '../../api';
import type { InstanceParamValue, SerializedAssembly, SerializedAssemblyInstance, SerializedAssemblyOccurrence } from '../../types';
import type { VariableInfo } from '../../ui/expression-core';
import type { FieldValue } from '../create-feature/schema/schema-fields';
import type { GeneratedDefinition } from './generated-definition';
import { GeneratedPanel } from './generated-panel';
import { PreviewRequests, type PreviewEdit } from './preview-requests';
import { AssemblyPreviewRunner, type PreviewRunnerOptions } from './preview-runner';
import { PreviewTokens } from './preview-tokens';

/** The insert an Edit parameters dialog edits: a generated occurrence's, or a generated part's instance's. */
export type GeneratedEditTarget = {
  kind: 'occurrence' | 'instance';
  /** The record's id — the row the edit comes from, sent with the writes (G8). */
  row: string;
  /** The record's name, for the title. */
  name: string;
  filePath: string;
  /** The `insert()`'s 1-based line in the editor's code. */
  line: number;
  /** The values it was built with, by id (defaults included). */
  values: Record<string, InstanceParamValue>;
};

/** The scene the page just applied, as the dialog reads it. */
export type GeneratedDialogScene = {
  absPath: string | null;
  sceneKind: 'part' | 'assembly';
  /** The scene's preview token; null for the file's own scene. */
  previewToken: string | null;
  assembly: SerializedAssembly | null;
};

export type GeneratedDialogHooks = {
  /** The dialog opens: the page closes the other assembly dialogs and drops the selection. */
  onEnter?: () => void;
  /** Which definition's dialog is open (null: none) — its menu cell reads as armed. */
  onActiveChange?: (definition: GeneratedDefinition | null) => void;
  /** The dialog closed by itself (its preview ended, its file left the screen): what the page tells the user. */
  notify?: (message: string) => void;
  /** Test seams: the preview request, its end, the Apply write, the edit's expression texts, the scope's variables. */
  send?: PreviewRunnerOptions['send'];
  end?: (token: string) => Promise<unknown>;
  write?: (writer: PreviewWriterRequest) => Promise<{ success: boolean; reason?: string }>;
  expressions?: (filePath: string, line: number) => Promise<Record<string, string> | null>;
  variables?: (line: number | null) => Promise<VariableInfo[]>;
};

type Session = {
  definition: GeneratedDefinition;
  panel: GeneratedPanel;
  runner: AssemblyPreviewRunner;
  token: string;
  filePath: string;
  /** The insert an edit rewrites; null for a create. */
  target: GeneratedEditTarget | null;
  applying: boolean;
  /** A render replaced the preview: the next scene of the file re-arms it. */
  rearm: boolean;
};

/**
 * The dialog of a generated part or assembly in an assembly (G4): the
 * custom-feature dialog over its values, previewing the real result — the
 * assembly rendered with the insert (create) or the values edit (Edit
 * parameters) applied in memory, opaque, in its own appearance — while the
 * user edits.
 *
 * The rules:
 * - **One token per dialog session**, kept in this tab's session storage
 *   ({@link PreviewTokens}) until its preview is ended or applied.
 * - **Create** previews the definition's defaults as it opens; **edit**
 *   previews nothing until a value changes (the scene on screen is already
 *   the insert as it stands). Previews follow {@link AssemblyPreviewRunner}'s
 *   timing: typing debounced, drags throttled, `'preview'` tier while a
 *   control moves, `'full'` once it settles.
 * - **Apply** settles a full-tier preview of the form first, then posts the
 *   writer request that preview rendered ({@link PreviewRequests.writerOf}):
 *   the editor's code then equals the previewed code, so the server serves
 *   Apply's render from the preview — which ends it (`replaced`), expected.
 *   A refusal keeps the dialog open with its reason. **Cancel** (and Escape)
 *   ends the preview: the saved code renders again, its parts from the cache.
 * - **When the preview ends without the dialog** (`assembly-preview-ended`):
 *   `replaced` (a save, an edit in the editor, a parameter change rendered
 *   the file's own code) rebuilds the preview on that new scene, saying so;
 *   `superseded` (another dialog's preview), `closed` (the file closed) and
 *   `end` close the dialog and say why. A scene of another file, or one
 *   where an edited insert is gone, closes it too. An edit follows its
 *   insert's line through renders, by its row.
 * - Values are written by id; a create writes only the rows the user set (an
 *   untouched row is the definition's default), an edit only the rows the
 *   user changed (`set`) and those emptied (`unset`, back to the default).
 */
export class GeneratedDialog {
  private session: Session | null = null;

  constructor(private readonly container: HTMLElement, private readonly hooks: GeneratedDialogHooks = {}) {}

  get isOpen(): boolean {
    return this.session !== null;
  }

  /** The open dialog's definition. */
  get definition(): GeneratedDefinition | null {
    return this.session?.definition ?? null;
  }

  /** The open dialog's preview token. */
  get token(): string | null {
    return this.session?.token ?? null;
  }

  get isEditing(): boolean {
    return this.session?.target !== null && this.session?.target !== undefined;
  }

  /** The open dialog's panel (tests drive it). */
  get panel(): GeneratedPanel | null {
    return this.session?.panel ?? null;
  }

  /**
   * What Edit parameters on a record opens: the generated definition that
   * made it and the insert to edit — a generated assembly's occurrence, or a
   * generated part's instance (its own `insert()`, with a source location);
   * null for any other record (its `param()` form edits it instead).
   */
  static editTargetOf(
    record: SerializedAssemblyInstance | SerializedAssemblyOccurrence,
  ): { definition: string; target: GeneratedEditTarget } | null {
    const location = record.sourceLocation;
    if (!record.generated || !location) {
      return null;
    }
    const occurrence = 'occurrenceId' in record;
    return {
      definition: record.generated.definition,
      target: {
        kind: occurrence ? 'occurrence' : 'instance',
        row: occurrence ? record.occurrenceId : record.instanceId,
        name: record.name,
        filePath: location.filePath,
        line: location.line,
        values: record.generated.values,
      },
    };
  }

  /** Insert `definition` into the assembly `filePath`: the dialog opens on its defaults, previewing them. */
  openCreate(definition: GeneratedDefinition, filePath: string): void {
    this.close({ end: true });
    this.hooks.onEnter?.();
    const session = this.begin(definition, filePath, null);
    session.panel.show();
    void this.loadVariables(session, null);
    session.runner.kick();
  }

  /** Edit the values of an existing insert of `definition`: the dialog opens on them (expressions as written). */
  async openEdit(definition: GeneratedDefinition, target: GeneratedEditTarget): Promise<void> {
    this.close({ end: true });
    this.hooks.onEnter?.();
    const session = this.begin(definition, target.filePath, target);
    const read = this.hooks.expressions ?? getInsertParamExpressions;
    const expressions = await read(target.filePath, target.line).catch(() => null);
    if (this.session !== session) {
      return;
    }
    const values: Record<string, FieldValue> = {};
    for (const id of Object.keys(definition.entry.schema.params)) {
      const seed = definition.seedValue(id, target.values[id], expressions?.[id]);
      if (seed !== undefined) {
        values[id] = seed;
      }
    }
    // A generated definition has no operations: the operation is not read.
    session.panel.showEdit({ values, operation: 'add', seedPicks: () => {} });
    session.panel.setTitle(`Edit ${target.name}`);
    void this.loadVariables(session, target.line);
  }

  /** Cancel (the button, Escape, or another dialog opening): the preview ends and the model shows its own code again. */
  cancel(): void {
    this.close({ end: true });
  }

  /** Apply: settle a full preview of the form, then write it. */
  async apply(): Promise<void> {
    const session = this.session;
    if (!session || session.applying) {
      return;
    }
    const edit = this.editOf(session, true);
    if ('error' in edit) {
      session.panel.setMessage(edit.error);
      return;
    }
    if (PreviewRequests.isNoChange(edit)) {
      this.close({ end: true });
      return;
    }
    session.applying = true;
    session.panel.setApplyEnabled(false);
    session.panel.setMessage(null);
    const settled = await session.runner.settle();
    if (this.session !== session) {
      return;
    }
    if (settled.ok === false) {
      this.refuseApply(session, settled.message);
      return;
    }
    const write = this.hooks.write ?? postPreviewWriter;
    const result = await write(PreviewRequests.writerOf(edit));
    if (this.session !== session) {
      return;
    }
    if (!result.success) {
      this.refuseApply(session, result.reason ?? 'Could not apply.');
      return;
    }
    // The write's render ends the preview (`replaced`): nothing to end here.
    this.close({ end: false });
  }

  /** `assembly-preview-ended`: the preview of `token` stopped showing, for `reason`. */
  handlePreviewEnded(token: string, reason: 'end' | 'superseded' | 'replaced' | 'closed'): void {
    const session = this.session;
    if (!session || session.token !== token || session.applying) {
      return;
    }
    switch (reason) {
      case 'replaced':
        session.rearm = true;
        return;
      case 'superseded':
        this.closeBecause('Another preview took over, so the dialog closed.');
        return;
      case 'closed':
        this.closeBecause('The assembly was closed, so the dialog closed.');
        return;
      case 'end':
        this.closeBecause('The preview was ended, so the dialog closed.');
        return;
    }
  }

  /**
   * Every scene the page applies. The file's own scene: the dialog closes
   * when its assembly left the screen, an edit follows its insert's line
   * (by its row) or closes when the insert is gone, and a preview a render
   * replaced is rebuilt on it. A preview scene changes nothing.
   */
  handleSceneRendered(scene: GeneratedDialogScene): void {
    const session = this.session;
    if (!session || session.applying || scene.previewToken !== null) {
      return;
    }
    if (scene.sceneKind !== 'assembly' || scene.absPath !== session.filePath) {
      this.closeBecause('The assembly is no longer on screen, so the dialog closed.');
      return;
    }
    if (session.target) {
      const line = GeneratedDialog.lineOf(session.target, session.definition, scene.assembly);
      if (line === null) {
        this.closeBecause(`${session.target.name} is no longer in the assembly, so the dialog closed.`);
        return;
      }
      session.target = { ...session.target, line };
    }
    if (session.rearm) {
      session.rearm = false;
      session.panel.setNote('The model changed, so the preview was rebuilt.');
      session.runner.kick();
    }
  }

  private begin(definition: GeneratedDefinition, filePath: string, target: GeneratedEditTarget | null): Session {
    const panel = new GeneratedPanel(this.container, definition);
    const token = PreviewTokens.create();
    const session: Session = {
      definition, panel, token, filePath, target, applying: false, rearm: false,
      runner: null as unknown as AssemblyPreviewRunner,
    };
    session.runner = new AssemblyPreviewRunner({
      token: () => session.token,
      edit: () => this.editOf(session, false),
      onAnswer: (answer) => this.hear(session, answer),
      onBusy: (busy) => session.panel.setUpdating(busy),
      ...(this.hooks.send ? { send: this.hooks.send } : {}),
    });
    panel.onChange = (change) => {
      panel.setMessage(null);
      panel.setNote(null);
      session.runner.changed(change);
    };
    panel.onApply = () => void this.apply();
    panel.onExit = () => this.cancel();
    this.session = session;
    this.hooks.onActiveChange?.(definition);
    return session;
  }

  /**
   * Close the dialog. `end`: end its preview when it may be showing (a
   * request went out) — not after Apply, whose render ends it. The token is
   * forgotten once the preview is over.
   */
  private close(opts: { end: boolean }): void {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = null;
    session.runner.stop();
    session.panel.hide();
    session.panel.destroy();
    this.hooks.onActiveChange?.(null);
    if (opts.end && session.runner.hasSent) {
      const end = this.hooks.end ?? endAssemblyPreview;
      void Promise.resolve(end(session.token)).catch(() => null).then(() => PreviewTokens.release(session.token));
    } else {
      PreviewTokens.release(session.token);
    }
  }

  /** Close on the dialog's own account and tell the user why. */
  private closeBecause(message: string): void {
    this.close({ end: true });
    this.hooks.notify?.(message);
  }

  private refuseApply(session: Session, message: string): void {
    session.applying = false;
    session.panel.setApplyEnabled(true);
    session.panel.setMessage(message);
  }

  /** The newest preview's answer: what the dialog says about it. */
  private hear(session: Session, answer: AssemblyPreviewAnswer): void {
    if (this.session !== session) {
      return;
    }
    switch (answer.state) {
      case 'rendered':
        if (!session.applying) {
          session.panel.setMessage(null);
        }
        return;
      case 'build-error': {
        const error = answer.objectErrors?.[0];
        session.panel.setMessage(error ? (error.name ? `${error.name}: ${error.message}` : error.message) : 'The result failed to build.');
        return;
      }
      case 'compile-error':
        session.panel.setMessage(`The result doesn't compile: ${answer.compileError?.message ?? 'compile error'}`);
        return;
      case 'refused':
        session.panel.setMessage(answer.reason);
        return;
      case 'superseded':
        // Only `ended` arrives: the preview is over, outside this dialog.
        if (!session.applying) {
          this.closeBecause('The preview was ended, so the dialog closed.');
        }
        return;
    }
  }

  /**
   * The edit the form describes: a create writes the rows the user set (an
   * untouched one is the definition's default) and refuses a required row
   * never filled in; an edit writes the rows the user changed and resets
   * the ones emptied. Hidden rows (`visibleWhen`) are left as they are.
   * `reveal`: Apply brings the row blocking it into view.
   */
  private editOf(session: Session, reveal: boolean): PreviewEdit | { error: string } {
    const { definition, panel, target } = session;
    const schema = panel.schema;
    const values: Record<string, InsertValue> = {};
    const unset: string[] = [];
    const newVariables: NewVariable[] = [];
    for (const [id, field] of panel.fields) {
      if (!field.visible) {
        continue;
      }
      const required = schema.required(id);
      const missing = `${schema.param(id).label} is required.`;
      if (!field.dirty) {
        if (target === null && required) {
          return this.blocked(panel, id, reveal, missing);
        }
        continue;
      }
      const read = field.read();
      if ('error' in read) {
        return this.blocked(panel, id, reveal, read.error);
      }
      if ('empty' in read) {
        if (required) {
          return this.blocked(panel, id, reveal, missing);
        }
        if (target !== null) {
          unset.push(id);
        }
        continue;
      }
      values[id] = definition.insertValue(id, read.value);
      if (read.newVariable && !newVariables.some(v => v.name === read.newVariable!.name)) {
        newVariables.push(read.newVariable);
      }
    }
    const declared = newVariables.length > 0 ? { newVariables } : {};
    if (target === null) {
      return {
        mode: 'create',
        filePath: session.filePath,
        definition: { file: definition.entry.file, exportName: definition.entry.exportName },
        values,
        ...declared,
      };
    }
    return { mode: 'edit', filePath: session.filePath, line: target.line, values, unset, row: target.row, ...declared };
  }

  private blocked(panel: GeneratedPanel, id: string, reveal: boolean, error: string): { error: string } {
    if (reveal) {
      panel.reveal(id);
    }
    return { error };
  }

  /** The variables the number rows offer: the assembly's, as of the edited insert's line for an edit. */
  private async loadVariables(session: Session, line: number | null): Promise<void> {
    const read = this.hooks.variables ?? ((at: number | null) => getScopeVariables(at, 'assembly'));
    const variables = await read(line).catch(() => [] as VariableInfo[]);
    if (this.session === session) {
      session.panel.setScopeVariables(variables);
    }
  }

  /** The line of an edited insert in a new scene: its row's record, still of the same definition and file; null when gone. */
  private static lineOf(target: GeneratedEditTarget, definition: GeneratedDefinition, assembly: SerializedAssembly | null): number | null {
    const record = target.kind === 'occurrence'
      ? assembly?.occurrences?.find(occ => occ.occurrenceId === target.row)
      : assembly?.instances.find(inst => inst.instanceId === target.row);
    if (!record?.sourceLocation || record.generated?.definition !== definition.id || record.sourceLocation.filePath !== target.filePath) {
      return null;
    }
    return record.sourceLocation.line;
  }
}
