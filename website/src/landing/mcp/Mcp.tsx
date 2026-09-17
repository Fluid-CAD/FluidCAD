import Link from '@docusaurus/Link'
import { Section } from '../Section'
import styles from './Mcp.module.css'

export default function Mcp() {
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
        <div className={styles.placeholder} aria-hidden="true" />
      </div>
    </Section>
  )
}
