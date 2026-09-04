/**
 * How the assembly rail divides its column between Parts, Connectors and
 * Joints. Parts is the column's subject and holds half of it whenever it is
 * open alongside anything else; the other open sections share the rest
 * equally — a quarter each with both open, the whole other half with one.
 * A closed section drops to its header and hands its room back, so with
 * Parts closed Connectors and Joints split the column between them, and a
 * section open on its own has all of it.
 *
 * Those are the shares under contention. Each host is also capped at its
 * own rows (`max-h-max`) and every open one grows, so a section that wants
 * less than its share stops there and the others take what it freed — the
 * same terms as the part-design column (see accordion-section.ts).
 */

export type RailSection = 'parts' | 'connectors' | 'joints';

/** Which sections are open; a section nothing is mounted in counts as closed. */
export type RailOpenState = Record<RailSection, boolean>;

/** The class string for each section's host, in the column's order. */
export type RailSplit = Record<RailSection, string>;

/** Every host is a nested column of header + scrolling body, capped at its rows. */
const HOST_BASE = 'flex flex-col gap-1 min-h-0 max-h-max';

/** A closed section is exactly its header: no claim on the column, never crushed. */
const CLOSED = 'grow-0 shrink-0 basis-auto';

/** Tailwind's spelling of each share the policy can hand out. */
const BASIS: Record<string, string> = {
  '1': 'basis-full',
  '0.5': 'basis-1/2',
  '0.25': 'basis-1/4',
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
  const othersOpen = (open.connectors ? 1 : 0) + (open.joints ? 1 : 0);
  const partsShare = !open.parts ? 0 : othersOpen === 0 ? 1 : 0.5;
  const otherShare = othersOpen === 0 ? 0 : (1 - partsShare) / othersOpen;
  return {
    parts: host(open.parts, partsShare),
    connectors: host(open.connectors, otherShare),
    joints: host(open.joints, otherShare),
  };
}
