import { part, sketch, line, circle, extrude, cut, plane, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A 40 × 40 × 40 angle bracket, 4 mm thick, with two mounting holes in
// each leg — and named connectors on the faces other parts mate to. In a
// part file the connectors render as small axis triads on their geometry;
// an assembly mates to them as `bracket.connectors.<name>`.
export const bracket = part('Angle bracket', () => {
    // The L profile on the front plane: base along X, upright along Z.
    sketch('xz', () => {
        const l1 = line([0, 0], [40, 0]);
        const l2 = line([40, 0], [40, 4]);
        const l3 = line([40, 4], [4, 4]);
        const l4 = line([4, 4], [4, 40]);
        const l5 = line([4, 40], [0, 40]);
        const l6 = line([0, 40], [0, 0]);
        coincident(l1.end(), l2.start());
        coincident(l2.end(), l3.start());
        coincident(l3.end(), l4.start());
        coincident(l4.end(), l5.start());
        coincident(l5.end(), l6.start());
        coincident(l6.end(), l1.start());
        horizontal(l1);
        horizontal(l3);
        horizontal(l5);
        vertical(l2);
        vertical(l4);
        vertical(l6);
        fix(l1.start(), [0, 0]);
        distance(l1.start(), l1.end(), 40);
        distance(l6.start(), l6.end(), 40);
        distance(l2.start(), l2.end(), 4);
        distance(l5.start(), l5.end(), 4);
    });
    extrude(40).symmetric();

    // Mounting holes: two down through the base, two through the upright.
    sketch(plane('xy', { offset: 4 }), () => {
        circle([25, -12], 5);
        circle([25, 12], 5);
    });
    cut(4);
    sketch(plane('yz', { offset: 4 }), () => {
        circle([-12, 25], 5);
        circle([12, 25], 5);
    });
    cut(4);

    // highlight-start
    // A face connector sits at the face's centre with Z along its outward
    // normal — the frame another part's face is mated face-to-face against.
    // The underside of the base:
    connector('foot', select(face().planar().onPlane('xy', 0)));
    // The back of the upright, for hanging the bracket on a wall or beam:
    connector('back', select(face().planar().onPlane('yz', 0)));
    // The two base holes: the top-of-base frame moved along its own X / Y
    // to each hole centre, where a standoff or a bolt head seats.
    connector('hole1', select(face().planar().onPlane('xy', 4))).offset(3, -12, 0);
    connector('hole2', select(face().planar().onPlane('xy', 4))).offset(3, 12, 0);
    // highlight-end
});
