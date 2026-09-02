// rect() — the first macro shape: an axis-aligned rectangle as one atomic
// statement. 4 lines + internal rows (4 coincident + 2 H + 2 V) = 4 DOF —
// exactly its args (pos + size, both guesses). `.centered()` reinterprets
// pos as the center; `.radius(r)` rounds the corners with 4 quarter arcs
// (+ tangents + equal radii), adding the shared radius as a 5th DOF —
// the literal is a GUESS like every other arg, not a locked dimension.

import { Point2D } from "../../../../math/point.js";
import { SceneObject } from "../../../../common/scene-object.js";
import { MacroShapeBase, MacroEntityDef } from "./base.js";
import { MacroEdgeRef } from "./refs.js";
import { start, end, entityRef } from "../../../../sketch-solver/index.js";
import type { ConstraintSpec } from "../../../../sketch-solver/index.js";
import { mmTol } from "../../../../units/tolerance.js";

const SIDES = ['bottom', 'right', 'top', 'left'] as const;
/** A side shorter than 1e-6 mm (in the active unit) is degenerate. */
function minSpan(): number {
  return mmTol(1e-6);
}

/** Perimeter walk order (CCW for positive spans): side, then the corner
 * arc joining it to the next side. corner0 sits at the pos corner
 * (bottom-left for positive spans), numbering CCW. */
const ROUNDED_CHAIN = [
  'bottom', 'corner1', 'right', 'corner2', 'top', 'corner3', 'left', 'corner0',
] as const;

export class RectMacro extends MacroShapeBase {

  private _centered = false;
  private _cornerRadius: number | null = null;

  constructor(
    private posGuess: Point2D,
    private widthGuess: number,
    private heightGuess: number,
  ) {
    super();
  }

  // -- chained modifiers (statement time only) -----------------------------

  /** Reinterpret the position argument as the rectangle's CENTER. */
  centered(): this {
    this.assertMutable('rect.centered');
    this._centered = true;
    return this;
  }

  /** Round all four corners with radius `r` (a guess — the shared corner
   * radius becomes a 5th degree of freedom; lock it with a radius() dim). */
  radius(r: number): this {
    this.assertMutable('rect.radius');
    if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) {
      throw new Error('rect.radius: expected a positive number');
    }
    if (this._cornerRadius !== null) {
      throw new Error('rect.radius: already set — rect() takes one corner radius');
    }
    this._cornerRadius = r;
    return this;
  }

  // -- accessors -----------------------------------------------------------

  bottom(): MacroEdgeRef {
    return new MacroEdgeRef(this, 'bottom');
  }

  right(): MacroEdgeRef {
    return new MacroEdgeRef(this, 'right');
  }

  top(): MacroEdgeRef {
    return new MacroEdgeRef(this, 'top');
  }

  left(): MacroEdgeRef {
    return new MacroEdgeRef(this, 'left');
  }

  /** Corner arc `i` (0 at the pos corner, numbering CCW) — rounded rects
   * only. Resolution errors on a plain rect point at `.radius(r)`. */
  corner(i: number): MacroEdgeRef {
    return new MacroEdgeRef(this, `corner${i}`);
  }

  // -- recipe --------------------------------------------------------------

  canonicalSlots(): string[] {
    return [...SIDES, 'corner0', 'corner1', 'corner2', 'corner3'];
  }

  protected override missingSlotMessage(slot: string): string {
    const match = /^corner(-?\d+)$/.exec(slot);
    if (match) {
      const i = Number(match[1]);
      if (i < 0 || i > 3) {
        return `rect() corners are numbered 0..3 — corner(${i}) does not exist`;
      }
      return `rect() has no rounded corners — chain .radius(r) to round them`;
    }
    return `rect() has no '${slot}' edge`;
  }

  protected validateArgs(): void {
    const w = this.widthGuess;
    const h = this.heightGuess;
    const MIN_SPAN = minSpan();
    if (Math.abs(w) < MIN_SPAN || Math.abs(h) < MIN_SPAN) {
      throw new Error(`rect() width and height must be non-zero — got ${w} × ${h}`);
    }
    const r = this._cornerRadius;
    if (r !== null && r >= Math.min(Math.abs(w), Math.abs(h)) / 2 - MIN_SPAN) {
      throw new Error(
        `rect.radius: ${r} does not fit a ${Math.abs(w)}×${Math.abs(h)} rect — ` +
        'the radius must be less than half the shorter side',
      );
    }
  }

  protected computeEntities(): MacroEntityDef[] {
    const w = this.widthGuess;
    const h = this.heightGuess;
    const x0 = this._centered ? this.posGuess.x - w / 2 : this.posGuess.x;
    const y0 = this._centered ? this.posGuess.y - h / 2 : this.posGuess.y;
    const x1 = x0 + w;
    const y1 = y0 + h;
    const r = this._cornerRadius;

    if (r === null) {
      return [
        { slot: 'bottom', kind: 'line', params: [x0, y0, x1, y0] },
        { slot: 'right', kind: 'line', params: [x1, y0, x1, y1] },
        { slot: 'top', kind: 'line', params: [x1, y1, x0, y1] },
        { slot: 'left', kind: 'line', params: [x0, y1, x0, y0] },
      ];
    }

    // Signed insets keep negative spans drawing the same signed rectangle
    // the args describe (the testRect convention).
    const su = Math.sign(w) * r;
    const sv = Math.sign(h) * r;
    const arc = (slot: string, cx: number, cy: number, sx: number, sy: number, ex: number, ey: number): MacroEntityDef => ({
      slot,
      kind: 'arc',
      params: [cx, cy, sx, sy, ex, ey],
      cw: (sx - cx) * (ey - cy) - (sy - cy) * (ex - cx) < 0,
    });
    return [
      { slot: 'bottom', kind: 'line', params: [x0 + su, y0, x1 - su, y0] },
      arc('corner1', x1 - su, y0 + sv, x1 - su, y0, x1, y0 + sv),
      { slot: 'right', kind: 'line', params: [x1, y0 + sv, x1, y1 - sv] },
      arc('corner2', x1 - su, y1 - sv, x1, y1 - sv, x1 - su, y1),
      { slot: 'top', kind: 'line', params: [x1 - su, y1, x0 + su, y1] },
      arc('corner3', x0 + su, y1 - sv, x0 + su, y1, x0, y1 - sv),
      { slot: 'left', kind: 'line', params: [x0, y1 - sv, x0, y0 + sv] },
      arc('corner0', x0 + su, y0 + sv, x0, y0 + sv, x0 + su, y0),
    ];
  }

  protected computeRules(entityId: (slot: string) => number): ConstraintSpec[] {
    const specs: ConstraintSpec[] = [];
    const chain: readonly string[] = this._cornerRadius === null ? SIDES : ROUNDED_CHAIN;
    for (let i = 0; i < chain.length; i++) {
      const a = entityId(chain[i]);
      const b = entityId(chain[(i + 1) % chain.length]);
      specs.push({ kind: 'coincident', a: end(a), b: start(b) });
    }
    specs.push({ kind: 'horizontal', a: entityRef(entityId('bottom')) });
    specs.push({ kind: 'vertical', a: entityRef(entityId('right')) });
    specs.push({ kind: 'horizontal', a: entityRef(entityId('top')) });
    specs.push({ kind: 'vertical', a: entityRef(entityId('left')) });
    if (this._cornerRadius !== null) {
      for (let i = 0; i < ROUNDED_CHAIN.length; i++) {
        specs.push({
          kind: 'tangent',
          a: entityRef(entityId(ROUNDED_CHAIN[i])),
          b: entityRef(entityId(ROUNDED_CHAIN[(i + 1) % ROUNDED_CHAIN.length])),
        });
      }
      specs.push({
        kind: 'equal',
        a: entityRef(entityId('corner0')),
        b: entityRef(entityId('corner1')),
        others: [entityRef(entityId('corner2')), entityRef(entityId('corner3'))],
      });
    }
    return specs;
  }

  protected serializeConfig(): Record<string, unknown> {
    return {
      centered: this._centered,
      radius: this._cornerRadius,
      // Authored argument guesses — the drag write-back drift-guards its
      // literal splices against these (the P4 discipline).
      guess: {
        pos: { x: this.posGuess.x, y: this.posGuess.y },
        width: this.widthGuess,
        height: this.heightGuess,
        ...(this._cornerRadius !== null ? { radius: this._cornerRadius } : {}),
      },
    };
  }

  // -- SceneObject plumbing ------------------------------------------------

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new RectMacro(this.posGuess, this.widthGuess, this.heightGuess);
    copy._centered = this._centered;
    copy._cornerRadius = this._cornerRadius;
    this.copyMacroStateTo(copy);
    return copy;
  }

  compareTo(other: RectMacro): boolean {
    if (!(other instanceof RectMacro)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.posGuess.x === other.posGuess.x
      && this.posGuess.y === other.posGuess.y
      && this.widthGuess === other.widthGuess
      && this.heightGuess === other.heightGuess
      && this._centered === other._centered
      && this._cornerRadius === other._cornerRadius;
  }

  getType(): string {
    return 'rect';
  }

  getUniqueType(): string {
    return 'macro-rect';
  }
}
