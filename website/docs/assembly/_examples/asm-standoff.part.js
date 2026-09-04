import { part, sketch, circle, extrude, chamfer, color, connector } from 'fluidcad/core';

// A Ø8 × 15 standoff with a Ø4 through hole, chamfered on top.
export const standoff = part('Standoff', () => {
    sketch('xy', () => {
        circle([0, 0], 8);
        circle([0, 0], 4);
    });
    const body = extrude(15);
    chamfer(0.5, body.endEdges());
    color('goldenrod');
    // The foot: the face that sits on a mounting hole.
    connector('foot', body.startFaces());
});
