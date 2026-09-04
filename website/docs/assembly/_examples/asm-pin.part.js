import { part, sketch, circle, extrude, chamfer, color, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

// A headed pivot pin: Ø8 × 18 shaft under a Ø12 × 3 head, tip chamfered.
export const pin = part('Pivot pin', () => {
    sketch('xy', () => {
        circle([0, 0], 8);
    });
    const shaft = extrude(-18);          // down from the head's underside
    sketch('xy', () => {
        circle([0, 0], 12);
    });
    extrude(3);                           // the head, fused onto the shaft
    chamfer(1, shaft.endEdges());
    color('goldenrod');

    // Under the head: the face that seats on whatever the pin goes through.
    connector('head', select(face().planar().onPlane('xy', 0)));
    // The tip face, Z pointing out of the pin.
    connector('tip', shaft.endFaces());
});
