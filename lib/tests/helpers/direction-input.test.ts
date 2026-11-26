import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import axis from "../../core/axis.js";
import plane from "../../core/plane.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import cylinder from "../../core/cylinder.js";
import { line } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { BuildError } from "../../common/build-error.js";
import { Shape } from "../../common/shape.js";
import { Edge } from "../../common/edge.js";
import { AxisObject } from "../../features/axis.js";
import { CurveObject } from "../../features/curve-object.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { AxisFromConnector } from "../../features/axis-from-connector.js";
import { PlaneObject } from "../../features/plane.js";
import { DirectionInput } from "../../helpers/direction-input.js";
import { Axis } from "../../math/axis.js";
import type { DirectionInputLike } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Vector3d } from "../../math/vector3d.js";
import { expectOptionsCarried } from "./option-contract.js";
import { testRect } from "./profiles.js";

const asObject = (value: unknown) => value as SceneObject;
const xyz = (vector: Vector3d) => [vector.x, vector.y, vector.z].map(v => +v.toFixed(6) + 0);

/** `DirectionInput.from` as a tool's builder calls it: with the parser context of a statement. */
const direction = registerBuilder((context: SceneParserContext) => {
  return function direction(value: DirectionInputLike): SceneObject {
    return DirectionInput.from(value, context);
  };
});

/** A curve tool with a chained direction, wired the way a tool wires one: a 10 long edge from the origin along it. */
class Ray extends CurveObject {
  private _direction: SceneObject | null = null;

  constructor(private readonly toDirection: (value: DirectionInputLike) => SceneObject) {
    super();
  }

  direction(value: DirectionInputLike): this {
    this._direction = this.adoptOperand(this.toDirection(value));
    return this;
  }

  protected buildCurves(): Shape[] {
    const along = DirectionInput.resolve(this._direction ?? new AxisObject(Axis.X()), "ray direction");
    return [EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(along.x * 10, along.y * 10, along.z * 10))];
  }

  override getType(): string {
    return "test-ray";
  }

  override getDependencies(): SceneObject[] {
    return this._direction ? [this._direction] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Ray(this.toDirection);
    copy._direction = this._direction ? remap.get(this._direction) ?? this._direction : null;
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof Ray) || !super.compareTo(other) || !this._direction !== !other._direction) {
      return false;
    }
    return !this._direction || this._direction.compareTo(other._direction!);
  }

  serialize() {
    return { direction: this._direction ? this._direction.serialize() : undefined };
  }
}

const ray = registerBuilder((context: SceneParserContext) => {
  return function ray(): Ray {
    const result = new Ray(value => DirectionInput.from(value, context));
    context.addSceneObject(result);
    return result;
  };
});

/** A 20 × 10 × 5 block on XY from the origin. */
function block(): SceneObject {
  sketch("xy", () => {
    testRect(20, 10);
  });
  return asObject(extrude(5));
}

function refusal(run: () => unknown): BuildError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return error as BuildError;
  }
  throw new Error("expected a BuildError");
}

describe("DirectionInput", () => {
  setupOC();

  describe("an axis", () => {
    it("reads a world axis name, without putting anything in the scene", () => {
      const before = getCurrentScene().getAllSceneObjects().length;
      const d = direction("z");

      expect(d).toBeInstanceOf(AxisObject);
      expect(d.isInternal()).toBe(true);
      expect(getCurrentScene().getAllSceneObjects().length).toBe(before);
      expect(xyz(DirectionInput.resolve(d))).toEqual([0, 0, 1]);
      expect(xyz(DirectionInput.resolve(direction("x")))).toEqual([1, 0, 0]);
    });

    it("keeps an axis() statement as it is and reads its direction", () => {
      const a = axis("y");
      const d = direction(a);
      render();

      expect(d).toBe(a);
      expect(xyz(DirectionInput.resolve(d))).toEqual([0, 1, 0]);
    });

    it("reads a straight edge of a solid", () => {
      block();
      const upright = asObject(select(edge().verticalTo("xy").nearest("x").nearest("y")));
      const d = direction(upright);
      render();

      expect(d).toBe(upright);
      expect(xyz(DirectionInput.resolve(d))).toEqual([0, 0, 1]);
    });

    it("reads a sketch line, whichever way it was drawn", () => {
      let drawn: SceneObject = null!;
      sketch("xy", () => {
        drawn = asObject(line([10, 0], [0, 0]));
      });
      render();

      expect(xyz(DirectionInput.resolve(direction(drawn)))).toEqual([1, 0, 0]);
    });

    it("reads a connector as its Z axis", () => {
      let d: SceneObject = null!;
      part("flange", () => {
        block();
        const side = connector("side", select(face().planar().onPlane("yz", 20)));
        d = direction(side);
      });
      render();

      expect(d).toBeInstanceOf(AxisFromConnector);
      expect(d.isInternal()).toBe(true);
      expect(xyz(DirectionInput.resolve(d))).toEqual([1, 0, 0]);
    });
  });

  describe("a plane", () => {
    it("reads a world plane name as its normal, without putting anything in the scene", () => {
      const before = getCurrentScene().getAllSceneObjects().length;
      const d = direction("xy");

      expect(d).toBeInstanceOf(PlaneObject);
      expect(d.isInternal()).toBe(true);
      expect(getCurrentScene().getAllSceneObjects().length).toBe(before);
      expect(xyz(DirectionInput.resolve(d))).toEqual([0, 0, 1]);
      expect(xyz(DirectionInput.resolve(direction("yz")))).toEqual([1, 0, 0]);
    });

    it("keeps a plane() statement as it is and reads its normal", () => {
      const p = plane("xz", { offset: 12 });
      const d = direction(p);
      render();

      expect(d).toBe(p);
      const normal = xyz(DirectionInput.resolve(d));
      expect([Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])]).toEqual([0, 1, 0]);
    });

    it("reads a planar face as its outward normal", () => {
      block();
      const top = asObject(select(face().planar().onPlane("xy", 5)));
      const side = asObject(select(face().planar().onPlane("yz", 20)));
      render();

      expect(xyz(DirectionInput.resolve(direction(top)))).toEqual([0, 0, 1]);
      expect(xyz(DirectionInput.resolve(direction(side)))).toEqual([1, 0, 0]);
    });
  });

  describe("given through a chained method", () => {
    const tip = (tool: Ray) => {
      const drawn = tool.getShapes()[0] as Edge;
      return xyz(drawn.getLastPoint().toVector3d());
    };

    it("builds along a world axis and leaves no axis in the scene", () => {
      const r = ray().direction("z");
      const scene = render();

      expect(r.getError()).toBeNull();
      expect(tip(r)).toEqual([0, 0, 10]);
      expect(scene.getAllSceneObjects()).toEqual([r]);
    });

    it("builds along a plane's normal", () => {
      const r = ray().direction("yz");
      render();

      expect(tip(r)).toEqual([10, 0, 0]);
    });

    it("builds along a picked edge and takes the selection", () => {
      block();
      const upright = select(edge().verticalTo("xy").nearest("x").nearest("y")) as unknown as SelectSceneObject;
      const r = ray().direction(upright);
      render();

      expect(r.getError()).toBeNull();
      expect(tip(r)).toEqual([0, 0, 10]);
      expect(upright.isClaimed()).toBe(true);
      expect(upright.getShapes()).toEqual([]);
    });

    it("builds along a lazy accessor, which has no build slot of its own", () => {
      sketch("xy", () => {
        testRect(20, 10);
      });
      const box = extrude(5) as unknown as Extrude;
      const r = ray().direction(box.endFaces(0));
      render();

      expect(r.getError()).toBeNull();
      expect(tip(r)).toEqual([0, 0, 10]);
    });

    it("carries the direction through copy, compare, dependencies and serialize", () => {
      const a = axis("y");
      expectOptionsCarried<Ray>(() => ray(), {
        direction: tool => tool.direction(a),
      });
      expectOptionsCarried<Ray>(() => ray(), {
        direction: tool => tool.direction("z"),
      });
    });

    it("reports the operand in the tool's words", () => {
      cylinder(5, 10);
      const rim = asObject(select(edge().circle().nearest("z")));
      const r = ray().direction(rim);
      render();

      expect(r.getError()).toMatch(/^ray direction is a curved edge/);
    });
  });

  describe("refusals", () => {
    it("refuses a curved edge, naming the operand", () => {
      cylinder(5, 10);
      const rim = asObject(select(edge().circle().nearest("z")));
      render();

      const error = refusal(() => DirectionInput.resolve(direction(rim), "project direction"));
      expect(error.diagnostic).toBe("project direction is a curved edge; only a straight edge gives a direction.");
      expect(error.hint).toMatch(/an axis .* or a plane/);
    });

    it("refuses a curved face", () => {
      cylinder(5, 10);
      const wall = asObject(select(face().cylinder()));
      render();

      const error = refusal(() => DirectionInput.resolve(direction(wall), "ruled direction"));
      expect(error.diagnostic).toBe("ruled direction is a curved face; only a planar face gives a direction.");
    });

    it("refuses several edges, and a selection that matched nothing", () => {
      block();
      const uprights = asObject(select(edge().verticalTo("xy")));
      const none = asObject(select(edge().circle()));
      render();

      expect(refusal(() => DirectionInput.resolve(uprights)).diagnostic)
        .toBe("direction holds 4 shapes; a direction is read from one.");
      expect(refusal(() => DirectionInput.resolve(none)).diagnostic)
        .toBe("direction holds nothing to read a direction from.");
    });

    it("refuses a solid", () => {
      const box = block();
      render();

      expect(refusal(() => DirectionInput.resolve(direction(box))).diagnostic)
        .toBe("direction is a solid; it gives no direction.");
    });

    it("refuses a value that is neither an axis nor a plane, where the statement is written", () => {
      expect(() => direction("up" as never)).toThrow(/direction: expected an axis .* or a plane/);
      expect(() => direction(42 as never)).toThrow(/direction: expected an axis/);
    });
  });
});
