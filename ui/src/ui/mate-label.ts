import { connectorLabel, type SerializedAssemblyMate } from '../types';

/** The two things a mate joins, named the way the parts panel names them. */
export type MateSideNames = { a: string; b: string };

/**
 * What a joint's row (or a relation's) leads with: `title`, its authored
 * `.name()` when it has one, else what kind of joint it is; and `kind`, the
 * kind again as secondary text when the title is the name — null otherwise.
 */
export type JointHeading = { title: string; kind: string | null };

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

  /**
   * `Revolute · base ↔ gear1`; a named mate leads with its name, its type
   * after it: `Left door (Revolute) · Carcass ↔ Left door`.
   */
  static describe(
    mate: SerializedAssemblyMate,
    instanceNames: ReadonlyMap<string, string>,
    worldConnectorNames: ReadonlyMap<string, string>,
  ): string {
    const sides = MateLabel.sides(mate, instanceNames, worldConnectorNames);
    const type = MateLabel.TYPE_LABELS[mate.type];
    const lead = MateLabel.nameOf(mate) !== null ? `${MateLabel.nameOf(mate)} (${type})` : type;
    return `${lead} · ${sides.a} ↔ ${sides.b}`;
  }

  /**
   * The rule every joint row follows, whoever wrote the statement (the
   * user's `mate().name('Hinge')`, a generator's `g.mate(…).name('Left
   * door')`): a named joint reads by its name, its kind beside it; an
   * unnamed one by its kind (`kind` as the row writes it: `revolute`,
   * `Gear × 2`).
   */
  static heading(name: string | undefined, kind: string): JointHeading {
    const trimmed = name?.trim() ?? '';
    return trimmed !== '' ? { title: trimmed, kind } : { title: kind, kind: null };
  }

  /** A mate's authored name, or null when it has none (absent or blank). */
  static nameOf(mate: Pick<SerializedAssemblyMate, 'name'>): string | null {
    const trimmed = mate.name?.trim() ?? '';
    return trimmed !== '' ? trimmed : null;
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
