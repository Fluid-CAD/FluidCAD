import type { SceneObject } from "../common/scene-object.js";
import type { Shape } from "../common/shape.js";
import { Edge } from "../common/edge.js";
import { Wire } from "../common/wire.js";
import { BuildError } from "../common/build-error.js";
import { WireOps } from "../oc/wire-ops.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import { getActiveUnit } from "../units/registry.js";
import { UNIT_DISPLAY_DECIMALS } from "../units/units.js";

/** What a curve-like argument can be: one object, or several read as one. */
export type CurveSource = SceneObject | readonly SceneObject[];

/**
 * The reader of every curve-like argument — a sweep path, a loft guide, the
 * curves a curve or surface tool acts on. One place decides what an object
 * stands for as a curve, in what order its edges come, and how they chain:
 *
 * - a sketch: its edges, construction geometry left out;
 * - a sketch statement, a curve object (a helix), an edge selection: its edges;
 * - a face selection, a solid or a surface: refused — the edges meant are
 *   never all of them, so the user is asked to pick them.
 *
 * Edges come in statement order — the owning objects' order, then each
 * edge's place among its owner's edges — so indices and chain directions
 * follow what was drawn first, not the kernel's walk.
 */
export class CurveOperand {
  /** The model edges the argument stands for, in statement order. */
  static edges(source: CurveSource, label: string): Edge[] {
    const owners = new Map<Edge, SceneObject>();
    for (const obj of CurveOperand.objectsOf(source)) {
      CurveOperand.collect(obj, label, owners);
    }
    if (owners.size === 0) {
      throw new BuildError(
        `${label} has no edges to build a curve from.`,
        `Pass a sketch, a curve or a selection of edges.`,
      );
    }
    return CurveOperand.statementOrder(owners);
  }

  /** The argument's edges chained into wires: one wire per connected chain, chains in statement order. */
  static wires(source: CurveSource, label: string): Wire[] {
    return CurveOperand.chain(CurveOperand.edges(source, label));
  }

  /** Exactly one chain, or a BuildError that says how many there were and where they part. */
  static wire(source: CurveSource, label: string): Wire {
    const wires = CurveOperand.wires(source, label);
    if (wires.length === 1) {
      return wires[0];
    }
    const gap = CurveOperand.nearestGap(wires);
    wires.forEach(wire => wire.dispose());
    const where = gap
      ? `; the nearest ends, ${CurveOperand.formatPoint(gap.a)} and ${CurveOperand.formatPoint(gap.b)}, are ${CurveOperand.formatLength(gap.distance)} apart`
      : '';
    throw new BuildError(
      `${label} is ${wires.length} separate curves, not one connected curve${where}.`,
      `Make each piece start where the previous one ends, or pass a single connected curve.`,
    );
  }

  /** One closed loop, or a BuildError that names the open ends (their coordinates). */
  static closedLoop(source: CurveSource, label: string): Wire {
    const wire = CurveOperand.wire(source, label);
    const ends = CurveOperand.openEnds([wire]);
    if (ends.length === 0) {
      return wire;
    }
    wire.dispose();
    throw new BuildError(
      `${label} is open: it ends at ${ends.map(point => CurveOperand.formatPoint(point)).join(' and ')}.`,
      `Close the curve so it ends where it starts.`,
    );
  }

  /** The plane every edge lies in, or null (the edges leave every plane, or are collinear). */
  static planeOf(edges: readonly Edge[]): Plane | null {
    return WireOps.planeOfEdges([...edges]);
  }

  /**
   * The open ends of a set of wires: each wire's vertices that only one of
   * its edges reaches, matched within the chaining tolerance, so a loop that
   * closes within that tolerance has none.
   */
  static openEnds(wires: readonly Wire[]): Point[] {
    const ends: Point[] = [];
    for (const wire of wires) {
      const edges = wire.getEdges();
      const tolerance = WireOps.connectTolerance(edges);
      const counted: { point: Point; count: number }[] = [];
      for (const edge of edges) {
        for (const point of [edge.getFirstPoint(), edge.getLastPoint()]) {
          const known = counted.find(entry => entry.point.distanceTo(point) <= tolerance);
          if (known) {
            known.count++;
          } else {
            counted.push({ point, count: 1 });
          }
        }
      }
      ends.push(...counted.filter(entry => entry.count === 1).map(entry => entry.point));
    }
    return ends;
  }

  /**
   * Edges chained into wires, one per connected chain, chains in the order
   * of their earliest edge: {@link WireOps.chainEdges}, for readers that
   * hold edges already (a preview built from picks).
   */
  static chain(edges: readonly Edge[]): Wire[] {
    return WireOps.chainEdges(edges);
  }

  /**
   * Edges in statement order: the owner's order, then the edge's place
   * among the owner's edges (a wire's edges in its walk). Shared by every
   * reader that indexes or orients curves by what was drawn first.
   */
  static statementOrder(owners: ReadonlyMap<Edge, SceneObject>): Edge[] {
    const ownEdges = new Map<SceneObject, Edge[]>();
    const ranks = new Map<Edge, [number, number]>();
    for (const [edge, owner] of owners) {
      let list = ownEdges.get(owner);
      if (!list) {
        list = owner.getAddedShapes().flatMap(CurveOperand.edgesIn);
        ownEdges.set(owner, list);
      }
      ranks.set(edge, [owner.getOrder(), list.indexOf(edge)]);
    }
    return [...owners.keys()].sort((a, b) => {
      const [aOrder, aIndex] = ranks.get(a)!;
      const [bOrder, bIndex] = ranks.get(b)!;
      return aOrder - bOrder || aIndex - bIndex;
    });
  }

  private static objectsOf(source: CurveSource): readonly SceneObject[] {
    return Array.isArray(source) ? source : [source as SceneObject];
  }

  /** A shape's own edges when it is a curve: the edge itself, or a wire's edges. */
  private static edgesIn(shape: Shape): Edge[] {
    if (shape instanceof Edge) {
      return [shape];
    }
    if (shape instanceof Wire) {
      return shape.getEdges();
    }
    return [];
  }

  /**
   * The object's edges with the object that holds each. A container (a
   * sketch, a repeat) stands for its children; lazy accessors and
   * selections inside it hold the same edges as the statement that drew
   * them and would take their ownership. Meta shapes are never geometry —
   * an axis datum's dashed line inside a sketch (`mirror(yAxis())`) stays
   * readable after the mirror hid it, and must not become part of the curve.
   */
  private static collect(obj: SceneObject, label: string, into: Map<Edge, SceneObject>): void {
    if (obj.isContainer()) {
      for (const child of obj.getChildren()) {
        if (!child.isLazy() && !child.isSelection()) {
          CurveOperand.collect(child, label, into);
        }
      }
      return;
    }
    for (const shape of obj.getShapes()) {
      if (shape.isBody()) {
        throw new BuildError(
          `${label} is ${shape.isSolid() ? 'a solid' : 'a surface'}; pick the edges to use.`,
          `Select the edges, for example select(edge().from(…)), or draw the curve in a sketch.`,
        );
      }
      if (shape.isFace()) {
        throw new BuildError(
          `${label} is a face selection; pick its edges.`,
          `Select the edges of those faces, for example select(edge().belongsToFace(face()…)).`,
        );
      }
      for (const edge of CurveOperand.edgesIn(shape)) {
        if (!into.has(edge)) {
          into.set(edge, obj);
        }
      }
    }
  }

  /** The closest pair of open ends that belong to different chains, if two chains have ends. */
  private static nearestGap(wires: readonly Wire[]): { a: Point; b: Point; distance: number } | null {
    const endsByWire = wires.map(wire => CurveOperand.openEnds([wire]));
    let best: { a: Point; b: Point; distance: number } | null = null;
    for (let i = 0; i < endsByWire.length; i++) {
      for (let j = i + 1; j < endsByWire.length; j++) {
        for (const a of endsByWire[i]) {
          for (const b of endsByWire[j]) {
            const distance = a.distanceTo(b);
            if (!best || distance < best.distance) {
              best = { a, b, distance };
            }
          }
        }
      }
    }
    return best;
  }

  private static formatLength(value: number): string {
    const decimals = UNIT_DISPLAY_DECIMALS[getActiveUnit()];
    // "+ 0" folds -0 into 0.
    return String(+value.toFixed(decimals) + 0);
  }

  /** A point as a refusal names it: its coordinates, rounded to the active unit's display decimals. */
  static formatPoint(point: Point): string {
    return `(${[point.x, point.y, point.z].map(CurveOperand.formatLength).join(', ')})`;
  }
}
