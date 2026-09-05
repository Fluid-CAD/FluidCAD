// @screenshot skip
import { part, sketch, circle, extrude, chamfer, color, select, connector } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

// A piston: Ø19.8 × 30 body with a chamfered crown and a Ø8 × 30 rod.
export const piston = part('Piston', () => {
    sketch('xy', () => {
        circle([0, 0], 19.8);
    });
    const body = extrude(30);
    chamfer(1, body.endEdges());
    sketch(body.endFaces(), () => {
        circle([0, 0], 8);
    });
    extrude(30);
    color('tomato');
    // The skirt: the bottom face, Z pointing down toward the bore floor.
    connector('skirt', select(face().planar().onPlane('xy', 0)));
});
