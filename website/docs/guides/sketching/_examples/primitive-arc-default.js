import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    arc(60)     // defaults: 0° → 180°, centered at the current position
})
