import { sketch, line, fillet, extrude, project, offset } from 'fluidcad/core';
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

// A rounded housing lid, 100 × 60 × 30.
sketch("xy", () => {
    const sg1 = line([-50, -30], [50, -30]);
    const sg2 = line([50, -30], [50, 30]);
    const sg3 = line([50, 30], [-50, 30]);
    const sg4 = line([-50, 30], [-50, -30]);
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
    fillet(8, sg1, sg2, sg3, sg4)
})

const e = extrude(30)

// A gasket that follows the lid's outline, drawn on its top face.
sketch(e.endFaces(), () => {
    // The top face outline, flattened onto this sketch as fixed reference
    // geometry. It is a guide so it stays out of the profile.
    const outline = project(e.endFaces()).guide()
    // Inset it — the offset is the gasket's inner edge; the region between
    // the two offsets is the gasket.
    offset(-4, outline)
    offset(-9, outline)
})
