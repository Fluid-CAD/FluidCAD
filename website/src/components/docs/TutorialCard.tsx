import Link from '@docusaurus/Link';
import styles from './TutorialCard.module.css';

type TutorialCardProps = {
  title: string;
  description: string;
  image: string;
  href: string;
};

export function TutorialCard({title, description, image, href}: TutorialCardProps) {
  return (
    <Link to={href} className={styles.card}>
      <div className={styles.imageWrapper}>
        <img src={image} alt={title} className={styles.image} />
      </div>
      <div className={styles.content}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.description}>{description}</p>
      </div>
    </Link>
  );
}

export function TutorialGrid({children}: {children: React.ReactNode}) {
  return <div className={styles.grid}>{children}</div>;
}
