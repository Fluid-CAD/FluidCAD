// A feature whose build() throws does not abort the render — the renderer
// records the message on that object and keeps going. So "the render
// resolved" is not "the model is right", and every render outcome the server
// reports (POST /api/render, /api/recompute, /api/rollback) has to carry the
// per-object failures or it reports success over a scene missing features.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import shell from '../../lib/core/shell.js';
import { circle } from '../../lib/core/2d/index.js';
import { face } from '../../lib/filters/index.js';
import { Extrude } from '../../lib/features/extrude.js';
import { FluidCadServer } from '../src/fluidcad-server.ts';

/** One entry of `scene.getRenderedObjects()`, trimmed to what the collector reads. */
function rendered(overrides: Record<string, unknown> = {}) {
  return {
    id: 'obj-1',
    name: 'Fillet',
    type: 'fillet',
    uniqueType: 'Fillet-1',
    hasError: false,
    ...overrides,
  };
}

describe('FluidCadServer.collectObjectErrors', () => {
  setupOC();

  it('reports a feature that failed to build during an otherwise fine render', () => {
    sketch('xy', () => {
      circle([0, 0], 100);
    });
    const e = extrude(50) as Extrude;
    // Lazy accessor selection that resolves to nothing — validate() can't see
    // it, so the failure only surfaces inside build().
    shell(-2, e.endFaces(face().circle(999)));

    const scene = render();
    const result = scene.getRenderedObjects();
    const errors = FluidCadServer.collectObjectErrors(result);

    expect(errors).toHaveLength(1);
    expect(errors[0].uniqueKind).toContain('shell');
    expect(errors[0].message).toContain('no faces');
    // The index addresses the same array `get_scene_summary` numbers, so the
    // agent can go straight from the error to the object (and to rollback_to).
    expect(result[errors[0].index].uniqueType).toBe(errors[0].uniqueKind);
    expect(result[errors[0].index].hasError).toBe(true);
  });

  it('returns nothing for a scene that built cleanly', () => {
    sketch('xy', () => {
      circle([0, 0], 100);
    });
    extrude(50);

    expect(FluidCadServer.collectObjectErrors(render().getRenderedObjects())).toEqual([]);
  });

  it('carries the fields needed to locate and fix the failure', () => {
    const errors = FluidCadServer.collectObjectErrors([
      rendered(),
      rendered({
        id: 'obj-2',
        name: 'Rim fillet',
        uniqueType: 'Fillet-2',
        hasError: true,
        errorMessage: 'Failed to fillet edges',
        sourceLocation: { filePath: '/ws/part.fluid.js', line: 12, column: 1 },
      }),
    ]);

    expect(errors).toEqual([
      {
        index: 1,
        id: 'obj-2',
        name: 'Rim fillet',
        uniqueKind: 'Fillet-2',
        message: 'Failed to fillet edges',
        sourceLocation: { filePath: '/ws/part.fluid.js', line: 12, column: 1 },
      },
    ]);
  });

  it('never reports an errored object without a message', () => {
    const errors = FluidCadServer.collectObjectErrors([rendered({ hasError: true })]);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Build failed.');
  });
});
