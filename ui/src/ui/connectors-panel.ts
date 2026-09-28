import { AccordionSection } from './accordion-section';
import {
  ICON_CHEVRON_RIGHT, ICON_CODE, ICON_COPY, ICON_DOTS_VERTICAL, ICON_EYE, ICON_EYE_OFF, ICON_PENCIL, ICON_TRASH,
} from './icons';
import { escapeHtml } from './expression-core';
import { connectorLabel, type SerializedAssemblyConnector } from '../types';

export interface ConnectorsPanelOptions {
  /** A host that cannot edit source: rows are inert labels; the eye toggle stays. */
  readOnly?: boolean;
}

/**
 * What the rail hands back to the page. Everything but the eye toggle and
 * a pick edits source, so a read-only host wires those alone.
 */
export type ConnectorsPanelHooks = {
  /** A declared connector's row: open the connector dialog on it. */
  onEdit: (connector: SerializedAssemblyConnector) => void;
  /** A copy's row: open the Copy dialog on the `copy()` statement that made it. */
  onEditCopy?: (copy: SerializedAssemblyConnector) => void;
  /** Any row while a dialog is picking ({@link ConnectorsPanel.setPickMode}); `onEdit` when absent. */
  onPick?: (connector: SerializedAssemblyConnector) => void;
  /** The eye toggle, keyed by label: `bay`, or `bay.instance(2)` for a copy. */
  onToggleVisibility: (label: string, visible: boolean) => void;
  isHidden: (label: string) => boolean;
  /** A declared connector's "Copy…": the Copy dialog with it as the target. */
  onCopy?: (connector: SerializedAssemblyConnector) => void;
  /** "Show in source": a connector's `connector()` statement, a copy's `copy()` statement. */
  onShowInSource?: (connector: SerializedAssemblyConnector) => void;
  /** A declared connector's "Delete": its statement, and everything naming it. */
  onDelete?: (connector: SerializedAssemblyConnector) => void;
  /** A copy's "Remove copies": its `copy()` statement, and everything on the copies. */
  onRemoveCopies?: (copy: SerializedAssemblyConnector) => void;
};

/** One declared connector and the copies a top-level `copy()` made of it, in slot order. */
type ConnectorFamilyRows = {
  seed: SerializedAssemblyConnector;
  copies: SerializedAssemblyConnector[];
};

/**
 * The assembly rail's Connectors section: one row per assembly connector
 * (`connector('name', [x, y, z])` at the file's top level) with an eye
 * toggle for its gizmo; clicking a row opens the connector dialog on it.
 * Mounted between Parts and Joints in the PartsPanel's column.
 *
 * A connector a `copy()` copies heads its family: its row carries the
 * family's count and a chevron that folds out one row per copy, labelled
 * `instance(1)`, … the way code addresses it. A copy's row edits the copy
 * statement that made it — a copy has no statement of its own — and each
 * row's eye hides its own gizmo, keyed by label; the seed's eye hides the
 * whole family. While a dialog picks connectors every row is a pick. The
 * ⋮ menu (and right-click) offers Show in source, Copy… (or Edit copy…
 * once one exists — one copy statement per connector) and Delete on a
 * connector; Show in source, Edit copy… and Remove copies on a copy.
 */
export class ConnectorsPanel {
  private section: AccordionSection;
  private connectors: SerializedAssemblyConnector[] = [];
  /** True while a dialog is picking: a row click is a pick, not an edit. */
  private pickMode = false;
  /** What a row's tooltip says a pick does while {@link pickMode} is on. */
  private pickHint = 'Pick as the mate side';
  /** Families folded out, by their seed's name (names survive the per-render id re-mint). */
  private expanded = new Set<string>();
  private readonly readOnly: boolean;
  private activeDropdown: HTMLDivElement | null = null;
  private dropdownCleanup: (() => void) | null = null;

  constructor(
    private host: HTMLElement,
    private hooks: ConnectorsPanelHooks,
    options: ConnectorsPanelOptions = {},
  ) {
    this.readOnly = options.readOnly === true;
    // Row menus are positioned from coordinates measured against the host.
    host.classList.add('relative');
    this.section = new AccordionSection('Connectors', {
      trailing: '<span data-ref="count" class="text-xs text-base-content/40 tabular-nums"></span>',
    });
    this.section.mount(host);
    this.render();
  }

  update(connectors: SerializedAssemblyConnector[]): void {
    this.connectors = connectors;
    const count = this.section.header.querySelector<HTMLSpanElement>('[data-ref="count"]');
    if (count) {
      // Every frame a mate can take, the copies included.
      count.textContent = connectors.length > 0 ? String(connectors.length) : '';
    }
    this.render();
  }

  /**
   * Flip the rows between "edit this connector" and "pick it" — a dialog
   * picking connectors (the mate, replicate or copy dialog) takes a row
   * click as a pick, which `hint` names in the row's tooltip.
   */
  setPickMode(pickMode: boolean, hint = 'Pick as the mate side'): void {
    if (this.pickMode === pickMode && this.pickHint === hint) {
      return;
    }
    this.pickMode = pickMode;
    this.pickHint = hint;
    this.render();
  }

  dispose(): void {
    this.closeDropdown();
    this.section.header.remove();
    this.section.body.remove();
  }

  /**
   * The connectors as families: each declared connector with the copies
   * made of it, in slot order. A copy whose seed is not listed (its build
   * failed) stands on its own row.
   */
  static families(connectors: readonly SerializedAssemblyConnector[]): ConnectorFamilyRows[] {
    const families = new Map<string, ConnectorFamilyRows>();
    for (const connector of connectors) {
      if (!connector.copy) {
        families.set(connector.connectorId, { seed: connector, copies: [] });
      }
    }
    const orphans: ConnectorFamilyRows[] = [];
    for (const connector of connectors) {
      if (!connector.copy) {
        continue;
      }
      const family = families.get(connector.copy.seedId);
      if (family) {
        family.copies.push(connector);
      } else {
        orphans.push({ seed: connector, copies: [] });
      }
    }
    for (const family of families.values()) {
      family.copies.sort((a, b) => a.copy!.slot - b.copy!.slot);
    }
    return [...families.values(), ...orphans];
  }

  private static labelOf(connector: SerializedAssemblyConnector): string {
    return connectorLabel(connector.name, connector.copy?.slot);
  }

  private render(): void {
    this.closeDropdown();
    const body = this.section.body;
    if (this.connectors.length === 0) {
      // A read-only host has no Connector tool to point at.
      body.innerHTML = AccordionSection.emptyState(
        this.readOnly ? 'No assembly connectors.' : 'No assembly connectors — add one with the Connector tool.',
      );
      return;
    }
    body.innerHTML = ConnectorsPanel.families(this.connectors).map(family => this.familyHtml(family)).join('');
    this.bindRows(body);
  }

  private familyHtml(family: ConnectorFamilyRows): string {
    if (family.copies.length === 0) {
      return this.rowHtml(family.seed, { kind: 'plain' });
    }
    const expanded = this.expanded.has(family.seed.name);
    const head = this.rowHtml(family.seed, { kind: 'seed', expanded, count: family.copies.length + 1 });
    return expanded ? head + family.copies.map(copy => this.rowHtml(copy, { kind: 'copy' })).join('') : head;
  }

  private rowHtml(
    connector: SerializedAssemblyConnector,
    row: { kind: 'plain' | 'copy' } | { kind: 'seed'; expanded: boolean; count: number },
  ): string {
    const label = ConnectorsPanel.labelOf(connector);
    const hidden = this.hooks.isHidden(label);
    const eyeIcon = hidden ? ICON_EYE_OFF : ICON_EYE;
    const eyeVisibility = hidden
      ? 'opacity-100 text-base-content/70'
      : 'opacity-0 group-hover:opacity-100 text-base-content/40';
    const isCopy = connector.copy !== undefined;
    const title = this.readOnly ? ''
      : this.pickMode ? this.pickHint
      : isCopy ? `Edit the copy that makes ${label}`
      : 'Edit this connector';
    const pickClass = this.pickMode ? ' text-primary' : '';
    const rowCursor = this.readOnly ? 'cursor-default' : 'cursor-pointer';
    // A copy row reads as the family's own numbering; an orphan copy keeps its whole label.
    const text = row.kind === 'copy' ? `instance(${connector.copy!.slot})` : label;
    const padding = row.kind === 'copy' ? 'pl-10 pr-3' : row.kind === 'seed' ? 'pl-1.5 pr-3' : 'px-3';
    const chevron = row.kind === 'seed'
      ? `<button class="flex items-center justify-center w-4 h-4 shrink-0 opacity-50 hover:opacity-100 transition-transform${row.expanded ? ' rotate-90' : ''}" data-chevron="${escapeHtml(connector.name)}" title="${row.expanded ? 'Hide' : 'Show'} its copies">${ICON_CHEVRON_RIGHT}</button>`
      : '';
    const count = row.kind === 'seed'
      ? `<span class="text-xs text-base-content/40 tabular-nums shrink-0" data-family-count title="${escapeHtml(label)} and its ${row.count - 1} copies">${row.count}</span>`
      : '';
    const dots = this.readOnly
      ? ''
      : `<button class="opacity-0 group-hover:opacity-100 btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/70 shrink-0" data-dots="${escapeHtml(connector.connectorId)}">${ICON_DOTS_VERTICAL}</button>`;
    return `
      <div class="group flex items-center gap-2 ${padding} py-1.5 ${rowCursor} hover:bg-base-content/[0.06] text-sm text-base-content/80${pickClass}" data-connector-id="${escapeHtml(connector.connectorId)}" data-row="${row.kind}" title="${escapeHtml(title)}">
        ${chevron}
        <img src="/icons/mate-connector.png" class="w-4 h-4 object-contain shrink-0 opacity-70" alt="" />
        <span class="truncate">${escapeHtml(text)}</span>
        ${count}
        <button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${escapeHtml(label)}" title="${row.kind === 'seed' ? 'Show/hide the connector and its copies' : 'Show/hide the connector'}">${eyeIcon}</button>
        ${dots}
      </div>`;
  }

  private bindRows(body: HTMLElement): void {
    body.querySelectorAll<HTMLElement>('[data-connector-id]').forEach((row) => {
      const connector = this.connectors.find(c => c.connectorId === row.dataset.connectorId);
      if (!connector) {
        return;
      }
      if (!this.readOnly) {
        row.addEventListener('click', (event) => {
          if ((event.target as HTMLElement).closest('[data-eye], [data-chevron], [data-dots]')) {
            return;
          }
          this.activate(connector);
        });
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          const hostRect = this.host.getBoundingClientRect();
          this.showDropdown(connector, { top: event.clientY - hostRect.top, left: event.clientX - hostRect.left });
        });
      }
    });
    body.querySelectorAll<HTMLButtonElement>('[data-chevron]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const name = button.dataset.chevron!;
        if (this.expanded.has(name)) {
          this.expanded.delete(name);
        } else {
          this.expanded.add(name);
        }
        this.render();
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-eye]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const label = button.dataset.eye!;
        const row = button.closest<HTMLElement>('[data-connector-id]');
        this.toggleVisibility(label, row?.dataset.row === 'seed' ? row.dataset.connectorId! : null);
        this.render();
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-dots]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const connector = this.connectors.find(c => c.connectorId === button.dataset.dots);
        if (!connector) {
          return;
        }
        const rect = button.getBoundingClientRect();
        const hostRect = this.host.getBoundingClientRect();
        this.showDropdown(connector, { top: rect.bottom - hostRect.top + 2, left: rect.left - hostRect.left - 140 }, button);
      });
    });
  }

  /** A row click: a pick while a dialog picks, else the connector's editor — a copy's is its copy statement's. */
  private activate(connector: SerializedAssemblyConnector): void {
    if (this.pickMode) {
      (this.hooks.onPick ?? this.hooks.onEdit)(connector);
      return;
    }
    if (connector.copy) {
      this.hooks.onEditCopy?.(connector);
      return;
    }
    this.hooks.onEdit(connector);
  }

  /**
   * The eye on one row — its own gizmo, by label; on a family's head row,
   * the whole family follows the seed.
   */
  private toggleVisibility(label: string, familySeedId: string | null): void {
    const show = this.hooks.isHidden(label);
    const labels = [label];
    if (familySeedId !== null) {
      for (const connector of this.connectors) {
        if (connector.copy?.seedId === familySeedId) {
          labels.push(ConnectorsPanel.labelOf(connector));
        }
      }
    }
    for (const each of labels) {
      this.hooks.onToggleVisibility(each, show);
    }
  }

  /** The copies of a declared connector — a copy statement already copies it when there are any. */
  private copiesOf(connector: SerializedAssemblyConnector): SerializedAssemblyConnector[] {
    return this.connectors.filter(c => c.copy?.seedId === connector.connectorId);
  }

  private showDropdown(
    connector: SerializedAssemblyConnector,
    position: { top: number; left: number },
    anchor?: HTMLElement,
  ): void {
    this.closeDropdown();
    if (this.readOnly) {
      return;
    }
    const dropdown = document.createElement('div');
    dropdown.className = 'absolute z-[200] panel-bg border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)]';
    dropdown.style.top = `${position.top}px`;
    dropdown.style.left = `${position.left}px`;
    const actions = connector.copy ? this.copyActions(connector) : this.connectorActions(connector);
    dropdown.innerHTML = `<ul class="menu menu-xs p-1 min-w-[160px]">${actions.map(a => ConnectorsPanel.menuItem(a)).join('')}</ul>`;
    for (const action of actions) {
      dropdown.querySelector(`[data-action="${action.id}"]`)?.addEventListener('click', () => {
        this.closeDropdown();
        action.run();
      });
    }
    this.host.appendChild(dropdown);
    this.activeDropdown = dropdown;

    const onClickOutside = (event: MouseEvent) => {
      if (!dropdown.contains(event.target as Node) && !anchor?.contains(event.target as Node)) {
        this.closeDropdown();
      }
    };
    // A right-click elsewhere dismisses too — a row's own contextmenu handler
    // runs first (and re-opens the menu there), so a fresh menu survives it.
    setTimeout(() => {
      document.addEventListener('click', onClickOutside);
      document.addEventListener('contextmenu', onClickOutside);
    }, 0);
    this.dropdownCleanup = () => {
      document.removeEventListener('click', onClickOutside);
      document.removeEventListener('contextmenu', onClickOutside);
    };
  }

  /** A declared connector's menu: its statement, its copy statement (new, or the one there is), deletion. */
  private connectorActions(connector: SerializedAssemblyConnector): MenuAction[] {
    const actions: MenuAction[] = [];
    if (this.hooks.onShowInSource) {
      actions.push({ id: 'show-in-source', icon: ICON_CODE, label: 'Show in source', run: () => this.hooks.onShowInSource!(connector) });
    }
    const [copy] = this.copiesOf(connector);
    if (copy && this.hooks.onEditCopy) {
      actions.push({ id: 'edit-copy', icon: ICON_PENCIL, label: 'Edit copy…', run: () => this.hooks.onEditCopy!(copy) });
    } else if (!copy && this.hooks.onCopy) {
      actions.push({ id: 'copy', icon: ICON_COPY, label: 'Copy…', run: () => this.hooks.onCopy!(connector) });
    }
    if (this.hooks.onDelete) {
      actions.push({ id: 'delete', icon: ICON_TRASH, label: 'Delete', danger: true, run: () => this.hooks.onDelete!(connector) });
    }
    return actions;
  }

  /** A copy's menu: its copy statement — shown, edited, or removed with every copy it made. */
  private copyActions(copy: SerializedAssemblyConnector): MenuAction[] {
    const actions: MenuAction[] = [];
    if (this.hooks.onShowInSource) {
      actions.push({ id: 'show-in-source', icon: ICON_CODE, label: 'Show in source', run: () => this.hooks.onShowInSource!(copy) });
    }
    if (this.hooks.onEditCopy) {
      actions.push({ id: 'edit-copy', icon: ICON_PENCIL, label: 'Edit copy…', run: () => this.hooks.onEditCopy!(copy) });
    }
    if (this.hooks.onRemoveCopies) {
      actions.push({ id: 'remove-copies', icon: ICON_TRASH, label: 'Remove copies', danger: true, run: () => this.hooks.onRemoveCopies!(copy) });
    }
    return actions;
  }

  /** One icon + label menu row, matching the parts panel's. */
  private static menuItem(action: MenuAction): string {
    return `<li><button data-action="${action.id}" class="flex items-center gap-2${action.danger ? ' text-error' : ''}">`
      + `<span class="flex items-center justify-center w-4 h-4 shrink-0 [&>svg]:size-3.5">${action.icon}</span>`
      + `<span>${action.label}</span>`
      + `</button></li>`;
  }

  private closeDropdown(): void {
    if (this.activeDropdown) {
      this.activeDropdown.remove();
      this.activeDropdown = null;
    }
    if (this.dropdownCleanup) {
      this.dropdownCleanup();
      this.dropdownCleanup = null;
    }
  }
}

/** One row of a connector's ⋮ menu. */
type MenuAction = { id: string; icon: string; label: string; danger?: boolean; run: () => void };
