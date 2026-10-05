// @screenshot view iso-ftr hideDimensions hidePositional
import { part, sketch, circle, extrude, connector, hole, repeat } from 'fluidcad/core';
import { fix, diameter } from 'fluidcad/constraints';

// A flange: a 100 mm disc, 12 thick. One connector on the top face is the
// bolt seat; the hole is cut at it and then repeated around the axis.
part('Flange', () => {
    sketch("xy", () => {
        const rim = circle([0, 0], 100);
        fix(rim.center(), [0, 0]);
        diameter(rim, 100);
    });
    const disc = extrude(12);

    // The bolt seat: a connector at the centre of a small circle drawn on
    // the top face. Its Z points out of the face, so the hole drills in.
    const seat = sketch(disc.endFaces(), () => {
        const c = circle([38, 0], 6);
        fix(c.center(), [38, 0]);
        diameter(c, 6);
        return { c };
    });
    const bolt = connector('bolt', seat.geometries.c.center());

    // An M6 clearance hole at the connector, then five more around the axis.
    // The repeat takes the hole (the last feature); the connector stays put.
    hole('M6', bolt).clearance('normal');
    repeat('circular', 'z', { count: 6, angle: 360 });
});
