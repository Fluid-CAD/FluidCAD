import { sketch, loft, plane } from 'fluidcad/core';
import { circle, rect } from 'fluidcad/core';

const s1 = sketch("xy", () => { circle(100) })
const s2 = sketch(plane("xy", { offset: 50 }), () => { rect(60).centered() })
const s3 = sketch(plane("xy", { offset: 100 }), () => { circle(40) })

loft(s1, s2, s3)
