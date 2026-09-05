// @screenshot skip
import { part, sketch, line, extrude, chamfer, color, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 30 × 30 × 15 mm clamp block with a chamfered top — the part that slides
// around on the base plate in the planar example.
export const clamp = part('Clamp block', () => {
    sketch('xy', () => {
        const b = line([-15, -15], [15, -15]);
        const r = line([15, -15], [15, 15]);
        const t = line([15, 15], [-15, 15]);
        const l = line([-15, 15], [-15, -15]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-15, -15]);
        distance(b.start(), b.end(), 30);
        distance(r.start(), r.end(), 30);
    });
    const body = extrude(15);
    chamfer(2, body.endEdges());
    color('seagreen');
    connector('bottom', select(face().planar().onPlane('xy', 0)));
});
