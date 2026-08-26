import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// lib/sketch-solver/ must stay pure TS: it runs in the kernel (Node,
// P2) and the browser (P4 drag client), so imports may reach only its
// own modules and lib/solver-core/. This is the CI guard (the repo
// has no eslint config). It also pins the module list so new files
// get added here deliberately.

const SOLVER_DIR = resolve(import.meta.dirname, "../../sketch-solver");
const CORE_DIR = resolve(import.meta.dirname, "../../solver-core");

function tsFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...tsFiles(join(dir, entry.name), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

describe("sketch-solver purity", () => {
  const files = tsFiles(SOLVER_DIR);

  it("has the expected modules", () => {
    expect(files.sort()).toEqual([
      "constraints/angle.ts",
      "constraints/arc-consistency.ts",
      "constraints/coincident.ts",
      "constraints/collinear.ts",
      "constraints/concentric.ts",
      "constraints/distance.ts",
      "constraints/equal.ts",
      "constraints/fix.ts",
      "constraints/horizontal.ts",
      "constraints/index.ts",
      "constraints/midpoint.ts",
      "constraints/parallel.ts",
      "constraints/perpendicular.ts",
      "constraints/radius.ts",
      "constraints/symmetric.ts",
      "constraints/tangent.ts",
      "constraints/transform-tie.ts",
      "constraints/types.ts",
      "constraints/util.ts",
      "constraints/vertical.ts",
      "decompose.ts",
      "diagnose.ts",
      "index.ts",
      "solve.ts",
      "system.ts",
      "types.ts",
    ]);
  });

  for (const file of files) {
    it(`${file} imports only sketch-solver or solver-core modules`, () => {
      const src = readFileSync(join(SOLVER_DIR, file), "utf8");
      const specRe =
        /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
      for (let match = specRe.exec(src); match; match = specRe.exec(src)) {
        const spec = match[1] ?? match[2];
        expect(spec, `${file} imports "${spec}"`).toMatch(/^\.\.?\//);
        const target = resolve(SOLVER_DIR, file, "..", spec);
        const inside =
          target.startsWith(`${SOLVER_DIR}/`) || target.startsWith(`${CORE_DIR}/`);
        expect(inside, `${file} imports "${spec}" which resolves outside`).toBe(true);
      }
      expect(src).not.toMatch(/\brequire\s*\(/);
      expect(src).not.toMatch(/\bimport\s*\(/);
    });
  }
});
