export type ProfileCategory = {
  category: string;
  durationMs: number;
};

export class Profiler {
  private categories: Map<string, number> = new Map();
  private stack: { category: string; startTime: number }[] = [];

  start(category: string): void {
    this.stack.push({ category, startTime: performance.now() });
  }

  end(category: string): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].category === category) {
        const entry = this.stack.splice(i, 1)[0];
        const elapsed = performance.now() - entry.startTime;
        const current = this.categories.get(category) || 0;
        this.categories.set(category, current + elapsed);
        this.stack.length = i;
        return;
      }
    }
  }

  record<T>(category: string, fn: () => T): T {
    this.start(category);
    try {
      return fn();
    } finally {
      this.end(category);
    }
  }

  getCategories(): ProfileCategory[] {
    const result: ProfileCategory[] = [];
    for (const [category, durationMs] of this.categories.entries()) {
      result.push({ category, durationMs: Math.round(durationMs * 10) / 10 });
    }
    result.sort((a, b) => b.durationMs - a.durationMs);
    return result;
  }
}
