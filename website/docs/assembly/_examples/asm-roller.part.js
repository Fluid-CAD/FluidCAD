import { part, sketch, circle, extrude, chamfer, color, select, expose } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

// A Ø20 × 30 roller with a Ø6 axle hole, lying along X. Its running surface
// is exposed so a tangent mate can rest it on another part.
export const roller = part('Roller', () => {
    sketch('yz', () => {
        circle([0, 0], 20);
        circle([0, 0], 6);
    });
    const body = extrude(30);
    chamfer(1, body.endEdges());
    color('tomato');
    expose('tread', select(face().cylinder(20)));
});
