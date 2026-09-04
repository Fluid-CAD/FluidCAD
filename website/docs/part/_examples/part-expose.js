import { part, sketch, circle, extrude, cut, color, plane, select, expose } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

// A pipe flange: Ø60 disc, 6 thick, with a Ø20 bore and four Ø6 bolt holes
// on a 44 mm bolt circle. It publishes the hole pattern and its sealing
// face; consumers read them as `flange.features.<name>`.
export const flange = part('Flange', () => {
    sketch('xy', () => {
        circle([0, 0], 60);
    });
    extrude(6);
    // The bore and the bolt pattern in one sketch. .reusable() keeps it
    // alive after the cut consumes it, so it can be published below.
    const holes = sketch('xy', () => {
        circle([0, 0], 20);
        circle([22, 0], 6);
        circle([0, 22], 6);
        circle([-22, 0], 6);
        circle([0, -22], 6);
    }).reusable();
    cut(-6, holes);   // negative: cut along the sketch normal, up through the disc

    // highlight-start
    // Publish the hole sketch under the name "holes" …
    expose('holes', holes);
    // … and the sealing face under "seal". A tangent mate in an assembly
    // reads this one as `instance.features.seal`.
    expose('seal', select(face().planar().onPlane('xy', 6)));
    // highlight-end
});

// A gasket for that flange, in the same file: a 2 mm disc 6 mm below the
// flange with the flange's own hole pattern cut through it.
export const gasket = part('Gasket', () => {
    sketch(plane('xy', { offset: -6 }), () => {
        circle([0, 0], 60);
    });
    extrude(-2);
    color('tomato');
    // The published sketch lies on the flange's plane (z = 0); cut 8 deep
    // from there to reach through the gasket.
    // highlight-next-line
    cut(8, flange.features.holes);
});
