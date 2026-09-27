import { gotoSource } from '../../api';
import { SceneIndex } from '../../helpers/scene-index';
import { ConnectorData, SceneObjectRender, connectorLabel } from '../../types';
import { PickSlotChip } from '../pick-slot';

/**
 * A connector a part dialog can reference: a `connector()` statement's own
 * connector, or one of the copies a `copy()` statement made of it
 * (`bolt.instance(3)`). Addressed by its {@link ConnectorSite} — the
 * declared connector's statement, plus the slot for a copy — because scene
 * ids change with every render and a copy has no statement of its own.
 */
export type ConnectorOption = {
  /** The connector row's scene id in this render — gizmo picks and highlights. */
  id: string;
  /** How code names it: `bolt`, or `bolt.instance(3)`. */
  label: string;
  /** The name its `connector()` statement registers. */
  name: string;
  /** A copy's pattern slot; undefined for a declared connector. */
  slot?: number;
  /** The `connector()` statement — the seed's, for a copy. */
  filePath: string;
  line: number;
  column: number;
  /**
   * The `copy()` statement already copying this connector, by its line —
   * one copy statement per connector, so it is never copied again.
   */
  copiedAt?: number;
};

/** Where code declares a connector: its statement (the seed's, for a copy), and a copy's slot. */
export type ConnectorSite = { filePath: string; line: number; slot?: number };

/**
 * The part-scene connectors a dialog can pick — the part dialogs' side of
 * the connector pick channel ({@link ConnectorGizmoPicker} finds the gizmo,
 * this names the connector behind it). One option per connector row, the
 * copies included, each re-found after a render by its site rather than
 * its id.
 */
export class ConnectorOptions {
  /**
   * Every connector the scene carries that code can name: declared
   * connectors by their own statement, copies by their seed's statement
   * and slot. A connector whose build failed (no frame, no name) or whose
   * statement the render didn't locate is left out.
   */
  static collect(sceneObjects: SceneObjectRender[]): ConnectorOption[] {
    const index = SceneIndex.of(sceneObjects);
    const options: ConnectorOption[] = [];
    for (const row of sceneObjects) {
      if (row.type !== 'connector' || row.id == null) {
        continue;
      }
      const data = row.object as ConnectorData | undefined;
      if (!data?.name || !data.origin) {
        continue;
      }
      const slot = data.copy?.slot;
      const statementRow = data.copy ? index.byId(data.copy.seedId) : row;
      const loc = statementRow?.sourceLocation;
      if (!loc) {
        continue;
      }
      const copiedAt = index.copyStatementOf(row.id)?.sourceLocation?.line;
      options.push({
        id: row.id,
        label: connectorLabel(data.name, slot),
        name: data.name,
        ...(slot !== undefined ? { slot } : {}),
        filePath: loc.filePath,
        line: loc.line,
        column: loc.column,
        ...(copiedAt !== undefined ? { copiedAt } : {}),
      });
    }
    return options;
  }

  /** The option a gizmo pick (a connector row's scene id) names. */
  static forId(id: string, options: readonly ConnectorOption[]): ConnectorOption | undefined {
    return options.find(option => option.id === id);
  }

  /** The option at a site — a declared connector's statement, or a copy's seed statement and slot. */
  static forSite(site: ConnectorSite, options: readonly ConnectorOption[]): ConnectorOption | undefined {
    return options.find(option => ConnectorOptions.sameSite(option, site));
  }

  /** The declared connector at a statement — what a timeline connector row or a kept target names. */
  static forLocation(
    loc: { filePath: string; line: number },
    options: readonly ConnectorOption[],
  ): ConnectorOption | undefined {
    return ConnectorOptions.forSite({ filePath: loc.filePath, line: loc.line }, options);
  }

  /** Whether two sites name the same connector. */
  static sameSite(a: ConnectorSite, b: ConnectorSite): boolean {
    return a.filePath === b.filePath && a.line === b.line && a.slot === b.slot;
  }

  /**
   * A connector's chip: how code names it, and its statement's line — the
   * seed's, for a copy — with the jump to it.
   */
  static chip(option: ConnectorOption, opts: { badge?: string; removable?: boolean } = {}): PickSlotChip {
    return {
      label: option.label,
      title: `Connector ${option.label}`,
      badge: opts.badge,
      removable: opts.removable,
      line: option.line,
      onGoto: () => gotoSource({ filePath: option.filePath, line: option.line, column: option.column }),
    };
  }
}
