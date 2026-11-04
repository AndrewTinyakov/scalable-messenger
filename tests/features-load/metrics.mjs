export class Histogram {
  constructor() {
    this.buckets = new Uint32Array(64);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
  observe(value) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid latency');
    this.buckets[Math.min(63, Math.ceil(Math.log2(Math.max(1, value * 1000))))]++;
    this.count++;
    this.sum += value;
    this.max = Math.max(this.max, value);
  }
  percentile(fraction) {
    const rank = Math.ceil(this.count * fraction);
    let count = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      count += this.buckets[i];
      if (count >= rank) return Math.min(this.max, 2 ** i / 1000);
    }
    return 0;
  }
  report() {
    return { count: this.count, meanMs: this.sum / (this.count || 1), p50UpperMs: this.percentile(.5), p95UpperMs: this.percentile(.95), p99UpperMs: this.percentile(.99), maxMs: this.max };
  }
}

export class Metrics {
  constructor() {
    this.counts = Object.create(null);
    this.latencies = new Map();
    this.errors = [];
  }
  count(name, amount = 1) { this.counts[name] = (this.counts[name] ?? 0) + amount; }
  observe(name, value) {
    if (!this.latencies.has(name)) this.latencies.set(name, new Histogram());
    this.latencies.get(name).observe(value);
  }
  failure(kind, error) {
    this.count(kind);
    if (this.errors.length < 32) this.errors.push({ kind, message: String(error?.message ?? error).slice(0, 300) });
  }
  report() { return { counts: this.counts, latencies: Object.fromEntries([...this.latencies].map(([k, v]) => [k, v.report()])), errors: this.errors }; }
}
