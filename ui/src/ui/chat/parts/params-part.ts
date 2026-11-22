import { ChatIcons } from '../chat-icons';
import type { ChatPart, ParamCardItem, ParamCardValue, ParamKeptValue, ParamsPart } from '../chat-types';
import {
  ParamDebouncer,
  bindParamHandlers,
  controlSignature,
  effectiveControlType,
  paramRowKey,
  renderParamControl,
  updateParamValuesInPlace,
  type ParamRowDefinition,
} from '../../param-row';
import type { PartContext, PartView } from './part-view';

/**
 * A parameter of the model on screen as a card reads it: what the
 * Parameters panel draws a row from, plus the value the active
 * configuration row gives it (the value a session change sits on).
 */
export type ParamCardDefinition = ParamRowDefinition & {
  kind?: 'part' | 'assembly' | 'global';
  configuredValue?: ParamCardValue;
};

/** The model on screen, as a parameter card reads it. */
export type ParamCardModel = {
  /** The model file on screen, absolute; null when none is. */
  file: string | null;
  /** What its last render declared, each with the value it has now. */
  params: ParamCardDefinition[];
  /** The `configurations()` row on screen; `Default` for the `param()` literals. */
  configuration: string;
};

/** What a parameter card needs from the page: the model on screen, and the engine's own value routes. */
export type ParamCardHost = {
  model(): ParamCardModel;
  /** `listener` is told after every render, and when another model comes on screen; returns what stops it. */
  onModelChange(listener: () => void): () => void;
  /** Set a session value: the model on screen follows, and nothing is written. `body` is the declaring part or assembly. */
  set(label: string, value: unknown, body?: string): void;
  /** Drop the session values of these parameters, so each reads the file's value again. */
  reset(params: { label: string; body?: string }[]): void;
  /**
   * Write a value into the source where `configuration` keeps it: the
   * `param()` default on `Default`, else that row's cell. Absent on a host
   * that cannot edit source: the card then offers no Keep.
   */
  keep?(label: string, value: unknown, body: string | undefined, configuration: string): Promise<{ success: boolean; reason?: string }>;
};

const DEFAULT_CONFIGURATION = 'Default';

/** How the card stands to the model on screen. */
type Availability =
  /** The page gave the card no model to read (a host without one). */
  | 'no-model'
  /** Another file is on screen, or none. */
  | 'other-file'
  /** The card's file is on screen: each parameter it still declares is a live control. */
  | 'live';

/**
 * What the agent offered through `offer_params` (docs/agent-chat-plan.md
 * §26), as one card: a control per parameter, drawn and wired by the
 * Parameters panel's own rows (`param-row.ts`), so a slider, a number, a
 * select and a switch look and behave here as they do there.
 *
 * The card holds no value. A control sets a session value in the engine;
 * the render that follows comes back to every page, and the card, the
 * Parameters panel and a second tab all draw it. So the card is a view of
 * the model on screen: it stays usable after its turn, a reloaded page shows
 * it as the model now is, and a parameter the model no longer declares (the
 * file changed, another file is open) is listed as unavailable instead of
 * failing. The part names the parameters and nothing else.
 *
 * **Reset** drops the session values of the card's parameters. **Keep**
 * writes them into the source as the parameters' defaults (on a
 * configuration row, as that row's values), one parameter after the other
 * through the Parameters panel's own write, then tells the session, which
 * tells the agent with the next message. Both act on the card's parameters
 * whose value differs from the file's, whoever set it.
 *
 * Labels, part names, option texts and the note come from the model file
 * and the agent: the note and the unavailable rows are set as text, and a
 * live row goes through the panel's escaping with its numbers checked first.
 */
export class ParamsPartView implements PartView {
  readonly el: HTMLDivElement;
  private part: ParamsPart;
  private readonly unsubscribe: (() => void) | null;
  private readonly debouncer = new ParamDebouncer();
  private readonly rows: HTMLDivElement;
  private readonly foot: HTMLDivElement;
  /** What the rows were last drawn from: an in-place update is enough while it holds. */
  private drawn = '';
  private busy: 'keep' | null = null;
  /** Why the last Keep did not write everything. */
  private error: string | null = null;

  constructor(part: ParamsPart, private readonly ctx: PartContext) {
    this.part = part;
    this.el = document.createElement('div');
    this.el.className = 'chat-params';
    this.el.dataset.part = 'params';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', `Parameters of ${part.file}`);

    const head = document.createElement('div');
    head.className = 'chat-params-head';
    const title = document.createElement('span');
    title.className = 'chat-params-title';
    title.append(ChatIcons.span(ChatIcons.PARAMS, '[&>svg]:size-3.5'), text('Parameters'));
    const file = document.createElement('span');
    file.className = 'chat-params-file';
    file.dataset.ref = 'params-file';
    file.textContent = part.file;
    file.title = part.file;
    head.append(title, file);
    this.el.append(head);
    if (part.note) {
      const note = document.createElement('div');
      note.className = 'chat-params-note';
      note.dataset.ref = 'params-note';
      note.textContent = part.note;
      this.el.append(note);
    }
    this.rows = document.createElement('div');
    this.rows.className = 'chat-params-rows';
    this.rows.dataset.ref = 'params-rows';
    this.foot = document.createElement('div');
    this.foot.className = 'chat-params-foot';
    this.el.append(this.rows, this.foot);

    this.unsubscribe = ctx.params?.onModelChange(() => this.sync()) ?? null;
    this.sync();
  }

  update(part: ChatPart): void {
    if (part.type !== 'params') {
      return;
    }
    // Only what was kept changes on a card; the controls follow the model, not the part.
    this.part = part;
    this.paintFoot();
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  // --- The model on screen ----------------------------------------------------

  private availability(model: ParamCardModel | null): Availability {
    if (!model) {
      return 'no-model';
    }
    return model.file !== null && samePath(model.file, this.part.absPath) ? 'live' : 'other-file';
  }

  /** The card's parameters the model on screen declares now, in the card's order (null: not declared). */
  private definitions(model: ParamCardModel | null): (ParamCardDefinition | null)[] {
    if (this.availability(model) !== 'live') {
      return this.part.params.map(() => null);
    }
    return this.part.params.map((item) => {
      const def = model!.params.find((p) => p.kind !== 'global' && p.label === item.label && p.body === item.part);
      return def ? checked(def) : null;
    });
  }

  /** The live parameters whose value is not the file's: a session value sits on them. */
  private changed(model: ParamCardModel | null): ParamCardDefinition[] {
    return this.definitions(model).filter((def): def is ParamCardDefinition => def !== null && !sameValue(def.currentValue, def.configuredValue ?? def.defaultValue));
  }

  /** The model changed (a render, another file): redraw the rows, or only their values when the controls are the same. */
  private sync(): void {
    const model = this.ctx.params?.model() ?? null;
    const availability = this.availability(model);
    const defs = this.definitions(model);
    const signature = JSON.stringify([
      availability,
      defs.map((def) => {
        if (def === null) {
          return null;
        }
        // A multi-value control is redrawn with its value: the panel's in-place path does not reach inside it.
        return [controlSignature(def), def.multi ? def.currentValue : null];
      }),
    ]);
    this.el.dataset.live = String(availability === 'live' && defs.some((def) => def !== null));
    if (signature === this.drawn) {
      updateParamValuesInPlace(this.rows, defs.filter((def): def is ParamCardDefinition => def !== null));
    } else {
      this.drawn = signature;
      this.paintRows(availability, defs);
    }
    this.markChanged(defs);
    this.paintFoot();
  }

  private paintRows(availability: Availability, defs: (ParamCardDefinition | null)[]): void {
    this.rows.replaceChildren();
    // Two parts' parameters of one label read apart by the part's name.
    const labels = this.part.params.map((item) => item.label);
    const shared = new Set(labels.filter((label, index) => labels.indexOf(label) !== index));
    this.part.params.forEach((item, index) => {
      const def = defs[index];
      if (def === null) {
        this.rows.append(this.staticRow(item, availability === 'live' ? 'No longer in the model' : null, shared.has(item.label)));
        return;
      }
      const row = document.createElement('div');
      row.className = 'chat-params-row';
      row.dataset.ref = 'param';
      row.dataset.label = item.label;
      // The panel's own row: its markup escapes the label, the description and the option texts.
      row.innerHTML = renderParamControl({ ...def, group: undefined }, { editable: false, ...(shared.has(item.label) && item.part !== undefined ? { owner: item.part } : {}) });
      this.rows.append(row);
    });
    const host = this.ctx.params;
    if (!host) {
      return;
    }
    const lookup = (key: string) => defs.find((def) => def !== null && paramRowKey(def) === key) ?? undefined;
    bindParamHandlers(this.rows, {
      // The newest definition: a render may have moved the value since the rows were drawn.
      lookup: (key) => this.definitions(host.model()).find((def) => def !== null && paramRowKey(def) === key) ?? lookup(key),
      setValue: (key, value) => {
        const def = lookup(key);
        if (def) {
          this.error = null;
          host.set(def.label, value, def.body);
        }
      },
      debouncer: this.debouncer,
      // A session value costs a render and nothing else: it goes as the user goes.
      sendOn: 'live',
    });
  }

  /** A parameter with no control: its label, and why when the model on screen dropped it. No value: the card has none of its own. */
  private staticRow(item: ParamCardItem, why: string | null, withPart: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-params-row chat-params-missing';
    row.dataset.ref = 'param';
    row.dataset.label = item.label;
    row.dataset.missing = 'true';
    const name = document.createElement('span');
    name.className = 'chat-params-missing-label';
    name.textContent = item.label;
    if (withPart && item.part !== undefined) {
      const owner = document.createElement('span');
      owner.className = 'chat-params-missing-owner';
      owner.textContent = ` ${item.part}`;
      name.append(owner);
    }
    row.append(name);
    if (why) {
      const reason = document.createElement('span');
      reason.className = 'chat-params-missing-why';
      reason.dataset.ref = 'param-why';
      reason.textContent = why;
      row.append(reason);
    }
    return row;
  }

  /** A changed parameter's row says so (its label is drawn bold), without a redraw taking the focus from its control. */
  private markChanged(defs: (ParamCardDefinition | null)[]): void {
    const rows = [...this.rows.children] as HTMLElement[];
    defs.forEach((def, index) => {
      const row = rows[index];
      if (row && def !== null) {
        row.dataset.changed = String(!sameValue(def.currentValue, def.configuredValue ?? def.defaultValue));
      }
    });
  }

  // --- Reset and Keep -----------------------------------------------------------

  private paintFoot(): void {
    const host = this.ctx.params;
    const model = host?.model() ?? null;
    const availability = this.availability(model);
    const defs = this.definitions(model);
    const changed = this.changed(model);
    this.foot.replaceChildren();

    if (this.part.kept && this.part.kept.length > 0) {
      const kept = document.createElement('div');
      kept.className = 'chat-params-kept';
      const words = document.createElement('span');
      words.dataset.ref = 'params-kept';
      words.textContent = `Kept in the file: ${this.part.kept.map(keptText).join(', ')}`;
      kept.append(ChatIcons.span(ChatIcons.CHECK, '[&>svg]:size-3.5 mt-px'), words);
      this.foot.append(kept);
    }
    if (this.error) {
      const error = document.createElement('div');
      error.className = 'chat-params-error';
      error.dataset.ref = 'params-error';
      error.setAttribute('role', 'alert');
      error.textContent = this.error;
      this.foot.append(error);
    }

    const actions = document.createElement('div');
    actions.className = 'chat-params-actions';
    const status = document.createElement('span');
    status.className = 'chat-params-status';
    status.dataset.ref = 'params-status';
    status.textContent = this.statusText(availability, defs, changed.length, model);
    actions.append(status);
    if (host && availability === 'live' && defs.some((def) => def !== null)) {
      const buttons = document.createElement('div');
      buttons.className = 'chat-params-buttons';
      const idle = this.busy === null && changed.length > 0;
      const reset = actionButton('params-reset', 'Reset', 'btn-ghost chat-approval-secondary');
      reset.title = 'Back to the values in the file';
      reset.disabled = !idle;
      reset.addEventListener('click', () => this.reset());
      buttons.append(reset);
      if (host.keep) {
        const keep = actionButton('params-keep', 'Keep', 'btn-primary');
        const row = model!.configuration !== DEFAULT_CONFIGURATION ? model!.configuration : null;
        keep.title = row ? `Write these values into the configuration ${row}` : 'Write these values into the file, as the parameters\' defaults';
        keep.disabled = !idle;
        spin(keep, this.busy === 'keep', 'Keep');
        keep.addEventListener('click', () => void this.keep());
        buttons.append(keep);
      }
      actions.append(buttons);
    }
    this.foot.append(actions);
  }

  private statusText(availability: Availability, defs: (ParamCardDefinition | null)[], changed: number, model: ParamCardModel | null): string {
    if (availability === 'no-model') {
      return 'The controls need the model on screen.';
    }
    if (availability === 'other-file') {
      return `Open ${this.part.file} to use these controls.`;
    }
    if (defs.every((def) => def === null)) {
      return 'The model no longer declares these parameters.';
    }
    if (changed === 0) {
      return 'The values are the file\'s.';
    }
    const row = model!.configuration !== DEFAULT_CONFIGURATION ? ` from ${model!.configuration}` : '';
    return `${changed} ${changed === 1 ? 'value' : 'values'} changed${row}, on screen only.`;
  }

  private reset(): void {
    const host = this.ctx.params;
    const changed = this.changed(host?.model() ?? null);
    if (!host || this.busy !== null || changed.length === 0) {
      return;
    }
    this.error = null;
    host.reset(changed.map((def) => ({ label: def.label, ...(def.body !== undefined ? { body: def.body } : {}) })));
  }

  /**
   * Writes each changed value where the configuration on screen keeps it,
   * one after the other (each write is an edit of the file and its own undo
   * step), then tells the session what was written. A value the file
   * refused stays on screen as it was, and the card says why.
   */
  private async keep(): Promise<void> {
    const host = this.ctx.params;
    const model = host?.model() ?? null;
    const changed = this.changed(model);
    if (!host?.keep || !model || this.busy !== null || changed.length === 0) {
      return;
    }
    this.busy = 'keep';
    this.error = null;
    this.paintFoot();
    const kept: ParamKeptValue[] = [];
    const refused: string[] = [];
    for (const def of changed) {
      let result: { success: boolean; reason?: string };
      try {
        result = await host.keep(def.label, def.currentValue, def.body, model.configuration);
      } catch {
        result = { success: false, reason: 'FluidCAD did not answer' };
      }
      if (result.success) {
        kept.push({
          label: def.label,
          ...(def.body !== undefined ? { part: def.body } : {}),
          value: def.currentValue,
          ...(model.configuration !== DEFAULT_CONFIGURATION ? { configuration: model.configuration } : {}),
        });
      } else {
        refused.push(`${def.label} (${result.reason ?? 'the edit was refused'})`);
        // A refused write may already have dropped the session value: the model stays as the user set it.
        host.set(def.label, def.currentValue, def.body);
      }
    }
    if (kept.length > 0) {
      await this.ctx.paramsKept?.(this.part.id, kept);
    }
    this.busy = null;
    this.error = refused.length > 0 ? `Not written: ${refused.join('; ')}.` : null;
    this.paintFoot();
  }
}

/**
 * A definition as the panel's row markup may take it. The row escapes the
 * texts; the numbers it writes into attributes as they are, so anything
 * that is not a finite number is left out, and a number control's value is
 * made one.
 */
function checked(def: ParamCardDefinition): ParamCardDefinition {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const control = effectiveControlType(def);
  const numeric = control === 'slider' || control === 'number';
  const value = numeric ? Number(def.currentValue) : def.currentValue;
  return {
    ...def,
    min: number(def.min),
    max: number(def.max),
    step: number(def.step),
    currentValue: numeric ? (Number.isFinite(value as number) ? value : 0) : def.currentValue,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A file as a render names it, compared whatever its separators and the live-render prefix. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^virtual:live-render:/, '').replace(/\\/g, '/');
  return norm(a) === norm(b);
}

function valueText(value: ParamCardValue): string {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
}

function keptText(kept: ParamKeptValue): string {
  return `${kept.label} ${valueText(kept.value)}${kept.configuration ? ` (${kept.configuration})` : ''}`;
}

function actionButton(ref: string, label: string, variant: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.ref = ref;
  button.className = `btn btn-xs ${variant}`;
  button.textContent = label;
  return button;
}

/** The button's label, behind a spinner while its writes are on the way. */
function spin(button: HTMLButtonElement, on: boolean, label: string): void {
  button.replaceChildren();
  if (on) {
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    button.append(spinner);
  }
  button.append(text(label));
}

function text(value: string): Text {
  return document.createTextNode(value);
}
