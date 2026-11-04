// @screenshot skip
// The wardrobe made insertable: an assembly definition whose body is the
// generator's layout, run with the insert's values. The assembly bar's
// Generate Parts dropdown and the Insert dialog list it; its dialog asks for the
// generator's values.
import { defineAssembly } from 'fluidcad/sdk';
import { WardrobeUnit } from './wardrobe-unit.js';

export const wardrobeAssembly = defineAssembly(WardrobeUnit, {
  label: 'Wardrobe', // the menu entry, the dialog's title and the sub-assembly's name
  description: 'A wardrobe as an assembly: the carcass, two hinged doors and drawers on runners',
  icon: './wardrobe.svg', // images are relative to this file
  // The dialog: as a feature's metadata lays it out.
  width: 'wide',
  layout: [
    { row: ['width', 'height', 'depth'] },
    { section: 'Drawers', items: [{ row: ['drawers', 'drawerFront'] }] },
    { section: 'Doors', items: ['doorSwing'] },
  ],
  aside: [{ image: './wardrobe-size.svg', alt: 'The width, height and depth of the carcass' }],
});
