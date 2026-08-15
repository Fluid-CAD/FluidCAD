import { describe, it, expect } from 'vitest';
import { PageWriteLedger } from '../../src/files/page-write-ledger.ts';

// `fluidcad serve` runs a disk watcher next to the in-page editor host, and
// the host's own saves come back through it as live-updates. The ledger is
// how the server tells that echo (already rendered by the host, with the
// right keepCurrent) from a genuine external edit.

describe('PageWriteLedger', () => {
  it('recognises the echo of a page write by content', () => {
    let t = 1000;
    const ledger = new PageWriteLedger(10_000, () => t);
    ledger.record('/ws/arm.part.js', 'const a = 1;');
    t += 300; // chokidar + the CLI watcher's debounce
    expect(ledger.isEcho('/ws/arm.part.js', 'const a = 1;')).toBe(true);
  });

  it('does not swallow a genuine external edit to the same file', () => {
    let t = 1000;
    const ledger = new PageWriteLedger(10_000, () => t);
    ledger.record('/ws/arm.part.js', 'const a = 1;');
    t += 300;
    expect(ledger.isEcho('/ws/arm.part.js', 'const a = 2;')).toBe(false);
  });

  it('is per file', () => {
    const ledger = new PageWriteLedger(10_000, () => 0);
    ledger.record('/ws/arm.part.js', 'same');
    expect(ledger.isEcho('/ws/base.part.js', 'same')).toBe(false);
  });

  it('survives a watcher that reports one write as two events', () => {
    let t = 1000;
    const ledger = new PageWriteLedger(10_000, () => t);
    ledger.record('/ws/arm.part.js', 'x');
    t += 300;
    expect(ledger.isEcho('/ws/arm.part.js', 'x')).toBe(true);
    t += 50;
    expect(ledger.isEcho('/ws/arm.part.js', 'x')).toBe(true);
  });

  it('forgets a write after the TTL so an identical later save is an edit again', () => {
    let t = 1000;
    const ledger = new PageWriteLedger(10_000, () => t);
    ledger.record('/ws/arm.part.js', 'x');
    t += 10_001;
    expect(ledger.isEcho('/ws/arm.part.js', 'x')).toBe(false);
  });

  it('keys paths the way the rest of the server does (normalizePath: slashes, drive letter)', () => {
    const ledger = new PageWriteLedger(10_000, () => 0);
    ledger.record('c:\\ws\\arm.part.js', 'x');
    expect(ledger.isEcho('C:/ws/arm.part.js', 'x')).toBe(true);
  });

  it('never treats a non-string payload as an echo', () => {
    const ledger = new PageWriteLedger(10_000, () => 0);
    ledger.record('/ws/arm.part.js', 'x');
    expect(ledger.isEcho('/ws/arm.part.js', undefined)).toBe(false);
  });
});
