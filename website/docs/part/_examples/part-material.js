import { part, sketch, line, circle, extrude, chamfer } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A mounting plate: an 80 x 50 rectangle with a clearance hole near each
// corner, 6 mm thick, top edges chamfered. Its material is a chain on the
// part() statement — Set material… on the timeline row writes it.
export const plate = part('Plate', () => {
    sketch('xy', () => {
        const b = line([-40, -25], [40, -25]);
        const r = line([40, -25], [40, 25]);
        const t = line([40, 25], [-40, 25]);
        const l = line([-40, 25], [-40, -25]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-40, -25]);
        distance(b.start(), b.end(), 80);
        distance(r.start(), r.end(), 50);
        // One M5 clearance hole inset 8 mm from each corner.
        for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
                circle([sx * 32, sy * 17], 2.75);
            }
        }
    });
    const e = extrude(6);
    chamfer(1, e.endEdges());
// highlight-next-line
}).material('fluidcad-aluminum-6061');
