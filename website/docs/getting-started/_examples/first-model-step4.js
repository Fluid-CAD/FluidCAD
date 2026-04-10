import { sketch, extrude } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center().radius(8)
})

const box = extrude(30)
