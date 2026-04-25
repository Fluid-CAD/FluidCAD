import { describe, it } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cylinder from "../../core/cylinder.js";
import { circle, rect, move } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";

// Run with `LOG_PERF=1 npm test -- --run lib/tests/perf/` to see the breakdown.
const LOG = process.env.LOG_PERF === "1";

function dump(scene: any, label: string, target: any) {
  if (!LOG) return;
  const rendered = scene.getRenderedObject(target);
  const categories: { category: string; durationMs: number }[] = rendered?.profileCategories ?? [];
  console.log(`\n=== ${label} ===`);
  console.log(`buildDurationMs=${rendered?.buildDurationMs?.toFixed(1)}ms`);
  for (const c of categories) {
    console.log(`  ${c.category.padEnd(30)} ${c.durationMs.toFixed(1)}ms`);
  }
}

describe("perf: record fusion history breakdown", () => {
  setupOC();

  it("simple cylinder + extrude fuse", () => {
    cylinder(20, 20);
    sketch("xy", () => { circle(8); });
    const e = extrude(40) as Extrude;
    const s = render();
    dump(s, "simple cylinder + extrude(40) fuse", e);
  });

  it("box + extrude fuse — bigger result", () => {
    sketch("xy", () => { rect(80, 80); });
    extrude(40);
    sketch("xy", () => { circle(15); });
    const e = extrude(80) as Extrude;
    const s = render();
    dump(s, "box(80,80,40) + extrude(80) fuse", e);
  });

  it("complex: many small holes through a big block", () => {
    sketch("xy", () => { rect(100, 100); });
    extrude(40);
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        sketch("xy", () => { move([i * 18 - 36, j * 18 - 36]); circle(3); });
      }
    }
    sketch("xy", () => { circle(40); });
    const e = extrude(40) as Extrude;
    const s = render();
    dump(s, "block + extrude over many holes", e);
  });

  it("very complex: big block with N small holes (single fuse)", () => {
    sketch("xy", () => { rect(200, 200); });
    extrude(40);

    const N = 8;
    sketch("xy", () => {
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          move([i * 22 - 80, j * 22 - 80]);
          circle(4);
        }
      }
    });
    const e = extrude(60) as Extrude;
    const s = render();
    dump(s, `block + single extrude with ${N*N} holes`, e);
  });

  it("incremental fuses: extrude many small features one-by-one", () => {
    sketch("xy", () => { rect(150, 150); });
    extrude(30);

    let last: Extrude | null = null;
    for (let i = 0; i < 10; i++) {
      sketch("xy", () => { move([i * 12 - 50, 0]); circle(4); });
      last = extrude(40) as Extrude;
    }
    const s = render();
    dump(s, "10th incremental extrude (after building up complexity)", last!);
  });
});
