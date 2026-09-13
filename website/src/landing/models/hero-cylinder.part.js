import { circle, cut, extrude, sketch } from "fluidcad/core";
import { diameter, fix } from "fluidcad/constraints";

sketch("xy", () => {
    const outer = circle([0, 0], 60);
    fix(outer.center(), [0, 0]);
    diameter(outer, 60);
});

const body = extrude(40);

sketch(body.endFaces(), () => {
    const bore = circle([0, 0], 24);
    fix(bore.center(), [0, 0]);
    diameter(bore, 24);
});

cut();
