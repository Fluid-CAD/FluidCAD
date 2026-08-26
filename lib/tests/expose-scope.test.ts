import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import part from "../core/part.js";
import expose from "../core/expose.js";
import insert from "../core/insert.js";
import param from "../core/param.js";
import { testRect } from "./helpers/profiles.js";
import { Part } from "../features/part.js";
import { Exposed } from "../features/exposed.js";

describe("expose scope", () => {
  setupOC();

  it("throws when called outside a part() block", () => {
    expect(() => {
      const s = sketch("xy", () => { testRect(20, 20); });
      expose("profile", s);
    }).toThrow(/inside a part/i);
  });

  it("throws at assembly scope with a pointed error", () => {
    getSceneManager().startAssemblyScene();
    const p = part("block", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      expose("profile", s);
    });
    insert(p);
    expect(() => {
      expose("profile", p.features.profile);
    }).toThrow(/inside a part\(\) block/i);
  });

  it("throws when nested inside a sketch() callback", () => {
    // The part is found by scanning the container stack, but parenting goes
    // to the top container — an exposure created here would become the
    // sketch's child and vanish from Part.getExposed().
    expect(() => {
      part("nested", () => {
        const s = sketch("xy", () => {
          const r = testRect(20, 20);
          expose("mid", r.b as any);
        });
        extrude(10, s);
      }).materialize();
    }).toThrow(/directly in the part\(\) body/i);
  });

  it("rejects raw non-scene-object sources", () => {
    expect(() => {
      part("bad-source", () => {
        sketch("xy", () => { testRect(20, 20); });
        extrude(10);
        // @ts-expect-error — passing a raw object on purpose
        expose("profile", { x: 0, y: 0, z: 0 });
      }).materialize();
    }).toThrow(/scene object/i);
  });

  it("rejects a missing or non-identifier name", () => {
    for (const bad of ["", "top left", "1st", "a-b"]) {
      expect(() => {
        part(`bad-name-${bad}`, () => {
          const s = sketch("xy", () => { testRect(20, 20); }).reusable();
          expose(bad, s);
        }).materialize();
      }).toThrow(/identifier/i);
    }
  });

  it("rejects a source passed where the name belongs (positional mixup)", () => {
    expect(() => {
      part("no-name", () => {
        const s = sketch("xy", () => { testRect(20, 20); }).reusable();
        // @ts-expect-error — source in the name slot on purpose
        expose(s);
      }).materialize();
    }).toThrow(/name/i);
  });

  it("throws on a duplicate name within the same part", () => {
    expect(() => {
      part("dup-names", () => {
        const s = sketch("xy", () => { testRect(20, 20); }).reusable();
        expose("profile", s);
        expose("profile", s);
      }).materialize();
    }).toThrow(/already exposes "profile"/i);
  });

  it("allows the same name in two different parts", () => {
    const a = part("same-name-a", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      expose("profile", s);
    });
    const b = part("same-name-b", () => {
      const s = sketch("xy", () => { testRect(30, 10); }).reusable();
      expose("profile", s);
    });

    expect(Object.keys(a.getNamedExposures())).toEqual(["profile"]);
    expect(Object.keys(b.getNamedExposures())).toEqual(["profile"]);
    expect(a.features.profile).not.toBe(b.features.profile);
  });

  it("registers an Exposed child on the part, named after the exposure", () => {
    const def = part("registered", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      expose("profile", s);
    });

    const exposures = def.getExposed();
    expect(exposures).toHaveLength(1);
    expect(exposures[0]).toBeInstanceOf(Exposed);
    expect(exposures[0].exposeName).toBe("profile");
    expect(exposures[0].getName()).toBe("profile");
  });

  it("features serves the SOURCE, not the Exposed wrapper", () => {
    const def = part("sources", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      expose("profile", s);
    });

    expect(def.features.profile.getType()).toBe("sketch");
    expect(def.features.profile).toBe(def.getExposed()[0].source);
  });

  it("a consumer part extrudes an exposed sketch into real geometry", () => {
    const donor = part("Donor", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      expose("profile", s);
    });
    part("Consumer", () => {
      extrude(15, donor.features.profile);
    });

    const scene = render();

    const consumer = scene.getAllSceneObjects().find(
      o => o instanceof Part && (o as Part).partName === "Consumer",
    ) as Part;
    const solids = consumer.getChildren().flatMap(c => c.getShapes(undefined, "solid"));
    expect(solids.length).toBeGreaterThan(0);
  });

  it("build() never consumes the source — the exposed sketch keeps its shapes", () => {
    const donor = part("keeps-source", () => {
      const s = sketch("xy", () => { testRect(20, 20); }).reusable();
      expose("profile", s);
    });

    render();

    expect(donor.features.profile.getShapes().length).toBeGreaterThan(0);
  });

  it("warns once per definition across variants when the callback returns an object", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getSceneManager().startAssemblyScene();
      const def = part("legacy", () => {
        const len = param("Length", 100) as number;
        sketch("xy", () => { testRect(len, 10); });
        const e = extrude(5);
        return { body: e };
      });
      insert(def, { Length: 100 });
      insert(def, { Length: 200 });
      expect(def.features).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("expose("));
    } finally {
      warn.mockRestore();
    }
  });
});
