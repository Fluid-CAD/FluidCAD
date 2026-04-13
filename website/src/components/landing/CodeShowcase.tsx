import { useState, useEffect, useCallback, useRef } from 'react';
import HighlightedCode from './HighlightedCode';
import styles from './CodeShowcase.module.css';

const CODE = `import { sketch, extrude, fillet, shell } from 'fluidcad/core';

sketch("xy", () => {
    circle(50)
})

const e = extrude(50)

fillet(5, e.startEdges())

shell(-2, e.endFaces())`;

type Step = {
  highlightRange: [number, number] | null;
  screenshot: string;
  caption: string;
};

const STEPS: Step[] = [
  {
    highlightRange: [3, 5],
    screenshot: '/img/docs/_landing/step-1-empty.png',
    caption: 'Define a 2D sketch on the XY plane',
  },
  {
    highlightRange: [4, 4],
    screenshot: '/img/docs/_landing/step-2-sketch.png',
    caption: 'Draw a circle with diameter 50',
  },
  {
    highlightRange: [7, 7],
    screenshot: '/img/docs/_landing/step-3-extrude.png',
    caption: 'Extrude into a solid cylinder',
  },
  {
    highlightRange: [9, 9],
    screenshot: '/img/docs/_landing/step-4-fillet.png',
    caption: 'Round the bottom edges with a fillet',
  },
  {
    highlightRange: [11, 11],
    screenshot: '/img/docs/_landing/step-5-shell.png',
    caption: 'Hollow the top to create a shell',
  },
];

const UNIQUE_SCREENSHOTS = [...new Set(STEPS.map(s => s.screenshot))];
const INTERVAL_MS = 2000;

export default function CodeShowcase() {
  const [currentStep, setCurrentStep] = useState(0);
  const isPausedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    timerRef.current = setInterval(() => {
      if (!isPausedRef.current) {
        setCurrentStep(prev => (prev + 1) % STEPS.length);
      }
    }, INTERVAL_MS);
  }, []);

  useEffect(() => {
    startTimer();
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [startTimer]);

  const handleMouseEnter = () => {
    isPausedRef.current = true;
  };

  const handleMouseLeave = () => {
    isPausedRef.current = false;
  };

  const step = STEPS[currentStep];

  return (
    <section
      className={styles.section}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="container">
        <div className={styles.grid}>
          {/* Left: Code */}
          <div className={styles.codeCol}>
            <div className={styles.codeWindow}>
              <div className={styles.windowChrome}>
                <span className={styles.dot} data-color="red" />
                <span className={styles.dot} data-color="yellow" />
                <span className={styles.dot} data-color="green" />
                <span className={styles.windowTitle}>my-part.fluid.js</span>
              </div>
              <div className={styles.codeBody}>
                <HighlightedCode
                  code={CODE}
                  language="javascript"
                  highlightRange={step.highlightRange}
                />
              </div>
            </div>
          </div>

          {/* Right: Preview */}
          <div className={styles.previewCol}>
            <div className={styles.previewCard}>
              <div className={styles.previewContainer}>
                {UNIQUE_SCREENSHOTS.map(src => (
                  <img
                    key={src}
                    src={src}
                    alt={step.screenshot === src ? step.caption : ''}
                    className={`${styles.screenshot} ${step.screenshot === src ? styles.screenshotActive : ''}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
