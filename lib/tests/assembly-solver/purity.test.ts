import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// lib/assembly-solver/ runs wherever an assembly is solved: in the viewer on
// every drag frame, and in the engine (Node, or a browser worker) once per
// render. So it may depend on nothing but itself and the shared numeric core
// — no OCCT, no DOM, no Node builtins, no 3D library, nothing else of lib/.
// This test is the CI guard for that rule.

const SOLVER_DIR = join(import.meta.dirname, "../../assembly-solver");

describe("assembly-solver purity", () => {
  const files = readdirSync(SOLVER_DIR).filter((f) => f.endsWith(".ts"));

  it("has the expected modules", () => {
    expect(files.sort()).toEqual([
      "contact-model.ts",
      "graph.ts",
      "index.ts",
      "joint-model.ts",
      "loop-relaxation.ts",
      "mate-gap.ts",
      "math.ts",
      "model.ts",
      "relation-groups.ts",
      "relation-model.ts",
      "solver.ts",
      "types.ts",
      "warm-start.ts",
      "world-body.ts",
    ]);
  });

  for (const file of files) {
    it(`${file} imports only its own directory and lib/solver-core/`, () => {
      const src = readFileSync(join(SOLVER_DIR, file), "utf8");
      // import ... from 'x' | export ... from 'x' | bare import 'x'
      const specRe = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
      const specs: string[] = [];
      for (let match = specRe.exec(src); match; match = specRe.exec(src)) {
        specs.push(match[1] ?? match[2]);
      }
      for (const spec of specs) {
        expect(spec, `${file} imports "${spec}"`).toMatch(/^(\.\/[a-z-]+\.js|\.\.\/solver-core\/index\.js)$/);
      }
      expect(src).not.toMatch(/\brequire\s*\(/);
      expect(src).not.toMatch(/\bimport\s*\(/);
    });
  }
});
