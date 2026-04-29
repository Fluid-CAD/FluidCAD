import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import revolve from "../../core/revolve.js";
import subtract from "../../core/subtract.js";
import axis from "../../core/axis.js";
import translate from "../../core/translate.js";
import { circle } from "../../core/2d/index.js";
import { Subtract } from "../../features/subtract.js";

describe("subtract: consumed-input diagnostic (issue #50)", () => {
  setupOC();

  it("explains which earlier op consumed an empty operand", () => {
    const torusAxis = axis('y', { offsetZ: 20 });

    sketch('yz', () => {
      circle(8);
    });
    const torus1 = revolve(torusAxis).name(' torus1');
    translate([0, 5, 0], torus1);

    sketch('yz', () => {
      circle(8);
    });
    const torus2 = revolve(torusAxis).new().name(' torus2');

    const sub = subtract(torus1, torus2) as Subtract;

    render();

    const err = sub.getError();
    expect(err).toMatch(/subtract:.*first operand.*has no shapes.*translate/);
    expect(err).toMatch(/Hint:/);
  });
});
