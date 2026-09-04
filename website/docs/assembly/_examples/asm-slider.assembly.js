import { assembly, insert, mate } from 'fluidcad/core';
import { rail } from './asm-rail.part.js';
import { carriage } from './asm-carriage.part.js';

export const linearStage = assembly('linear-stage', () => {
    const track = insert(rail).grounded();
    const slide = insert(carriage).translate(0, 0, 40);

    // highlight-start
    // Slider leaves one degree of freedom: travel along the shared Z, which
    // both parts' frames point along their length. The carriage sits over
    // the rail and slides; .offset(0, 0, d) sets where it rests and
    // .limits() bounds the travel, both in document units (mm here).
    mate('slider', track.connectors.track, slide.connectors.slide).offset(0, 0, 25).limits(-45, 45);
    // highlight-end
});
