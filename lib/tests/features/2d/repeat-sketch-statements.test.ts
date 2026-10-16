// Every sketch statement kind survives being cloned: repeat() and copy() of
// a feature clone its whole sketch statement by statement through
// createCopy(), and a statement kind without one fails the user's file at
// the repeat line ("createCopy() not implemented for spline" — the gear
// tooth bug, 2026-10-16; the in-sketch copy() had the same gap). The
// abstract createCopy on GeometrySceneObject makes a NEW kind fail to
// compile instead; this table proves each existing kind's copy also
// builds, by asserting no per-object error (render() never throws) and the
// solid count the placement implies.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import repeat from "../../../core/repeat.js";
import copy from "../../../core/copy.js";
import mirror from "../../../core/mirror.js";
import fillet from "../../../core/fillet.js";
import { rect } from "../../../core/shapes/index.js";
import {
  line, arc, circle, ellipse, point, offset, project, intersect, bezier, spline, text,
} from "../../../core/2d/index.js";
import { Scene } from "../../../rendering/scene.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";

type Case = {
  name: string;
  /** Builds the model up to and including the feature to repeat / copy;
   * returns that feature. */
  model: () => ExtrudeBase;
  /** Solids outside the repeated feature (a projection's source body). */
  base?: number;
  /** Solids one placement of the feature yields. */
  perInstance: number;
};

const CASES: Case[] = [
  {
    name: "line + arc",
    model: () => {
      sketch("xy", () => {
        line([14, -3], [20, -3]);
        arc([20, -3], [20, 3], [20, 0]);
        line([20, 3], [14, 3]);
        line([14, 3], [14, -3]);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "circle",
    model: () => {
      sketch("xy", () => {
        circle([18, 0], 3);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "ellipse",
    model: () => {
      sketch("xy", () => {
        ellipse([18, 0], 4, 2);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "rect macro",
    model: () => {
      sketch("xy", () => {
        rect([14, -3], 6, 6);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "rect + point",
    model: () => {
      sketch("xy", () => {
        rect([14, -3], 6, 6);
        point([17, 0]);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "bezier flanks",
    model: () => {
      sketch("xy", () => {
        bezier([13, -2.8], [14.25, -2.8], [18, -2.35], [21, -1.35]);
        line([21, -1.35], [21, 1.35]);
        bezier([21, 1.35], [18, 2.35], [14.25, 2.8], [13, 2.8]);
        line([13, 2.8], [13, -2.8]);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "spline flanks",
    model: () => {
      sketch("xy", () => {
        spline([13, -2.8], [14.25, -2.8], [18, -2.35], [21, -1.35]);
        line([21, -1.35], [21, 1.35]);
        spline([21, 1.35], [18, 2.35], [14.25, 2.8], [13, 2.8]);
        line([13, 2.8], [13, -2.8]);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "curve riding a line's end",
    model: () => {
      sketch("xy", () => {
        const l = line([14, -3], [20, -3]);
        spline(l.end(), [22, 0], [20, 3]);
        const back = bezier([20, 3], [17, 4], [14, 3]);
        line(back.end(), [14, -3]);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "text",
    model: () => {
      sketch("xy", () => {
        text("L").size(6).at([14, -3]);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "offset ring",
    model: () => {
      sketch("xy", () => {
        circle([18, 0], 2);
        offset(2);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "fillet2d",
    model: () => {
      sketch("xy", () => {
        rect([14, -3], 6, 6);
        fillet(1);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 1,
  },
  {
    name: "in-sketch linear copy",
    model: () => {
      sketch("xy", () => {
        circle([14, 0], 2);
        copy("linear", "x", { count: 2, offset: 6 });
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 2,
  },
  {
    name: "in-sketch circular copy",
    model: () => {
      sketch("xy", () => {
        const c = circle([14, 0], 2);
        copy("circular", [14, 6], { count: 2, angle: 60 }, c);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 2,
  },
  {
    name: "in-sketch mirror",
    model: () => {
      sketch("xy", () => {
        circle([14, 5], 2);
        mirror("x");
      });
      return extrude(4).new() as ExtrudeBase;
    },
    perInstance: 2,
  },
  {
    name: "projection of a body's end face",
    model: () => {
      sketch("xy", () => {
        rect([14, -3], 6, 6);
      });
      const body = extrude(2).new() as ExtrudeBase;
      sketch("xy", () => {
        project(body.endFaces());
      });
      return extrude(4).new() as ExtrudeBase;
    },
    base: 1,
    perInstance: 1,
  },
  {
    name: "intersection with a body",
    model: () => {
      sketch("xy", () => {
        rect([14, -3], 6, 6);
      });
      const body = extrude(2).new() as ExtrudeBase;
      sketch("xy", () => {
        intersect(body);
      });
      return extrude(4).new() as ExtrudeBase;
    },
    base: 1,
    perInstance: 1,
  },
];

function expectNoErrors(scene: Scene) {
  const errored = scene.getAllSceneObjects().filter(o => o.getError());
  expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
}

/** Solids the viewport shows: a repeat's clones keep their built solid but
 * are display-consumed, so only the rendered rows' shapes count (every
 * sketch here is consumed by its extrude, so those rows hold solids only). */
function solidCount(scene: Scene): number {
  return scene.getRenderedObjects()
    .flatMap(r => r.sceneShapes)
    .filter(s => s.lineageKey !== undefined)
    .length;
}

describe("every sketch statement kind survives a clone", () => {
  setupOC();

  describe("circular repeat", () => {
    for (const c of CASES) {
      it(c.name, () => {
        c.model();
        repeat("circular", "z", { count: 3, angle: 360 });
        const scene = render();
        expectNoErrors(scene);
        expect(solidCount(scene)).toBe((c.base ?? 0) + 3 * c.perInstance);
      });
    }
  });

  describe("3D copy", () => {
    for (const c of CASES) {
      it(c.name, () => {
        const feature = c.model();
        copy("linear", "y", { count: 2, offset: 40 }, feature);
        const scene = render();
        expectNoErrors(scene);
        expect(solidCount(scene)).toBe((c.base ?? 0) + 2 * c.perInstance);
      });
    }
  });
});
