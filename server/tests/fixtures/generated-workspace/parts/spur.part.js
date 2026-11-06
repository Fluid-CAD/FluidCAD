import { definePart } from 'fluidcad/sdk';
import { Spur } from '../features/spur.feature.js';

// The spur feature as an insertable part: its values by id, its axis a connector.
export const spurPart = definePart(Spur, {
  label: 'Spur gear',
  description: 'A spur gear blank, inserted with its values by id.',
  icon: '../features/icons/spur.svg',
});
