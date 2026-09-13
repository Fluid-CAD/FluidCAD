import { circle, cut, extrude, repeat, sketch } from "fluidcad/core";

sketch("xy", () => {
    circle(72);
});

const body = extrude(34);

sketch(body.endFaces(), () => {
    circle(30);
});

cut();

sketch(body.endFaces(), () => {
    circle([36, 0], 16);
});

const flute = cut();

repeat("circular", "z", { count: 8, angle: 360 }, flute);
