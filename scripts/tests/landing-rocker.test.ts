import { describe, expect, it } from 'vitest';
import * as core from '../../lib/core/index.js';
import * as constraints from '../../lib/core/constraints/index.js';
import * as filters from '../../lib/filters/index.js';
import { setupOC, render } from '../../lib/tests/setup.js';
import { STEPS, fileAt } from '../../website/src/landing/exchange/steps.js';

describe('landing page rocker arm', () => {
  setupOC();

  it.each(STEPS.map((step, index) => ({ label: step.label, index })))
  ('$label builds with every sketch fully constrained', ({ index }) => {
    // Execute the actual snippet displayed by the website against the local engine.
    const modules = { core, constraints, filters };
    const source = fileAt(index).code.replace(
      /import\s*\{([^}]+)\}\s*from\s*"fluidcad\/(core|constraints|filters)";/g,
      (_, names, module) => `const {${names}} = modules.${module};`,
    );
    new Function('modules', source)(modules);
    const objects = render().getRenderedObjects();
    expect(objects.filter(object => object.hasError)).toEqual([]);

    const sketches = objects.filter(object => object.uniqueType === 'sketch');
    expect(sketches).toHaveLength(
      STEPS.slice(0, index + 1).filter(step => step.feature === 'sketch').length,
    );
    for (const sketch of sketches) {
      expect(sketch.object.solver).toMatchObject({
        outcome: 'solved',
        dof: 0,
        conflicting: [],
        redundant: [],
      });
    }
  });
});
