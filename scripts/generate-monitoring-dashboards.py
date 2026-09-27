#!/usr/bin/env python3
"""Build the provisioned Grafana dashboards from the queries below."""

import json
from pathlib import Path


OUT = Path(__file__).resolve().parents[1] / "deploy/grafana/dashboards"
RATE = "$__rate_interval"


def query(expr, legend="{{instance}}"):
    return {"expr": expr, "legendFormat": legend, "refId": "A"}


def panel(title, expr, legend="{{instance}}", unit="short", kind="timeseries", description=""):
    return {"title": title, "targets": [query(expr, legend)], "unit": unit, "kind": kind, "description": description}


def dashboard(uid, title, sections):
    panels = []
    y = 0
    next_id = 1
    for section, items in sections:
        panels.append({"id": next_id, "title": section, "type": "row", "collapsed": False,
                       "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}})
        next_id += 1
        y += 1
        for index, item in enumerate(items):
            x = (index % 3) * 8
            top = y + (index // 3) * 8
            is_stat = item["kind"] == "stat"
            panels.append({
                "id": next_id,
                "title": item["title"],
                "description": item["description"],
                "type": item["kind"],
                "datasource": {"type": "prometheus", "uid": "prometheus"},
                "gridPos": {"h": 8, "w": 8, "x": x, "y": top},
                "fieldConfig": {"defaults": {"unit": item["unit"], "color": {"mode": "palette-classic"}}, "overrides": []},
                "options": ({"colorMode": "value", "graphMode": "area", "justifyMode": "auto",
                             "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False}}
                            if is_stat else {"legend": {"displayMode": "list", "placement": "bottom", "calcs": []},
                                             "tooltip": {"mode": "multi", "sort": "desc"}}),
                "targets": [{**target, "refId": chr(65 + i), "instant": is_stat}
                            for i, target in enumerate(item["targets"])],
            })
            next_id += 1
        y += ((len(items) + 2) // 3) * 8
    return {
        "uid": uid, "title": title, "tags": ["messenger"], "timezone": "browser",
        "schemaVersion": 41, "version": 1, "refresh": "15s", "time": {"from": "now-1h", "to": "now"},
        "editable": True, "graphTooltip": 1, "panels": panels,
        "templating": {"list": []}, "annotations": {"list": []},
    }


overview = dashboard("messenger-overview", "Messenger overview", [
    ("Availability", [
        panel("Healthy service jobs", 'sum(min by (job) (up{job=~"api|command-processor|outbox-publisher|ws|rabbitmq|rabbitmq-queues|redis|postgres|ingress"}))',
              "healthy", kind="stat", description="Nine jobs are expected; replica alerts check each job's target count."),
        panel("Firing alerts", 'sum(ALERTS{alertstate="firing"}) or vector(0)', "alerts", kind="stat"),
        panel("Active WebSocket connections", "sum(messenger_ws_connections)", "connections", kind="stat"),
    ]),
    ("Message path", [
        panel("Queued send commands", 'sum(max by (queue) (rabbitmq_detailed_queue_messages_ready{queue=~"messenger.send.[0-3]"}))',
              "ready", kind="stat"),
        panel("Unpublished outbox events", "max(messenger_outbox_pending)", "pending", kind="stat"),
        panel("Oldest unpublished event", "max(messenger_outbox_oldest_age_seconds)", "age", "s", "stat"),
        panel("Commands processed per second", f'sum by (kind, outcome) (rate(messenger_command_consumed_total[{RATE}]))',
              "{{kind}} {{outcome}}", "ops"),
        panel("Send results per second", f'sum by (result) (rate(messenger_command_result_total[{RATE}]))',
              "{{result}}", "ops"),
        panel("Redis publications per second", f'sum by (result) (rate(messenger_outbox_publish_total[{RATE}]))',
              "{{result}}", "ops"),
        panel("WS SQL recovery requests per second", f'sum(rate(messenger_ws_sql_fallback_total[{RATE}]))',
              "SQL fallback", "ops"),
    ]),
    ("User experience", [
        panel("Ingress active connections", "nginx_connections_active", "{{tier}}"),
        panel("API requests per second", f'sum by (status) (rate(http_server_requests_seconds_count{{job="api"}}[{RATE}]))',
              "HTTP {{status}}", "reqps"),
        panel("API p95 latency", f'histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{{job="api"}}[{RATE}])))',
              "p95", "s"),
        panel("WS Rabbit confirm p95", f'histogram_quantile(0.95, sum by (le) (rate(messenger_ws_publish_seconds_bucket{{result="confirmed"}}[{RATE}])))',
              "p95", "s"),
        panel("SQL save to WS p95", f'histogram_quantile(0.95, sum by (le) (rate(messenger_ws_saved_event_lag_seconds_bucket[{RATE}])))',
              "p95", "s", description="Includes outbox publication and Redis delivery; excludes the browser network."),
    ]),
])

websocket = dashboard("messenger-websocket", "Messenger WebSocket", [
    ("Connections and delivery", [
        panel("WS proxy active connections", 'nginx_connections_active{tier="ws"}', "proxy"),
        panel("Connections by node", "messenger_ws_connections", "{{instance}}"),
        panel("Redis room subscriptions by node", "messenger_ws_room_subscriptions", "{{instance}}"),
        panel("Outbound socket queue bytes", "messenger_ws_queued_bytes", "{{instance}}", "bytes"),
        panel("Handshake results per second", f'sum by (result) (rate(messenger_ws_handshakes_total[{RATE}]))', "{{result}}", "ops"),
        panel("WS error frames", f'sum by (code) (rate(messenger_ws_error_frames_total[{RATE}]))', "{{code}}", "ops"),
        panel("Slow-client closes per second", f'sum by (instance) (rate(messenger_ws_slow_closes_total[{RATE}]))', "{{instance}}", "ops"),
        panel("Device-applied acknowledgements", f'sum by (result) (rate(messenger_ws_applied_total[{RATE}]))',
              "{{result}}", "ops"),
        panel("Local fanout p95 duration", f'histogram_quantile(0.95, sum by (le) (rate(messenger_ws_fanout_seconds_bucket[{RATE}])))', "p95", "s"),
        panel("Local fanout p95 recipients", f'histogram_quantile(0.95, sum by (le) (rate(messenger_ws_fanout_recipients_bucket[{RATE}])))', "p95", "short"),
        panel("Go heap in use", "go_memstats_heap_inuse_bytes{job=\"ws\"}", "{{instance}}", "bytes"),
        panel("WS process CPU per second", f'rate(process_cpu_seconds_total{{job="ws"}}[{RATE}])', "{{instance}}", "percentunit"),
    ]),
    ("Authorization and broker", [
        panel("Group authorization p95", f'histogram_quantile(0.95, sum by (le, result) (rate(messenger_ws_group_authorization_seconds_bucket[{RATE}])))',
              "{{result}}", "s"),
        panel("Group authorization calls per second", f'sum by (result) (rate(messenger_ws_group_authorization_seconds_count[{RATE}]))',
              "{{result}}", "ops"),
        panel("Rabbit publisher confirmations", f'sum by (result) (rate(messenger_ws_publish_seconds_count[{RATE}]))',
              "{{result}}", "ops"),
        panel("SQL save to WS p95", f'histogram_quantile(0.95, sum by (le, instance) (rate(messenger_ws_saved_event_lag_seconds_bucket[{RATE}])))',
              "{{instance}}", "s"),
    ]),
    ("Recovery and position", [
        panel("Redis replay results per second", f'sum by (result) (rate(messenger_ws_replay_total[{RATE}]))', "{{result}}", "ops"),
        panel("SQL fallback per second", f'sum by (instance) (rate(messenger_ws_sql_fallback_total[{RATE}]))', "{{instance}}", "ops"),
        panel("Recovery-required closes", f'sum by (instance) (rate(messenger_ws_recovery_closes_total[{RATE}]))', "{{instance}}", "ops"),
        panel("Expired group leases", f'sum by (instance) (rate(messenger_ws_group_lease_expired_total[{RATE}]))', "{{instance}}", "ops"),
        panel("Stale rooms per second", f'sum by (instance) (rate(messenger_ws_stale_rooms_total[{RATE}]))', "{{instance}}", "ops"),
        panel("Oldest room position age", "messenger_ws_oldest_room_position_seconds", "{{instance}}", "s"),
        panel("Position sweep p95", f'histogram_quantile(0.95, sum by (le, instance) (rate(messenger_ws_position_sweep_seconds_bucket[{RATE}])))',
              "{{instance}}", "s"),
    ]),
])

backend = dashboard("messenger-backend", "Messenger backend and infrastructure", [
    ("API and Kotlin processes", [
        panel("API 5xx requests per second", f'sum(rate(http_server_requests_seconds_count{{job="api",status=~"5.."}}[{RATE}]))',
              "5xx", "reqps"),
        panel("JVM heap used by service", 'sum by (job, instance) (jvm_memory_used_bytes{area="heap",job=~"api|command-processor|outbox-publisher"})',
              "{{job}} {{instance}}", "bytes"),
        panel("JVM process CPU", 'process_cpu_usage{job=~"api|command-processor|outbox-publisher"}',
              "{{job}} {{instance}}", "percentunit"),
        panel("JVM GC overhead", 'jvm_gc_overhead{job=~"api|command-processor|outbox-publisher"}',
              "{{job}} {{instance}}", "percentunit"),
        panel("JDBC active connections", 'hikaricp_connections_active{job=~"api|command-processor|outbox-publisher"}',
              "{{job}} {{instance}}"),
        panel("JDBC pending connections", 'hikaricp_connections_pending{job=~"api|command-processor|outbox-publisher"}',
              "{{job}} {{instance}}"),
    ]),
    ("Command processors", [
        panel("Send queue depth by partition", 'max by (queue) (rabbitmq_detailed_queue_messages_ready{queue=~"messenger.send.[0-3]"})',
              "{{queue}}"),
        panel("Consumers by queue", 'max by (queue) (rabbitmq_detailed_queue_consumers{queue=~"messenger.send.[0-3]"})',
              "{{queue}}"),
        panel("Unacknowledged commands", 'max by (queue) (rabbitmq_detailed_queue_messages_unacked{queue=~"messenger.send.[0-3]"})',
              "{{queue}}"),
        panel("Command outcomes", f'sum by (kind, outcome) (rate(messenger_command_consumed_total[{RATE}]))',
              "{{kind}} {{outcome}}", "ops"),
        panel("Saved, rejected and duplicate sends", f'sum by (result) (rate(messenger_command_result_total[{RATE}]))',
              "{{result}}", "ops"),
        panel("Command processing p95", f'histogram_quantile(0.95, sum by (le, kind) (rate(messenger_command_processing_seconds_bucket[{RATE}])))',
              "{{kind}}", "s"),
        panel("Queue arrival delay p95", f'histogram_quantile(0.95, sum by (le) (rate(messenger_command_queue_delay_seconds_bucket[{RATE}])))',
              "p95", "s"),
        panel("Dead-letter queue depth", 'max(rabbitmq_detailed_queue_messages_ready{queue="messenger.send.dead"})',
              "dead letters"),
    ]),
    ("Outbox publishers", [
        panel("Pending events", "messenger_outbox_pending", "{{instance}}"),
        panel("Oldest pending event", "messenger_outbox_oldest_age_seconds", "{{instance}}", "s"),
        panel("Redis publication results", f'sum by (result) (rate(messenger_outbox_publish_total[{RATE}]))',
              "{{result}}", "ops"),
        panel("Claimed events per second", f'sum(rate(messenger_outbox_claimed_total[{RATE}]))', "claimed", "ops"),
        panel("Batch p95 duration", f'histogram_quantile(0.95, sum by (le) (rate(messenger_outbox_batch_seconds_bucket[{RATE}])))',
              "p95", "s"),
        panel("Backlog sampler healthy", "messenger_outbox_backlog_sample_healthy", "{{instance}}", kind="stat"),
    ]),
    ("RabbitMQ, Redis, PostgreSQL", [
        panel("RabbitMQ node memory", "rabbitmq_process_resident_memory_bytes", "{{instance}}", "bytes"),
        panel("Redis memory by node", "redis_memory_used_bytes", "{{instance}}", "bytes"),
        panel("Redis commands per second", f'rate(redis_commands_processed_total[{RATE}])', "{{instance}}", "ops"),
        panel("Redis connected clients", "redis_connected_clients", "{{instance}}"),
        panel("Redis network output", f'rate(redis_net_output_bytes_total[{RATE}])', "{{instance}}", "Bps"),
        panel("Redis cluster slots failed", "redis_cluster_slots_fail", "{{instance}}"),
        panel("PostgreSQL connections", 'sum by (state) (pg_stat_activity_count)', "{{state}}"),
        panel("PostgreSQL committed transactions per second", f'sum(rate(pg_stat_database_xact_commit{{datname="messenger"}}[{RATE}]))',
              "commits", "ops"),
        panel("PostgreSQL deadlocks per second", f'sum(rate(pg_stat_database_deadlocks{{datname="messenger"}}[{RATE}]))',
              "deadlocks", "ops"),
        panel("PostgreSQL locks by mode", 'sum by (mode) (pg_locks_count{datname="messenger"})', "{{mode}}"),
        panel("PostgreSQL database size", 'pg_database_size_bytes{datname="messenger"}', "{{datname}}", "bytes"),
    ]),
])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in (("messenger-overview.json", overview),
                       ("messenger-websocket.json", websocket),
                       ("messenger-backend.json", backend)):
        (OUT / name).write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    main()
