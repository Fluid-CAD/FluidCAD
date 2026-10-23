// @screenshot hideGrid noAxes
import { assembly, insert, param, configurations, mate, relation } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
import { gear } from './asm-gear.part.js';

// A gear pair on the base plate, in three ratios. The param() calls are the
// assembly's parameters; each configurations() row names a set of their
// values, and Default is the param() literals — a 1:1 pair.
export const gearbox = assembly('gearbox', () => {
    // highlight-start
    // The first statement of the body, before any param(). One entry per
    // configuration; a row lists only the labels it changes, and a label it
    // leaves out keeps its param() literal. The return value is the name of
    // the row being built — 'Default' when none is.
    const configuration = configurations({
        'Ratio 2:1': { 'Wheel teeth': 24 },
        'Ratio 3:1': { 'Pinion teeth': 10, 'Wheel teeth': 30 },
    });
    // highlight-end

    // The parameters, declared once with their controls and bounds.
    const pinionTeeth = param('Pinion teeth', 12, 'number', { min: 8, max: 24, step: 1 });
    const wheelTeeth = param('Wheel teeth', 12, 'number', { min: 8, max: 48, step: 1 });

    // Everything a configuration changes follows from the values: the gears'
    // tooth counts, the axle spacing (module 3: each pitch radius is
    // 1.5 × the teeth, and the axles sit the sum of the two apart), the
    // wheel's mesh phase (turned to face the pinion, then half a tooth pitch
    // on, so a tooth meets the pinion's gap) and the gear relation's ratio.
    const centre = 1.5 * (pinionTeeth + wheelTeeth);
    const base = insert(plate).grounded();
    const pinion = insert(gear, { teeth: pinionTeeth }).translate(-centre / 2, 0, 10);
    const wheel = insert(gear, { teeth: wheelTeeth }).rotate('z', 180 + 180 / wheelTeeth).translate(centre / 2, 0, 10);
    const pinionAxle = mate('revolute', base.connectors.top, pinion.connectors.bore).offset(-centre / 2, 0, 0);
    const wheelAxle = mate('revolute', base.connectors.top, wheel.connectors.bore).offset(centre / 2, 0, 0);
    relation('gear', pinionAxle, wheelAxle, pinionTeeth / wheelTeeth).reverse();

    // highlight-start
    // A parameter only one row has. The large wheel overhangs the plate, so
    // the 3:1 gearbox gets a second plate under it; its offset is a
    // parameter that exists — in the panel and in the row — only while
    // 'Ratio 3:1' is built.
    if (configuration === 'Ratio 3:1') {
        const reach = param('Extension', 70, 'number', { min: 40, max: 120, step: 5 });
        insert(plate).translate(reach, 0, 0);
    }
    // highlight-end
});
