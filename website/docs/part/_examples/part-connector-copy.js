import { part, sketch, circle, extrude, cut, repeat, connector, copy, origin } from 'fluidcad/core';
import { coincident, diameter, fix } from 'fluidcad/constraints';

// A Ø120 pipe flange, 12 mm thick, with a Ø40 bore and six Ø10 bolt holes
// on a Ø90 bolt circle. Each hole gets a connector a bolt mates to — one
// declared on the first hole, and a copy of it on each of the other five.
export const flange = part('Pipe flange', () => {
    sketch('xy', () => {
        const rim = circle([0, 0], 120);
        coincident(rim.center(), origin());
        diameter(rim, 120);
    });
    const disc = extrude(12);

    sketch(disc.endFaces(), () => {
        const bore = circle([0, 0], 40);
        coincident(bore.center(), origin());
        diameter(bore, 40);
    });
    cut();

    // One bolt hole on the bolt circle, cut through, then repeated six
    // times around Z by the Repeat dialog.
    sketch(disc.endFaces(), () => {
        const c = circle([45, 0], 10);
        diameter(c, 10);
        fix(c.center(), [45, 0]);
    });
    const hole = cut();
    const holes = repeat('circular', 'z', { count: 6, angle: 360 }, hole);

    // highlight-start
    // The bolt seat on the first hole: its round top edge gives the frame
    // — origin at the hole's centre, Z along the hole's axis.
    const bolt = connector('bolt', hole.startEdges());
    // Copy dialog, type "Along a repeat": one copy of `bolt` on each hole
    // the repeat cut. bolt.instance(k) sits on holes.instance(k), so copy 3
    // of `bolt` is the hole three steps round. Change the repeat's count
    // and the copies follow it.
    copy(holes, bolt);
    // highlight-end
});
