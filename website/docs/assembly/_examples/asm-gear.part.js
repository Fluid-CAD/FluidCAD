// @screenshot skip
import { part, param, sketch, line, circle, extrude, cut, repeat, color, plane, connector } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from 'fluidcad/constraints';

// A spur gear, 3 mm module: the pitch radius is 1.5 × the tooth count.
// A disc with a Ø8 bore, teeth cut as evenly spaced notches around the rim.
export const gear = part('Gear', () => {
    const teeth = param('teeth', 12, 'number', { min: 8, max: 48, step: 1 });
    const pitchRadius = teeth * 1.5;
    sketch('xy', () => {
        // circle() takes a diameter: the blank reaches 3 mm past the pitch
        // circle, and the bore is Ø8.
        circle([0, 0], 2 * (pitchRadius + 3));
        circle([0, 0], 8);
    });
    const disc = extrude(8);
    // One notch at the rim — a 5.5 × 3 mm slot straddling the pitch circle,
    // drawn on the top face and cut down through the disc — repeated around
    // the axis, once per tooth.
    sketch(disc.endFaces(), () => {
        const b = line([pitchRadius - 1.5, -1.5], [pitchRadius + 4, -1.5]);
        const r = line([pitchRadius + 4, -1.5], [pitchRadius + 4, 1.5]);
        const t = line([pitchRadius + 4, 1.5], [pitchRadius - 1.5, 1.5]);
        const l = line([pitchRadius - 1.5, 1.5], [pitchRadius - 1.5, -1.5]);
        coincident(b.end(), r.start());
        coincident(r.end(), t.start());
        coincident(t.end(), l.start());
        coincident(l.end(), b.start());
        horizontal(b);
        horizontal(t);
        vertical(r);
        vertical(l);
        fix(b.start(), [pitchRadius - 1.5, -1.5]);
        distance(b.start(), b.end(), 5.5);
        distance(r.start(), r.end(), 3);
    });
    cut(8);
    repeat('circular', 'z', { count: teeth, angle: 360 });
    color('steelblue');

    // The bore frame on the underside: Z out of the bottom face, ready to
    // meet an axle frame that points up.
    connector('bore', plane('-xy'));
});
