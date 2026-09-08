// Every jsdom test file shares one document: the suite runs without isolation
// so OpenCascade loads once (vitest.config.ts). A panel a test appends to
// document.body and never removes is therefore still there when the next
// file's tests query the document, and a document-wide lookup finds the
// stale element first. Each file leaves the body the way it found it.
import { afterAll } from 'vitest';

afterAll(() => {
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
  }
});
