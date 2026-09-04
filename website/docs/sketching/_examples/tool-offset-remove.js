import { sketch, line, offset } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
    // A pocket floor inset 10 from the plate's outline. The outline is
    // drawn as guides — only the offset contributes to the profile.
    const sg1 = line([-50, -30], [50, -30]).guide();
    const sg2 = line([50, -30], [50, 30]).guide();
    const sg3 = line([50, 30], [-50, 30]).guide();
    const sg4 = line([-50, 30], [-50, -30]).guide();
    coincident(sg1.end(), sg2.start());
    coincident(sg2.end(), sg3.start());
    coincident(sg3.end(), sg4.start());
    coincident(sg4.end(), sg1.start());
    horizontal(sg1);
    vertical(sg2);
    horizontal(sg3);
    vertical(sg4);
    fix(sg1.start(), [-50, -30]);
    distance(sg1.start(), sg1.end(), 100);
    distance(sg2.start(), sg2.end(), 60);
    // Explicit targets — a target-less offset() skips guides.
    // highlight-next-line
    offset(-10, sg1, sg2, sg3, sg4)
})
