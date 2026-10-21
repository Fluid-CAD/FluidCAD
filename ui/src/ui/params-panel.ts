import type { SourceLocation, UIConfigurations, UIParamDefinition, UIPropertyDefinition } from '../types';
import type { ParamEditorDialog, PartChoices } from './param-editor-dialog';
import type { PropertyEditorDialog } from './property-editor-dialog';
import type { EngineClient } from '../engine-client';
import { ActivePartTracker, type PartChoice } from '../interactive/active-part-tracker';
import {
  ICON_ADJUSTMENTS,
  ICON_CODE,
  ICON_COPY,
  ICON_DOTS_VERTICAL,
  ICON_GRID,
  ICON_PENCIL,
  ICON_PLUS,
  ICON_TRASH,
} from './icons';
import { showPopupMenu, type PopupMenuItem } from './popup-menu';
import {
  confirmConfigurationDelete,
  promptConfigurationName,
  type ConfigurationNamePrompt,
} from './configuration-dialogs';
import { ParamWriteQueue } from './param-write-queue';
import { openConfigurationsGrid, type ConfigurationsGridOptions } from './configurations-grid-dialog';
import { AccordionSection } from './accordion-section';
import {
  ParamDebouncer,
  bindParamGroups,
  bindParamHandlers,
  controlSignature,
  escapeHtml,
  paramRowKey,
  renderParamControl,
  renderParamGroup,
  updateParamValuesInPlace,
} from './param-row';

// This section is the one whose rows are controls rather than names, so it
// is the one that takes a sheet body (`sheet: true` below): a field has to
// read as something you can type into, and an outline with the scene showing
// through it does not. The controls themselves — markup, wiring, the field
// surface they are drawn on — live in param-row.ts, shared with the
// project-wide Parameters column.

/**
 * The bands above the controls — the configuration band, then the Part
 * band — as one stack: scope chrome, not parameter rows. The stack closes
 * with the hairline the column's other chrome draws, which parts it from the
 * values below, and keeps the sheet's spacing under it. Hidden with both its
 * bands, so an empty stack shifts nothing.
 */
const BAND_STACK_CLASS = 'pb-1.5 mb-1 border-b border-base-content/10';

/**
 * One band: the configuration dropdown, or the Part dropdown answering the
 * header's + ("add to which part?"). Laid out as a parameter row is
 * (param-row.ts): the same padding, a label line, then the control at the
 * column's full width under it, so a band reads as the same kind of control
 * and a long name such as "Default" never truncates.
 */
const BAND_CLASS = 'px-3 py-1.5';

/** A band's label line: the caption, then (configuration band) the ⋮. */
const BAND_LABEL_ROW_CLASS = 'flex items-center gap-1';

/** A band's caption: the parameter rows' label typography. */
const BAND_CAPTION_CLASS = 'flex-1 truncate text-sm text-base-content/80';

/**
 * A band's dropdown: the app's standard select — the bordered `select-sm`
 * the feature dialogs and Settings use (settings-tab.ts's `SELECT`) — so its
 * field and its open list are daisyUI's solid base surface, never the scene
 * showing through. Full width under the label, as a parameter's control is.
 */
const BAND_SELECT_CLASS = 'select select-sm select-bordered w-full mt-1';

/** The reserved row: the `param()` literals — never among a table's names, always first in the dropdown. */
const DEFAULT_CONFIGURATION = 'Default';

/**
 * The label line's ⋮: the row actions' menu. A ghost square the label
 * line's own height, like a parameter row's pencil, so the line keeps the
 * rows' rhythm.
 */
const CONFIGURATION_MENU_BUTTON_CLASS =
  'btn btn-ghost btn-xs btn-square size-5 min-h-0 shrink-0 text-base-content/50 hover:text-base-content/80 [&>svg]:size-3.5';

/** The band's one control while the file has no table: what starts one. */
const CONFIGURATION_ADD_BUTTON_CLASS =
  'btn btn-ghost btn-xs gap-1.5 -ml-1 px-2 font-normal text-base-content/70 hover:text-base-content/90 [&_svg]:size-3.5';

/**
 * The hint on a row the active configuration leaves out: its value is the
 * literal. Dimmed and italic like an empty state, so it reads as a note on
 * the row rather than as a second value.
 */
const DEFAULT_HINT = '<span class="shrink-0 text-xs text-base-content/40 italic" data-param-default-hint>default</span>';

/**
 * On a row the active configuration sets, beside the pencil: ↺ clears the
 * row's cell, so the parameter reads its default again — the Manage grid's
 * ↺, on the row on screen. Fades in on hover like the pencil, so the bold
 * label stays the row's one mark of a set value.
 */
const INHERIT_BUTTON_CLASS =
  'btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-0 group-hover:opacity-100 focus:opacity-100 '
  + 'text-xs leading-none text-base-content/40 hover:text-base-content/70';

/**
 * Add and reset sit in the header card rather than above the first row, so
 * the section reads as one row of chrome like the History's menu does. Both
 * stop the click short of the header, which would otherwise collapse the
 * section out from under the dialog the button just opened.
 */
const HEADER_BUTTONS = `
  <span class="ml-auto flex items-center relative">
    <button class="btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-base-content/70" title="Add parameter or property" data-add-param>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
        <path d="M10 4.25a.75.75 0 01.75.75v4.25H15a.75.75 0 010 1.5h-4.25V15a.75.75 0 01-1.5 0v-4.25H5a.75.75 0 010-1.5h4.25V5a.75.75 0 01.75-.75z" />
      </svg>
    </button>
    <button class="btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-base-content/70" title="Reset all to defaults" data-reset-params>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
        <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.598a.75.75 0 00-.75.75v3.634a.75.75 0 001.5 0v-2.09l.312.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm-10.624-2.85a5.5 5.5 0 019.201-2.465l.312.31H11.77a.75.75 0 000 1.5h3.634a.75.75 0 00.75-.75V3.535a.75.75 0 00-1.5 0v2.09l-.312-.31A7 7 0 002.63 8.453a.75.75 0 001.449.39z" clip-rule="evenodd" />
      </svg>
    </button>
  </span>
`;

/**
 * The model's parameters, as one section of a docked panel column.
 *
 * `container` is optional: a host that already knows where the section goes
 * passes it and is done, while the part rail builds the panel before the
 * column that will hold it exists and mounts it later ({@link mount}). Its
 * values and its open/closed state then survive a rail rebuild, because the
 * panel outlives the column its elements happen to be parented to.
 */
export class ParamsPanel extends AccordionSection {
  private currentParams: UIParamDefinition[] = [];
  /** The rendered file's `property()` declarations — a part scene's published values. */
  private currentProperties: UIPropertyDefinition[] = [];
  /** The rendered file's `configurations()` rows and the active one; null until a render carries them. */
  private configurations: UIConfigurations | null = null;
  /**
   * The header's ↺, which drops the session's value overrides: "Reset all to
   * defaults" on Default, "Revert changes" while a row is active. Only a
   * read-only host has overrides to drop — where the panel writes values
   * into the source there are none, and the button is hidden.
   */
  private readonly resetButton: HTMLElement;
  /** Where the band's own dialogs mount; the host points it at its overlay container. */
  dialogHost: HTMLElement = document.body;
  /** Asks for a row name (Add, Duplicate…, Rename…); resolves when the prompt closes. */
  promptName: (prompt: ConfigurationNamePrompt) => Promise<void> =
    (prompt) => promptConfigurationName(this.dialogHost, prompt);
  /** Asks before Delete removes the active row; resolves true to delete. */
  confirmDelete: (name: string) => Promise<boolean> = (name) => confirmConfigurationDelete(this.dialogHost, name);
  /**
   * Asks before the Manage grid marks a row for deletion. Unlike
   * {@link confirmDelete} nothing is removed yet — the row goes when the grid
   * is applied — so the host words it as a staged removal.
   */
  confirmGridDelete: (name: string) => Promise<boolean> = (name) => this.confirmDelete(name);
  /** Opens the Manage grid over the whole table; resolves when it closes. */
  openGrid: (opts: ConfigurationsGridOptions) => Promise<void> = (opts) => openConfigurationsGrid(this.dialogHost, opts);
  /** A refused edit with no dialog open to show it in: a value write, ↺ on a row, Delete. */
  onError: (message: string) => void = (message) => console.error(message);
  /** The rows' decoration key the list was last drawn with — what update() compares against. */
  private renderedDecor = '';
  private debouncer = new ParamDebouncer();
  /** The value writes, one at a time and coalesced per parameter (source-editing hosts only). */
  private readonly writes = new ParamWriteQueue();
  private collapsedGroups = new Set<string>();
  /** The header +'s open menu, while one is open. */
  private addMenu: HTMLDivElement | null = null;
  private addMenuCleanup: (() => void) | null = null;

  /** The two bands' stack, hidden while both of them are. */
  private bands: HTMLDivElement;
  /**
   * The configuration band, first in the stack in both scopes: what the file
   * renders (the dropdown and the ⋮ row actions) or, before
   * the file has a table, the Add configuration button.
   */
  private configurationBar: HTMLDivElement;
  /** The Part dropdown's row (part scope), under the configuration band; its own element so a re-render of the list leaves it be. */
  private partBar: HTMLDivElement;
  /** Where the parameter controls are drawn. */
  private list: HTMLDivElement;
  /** The header's +, or null on a host without an editor to open. */
  private addButton: HTMLElement | null = null;
  /** Where the Part dropdown reads the scene's parts and the timeline's selected one from. */
  private partProvider: (() => PartChoices) | null = null;
  /** The parts the dropdown currently lists, by option index. */
  private partChoices: PartChoice[] = [];
  /**
   * What the user chose in the dropdown: a part, or undefined while nothing
   * was chosen — the dropdown then follows the timeline's selected part. A
   * choice lasts until that selection moves (a click on another part row, a
   * new part), which resets it to that default; stepping out of the selected
   * part to the file's top level keeps it.
   */
  private pick: PartChoice | undefined = undefined;
  /** True while update() runs syncParts — it decides the redraw itself. */
  private syncing = false;
  /** File and name of the timeline's selected part at the last sync — the identity a line shift keeps. */
  private lastSelectedKey: string | null = null;

  constructor(
    container: HTMLElement | null,
    private client: EngineClient,
    private editor?: ParamEditorDialog,
    private scope: 'part' | 'assembly' = 'part',
    /** The property dialog; part scope only — a property lives in a part body. */
    private propertyEditor?: PropertyEditorDialog,
  ) {
    // Hidden until a host shows it — the floating hosts toggle it from a
    // button, and the docked column turns it on for good when it mounts it.
    super('Parameters', {
      visible: false,
      trailing: HEADER_BUTTONS,
      sheet: true,
    });

    const resetButton = this.header.querySelector<HTMLElement>('[data-reset-params]')!;
    this.resetButton = resetButton;
    resetButton.hidden = this.writesSource;
    resetButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.client.resetParams();
    });
    // Declaration edits rewrite source; without an editor-backed host the
    // panel is a pure value surface.
    const addButton = this.header.querySelector<HTMLElement>('[data-add-param]')!;
    if (this.editor) {
      this.addButton = addButton;
      addButton.addEventListener('click', (e) => {
        e.stopPropagation();
        // A part file declares two kinds of thing: the + asks which. An
        // assembly body only takes parameters, so there its + stays direct.
        if (this.propertyEditor && this.scope === 'part') {
          this.toggleAddMenu(addButton);
        } else {
          this.editor!.openForCreate(this.selectedPart);
        }
      });
    } else {
      addButton.remove();
    }

    // The bands and the controls are separate rows of the body: the bands
    // survive a re-render of the list, and the list's in-place value updates
    // never touch them.
    this.configurationBar = document.createElement('div');
    this.configurationBar.className = BAND_CLASS;
    this.configurationBar.hidden = true;
    this.partBar = document.createElement('div');
    this.partBar.className = BAND_CLASS;
    this.partBar.hidden = true;
    this.bands = document.createElement('div');
    this.bands.className = BAND_STACK_CLASS;
    this.bands.hidden = true;
    this.bands.append(this.configurationBar, this.partBar);
    this.list = document.createElement('div');
    this.body.appendChild(this.bands);
    this.body.appendChild(this.list);

    // The empty state is part of the section, not something the first render
    // brings: a model with no parameters at all never sends an update.
    this.renderParams();
    // The configuration band offers Add configuration from the start, too —
    // in part scope once the scene has a part to start the table in.
    this.syncConfigurations();

    if (container) {
      this.mount(container);
    }
  }

  update(params: UIParamDefinition[], properties: UIPropertyDefinition[] = [], configurations?: UIConfigurations): void {
    const prev = this.visibleParams();
    const prevProperties = this.visibleProperties();
    this.currentParams = params;
    this.currentProperties = properties;
    this.configurations = configurations ?? null;
    this.syncing = true;
    try {
      this.syncParts();
    } finally {
      this.syncing = false;
    }
    const next = this.visibleParams();
    const nextProperties = this.visibleProperties();
    // A configuration switch changes which labels are bold and which rows
    // carry the "default" hint — not something the in-place path redraws.
    if (this.canUpdateInPlace(prev, next)
      && ParamsPanel.samePropertyRows(prevProperties, nextProperties)
      && this.rowDecorKey(next) === this.renderedDecor) {
      this.updateValuesInPlace(next);
      this.updatePropertyValuesInPlace(nextProperties);
    } else {
      this.renderParams();
    }
  }

  /** The configuration the rendered file shows: a row name, or Default. */
  get activeConfiguration(): string {
    return this.configurations?.active ?? DEFAULT_CONFIGURATION;
  }

  /** Whether the rows carry configuration decorations: a row, not Default, is active. */
  private get rowActive(): boolean {
    return this.activeConfiguration !== DEFAULT_CONFIGURATION;
  }

  /** Everything about the configuration that decides how `params` rows are decorated. */
  private rowDecorKey(params: UIParamDefinition[]): string {
    return JSON.stringify([this.rowActive, params.map((p) => p.configuredValue !== undefined)]);
  }

  /**
   * Whether a value edited here is written into the source: an editor-backed
   * host whose client can write it. Then a committed value is the active
   * configuration's — the row's cell, or on Default the `param()` literal —
   * and there is no session-only value to mark, save or revert. A
   * read-only host (the viewer embed) overrides values for the session.
   */
  get writesSource(): boolean {
    return this.editor !== undefined && typeof this.client.writeParam === 'function';
  }

  /** Whether the band offers the row edits: an editor-backed host whose client can rewrite the table. */
  private get canEditConfigurations(): boolean {
    return this.editor !== undefined && typeof this.client.addConfiguration === 'function';
  }

  /**
   * Whether the file has a body a new `configurations()` table can start in:
   * the assembly's own body, or — in part scope — a part. A top-level file
   * without `part()` cannot declare `param()`, so it has no table to start.
   */
  private get hasTableBody(): boolean {
    return this.scope === 'assembly' || this.partChoices.length > 0;
  }

  /**
   * The configuration band, the same in both scopes. With a
   * `configurations()` table: the dropdown — Default, then the file's rows —
   * and the ⋮ menu of row actions; the dropdown shows
   * on any host, even one with nothing to edit or no part to add to. Without
   * a table: a single Add configuration button, which starts one — on a host
   * that can edit, in a file with a body to hold it ({@link hasTableBody}).
   * Otherwise hidden. Redrawn by every render through {@link update}.
   */
  private syncConfigurations(): void {
    const configurations = this.configurations;
    const names = configurations?.names ?? [];
    this.resetButton.title = this.rowActive ? 'Revert changes' : 'Reset all to defaults';
    if (names.length === 0) {
      if (!this.canEditConfigurations || !this.hasTableBody) {
        this.configurationBar.hidden = true;
        this.configurationBar.replaceChildren();
        this.syncBandStack();
        return;
      }
      this.configurationBar.hidden = false;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = CONFIGURATION_ADD_BUTTON_CLASS;
      add.dataset.configurationAdd = '';
      add.title = 'Name the values on screen as a configuration — a row the file and its inserts can pick';
      add.innerHTML = `${ICON_PLUS}<span>Add configuration</span>`;
      add.addEventListener('click', () => void this.addConfiguration('Add configuration', 'Add'));
      this.configurationBar.replaceChildren(add);
      this.syncBandStack();
      return;
    }
    this.configurationBar.hidden = false;
    const select = document.createElement('select');
    select.className = BAND_SELECT_CLASS;
    select.title = 'The configuration the file renders';
    select.setAttribute('aria-label', 'Configuration');
    select.dataset.configuration = '';
    for (const name of [DEFAULT_CONFIGURATION, ...names]) {
      select.appendChild(ParamsPanel.option(name, name));
    }
    select.value = this.activeConfiguration;
    select.addEventListener('change', () => {
      void this.pickConfiguration(select);
    });
    const labelRow: HTMLElement[] = [ParamsPanel.bandCaption('Configuration')];
    if (this.canEditConfigurations) {
      const menuButton = document.createElement('button');
      menuButton.type = 'button';
      menuButton.className = CONFIGURATION_MENU_BUTTON_CLASS;
      menuButton.dataset.configurationMenu = '';
      menuButton.title = 'Configuration actions';
      menuButton.setAttribute('aria-label', 'Configuration actions');
      menuButton.innerHTML = ICON_DOTS_VERTICAL;
      menuButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openConfigurationMenu(menuButton);
      });
      labelRow.push(menuButton);
    }
    this.configurationBar.replaceChildren(ParamsPanel.bandLabelRow(labelRow), select);
    this.syncBandStack();
  }

  /** The stack shows while either band does. */
  private syncBandStack(): void {
    this.bands.hidden = this.configurationBar.hidden && this.partBar.hidden;
  }

  /**
   * The row actions, acting on the active row. There is no Save: a value
   * edited in the panel is already in the row. Rename… and Delete need a
   * row — Default is the literals, which a value edit on Default writes.
   */
  configurationMenuItems(): PopupMenuItem[] {
    const active = this.activeConfiguration;
    const onDefault = active === DEFAULT_CONFIGURATION;
    const noRow = 'Default is the parameters\' own values — pick a configuration first';
    const canManage = this.configurationNames.length > 0 && typeof this.client.commitConfigurationTable === 'function';
    return [
      {
        icon: ICON_PLUS,
        label: 'Add configuration…',
        onSelect: () => void this.addConfiguration('Add configuration', 'Add'),
      },
      {
        icon: ICON_COPY,
        label: 'Duplicate…',
        title: 'A new configuration holding the values on screen',
        onSelect: () => void this.addConfiguration('Duplicate configuration', 'Duplicate', onDefault ? '' : `${active} copy`),
      },
      {
        icon: ICON_PENCIL,
        label: 'Rename…',
        disabled: onDefault,
        ...(onDefault ? { title: noRow } : {}),
        onSelect: () => void this.renameConfiguration(active),
      },
      {
        icon: ICON_TRASH,
        label: 'Delete',
        separated: true,
        className: 'text-error',
        disabled: onDefault,
        ...(onDefault ? { title: noRow } : {}),
        onSelect: () => void this.deleteConfiguration(active),
      },
      {
        icon: ICON_GRID,
        label: 'Manage…',
        separated: true,
        disabled: !canManage,
        title: canManage ? 'Every configuration and its values in one table' : 'No configurations() table to manage',
        onSelect: () => void this.manageConfigurations(),
      },
    ];
  }

  private openConfigurationMenu(anchor: HTMLElement): void {
    const host = this.configurationBar.closest<HTMLElement>('#fluidcad-viewer') ?? document.body;
    const rect = anchor.getBoundingClientRect();
    const menu = showPopupMenu(host, { clientX: rect.right, clientY: rect.bottom + 4 }, this.configurationMenuItems(), {
      align: 'end',
      focusFirst: true,
    });
    menu.dataset.configurationActions = '';
  }

  /** The names the table has now — what a new or renamed row may not repeat. */
  private get configurationNames(): string[] {
    return this.configurations?.names ?? [];
  }

  /**
   * Add (and Duplicate…): a new row holding every value that differs from its
   * literal — the values on screen: the active row's cells (plus a read-only
   * session's tweaks), or nothing on Default — selected once it lands. The server writes each
   * part's values into that part's own table; a row with no value at all
   * goes into the Part band's part ({@link configurationHome}).
   */
  private addConfiguration(title: string, confirmLabel: string, initial = ''): Promise<void> {
    const add = this.client.addConfiguration;
    if (!add) {
      return Promise.resolve();
    }
    const home = this.configurationHome;
    return this.promptName({
      title,
      confirmLabel,
      initial,
      taken: this.configurationNames,
      submit: async (name) => this.landed(await (home
        ? add.call(this.client, name, undefined, home)
        : add.call(this.client, name))),
    });
  }

  /**
   * Where a configuration row with no value of its own goes: the Part band's
   * part's `part()` statement, in part scope. Null in assembly scope (the
   * assembly body is the only one) and in a scene with no part.
   */
  private get configurationHome(): SourceLocation | null {
    if (this.scope === 'assembly' || this.partChoices.length === 0) {
      return null;
    }
    return this.selectedPart;
  }

  private renameConfiguration(from: string): Promise<void> {
    const rename = this.client.renameConfiguration;
    if (!rename) {
      return Promise.resolve();
    }
    return this.promptName({
      title: 'Rename configuration',
      confirmLabel: 'Rename',
      initial: from,
      taken: this.configurationNames,
      submit: async (to) => this.landed(await rename.call(this.client, from, to)),
    });
  }

  private async deleteConfiguration(name: string): Promise<void> {
    const remove = this.client.removeConfiguration;
    if (!remove || !await this.confirmDelete(name)) {
      return;
    }
    const refused = this.landed(await remove.call(this.client, name));
    if (refused !== null) {
      this.onError(`Couldn't delete ${name}: ${refused}`);
    }
  }

  /**
   * Manage…: every table of the file in one grid, committed as one rewrite
   * of the file. The columns are {@link gridParams} — the assembly's own
   * parameters, or every part's, grouped by part — and the cells come from
   * the source, so expressions stay.
   */
  private manageConfigurations(): Promise<void> {
    const commitTable = this.client.commitConfigurationTable;
    if (!commitTable || !this.configurations) {
      return Promise.resolve();
    }
    const getTables = this.client.getConfigurationTables;
    const home = this.configurationHome;
    return this.openGrid({
      params: this.gridParams(),
      configurations: this.configurations,
      ...(getTables ? { loadTable: () => getTables.call(this.client) } : {}),
      ...(home ? { home } : {}),
      commit: async (commit) => this.landed(await commitTable.call(this.client, commit)),
      confirmDelete: (name) => this.confirmGridDelete(name),
    });
  }

  /**
   * The Manage grid's columns. A configuration row is file-wide and sets
   * any part's parameters, so in part scope these are every part's
   * parameters — not only the part the Part band names — in the parts' order, each
   * part's run kept together (the grid draws a part header over each run
   * when there are several). In assembly scope, the assembly's own.
   */
  private gridParams(): UIParamDefinition[] {
    if (this.scope === 'assembly') {
      return this.visibleParams();
    }
    if (this.partChoices.length === 0) {
      return this.currentParams.filter((p) => ParamsPanel.kindOf(p) !== 'global');
    }
    const parts = this.currentParams.filter((p) => ParamsPanel.kindOf(p) === 'part' && p.part !== undefined);
    return this.partChoices.flatMap((choice) =>
      parts.filter((p) => ActivePartTracker.sameStatement(p.part!, choice.sourceLocation)));
  }

  /**
   * A row edit's answer: null when it landed — the band takes the table the
   * answer carries straight away, ahead of the re-render bringing the same —
   * or the refusal's text.
   */
  private landed(result: { success: boolean; reason?: string; configurations?: UIConfigurations }): string | null {
    if (!result.success) {
      return result.reason ?? 'The edit was refused.';
    }
    if (result.configurations) {
      this.configurations = result.configurations;
      this.syncConfigurations();
    }
    return null;
  }

  /**
   * The dropdown's choice, shown straight away. Nothing is left to lose: on
   * a source-editing host every value is already in its row, and a
   * read-only host's session tweaks are exploratory — the switch drops them,
   * as ↺ would. The values still being written finish first, so each lands
   * in the row it was typed on.
   */
  private async pickConfiguration(select: HTMLSelectElement): Promise<void> {
    const name = select.value;
    if (name === this.activeConfiguration) {
      return;
    }
    if (!this.writes.idle) {
      await this.writes.whenIdle();
    }
    this.client.selectConfiguration(name);
  }

  /**
   * The property rows the list shows: the selected part's own declarations,
   * like {@link visibleParams}; none in assembly scope, where a property has
   * no home.
   */
  private visibleProperties(): UIPropertyDefinition[] {
    if (this.scope === 'assembly') {
      return [];
    }
    const selected = this.partChoices.length === 0 ? null : this.selectedPart;
    if (selected === null) {
      return this.currentProperties;
    }
    return this.currentProperties.filter((p) => ActivePartTracker.sameStatement(p.part, selected));
  }

  /**
   * The header + as a two-item menu: what to declare. Opens below the button,
   * inside the header's own layout; a click anywhere else closes it.
   */
  private toggleAddMenu(anchor: HTMLElement): void {
    if (this.addMenu) {
      this.closeAddMenu();
      return;
    }
    const menu = document.createElement('div');
    // Solid like every popup menu (menu-styles.ts): it opens over the rows.
    menu.className = 'absolute right-0 top-full mt-1 z-[200] bg-base-100 border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    menu.dataset.addMenu = '';
    menu.innerHTML = `
      <ul class="menu menu-xs p-1 min-w-[160px]">
        ${ParamsPanel.menuItem('param', ICON_ADJUSTMENTS, 'New parameter')}
        ${ParamsPanel.menuItem('property', ICON_CODE, 'New property')}
      </ul>
    `;
    // The header collapses the section on click; the menu's clicks are its own.
    menu.addEventListener('click', (e) => e.stopPropagation());
    menu.querySelector('[data-add="param"]')!.addEventListener('click', () => {
      this.closeAddMenu();
      this.editor!.openForCreate(this.selectedPart);
    });
    menu.querySelector('[data-add="property"]')!.addEventListener('click', () => {
      this.closeAddMenu();
      this.propertyEditor!.openForCreate(this.selectedPart);
    });
    anchor.parentElement!.appendChild(menu);
    this.addMenu = menu;

    const onClickOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
        this.closeAddMenu();
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
    this.addMenuCleanup = () => document.removeEventListener('click', onClickOutside);
  }

  private closeAddMenu(): void {
    this.addMenu?.remove();
    this.addMenu = null;
    this.addMenuCleanup?.();
    this.addMenuCleanup = null;
  }

  private static menuItem(kind: 'param' | 'property', icon: string, label: string): string {
    return `<li><button data-add="${kind}" class="flex items-center gap-2">`
      + `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${icon}</span>`
      + `<span>${label}</span>`
      + `</button></li>`;
  }

  /**
   * The rows the list shows: with the dropdown on a part, that part's own
   * declarations — a parameter only lives inside a part body, so one stamped
   * with no part (an assembly body's) never shows under a part; everything
   * when the scene has no parts to filter by.
   */
  private visibleParams(): UIParamDefinition[] {
    if (this.scope === 'assembly') {
      return this.currentParams.filter((p) => ParamsPanel.kindOf(p) === 'assembly');
    }
    const selected = this.partChoices.length === 0 ? null : this.selectedPart;
    if (selected === null) {
      return this.currentParams.filter((p) => ParamsPanel.kindOf(p) !== 'global');
    }
    return this.currentParams.filter((p) =>
      ParamsPanel.kindOf(p) === 'part' && p.part !== undefined && ActivePartTracker.sameStatement(p.part, selected));
  }

  /**
   * Where a declaration lives. A render from a server predating the field
   * is read the way the panel always did: stamped with a part, it is the
   * part's; otherwise the assembly's. A project parameter (`'global'`) is
   * never one of this section's rows — it has its own column.
   */
  private static kindOf(p: UIParamDefinition): UIParamDefinition['kind'] {
    return p.kind ?? (p.part !== undefined ? 'part' : 'assembly');
  }

  /**
   * Where the Part dropdown reads the scene's parts and the selected one
   * from — the timeline's part tracker. Without a provider (a host with no
   * timeline) the dropdown never shows and, with no part to declare in,
   * neither does the +, as in a scene with no parts.
   */
  setPartProvider(provider: () => PartChoices): void {
    this.partProvider = provider;
    this.syncParts();
  }

  /**
   * The part a new parameter goes into: the dropdown's choice, or the
   * timeline's selected part while nothing was chosen. Null only in a scene
   * with no parts, which has nowhere to declare one.
   */
  get selectedPart(): SourceLocation | null {
    const choices = this.partProvider?.() ?? { parts: [], selected: null };
    if (this.pick === undefined) {
      return choices.selected;
    }
    return ParamsPanel.resolve(this.pick, choices.parts)?.sourceLocation ?? choices.selected;
  }

  /**
   * The chosen part as the current render lists it — by statement line, else
   * by file and name: an insert above the statement shifts its line, a rename
   * keeps the line. Same rule the tracker re-resolves the selected part by.
   */
  private static resolve(wanted: PartChoice, parts: PartChoice[]): PartChoice | null {
    return parts.find((part) => ActivePartTracker.sameStatement(part.sourceLocation, wanted.sourceLocation))
      ?? parts.find((part) =>
        part.sourceLocation.filePath === wanted.sourceLocation.filePath && part.name === wanted.name)
      ?? null;
  }

  private static keyOf(part: PartChoice | null): string | null {
    return part === null ? null : `${part.sourceLocation.filePath}\n${part.name}`;
  }

  /**
   * Redraw the Part dropdown from the provider. Every render calls this
   * through {@link update}; the timeline calls it when a part-row click moves
   * the selection without a render. The row hides when the scene has no
   * parts, and so does the +: there is no part to declare a parameter in.
   * The configuration band above it is redrawn too — whether it offers Add
   * configuration depends on the scene having a part. An assembly has no
   * Part dropdown (its parameters live in its own body), only that band.
   */
  syncParts(): void {
    if (this.scope === 'assembly') {
      this.syncConfigurations();
      if (this.addButton) {
        this.addButton.hidden = false;
      }
      return;
    }
    const choices = this.partProvider?.() ?? { parts: [], selected: null };
    const timelinePart = choices.selected === null
      ? null
      : choices.parts.find((part) => ActivePartTracker.sameStatement(part.sourceLocation, choices.selected!)) ?? null;
    const selectedKey = ParamsPanel.keyOf(timelinePart);
    const selectionMoved = selectedKey !== this.lastSelectedKey;
    if (selectionMoved) {
      this.pick = undefined;
    }
    this.lastSelectedKey = selectedKey;
    const hadParts = this.partChoices.length > 0;
    this.partChoices = choices.parts;
    // Called outside update() (a timeline click), a moved selection changes
    // which rows show — redraw the list to match.
    if (!this.syncing && (selectionMoved || hadParts !== choices.parts.length > 0)) {
      this.renderParams();
    }

    this.syncConfigurations();
    this.partBar.hidden = choices.parts.length === 0;
    if (this.addButton) {
      this.addButton.hidden = choices.parts.length === 0;
    }
    if (choices.parts.length === 0) {
      this.partBar.replaceChildren();
      this.syncBandStack();
      return;
    }
    const select = document.createElement('select');
    select.className = BAND_SELECT_CLASS;
    select.title = 'The part a new parameter is added to';
    select.setAttribute('aria-label', 'Part a new parameter is added to');
    select.dataset.paramPart = '';
    ActivePartTracker.choiceLabels(choices.parts).forEach((text, index) => {
      select.appendChild(ParamsPanel.option(String(index), text));
    });
    const selected = this.selectedPart;
    const index = selected === null
      ? -1
      : choices.parts.findIndex((part) => ActivePartTracker.sameStatement(part.sourceLocation, selected));
    // A scene with parts always has a selected one among them; the first
    // entry only stands in for a tracker mid-resolution.
    select.value = String(Math.max(index, 0));
    select.addEventListener('change', () => {
      this.pick = this.partChoices[Number(select.value)];
      this.renderParams();
    });

    // "Part <part>" — the caption names what the dropdown decides, since the
    // + it answers sits in the header above rather than beside it.
    this.partBar.replaceChildren(ParamsPanel.bandLabelRow([ParamsPanel.bandCaption('Part')]), select);
    this.syncBandStack();
  }

  /** A band's label line, above its dropdown. */
  private static bandLabelRow(children: HTMLElement[]): HTMLDivElement {
    const row = document.createElement('div');
    row.className = BAND_LABEL_ROW_CLASS;
    row.append(...children);
    return row;
  }

  private static bandCaption(text: string): HTMLSpanElement {
    const caption = document.createElement('span');
    caption.className = BAND_CAPTION_CLASS;
    caption.textContent = text;
    return caption;
  }

  private static option(value: string, label: string): HTMLOptionElement {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  /** Show the section if it is hidden, hide it if it is not. */
  toggle(): void {
    this.setVisible(!this.isVisible);
  }

  private canUpdateInPlace(prev: UIParamDefinition[], next: UIParamDefinition[]): boolean {
    if (prev.length !== next.length || prev.length === 0) {
      return false;
    }
    for (let i = 0; i < prev.length; i++) {
      if (controlSignature(prev[i]) !== controlSignature(next[i])) {
        return false;
      }
    }
    return true;
  }

  /** Whether two property lists draw the same rows — only their values may differ. */
  private static samePropertyRows(prev: UIPropertyDefinition[], next: UIPropertyDefinition[]): boolean {
    if (prev.length !== next.length) {
      return false;
    }
    return prev.every((p, i) => p.name === next[i].name);
  }

  private updatePropertyValuesInPlace(properties: UIPropertyDefinition[]): void {
    for (const p of properties) {
      const el = this.body.querySelector<HTMLElement>(`[data-property-value="${CSS.escape(p.name)}"]`);
      if (el) {
        el.textContent = ParamsPanel.propertyValueText(p.value);
      }
    }
  }

  private updateValuesInPlace(params: UIParamDefinition[]): void {
    updateParamValuesInPlace(this.list, params);
  }

  private renderParams(): void {
    const params = this.visibleParams();
    const properties = this.visibleProperties();
    this.renderedDecor = this.rowDecorKey(params);

    // The panel is reachable with nothing in it — adding the model's first
    // parameter is one of the things it is for. With the dropdown filtering,
    // "nothing" is nothing IN THAT PART, and the wording says so.
    if (params.length === 0 && properties.length === 0) {
      this.list.innerHTML = AccordionSection.emptyState(this.emptyMessage());
      return;
    }

    const ungrouped: UIParamDefinition[] = [];
    const groups = new Map<string, UIParamDefinition[]>();
    for (const p of params) {
      if (p.group) {
        if (!groups.has(p.group)) {
          groups.set(p.group, []);
        }
        groups.get(p.group)!.push(p);
      } else {
        ungrouped.push(p);
      }
    }

    const rowOptions = { editable: this.editor !== undefined };
    // A label two listed parts both declare names its part after it, so the
    // rows read apart; a label shown once keeps the plain look.
    const shared = ParamsPanel.sharedLabels(params);
    // With a row active: a label the row sets is bold, one it leaves out
    // says so — its value is the literal. Where values are written into the
    // source, a set one also carries the ↺ that clears its cell.
    const rowActive = this.rowActive;
    const inherit = rowActive && this.writesSource;
    const optionsFor = (p: UIParamDefinition) => {
      const base = shared.has(p.label) && p.body !== undefined ? { ...rowOptions, owner: p.body } : rowOptions;
      if (!rowActive) {
        return base;
      }
      if (p.configuredValue === undefined) {
        return { ...base, labelTrailing: DEFAULT_HINT };
      }
      return inherit
        ? { ...base, labelBold: true, labelTrailing: this.inheritButton(p) }
        : { ...base, labelBold: true };
    };
    let html = '';
    for (const p of ungrouped) {
      html += renderParamControl(p, optionsFor(p));
    }
    for (const [groupName, groupParams] of groups) {
      let controlsHtml = '';
      for (const p of groupParams) {
        controlsHtml += renderParamControl(p, optionsFor(p));
      }
      html += renderParamGroup(groupName, controlsHtml, this.collapsedGroups.has(groupName));
    }

    html += this.renderProperties(properties);

    this.list.innerHTML = html;
    // A row is its part + label: the value goes to that part's parameter
    // only, even when another part declares the same label.
    bindParamHandlers(this.list, {
      lookup: (key) => this.paramFor(key),
      setValue: (key, value) => {
        const def = this.paramFor(key);
        if (def) {
          this.commitValue(def, value);
        }
      },
      onEdit: (key) => {
        const def = this.paramFor(key);
        if (def) {
          this.editor?.openForEdit(def);
        }
      },
      debouncer: this.debouncer,
      sendOn: this.writesSource ? 'commit' : 'live',
    });
    this.list.querySelectorAll<HTMLElement>('[data-param-inherit]').forEach((el) => {
      el.addEventListener('click', () => {
        const def = this.paramFor(el.dataset.paramInherit!);
        if (def) {
          this.inheritValue(def);
        }
      });
    });
    this.bindPropertyHandlers();
    bindParamGroups(this.list, this.collapsedGroups);
  }

  /**
   * A value the user finished editing. Where the panel writes source it is
   * written into the configuration on screen — the row's cell, or on
   * Default the literal — queued behind the writes before it; a refusal
   * shows as an error and redraws the rows from the last render, so the
   * control goes back to the value the source still holds. A read-only
   * host overrides it for the session.
   */
  private commitValue(def: UIParamDefinition, value: unknown): void {
    if (!this.writesSource) {
      this.client.setParam(def.label, value, def.body);
      return;
    }
    this.queueWrite(def, value, `Couldn't change ${def.label}`);
  }

  /** ↺ on a row-set parameter: clear the active row's cell, so the parameter reads its default again. */
  private inheritValue(def: UIParamDefinition): void {
    this.queueWrite(def, null, `Couldn't reset ${def.label} to its default`);
  }

  /** One value write into the source, for the configuration shown when it was made. */
  private queueWrite(def: UIParamDefinition, value: unknown, failure: string): void {
    const write = this.client.writeParam;
    if (!write) {
      return;
    }
    const configuration = this.activeConfiguration;
    this.writes.enqueue(paramRowKey(def), async () => {
      const refused = this.landed(await write.call(this.client, def.label, value, def.body, configuration));
      if (refused !== null) {
        this.onError(`${failure}: ${refused}`);
        this.renderParams();
      }
    });
  }

  /** The ↺ markup of a row-set parameter's label line. */
  private inheritButton(p: UIParamDefinition): string {
    const key = escapeHtml(paramRowKey(p));
    const title = escapeHtml(`Use the default — ${this.activeConfiguration} stops setting ${p.label}`);
    return `<button type="button" class="${INHERIT_BUTTON_CLASS}" data-param-inherit="${key}" title="${title}" aria-label="${title}">↺</button>`;
  }

  /** The parameter a row key names, as the last render listed it. */
  private paramFor(key: string): UIParamDefinition | undefined {
    return this.currentParams.find((p) => paramRowKey(p) === key);
  }

  /** The labels more than one of `params` carries — two parts' `Width` listed together. */
  private static sharedLabels(params: UIParamDefinition[]): Set<string> {
    const seen = new Set<string>();
    const shared = new Set<string>();
    for (const p of params) {
      if (seen.has(p.label)) {
        shared.add(p.label);
      }
      seen.add(p.label);
    }
    return shared;
  }

  /**
   * The part's published values, below its parameters under a caption of
   * their own: name on the left, the value the last render computed on the
   * right. A property is read-only here — its value is an expression the
   * pencil opens, not a control to drag.
   */
  private renderProperties(properties: UIPropertyDefinition[]): string {
    if (properties.length === 0) {
      return '';
    }
    const rows = properties.map((p) => {
      const name = escapeHtml(p.name);
      const label = escapeHtml(p.label ?? p.name);
      const editButton = !this.propertyEditor ? '' : `
        <button class="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-0 group-hover:opacity-100 focus:opacity-100 text-base-content/40 hover:text-base-content/70"
          data-property-edit="${name}" title="Edit property">
          <span class="[&>svg]:size-3">${ICON_PENCIL}</span>
        </button>`;
      return `
        <div class="px-3 py-1.5 group flex items-center gap-2" data-property-row="${name}">
          <span class="text-sm text-base-content/80 flex-1 truncate" title="${name}">${label}</span>
          <span class="text-sm text-base-content/80 tabular-nums font-mono truncate max-w-[45%]" data-property-value="${name}">${escapeHtml(ParamsPanel.propertyValueText(p.value))}</span>
          ${editButton}
        </div>
      `;
    }).join('');
    return `
      <div class="mt-2 border-t border-base-content/10" data-properties>
        <div class="px-3 pt-2 pb-0.5 text-xs font-medium text-base-content/65 uppercase tracking-wider">Properties</div>
        ${rows}
      </div>
    `;
  }

  /** A computed value as the row prints it. */
  private static propertyValueText(value: UIPropertyDefinition['value']): string {
    if (Array.isArray(value)) {
      return `[${value.join(', ')}]`;
    }
    if (typeof value === 'number') {
      return String(Number.isInteger(value) ? value : Number(value.toFixed(4)));
    }
    return String(value);
  }

  private bindPropertyHandlers(): void {
    this.list.querySelectorAll<HTMLElement>('[data-property-edit]').forEach((el) => {
      el.addEventListener('click', () => {
        const def = this.visibleProperties().find((p) => p.name === el.dataset.propertyEdit);
        if (def) {
          this.propertyEditor?.openForEdit(def);
        }
      });
    });
  }

  private emptyMessage(): string {
    if (this.scope === 'assembly') {
      return this.editor
        ? 'No assembly parameters yet. Use + above to add one.'
        : 'No assembly parameters yet. Declare one with <code>param(...)</code> inside the assembly body.';
    }
    // A parameter only lives inside a part body: without a part there is no
    // + to offer, only the call to write.
    if (this.partChoices.length === 0) {
      return 'No parameters yet — declare one with <code>param(...)</code> inside a <code>part()</code> body.';
    }
    const how = this.editor ? 'use + above, or <code>param(...)</code>' : 'declare one with <code>param(...)</code>';
    const selected = this.selectedPart;
    const part = selected === null
      ? null
      : this.partChoices.find((c) => ActivePartTracker.sameStatement(c.sourceLocation, selected)) ?? null;
    return `No parameters in ${escapeHtml(part?.name || 'this part')} yet — ${how} in its body.`;
  }
}
