import Link from '@docusaurus/Link'
import type { CSSProperties } from 'react'
import { Section } from '../Section'
import { useReveal } from '../useReveal'
import styles from './Mcp.module.css'

const prompt = 'Use FluidCAD to build an L-shaped mounting bracket: 60 × 40 mm base, 40 mm upright, 4 mm thick, two Ø5 mm holes on each face, and 2 mm edge fillets. Keep the dimensions parametric.'

export default function Mcp() {
  const [terminalRef, shown] = useReveal<HTMLDivElement>()

  return (
    <Section>
      <div className={styles.layout}>
        <div>
          <h2 className={styles.title}>Your agent, in the same workspace</h2>
          <p className={styles.lead}>
            Connect an AI agent through MCP. It can read and edit your model, inspect geometry,
            measure a face, and check its work with screenshots. You keep the source and see the
            changes in your viewport.
          </p>
          <pre className={styles.command}>
            <code>npx fluidcad mcp</code>
          </pre>
          <Link to="/docs/cli#fluidcad-mcp">Connect an agent →</Link>
        </div>
        <div
          ref={terminalRef}
          className={`${styles.terminal} ${shown ? styles.typing : ''}`}
          role="img"
          aria-label={`Codex open in a terminal. Example prompt: ${prompt}`}
        >
          <div className={styles.titlebar} aria-hidden="true">
            <span className={styles.windowControls}><i /><i /><i /></span>
            <span>codex</span>
          </div>
          <div className={styles.terminalBody} aria-hidden="true">
            <div className={styles.prompt}>
              <span className={styles.chevron}>›</span>
              <div>
                {Array.from(prompt).map((character, index) => (
                  <span
                    key={index}
                    className={styles.character}
                    style={{ '--character-delay': `${300 + index * 20}ms` } as CSSProperties}
                  >{character}</span>
                ))}
                <span
                  className={styles.cursor}
                  style={{ '--typing-duration': `${300 + prompt.length * 20}ms` } as CSSProperties}
                >▌</span>
              </div>
            </div>
            <div className={styles.terminalHint}>~/fluidcad/bracket</div>
          </div>
        </div>
      </div>
    </Section>
  )
}
