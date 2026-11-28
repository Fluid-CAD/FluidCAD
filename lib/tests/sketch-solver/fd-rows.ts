import { expect } from "vitest";
import type { SketchSystem } from "../../sketch-solver/index.js";
import { makeLcg } from "../solver-core/synthetic.js";

/**
 * Finite-difference check of every compiled row of the system: at each
 * seed the params are perturbed by up to `amp`, and each row's analytic
 * partials (duplicate param slots summed) must match a central difference
 * of its residual.
 */
export function fdCheckRows(sys: SketchSystem, seeds: number[], amp: number): void {
  const compiled = sys.compiled();
  expect(compiled.rows.length).toBeGreaterThan(0);
  for (const seed of seeds) {
    const rand = makeLcg(seed);
    const p = new Float64Array(sys.values);
    for (let i = 0; i < p.length; i++) {
      p[i] += (rand() * 2 - 1) * amp;
    }
    for (let k = 0; k < compiled.rows.length; k++) {
      const row = compiled.rows[k];
      const analytic = new Float64Array(row.params.length);
      row.jac(p, analytic);
      const byParam = new Map<number, number>();
      for (let s = 0; s < row.params.length; s++) {
        byParam.set(row.params[s], (byParam.get(row.params[s]) ?? 0) + analytic[s]);
      }
      for (const [gp, an] of byParam) {
        const h = 1e-6 * Math.max(1, Math.abs(p[gp]));
        const saved = p[gp];
        p[gp] = saved + h;
        const plus = row.eval(p);
        p[gp] = saved - h;
        const minus = row.eval(p);
        p[gp] = saved;
        const fd = (plus - minus) / (2 * h);
        const record = sys.constraints()[compiled.rowConstraint[k]];
        expect(
          Math.abs(fd - an),
          `row ${k} (constraint ${record.id}, ${record.spec.kind}) ∂/∂p[${gp}]: fd=${fd} analytic=${an}`,
        ).toBeLessThanOrEqual(2e-5 + 1e-4 * Math.abs(an));
      }
    }
  }
}
