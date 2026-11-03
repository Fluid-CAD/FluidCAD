// @screenshot skip
import { assembly, insert } from 'fluidcad/core';
// highlight-next-line
import { wardrobeAssembly } from '@fluidcad/cabinets'; // a generated assembly, imported by the package's name

export const bedroom = assembly('bedroom', () => {
  // Written by the Wardrobe dialog's Apply: the values you changed, by id.
  // Every other value is the wardrobe's default. Edit parameters… merges a
  // change into this object; Toggle grounded on the header added .grounded().
  // highlight-next-line
  const wardrobeAssembly1 = insert(wardrobeAssembly, { width: 1200, drawers: 3, drawerPlacement: 'outside' }).name('wardrobeAssembly1').grounded();

  // The carcass, the doors, the drawers and the joints between them are not
  // in this file: the wardrobe makes them from its values. An assembly mates
  // to them through the occurrence's parts, as it would a sub-assembly's:
  // wardrobeAssembly1.parts.carcass.connectors.<name>.
});
