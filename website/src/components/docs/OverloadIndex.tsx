import { Highlight } from 'prism-react-renderer';
import { usePrismTheme } from '@docusaurus/theme-common';
import Link from '@docusaurus/Link';
import styles from './OverloadIndex.module.css';

type Overload = {
  /** Full typed signature, e.g. `line(end: Point2DLike): Geometry`. */
  signature: string;
  /** Id of the detail heading this entry scrolls to. */
  anchor: string;
  /** JSDoc summary. May contain `inline code` wrapped in backticks. */
  description?: string;
};

type Props = {
  overloads: Overload[];
};

/** Render a plain string, turning `backtick`-wrapped spans into inline code. */
function renderDescription(text: string) {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className={styles.descCode}>{part}</code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/**
 * Summary of every overload of a function, shown at the top of its API page.
 * Each row is a syntax-highlighted signature plus its JSDoc summary, linking
 * down to the matching detailed signature section.
 */
export default function OverloadIndex({ overloads }: Props) {
  const prismTheme = usePrismTheme();

  return (
    <ol className={styles.list}>
      {overloads.map((overload, i) => (
        <li key={i} className={styles.item}>
          <Link to={`#${overload.anchor}`} className={styles.row}>
            <Highlight theme={prismTheme} code={overload.signature} language="ts">
              {({ tokens, getTokenProps }) => (
                <code className={styles.signature}>
                  {tokens.map((line, lineKey) =>
                    line.map((token, key) => (
                      <span key={`${lineKey}-${key}`} {...getTokenProps({ token })} />
                    )),
                  )}
                </code>
              )}
            </Highlight>
            {overload.description ? (
              <span className={styles.description}>
                {renderDescription(overload.description)}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ol>
  );
}
