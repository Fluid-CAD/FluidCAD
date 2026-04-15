import type {ReactNode} from 'react';
import {useState} from 'react';
import CodeBlock from '@theme/CodeBlock';
import styles from './EditorSection.module.css';

const INSTALL_CMD = `npm i fluidcad
npx fluidcad init`;

type Editor = {
  id: string;
  name: string;
  steps: (string | ReactNode)[];
  code?: {language: string; content: string};
  note?: string;
};

const EDITORS: Editor[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    steps: [
      <>Install the FluidCAD extension from the <a href="https://marketplace.visualstudio.com/items?itemName=FluidCAD.fluidcad" target="_blank" rel="noopener noreferrer">VS Code Marketplace</a>.</>,
      'Open your project folder in VS Code.',
      'Open the Command Palette (Ctrl+Shift+P / Cmd+Shift+P) and run Show FluidCAD Scene.',
    ],
  },
  {
    id: 'neovim',
    name: 'Neovim',
    steps: [
      'Add the plugin with lazy.nvim.',
      'Open a .fluid.js file and the server starts automatically.',
      'Run :FluidCadOpenBrowser to open the 3D viewport.',
    ],
    code: {
      language: 'lua',
      content: `{
  "Fluid-CAD/FluidCAD",
  config = function()
    require("fluidcad").setup()
  end,
  ft = { "javascript" },
}`,
    },
  },
  {
    id: 'cli',
    name: 'Other Editors',
    steps: [
      'Run the FluidCAD server directly.',
      'Edit your .fluid.js files in any editor.',
      'The viewport updates on save.',
    ],
    note: 'Interactive features like region picking, trimming, and interactive bezier drawing are only available in VS Code and Neovim.',
    code: {
      language: 'bash',
      content: 'npx fluidcad -w ./my-app',
    },
  },
];

export default function EditorSection() {
  const [active, setActive] = useState(0);
  const editor = EDITORS[active];

  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>Get started</h2>
        <p className={styles.sectionSubtitle}>
          Set up a project and connect your editor in under a minute.
        </p>
        <div className={styles.columns}>
          {/* Left: Install */}
          <div className={styles.installCol}>
            <h3 className={`${styles.colTitle} ${styles.installTitle}`}>Install</h3>
            <div className={styles.terminal}>
              <div className={styles.terminalChrome}>
                <span className={styles.dot} data-color="red" />
                <span className={styles.dot} data-color="yellow" />
                <span className={styles.dot} data-color="green" />
                <span className={styles.terminalTitle}>Terminal</span>
              </div>
              <div className={styles.terminalBody}>
                <CodeBlock language="bash">
                  {INSTALL_CMD}
                </CodeBlock>
              </div>
            </div>
          </div>

          {/* Right: Editor setup */}
          <div className={styles.editorCol}>
            <h3 className={styles.colTitle}>Set up your editor</h3>
            <div className={styles.tabLayout}>
              <div className={styles.tabList} role="tablist">
                {EDITORS.map((e, i) => (
                  <button
                    key={e.id}
                    role="tab"
                    aria-selected={i === active}
                    className={`${styles.tab} ${i === active ? styles.tabActive : ''}`}
                    onClick={() => setActive(i)}>
                    {e.name}
                  </button>
                ))}
              </div>
              <div className={styles.tabPanel} role="tabpanel">
                <div className={styles.steps}>
                  {editor.steps.map((step, i) => (
                    <div key={i} className={styles.step}>
                      <span className={styles.stepNumber}>{i + 1}</span>
                      <span className={styles.stepText}>{step}</span>
                    </div>
                  ))}
                </div>
                {editor.code && (
                  <div className={styles.codeWrapper}>
                    <CodeBlock language={editor.code.language}>
                      {editor.code.content}
                    </CodeBlock>
                  </div>
                )}
                {editor.note && (
                  <p className={styles.note}>{editor.note}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
