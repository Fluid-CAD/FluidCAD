// @screenshot skip
import { assembly, insert, mate } from 'fluidcad/core';
import { plate } from './asm-plate.part.js';
// highlight-next-line
import { gearPart } from '@fluidcad/gears'; // a generated part, imported by the package's name

export const drive = assembly('drive', () => {
  const plate1 = insert(plate).name('plate1').grounded();

  // Written by the Gear dialog's Apply: the values you changed, by id.
  // highlight-next-line
  const gearPart1 = insert(gearPart, { teeth: 18 }).name('gearPart1');

  // Written by the Revolute dialog: the plate's bore, then the gear's axis
  // connector, which the gear feature's axis frame became. A mate lays its
  // frames face to face; .flip() points the gear's axis the same way as the
  // bore's, so the gear stands on the plate.
  // highlight-next-line
  mate('revolute', plate1.connectors.bore, gearPart1.connectors.axis).flip();
});
