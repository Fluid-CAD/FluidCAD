import { AccordionSection } from './accordion-section';
import { ICON_EYE, ICON_EYE_OFF } from './icons';
import { escapeHtml } from './expression-core';
import type { SerializedAssemblyConnector } from '../types';

export interface ConnectorsPanelOptions {
  /** A host that cannot edit source: rows are inert labels; the eye toggle stays. */
  readOnly?: boolean;
}

/**
 * The assembly rail's Connectors section: one row per assembly connector
 * (`connector('name', [x, y, z])` at the file's top level) with an eye
 * toggle for its gizmo; clicking a row opens the connector dialog on it.
 * Mounted between Parts and Joints in the PartsPanel's column.
 */
export class ConnectorsPanel {
  private section: AccordionSection;
  private connectors: SerializedAssemblyConnector[] = [];
  /** True while the mate dialog is picking: a row click is a pick, not an edit. */
  private pickMode = false;
  private readonly readOnly: boolean;

  constructor(
    host: HTMLElement,
    private hooks: {
      onEdit: (connector: SerializedAssemblyConnector) => void;
      onToggleVisibility: (name: string, visible: boolean) => void;
      isHidden: (name: string) => boolean;
    },
    options: ConnectorsPanelOptions = {},
  ) {
    this.readOnly = options.readOnly === true;
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
      count.textContent = connectors.length > 0 ? String(connectors.length) : '';
    }
    this.render();
  }

  /** Flip the rows between "edit this connector" and "pick as mate side". */
  setPickMode(pickMode: boolean): void {
    if (this.pickMode === pickMode) {
      return;
    }
    this.pickMode = pickMode;
    this.render();
  }

  dispose(): void {
    this.section.header.remove();
    this.section.body.remove();
  }

  private render(): void {
    const body = this.section.body;
    if (this.connectors.length === 0) {
      // A read-only host has no Connector tool to point at.
      body.innerHTML = AccordionSection.emptyState(
        this.readOnly ? 'No assembly connectors.' : 'No assembly connectors — add one with the Connector tool.',
      );
      return;
    }
    body.innerHTML = this.connectors.map((c) => {
      const hidden = this.hooks.isHidden(c.name);
      const eyeIcon = hidden ? ICON_EYE_OFF : ICON_EYE;
      const eyeVisibility = hidden
        ? 'opacity-100 text-base-content/70'
        : 'opacity-0 group-hover:opacity-100 text-base-content/40';
      const title = this.readOnly ? '' : this.pickMode ? 'Pick as the mate side' : 'Edit this connector';
      const pickClass = this.pickMode ? ' text-primary' : '';
      const rowCursor = this.readOnly ? 'cursor-default' : 'cursor-pointer';
      return `
      <div class="group flex items-center gap-2 px-3 py-1.5 ${rowCursor} hover:bg-base-content/[0.06] text-sm text-base-content/80${pickClass}" data-connector-id="${escapeHtml(c.connectorId)}" title="${title}">
        <img src="/icons/mate-connector.png" class="w-4 h-4 object-contain shrink-0 opacity-70" alt="" />
        <span class="truncate">${escapeHtml(c.name)}</span>
        <button class="ml-auto btn btn-ghost btn-square btn-xs ${eyeVisibility} hover:text-base-content/70 shrink-0 [&>svg]:size-3.5" data-eye="${escapeHtml(c.name)}" title="Show/hide the connector">${eyeIcon}</button>
      </div>`;
    }).join('');
    if (!this.readOnly) {
      body.querySelectorAll<HTMLElement>('[data-connector-id]').forEach((row) => {
        row.addEventListener('click', () => {
          const connector = this.connectors.find(c => c.connectorId === row.dataset.connectorId);
          if (connector) {
            this.hooks.onEdit(connector);
          }
        });
      });
    }
    body.querySelectorAll<HTMLButtonElement>('[data-eye]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const name = button.dataset.eye!;
        this.hooks.onToggleVisibility(name, this.hooks.isHidden(name));
        this.render();
      });
    });
  }
}
