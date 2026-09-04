import { part, sketch, line, circle, extrude, fillet, color, plane, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A lever: 60 × 16 × 8 mm bar with rounded corners, a Ø8 pivot hole at one
// end and a Ø6 hole at the other. The pivot hole sits on the part's origin.
export const lever = part('Lever', () => {
    sketch('xy', () => {
        const b = line([-8, -8], [52, -8]);
        const r = line([52, -8], [52, 8]);
        const t = line([52, 8], [-8, 8]);
        const l = line([-8, 8], [-8, -8]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-8, -8]);
        distance(b.start(), b.end(), 60);
        distance(r.start(), r.end(), 16);
        fillet(6, b, r, t, l);
        circle([0, 0], 8);
        circle([44, 0], 6);
    });
    extrude(8);
    color('tomato');

    // The pivot frame: the part's XY plane at the hole, facing down like the
    // underside it lies in — Z out of the bottom face, ready to meet a
    // plate's upward frame face-to-face.
    connector('pivot', plane('-xy'));
    // Where the pin's head seats: the top face's frame moved back to the
    // hole (the face centre is 22 mm along the bar).
    connector('pinSeat', select(face().planar().onPlane('xy', 8))).offset(-22, 0, 0);
});
