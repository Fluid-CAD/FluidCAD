import { sketch, arc } from 'fluidcad/core';

sketch("xy", () => {
    arc(60, 90, 0)     // 270° arc: sweeps CCW the long way from 90° back to 0°
})
