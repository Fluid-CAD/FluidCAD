import { assembly, insert, mate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { standoff } from './asm-standoff.part.js';

export const groundedExample = assembly('grounded-example', () => {
    // highlight-start
    // Exactly one thing is grounded: it is the frame everything else is
    // solved against. Ground the part you would bolt to the bench.
    const base = insert(plate).grounded();
    // highlight-end

    // An ungrounded instance is free until a mate places it. The pose
    // written here is only where it starts.
    const post = insert(standoff).translate(0, 0, 40).name('Front-left standoff');

    mate('fastened', base.connectors.hole1, post.connectors.foot);
});
