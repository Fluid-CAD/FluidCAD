import { part, sketch, line, circle, extrude, fillet, select, connector, expose } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// The base plate every assembly example bolts onto: 80 × 50 × 10 mm, rounded
// corners, a Ø8 pivot bore in the middle and four Ø5 mounting holes.
export const plate = part('Base plate', () => {
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
        // Round the four corners — a sketch fillet trims the lines and
        // inserts tangent arcs.
        fillet(6, b, r, t, l);
        // The pivot bore, 20 mm right of centre …
        circle([20, 0], 8);
        // … and the mounting holes near each corner.
        circle([-30, -17.5], 5);
        circle([30, -17.5], 5);
        circle([30, 17.5], 5);
        circle([-30, 17.5], 5);
    });
    extrude(10);

    // Mating frames. A face connector sits at the face centre with Z along
    // the outward normal; .offset() then moves it along the frame's own
    // X / Y / Z. Every frame here is the top face's, moved to where a part
    // will mate — the top-face frame keeps X along world X and Y along
    // world Y, so the offsets read like sketch coordinates.
    connector('top', select(face().planar().onPlane('xy', 10)));
    connector('bore', select(face().planar().onPlane('xy', 10))).offset(20, 0, 0);
    connector('hole1', select(face().planar().onPlane('xy', 10))).offset(-30, -17.5, 0);
    connector('hole2', select(face().planar().onPlane('xy', 10))).offset(30, -17.5, 0);
    connector('hole3', select(face().planar().onPlane('xy', 10))).offset(30, 17.5, 0);
    connector('hole4', select(face().planar().onPlane('xy', 10))).offset(-30, 17.5, 0);
    // The top face as contact geometry for tangent mates.
    expose('deck', select(face().planar().onPlane('xy', 10)));
});
