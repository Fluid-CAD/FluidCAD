import { useRef, useLayoutEffect, useState } from 'react';
import { Highlight } from 'prism-react-renderer';
import { usePrismTheme } from '@docusaurus/theme-common';
import styles from './HighlightedCode.module.css';

type Props = {
  code: string;
  language: string;
  /** 1-indexed inclusive range of lines to highlight, e.g. [4, 6]. null = no highlight. */
  highlightRange: [number, number] | null;
};

export default function HighlightedCode({ code, language, highlightRange }: Props) {
  const prismTheme = usePrismTheme();
  const codeRef = useRef<HTMLElement>(null);
  const [lineHeight, setLineHeight] = useState(0);

  useLayoutEffect(() => {
    const el = codeRef.current;
    if (!el) {
      return;
    }
    // Measure the first line div to get consistent line height
    const lines = el.querySelectorAll(`.${styles.line}`);
    if (lines.length >= 2) {
      const first = lines[0] as HTMLElement;
      const second = lines[1] as HTMLElement;
      setLineHeight(second.offsetTop - first.offsetTop);
    } else if (lines.length === 1) {
      setLineHeight((lines[0] as HTMLElement).offsetHeight);
    }
  }, [code]);

  const showOverlay = highlightRange !== null && lineHeight > 0;
  const overlayTop = highlightRange ? lineHeight * (highlightRange[0] - 1) : 0;
  const overlayHeight = highlightRange ? lineHeight * (highlightRange[1] - highlightRange[0] + 1) : 0;

  return (
    <Highlight theme={prismTheme} code={code} language={language}>
      {({ tokens, getLineProps, getTokenProps, style }) => (
        <pre className={styles.pre} style={style}>
          <code ref={codeRef} className={styles.code}>
            {showOverlay && (
              <div
                className={styles.highlightOverlay}
                style={{
                  transform: `translateY(${overlayTop}px)`,
                  height: `${overlayHeight}px`,
                }}
                aria-hidden="true"
              />
            )}
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <div key={i} {...lineProps} className={`${lineProps.className ?? ''} ${styles.line}`}>
                  <span className={styles.lineNumber}>{i + 1}</span>
                  <span className={styles.lineContent}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </div>
              );
            })}
          </code>
        </pre>
      )}
    </Highlight>
  );
}
