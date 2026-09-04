import { part, sketch, line, circle, extrude, fillet, chamfer, color, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 4 mm cover that bolts onto the base plate: same outline and mounting
// holes, a Ø30 window over the pivot, edges broken and anodised blue.
export const cover = part('Cover', () => {
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
        fillet(6, b, r, t, l);
        circle([20, 0], 30);
        circle([-30, -17.5], 5);
        circle([30, -17.5], 5);
        circle([30, 17.5], 5);
        circle([-30, 17.5], 5);
    });
    const body = extrude(4);
    chamfer(0.5, body.endEdges());
    color('steelblue');

    // The underside — the face that lands on the base plate.
    connector('bottom', select(face().planar().onPlane('xy', 0)));
});
