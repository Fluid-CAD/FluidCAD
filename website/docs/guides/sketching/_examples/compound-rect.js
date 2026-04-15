import { sketch } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).centered().radius(5)
})
