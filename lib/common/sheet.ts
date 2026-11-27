import type { TopoDS_Shell } from "ocjs-fluidcad";
import { SheetOps } from "../oc/sheet-ops.js";
import { ShapeType } from "./shape-type.js";
import { Shape } from "./shape.js";
import { BodyShape } from "./body-shape.js";
import type { Edge } from "./edge.js";
import type { Wire } from "./wire.js";

/**
 * A surface body: connected faces that stand in the scene as one surface
 * and need not enclose a volume. Wraps a `TopoDS_Shell`; a single-face
 * surface is a one-face sheet, so a consumer never has to tell a surface
 * from a reference to a face.
 */
export class Sheet extends BodyShape<TopoDS_Shell> {
  /** {@link getBoundaryEdges}' answer: a subset of the body's own edge wrappers. */
  private boundaryEdges: Edge[] | null = null;
  /** {@link getBoundaryWires}' answer, owned by this wrapper. */
  private boundaryWires: Wire[] | null = null;

  constructor(shell: TopoDS_Shell) {
    super(shell);
  }

  getType(): ShapeType {
    return "surface";
  }

  override isSheet() {
    return true;
  }

  /**
   * The open rim: every model edge that bounds exactly one face of this
   * sheet ({@link isBoundaryEdge}). A seam is hidden, so it is never part
   * of the rim.
   */
  getBoundaryEdges(): Edge[] {
    if (!this.boundaryEdges) {
      this.boundaryEdges = this.getEdges().filter(edge => this.isBoundaryEdge(edge.getShape()));
    }
    return this.boundaryEdges;
  }

  /** The rim as closed loops (and open chains, for a rim a seam interrupts). */
  getBoundaryWires(): Wire[] {
    if (!this.boundaryWires) {
      this.boundaryWires = SheetOps.boundaryWires(this);
    }
    return this.boundaryWires;
  }

  /** No rim at all: the faces enclose a volume (a solid waiting to be made). */
  isClosed(): boolean {
    return this.getBoundaryEdges().length === 0;
  }

  override dispose() {
    if (this.isReleased()) {
      return;
    }
    this.boundaryEdges = null;
    super.dispose();
  }

  protected override disposeSubShapes(): void {
    for (const wire of this.boundaryWires ?? []) wire.dispose();
    this.boundaryWires = null;
    super.disposeSubShapes();
  }

  override getLinkedShapes(): Shape[] {
    const linked = super.getLinkedShapes();
    if (this.boundaryWires) {
      linked.push(...this.boundaryWires);
    }
    return linked;
  }

  override release(retainedRaw: ReadonlySet<object>, deletedRaw: Set<object>): void {
    if (this.isReleased()) {
      return;
    }
    this.boundaryEdges = null;
    this.boundaryWires = null;
    super.release(retainedRaw, deletedRaw);
  }

  /** A new wrapper over the same handle (so the faces are `IsSame` with the original's), as `Solid.copy()` is. */
  override copy(): Shape {
    const copied = new Sheet(this.getShape());
    for (const edge of this.getRenderSeams()) copied.recordRenderSeam(edge);
    return copied;
  }

  static fromTopoDSShell(shell: TopoDS_Shell): Sheet {
    return new Sheet(shell);
  }
}
