import {useEffect, useRef} from 'react';
import {Highlight} from 'prism-react-renderer';
import {usePrismTheme} from '@docusaurus/theme-common';
import styles from './CodePane.module.css';

type Props = {
  code: string;
  language?: string;
  /** 1-indexed inclusive range the current step is responsible for. */
  live?: [number, number] | null;
  /** Keep the live range in view as it moves down the file. */
  follow?: boolean;
  className?: string;
  'aria-label'?: string;
};

/**
 * A file, with the statement that just landed at full ink and the rest of it
 * stepped back.
 *
 * The usual device — a tinted band behind the active lines — says "this row
 * is selected", which is a table's idea. A file being written doesn't do
 * that: the new line is simply the one you are looking at, and everything
 * above it is context. Dimming the context says exactly that, costs no extra
 * chrome, and leaves the whole file legible at a glance instead of hiding it
 * behind a highlight.
 */
export default function CodePane({
  code,
  language = 'javascript',
  live = null,
  follow = false,
  className,
  'aria-label': label,
}: Props) {
  const prismTheme = usePrismTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  // Follow the write head. Deliberately *not* `scrollIntoView`: that walks up
  // to the nearest scrolling ancestor and will take the whole page with it,
  // which on a landing page reads as the site stealing the scroll. This moves
  // the pane's own scrollTop and nothing else, and only when the pane has
  // somewhere to scroll.
  const from = live?.[0];
  const to = live?.[1];
  useEffect(() => {
    const pane = scrollRef.current;
    const target = liveRef.current;
    if (!follow || !pane || !target || pane.scrollHeight <= pane.clientHeight) {
      return;
    }
    const top = target.offsetTop - (pane.clientHeight - target.offsetHeight) / 2;
    pane.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    // The primitives, not the `live` tuple: a fresh array literal on every
    // render would re-run this on every render.
  }, [code, from, to, follow]);

  return (
    <div
      ref={scrollRef}
      className={`${styles.pane} ${className ?? ''}`}
      // Only a pane that has a live range steps its context back. Without
      // one this is an ordinary sample, and dimming all of it would just
      // make the whole block hard to read.
      data-focused={live !== null || undefined}>
      <Highlight theme={prismTheme} code={code} language={language}>
        {({tokens, getLineProps, getTokenProps}) => (
          <pre className={styles.pre} aria-label={label}>
            <code className={styles.code}>
              {tokens.map((line, i) => {
                const number = i + 1;
                const isLive = live !== null && number >= live[0] && number <= live[1];
                const lineProps = getLineProps({line});
                return (
                  <div
                    key={i}
                    {...lineProps}
                    ref={live !== null && number === live[0] ? liveRef : undefined}
                    className={`${lineProps.className ?? ''} ${styles.line} ${isLive ? styles.live : ''}`}>
                    <span className={styles.gutter} aria-hidden="true">
                      {number}
                    </span>
                    <span className={styles.text}>
                      {line.map((token, key) => (
                        <span key={key} {...getTokenProps({token})} />
                      ))}
                    </span>
                  </div>
                );
              })}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}
