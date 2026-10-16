import { connectorLabel, type SerializedAssemblyMate } from '../types';

/** The two things a mate joins, named the way the parts panel names them. */
export type MateSideNames = { a: string; b: string };

/**
 * How a mate is spoken of outside the joints panel's own rows — the
 * relation dialog's chips and the relation rows' sub-lines: the instance (or
 * assembly connector) on each side, and a one-line `revolute · base ↔ gear`
 * description.
 */
export class MateLabel {
  static readonly TYPE_LABELS: Record<SerializedAssemblyMate['type'], string> = {
    'fastened': 'Fastened',
    'revolute': 'Revolute',
    'slider': 'Slider',
    'cylindrical': 'Cylindrical',
    'planar': 'Planar',
    'parallel': 'Parallel',
    'pin-slot': 'Pin-slot',
    'tangent': 'Tangent',
  };

  /**
   * The instance name (or assembly connector label) of each side. Unknown
   * ids read as `?` — a side that no longer resolves still gets a row.
   */
  static sides(
    mate: SerializedAssemblyMate,
    instanceNames: ReadonlyMap<string, string>,
    worldConnectorNames: ReadonlyMap<string, string>,
  ): MateSideNames {
    const name = (
      conn: { instanceId: string } | undefined,
      geo: { instanceId: string } | undefined,
      frame: { connectorId: string } | undefined,
    ): string => {
      if (frame) {
        return worldConnectorNames.get(frame.connectorId) ?? '?';
      }
      const id = conn?.instanceId ?? geo?.instanceId;
      return (id !== undefined ? instanceNames.get(id) : undefined) ?? '?';
    };
    return {
      a: name(mate.connectorA, mate.geometryA, mate.frameA),
      b: name(mate.connectorB, mate.geometryB, mate.frameB),
    };
  }

  /** `Revolute · base ↔ gear1` */
  static describe(
    mate: SerializedAssemblyMate,
    instanceNames: ReadonlyMap<string, string>,
    worldConnectorNames: ReadonlyMap<string, string>,
  ): string {
    const sides = MateLabel.sides(mate, instanceNames, worldConnectorNames);
    return `${MateLabel.TYPE_LABELS[mate.type]} · ${sides.a} ↔ ${sides.b}`;
  }

  /** Assembly connectors by scene id, labelled the way code names them (a copy as `bay.instance(2)`). */
  static worldConnectorNames(
    connectors: ReadonlyArray<{ connectorId: string; name: string; copy?: { slot: number } }>,
  ): Map<string, string> {
    return new Map(connectors.map(c => [c.connectorId, connectorLabel(c.name, c.copy?.slot)]));
  }

  /**
   * The statement stand-in the relation preview row shows for a mate: its
   * authored `.name()` when it has one, else `<type>@<line>` — the server
   * writes the real binding.
   */
  static standIn(mate: SerializedAssemblyMate): string {
    if (mate.name) {
      return mate.name;
    }
    return mate.sourceLocation ? `${mate.type}@${mate.sourceLocation.line}` : mate.mateId;
  }
}
