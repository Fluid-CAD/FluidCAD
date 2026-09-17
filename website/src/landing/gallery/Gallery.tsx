import Link from '@docusaurus/Link'
import { Section, SectionHead } from '../Section'
import styles from './Gallery.module.css'

/** The five worked examples in the documentation sidebar. */
type Work = {
  id: string
  title: string
  teaches: string
  image: string
  href: string
  /** Cells that claim extra room because the part in them needs it. */
  span?: 'tall' | 'wide'
}

const WORK: Work[] = [
  {
    id: 'lantern',
    title: 'Lantern',
    teaches: 'A hollow body, lofted roof and revolved details.',
    image: '/img/landing/gallery-lantern.png',
    href: '/docs/tutorials/lantern'
  },
  {
    id: 'upper-alignment-clamp',
    title: 'Upper alignment clamp',
    teaches: 'Constrained profiles, mirrored features and a tangent web.',
    image: '/img/landing/gallery-upper-alignment-clamp.png',
    href: '/docs/tutorials/upper-alignment-clamp'
  },
  {
    id: 'flange-with-notch',
    title: 'Flange with notch',
    teaches: 'A dimensioned flange with a central bore and mirrored notches.',
    image: '/img/landing/gallery-flange-with-notch.png',
    href: '/docs/tutorials/flange-with-notch'
  },
  {
    id: 'desk-organizer',
    title: 'Desk organizer',
    teaches: 'Compartments, repeating features and finishing fillets.',
    image: '/img/landing/gallery-desk-organizer.png',
    href: '/docs/tutorials/desk-organizer',
    span: 'wide'
  },
  {
    id: 'fork',
    title: 'Forked yoke',
    teaches: 'Arc profiles, mirrored geometry and annular cuts.',
    image: '/img/landing/gallery-fork.png',
    href: '/docs/tutorials/fork'
  }
]

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
  )
}
