import { sketch, plane, loft, line, circle, bezier, mirror, local } from 'fluidcad/core';
import { coincident, equal, perpendicular, fix } from 'fluidcad/constraints';

const p1 = sketch("top", () => {
    // A square rotated 45°, 50 across the flats
    const s1 = line([35.355339, 0], [0, 35.355339]);
    const s2 = line([0, 35.355339], [-35.355339, 0]);
    const s3 = line([-35.355339, 0], [0, -35.355339]);
    const s4 = line([0, -35.355339], [35.355339, 0]);
    coincident(s1.end(), s2.start());
    coincident(s2.end(), s3.start());
    coincident(s3.end(), s4.start());
    coincident(s4.end(), s1.start());
    equal(s1, s2);
    equal(s2, s3);
    equal(s3, s4);
    perpendicular(s1, s2);
    fix(s1.start());
  })

const p2 = sketch(plane("top", 80), () => {
    circle([0, 0], 30);
  })

// One sketch, two rails: the bezier and its mirror each count as one guide
const g1 = sketch("right", () => {
    bezier([Math.sqrt(2) * 25, 0], [50, 40], [15, 80])
    mirror(local("y"))
}).reusable()

// highlight-next-line
loft(p1, p2).guides(g1)
