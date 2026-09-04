import { part, sketch, line, extrude, chamfer, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 120 mm linear rail: a 20 × 12 bar along X with chamfered top edges.
export const rail = part('Rail', () => {
    sketch('xy', () => {
        const b = line([-60, -10], [60, -10]);
        const r = line([60, -10], [60, 10]);
        const t = line([60, 10], [-60, 10]);
        const l = line([-60, 10], [-60, -10]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-60, -10]);
        distance(b.start(), b.end(), 120);
        distance(r.start(), r.end(), 20);
    });
    const body = extrude(12);
    chamfer(1.5, body.endEdges());
    // The track frame: the top-face frame turned so Z runs along the rail.
    // A slider mate frees exactly that direction.
    connector('track', select(face().planar().onPlane('xy', 12))).rotate('y', 90);
});
