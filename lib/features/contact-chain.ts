import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Explorer } from "../oc/explorer.js";
import { TangentExpander } from "../filters/tangent-expander.js";
import { classifyContactShape, ContactEntity } from "../oc/contact-classify.js";

export type ContactClassification = {
  seed: ContactEntity | null;
  /** Tangent-propagation set, seed first; [] when the seed is unsupported. */
  chain: ContactEntity[];
};

/** The root among `roots` whose sub-shapes contain `seed` topologically. */
function findOwnerRoot(seed: Shape, roots: Shape[]): Shape | null {
  const isFace = seed instanceof Face;
  for (const root of roots) {
    const members: Shape[] = isFace
      ? Explorer.findFacesWrapped(root)
      : Explorer.findEdgesWrapped(root);
    if (members.some(m => m.isSame(seed))) {
      return root;
    }
  }
  return null;
}

/**
 * Classify an exposure's seed shape and its tangent-propagation chain: the
 * G1-connected face (or edge) set on the owning solid, walked with the
 * existing TangentExpander (BRepLib.ContinuityOfFaces — computed from
 * geometry, not stored flags). Chain members with unsupported forms are
 * dropped with a warning; an unsupported SEED nulls the whole result.
 */
export function classifyContact(seed: Shape, roots: Shape[]): ContactClassification {
  const seedEntity = classifyContactShape(seed);
  if (!seedEntity) {
    return { seed: null, chain: [] };
  }

  const root = findOwnerRoot(seed, roots);
  if (!root) {
    return { seed: seedEntity, chain: [seedEntity] };
  }

  const poolAll: Shape[] = seed instanceof Face
    ? Explorer.findFacesWrapped(root)
    : Explorer.findEdgesWrapped(root);
  // The pool re-wraps every sub-shape, so it contains an IsSame twin of the
  // seed — swap the twin for the seed wrapper itself or the walk would
  // report the seed twice.
  const pool = [seed, ...poolAll.filter(m => !m.isSame(seed))];

  const expanded = TangentExpander.expand([seed], pool);
  const chain: ContactEntity[] = [seedEntity];
  for (const member of expanded) {
    if (member === seed) {
      continue;
    }
    const entity = classifyContactShape(member);
    if (!entity) {
      console.warn(
        `tangent propagation: dropping a chain ${member instanceof Face ? 'face' : 'edge'} with an unsupported surface form`,
      );
      continue;
    }
    chain.push(entity);
  }
  return { seed: seedEntity, chain };
}
