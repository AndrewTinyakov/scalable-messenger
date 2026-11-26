// Server-side measurements for one window, from the stack's own Prometheus.
// Every query exists in both builds unless it names a build-specific RPC.

const rate = (metric, filter = '') => `sum(rate(${metric}${filter}[30s]))`;
const rpc = method => rate('grpc_server_seconds_count', `{job="api",rpc_method="${method}"}`);
const sql = method => rate('messenger_database_query_seconds_count', `{job="api",entrypoint=~".*/${method}"}`);

export const QUERIES = {
  gatewayCpuCores: rate('process_cpu_seconds_total', '{job="ws"}'),
  gatewayRssMiB: 'sum(process_resident_memory_bytes{job="ws"}) / 2^20',
  gatewayConnections: 'sum(messenger_ws_connections)',
  gatewayOutboundFramesPerSec: rate('messenger_ws_messages_total', '{direction="outbound"}'),
  gatewayOutboundBytesPerSec: rate('messenger_ws_message_bytes_total', '{direction="outbound"}'),
  redisCpuCores: 'sum(rate(redis_cpu_user_seconds_total[30s]) + rate(redis_cpu_sys_seconds_total[30s]))',
  redisCommandsPerSec: rate('redis_commands_processed_total'),
  redisUsedMiB: 'sum(redis_memory_used_bytes) / 2^20',
  apiCpuCores: 'sum(rate(process_cpu_time_ns_total{job="api"}[30s])) / 1e9',
  apiGrpcPerSec: rate('grpc_server_seconds_count', '{job="api"}'),
  apiSqlPerSec: rate('messenger_database_query_seconds_count', '{job="api",entrypoint_kind="rpc"}'),
  validateSessionGrpcPerSec: `${rpc('ValidateSession')} + ${rpc('ValidateSessions')}`,
  // Legacy presence authorization.
  authorizePresenceGrpcPerSec: rpc('AuthorizePresence'),
  authorizeSidebarGrpcPerSec: rpc('AuthorizeSidebar'),
  authorizeSidebarSqlPerSec: sql('AuthorizeSidebar'),
  // Current presence authorization and persistence.
  presenceVisibilityGrpcPerSec: rpc('PresenceVisibility'),
  presenceVisibilitySqlPerSec: sql('PresenceVisibility'),
  onlineCountMembersGrpcPerSec: rpc('OnlineCountMembers'),
  recordLastSeenGrpcPerSec: rpc('RecordLastSeen'),
};

async function query(base, path, params) {
  const response = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json();
  if (body.status !== 'success') throw new Error(`Prometheus ${path}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.data.result;
}

// Mean and peak of each series over [startMs, endMs], sampled every 5 s.
export async function collect(base, startMs, endMs) {
  if (!base) return null;
  const samples = {};
  for (const [name, expression] of Object.entries(QUERIES)) {
    const result = await query(base, '/api/v1/query_range', { query: expression, start: startMs / 1000, end: endMs / 1000, step: 5 });
    const values = (result[0]?.values ?? []).map(([, value]) => Number(value)).filter(Number.isFinite);
    samples[name] = values.length
      ? { mean: values.reduce((sum, value) => sum + value, 0) / values.length, peak: Math.max(...values), samples: values.length }
      : null;
  }
  return samples;
}
