import { sketch, offset } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).center()
    offset(-10, true)
})
