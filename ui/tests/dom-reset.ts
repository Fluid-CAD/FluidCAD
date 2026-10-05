// Every jsdom test file shares one document: the suite runs without isolation
// so OpenCascade loads once (vitest.config.ts). A panel a test appends to
// document.body and never removes is therefore still there when the next
// file's tests query the document, and a document-wide lookup finds the
// stale element first. Each file leaves the body the way it found it.
import { afterAll } from 'vitest';

// jsdom has no layout/scrolling implementation; expression suggestions use
// the browser's method to keep the keyboard selection in view.
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

afterAll(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});
