// @screenshot view from 260,110,80
import { sketch, line, circle, extrude, intersect, yAxis } from 'fluidcad/core';
import { coincident, distance, horizontal, vertical, symmetric } from "fluidcad/constraints";

// A Ø60 tube, 100 long with a 6 mm wall — a thin extrude of one circle,
// drawn on the yz plane so the tube runs along X, centred on the plane.
sketch("yz", () => {
    circle([0, 0], 60)
})
const tube = extrude(100).symmetric().thin(6)

// A divider plate, 6 thick, across the middle of the bore. It is drawn on
// the same yz plane, halfway along the tube, where nothing in the sketch
// says how wide the bore is — Intersect does.
sketch("yz", () => {
    // The tube's inner wall cut by the sketch plane: one circle, fixed
    // reference geometry the plate's corners can land on.
    const wall = intersect(tube.internalFaces()).guide()
    const b = line([-3, -24], [3, -24]);
    const r = line([3, -24], [3, 24]);
    const t = line([3, 24], [-3, 24]);
    const l = line([-3, 24], [-3, -24]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    distance(b.start(), b.end(), 6);
    symmetric(b.start(), b.end(), yAxis());
    // Two opposite corners on the wall: the plate spans the bore exactly,
    // and follows it if the tube changes.
    coincident(b.start(), wall);
    coincident(t.start(), wall);
})

// The plate, 10 long, centred on the plane like the tube.
extrude(10).symmetric()
