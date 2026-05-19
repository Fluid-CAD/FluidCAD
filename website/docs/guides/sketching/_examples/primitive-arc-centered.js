import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    arc(60, 0, 90).centered()   // 90° sweep, centered on the +X tangent: −45° → 45°
})
