// @screenshot skip
import { part, sketch, line, circle, extrude, cut, chamfer, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A cylinder body: 40 × 40 × 50 mm block with a Ø20 bore, 40 deep, from the top.
export const cylinder = part('Cylinder body', () => {
    sketch('xy', () => {
        const b = line([-20, -20], [20, -20]);
        const r = line([20, -20], [20, 20]);
        const t = line([20, 20], [-20, 20]);
        const l = line([-20, 20], [-20, -20]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [-20, -20]);
        distance(b.start(), b.end(), 40);
        distance(r.start(), r.end(), 40);
    });
    const body = extrude(50);
    sketch(body.endFaces(), () => {
        circle([0, 0], 20);
    });
    const bore = cut(40);
    chamfer(1, bore.startEdges());
    // The bore mouth: the top face's frame, centred on the bore with Z
    // pointing up the axis. A piston mated here sits on the axis; a Z
    // offset sets how deep it goes.
    connector('bore', select(face().planar().onPlane('xy', 50)));
});
