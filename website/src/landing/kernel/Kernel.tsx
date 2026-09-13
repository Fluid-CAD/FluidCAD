import Link from '@docusaurus/Link';
import {Section, SectionHead} from '../Section';
import {useReveal} from '../useReveal';
import styles from './Kernel.module.css';

/**
 * Three parts, cut by the kernel this page is asking you to trust.
 *
 * No cards. Each specimen is geometry standing on the page ground with a
 * note under it, the way a parts drawing captions a view, so the section
 * reads as evidence rather than as three feature tiles.
 */
const SPECIMENS = [
  {
    id: 'thread',
    name: 'Helical thread',
    note: 'A true helix swept into a solid, then taken out of the shank. Ø26, 4.5 mm pitch, and the flanks are surfaces rather than a staircase of facets.',
    image: '/img/landing/spec-thread.png',
    alt: 'A threaded stud on a round flange, the thread cut as a continuous helical groove.',
  },
  {
    id: 'shell',
    name: 'Shelled wall',
    note: 'One face removed and every remaining surface offset 2.5 mm inward. The corner radii carry through the offset exactly, including around the bored port.',
    image: '/img/landing/spec-shell.png',
    alt: 'An open rectangular housing with rounded corners, hollowed to a thin constant wall, with a circular port through one side.',
  },
  {
    id: 'colour',
    name: 'Colour that travels',
    note: 'Bodies and individual faces carry colour, and the STEP writer carries it out with them, so the part arrives in the next program looking the way it left.',
    image: '/img/landing/spec-color.png',
    alt: 'A blue-grey bolted flange with an orange spigot and a green cap stacked on it.',
  },
];

export default function Kernel() {
  const [ref, shown] = useReveal<HTMLDivElement>();

  return (
    <Section>
      <SectionHead
        title="The geometry is exact"
        lead={
          <>
            FluidCAD is built on OpenCascade, the B-Rep kernel behind FreeCAD and a good deal of
            production CAD. Faces are analytic surfaces, edges are curves, and a fillet is a real
            blend between two of them. That is the difference between a model you can machine from
            and a mesh that only looks right.
          </>
        }
      />

      <div ref={ref} className={styles.row} data-shown={shown || undefined}>
        {SPECIMENS.map((item) => (
          <figure key={item.id} className={styles.specimen}>
            <img
              className={styles.render}
              src={item.image}
              alt={item.alt}
              width={640}
              height={480}
              loading="lazy"
              decoding="async"
            />
            <figcaption className={styles.caption}>
              <span className={styles.name}>{item.name}</span>
              <span className={styles.note}>{item.note}</span>
            </figcaption>
          </figure>
        ))}
      </div>

      <p className={styles.formats}>
        STEP and STL in and out, PNG straight from the viewport, and a sketch solver that will hold
        a line tangent to two arcs while you move them.{' '}
        <Link to="/docs/guides/export">Read about export</Link>.
      </p>
    </Section>
  );
}
