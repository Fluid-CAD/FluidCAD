// @screenshot skip
import { part, sketch, line, extrude } from 'fluidcad/core';
import { coincident, horizontal, vertical, distance, fix } from 'fluidcad/constraints';
// highlight-next-line
import { standoff } from '@acme/mounting-hardware';   // written by the dialog: the package's name, not a path

// A 120 × 80 × 3 electronics tray with a standoff in the middle of its top face.
export const tray = part('Electronics tray', () => {
  sketch('xy', () => {
    const b = line([0, 0], [120, 0]);
    const r = line([120, 0], [120, 80]);
    const t = line([120, 80], [0, 80]);
    const l = line([0, 80], [0, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [0, 0]);
    distance(b.start(), b.end(), 120);
    distance(r.start(), r.end(), 80);
  });
  const e = extrude(3);

  // The package's Standoff on the tray's top face: 8 tall, an M3 clearance bore.
  // Only the values that differ from the feature's defaults are written.
  // highlight-next-line
  standoff(e.endFaces(), { height: 8, hole: 3.2 });
});
