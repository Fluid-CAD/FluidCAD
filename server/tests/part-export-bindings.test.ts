import { describe, it, expect, beforeEach } from 'vitest';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { PartExportBindings } from '../src/host/scene-host.ts';
import { createManager, getSceneManager } from '../../lib/dist/scene-manager.js';
import { createParamRegistry, getParamRegistry } from '../../lib/dist/index.js';
import param from '../../lib/dist/core/param.js';
import part from '../../lib/dist/core/part.js';

// A part body's hidden identity is its export binding (lib PartIdentity):
// the Vite host hands every exported definition its binding after the module
// evaluated and before it builds the first body, so two `part('Plate', …)`
// exported as `plate` and `lid` are two bodies — whichever builds first, and
// whether a body builds from the host's loop or on another body's read.

/** The host's own `loadModule`, with Vite's module loader answering `mod`. */
function hostReturning(mod: Record<string, unknown>): LocalSceneHost {
  const host = new LocalSceneHost();
  (host as unknown as { server: { ssrLoadModule: () => Promise<Record<string, unknown>> } }).server = {
    ssrLoadModule: async () => mod,
  };
  return host;
}

const widths = () => getParamRegistry().getDefinitions()
  .filter((def) => def.label === 'Width')
  .map((def) => [def.body, def.bodyName, def.currentValue]);

beforeEach(() => {
  (getSceneManager() ?? createManager('')).startScene();
  createParamRegistry();
});

describe('LocalSceneHost.loadModule — part identities', () => {
  it('binds every export before the first body builds, so a body read on demand is named too', async () => {
    const plate = part('Plate', () => {
      param('Width', 100);
    });
    // The lid comes first in the module and reads the plate mid-body.
    const lid = part('Plate', () => {
      void plate.features;
      param('Width', 40);
    });
    await hostReturning({ lid, plate }).loadModule('/ws/pair.part.js');
    expect(widths()).toEqual([['plate', 'Plate', 100], ['lid', 'Plate', 40]]);
  });

  it('binds a factory\'s part to the factory\'s export name', async () => {
    const make = () => part('Plate', () => {
      param('Width', 7);
    });
    await hostReturning({ makePlate: make }).loadModule('/ws/factory.part.js');
    expect(widths()).toEqual([['makePlate', 'Plate', 7]]);
  });

  it('leaves `default` and non-part exports alone', () => {
    const plate = part('Plate', () => {});
    PartExportBindings.bindAll({ default: plate, size: 3, helper: () => 1 });
    expect(plate.getBodyId()).toBe('Plate#1');
  });
});
