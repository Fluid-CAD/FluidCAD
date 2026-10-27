// @screenshot skip
import { assembly, insert } from 'fluidcad/core';
import { tray } from './package-tray.part.js';
// highlight-next-line
import { pcbPlate } from '@acme/mounting-hardware';   // a part from the package, imported by its name

// The controller enclosure: the project's own tray, with the package's PCB plate on it.
export const controller = assembly('controller', () => {
  insert(tray).grounded();
  // Written by Insert part; the translate is the pose you give it with the gizmo.
  // highlight-next-line
  const pcbPlate1 = insert(pcbPlate).name('pcbPlate1').translate(60, 40, 3);
});
