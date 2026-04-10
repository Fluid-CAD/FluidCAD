import { chamfer, cut, extrude, fillet, plane, repeat, select, sketch } from 'fluidcad/core';
import { edge, } from 'fluidcad/filters';
import { circle, move, rect } from 'fluidcad/core';

sketch(plane("xy"), () => {
    rect(200,100).center();
})

const e1 = extrude(20)

sketch(e1.endFaces(), () => {
    move([100-20, 50 - 20])
    rect(20, 20)
})

cut()

sketch(e1.endFaces(), () => {
    move([-100, -50])
    rect(85, 20)
})

const e2 = extrude(50);

sketch(e2.sideFaces(3), () => {
    move([-58, 85/2])
    circle(30)
})

const c1 = cut(20)
select(edge().onPlane("top", 20+50).parallelTo("yz"))

chamfer(15)
select(edge().onPlane("top", 20).onPlane("yz", -15))

const f2 = fillet(10)

repeat("mirror", "front", e2, c1, f2); // repeat the extrusion, cut and fillet but not the chamfer
