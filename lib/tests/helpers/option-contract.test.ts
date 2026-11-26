import { describe, it, expect } from "vitest";
import { setupOC } from "../setup.js";
import sketch from "../../core/sketch.js";
import { line } from "../../core/2d/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { expectOptionsCarried } from "./option-contract.js";
import { chord, TestChord } from "./result-fixtures.js";

type Method = "createCopy" | "compareTo" | "getDependencies" | "serialize";

/** Stands for an operand: equal to any other marker with the same label. */
class Marker extends SceneObject {
  constructor(readonly label: string) {
    super();
  }

  build() {}

  override getType(): string {
    return "marker";
  }

  override compareTo(other: SceneObject): boolean {
    return other instanceof Marker && other.label === this.label;
  }

  serialize() {
    return { label: this.label };
  }
}

/**
 * A feature with a flag option and a scene-object option that carries both
 * through every method, except the one named in `forget` for the option
 * named in `forgotten`.
 */
class Probe extends SceneObject {
  private _flag = false;
  private _ref: SceneObject | null = null;

  constructor(private readonly forgotten: "flag" | "ref" | null = null, private readonly forget: Method | null = null) {
    super();
  }

  flag(): this {
    this._flag = true;
    return this;
  }

  ref(value: SceneObject): this {
    this._ref = value;
    return this;
  }

  private carries(option: "flag" | "ref", method: Method): boolean {
    return !(this.forgotten === option && this.forget === method);
  }

  build() {}

  override getType(): string {
    return "probe";
  }

  override getDependencies(): SceneObject[] {
    return this._ref && this.carries("ref", "getDependencies") ? [this._ref] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Probe(this.forgotten, this.forget);
    if (this.carries("flag", "createCopy")) {
      copy._flag = this._flag;
    }
    if (this.carries("ref", "createCopy")) {
      copy._ref = this._ref ? remap.get(this._ref) ?? this._ref : null;
    }
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof Probe) || !super.compareTo(other)) {
      return false;
    }
    if (this.carries("flag", "compareTo") && this._flag !== other._flag) {
      return false;
    }
    if (this.carries("ref", "compareTo")) {
      if (!this._ref !== !other._ref) {
        return false;
      }
      if (this._ref && !this._ref.compareTo(other._ref!)) {
        return false;
      }
    }
    return true;
  }

  serialize() {
    return {
      flag: this.carries("flag", "serialize") ? this._flag : undefined,
      ref: this.carries("ref", "serialize") && this._ref ? this._ref.serialize() : undefined,
    };
  }
}

const OPTIONS: Record<string, (feature: Probe) => void> = {
  flag: feature => feature.flag(),
  ref: feature => feature.ref(new Marker("rail")),
};

const check = (forgotten: "flag" | "ref", forget: Method) =>
  () => expectOptionsCarried(() => new Probe(forgotten, forget), OPTIONS);

describe("expectOptionsCarried", () => {
  setupOC();

  it("passes for a feature that carries every option", () => {
    expect(() => expectOptionsCarried(() => new Probe(), OPTIONS)).not.toThrow();
  });

  it("passes for the chord fixture, built through its builder", () => {
    const path = sketch("xy", () => {
      line([0, 0], [10, 0]);
    }) as unknown as SceneObject;
    expectOptionsCarried<TestChord>(() => chord([0, 0, 0], [10, 0, 0]), {
      reversed: feature => feature.reversed(),
      along: feature => feature.along(path),
    });
  });

  describe("an option forgotten in createCopy", () => {
    it("fails for a flag", () => {
      expect(check("flag", "createCopy")).toThrow(/createCopy\(\) carries \.flag\(\)/);
    });

    it("fails for a scene object", () => {
      expect(check("ref", "createCopy")).toThrow(/createCopy\(\) carries \.ref\(\)/);
    });

    it("fails for a scene object copied without the remap", () => {
      class Unmapped extends Probe {
        override createCopy(): SceneObject {
          return super.createCopy(new Map());
        }
      }
      expect(() => expectOptionsCarried(() => new Unmapped(), OPTIONS))
        .toThrow(/createCopy\(remap\) remaps the marker given to \.ref\(\)/);
    });
  });

  describe("an option forgotten in compareTo", () => {
    it("fails for a flag", () => {
      expect(check("flag", "compareTo")).toThrow(/compareTo\(\) sees \.flag\(\)/);
    });

    it("fails for a scene object", () => {
      expect(check("ref", "compareTo")).toThrow(/compareTo\(\) sees \.ref\(\)/);
    });
  });

  describe("an option forgotten in getDependencies", () => {
    it("fails for a scene object", () => {
      expect(check("ref", "getDependencies")).toThrow(/getDependencies\(\) lists the marker given to \.ref\(\)/);
    });
  });

  describe("an option forgotten in serialize", () => {
    it("fails for a flag", () => {
      expect(check("flag", "serialize")).toThrow(/serialize\(\) shows \.flag\(\)/);
    });

    it("fails for a scene object", () => {
      expect(check("ref", "serialize")).toThrow(/serialize\(\) shows \.ref\(\)/);
    });
  });

  it("fails when two default instances do not compare equal, since no option could be told apart", () => {
    let serial = 0;
    expect(() => expectOptionsCarried(() => new Marker(`m${serial++}`), {})).toThrow(/two default instances compare equal/);
  });
});
