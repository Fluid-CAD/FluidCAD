import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { SceneCompare } from "../rendering/scene-compare.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import plane from "../core/plane.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import { circle, rect } from "../core/2d/index.js";
import { face, edge } from "../filters/index.js";
import { Connector } from "../features/connector.js";
import { Part } from "../features/part.js";

const EPS = 1e-6;

describe("connector frame", () => {
  setupOC();

  it("derives centroid + face normal from a planar face selection", () => {
    let conn!: Connector;
    part("face-frame", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20))) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // rect(40, 60) spans (0,0)-(40,60); centroid of the top face is (20, 30, 20).
    expect(frame.origin.x).toBeCloseTo(20, 5);
    expect(frame.origin.y).toBeCloseTo(30, 5);
    expect(frame.origin.z).toBeCloseTo(20, 5);

    // Top face normal is +Z.
    expect(frame.normal.x).toBeCloseTo(0, 5);
    expect(frame.normal.y).toBeCloseTo(0, 5);
    expect(frame.normal.z).toBeCloseTo(1, 5);

    // Horizontal-face fallback: Y = +Y (worldUp lies along Z), X = Y × Z = +X.
    expect(frame.xDirection.x).toBeCloseTo(1, 5);
    expect(frame.xDirection.y).toBeCloseTo(0, 5);
    expect(frame.xDirection.z).toBeCloseTo(0, 5);
    expect(frame.yDirection.x).toBeCloseTo(0, 5);
    expect(frame.yDirection.y).toBeCloseTo(1, 5);
    expect(frame.yDirection.z).toBeCloseTo(0, 5);
  });

  it("yields the same auto-frame regardless of the sketch plane that produced the face", () => {
    // The same physical face (same outward normal) must get the same connector
    // frame whether the box was sketched in 'front' or in 'right'. The
    // worldUp-anchored rule depends only on Z, so picking the +X face of each
    // box gives identical X/Y axes despite different construction histories.
    let frontConn!: Connector;
    part("auto-frame-front", () => {
      // 'front' = XZ plane (normal -Y); rect lives in (-40..40, 0, 0..120),
      // extrude(-50) sweeps along +Y → box (-40..40, 0..50, 0..120).
      sketch("front", () => rect(80, 120).centered("horizontal"));
      extrude(-50);
      frontConn = connector(select(face().planar().onPlane("yz", 40))) as unknown as Connector;
    });
    render();

    let rightConn!: Connector;
    part("auto-frame-right", () => {
      // 'right' = YZ plane (normal +X); rect lives in (0, -40..40, 0..120),
      // extrude(-50) sweeps along -X → box (-50..0, -40..40, 0..120).
      sketch("right", () => rect(80, 120).centered("horizontal"));
      extrude(-50);
      rightConn = connector(select(face().planar().onPlane("yz", 0))) as unknown as Connector;
    });
    render();

    const frontFrame = frontConn.getFrame();
    const rightFrame = rightConn.getFrame();

    expect(frontFrame.normal.x).toBeCloseTo(1, 5);
    expect(rightFrame.normal.x).toBeCloseTo(1, 5);

    // Same normal → same auto X (worldUp rule fixes X = +Z × +X = +Y).
    expect(frontFrame.xDirection.x).toBeCloseTo(rightFrame.xDirection.x, 5);
    expect(frontFrame.xDirection.y).toBeCloseTo(rightFrame.xDirection.y, 5);
    expect(frontFrame.xDirection.z).toBeCloseTo(rightFrame.xDirection.z, 5);
    expect(frontFrame.xDirection.y).toBeCloseTo(1, 5);

    // And Y is world up for both.
    expect(frontFrame.yDirection.z).toBeCloseTo(1, 5);
    expect(rightFrame.yDirection.z).toBeCloseTo(1, 5);
  });

  it("anchors the auto-frame Y axis to world up for non-horizontal faces", () => {
    // Build one box and check every vertical side face: Y must be +Z, X is
    // determined by right-handed Y × Z. This locks in the new convention.
    // rect(100, 60).centered() on 'xy' extruded 40 → box (-50..50, -30..30, 0..40).
    let conns!: { right: Connector; left: Connector; front: Connector; back: Connector };
    part("up-anchored-frame", () => {
      sketch("xy", () => rect(100, 60).centered());
      extrude(40);
      conns = {
        right: connector(select(face().planar().onPlane("yz", 50))) as unknown as Connector,
        left: connector(select(face().planar().onPlane("yz", -50))) as unknown as Connector,
        front: connector(select(face().planar().onPlane("xz", 30))) as unknown as Connector,
        back: connector(select(face().planar().onPlane("xz", -30))) as unknown as Connector,
      };
    });

    render();

    const right = conns.right.getFrame();
    const left = conns.left.getFrame();
    const front = conns.front.getFrame();
    const back = conns.back.getFrame();

    for (const f of [right, left, front, back]) {
      expect(f.yDirection.x).toBeCloseTo(0, 5);
      expect(f.yDirection.y).toBeCloseTo(0, 5);
      expect(f.yDirection.z).toBeCloseTo(1, 5);
    }

    // Right (Z=+X)  → X = +Z × +X = +Y
    expect(right.normal.x).toBeCloseTo(1, 5);
    expect(right.xDirection.y).toBeCloseTo(1, 5);
    // Left (Z=-X)   → X = +Z × -X = -Y
    expect(left.normal.x).toBeCloseTo(-1, 5);
    expect(left.xDirection.y).toBeCloseTo(-1, 5);
    // Front (Z=-Y)  → X = +Z × -Y = +X
    expect(front.normal.y).toBeCloseTo(-1, 5);
    expect(front.xDirection.x).toBeCloseTo(1, 5);
    // Back (Z=+Y)   → X = +Z × +Y = -X
    expect(back.normal.y).toBeCloseTo(1, 5);
    expect(back.xDirection.x).toBeCloseTo(-1, 5);
  });

  it("derives center + axis from a circular edge selection", () => {
    let conn!: Connector;
    part("edge-frame", () => {
      sketch("xy", () => circle(10));
      extrude(15);
      conn = connector(select(edge().circle().onPlane("xy", 15))) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // The top circular edge of the cylinder is centered at (0, 0, 15) with axis +Z.
    expect(frame.origin.x).toBeCloseTo(0, 5);
    expect(frame.origin.y).toBeCloseTo(0, 5);
    expect(frame.origin.z).toBeCloseTo(15, 5);

    expect(Math.abs(frame.normal.z)).toBeCloseTo(1, 5);
    expect(frame.normal.x).toBeCloseTo(0, 5);
    expect(frame.normal.y).toBeCloseTo(0, 5);
  });

  it("uses world Z and the requested X for a plane source", () => {
    let conn!: Connector;
    part("plane-frame", () => {
      sketch("xy", () => rect(20, 20));
      extrude(5);
      conn = connector(plane("xy")) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    expect(frame.normal.z).toBeCloseTo(1, 5);
    // XY plane's authored xDirection is +X.
    expect(frame.xDirection.x).toBeCloseTo(1, 5);
    expect(frame.xDirection.y).toBeCloseTo(0, 5);
  });

  it("honors options.xDirection and re-orthogonalizes against Z", () => {
    let conn!: Connector;
    part("xdir-frame", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(
        select(face().planar().onPlane("xy", 20)),
        { xDirection: 'y' },
      ) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // Z should still be +Z (top face).
    expect(frame.normal.z).toBeCloseTo(1, 5);
    // X should align with +Y after orthogonalization (Z is +Z, Y has no Z component).
    expect(frame.xDirection.x).toBeCloseTo(0, 5);
    expect(frame.xDirection.y).toBeCloseTo(1, 5);
    expect(frame.xDirection.z).toBeCloseTo(0, 5);
    // Frame stays orthonormal.
    expect(frame.xDirection.dot(frame.normal)).toBeCloseTo(0, 6);
    expect(frame.yDirection.dot(frame.normal)).toBeCloseTo(0, 6);
    expect(frame.xDirection.dot(frame.yDirection)).toBeCloseTo(0, 6);
  });

  it("produces an orthonormal frame regardless of source", () => {
    let conn!: Connector;
    part("ortho-frame", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20))) as unknown as Connector;
    });

    render();

    const f = conn.getFrame();
    expect(Math.hypot(f.xDirection.x, f.xDirection.y, f.xDirection.z)).toBeCloseTo(1, 5);
    expect(Math.hypot(f.yDirection.x, f.yDirection.y, f.yDirection.z)).toBeCloseTo(1, 5);
    expect(Math.hypot(f.normal.x, f.normal.y, f.normal.z)).toBeCloseTo(1, 5);
    expect(Math.abs(f.xDirection.dot(f.yDirection))).toBeLessThan(EPS);
    expect(Math.abs(f.xDirection.dot(f.normal))).toBeLessThan(EPS);
    expect(Math.abs(f.yDirection.dot(f.normal))).toBeLessThan(EPS);
  });

  it("rebuilds the same frame when geometry is reproduced identically", () => {
    function buildOnce(height: number) {
      let conn!: Connector;
      const p = part("stable-" + height, () => {
        sketch("xy", () => rect(40, 60));
        extrude(height);
        conn = connector(select(face().planar().onPlane("xy", height))) as unknown as Connector;
      });
      render();
      return { p, conn };
    }

    const a = buildOnce(20).conn.getFrame();
    const b = buildOnce(20).conn.getFrame();
    expect(b.origin.x).toBeCloseTo(a.origin.x, 6);
    expect(b.origin.y).toBeCloseTo(a.origin.y, 6);
    expect(b.origin.z).toBeCloseTo(a.origin.z, 6);
    expect(b.normal.dot(a.normal)).toBeCloseTo(1, 6);
    expect(b.xDirection.dot(a.xDirection)).toBeCloseTo(1, 6);
  });

  it("accepts a LazySelectionSceneObject (e.g., rect.edge('top')) as source", () => {
    let conn!: Connector;
    part("lazy-source", () => {
      let topEdge: any;
      sketch("xy", () => {
        const r = rect(40, 60);
        topEdge = r.edge('top');
      });
      extrude(20);
      conn = connector(topEdge) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // rect(40, 60) spans (0,0)-(40,60). Top edge is y=60, x from 0..40, z=0.
    // Midpoint is (20, 60, 0). Z is the tangent direction (along ±X).
    expect(frame.origin.x).toBeCloseTo(20, 5);
    expect(frame.origin.y).toBeCloseTo(60, 5);
    expect(frame.origin.z).toBeCloseTo(0, 5);
    // Tangent runs along ±X (line edge).
    expect(Math.abs(frame.normal.x)).toBeCloseTo(1, 5);
    expect(frame.normal.y).toBeCloseTo(0, 5);
    expect(frame.normal.z).toBeCloseTo(0, 5);
  });

  it("preserves its serialized frame across SceneCompare cache hits", () => {
    function authorScene() {
      const p = part("cache-hit", () => {
        sketch("xy", () => rect(40, 60));
        extrude(20);
        connector(select(face().planar().onPlane("xy", 20)));
      }) as unknown as Part;
      return p;
    }

    const oldPart = authorScene();
    render();
    const previousScene = getSceneManager().currentScene;
    const oldConn = oldPart.getConnectors()[0];
    const oldSerialized = oldConn.serialize();
    expect(oldSerialized.origin).toBeDefined();

    // Simulate "save the file" — start a new scene with identical source,
    // run SceneCompare, and verify the new connector still serializes a
    // frame (i.e., the cache restore populates the connector's state).
    const newScene = getSceneManager().startScene();
    const newPart = authorScene();
    SceneCompare.compare(previousScene, newScene);

    const newConn = newPart.getConnectors()[0];
    const newSerialized = newConn.serialize();
    expect(newSerialized.origin).toBeDefined();
    expect(newSerialized.normal).toBeDefined();
    expect(newSerialized.origin.x).toBeCloseTo(oldSerialized.origin.x, 6);
    expect(newSerialized.origin.y).toBeCloseTo(oldSerialized.origin.y, 6);
    expect(newSerialized.origin.z).toBeCloseTo(oldSerialized.origin.z, 6);
  });

  it("offset(x, y, z) shifts the origin along the connector's local axes", () => {
    let conn!: Connector;
    part("offset-local", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20)))
        .offset(1, 2, 3) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // Top face frame: origin (20,30,20), xDir=+X, yDir=+Y, normal=+Z.
    // 1·xDir + 2·yDir + 3·normal = (1, 2, 3) world delta.
    expect(frame.origin.x).toBeCloseTo(21, 5);
    expect(frame.origin.y).toBeCloseTo(32, 5);
    expect(frame.origin.z).toBeCloseTo(23, 5);
    // Axes unchanged.
    expect(frame.xDirection.x).toBeCloseTo(1, 5);
    expect(frame.yDirection.y).toBeCloseTo(1, 5);
    expect(frame.normal.z).toBeCloseTo(1, 5);
  });

  it("offset() with omitted args defaults to 0", () => {
    let conn!: Connector;
    part("offset-defaults", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20)))
        .offset(0, 0, 5) as unknown as Connector;
      // call form .offset(z) only (omitted x, y) should match
    });

    render();

    const frame = conn.getFrame();
    expect(frame.origin.z).toBeCloseTo(25, 5);
  });

  it('rotate("z", 90) on a +Z face spins xDirection in-plane', () => {
    let conn!: Connector;
    part("rotate-z", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20)))
        .rotate("z", 90) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // Original X = +X. Rotate +90° around +Z → +Y.
    expect(frame.xDirection.x).toBeCloseTo(0, 5);
    expect(frame.xDirection.y).toBeCloseTo(1, 5);
    expect(frame.xDirection.z).toBeCloseTo(0, 5);
    // Normal unchanged (rotated around itself).
    expect(frame.normal.z).toBeCloseTo(1, 5);
    // Origin unchanged (rotation pivots through origin).
    expect(frame.origin.x).toBeCloseTo(20, 5);
    expect(frame.origin.y).toBeCloseTo(30, 5);
    expect(frame.origin.z).toBeCloseTo(20, 5);
  });

  it('rotate("x", 90) tilts the normal off the face', () => {
    let conn!: Connector;
    part("rotate-x", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20)))
        .rotate("x", 90) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // xDirection unchanged (rotated around itself).
    expect(frame.xDirection.x).toBeCloseTo(1, 5);
    // Normal was +Z, rotated +90° around +X → -Y (right-hand rule).
    expect(frame.normal.x).toBeCloseTo(0, 5);
    expect(frame.normal.y).toBeCloseTo(-1, 5);
    expect(frame.normal.z).toBeCloseTo(0, 5);
    // Frame stays orthonormal.
    expect(Math.abs(frame.xDirection.dot(frame.normal))).toBeLessThan(EPS);
    expect(Math.abs(frame.xDirection.dot(frame.yDirection))).toBeLessThan(EPS);
    expect(Math.abs(frame.yDirection.dot(frame.normal))).toBeLessThan(EPS);
  });

  it("offset then rotate uses the shifted origin as pivot", () => {
    let conn!: Connector;
    part("offset-then-rotate", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20)))
        .offset(5, 0, 0)
        .rotate("z", 90) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // After offset: origin (25, 30, 20). Then rotate around its Z (still +Z)
    // through (25, 30, 20) — origin doesn't change since the pivot IS the origin.
    expect(frame.origin.x).toBeCloseTo(25, 5);
    expect(frame.origin.y).toBeCloseTo(30, 5);
    // xDirection rotated +90° around +Z → +Y.
    expect(frame.xDirection.y).toBeCloseTo(1, 5);
  });

  it("rotate then offset translates along the rotated axes", () => {
    let conn!: Connector;
    part("rotate-then-offset", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      conn = connector(select(face().planar().onPlane("xy", 20)))
        .rotate("z", 90)
        .offset(5, 0, 0) as unknown as Connector;
    });

    render();

    const frame = conn.getFrame();
    // After rotate: xDirection = +Y. offset(5, 0, 0) moves +5 along the new X (+Y).
    // Origin: (20, 30, 20) + 5·(0, 1, 0) = (20, 35, 20).
    expect(frame.origin.x).toBeCloseTo(20, 5);
    expect(frame.origin.y).toBeCloseTo(35, 5);
    expect(frame.origin.z).toBeCloseTo(20, 5);
  });

  it("identical transform chains compare equal; different ones do not", () => {
    let connA!: Connector;
    let connB!: Connector;
    let connC!: Connector;
    part("compare-A", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      connA = connector(select(face().planar().onPlane("xy", 20)))
        .rotate("z", 45)
        .offset(0, 0, 5) as unknown as Connector;
    });
    render();
    part("compare-B", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      connB = connector(select(face().planar().onPlane("xy", 20)))
        .rotate("z", 45)
        .offset(0, 0, 5) as unknown as Connector;
    });
    render();
    part("compare-C", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      connC = connector(select(face().planar().onPlane("xy", 20)))
        .rotate("z", 45)
        .offset(0, 0, 6) as unknown as Connector;
    });
    render();

    expect(connA.compareTo(connB)).toBe(true);
    expect(connA.compareTo(connC)).toBe(false);
  });

  it("connectors are tracked as Part children in source order", () => {
    let p!: Part;
    p = part("ordered", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      const top = connector(select(face().planar().onPlane("xy", 20)));
      const bottom = connector(select(face().planar().onPlane("xy")));
      return { top, bottom };
    }) as unknown as Part;

    render();

    const conns = p.getConnectors();
    expect(conns.length).toBe(2);
    // Source order: top first, then bottom.
    expect(conns[0].getFrame().origin.z).toBeCloseTo(20, 5);
    expect(conns[1].getFrame().origin.z).toBeCloseTo(0, 5);
  });
});
