import type { SourceSlotRef } from '../../api';
import type { SceneObjectRender } from '../../types';
import type { ConnectorPickDetail } from '../feature-dialog-registry';
import { ConnectorPickMenu } from '../assembly-mate/connector-pick-menu';
import { ConnectorOption, ConnectorOptions } from './connector-options';

/**
 * The connectors a part dialog picks — every axis slot takes one, standing
 * for its Z axis through its origin, and the copy's targets do too. One per
 * dialog: it collects the scene's connectors after each render (picks
 * re-match them by site), turns a gizmo click into its connector — through
 * the "which connector?" menu when several gizmos sit under the cursor — and
 * names the connector a timeline row or an edited statement's sources stand
 * for. The dialog decides which slot a connector lands in.
 */
export class ConnectorPicks {
  /** Why a gizmo has no connector a statement can name. */
  static readonly UNREFERENCEABLE =
    'That connector cannot be referenced — only connector() features and their copies can be picked.';

  private options: ConnectorOption[] = [];
  private readonly menu: ConnectorPickMenu;

  constructor(
    container: HTMLElement,
    private readonly viewer: { setHoveredConnector(connectorId: string | null): void },
  ) {
    this.menu = new ConnectorPickMenu(container);
  }

  /** Every connector the last collected scene carries, the copies included. */
  get all(): readonly ConnectorOption[] {
    return this.options;
  }

  /** The connectors a render left — what picks re-match against by site. */
  collect(sceneObjects: SceneObjectRender[]): readonly ConnectorOption[] {
    this.options = ConnectorOptions.collect(sceneObjects);
    return this.options;
  }

  /**
   * A gizmo click: its connector goes to `take` — after the menu asks which
   * one when several gizmos sit under the cursor. Answers the message to
   * show when the gizmo is no connector a statement can name, else null.
   */
  pick(connectorId: string, detail: ConnectorPickDetail | undefined, take: (option: ConnectorOption) => void): string | null {
    this.menu.close();
    const candidates = detail?.connectorCandidates;
    if (candidates && candidates.length > 1 && detail?.clientX !== undefined && detail.clientY !== undefined) {
      this.menu.show(detail.clientX, detail.clientY, candidates.map(candidate => ({
        label: ConnectorOptions.forId(candidate.connectorId, this.options)?.label ?? candidate.connectorId,
        onHover: () => this.viewer.setHoveredConnector(candidate.connectorId),
        onPick: () => {
          const option = ConnectorOptions.forId(candidate.connectorId, this.options);
          if (option) {
            take(option);
          }
        },
      })), () => this.viewer.setHoveredConnector(null));
      return null;
    }
    const option = ConnectorOptions.forId(connectorId, this.options);
    if (!option) {
      return ConnectorPicks.UNREFERENCEABLE;
    }
    take(option);
    return null;
  }

  /** The connector a timeline row stands for, when it is a connector row. */
  forRow(obj: SceneObjectRender): ConnectorOption | undefined {
    return obj.type === 'connector' && obj.id != null ? ConnectorOptions.forId(obj.id, this.options) : undefined;
  }

  /** The connector an edited statement's source names — an axis that is one. */
  forSource(slot: SourceSlotRef | null | undefined): ConnectorOption | null {
    if (slot?.kind !== 'connector') {
      return null;
    }
    return ConnectorOptions.forSite({ filePath: slot.filePath, line: slot.line, slot: slot.slot }, this.options) ?? null;
  }

  /** Close the menu — the dialog left, or the scene moved under it. */
  close(): void {
    this.menu.close();
  }
}
