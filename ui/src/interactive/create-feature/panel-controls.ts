import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { viewportChrome } from '../../ui/viewport-chrome';
import { ExpressionField, collectNewVariables } from '../../ui/expression-field';
import { VariableInfo } from '../../ui/expression-core';
import { NewVariable, ValueExpr } from '../../api';

export type FeatureOp = 'add' | 'remove' | 'new';

const TAB_BASE = 'btn btn-sm join-item flex-1 font-normal';
const TAB_ACTIVE = 'btn btn-sm join-item flex-1 btn-soft btn-primary';

/**
 * A mutually-exclusive tab row shared by the create-feature dialogs.
 * Renders into `host` (a `join` row).
 */
export class ChoiceTabs<T extends string> {
  onChange?: () => void;

  private tabs = new Map<T, HTMLButtonElement>();
  private current: T;
  private readonly initial: T;

  constructor(host: HTMLElement, choices: { key: T; label: string; title: string; disabled?: boolean }[], initial: T) {
    this.initial = initial;
    this.current = initial;
    for (const { key, label, title, disabled } of choices) {
      const tab = document.createElement('button');
      tab.className = key === this.current ? TAB_ACTIVE : TAB_BASE;
      tab.textContent = label;
      tab.title = title;
      if (disabled) {
        // Visually muted but not `disabled`/pointer-events:none — the title
        // tooltip must still show on hover.
        tab.classList.add('opacity-40', 'cursor-not-allowed');
      } else {
        tab.addEventListener('click', () => this.set(key));
      }
      host.appendChild(tab);
      this.tabs.set(key, tab);
    }
  }

  get value(): T {
    return this.current;
  }

  /** Programmatic tab choice (edit-mode prefill); no change event fires. */
  setValue(key: T): void {
    this.current = key;
    for (const [kind, tab] of this.tabs) {
      tab.className = kind === key ? TAB_ACTIVE : TAB_BASE;
    }
  }

  /** Back to the construction-time tab (fresh-arming defaults); no change event fires. */
  reset(): void {
    this.setValue(this.initial);
  }

  private set(key: T): void {
    if (this.current === key) {
      return;
    }
    this.setValue(key);
    this.onChange?.();
  }
}

/** The boolean-operation tab row (Add / Remove / New). */
export class OpTabs extends ChoiceTabs<FeatureOp> {
  constructor(host: HTMLElement, ops: { op: FeatureOp; label: string; title: string }[]) {
    super(host, ops.map(({ op, label, title }) => ({ key: op, label, title })), 'add');
  }

  get op(): FeatureOp {
    return this.value;
  }

  /** Programmatic tab choice (edit-mode prefill); no change event fires. */
  setOp(op: FeatureOp): void {
    this.setValue(op);
  }
}

/**
 * The "Thin walls" toggle with its thickness field, shared by the
 * create-feature dialogs. Appends its own rows into `container`.
 */
export class ThinControl {
  onChange?: () => void;
  /** Enter pressed inside the thickness field — the dialogs apply. */
  onSubmit?: () => void;

  private checkbox: HTMLInputElement;
  private toggle: HTMLElement;
  private valuesRow: HTMLElement;
  private input: HTMLInputElement;
  private input2: HTMLInputElement;
  private field: ExpressionField;
  private field2: ExpressionField;

  constructor(container: HTMLElement) {
    const toggle = document.createElement('label');
    toggle.className = 'flex items-center justify-between cursor-pointer';
    toggle.innerHTML = `
      <span class="text-base-content/70">Thin walls</span>
      <input data-role="thin" type="checkbox" class="toggle toggle-sm toggle-primary" />
    `;
    container.appendChild(toggle);
    this.toggle = toggle;

    this.valuesRow = document.createElement('div');
    this.valuesRow.className = 'hidden gap-2';
    this.valuesRow.innerHTML = `
      <label class="flex flex-col gap-1.5 flex-1 min-w-0"
        title="Wall thickness — the sign picks which side of the profile the wall grows">
        <span class="text-base-content/70">Thickness</span>
        <input data-role="thin-value" data-unit="length" type="number" step="0.5" value="2"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
      <label class="flex flex-col gap-1.5 flex-1 min-w-0"
        title="Wall thickness on the opposite side of the profile — leave empty for a single-sided wall">
        <span class="text-base-content/70">Thickness 2</span>
        <input data-role="thin-value2" data-unit="length" type="number" step="0.5" placeholder="off"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
    `;
    container.appendChild(this.valuesRow);

    this.checkbox = toggle.querySelector('[data-role="thin"]')!;
    this.input = this.valuesRow.querySelector('[data-role="thin-value"]')!;
    this.input2 = this.valuesRow.querySelector('[data-role="thin-value2"]')!;

    this.checkbox.addEventListener('change', () => {
      this.sync();
      this.onChange?.();
    });
    // The fields own their inputs' keyboard handling (dropdown navigation,
    // Enter-to-submit) and flip the inputs to type="text" for identifiers.
    this.field = new ExpressionField(this.input);
    this.field.onSubmit = () => this.onSubmit?.();
    this.input.addEventListener('input', () => this.onChange?.());
    this.field2 = new ExpressionField(this.input2);
    this.field2.onSubmit = () => this.onSubmit?.();
    this.input2.addEventListener('input', () => this.onChange?.());
  }

  /** The variables the thickness fields' dropdowns offer. */
  setVariables(variables: VariableInfo[]): void {
    this.field.setVariables(variables);
    this.field2.setVariables(variables);
  }

  /**
   * Block the toggle while the feature's current inputs exclude thin mode
   * (loft guides). Blocking unchecks — a checked-but-ignored toggle would
   * lie about the statement being written.
   */
  setBlocked(blocked: boolean, reason: string): void {
    this.checkbox.disabled = blocked;
    this.toggle.title = blocked ? reason : '';
    this.toggle.classList.toggle('opacity-50', blocked);
    this.toggle.classList.toggle('cursor-not-allowed', blocked);
    this.toggle.classList.toggle('cursor-pointer', !blocked);
    if (blocked && this.checkbox.checked) {
      this.checkbox.checked = false;
      this.sync();
    }
  }

  /**
   * Programmatic offsets (edit-mode prefill); no change event fires. A null
   * turns the toggle off and reseeds the fields' defaults — a statement
   * without thin() must not show a stale thickness once re-enabled.
   */
  setValues(thin: [ValueExpr] | [ValueExpr, ValueExpr] | null): void {
    this.checkbox.checked = thin !== null;
    this.field.setValue(thin !== null ? thin[0] : 2);
    this.field2.setValue(thin?.[1] ?? '');
    this.sync();
  }

  /** Back to the defaults: toggle off, thickness 2, single-sided. */
  reset(): void {
    this.setValues(null);
  }

  /** The `.thin()` offsets, null when off, or the message for a bad value. */
  values(): {
    thin: [ValueExpr] | [ValueExpr, ValueExpr] | null;
    newVariables?: NewVariable[];
  } | { error: string } {
    if (!this.checkbox.checked) {
      return { thin: null };
    }
    const read = this.field.read();
    if ('error' in read) {
      return { error: read.error === 'empty' ? 'Enter a wall thickness.' : read.error };
    }
    if (typeof read.value === 'number' && read.value === 0) {
      return { error: 'Wall thickness cannot be zero.' };
    }
    // The second offset is optional — empty means a single-sided wall.
    const read2 = this.field2.read();
    if ('error' in read2) {
      if (read2.error !== 'empty') {
        return { error: read2.error };
      }
      return { thin: [read.value], newVariables: collectNewVariables([read]) };
    }
    if (typeof read2.value === 'number' && read2.value === 0) {
      return { error: 'Thickness 2 cannot be zero.' };
    }
    return {
      thin: [read.value, read2.value],
      newVariables: collectNewVariables([read, read2]),
    };
  }

  private sync(): void {
    const on = this.checkbox.checked;
    this.valuesRow.classList.toggle('hidden', !on);
    this.valuesRow.classList.toggle('flex', on);
  }
}

/**
 * The docked-dialog positioning every create/edit/modify dialog shares. From
 * `sm:` up the dialog floats at top-[196px] right-4 — just below the viewport
 * gizmo (~y 102–182), in the spot the settings/fit-to-view/params stack
 * (right-7) vacates while a dialog is open (see viewportChrome). Below `sm:`
 * it becomes a full-width bottom sheet. daisyUI's modal-bottom and drawer are
 * both modal overlays, and these dialogs must leave the viewport pickable
 * while open, so the sheet is plain positioning over the same daisyUI tokens.
 */
export const DIALOG_DOCK_CLASS =
  'absolute z-[999] pointer-events-auto inset-x-0 bottom-0 sm:inset-x-auto sm:bottom-auto sm:top-[196px] sm:right-4 '
  + 'max-sm:animate-[dialog-slide-up_0.25s_ease-out] motion-reduce:animate-none';

/**
 * The dock's inner stack: the body plus the rows docked around it (statement
 * preview, error message, expression row). Reversed on the sheet so those
 * rows stack above the body instead of running off the bottom edge.
 */
export const DIALOG_COLUMN_CLASS =
  'flex flex-col-reverse items-stretch gap-1.5 sm:flex-col sm:items-end';

/**
 * The dialog box: the chrome (surface, border, radius, shadow) and the height
 * cap, split into three rows — a pinned header, the scrolling body and a
 * pinned footer — so the title and the Apply / Exit actions stay put while a
 * long dialog scrolls. The box itself never scrolls; only the body does. The
 * sheet spans the full width and caps at half the screen; the float keeps the
 * fixed w-60 column capped just above the screen bottom. Wears `group` so the
 * header and footer can read the scroll cues {@link PanelShell.watchScroll}
 * stamps on it.
 */
export const DIALOG_BOX_CLASS =
  'group flex flex-col items-stretch overflow-hidden bg-base-100 text-base-content text-xs select-none shadow-md '
  + 'border-t border-base-300 rounded-t-xl max-h-[50dvh] '
  + 'sm:w-60 sm:border sm:rounded-lg sm:max-h-[calc(100vh-260px)]';

/**
 * The pinned title row. A hairline appears along its bottom edge once the
 * body has scrolled under it — drawn as a shadow so nothing shifts.
 */
export const DIALOG_HEADER_CLASS =
  'flex items-center gap-2.5 shrink-0 px-4 pt-4 pb-3.5 transition-shadow duration-150 '
  + 'group-data-scrolled:shadow-[0_1px_0_0_color-mix(in_oklab,var(--color-base-content)_18%,transparent)]';

/**
 * The scrolling body the panels append their controls to. `min-h-0` lets it
 * shrink under the box cap; `overscroll-contain` keeps a scroll at either end
 * from chaining to the page.
 */
export const DIALOG_BODY_CLASS =
  'flex flex-col items-stretch gap-3.5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4';

/**
 * The pinned action row: a raised band under the body (second neutral, top
 * border), with a soft shade along its top edge while more body is hidden
 * beneath it. The bottom padding rides above a phone's home indicator.
 */
export const DIALOG_FOOTER_CLASS =
  'flex items-center gap-2 shrink-0 border-t border-base-300 bg-base-200 px-4 py-3 '
  + 'pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3 transition-shadow duration-150 '
  + 'group-data-overflow:shadow-[0_-6px_8px_-6px_rgba(0,0,0,0.35)]';

/**
 * The floating dialog chrome the create-feature panels share: the docked
 * container, the box with its pinned title row and pinned footer, and the
 * statement-preview and error rows below the box. Panels append their
 * controls to `body` and their actions to `footer`.
 */
export class PanelShell {
  /** The scrolling body between the title and the footer; panels append their controls here. */
  readonly body: HTMLDivElement;
  /** The pinned action row under the body; panels put their Apply / Exit buttons here. */
  readonly footer: HTMLDivElement;
  /**
   * The right-aligned stack holding the box, the preview and the message —
   * panels dock extra full-width rows here (the expression-transparency row).
   */
  readonly column: HTMLDivElement;

  private root: HTMLDivElement;
  private box: HTMLDivElement;
  private preview: HTMLDivElement;
  private message: HTMLDivElement;
  private titleText: HTMLSpanElement;
  private readonly defaultTitle: string;

  constructor(container: HTMLElement, id: string, title: string, iconSrc: string) {
    this.defaultTitle = title;
    this.root = document.createElement('div');
    this.root.id = id;
    this.root.className = `${DIALOG_DOCK_CLASS} hidden`;
    this.root.innerHTML = `
      <div data-role="column" class="${DIALOG_COLUMN_CLASS}">
        ${PanelShell.frameHtml({
          header: `<img src="${iconSrc}" ${ICON_IMG_FALLBACK} class="w-4 h-4 object-contain" alt="" />
            <span data-role="title" class="font-medium text-sm">${title}</span>`,
        })}
        <div data-role="preview" class="hidden max-sm:hidden sm:max-w-[380px] bg-base-100 border border-base-300 rounded-lg px-3 py-1.5 font-mono text-[11px] text-base-content shadow-md"></div>
        <div data-role="message" class="hidden sm:max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md"></div>
      </div>
    `;
    container.appendChild(this.root);
    this.column = this.root.querySelector('[data-role="column"]')!;
    this.box = this.root.querySelector('[data-role="box"]')!;
    this.body = this.root.querySelector('[data-role="body"]')!;
    this.footer = this.root.querySelector('[data-role="footer"]')!;
    PanelShell.watchScroll(this.box);
    this.preview = this.root.querySelector('[data-role="preview"]')!;
    this.message = this.root.querySelector('[data-role="message"]')!;
    this.titleText = this.root.querySelector('[data-role="title"]')!;

    // Escape closes the dialog only from inside it — in sketch mode the
    // drawing tools own the global Escape.
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.onEscape?.();
      }
    });
  }

  onEscape?: () => void;

  /**
   * The dialog box markup — header, body, footer — for panels that build
   * their chrome from an HTML string instead of through a PanelShell. The
   * roles (`box`, `header`, `body`, `footer`) are how they find the rows
   * afterwards; pair it with {@link watchScroll} on the `box` element.
   */
  static frameHtml(parts: { header: string; body?: string; footer?: string }): string {
    return `
        <div data-role="box" class="${DIALOG_BOX_CLASS}">
          <div data-role="header" class="${DIALOG_HEADER_CLASS}">${parts.header}</div>
          <div data-role="body" class="${DIALOG_BODY_CLASS}">${parts.body ?? ''}</div>
          <div data-role="footer" class="${DIALOG_FOOTER_CLASS}">${parts.footer ?? ''}</div>
        </div>`;
  }

  /**
   * Keep the box's scroll cues current: `data-scrolled` while the body has
   * scrolled under the header, `data-overflow` while more body hides under
   * the footer. Re-measured on scroll, on the body resizing (the float grows
   * with its rows until the cap bites) and on rows appearing, hiding or
   * being swapped — a capped body's scroll height moves without its box
   * changing size, which a resize observer alone would miss.
   */
  static watchScroll(box: HTMLElement): void {
    const body = box.querySelector<HTMLElement>(':scope > [data-role="body"]');
    if (!body) {
      return;
    }
    const sync = (): void => {
      const scrolled = body.scrollTop > 0;
      const overflow = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
      box.toggleAttribute('data-scrolled', scrolled);
      box.toggleAttribute('data-overflow', overflow);
    };
    body.addEventListener('scroll', sync, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(sync).observe(body);
    }
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(sync).observe(body, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'],
      });
    }
    sync();
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** Retitle the dialog ("Edit extrude"); null restores the create title. */
  setTitle(title: string | null): void {
    this.titleText.textContent = title ?? this.defaultTitle;
  }

  show(): void {
    this.setMessage(null);
    this.setPreview(null);
    this.root.classList.remove('hidden');
    viewportChrome.setDialogOpen(this.root.id, true);
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.setMessage(null);
    this.setPreview(null);
    viewportChrome.setDialogOpen(this.root.id, false);
  }

  /** Remove the dialog from the DOM (for panels owned by short-lived tools). */
  destroy(): void {
    viewportChrome.setDialogOpen(this.root.id, false);
    this.root.remove();
  }

  setPreview(text: string | null): void {
    if (text) {
      this.preview.textContent = text;
      this.preview.classList.remove('hidden');
    } else {
      this.preview.textContent = '';
      this.preview.classList.add('hidden');
    }
  }

  setMessage(text: string | null): void {
    if (text) {
      this.message.textContent = text;
      this.message.classList.remove('hidden');
    } else {
      this.message.textContent = '';
      this.message.classList.add('hidden');
    }
  }
}
