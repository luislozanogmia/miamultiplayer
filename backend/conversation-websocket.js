'use strict';

// Small native WebSocket transport for the isolated conversation contract.
// It intentionally depends only on node:http's upgrade socket and the
// transport-neutral realtime module. The production server does not import or
// mount this adapter until the migration integration gate is approved.

const crypto = require('crypto');

const DEFAULT_PATH = '/api/conversations/ws';
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
// A single backend process must not accept an unbounded number of native
// conversation sockets. This is deliberately a transport-level guard; the
// caller can choose a lower deployment-specific ceiling.
const DEFAULT_MAX_CONNECTIONS = 256;
// Browsers reconnect cleanly after an idle timeout. A ten-minute default
// bounds abandoned sockets without treating an ordinary short backgrounding
// interval as a failure. The 30-second credential reauthorization remains a
// separate timer and is never relaxed by this setting.
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

class ConversationWebSocketError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationWebSocketError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConversationWebSocketError(code, message);
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  return value;
}

function safeJsonMessage(payload) {
  let message;
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch (_error) {
    fail('INVALID_MESSAGE', 'websocket message must be valid UTF-8 JSON');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) fail('INVALID_MESSAGE', 'websocket message must be an object');
  return message;
}

function encodeFrame(opcode, payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  if (bytes.length > 0x7fffffffffffffff) fail('MESSAGE_TOO_LARGE', 'websocket payload is too large');
  let header;
  if (bytes.length < 126) {
    header = Buffer.from([0x80 | opcode, bytes.length]);
  } else if (bytes.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(bytes.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  return Buffer.concat([header, bytes]);
}

function httpReject(socket, status, message) {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
}

function attachConversationWebSocketServer({
  server,
  realtime,
  authenticate,
  reauthorize = null,
  reauthorizeIntervalMs = 30_000,
  listHistory = null,
  path = DEFAULT_PATH,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}) {
  if (!server || typeof server.on !== 'function') throw new Error('an HTTP server is required');
  if (!realtime || typeof realtime.connect !== 'function' || typeof realtime.subscribe !== 'function') throw new Error('native realtime transport is required');
  if (typeof authenticate !== 'function') throw new Error('websocket authenticate function is required');
  if (reauthorize !== null && typeof reauthorize !== 'function') throw new Error('websocket reauthorize function is invalid');
  if (reauthorize !== null && (!Number.isInteger(reauthorizeIntervalMs) || reauthorizeIntervalMs < 10)) {
    throw new Error('websocket reauthorize interval must be at least 10ms');
  }
  if (listHistory !== null && typeof listHistory !== 'function') throw new Error('websocket history reader is invalid');
  if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 0x7fffffff) throw new Error('maxMessageBytes must be a positive bounded integer');
  if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new Error('maxConnections must be a positive integer');
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 10) throw new Error('idleTimeoutMs must be an integer of at least 10ms');
  const sockets = new Set();
  let connectionNumber = 0;
  let pendingConnections = 0;
  let transportClosed = false;

  function closeSocket(socket, code = 1000, reason = '') {
    if (!socket || socket.destroyed) return;
    const reasonBytes = Buffer.from(String(reason)).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    try { socket.write(encodeFrame(0x8, payload)); } catch (_error) { /* socket is already closing */ }
    socket.end();
  }

  function rejectAtCapacity(socket) {
    httpReject(socket, '503 Service Unavailable', 'websocket connection limit reached');
  }

  function handleMessage(connectionId, sendJson, message, principal) {
    const type = message.type;
    if (type === 'subscribe') {
      const conversationId = required(message.conversationId, 'conversationId');
      if (message.afterSequence !== undefined && (!Number.isInteger(message.afterSequence) || message.afterSequence < 0)) {
        fail('INVALID_MESSAGE', 'afterSequence must be a non-negative integer');
      }
      try {
        const result = realtime.subscribe(connectionId, conversationId);
        sendJson({ type: 'subscribed', ...result });
        if (message.afterSequence !== undefined) {
          if (!listHistory) fail('NOT_CONFIGURED', 'history replay is not configured');
          const history = listHistory({ principal, conversationId, afterSequence: message.afterSequence });
          if (!history || !Array.isArray(history.events)) fail('INVALID_HISTORY', 'history reader returned an invalid page');
          sendJson({ type: 'history', conversationId, afterSequence: message.afterSequence, ...history });
        }
      } catch (error) {
        const code = error && error.code ? error.code : 'FORBIDDEN';
        sendJson({ type: 'error', code, message: error.message || 'subscription denied' });
      }
      return;
    }
    if (type === 'unsubscribe') {
      const conversationId = required(message.conversationId, 'conversationId');
      const unsubscribed = realtime.unsubscribe(connectionId, conversationId);
      sendJson({ type: 'unsubscribed', conversationId, unsubscribed });
      return;
    }
    if (type === 'ping') {
      sendJson({ type: 'pong' });
      return;
    }
    fail('INVALID_MESSAGE', 'unsupported websocket message type');
  }

  function reserveConnection(socket) {
    if (transportClosed || sockets.size + pendingConnections >= maxConnections) {
      rejectAtCapacity(socket);
      return false;
    }
    pendingConnections += 1;
    return true;
  }

  function releasePendingConnection() {
    if (pendingConnections > 0) pendingConnections -= 1;
  }

  function handleUpgrade(request, socket) {
    let requestUrl;
    try { requestUrl = new URL(request.url || '/', 'http://miaos.invalid'); } catch (_error) { return; }
    if (requestUrl.pathname !== path) return;
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13') {
      httpReject(socket, '400 Bad Request', 'websocket upgrade required');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length < 16 || key.length > 128) {
      httpReject(socket, '400 Bad Request', 'invalid websocket key');
      return;
    }
    if (!reserveConnection(socket)) return;
    let authenticated;
    try {
      authenticated = authenticate(request);
    } catch (_error) {
      releasePendingConnection();
      httpReject(socket, '401 Unauthorized', 'unauthorized');
      return;
    }
    if (authenticated && typeof authenticated.then === 'function') {
      authenticated
        .then(
          (principal) => finishUpgrade(request, socket, key, principal),
          () => {
            releasePendingConnection();
            httpReject(socket, '401 Unauthorized', 'unauthorized');
          }
        );
      return;
    }
    finishUpgrade(request, socket, key, authenticated);
  }

  function finishUpgrade(request, socket, key, principal) {
    releasePendingConnection();
    if (transportClosed) {
      httpReject(socket, '503 Service Unavailable', 'websocket server is shutting down');
      return;
    }
    // A pending async authentication callback may resolve after another
    // connection completed. Re-check the active ceiling before the 101.
    if (sockets.size >= maxConnections) {
      rejectAtCapacity(socket);
      return;
    }
    if (!principal || typeof principal !== 'object') {
      httpReject(socket, '401 Unauthorized', 'unauthorized');
      return;
    }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const connectionId = `ws_${++connectionNumber}`;
    let buffer = Buffer.alloc(0);
    let fragmentOpcode = null;
    let fragmentParts = [];
    let fragmentBytes = 0;
    let closed = false;
    let reauthorizeTimer = null;
    let idleTimer = null;
    let lastActivityAt = Date.now();
    sockets.add(socket);

    const sendJson = (message) => {
      if (closed || socket.destroyed) throw new Error('websocket is closed');
      const payload = Buffer.from(JSON.stringify(message));
      if (payload.length > maxMessageBytes) throw new ConversationWebSocketError('MESSAGE_TOO_LARGE', 'websocket message is too large');
      socket.write(encodeFrame(0x1, payload));
    };
    const realtimeConnectionId = realtime.connect({ id: connectionId, principal, send: sendJson });

    function finishClose() {
      if (closed) return;
      closed = true;
      if (reauthorizeTimer) clearInterval(reauthorizeTimer);
      if (idleTimer) clearTimeout(idleTimer);
      sockets.delete(socket);
      realtime.disconnect(realtimeConnectionId);
    }

    function protocolClose(code, reason) {
      closeSocket(socket, code, reason);
      finishClose();
    }

    function armIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (closed) return;
        const idleFor = Date.now() - lastActivityAt;
        if (idleFor >= idleTimeoutMs) {
          protocolClose(1001, 'idle timeout');
          return;
        }
        armIdleTimer();
      }, idleTimeoutMs);
      idleTimer.unref();
    }

    function markActivity() {
      lastActivityAt = Date.now();
      armIdleTimer();
    }

    function deliverText(payload) {
      try {
        if (reauthorize && reauthorize(request, principal) !== true) {
          protocolClose(1008, 'authorization expired');
          return;
        }
        handleMessage(realtimeConnectionId, sendJson, safeJsonMessage(payload), principal);
      } catch (error) {
        const code = error && error.code ? error.code : 'INVALID_MESSAGE';
        try { sendJson({ type: 'error', code, message: error.message || 'invalid websocket message' }); } catch (_sendError) { protocolClose(1011, 'send failure'); }
      }
    }

    function parseFrames() {
      while (!closed && buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const rsv = first & 0x70;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let headerLength = 2;
        if (rsv !== 0 || !masked) { protocolClose(1002, 'invalid websocket frame'); return; }
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          headerLength = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const largeLength = buffer.readBigUInt64BE(2);
          if (largeLength > BigInt(maxMessageBytes)) { protocolClose(1009, 'message too large'); return; }
          length = Number(largeLength);
          headerLength = 10;
        }
        if (length > maxMessageBytes) { protocolClose(1009, 'message too large'); return; }
        const totalLength = headerLength + 4 + length;
        if (buffer.length < totalLength) return;
        if ((opcode & 0x8) !== 0 && (!fin || length > 125)) { protocolClose(1002, 'invalid control frame'); return; }
        const maskOffset = headerLength;
        const payloadOffset = headerLength + 4;
        const mask = buffer.subarray(maskOffset, payloadOffset);
        const payload = Buffer.from(buffer.subarray(payloadOffset, totalLength));
        buffer = buffer.subarray(totalLength);
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];

        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          closeSocket(socket, code, payload.length > 2 ? payload.subarray(2).toString() : '');
          finishClose();
          return;
        }
        if (opcode === 0x9) { socket.write(encodeFrame(0xA, payload)); continue; }
        if (opcode === 0xA) continue;
        if (opcode === 0x1) {
          if (fragmentOpcode !== null) { protocolClose(1002, 'unexpected text frame'); return; }
          if (fin) deliverText(payload);
          else { fragmentOpcode = opcode; fragmentParts = [payload]; fragmentBytes = payload.length; }
          continue;
        }
        if (opcode === 0x0) {
          if (fragmentOpcode === null) { protocolClose(1002, 'unexpected continuation'); return; }
          fragmentParts.push(payload);
          fragmentBytes += payload.length;
          if (fragmentBytes > maxMessageBytes) { protocolClose(1009, 'message too large'); return; }
          if (fin) {
            deliverText(Buffer.concat(fragmentParts));
            fragmentOpcode = null;
            fragmentParts = [];
            fragmentBytes = 0;
          }
          continue;
        }
        protocolClose(1002, 'unsupported websocket opcode');
        return;
      }
    }

    socket.on('data', (chunk) => {
      if (closed) return;
      markActivity();
      buffer = Buffer.concat([buffer, chunk]);
      parseFrames();
      if (!closed && buffer.length > maxMessageBytes + 14) { protocolClose(1009, 'message too large'); }
    });
    socket.on('end', finishClose);
    socket.on('close', finishClose);
    socket.on('error', finishClose);
    if (reauthorize) {
      reauthorizeTimer = setInterval(() => {
        try {
          if (reauthorize(request, principal) !== true) protocolClose(1008, 'authorization expired');
        } catch (_error) {
          protocolClose(1008, 'authorization expired');
        }
      }, reauthorizeIntervalMs);
      reauthorizeTimer.unref();
    }
    armIdleTimer();
    try { sendJson({ type: 'ready', connectionId }); } catch (_error) { protocolClose(1011, 'initialization failed'); }
  }

  server.on('upgrade', handleUpgrade);
  return {
    close() {
      transportClosed = true;
      server.off('upgrade', handleUpgrade);
      for (const socket of sockets) closeSocket(socket, 1001, 'server shutdown');
      sockets.clear();
    },
  };
}

module.exports = {
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PATH,
  ConversationWebSocketError,
  attachConversationWebSocketServer,
  encodeFrame,
};
