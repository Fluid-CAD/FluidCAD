// The Hole dialog's placement list: where each hole starts, as the user
// picked it (a connector gizmo or row, a sketch vertex dot, a face/edge
// anchor suggestion) or as the edited statement already names it (a kept
// argument). Each entry knows the world frame the ghost draws from and the
// request reference the server resolves it with.

import type {
  ApplyFeatureEntity, HoleEditPlacementRef, HolePlacementRef, ParsedFeatureStatement, SourceSlotRef,
} from '../../../api';
import type { SceneObjectRender, SourceLocation, Vec3Data } from '../../../types';
import type { SelectedEntity } from '../../../viewer';
import { SceneIndex } from '../../../helpers/scene-index';
import type { PickSlotChip } from '../../pick-slot';
import { ConnectorOptions, type ConnectorOption } from '../connector-options';
import { anchorChipLabel, type LockedAnchor } from '../anchor-suggestions';
import { gotoSource } from '../../../api';

/** A placement's world frame: the point the hole starts from and the outward normal. */
export type PlacementFrame = { origin: Vec3Data; normal: Vec3Data };

export type HolePlacementItem =
  | {
    kind: 'connector';
    option: ConnectorOption;
    frame: PlacementFrame;
    /** Edit mode: the statement argument this chip stands for, when it came from a kept argument. */
    sourceIndex?: number;
  }
  | {
    kind: 'vertex';
    entity: SelectedEntity & { sub: { type: 'vertex' } };
    label: string;
    frame: PlacementFrame;
  }
  | { kind: 'anchor'; locked: LockedAnchor; name: string; frame: PlacementFrame }
  | {
    kind: 'keep';
    sourceIndex: number;
    label: string;
    loc?: SourceLocation;
    /** Where the statement's own build placed this argument; absent when that build placed nothing. */
    frame?: PlacementFrame;
  };

const WORLD_Z: Vec3Data = { x: 0, y: 0, z: 1 };

/**
 * The frames an applied hole's build cut at, in argument order — its render
 * row's serialized `frames` (a rollback render still carries them for the
 * rows past its stop). Empty when the build failed before placing anything.
 */
export function builtHoleFrames(row: SceneObjectRender | undefined): PlacementFrame[] {
  type Built = { origin: [number, number, number]; normal: [number, number, number] };
  const frames = (row?.object as { frames?: Built[] } | undefined)?.frames ?? [];
  return frames.map(({ origin: [ox, oy, oz], normal: [nx, ny, nz] }) => ({
    origin: { x: ox, y: oy, z: oz },
    normal: { x: nx, y: ny, z: nz },
  }));
}

/** What a picked sketch dot stands for, read off the scene rows around its shape. */
function vertexLabel(shapeId: string, sceneObjects: SceneObjectRender[]): string {
  const owner = sceneObjects.find(row => row.sceneShapes?.some(shape => shape.shapeId === shapeId));
  if (!owner) {
    return 'Vertex';
  }
  const index = SceneIndex.of(sceneObjects);
  const sketch = index.enclosing(owner, 'sketch');
  const shape = owner.sceneShapes.find(part => part.shapeId === shapeId);
  const entity = owner.type ? owner.type.charAt(0).toUpperCase() + owner.type.slice(1) : 'Entity';
  const role = (owner.type as string) === 'point'
    ? 'point'
    : shape?.isMetaShape && shape.shapeType === 'vertex' ? 'centre' : 'vertex';
  const where = sketch?.sourceLocation ? ` · sketch line ${sketch.sourceLocation.line}` : '';
  return `${entity} ${role}${where}`;
}

/**
 * The outward normal at a picked vertex: the owning sketch's plane normal
 * (the hole enters the sketched face), or world Z for a vertex on a solid.
 */
function vertexNormal(shapeId: string, sceneObjects: SceneObjectRender[]): Vec3Data {
  const owner = sceneObjects.find(row => row.sceneShapes?.some(shape => shape.shapeId === shapeId));
  if (!owner) {
    return WORLD_Z;
  }
  const sketch = SceneIndex.of(sceneObjects).enclosing(owner, 'sketch');
  const normal = sketch?.object?.plane?.normal as Vec3Data | undefined;
  return normal ?? WORLD_Z;
}

function connectorFrame(row: SceneObjectRender | undefined): PlacementFrame | null {
  const data = row?.object as { origin?: Vec3Data; normal?: Vec3Data } | undefined;
  if (!data?.origin || !data.normal) {
    return null;
  }
  return { origin: data.origin, normal: data.normal };
}

export class HolePlacements {
  private items: HolePlacementItem[] = [];
  private connectorOptions: ConnectorOption[] = [];
  private sceneObjects: SceneObjectRender[] = [];

  get entries(): readonly HolePlacementItem[] {
    return this.items;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * A fresh render: connectors re-match by their statement (ids die with
   * the render), kept arguments survive as text, and picked vertices and
   * anchors — shape ids and cached frames of the old scene — are dropped.
   * With `resolveKeeps` (the edit session's rollback boundary) a kept
   * argument naming a connector statement becomes that connector's entry,
   * and every other kept argument takes its frame from `builtFrames` (the
   * edited statement's own, {@link builtHoleFrames}) for the ghost.
   */
  setScene(
    sceneObjects: SceneObjectRender[],
    opts: { resolveKeeps?: boolean; builtFrames?: readonly PlacementFrame[] } = {},
  ): { dropped: number } {
    this.sceneObjects = sceneObjects;
    this.connectorOptions = ConnectorOptions.collect(sceneObjects);
    let dropped = 0;
    this.items = this.items.flatMap((item): HolePlacementItem[] => {
      if (item.kind === 'keep') {
        if (!opts.resolveKeeps) {
          return [item];
        }
        const option = item.loc ? ConnectorOptions.forLocation(item.loc, this.connectorOptions) : undefined;
        const frame = option ? this.frameOf(option) : null;
        if (option && frame) {
          return [{ kind: 'connector', option, frame, sourceIndex: item.sourceIndex }];
        }
        return [{ ...item, frame: opts.builtFrames?.[item.sourceIndex] }];
      }
      if (item.kind === 'connector') {
        const option = ConnectorOptions.forSite(item.option, this.connectorOptions);
        const frame = option ? this.frameOf(option) : null;
        if (option && frame) {
          return [{ kind: 'connector', option, frame, sourceIndex: item.sourceIndex }];
        }
        dropped++;
        return [];
      }
      dropped++;
      return [];
    });
    return { dropped };
  }

  /** The connector options the scene offers (gizmo picks and timeline rows resolve against them). */
  get options(): readonly ConnectorOption[] {
    return this.connectorOptions;
  }

  /** Toggle a connector: picking one already listed takes it back off. */
  toggleConnector(option: ConnectorOption): boolean {
    const index = this.items.findIndex(item => item.kind === 'connector' && item.option.id === option.id);
    if (index >= 0) {
      this.items.splice(index, 1);
      return false;
    }
    const frame = this.frameOf(option);
    if (!frame) {
      return false;
    }
    this.items.push({ kind: 'connector', option, frame });
    return true;
  }

  /** Toggle a picked vertex dot. */
  toggleVertex(entity: SelectedEntity & { sub: { type: 'vertex' } }): boolean {
    const index = this.items.findIndex(item => item.kind === 'vertex'
      && item.entity.shapeId === entity.shapeId && item.entity.sub.index === entity.sub.index);
    if (index >= 0) {
      this.items.splice(index, 1);
      return false;
    }
    const position = entity.sub.position;
    if (!position) {
      return false;
    }
    this.items.push({
      kind: 'vertex',
      entity,
      label: vertexLabel(entity.shapeId, this.sceneObjects),
      frame: { origin: position, normal: vertexNormal(entity.shapeId, this.sceneObjects) },
    });
    return true;
  }

  /** Add a locked anchor suggestion; the same anchor picked again takes it back off. */
  toggleAnchor(locked: LockedAnchor): boolean {
    const index = this.items.findIndex(item => item.kind === 'anchor'
      && item.locked.key === locked.key && item.locked.anchorIndex === locked.anchorIndex);
    if (index >= 0) {
      this.items.splice(index, 1);
      return false;
    }
    const anchor = locked.anchors[locked.anchorIndex];
    this.items.push({
      kind: 'anchor',
      locked,
      name: this.freeAnchorName(),
      frame: { origin: anchor.frame.origin, normal: anchor.frame.normal },
    });
    return true;
  }

  /** An anchor already listed — the suggestion rail draws no faint twin under it. */
  hasAnchor(key: string, anchorIndex: number): boolean {
    return this.items.some(item => item.kind === 'anchor'
      && item.locked.key === key && item.locked.anchorIndex === anchorIndex);
  }

  removeAt(index: number): void {
    this.items.splice(index, 1);
  }

  clear(): void {
    this.items = [];
  }

  /** Edit mode: one kept entry per statement argument, in argument order. */
  seedKeeps(parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }>, targetFilePath: string): void {
    this.items = parsed.placementTexts.map((label, sourceIndex) => {
      const ref = parsed.placementRefs[sourceIndex];
      return {
        kind: 'keep' as const,
        sourceIndex,
        label,
        loc: ref ? { filePath: targetFilePath, line: ref.line, column: ref.column } : undefined,
      };
    });
  }

  /**
   * The statement's resolved sources (edit mode): a kept argument the
   * sources query placed on a connector statement becomes that connector's
   * entry once the scene offers it.
   */
  resolveSources(sources: SourceSlotRef[]): void {
    this.items = this.items.map((item): HolePlacementItem => {
      if (item.kind !== 'keep' || item.loc) {
        return item;
      }
      const slot = sources[item.sourceIndex];
      if (slot?.kind !== 'sketch') {
        return item;
      }
      const option = ConnectorOptions.forLocation(slot, this.connectorOptions);
      const frame = option ? this.frameOf(option) : null;
      return option && frame ? { kind: 'connector', option, frame, sourceIndex: item.sourceIndex } : { ...item, loc: slot };
    });
  }

  chips(): PickSlotChip[] {
    return this.items.map(item => {
      if (item.kind === 'connector') {
        const option = item.option;
        return {
          label: `Connector ${option.label}`,
          removable: true,
          line: option.line,
          onGoto: () => gotoSource({ filePath: option.filePath, line: option.line, column: option.column }),
        };
      }
      if (item.kind === 'vertex') {
        return { label: item.label, removable: true };
      }
      if (item.kind === 'anchor') {
        const anchor = item.locked.anchors[item.locked.anchorIndex];
        const expression = `${item.locked.args}${anchor.suffix}`;
        // Outside a part the hole takes the anchor expression itself — no connector is made.
        if (!item.locked.inPart) {
          return { label: anchorChipLabel(item.locked.entity, anchor), removable: true, title: expression };
        }
        return {
          label: `${anchorChipLabel(item.locked.entity, anchor)} (new connector ${item.name})`,
          removable: true,
          title: `${expression} — a connector named ${item.name} is created here`,
        };
      }
      return { label: `Current: ${item.label}`, removable: true };
    });
  }

  /**
   * The world frames the ghost draws the tools at — null while a kept
   * argument has none (before the boundary render, or its build failed):
   * a ghost missing a hole would misstate the edit.
   */
  frames(): PlacementFrame[] | null {
    const frames: PlacementFrame[] = [];
    for (const item of this.items) {
      if (!item.frame) {
        return null;
      }
      frames.push(item.frame);
    }
    return frames;
  }

  /** Listed connectors, by scene id — the viewport draws them enlarged. */
  connectorIds(): string[] {
    return this.items.flatMap(item => item.kind === 'connector' ? [item.option.id] : []);
  }

  /** Listed vertex picks — the viewport keeps their dots drawn as selected. */
  vertexEntities(): SelectedEntity[] {
    return this.items.flatMap(item => item.kind === 'vertex' ? [item.entity] : []);
  }

  /** Listed anchors' faces/edges — highlighted like any picked entity. */
  anchorEntities(): SelectedEntity[] {
    return this.items.flatMap(item => item.kind === 'anchor'
      ? [{ shapeId: item.locked.entity.shapeId, sub: item.locked.entity.sub as SelectedEntity['sub'] }]
      : []);
  }

  /** The create request's placements — every entry is a pick. */
  createRefs(): HolePlacementRef[] {
    return this.items.flatMap(item => {
      const ref = this.pickRef(item);
      return ref ? [ref] : [];
    });
  }

  /** The edit request's full replacement list: kept arguments by position mixed with picks. */
  editRefs(): HoleEditPlacementRef[] {
    return this.items.map(item => item.kind === 'keep'
      ? { kind: 'verbatim' as const, sourceIndex: item.sourceIndex }
      : this.pickRef(item)!);
  }

  /**
   * True while every entry is the statement's own argument, untouched and in
   * order — a kept argument resolved into its connector chip included.
   */
  unchangedKeeps(originalCount: number): boolean {
    return this.items.length === originalCount
      && this.items.every((item, index) =>
        (item.kind === 'keep' || item.kind === 'connector') && item.sourceIndex === index);
  }

  private pickRef(item: HolePlacementItem): HolePlacementRef | null {
    if (item.kind === 'connector') {
      return { kind: 'connector', filePath: item.option.filePath, line: item.option.line, column: item.option.column };
    }
    if (item.kind === 'vertex') {
      const entity: ApplyFeatureEntity = {
        shapeId: item.entity.shapeId,
        sub: { type: 'vertex', index: item.entity.sub.index },
      };
      return { kind: 'vertex', entity };
    }
    if (item.kind === 'anchor') {
      const anchor = item.locked.anchors[item.locked.anchorIndex];
      return { kind: 'anchor', entity: item.locked.entity, anchor: anchor.anchor, name: item.name };
    }
    return null;
  }

  private frameOf(option: ConnectorOption): PlacementFrame | null {
    return connectorFrame(SceneIndex.of(this.sceneObjects).byId(option.id));
  }

  /** `h1`, `h2`, … — free among the scene's connectors and the anchors already listed. */
  private freeAnchorName(): string {
    const taken = new Set<string>([
      ...this.connectorOptions.map(option => option.name),
      ...this.items.flatMap(item => item.kind === 'anchor' ? [item.name] : []),
    ]);
    let n = 1;
    while (taken.has(`h${n}`)) {
      n++;
    }
    return `h${n}`;
  }
}
