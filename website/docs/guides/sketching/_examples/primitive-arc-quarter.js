import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    arc(60, 0, 90)     // quarter arc, from 0° (tangent +X) to 90° (tangent +Y)
})
