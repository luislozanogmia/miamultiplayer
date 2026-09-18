'use strict';

// Transport-neutral realtime fanout. An HTTP/WebSocket adapter can translate
// the returned connection id and message objects into its socket lifecycle;
// this module owns subscription authorization and delivery filtering.

const crypto = require('crypto');

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

function createConversationRealtime(authorization) {
  if (!authorization || typeof authorization.authorize !== 'function' || typeof authorization.can !== 'function') {
    throw new Error('native conversation authorization is required');
  }
  const connections = new Map();

  function connect({ id, principal, send }) {
    const connectionId = id || `conn_${crypto.randomUUID().replaceAll('-', '')}`;
    required(connectionId, 'connection id');
    if (typeof send !== 'function') throw new Error('connection send function is required');
    if (connections.has(connectionId)) throw new Error('connection id already exists');
    connections.set(connectionId, {
      principal: { ...principal },
      send,
      subscriptions: new Set(),
    });
    return connectionId;
  }

  function disconnect(connectionId) {
    return connections.delete(required(connectionId, 'connectionId'));
  }

  function subscribe(connectionId, conversationId) {
    const connection = connections.get(required(connectionId, 'connectionId'));
    if (!connection) throw new Error('connection not found');
    const id = required(conversationId, 'conversationId');
    authorization.authorize({
      ...connection.principal,
      conversationId: id,
      operation: 'subscribe',
    });
    connection.subscriptions.add(id);
    return { connectionId, conversationId: id, subscribed: true };
  }

  function unsubscribe(connectionId, conversationId) {
    const connection = connections.get(required(connectionId, 'connectionId'));
    if (!connection) return false;
    return connection.subscriptions.delete(required(conversationId, 'conversationId'));
  }

  function publish(event) {
    if (!event || typeof event.conversationId !== 'string') throw new Error('native event is required');
    const message = {
      type: 'conversation.event',
      conversationId: event.conversationId,
      event,
    };
    let delivered = 0;
    let failed = 0;
    for (const [connectionId, connection] of connections) {
      if (!connection.subscriptions.has(event.conversationId)) continue;
      if (!authorization.can({
        ...connection.principal,
        conversationId: event.conversationId,
        operation: 'subscribe',
      })) {
        connection.subscriptions.delete(event.conversationId);
        continue;
      }
      try {
        connection.send(message);
        delivered += 1;
      } catch (error) {
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  function connectionCount() {
    return connections.size;
  }

  return { connect, disconnect, subscribe, unsubscribe, publish, connectionCount };
}

module.exports = { createConversationRealtime };
