import { sketch, line } from 'fluidcad/core';
import { coincident, horizontal, vertical, fix, distance, offsetFrom } from "fluidcad/constraints";

sketch("xy", () => {
    // An L-shaped path and its 4 mm offset. The corners are sharp: each
    // offset line is prolonged to where it meets the next one.
    const a = line([0, 0], [50, 0]);
    const b = line([50, 0], [50, 30]);
    const c = line([50, 30], [20, 30]);
    coincident(a.end(), b.start());
    coincident(b.end(), c.start());
    fix(a.start(), [0, 0]);
    horizontal(a);
    vertical(b);
    horizontal(c);
    distance(a.start(), a.end(), 50);
    distance(b.start(), b.end(), 30);
    distance(c.start(), c.end(), 30);
    // The offset: three lines held 4 from a, b and c, and a coincident at
    // each sharp corner. The free ends sit square across from the path's
    // ends on their own.
    // highlight-start
    const oa = line([0, -4], [54, -4]);
    const ob = line([54, -4], [54, 34]);
    const oc = line([54, 34], [20, 34]);
    offsetFrom([oa, ob, oc], [a, b, c], 4);
    coincident(oa.end(), ob.start());
    coincident(ob.end(), oc.start());
    // highlight-end
})
