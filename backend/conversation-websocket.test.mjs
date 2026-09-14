import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository.js');
const { createConversationAuthorization } = require('./conversation-authorization.js');
const { createConversationRealtime } = require('./conversation-realtime.js');
const { createConversationService } = require('./conversation-service.js');
const { attachConversationWebSocketServer } = require('./conversation-websocket.js');

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  drain() {
    while (this.waiters.length) {
      const waiter = this.waiters[0]();
      if (waiter === undefined) return;
      this.waiters.shift();
      waiter.resolve(waiter.value);
    }
  }

  async readUntil(marker) {
    while (true) {
      const index = this.buffer.indexOf(marker);
      if (index !== -1) {
        const end = index + marker.length;
        const result = this.buffer.subarray(0, end).toString();
        this.buffer = this.buffer.subarray(end);
        return result;
      }
      await this.waitForData();
    }
  }

  async waitForData() {
    await new Promise((resolve, reject) => {
      const waiter = () => {
        if (!this.buffer.length) return undefined;
        return { resolve, value: true };
      };
      this.waiters.push(waiter);
      this.socket.once('error', reject);
      this.socket.once('close', () => reject(new Error('socket closed before a websocket frame arrived')));
    });
  }

  async readFrame() {
    while (true) {
      if (this.buffer.length >= 2) {
        const first = this.buffer[0];
        const second = this.buffer[1];
        let length = second & 0x7f;
        let headerLength = 2;
        if (length === 126) {
          if (this.buffer.length < 4) { await this.waitForData(); continue; }
          length = this.buffer.readUInt16BE(2);
          headerLength = 4;
        } else if (length === 127) {
          if (this.buffer.length < 10) { await this.waitForData(); continue; }
          length = Number(this.buffer.readBigUInt64BE(2));
          headerLength = 10;
        }
        const end = headerLength + length;
        if (this.buffer.length >= end) {
          const payload = this.buffer.subarray(headerLength, end);
          this.buffer = this.buffer.subarray(end);
          return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload };
        }
      }
      await this.waitForData();
    }
  }
}

function clientFrame(value, { opcode = 0x1, fin = true } = {}) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const mask = Buffer.from([0x13, 0x57, 0x9b, 0xdf]);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

async function openSocket(port, principalHeader) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const reader = new SocketReader(socket);
  const key = Buffer.from(`fixture-${principalHeader || 'none'}-key`).subarray(0, 16).toString('base64');
  socket.write(
    `GET /api/conversations/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n` +
    (principalHeader ? `X-Principal: ${principalHeader}\r\n` : '') +
    `\r\n`
  );
  const header = await reader.readUntil('\r\n\r\n');
  return { socket, reader, header };
}

async function fixture(options = {}) {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const realtime = createConversationRealtime(authorization);
  const service = createConversationService({ repository, authorization, realtime });
  const owner = { companyId: 'company-a', principalId: 'owner@example.com', principalType: 'user' };
  const member = { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' };
  const conversation = service.createConversation({ companyId: owner.companyId, principal: owner, type: 'channel', name: 'WS' });
  service.addMember({ companyId: owner.companyId, conversationId: conversation.id, principal: owner, member: { principalId: member.principalId, principalType: member.principalType } });
  const principals = new Map([
    ['owner', owner],
    ['member', member],
    ['outsider', { companyId: 'company-a', principalId: 'outsider@example.com', principalType: 'user' }],
  ]);
  let authorized = true;
  const server = http.createServer();
  const transport = attachConversationWebSocketServer({
    server,
    realtime,
    authenticate: (request) => principals.get(request.headers['x-principal']) || null,
    ...(options.reauthorize ? {
      reauthorize: (request, principal) => authorized
        && principals.get(request.headers['x-principal']) === principal,
      reauthorizeIntervalMs: 10,
    } : {}),
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    listHistory: ({ principal, conversationId, afterSequence }) => service.listEvents({
      companyId: principal.companyId,
      conversationId,
      principal,
      afterSequence,
      limit: 100,
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    db,
    service,
    realtime,
    owner,
    conversation,
    server,
    transport,
    revoke() { authorized = false; },
    port: server.address().port,
    async close() {
      transport.close();
      server.close();
      await once(server, 'close');
      db.close();
    },
  };
}

test('websocket handshake, subscription, and native event delivery work after persistence', async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const client = await openSocket(app.port, 'owner');
  t.after(() => client.socket.destroy());
  assert.match(client.header, /^HTTP\/1\.1 101 Switching Protocols/m);
  assert.deepEqual(JSON.parse((await client.reader.readFrame()).payload.toString()), { type: 'ready', connectionId: 'ws_1' });

  client.socket.write(clientFrame(JSON.stringify({ type: 'subscribe', conversationId: app.conversation.id })));
  const subscribed = JSON.parse((await client.reader.readFrame()).payload.toString());
  assert.equal(subscribed.subscribed, true);

  const result = app.service.createEvent({
    companyId: app.owner.companyId,
    conversationId: app.conversation.id,
    principal: app.owner,
    content: { text: 'durable before fanout' },
  });
  assert.equal(result.event.sequence, 1);
  const delivered = JSON.parse((await client.reader.readFrame()).payload.toString());
  assert.equal(delivered.type, 'conversation.event');
  assert.equal(delivered.event.id, result.event.id);
});

test('websocket closes with policy violation after its credential is revoked', async (t) => {
  const app = await fixture({ reauthorize: true });
  t.after(() => app.close());
  const client = await openSocket(app.port, 'owner');
  t.after(() => client.socket.destroy());
  await client.reader.readFrame();

  app.revoke();
  const closed = await client.reader.readFrame();
  assert.equal(closed.opcode, 0x8);
  assert.equal(closed.payload.readUInt16BE(0), 1008);
  assert.match(closed.payload.subarray(2).toString(), /authorization expired/);
});

test('websocket authorization rejects an unrecognized principal and an unauthorized subscription', async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const missing = await openSocket(app.port);
  t.after(() => missing.socket.destroy());
  assert.match(missing.header, /^HTTP\/1\.1 401 Unauthorized/m);

  const outsider = await openSocket(app.port, 'outsider');
  t.after(() => outsider.socket.destroy());
  assert.match(outsider.header, /^HTTP\/1\.1 101 Switching Protocols/m);
  await outsider.reader.readFrame();
  outsider.socket.write(clientFrame(JSON.stringify({ type: 'subscribe', conversationId: app.conversation.id })));
  const denied = JSON.parse((await outsider.reader.readFrame()).payload.toString());
  assert.equal(denied.type, 'error');
  assert.equal(denied.code, 'FORBIDDEN');
});

test('websocket transport rejects connections beyond its configured ceiling', async (t) => {
  const app = await fixture({ maxConnections: 1 });
  t.after(() => app.close());
  const first = await openSocket(app.port, 'owner');
  t.after(() => first.socket.destroy());
  assert.match(first.header, /^HTTP\/1\.1 101 Switching Protocols/m);
  await first.reader.readFrame();

  const second = await openSocket(app.port, 'member');
  t.after(() => second.socket.destroy());
  assert.match(second.header, /^HTTP\/1\.1 503 Service Unavailable/m);
  assert.equal(app.realtime.connectionCount(), 1);
});

test('websocket transport closes an idle connection and removes its realtime subscription', async (t) => {
  const app = await fixture({ idleTimeoutMs: 25 });
  t.after(() => app.close());
  const client = await openSocket(app.port, 'owner');
  t.after(() => client.socket.destroy());
  await client.reader.readFrame();

  const closed = await client.reader.readFrame();
  assert.equal(closed.opcode, 0x8);
  assert.equal(closed.payload.readUInt16BE(0), 1001);
  assert.match(closed.payload.subarray(2).toString(), /idle timeout/);
  assert.equal(app.realtime.connectionCount(), 0);
});

test('websocket transport accepts fragmented JSON and answers protocol ping', async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const client = await openSocket(app.port, 'owner');
  t.after(() => client.socket.destroy());
  await client.reader.readFrame();
  const payload = JSON.stringify({ type: 'subscribe', conversationId: app.conversation.id });
  const midpoint = Math.floor(payload.length / 2);
  client.socket.write(clientFrame(payload.slice(0, midpoint), { fin: false }));
  client.socket.write(clientFrame(payload.slice(midpoint), { opcode: 0x0, fin: true }));
  assert.equal(JSON.parse((await client.reader.readFrame()).payload.toString()).subscribed, true);
  client.socket.write(clientFrame('check', { opcode: 0x9 }));
  const pong = await client.reader.readFrame();
  assert.equal(pong.opcode, 0xA);
  assert.equal(pong.payload.toString(), 'check');
});

test('chat-migration.history-pagination.001 chat-migration.poll-reconnect-health.001 — websocket reconnect replays only events after the supplied native cursor', async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const first = app.service.createEvent({
    companyId: app.owner.companyId,
    conversationId: app.conversation.id,
    principal: app.owner,
    content: { text: 'already received' },
  }).event;
  const second = app.service.createEvent({
    companyId: app.owner.companyId,
    conversationId: app.conversation.id,
    principal: app.owner,
    content: { text: 'replay after reconnect' },
  }).event;
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);

  const client = await openSocket(app.port, 'owner');
  t.after(() => client.socket.destroy());
  await client.reader.readFrame();
  client.socket.write(clientFrame(JSON.stringify({ type: 'subscribe', conversationId: app.conversation.id, afterSequence: first.sequence })));
  const subscribed = JSON.parse((await client.reader.readFrame()).payload.toString());
  assert.equal(subscribed.type, 'subscribed');
  const history = JSON.parse((await client.reader.readFrame()).payload.toString());
  assert.equal(history.type, 'history');
  assert.deepEqual(history.events.map((event) => event.id), [second.id]);
  assert.equal(history.nextAfterSequence, null);
});
