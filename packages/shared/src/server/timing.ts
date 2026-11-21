import { performance } from 'node:perf_hooks';

/** Cronômetro simples para medir etapas do pipeline. */
export class Stopwatch {
  private readonly start = performance.now();
  private readonly marks = new Map<string, number>();

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.marks.set(name, (this.marks.get(name) ?? 0) + (performance.now() - t0));
    }
  }

  record(name: string, ms: number): void {
    this.marks.set(name, (this.marks.get(name) ?? 0) + ms);
  }

  elapsed(): number {
    return performance.now() - this.start;
  }

  toJSON(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.marks) out[k] = Math.round(v);
    out.total = Math.round(this.elapsed());
    return out;
  }
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}
