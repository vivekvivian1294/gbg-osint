import { ClientMessage, MAX_SUBSCRIPTIONS, type ServerMessage } from '@gbg-osint/shared';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { clientKey } from '../core/net';
import type { ChannelStore } from '../core/store';

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_INVALID_MESSAGES = 10;

interface Client {
  socket: WebSocket;
  channels: Set<string>;
  invalid: number;
  alive: boolean;
}

export interface GatewayOptions {
  maxConnectionsPerIp: number;
}

export function registerGateway(
  app: FastifyInstance,
  store: ChannelStore,
  options: GatewayOptions,
): void {
  const clients = new Set<Client>();
  const connectionsPerIp = new Map<string, number>();

  const send = (client: Client, payload: string): void => {
    const { socket } = client;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, 'Client too slow');
      return;
    }
    socket.send(payload);
  };
  const sendMessage = (client: Client, msg: ServerMessage): void =>
    send(client, JSON.stringify(msg));

  const unsubscribeStore = store.onDelta((delta) => {
    let payload: string | undefined;
    for (const client of clients) {
      if (!client.channels.has(delta.channel)) continue;
      payload ??= JSON.stringify({ type: 'delta', ...delta } satisfies ServerMessage);
      send(client, payload);
    }
  });

  const reject = (client: Client, code: string, message: string): void => {
    client.invalid++;
    sendMessage(client, { type: 'error', code, message });
    if (client.invalid >= MAX_INVALID_MESSAGES)
      client.socket.close(1008, 'Too many invalid messages');
  };

  const handle = (client: Client, msg: ClientMessage): void => {
    switch (msg.type) {
      case 'ping':
        sendMessage(client, { type: 'pong' });
        return;
      case 'unsubscribe':
        for (const ch of msg.channels) client.channels.delete(ch);
        return;
      case 'subscribe':
        for (const channel of msg.channels) {
          if (client.channels.has(channel)) continue;
          if (!store.has(channel)) {
            sendMessage(client, {
              type: 'error',
              code: 'unknown_channel',
              message: `Unknown channel: ${channel}`,
            });
            continue;
          }
          if (client.channels.size >= MAX_SUBSCRIPTIONS) {
            sendMessage(client, {
              type: 'error',
              code: 'too_many_subscriptions',
              message: `At most ${MAX_SUBSCRIPTIONS} subscriptions per connection`,
            });
            return;
          }
          client.channels.add(channel);
          sendMessage(client, {
            type: 'snapshot',
            channel,
            items: store.snapshot(channel),
            ts: new Date().toISOString(),
          });
        }
        return;
    }
  };

  app.get('/ws', { websocket: true }, (socket, request) => {
    const ip = clientKey(request.ip);
    const open = connectionsPerIp.get(ip) ?? 0;
    if (open >= options.maxConnectionsPerIp) {
      socket.close(1008, 'Too many connections');
      return;
    }
    connectionsPerIp.set(ip, open + 1);

    const client: Client = { socket, channels: new Set(), invalid: 0, alive: true };
    clients.add(client);

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary || !Buffer.isBuffer(raw)) {
        reject(client, 'unsupported', 'Only JSON text messages are supported');
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        reject(client, 'invalid_json', 'Message is not valid JSON');
        return;
      }
      const parsed = ClientMessage.safeParse(data);
      if (!parsed.success) {
        reject(client, 'invalid_message', 'Message does not match the protocol');
        return;
      }
      handle(client, parsed.data);
    });

    socket.on('close', () => {
      clients.delete(client);
      const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (remaining > 0) connectionsPerIp.set(ip, remaining);
      else connectionsPerIp.delete(ip);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    unsubscribeStore();
    for (const client of clients) client.socket.close(1001, 'Server shutting down');
  });
}
