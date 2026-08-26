// @screenshot waitForInput
import { arc, circle, cut, extrude, fillet, line, mirror, plane, project,
    repeat, sketch, xAxis } from "fluidcad/core";
import { coincident, collinear, concentric, diameter, distance, equal, fix,
    horizontal, radius, tangent, vertical } from "fluidcad/constraints";
import { edge } from "fluidcad/filters";

sketch("top", () => {
    const bottom = line([-60, -33], [60, -33]);
    const right = line([60, -33], [60, 33]);
    const top = line([60, 33], [-60, 33]);
    const left = line([-60, 33], [-60, -33]);

    coincident(bottom.end(), right.start());
    coincident(right.end(), top.start());
    coincident(top.end(), left.start());
    coincident(left.end(), bottom.start());
    horizontal(bottom);
    vertical(right);
    horizontal(top);
    vertical(left);
    fix(bottom.start(), [-60, -33]);
    distance(bottom.start(), bottom.end(), 120);
    distance(right.start(), right.end(), 66);

    fillet(13, bottom, right, top, left);
})
let e = extrude(13)

sketch(e.endFaces(), () => {
    const lower = line([60, -7], [50, -7]);
    const cap = arc([50, -7], [50, 7], [50, 0]).cw();
    const upper = line([50, 7], [60, 7]);
    const mouth = line([60, 7], [60, -7]);

    coincident(lower.end(), cap.start());
    coincident(cap.end(), upper.start());
    coincident(upper.end(), mouth.start());
    coincident(mouth.end(), lower.start());
    horizontal(lower);
    horizontal(upper);
    vertical(mouth);
    tangent(lower, cap);
    tangent(cap, upper);
    fix(cap.center(), [50, 0]);
    radius(cap, 7);
    distance(lower.start(), lower.end(), 10);
});

const notch = cut()

repeat("mirror", "yz", notch);

sketch("front", () => {
    const dome = arc([31, 0], [-31, 0], [0, 0]);
    const flat = line([-31, 0], [31, 0]);

    coincident(dome.end(), flat.start());
    coincident(flat.end(), dome.start());
    collinear(xAxis(), flat);
    fix(dome.center(), [0, 0]);
    radius(dome, 31);
});

const circleExtrude = extrude(66).symmetric();
cut(66, sketch("front", () => {
    const bore = circle([0, 0], 36);
    fix(bore.center(), [0, 0]);
    diameter(bore, 36);
})).symmetric();

const p = plane("front", { offset: 20 })

sketch(p, () => {
    const bore = project(circleExtrude.endEdges(edge().arc())).guide()
    const pipe = circle([0, 45], 16).guide()
    const l1 = line([26.644954, 15.844444], [6.876117, 49.088889]);
    const cap = arc([6.876117, 49.088889], [-6.876117, 49.088889], [0, 45]);
    const l2 = line([-6.876117, 49.088889], [-26.644954, 15.844444]);
    const bridge = arc([-26.644954, 15.844444], [26.644954, 15.844444], [0, 0]).cw();

    fix(pipe.center(), [0, 45]);
    diameter(pipe, 16);
    coincident(l1.end(), cap.start());
    coincident(cap.end(), l2.start());
    coincident(l2.end(), bridge.start());
    coincident(bridge.end(), l1.start());
    tangent(l1, cap);
    tangent(cap, l2);
    tangent(l2, bridge);
    tangent(bridge, l1);
    concentric(cap, pipe);
    equal(cap, pipe);
    concentric(bridge, bore);
    equal(bridge, bore);
});

extrude(11)

sketch(plane("front", { offset: 35 }), () => {
    const outer = circle([0, 45], 16);
    const inner = circle([0, 45], 10);

    fix(outer.center(), [0, 45]);
    concentric(inner, outer);
    diameter(outer, 16);
    diameter(inner, 10);
});

const pipeLength = -35 + 20;
const e2 = extrude(pipeLength).drill(false);

cut(-pipeLength, sketch(e2.startFaces(), () => {
    const rim = project(e2.startFaces()).guide();
    const bore = circle([0, 45], 10);

    concentric(bore, rim.ref(0));
    diameter(bore, 10);
}));

mirror("front")
