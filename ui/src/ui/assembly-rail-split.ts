/**
 * How the assembly rail divides its column between Parts, Connectors,
 * Joints and Parameters. Parts holds half of the column whenever it is
 * open alongside anything else; the other open sections share the rest
 * equally, giving each a sixth when all three are open.
 * A closed section drops to its header and hands its room back, so with
 * Parts closed the remaining sections split the column between them, and a
 * section open on its own has all of it.
 *
 * Those are the shares under contention. Each host is also capped at its
 * own rows (`max-h-max`) and every open one grows, so a section that wants
 * less than its share stops there and the others take what it freed — the
 * same terms as the part-design column (see accordion-section.ts).
 */

export type RailSection = 'parts' | 'connectors' | 'joints' | 'params';

/** Which sections are open; a section nothing is mounted in counts as closed. */
export type RailOpenState = Record<Exclude<RailSection, 'params'>, boolean> & { params?: boolean };

/** The class string for each section's host, in the column's order. */
export type RailSplit = Record<RailSection, string>;

/**
 * Every host is a nested column of header + scrolling body, capped at its
 * rows — and the positioning context for its section's row menus, which
 * are measured against the host's rect. The split rewrites the host's whole
 * class list, so `relative` has to live here rather than be patched on by
 * the section (it would go with the first re-split, and the menu would then
 * resolve against the column and open over Parts).
 */
const HOST_BASE = 'relative flex flex-col gap-1 min-h-0 max-h-max';

/** A closed section is exactly its header: no claim on the column, never crushed. */
const CLOSED = 'grow-0 shrink-0 basis-auto';

/** Tailwind's spelling of each share the policy can hand out. */
const BASIS: Record<string, string> = {
  '1': 'basis-full',
  '0.5': 'basis-1/2',
  '0.25': 'basis-1/4',
  [String(1 / 3)]: 'basis-1/3',
  [String(1 / 6)]: 'basis-1/6',
};

function host(open: boolean, share: number): string {
  if (!open) {
    return `${HOST_BASE} ${CLOSED}`;
  }
  const basis = BASIS[String(share)];
  if (basis === undefined) {
    throw new Error(`assembly rail: no basis class for share ${share}`);
  }
  // Grows into whatever the others leave, shrinks so the shares always fit
  // beside the closed headers and the column's gaps.
  return `${HOST_BASE} grow shrink ${basis}`;
}

export function railSplit(open: RailOpenState): RailSplit {
  const othersOpen = (open.connectors ? 1 : 0) + (open.joints ? 1 : 0) + (open.params ? 1 : 0);
  const partsShare = !open.parts ? 0 : othersOpen === 0 ? 1 : 0.5;
  const otherShare = othersOpen === 0 ? 0 : (1 - partsShare) / othersOpen;
  return {
    parts: host(open.parts, partsShare),
    connectors: host(open.connectors, otherShare),
    joints: host(open.joints, otherShare),
    params: host(open.params ?? false, otherShare),
  };
}
