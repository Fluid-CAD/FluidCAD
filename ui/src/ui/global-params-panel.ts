import type { GlobalParam, GlobalParamsFile, GlobalParamsSnapshot } from '../types';
import type { ParamEditResponse } from '../api';
import { AccordionSection } from './accordion-section';
import { ICON_ALERT_TRIANGLE, ICON_CODE, ICON_PENCIL } from './icons';
import { GLOBAL_PANEL_CLASS, GLOBAL_PANEL_WIDTH, GLOBAL_PANEL_WIDTH_VARIABLE } from './rail-styles';
import {
  ParamDebouncer,
  bindParamGroups,
  bindParamHandlers,
  controlSignature,
  escapeHtml,
  renderParamControl,
  renderParamGroup,
  updateParamValuesInPlace,
  type ParamRowDefinition,
} from './param-row';

/** The file a workspace with no params file yet gets from the +. */
export const DEFAULT_PARAMS_FILE = 'project.params.js';

const PANEL_TITLE = 'Global Parameters';
const PANEL_SUBTITLE = 'Parameters you define here are available from any part or assembly';

const PLUS_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
    <path d="M10 4.25a.75.75 0 01.75.75v4.25H15a.75.75 0 010 1.5h-4.25V15a.75.75 0 01-1.5 0v-4.25H5a.75.75 0 010-1.5h4.25V5a.75.75 0 01.75-.75z" />
  </svg>`;

const HEADER_BTN = 'btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-base-content/70';

/**
 * The identifier beside a row's label: the token to type in an expression,
 * set in code so it reads as code. Capped so a long name truncates before
 * it crowds the label out.
 */
const CHIP_CLASS =
  'shrink-0 max-w-[45%] truncate px-1 py-px rounded bg-base-content/10 text-[11px] leading-4 font-mono text-base-content/70';

export interface GlobalParamsPanelHandlers {
  /** `GET api/global-params` — run on the column's first open. */
  fetch: () => Promise<GlobalParamsSnapshot | null>;
  /** `POST api/global-params/set`: a control's new value for the declaration `label` names in `file`. */
  setValue: (file: string, label: string, value: unknown) => Promise<ParamEditResponse>;
  /** Activate the editor tab for `file` at the line — the header's Open file, a derived row's pencil. */
  openFile: (file: string, line: number, column: number) => void;
  /** The header +: a new declaration in `file`, or — null — in a params file that does not exist yet. */
  onAdd: (file: string | null) => void;
  /** A row's pencil. */
  onEdit: (param: GlobalParam) => void;
  /** A refused value write — the server's reason. */
  onError?: (message: string) => void;
  /** After every open/close — the rail's latch re-reads {@link isOpen}. */
  onOpenChange?: () => void;
}

/**
 * The project Parameters column: every `*.params.js` file's exports, one
 * collapsible section per file, docked beside the panel rail. Toggled from
 * the rail's Parameters button, and the same column in both workbenches —
 * the part/assembly swap that rebuilds the feature tree never touches it,
 * since a project parameter belongs to no one model.
 *
 * While open it publishes its width ({@link GLOBAL_PANEL_WIDTH_VARIABLE}),
 * which styles.css folds into `--fluidcad-panel-left` — that is what moves
 * the scene and the feature tree or parts column over to make room.
 *
 * A value edit here is a source edit: the declaration's literal IS the value
 * (there is no session override for a global), so the controls post to the
 * server and the column redraws off the `global-params` push that follows.
 * Controls update in place when nothing but values changed, so a slider's
 * thumb never jumps out from under the pointer.
 */
export class GlobalParamsPanel {
  private readonly el: HTMLDivElement;
  private readonly column: HTMLDivElement;
  private snapshot: GlobalParamsSnapshot | null = null;
  private open = false;
  private fetched = false;
  private readonly debouncer = new ParamDebouncer();
  /** Files whose section the user folded. */
  private readonly collapsedFiles = new Set<string>();
  /** `file\ngroup` of every group card the user folded. */
  private readonly collapsedGroups = new Set<string>();
  /** The sections on screen, by file — what an in-place update writes into. */
  private readonly lists = new Map<string, HTMLDivElement>();
  /** The file sections on screen, by file — what {@link showFile} unfolds. */
  private readonly sections = new Map<string, AccordionSection>();
  /** The file {@link showFile} asked for, until a render puts its section on screen. */
  private revealFile: string | null = null;
  /** What the last full render drew, structurally; the same again means values only. */
  private renderedSignature: string | null = null;

  constructor(container: HTMLElement, private readonly handlers: GlobalParamsPanelHandlers) {
    this.el = document.createElement('div');
    this.el.className = GLOBAL_PANEL_CLASS;
    this.el.dataset.globalParams = '';
    container.appendChild(this.el);

    // The column's title and what it is for, flush with its edges like the
    // pane it docks beside; the file sections scroll under it.
    const header = document.createElement('div');
    header.className = 'shrink-0 px-3 py-2 border-b border-base-content/10';
    header.innerHTML = `
      <div class="text-sm font-semibold text-base-content" data-global-params-title>${PANEL_TITLE}</div>
      <div class="mt-0.5 text-xs leading-snug text-base-content/60" data-global-params-subtitle>${PANEL_SUBTITLE}</div>`;
    this.el.appendChild(header);

    this.column = document.createElement('div');
    this.column.className = 'flex-1 min-h-0 flex flex-col gap-1 p-1 overflow-y-auto';
    this.el.appendChild(this.column);

    this.render();
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /**
   * Open the column on one params file — what opening that file from a tab
   * or quick-open means, since its declarations are edited here rather than
   * as code. Its section unfolds and scrolls into view; before the first
   * fetch answers, as soon as the catalog lists it.
   */
  showFile(file: string): void {
    this.revealFile = file;
    this.setOpen(true);
    this.applyReveal();
  }

  private applyReveal(): void {
    const section = this.revealFile === null ? undefined : this.sections.get(this.revealFile);
    if (!section) {
      return;
    }
    this.revealFile = null;
    // Unfolding through the section keeps collapsedFiles in step (onToggle).
    section.setExpanded(true);
    section.header.scrollIntoView?.({ block: 'nearest' });
  }

  setOpen(open: boolean): void {
    if (this.open === open) {
      return;
    }
    this.open = open;
    this.el.classList.toggle('hidden', !open);
    const root = document.documentElement;
    if (open) {
      root.style.setProperty(GLOBAL_PANEL_WIDTH_VARIABLE, `${GLOBAL_PANEL_WIDTH}px`);
      if (!this.fetched) {
        this.fetched = true;
        void this.handlers.fetch().then((snapshot) => {
          // A push that landed while the fetch was out is newer than it.
          if (snapshot && this.snapshot === null) {
            this.update(snapshot);
          }
        });
      }
    } else {
      root.style.removeProperty(GLOBAL_PANEL_WIDTH_VARIABLE);
      this.revealFile = null;
    }
    this.handlers.onOpenChange?.();
  }

  /**
   * A fresh catalog — the first fetch or a `global-params` push. Redrawn
   * in place when every row's control is the same as the one on screen
   * (a value write, a render), from scratch when a declaration came, went
   * or changed shape.
   */
  update(snapshot: GlobalParamsSnapshot): void {
    this.snapshot = snapshot;
    if (this.renderedSignature === GlobalParamsPanel.signatureOf(snapshot)) {
      this.updateInPlace(snapshot);
    } else {
      this.render();
    }
  }

  /** Everything that decides a row's markup — not its value. */
  private static signatureOf(snapshot: GlobalParamsSnapshot): string {
    return JSON.stringify(snapshot.files.map((file) => [
      file.file,
      file.problems,
      file.params.map((p) => p.derived
        ? ['derived', p.name, p.expression ?? null, p.problems ?? null]
        : [controlSignature(GlobalParamsPanel.rowOf(p)), p.name, p.problems ?? null]),
    ]));
  }

  /** The control's view of a declaration: the literal is the value. */
  private static rowOf(p: GlobalParam): ParamRowDefinition {
    return {
      label: p.label,
      defaultValue: p.defaultValue,
      currentValue: p.value ?? p.defaultValue,
      controlType: p.controlType,
      description: p.description,
      group: p.group,
      min: p.min,
      max: p.max,
      step: p.step,
      options: p.options,
      multi: p.multi,
      multiControlType: p.multiControlType,
    };
  }

  private updateInPlace(snapshot: GlobalParamsSnapshot): void {
    for (const file of snapshot.files) {
      const list = this.lists.get(file.file);
      if (!list) {
        continue;
      }
      updateParamValuesInPlace(list, file.params.filter((p) => !p.derived).map(GlobalParamsPanel.rowOf));
      for (const p of file.params) {
        if (!p.derived) {
          continue;
        }
        const el = list.querySelector<HTMLElement>(`[data-derived-value="${CSS.escape(p.name)}"]`);
        if (el) {
          el.textContent = GlobalParamsPanel.valueText(p.value);
        }
      }
    }
  }

  private render(): void {
    this.column.replaceChildren();
    this.lists.clear();
    this.sections.clear();
    const snapshot = this.snapshot;
    this.renderedSignature = snapshot ? GlobalParamsPanel.signatureOf(snapshot) : null;

    if (!snapshot || snapshot.files.length === 0) {
      this.renderEmpty(snapshot === null);
      return;
    }
    for (const file of snapshot.files) {
      this.renderFile(file);
    }
    this.applyReveal();
  }

  /**
   * Nothing to list — before the first fetch answers, or in a workspace
   * with no params file. The + is still there: it creates the file.
   */
  private renderEmpty(loading: boolean): void {
    const section = new AccordionSection(PANEL_TITLE, {
      sheet: true,
      trailing: `
        <span class="ml-auto flex items-center">
          <button class="${HEADER_BTN}" title="Add a project parameter" data-add-global>${PLUS_ICON}</button>
        </span>`,
    });
    section.body.innerHTML = AccordionSection.emptyState(loading
      ? 'Loading…'
      : `No project parameters yet. <b>+</b> creates <code>${DEFAULT_PARAMS_FILE}</code>.`);
    section.header.querySelector('[data-add-global]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onAdd(null);
    });
    section.mount(this.column);
  }

  private renderFile(file: GlobalParamsFile): void {
    const name = file.relPath.split('/').pop() ?? file.relPath;
    const section = new AccordionSection(name, {
      sheet: true,
      expanded: !this.collapsedFiles.has(file.file),
      trailing: `
        <span class="ml-auto flex items-center">
          <button class="${HEADER_BTN}" title="Add a parameter to ${escapeHtml(file.relPath)}" data-add-global>${PLUS_ICON}</button>
          <button class="${HEADER_BTN} [&>svg]:size-3.5" title="Open ${escapeHtml(file.relPath)}" data-open-file>${ICON_CODE}</button>
        </span>`,
    });
    section.header.title = file.relPath;
    section.onToggle = () => {
      if (section.isExpanded) {
        this.collapsedFiles.delete(file.file);
      } else {
        this.collapsedFiles.add(file.file);
      }
    };
    section.header.querySelector('[data-add-global]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onAdd(file.file);
    });
    section.header.querySelector('[data-open-file]')!.addEventListener('click', (e) => {
      e.stopPropagation();
      const first = file.params[0];
      this.handlers.openFile(file.file, first?.line ?? 1, first?.column ?? 0);
    });

    const list = document.createElement('div');
    list.dataset.paramsFile = file.file;
    section.body.appendChild(list);
    this.lists.set(file.file, list);
    this.sections.set(file.file, section);

    let html = '';
    if (file.problems.length > 0) {
      html += `
        <div class="px-3 py-1.5 flex items-start gap-1.5 text-xs text-warning" data-file-problems>
          <span class="shrink-0 mt-0.5 [&>svg]:w-3 [&>svg]:h-3">${ICON_ALERT_TRIANGLE}</span>
          <span class="leading-snug">${escapeHtml(file.problems.join('\n')).replace(/\n/g, '<br>')}</span>
        </div>`;
    }
    if (file.params.length === 0) {
      html += AccordionSection.emptyState('No parameters in this file yet. Use + above to add one.');
    }

    const ungrouped: GlobalParam[] = [];
    const groups = new Map<string, GlobalParam[]>();
    for (const p of file.params) {
      if (p.group) {
        if (!groups.has(p.group)) {
          groups.set(p.group, []);
        }
        groups.get(p.group)!.push(p);
      } else {
        ungrouped.push(p);
      }
    }
    for (const p of ungrouped) {
      html += this.renderRow(p);
    }
    for (const [groupName, groupParams] of groups) {
      let rows = '';
      for (const p of groupParams) {
        rows += this.renderRow(p);
      }
      html += renderParamGroup(groupName, rows, this.collapsedGroups.has(`${file.file}\n${groupName}`));
    }
    list.innerHTML = html;

    const find = (label: string) => file.params.find((p) => p.label === label && !p.derived);
    bindParamHandlers(list, {
      lookup: (label) => {
        const p = find(label);
        return p ? GlobalParamsPanel.rowOf(p) : undefined;
      },
      setValue: (label, value) => {
        void this.handlers.setValue(file.file, label, value).then((result) => {
          if (!result.success) {
            this.handlers.onError?.(result.reason ?? 'The value could not be written.');
          }
        });
      },
      onEdit: (label) => {
        const p = find(label);
        if (p) {
          this.handlers.onEdit(p);
        }
      },
      debouncer: this.debouncer,
      debounceKey: (label) => `${file.file}\n${label}`,
      // Every value is a source edit and an undo step: a field sends on
      // Enter or blur, never a half-typed number.
      sendOn: 'commit',
    });
    list.querySelectorAll<HTMLElement>('[data-derived-open]').forEach((el) => {
      el.addEventListener('click', () => {
        const p = file.params.find((candidate) => candidate.derived && candidate.name === el.dataset.derivedOpen);
        if (p) {
          this.handlers.openFile(file.file, p.line, p.column);
        }
      });
    });
    bindParamGroups(list, this.collapsedGroups, (group) => `${file.file}\n${group}`);

    section.mount(this.column);
  }

  private renderRow(p: GlobalParam): string {
    const chip = `<code class="${CHIP_CLASS}" data-param-name="${escapeHtml(p.name)}" title="Type ${escapeHtml(p.name)} in an expression to read it">${escapeHtml(p.name)}</code>`;
    const warning = GlobalParamsPanel.warningMark(p.problems);
    if (p.derived) {
      return this.renderDerivedRow(p, chip, warning);
    }
    return renderParamControl(GlobalParamsPanel.rowOf(p), { editable: true, labelTrailing: `${warning}${chip}` });
  }

  /**
   * A plain `export const` — read-only here: its value is an expression,
   * which the pencil opens in the file rather than a control to drag.
   */
  private renderDerivedRow(p: GlobalParam, chip: string, warning: string): string {
    const expression = p.expression ?? '';
    const value = GlobalParamsPanel.valueText(p.value);
    return `
      <div class="px-3 py-1.5 group" data-derived-row="${escapeHtml(p.name)}">
        <div class="flex items-center gap-1">
          ${chip.replace(CHIP_CLASS, `${CHIP_CLASS} !max-w-full`)}
          <span class="flex-1"></span>
          ${warning}
          <span class="text-sm text-base-content/80 tabular-nums font-mono truncate max-w-[45%]" data-derived-value="${escapeHtml(p.name)}" title="Computed from the expression below">${escapeHtml(value)}</span>
          <button class="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-0 group-hover:opacity-100 focus:opacity-100 text-base-content/40 hover:text-base-content/70"
            data-derived-open="${escapeHtml(p.name)}" title="Open in the code editor">
            <span class="[&>svg]:size-3">${ICON_PENCIL}</span>
          </button>
        </div>
        <div class="mt-0.5 text-xs font-mono text-base-content/55 truncate" title="${escapeHtml(expression)}">= ${escapeHtml(expression)}</div>
      </div>
    `;
  }

  /** The timeline's warning triangle, carrying the row's lint findings. */
  private static warningMark(problems: string[] | undefined): string {
    if (!problems || problems.length === 0) {
      return '';
    }
    const text = escapeHtml(problems.join('\n'));
    return `<span class="text-warning shrink-0 [&>svg]:w-3 [&>svg]:h-3" data-warning="${text}" title="${text}">${ICON_ALERT_TRIANGLE}</span>`;
  }

  /** A computed value as a derived row prints it. */
  private static valueText(value: GlobalParam['value']): string {
    if (value === null || value === undefined) {
      return 'computed at render';
    }
    if (Array.isArray(value)) {
      return `[${value.join(', ')}]`;
    }
    if (typeof value === 'number') {
      return String(Number.isInteger(value) ? value : Number(value.toFixed(4)));
    }
    return String(value);
  }
}
