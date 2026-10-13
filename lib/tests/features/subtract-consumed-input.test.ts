import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import revolve from "../../core/revolve.js";
import subtract from "../../core/subtract.js";
import axis from "../../core/axis.js";
import translate from "../../core/translate.js";
import remove from "../../core/remove.js";
import { circle } from "../../core/2d/index.js";
import { Subtract } from "../../features/subtract.js";

describe("subtract: consumed-input diagnostic (issue #50)", () => {
  setupOC();

  function twoTori() {
    const torusAxis = axis('y', { offsetZ: 20 });

    sketch('yz', () => {
        circle([0, 0], 8);
      });
    const torus1 = revolve(torusAxis).name(' torus1');

    sketch('yz', () => {
        circle([0, 0], 8);
      });
    const torus2 = revolve(torusAxis).new().name(' torus2');
    return { torus1, torus2 };
  }

  it("explains which earlier op took an operand nothing stands for any more", () => {
    const { torus1, torus2 } = twoTori();
    remove(torus1);

    const sub = subtract(torus1, torus2) as Subtract;

    render();

    const err = sub.getError();
    expect(err).toMatch(/subtract:.*first operand.*has no shapes.*remove/);
    expect(err).toMatch(/Hint:/);
  });

  it("reads an operand a move took where the move left it", () => {
    const { torus1, torus2 } = twoTori();
    translate([0, 5, 0], torus1);

    const sub = subtract(torus1, torus2) as Subtract;

    render();

    expect(sub.getError()).toBeNull();
    expect(sub.getShapes({}, 'solid').length).toBeGreaterThanOrEqual(1);
  });
});
