import { part, param, sketch, circle, extrude, cut, plane, property, origin, color } from 'fluidcad/core';
import { coincident, diameter } from 'fluidcad/constraints';

// A round housing with a pocket cut down from the top. The pocket's size is
// what another part has to fit, so the housing publishes it instead of
// leaving the consumer to redo the arithmetic.
export const housing = part('Housing', () => {
    const width = param('Width', 60, 'number', { min: 30, max: 200, step: 5 });
    const wall = param('Wall', 4, 'number', { min: 2, max: 10, step: 0.5 });
    const height = param('Height', 25);

    sketch('xy', () => {
        const c = circle([0, 0], width);
        coincident(c.center(), origin());
        diameter(c, width);
    });
    extrude(height);
    sketch(plane('xy', { offset: height }), () => {
        const c = circle([0, 0], width - 2 * wall);
        coincident(c.center(), origin());
        diameter(c, width - 2 * wall);
    });
    cut(height - wall);   // down into the body, leaving the floor

    // highlight-start
    // Published values, computed from the parameters. A part reads them as
    // `housing.properties.<name>`, an assembly as `instance.properties.<name>`.
    property('Pocket diameter', 'pocketDiameter', width - 2 * wall);
    property('Pocket depth', 'pocketDepth', height - wall);
    property('Bolt count', 'boltCount', 4);
    // highlight-end
});

// A plug sized from the housing's published pocket — in a part file this
// reads the housing's DEFAULT variant.
export const plug = part('Plug', () => {
    // highlight-next-line
    const d = housing.properties.pocketDiameter - 0.4;   // 0.2 mm clearance per side
    sketch(plane('xy', { offset: 90 }), () => {
        const c = circle([0, 0], d);
        coincident(c.center(), origin());
        diameter(c, d);
    });
    extrude(housing.properties.pocketDepth);
    color('tomato');
});
