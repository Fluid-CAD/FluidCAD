import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import plane from "../../core/plane.js";
import repeat from "../../core/repeat.js";
import rib from "../../core/rib.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { circle, line, project } from "../../core/2d/index.js";
import { vertical } from "../../core/constraints/index.js";
import { Rib } from "../../features/rib.js";
import { Sketch } from "../../features/2d/sketch.js";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { testRect } from "../helpers/profiles.js";

// User repro (part2 bracket): a rib whose spine sketch also holds a
// `project(<lazy face selection>).guide()` reference, mirrored with
// repeat("mirror"). The mirror statement clones at module-eval time, before
// the source projection's pre-pass ran, so the clone carried no prepared
// compute and recomputed in the cloned sketch's pre-pass — which built the
// CLONED lazy face selection. Nothing ever consumed that face (the cloned
// projection's build slot is renderer-skipped), so the mirrored rib's spine
// read the line PLUS the face's four outline edges and failed with "Failed
// to create wire from edges".
//
// Geometry is the Lego brick of mirror-rib-user-repro.test.ts; the tubes
// stop the extended rib short of the far wall so the mirror is not
// degenerate.
describe("repeat mirror of a rib whose spine sketch projects a lazy face selection", () => {
  setupOC();

  it("builds the mirrored rib from the spine line alone", () => {
    const thickness = 9.6;
    const width = 31.8;
    const height = 15.8;

    sketch("xy", () => {
      testRect(width, height);
    });
    const e = extrude(thickness);

    sketch(e.endFaces(), () => {
      circle([3.9, (height - 8) / 2], 4.8);
    });
    const e2 = extrude(1.8);
    repeat("linear", ["x", "y"], { count: [4, 2], offset: [8, 8] }, e2);

    const sh = shell(-1.2, e.startFaces()).join("intersection");
    sketch(sh.internalFaces(1), () => {
      circle([-15.9, 7.9], 6.51);
      circle([-15.9, 7.9], 4.8);
    });
    const f = extrude(select(face().onPlane("xy")));
    repeat("linear", "x", { count: 3, offset: 8, centered: true }, f);

    const p = plane(sh.internalFaces(1), 6.3);
    sketch(p, () => {
      const sg1 = line([-15.9, 2], [-15.9, 3.67]);
      vertical(sg1);
      // A guide reference off a lazy face selection — construction only.
      project(e.sideFaces(2)).guide();
    });
    const f2 = rib(0.8).extend() as unknown as Rib;
    const p2 = plane(plane(e.sideFaces(1)), plane(e.sideFaces(3)));
    repeat("mirror", p2, f2 as unknown as SceneObject);

    render();

    const objs = getCurrentScene().getSceneObjects();
    const clones = objs.filter((o): o is Rib =>
      o instanceof Rib && o !== (f2 as unknown as SceneObject) &&
      o.getCloneSource() === (f2 as unknown as SceneObject),
    );
    expect(clones.length).toBe(1);
    expect((f2 as unknown as SceneObject).getError()).toBeNull();
    expect(clones[0].getError()).toBeNull();
    expect((clones[0].getState("start-faces") as Face[]).length).toBeGreaterThan(0);
    expect((clones[0].getState("side-faces") as Face[]).length).toBeGreaterThan(0);

    // The cloned sketch's lazy selection child stays empty: a clone never
    // recomputes its references, so no raw source face is built into the
    // cloned sketch for a consumer to trip over.
    const clonedSketches = objs.filter((o): o is Sketch =>
      o instanceof Sketch && o.getCloneSource() instanceof Sketch && o.getChildren().some(c => c.isLazy()),
    );
    expect(clonedSketches.length).toBe(1);
    for (const child of clonedSketches[0].getChildren()) {
      if (child.isLazy()) {
        expect(child.getShapes({ excludeMeta: false, excludeGuide: false }).length).toBe(0);
      }
    }
  });
});
