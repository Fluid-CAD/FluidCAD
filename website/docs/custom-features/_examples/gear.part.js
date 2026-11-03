// @screenshot skip
// The gear as a part an assembly inserts. The feature's typed-in values are
// the part's interface, by id: insert(gearPart, { teeth: 30, bore: 10 }).
// The face it stands on is a picked value, so the part leaves it out; the
// gear stands on the part's XY plane, and the assembly places the part.
import { definePart } from 'fluidcad/sdk';
import { Gear } from './gear.feature.js';

// highlight-start
export const gearPart = definePart(Gear, {
  label: 'Gear', // the menu entry, the dialog's title and the part's name
  description: 'A spur gear with a shaft bore, on its axis connector',
  icon: './gear.svg', // relative to this file
});
// highlight-end
// The feature's `axis` frame is the part's `axis` connector: a revolute
// mate turns the gear about it.
