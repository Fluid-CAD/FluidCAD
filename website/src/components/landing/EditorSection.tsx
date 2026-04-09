import {useState} from 'react';
import CodeBlock from '@theme/CodeBlock';
import styles from './EditorSection.module.css';

type Editor = {
  id: string;
  name: string;
  steps: string[];
  code?: {language: string; content: string};
};

const EDITORS: Editor[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    steps: [
      'Install the FluidCAD extension from the VS Code Marketplace.',
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
  "fluidcad/fluidcad",
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
        <h2 className={styles.sectionTitle}>Works with your editor</h2>
        <p className={styles.sectionSubtitle}>
          First-class integrations for popular editors, or bring your own.
        </p>
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
                <div key={step} className={styles.step}>
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
          </div>
        </div>
      </div>
    </section>
  );
}
