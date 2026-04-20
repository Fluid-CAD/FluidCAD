import { sketch, circle, extrude } from 'fluidcad/core';

sketch("xy", () => {
    circle(100);
    circle(50).reusable();
});

extrude();

extrude(50);
