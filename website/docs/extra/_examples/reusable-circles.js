// @screenshot skip
import { sketch, circle, extrude } from 'fluidcad/core';

sketch("xy", () => {
    circle([0, 0], 100);
    circle([0, 0], 50).reusable();
});

extrude();

extrude(50);
