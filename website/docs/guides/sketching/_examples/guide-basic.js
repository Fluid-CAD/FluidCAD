import { sketch, circle, line } from 'fluidcad/core';
import { coincident, equal, fix } from "fluidcad/constraints";

sketch("xy", () => {
    // The circumscribing circle is a guide — the hexagon snaps to it visually.
    circle([0, 0], 100).guide()
    const s1 = line([50, 0], [25, 43.30127]);
    const s2 = line([25, 43.30127], [-25, 43.30127]);
    const s3 = line([-25, 43.30127], [-50, 0]);
    const s4 = line([-50, 0], [-25, -43.30127]);
    const s5 = line([-25, -43.30127], [25, -43.30127]);
    const s6 = line([25, -43.30127], [50, 0]);
    coincident(s1.end(), s2.start());
    coincident(s2.end(), s3.start());
    coincident(s3.end(), s4.start());
    coincident(s4.end(), s5.start());
    coincident(s5.end(), s6.start());
    coincident(s6.end(), s1.start());
    equal(s1, s2);
    equal(s2, s3);
    equal(s3, s4);
    equal(s4, s5);
    equal(s5, s6);
    fix(s1.start(), [50, 0]);
})
