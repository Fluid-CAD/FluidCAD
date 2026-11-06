// @screenshot skip
import { assembly, insert } from 'fluidcad/core';
// highlight-next-line
import { cabinetAssembly } from '@fluidcad/cabinets'; // a generated assembly, imported by the package's name

export const bedroom = assembly('bedroom', () => {
  // Written by the Cabinet dialog's Apply: the values you changed, by id.
  // Every other value is the cabinet's default for a wardrobe. Edit parameters…
  // merges a change into this object; Toggle grounded on the header added .grounded().
  // highlight-next-line
  const cabinetAssembly1 = insert(cabinetAssembly, { type: 'wardrobe', width: 1200, drawerPlacement: 'outside', drawers: 3 }).name('cabinetAssembly1').grounded();

  // The carcass, the doors, the drawers and the joints between them are not
  // in this file: the cabinet makes them from its values. An assembly mates
  // to them through the occurrence's parts, as it would a sub-assembly's:
  // cabinetAssembly1.parts.carcass.connectors.<name>.
});
