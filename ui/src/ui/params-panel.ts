import type { SourceLocation, UIConfigurations, UIParamDefinition, UIPropertyDefinition } from '../types';
import type { ParamEditorDialog, PartChoices } from './param-editor-dialog';
import type { PropertyEditorDialog } from './property-editor-dialog';
import type { EngineClient } from '../engine-client';
import { ActivePartTracker, type PartChoice } from '../interactive/active-part-tracker';
import {
  ICON_ADJUSTMENTS,
  ICON_CHECK,
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
  chooseConfigurationSwitch,
  confirmConfigurationDelete,
  promptConfigurationName,
  type ConfigurationNamePrompt,
  type ConfigurationSwitchChoice,
} from './configuration-dialogs';
import { openConfigurationsGrid, type ConfigurationsGridOptions } from './configurations-grid-dialog';
import { AccordionSection } from './accordion-section';
import {
  ParamDebouncer,
  bindParamGroups,
  bindParamHandlers,
  controlSignature,
  escapeHtml,
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
 * The band the Part dropdown sits in: scope chrome, not a parameter row. It
 * answers the header's + ("add to which part?"), so it hangs directly off
 * the header — `-mt-1` swallows the sheet's top padding so the band meets
 * the header's edge — and closes with the hairline the column's other chrome
 * draws, which is what parts it from the values below. Its tint is half the
 * fields' (param-row.ts's `FIELD_SURFACE`): recessed enough to read as a different
 * kind of surface, not so much that it competes with a field.
 */
const PART_BAND_CLASS =
  '-mt-1 mb-1 flex items-center gap-2 px-3 h-10 bg-base-content/[0.03] border-b border-base-content/10';

/**
 * The dropdown itself: a picker, so it takes the ghost form — no field
 * surface, no border at rest, a surface on hover and the focus ring on
 * interaction — rather than the bordered box a value field has. Same height
 * as the band's text row so the caption and the chosen name sit on one
 * baseline.
 *
 * The hover/focus surface is the SOLID base colour, not a translucent wash,
 * and it arrives with no transition: Chrome paints the popup list it opens
 * in the select's own background, sampled on the mousedown that opens it —
 * a wash, or daisyUI's 200 ms fade still on its first frame, came out as a
 * see-through menu over the scene.
 */
// The open list (`::picker(select)`) inherits the select's background,
// which is the ghost's transparent one once the pointer leaves the field —
// it gets the popup menus' own surface instead.
const PART_SELECT_CLASS =
  'select select-sm select-ghost flex-1 min-w-0 h-8 min-h-0 pl-2 pr-7 text-sm font-medium transition-none '
  + 'text-base-content/85 hover:bg-base-100 focus:bg-base-100 '
  + 'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 '
  + '[&::picker(select)]:panel-bg';

/** The reserved row: the `param()` literals — never among a table's names, always first in the dropdown. */
const DEFAULT_CONFIGURATION = 'Default';

/**
 * Beside the dropdown while session tweaks sit on top of the active row —
 * what ↺ (Revert) clears and what a Save would write into the row.
 */
const MODIFIED_MARKER_CLASS = 'shrink-0 text-xs text-base-content/60 whitespace-nowrap';

/** The band's ⋮ beside the dropdown: the row actions' menu. Same ghost square the header's buttons are. */
const CONFIGURATION_MENU_BUTTON_CLASS =
  'btn btn-ghost btn-xs btn-square shrink-0 text-base-content/50 hover:text-base-content/80 [&>svg]:size-3.5';

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
  /** The header's ↺: "Reset all to defaults" on Default, "Revert changes" while a row is active. */
  private readonly resetButton: HTMLElement;
  /** Where the band's own dialogs mount; the host points it at its overlay container. */
  dialogHost: HTMLElement = document.body;
  /**
   * Asks before a switch drops the session's tweaks on the active row:
   * save them into it first, discard them, or stay. `canSave` is false on
   * Default (no row to save into) or a host that cannot edit the table.
   */
  chooseSwitch: (active: string, target: string, canSave: boolean) => Promise<ConfigurationSwitchChoice> =
    (active, target, canSave) => chooseConfigurationSwitch(this.dialogHost, { active, target, canSave });
  /** Asks for a row name (Add, Save as…, Rename…); resolves when the prompt closes. */
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
  /** A refused row edit with no dialog open to show it in (Save, Delete, a switch's Save). */
  onError: (message: string) => void = (message) => console.error(message);
  /** The rows' decoration key the list was last drawn with — what update() compares against. */
  private renderedDecor = '';
  private debouncer = new ParamDebouncer();
  private collapsedGroups = new Set<string>();
  /** The header +'s open menu, while one is open. */
  private addMenu: HTMLDivElement | null = null;
  private addMenuCleanup: (() => void) | null = null;

  /** The Part dropdown's row, above the controls; its own element so a re-render of the list leaves it be. */
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

    // The Part band and the controls are two rows of the body: the band
    // survives a re-render of the list, and the list's in-place value
    // updates never touch it.
    this.partBar = document.createElement('div');
    this.partBar.className = PART_BAND_CLASS;
    this.partBar.hidden = true;
    this.list = document.createElement('div');
    this.body.appendChild(this.partBar);
    this.body.appendChild(this.list);

    // The empty state is part of the section, not something the first render
    // brings: a model with no parameters at all never sends an update.
    this.renderParams();
    // The configuration band offers Add configuration from the start, too.
    if (this.scope === 'assembly') {
      this.syncConfigurations();
    }

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

  /** Whether the rows carry configuration decorations: assembly scope with a row active. */
  private get rowActive(): boolean {
    return this.scope === 'assembly' && this.activeConfiguration !== DEFAULT_CONFIGURATION;
  }

  /** Everything about the configuration that decides how `params` rows are decorated. */
  private rowDecorKey(params: UIParamDefinition[]): string {
    return JSON.stringify([this.rowActive, params.map((p) => p.configuredValue !== undefined)]);
  }

  /** Whether the band offers the row edits: an editor-backed host whose client can rewrite the table. */
  private get canEditConfigurations(): boolean {
    return this.editor !== undefined && typeof this.client.addConfiguration === 'function';
  }

  /**
   * The band in assembly scope. With a `configurations()` table: the
   * dropdown — Default, then the file's rows — the modified marker, and the
   * ⋮ menu of row actions. Without one: a single Add configuration button,
   * which starts the table. Hidden only on a host that cannot edit and has
   * no table to pick from. Redrawn by every render through {@link update}.
   */
  private syncConfigurations(): void {
    const configurations = this.configurations;
    const names = configurations?.names ?? [];
    this.resetButton.title = this.rowActive ? 'Revert changes' : 'Reset all to defaults';
    if (names.length === 0) {
      if (!this.canEditConfigurations) {
        this.partBar.hidden = true;
        this.partBar.replaceChildren();
        return;
      }
      this.partBar.hidden = false;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = CONFIGURATION_ADD_BUTTON_CLASS;
      add.dataset.configurationAdd = '';
      add.title = 'Name the values on screen as a configuration — a row the file and its inserts can pick';
      add.innerHTML = `${ICON_PLUS}<span>Add configuration</span>`;
      add.addEventListener('click', () => void this.addConfiguration('Add configuration', 'Add'));
      this.partBar.replaceChildren(add);
      return;
    }
    this.partBar.hidden = false;
    const select = document.createElement('select');
    select.className = PART_SELECT_CLASS;
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
    const children: HTMLElement[] = [select];
    if (configurations!.modified) {
      const marker = document.createElement('span');
      marker.className = MODIFIED_MARKER_CLASS;
      marker.dataset.configurationModified = '';
      marker.title = 'Values changed on top of the configuration — ↺ reverts them';
      marker.textContent = '● modified';
      children.push(marker);
    }
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
      children.push(menuButton);
    }
    this.partBar.replaceChildren(...children);
  }

  /**
   * The row actions, acting on the active row. Save writes the tweaks into
   * it, so it needs both a row and tweaks; Rename… and Delete need a row —
   * Default is the literals, which the pencil edits.
   */
  configurationMenuItems(): PopupMenuItem[] {
    const active = this.activeConfiguration;
    const onDefault = active === DEFAULT_CONFIGURATION;
    const modified = this.configurations?.modified ?? false;
    const noRow = 'Default is the parameters\' own values — pick a configuration first';
    const canManage = this.configurationNames.length > 0 && typeof this.client.commitConfigurationTable === 'function';
    return [
      {
        icon: ICON_PLUS,
        label: 'Add configuration…',
        onSelect: () => void this.addConfiguration('Add configuration', 'Add'),
      },
      {
        icon: ICON_CHECK,
        label: 'Save',
        disabled: onDefault || !modified,
        title: onDefault ? noRow : !modified ? 'No changes on top of the configuration' : `Write the changes into ${active}`,
        onSelect: () => void this.saveConfiguration(),
      },
      {
        icon: ICON_COPY,
        label: 'Save as…',
        title: 'A new configuration holding the values on screen',
        onSelect: () => void this.addConfiguration('Save as configuration', 'Save', onDefault ? '' : `${active} copy`),
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
    const host = this.partBar.closest<HTMLElement>('#fluidcad-viewer') ?? document.body;
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
   * Add (and Save as…): a new row holding every value that differs from its
   * literal — the active row's cells plus the tweaks, or nothing on an
   * untouched Default — selected once it lands.
   */
  private addConfiguration(title: string, confirmLabel: string, initial = ''): Promise<void> {
    const add = this.client.addConfiguration;
    if (!add) {
      return Promise.resolve();
    }
    return this.promptName({
      title,
      confirmLabel,
      initial,
      taken: this.configurationNames,
      submit: async (name) => this.landed(await add.call(this.client, name)),
    });
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

  /** Save: the tweaks into the active row. True when it landed; a refusal goes to {@link onError}. */
  private async saveConfiguration(): Promise<boolean> {
    const save = this.client.saveConfiguration;
    if (!save) {
      return false;
    }
    const refused = this.landed(await save.call(this.client));
    if (refused !== null) {
      this.onError(`Couldn't save ${this.activeConfiguration}: ${refused}`);
      return false;
    }
    return true;
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
   * Manage…: the whole table in a grid, committed as one rewrite. The
   * columns are the rows this section lists — the definition's own
   * parameters — and the cells come from the source, so expressions stay.
   */
  private manageConfigurations(): Promise<void> {
    const commitTable = this.client.commitConfigurationTable;
    if (!commitTable || !this.configurations) {
      return Promise.resolve();
    }
    const getTable = this.client.getConfigurationTable;
    return this.openGrid({
      params: this.visibleParams(),
      configurations: this.configurations,
      ...(getTable ? { loadTable: () => getTable.call(this.client) } : {}),
      commit: async (commit) => this.landed(await commitTable.call(this.client, commit)),
      confirmDelete: (name) => this.confirmGridDelete(name),
    });
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
   * The dropdown's choice. Tweaks on the active row would be lost by the
   * switch (the session layer is cleared), so the user first chooses: save
   * them into the row, discard them, or stay — a cancel (or a save that
   * fails) puts the dropdown back.
   */
  private async pickConfiguration(select: HTMLSelectElement): Promise<void> {
    const name = select.value;
    const active = this.activeConfiguration;
    if (name === active) {
      return;
    }
    if (this.configurations?.modified) {
      const canSave = active !== DEFAULT_CONFIGURATION && typeof this.client.saveConfiguration === 'function';
      const choice = await this.chooseSwitch(active, name, canSave);
      if (choice === 'cancel' || (choice === 'save' && !await this.saveConfiguration())) {
        select.value = active;
        return;
      }
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
    menu.className = 'absolute right-0 top-full mt-1 z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
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
   */
  syncParts(): void {
    if (this.scope === 'assembly') {
      // The band is the configuration dropdown's here.
      this.syncConfigurations();
      if (this.addButton) this.addButton.hidden = false;
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

    this.partBar.hidden = choices.parts.length === 0;
    if (this.addButton) {
      this.addButton.hidden = choices.parts.length === 0;
    }
    if (choices.parts.length === 0) {
      this.partBar.replaceChildren();
      return;
    }
    const select = document.createElement('select');
    select.className = PART_SELECT_CLASS;
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

    // "Add to <part>" — the caption names what the dropdown decides, since the
    // + it answers sits in the header above rather than beside it.
    const caption = document.createElement('span');
    caption.className = 'shrink-0 text-sm text-base-content/60';
    caption.textContent = 'Add to';
    this.partBar.replaceChildren(caption, select);
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
    // With a row active: a label the row sets is bold, one it leaves out
    // says so — its value is the literal.
    const rowActive = this.rowActive;
    const optionsFor = (p: UIParamDefinition) => {
      if (!rowActive) {
        return rowOptions;
      }
      return p.configuredValue !== undefined
        ? { ...rowOptions, labelBold: true }
        : { ...rowOptions, labelTrailing: DEFAULT_HINT };
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
    bindParamHandlers(this.list, {
      lookup: (label) => this.currentParams.find(p => p.label === label),
      setValue: (label, value) => this.client.setParam(label, value),
      onEdit: (label) => {
        const def = this.currentParams.find(p => p.label === label);
        if (def) {
          this.editor?.openForEdit(def);
        }
      },
      debouncer: this.debouncer,
    });
    this.bindPropertyHandlers();
    bindParamGroups(this.list, this.collapsedGroups);
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
