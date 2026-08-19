import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// lib/solver-core/ must stay dependency-free: it runs in the kernel
// (Node) and the browser (assembly solver + P4 sketch-solver client),
// so no OCCT, no DOM, no Node builtins, no third-party packages.
// Relative imports within the directory are the only imports allowed.
// This test is the CI guard for that rule.

const CORE_DIR = join(import.meta.dirname, "../../solver-core");

describe("solver-core purity", () => {
  const files = readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts"));

  it("has the expected modules", () => {
    expect(files.sort()).toEqual(["index.ts", "linalg.ts", "lm.ts", "rank.ts"]);
  });

  for (const file of files) {
    it(`${file} imports nothing outside lib/solver-core/`, () => {
      const src = readFileSync(join(CORE_DIR, file), "utf8");
      // import ... from 'x' | export ... from 'x' | bare import 'x'
      const specRe = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
      const specs: string[] = [];
      for (let match = specRe.exec(src); match; match = specRe.exec(src)) {
        specs.push(match[1] ?? match[2]);
      }
      for (const spec of specs) {
        expect(spec, `${file} imports "${spec}"`).toMatch(/^\.\/[a-z-]+\.js$/);
      }
      expect(src).not.toMatch(/\brequire\s*\(/);
      expect(src).not.toMatch(/\bimport\s*\(/);
    });
  }
});
