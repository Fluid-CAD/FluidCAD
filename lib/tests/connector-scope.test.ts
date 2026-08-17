import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import select from "../core/select.js";
import part from "../core/part.js";
import connector from "../core/connector.js";
import insert from "../core/insert.js";
import { rect } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Connector } from "../features/connector.js";
import { Part } from "../features/part.js";

describe("connector scope", () => {
  setupOC();

  it("throws when called outside a part() block", () => {
    expect(() => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      connector("top", select(face().planar().onPlane("xy")));
    }).toThrow(/inside a part/i);
  });

  it("throws at assembly scope with a pointed migration error", () => {
    // Assembly-scoped (instance-bound) connectors were removed — the old
    // `connector('pivot', arm1.select(...))` form must fail loudly, pointing
    // at the part() declaration instead of the generic part-design-only error.
    getSceneManager().startAssemblyScene();
    const p = part("block", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      connector("top", select(face().planar().onPlane("xy", 10)));
    }) as unknown as Part;
    const a = insert(p);
    expect(() => {
      connector("pivot", a.connectors.top as unknown as Parameters<typeof connector>[1]);
    }).toThrow(/inside a part\(\) block/i);
  });

  it("throws when nested inside a sketch() callback", () => {
    // The part is found by scanning the container stack, but parenting goes
    // to the top container — a connector created here would become the
    // sketch's child and vanish from Part.getConnectors().
    expect(() => {
      part("nested", () => {
        sketch("xy", () => {
          rect(20, 20);
          connector("mid", select(face().planar().onPlane("xy")));
        });
        extrude(10);
      }).materialize();
    }).toThrow(/directly in the part\(\) body/i);
  });

  it("rejects unsupported source kinds", () => {
    expect(() => {
      part("bad-source", () => {
        sketch("xy", () => rect(20, 20));
        extrude(10);
        // @ts-expect-error — passing a raw object on purpose
        connector("top", { x: 0, y: 0, z: 0 });
      }).materialize();
    }).toThrow();
  });

  it("rejects a missing or non-identifier name", () => {
    for (const bad of ["", "top left", "1st", "a-b"]) {
      expect(() => {
        part(`bad-name-${bad}`, () => {
          sketch("xy", () => rect(20, 20));
          extrude(10);
          connector(bad, select(face().planar().onPlane("xy")));
        }).materialize();
      }).toThrow(/identifier/i);
    }
  });

  it("rejects a source passed where the name belongs (old positional form)", () => {
    expect(() => {
      part("old-form", () => {
        sketch("xy", () => rect(20, 20));
        extrude(10);
        // @ts-expect-error — old pre-name signature on purpose
        connector(select(face().planar().onPlane("xy")));
      }).materialize();
    }).toThrow(/name/i);
  });

  it("throws on a duplicate name within the same part", () => {
    expect(() => {
      part("dup-names", () => {
        sketch("xy", () => rect(20, 20));
        extrude(10);
        connector("mount", select(face().planar().onPlane("xy", 10)));
        connector("mount", select(face().planar().onPlane("xy")));
      }).materialize();
    }).toThrow(/already has a connector named "mount"/i);
  });

  it("allows the same name in two different parts", () => {
    const a = part("same-name-a", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      connector("mount", select(face().planar().onPlane("xy", 10)));
    }) as unknown as Part;
    const b = part("same-name-b", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      connector("mount", select(face().planar().onPlane("xy", 10)));
    }) as unknown as Part;

    expect(Object.keys(a.getNamedConnectors())).toEqual(["mount"]);
    expect(Object.keys(b.getNamedConnectors())).toEqual(["mount"]);
    expect(a.getNamedConnectors().mount).not.toBe(b.getNamedConnectors().mount);
  });

  it("returns connectors in source order via Part.getConnectors()", () => {
    const p = part("ordered", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      connector("top", select(face().planar().onPlane("xy", 20)));
      connector("bottom", select(face().planar().onPlane("xy")));
    }) as unknown as Part;

    render();

    const conns = p.getConnectors();
    expect(conns).toHaveLength(2);
    expect(conns[0].getFrame().origin.z).toBeCloseTo(20, 5);
    expect(conns[1].getFrame().origin.z).toBeCloseTo(0, 5);
  });

  it("registers every connector by name — no return statement needed", () => {
    const p = part("named", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      connector("mountTop", select(face().planar().onPlane("xy", 20)));
      connector("axleBore", select(face().planar().onPlane("xy")));
    }) as unknown as Part;

    const named = p.getNamedConnectors();
    expect(Object.keys(named).sort()).toEqual(["axleBore", "mountTop"]);
    expect(named.mountTop).toBeInstanceOf(Connector);
    expect(named.axleBore).toBeInstanceOf(Connector);
    expect(named.mountTop.connectorName).toBe("mountTop");
  });

  it("uses the connector name as the scene object's display name", () => {
    const p = part("display-name", () => {
      sketch("xy", () => rect(20, 20));
      extrude(10);
      connector("mountTop", select(face().planar().onPlane("xy", 10)));
    }) as unknown as Part;

    expect(p.getConnectors()[0].getName()).toBe("mountTop");
  });

  it("passes the user's free-form features object through unchanged", () => {
    const p = part("flat-features", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      const top = connector("top", select(face().planar().onPlane("xy", 20)));
      return { top, meta: { count: 1 } };
    }) as any;

    expect(p.features).toBeDefined();
    expect(p.features.top).toBeInstanceOf(Connector);
    expect(p.features.meta).toEqual({ count: 1 });
  });

  it("the features return no longer affects the named-connector map", () => {
    const p = part("features-ignored", () => {
      sketch("xy", () => rect(40, 60));
      extrude(20);
      const top = connector("top", select(face().planar().onPlane("xy", 20)));
      // A stale-style return renaming the connector must NOT change the map.
      return { connectors: { renamed: top } };
    }) as unknown as Part;

    expect(Object.keys(p.getNamedConnectors())).toEqual(["top"]);
  });
});
