import Link from '@docusaurus/Link';
import {Section, SectionHead} from '../Section';
import styles from './Gallery.module.css';

/**
 * Finished parts, each one a tutorial you can follow to the same result.
 *
 * The stills are real viewport captures with the app's grid still under
 * them — transparent, so the grid sits on whichever ground the page is
 * wearing. Sizes vary because the parts do: a lantern is tall, a tray is
 * wide, and cropping them to a uniform tile would be the one decision that
 * made this look like a template.
 */
type Work = {
  id: string;
  title: string;
  teaches: string;
  image: string;
  href: string;
  /** Cells that claim extra room because the part in them needs it. */
  span?: 'tall' | 'wide';
};

const WORK: Work[] = [
  {
    id: 'lantern',
    title: 'Lantern',
    teaches: 'Polygons, draft, shell, projected geometry, loft and revolve.',
    image: '/img/docs/tutorials/lantern-final.png',
    href: '/docs/tutorials/lantern',
  },
  {
    id: 'gear-housing',
    title: 'Gear housing',
    teaches: 'Angled chamfers, multi-level extrudes, counterbores, circular patterns.',
    image: '/img/docs/tutorials/gear-housing-final.png',
    href: '/docs/tutorials/gear-housing',
  },
  {
    id: 'cswp',
    title: 'CSWP sample exam',
    teaches: 'The certification part, built parametrically and then re-driven from its variables.',
    image: '/img/docs/tutorials/cswp-sample-exam-final.png',
    href: '/docs/tutorials/cswp-sample-exam',
  },
  {
    id: 'ice-cube-tray',
    title: 'Ice cube tray',
    teaches: 'Draft cuts, internal fillets, a profile swept along a spine.',
    image: '/img/docs/tutorials/ice-cube-tray-final.png',
    href: '/docs/tutorials/ice-cube-tray',
    span: 'wide',
  },
  {
    id: 'fork',
    title: 'Forked yoke',
    teaches: 'Offset arc profiles, sketch-local mirror axes, thin annular cuts.',
    image: '/img/docs/tutorials/fork-final.png',
    href: '/docs/tutorials/fork',
  },
  {
    id: 'hinge-bracket',
    title: 'Hinge bracket',
    teaches: 'Edge and face filters doing the selecting, so the model survives being re-driven.',
    image: '/img/docs/tutorials/hinge-bracket-final.png',
    href: '/docs/tutorials/hinge-bracket',
  },
  {
    id: 'desk-organizer',
    title: 'Desk organizer',
    teaches: 'A printable part, sized from its own parameters.',
    image: '/img/docs/tutorials/desk-organizer-final.png',
    href: '/docs/tutorials/desk-organizer',
  },
];

export default function Gallery() {
  return (
    <Section>
      <SectionHead
        title="Built with it"
        lead="Every one of these is a tutorial: the drawing it came from, the sketch that starts it, and every statement in between."
      />

      <ul className={styles.grid}>
        {WORK.map((item) => (
          <li key={item.id} className={`${styles.cell} ${item.span ? styles[item.span] : ''}`}>
            <Link className={styles.card} to={item.href}>
              <span className={styles.plate}>
                <img
                  className={styles.shot}
                  src={item.image}
                  alt={`The finished ${item.title.toLowerCase()} in the FluidCAD viewport`}
                  loading="lazy"
                  decoding="async"
                />
              </span>
              <span className={styles.text}>
                <span className={styles.title}>{item.title}</span>
                <span className={styles.teaches}>{item.teaches}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p className={styles.more}>
        <Link to="/docs/tutorials">All tutorials</Link>
      </p>
    </Section>
  );
}
