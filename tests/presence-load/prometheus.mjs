const RATE_MS = 30_000;
const rate = selector => range => `sum(rate(${selector}[${range}]))`;
const rpc = method => rate(`grpc_server_seconds_count{job="api",rpc_method=~"${method}"}`);
const sql = method => rate(`messenger_database_query_seconds_count{job="api",entrypoint=~".*/(${method})"}`);

export const GAUGES = {
  gatewayRssMiB: 'sum(process_resident_memory_bytes{job="ws"}) / 2^20',
  gatewayConnections: 'sum(messenger_ws_connections)',
  redisUsedMiB: 'sum(redis_memory_used_bytes) / 2^20',
};

export const COUNTERS = {
  gatewayCpuCores: rate('process_cpu_seconds_total{job="ws"}'),
  gatewayOutboundFramesPerSec: rate('messenger_ws_messages_total{direction="outbound"}'),
  gatewayOutboundBytesPerSec: rate('messenger_ws_message_bytes_total{direction="outbound"}'),
  redisCpuCores: range => `sum(rate(redis_cpu_user_seconds_total[${range}]) + rate(redis_cpu_sys_seconds_total[${range}]))`,
  redisCommandsPerSec: rate('redis_commands_processed_total'),
  apiCpuCores: range => `${rate('process_cpu_time_ns_total{job="api"}')(range)} / 1e9`,
  apiGrpcPerSec: rate('grpc_server_seconds_count{job="api"}'),
  apiSqlPerSec: rate('messenger_database_query_seconds_count{job="api",entrypoint_kind="rpc"}'),
  validateSessionGrpcPerSec: rpc('ValidateSessions?'),
  authorizePresenceGrpcPerSec: rpc('AuthorizePresence'),
  authorizeSidebarGrpcPerSec: rpc('AuthorizeSidebar'),
  legacyPresenceSqlPerSec: sql('AuthorizePresence|AuthorizeSidebar'),
  presenceVisibilityGrpcPerSec: rpc('PresenceVisibility'),
  onlineCountMembersGrpcPerSec: rpc('OnlineCountMembers'),
  recordLastSeenGrpcPerSec: rpc('RecordLastSeen'),
  currentPresenceSqlPerSec: sql('PresenceVisibility|OnlineCountMembers|RecordLastSeen'),
};

async function query(base, path, params) {
  const response = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Prometheus ${path}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.data.result;
}

async function range(base, expression, startMs, endMs) {
  const result = await query(base, '/api/v1/query_range', { query: expression, start: startMs / 1000, end: endMs / 1000, step: 5 });
  return (result[0]?.values ?? []).map(([, value]) => Number(value)).filter(Number.isFinite);
}

export async function collect(base, startMs, endMs) {
  if (!base) return null;
  const samples = { intervals: { gauges: [startMs, endMs], counterMean: [startMs, endMs], counterPeak: null } };
  for (const [name, expression] of Object.entries(GAUGES)) {
    const values = await range(base, expression, startMs, endMs);
    samples[name] = values.length ? { mean: values.reduce((sum, value) => sum + value, 0) / values.length, peak: Math.max(...values) } : null;
  }
  if (endMs - startMs >= 2 * RATE_MS) samples.intervals.counterPeak = [startMs + RATE_MS, endMs];
  for (const [name, expression] of Object.entries(COUNTERS)) {
    const [mean] = await query(base, '/api/v1/query', { query: expression(`${Math.round(endMs - startMs)}ms`), time: endMs / 1000 });
    const peaks = samples.intervals.counterPeak ? await range(base, expression(`${RATE_MS / 1000}s`), startMs + RATE_MS, endMs) : [];
    samples[name] = mean ? { mean: Number(mean.value[1]), peak: peaks.length ? Math.max(...peaks) : null } : null;
  }
  return samples;
}
