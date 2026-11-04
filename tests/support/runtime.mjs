export const apiBase = process.env.MESSENGER_API_BASE_URL ?? 'http://localhost:8081/api';
export const wsUrl = process.env.MESSENGER_WS_URL ?? 'ws://localhost:8082/ws';
export const clientOrigin = process.env.MESSENGER_CLIENT_ORIGIN ?? 'http://localhost:8080';
export const redisNodes = ['redis-1', 'redis-2', 'redis-3', 'redis-4', 'redis-5', 'redis-6'];
export const composeOptions = process.env.MESSENGER_COMPOSE_PROJECT
  ? ['-p', process.env.MESSENGER_COMPOSE_PROJECT, '-f', 'compose.yaml',
    ...(process.env.MESSENGER_COMPOSE_OVERRIDE ? ['-f', process.env.MESSENGER_COMPOSE_OVERRIDE] : [])]
  : [];
