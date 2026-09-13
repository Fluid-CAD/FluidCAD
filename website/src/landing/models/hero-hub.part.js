import { circle, cut, extrude, fillet, rect, repeat, select, sketch } from "fluidcad/core";
import { edge } from "fluidcad/filters";

sketch("xy", () => {
    rect(90, 70).centered().radius(12);
});

const plate = extrude(12);

sketch(plate.endFaces(), () => {
    circle([0, 0], 34);
});

const hub = extrude(26);

sketch(hub.endFaces(), () => {
    circle([0, 0], 16);
});

cut();

sketch(plate.endFaces(), () => {
    circle([-31, -23], 9);
});

const bolt = cut();

repeat("linear", ["x", "y"], { count: [2, 2], offset: [62, 46] }, bolt);

select(edge().circle(34).below("xy", 20));

fillet(4);
