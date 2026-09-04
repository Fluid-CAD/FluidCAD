import { sketch, fillet } from 'fluidcad/core';
import { line } from 'fluidcad/core';
import { coincident, equal, fix } from 'fluidcad/constraints';

sketch("xy", () => {
    // Regular pentagon, 100 across the corners
    const s1 = line([50, 0], [15.450850, 47.552826]);
    const s2 = line([15.450850, 47.552826], [-40.450850, 29.389263]);
    const s3 = line([-40.450850, 29.389263], [-40.450850, -29.389263]);
    const s4 = line([-40.450850, -29.389263], [15.450850, -47.552826]);
    const s5 = line([15.450850, -47.552826], [50, 0]);
    coincident(s1.end(), s2.start());
    coincident(s2.end(), s3.start());
    coincident(s3.end(), s4.start());
    coincident(s4.end(), s5.start());
    coincident(s5.end(), s1.start());
    equal(s1, s2);
    equal(s2, s3);
    equal(s3, s4);
    equal(s4, s5);
    fix(s1.start());
    fillet(10, s1, s2, s3, s4, s5)
  })
