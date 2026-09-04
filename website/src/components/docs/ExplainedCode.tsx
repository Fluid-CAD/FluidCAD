import type {ReactNode} from 'react';
import CodeBlock from '@theme/CodeBlock';
import Details from '@theme/Details';
import {IconCode} from '@tabler/icons-react';
import styles from './ExplainedCode.module.css';

type ExplainedCodeProps = {
  /** Raw .part.js / .assembly.js source, typically a `!!raw-loader!` import. */
  code: string;
  /** Accordion label. */
  title?: string;
  /** File name shown on the code block. */
  fileName?: string;
  /** Start expanded. */
  open?: boolean;
  /** Extra prose rendered above the code, inside the accordion. */
  children?: ReactNode;
};

/**
 * The "what the UI wrote" accordion under a UI-driven example: the source the
 * interaction produced, with its explanatory comments, collapsed by default so
 * the page reads as a UI walkthrough first and a code reference second.
 *
 * Screenshot-automation directives (`// @screenshot …`) are stripped — they
 * are meaningless to a reader.
 */
export function ExplainedCode({
  code,
  title = 'The code behind it',
  fileName,
  open = false,
  children,
}: ExplainedCodeProps) {
  const source = code.replace(/^\/\/ @screenshot.*\r?\n/gm, '').trimEnd();
  return (
    <Details
      className={styles.details}
      open={open}
      summary={
        <summary className={styles.summary}>
          <IconCode size={16} stroke={2} aria-hidden />
          <span>{title}</span>
        </summary>
      }>
      {children}
      <CodeBlock language="js" title={fileName}>
        {source}
      </CodeBlock>
    </Details>
  );
}
