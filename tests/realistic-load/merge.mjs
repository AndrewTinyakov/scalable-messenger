import { check, Measurements } from './transport.mjs';

// Adds shard reports together. Correctness counters cover recipients in the sender's own shard; cross-shard
// deliveries contribute latency through the send time each message carries.
export function mergeReports(parts) {
  check(parts.length > 0 && parts.every(part => part.format === 'messenger-realistic-load-report-v1' && part.rawMetrics), 'shardReports');
  const [first] = parts;
  check(parts.every(part => part.fingerprint && part.fingerprint === first.fingerprint && part.startAt !== null &&
    part.startAt === first.startAt && part.manifestFingerprint === first.manifestFingerprint &&
    part.shard.count === parts.length), 'shardMismatch');
  check(new Set(parts.map(part => part.shard.index)).size === parts.length, 'shardMismatch');
  const sum = key => Object.fromEntries(Object.keys(first[key]).map(field =>
    [field, typeof first[key][field] === 'number' ? parts.reduce((total, part) => total + (part[key][field] ?? 0), 0) : first[key][field]]));
  return {
    ...first, shard: { index: null, count: parts.length },
    plannedActions: parts.reduce((total, part) => total + part.plannedActions, 0),
    schedule: { ...sum('schedule'), peak: Math.max(...parts.map(part => part.schedule.peak)), lagLimitMs: first.schedule.lagLimitMs },
    correctness: sum('correctness'),
    ticketAdmission: (({ maximumRequestsPerSecond, peakPending, ...totals }) => ({
      ...totals, maximumRequestsPerSecond, peakPending,
      intervalMs: maximumRequestsPerSecond ? 1000 / maximumRequestsPerSecond : first.ticketAdmission.intervalMs,
    }))({ ...sum('ticketAdmission'), peakPending: Math.max(...parts.map(part => part.ticketAdmission.peakPending ?? 0)) }),
    diagnostics: parts.flatMap(part => part.diagnostics ?? []).slice(0, 280),
    ...(first.verificationRawMetrics ? { verificationMetrics: Measurements.merge(parts.map(part => part.verificationRawMetrics)).report() } : {}),
    verificationRawMetrics: undefined,
    failedActionSamples: parts.flatMap(part => part.failedActionSamples).slice(0, 30),
    passed: parts.every(part => part.passed),
    metrics: Measurements.merge(parts.map(part => part.rawMetrics)).report(),
    rawMetrics: undefined,
  };
}
