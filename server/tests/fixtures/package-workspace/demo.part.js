// A test model the package workspace renders its features in. It is not
// one of the package's exports, so it never ships.

import { part, sketch, line, extrude, select } from 'fluidcad/core';
import { coincident, fix } from 'fluidcad/constraints';
import { face } from 'fluidcad/filters';
import { standoff } from './standoff.feature.js';

export const demo = part('Demo plate', () => {
  sketch('xy', () => {
    const a = line([0, 0], [40, 0]); const b = line([40, 0], [40, 30]); const c = line([40, 30], [0, 30]); const d = line([0, 30], [0, 0]);
    coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());
    fix(a.start(), [0, 0]); fix(b.start(), [40, 0]); fix(c.start(), [40, 30]); fix(d.start(), [0, 30]);
  });
  extrude(5);
  standoff(select(face().planar().onPlane('xy', 5)), { height: 12 });
});
