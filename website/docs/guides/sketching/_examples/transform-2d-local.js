import { bezier, extrude, local, mirror, sketch } from 'fluidcad/core';

sketch("front", () => {
    const b = bezier([200, 200], [-120, 380], [200, 450], [0, 600])
    mirror(local("y"), b)
})

extrude(20)
