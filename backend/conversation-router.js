'use strict';

// Native conversation HTTP contract. The router is intentionally unmounted
// from server.js until Gate 0 and the integration slice are approved. The
// caller supplies the authenticated principal; this module never trusts an
// identity supplied in request JSON.

const express = require('express');
const {
  isSafePreviewMime,
  previewContentSecurityPolicy,
} = require('./artifact-policy');

const STATUS_BY_CODE = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_PARENT: 400,
  UNSUPPORTED_TYPE: 415,
  TOO_LARGE: 413,
  CORRUPT_DATA: 500,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PREVIEW_UNAVAILABLE: 415,
  INVALID_DATABASE: 500,
  INVALID_REPOSITORY: 500,
  INVALID_AUTHORIZATION: 500,
});

class ConversationRouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationRouterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConversationRouterError(code, message);
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  return value;
}

function optionalObject(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${field} must be an object`);
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail('INVALID_INPUT', `${field} must be a boolean`);
  return value;
}

function optionalInteger(value, field, { min = 0, max = 1000 } = {}) {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail('INVALID_INPUT', `${field} must be an integer from ${min} to ${max}`);
  return parsed;
}

function decodeBase64(value) {
  required(value, 'contentBase64');
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('INVALID_INPUT', 'contentBase64 must be standard base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('INVALID_INPUT', 'contentBase64 must be canonical base64');
  return bytes;
}

function requestBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail('INVALID_INPUT', 'request body must be an object');
  return req.body;
}

function routeError(error) {
  const code = error && error.code ? error.code : 'INTERNAL_ERROR';
  return {
    status: STATUS_BY_CODE[code] || 500,
    payload: { error: code, message: error && error.message ? error.message : 'internal server error' },
  };
}

function createConversationRouter({ service, attachmentStore = null, resolvePrincipal }) {
  if (!service) throw new Error('native conversation service is required');
  if (typeof resolvePrincipal !== 'function') throw new Error('resolvePrincipal is required');
  if (attachmentStore && typeof attachmentStore.createAttachment !== 'function') throw new Error('invalid attachment store');

  const router = express.Router();

  function context(req) {
    const principal = resolvePrincipal(req);
    if (!principal || typeof principal !== 'object') fail('UNAUTHORIZED', 'authenticated principal is required');
    const companyId = required(principal.companyId, 'principal.companyId');
    required(principal.principalId, 'principal.principalId');
    required(principal.principalType, 'principal.principalType');
    return { companyId, principal };
  }

  function handle(handler) {
    return async (req, res, next) => {
      try {
        await handler(req, res);
      } catch (error) {
        if (res.headersSent) return next(error);
        const mapped = routeError(error);
        res.status(mapped.status).json(mapped.payload);
      }
    };
  }

  router.get('/conversations', handle((req, res) => {
    const { companyId, principal } = context(req);
    const limit = optionalInteger(req.query.limit, 'limit', { min: 1, max: 1000 });
    const conversations = service.listConversations({
      companyId,
      principal,
      includeDeleted: req.query.includeDeleted === 'true',
      ...(limit === undefined ? {} : { limit }),
    });
    res.status(200).json({ conversations });
  }));

  router.post('/conversations', handle((req, res) => {
    const { companyId, principal } = context(req);
    const body = requestBody(req);
    const conversation = service.createConversation({
      companyId,
      principal,
      type: required(body.type, 'type'),
      name: body.name === undefined ? null : body.name,
      metadata: optionalObject(body.metadata, 'metadata'),
    });
    res.status(201).json({ conversation });
  }));

  router.get('/conversations/:conversationId', handle((req, res) => {
    const { companyId, principal } = context(req);
    const conversation = service.getConversation({ companyId, conversationId: req.params.conversationId, principal });
    res.status(200).json({ conversation });
  }));

  router.delete('/conversations/:conversationId', handle((req, res) => {
    const { companyId, principal } = context(req);
    const result = service.deleteConversation({
      companyId,
      conversationId: req.params.conversationId,
      principal,
    });
    res.status(200).json(result);
  }));

  router.post('/conversations/:conversationId/restart', handle((req, res) => {
    const { companyId, principal } = context(req);
    const result = service.restartConversation({
      companyId,
      conversationId: req.params.conversationId,
      principal,
    });
    res.status(200).json(result);
  }));

  router.get('/conversations/:conversationId/members', handle((req, res) => {
    const { companyId, principal } = context(req);
    const members = service.listMembers({ companyId, conversationId: req.params.conversationId, principal });
    res.status(200).json({ members });
  }));

  router.post('/conversations/:conversationId/members', handle((req, res) => {
    const { companyId, principal } = context(req);
    const body = requestBody(req);
    const member = service.addMember({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      member: {
        principalId: required(body.principalId, 'principalId'),
        principalType: required(body.principalType, 'principalType'),
        role: body.role === undefined ? 'member' : body.role,
        state: body.state === undefined ? 'active' : body.state,
        metadata: optionalObject(body.metadata, 'metadata'),
      },
    });
    res.status(201).json({ member });
  }));

  router.delete('/conversations/:conversationId/members/:principalType/:principalId', handle((req, res) => {
    const { companyId, principal } = context(req);
    const member = service.removeMember({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      member: {
        principalId: req.params.principalId,
        principalType: req.params.principalType,
      },
    });
    res.status(200).json({ member });
  }));

  router.get('/conversations/:conversationId/events', handle((req, res) => {
    const { companyId, principal } = context(req);
    const afterSequence = optionalInteger(req.query.afterSequence, 'afterSequence', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const beforeSequence = optionalInteger(req.query.beforeSequence, 'beforeSequence', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const limit = optionalInteger(req.query.limit, 'limit', { min: 1, max: 100 });
    const events = service.listEvents({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      includeDeleted: req.query.includeDeleted !== 'false',
      latest: req.query.latest === 'true',
      ...(afterSequence === undefined ? {} : { afterSequence }),
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      ...(limit === undefined ? {} : { limit }),
    });
    res.status(200).json(events);
  }));

  router.get('/conversations/:conversationId/dispatches/active', handle((req, res) => {
    const { companyId, principal } = context(req);
    const dispatches = service.listActiveDispatches({
      companyId,
      conversationId: req.params.conversationId,
      principal,
    });
    res.status(200).json({ dispatches });
  }));

  router.post('/conversations/:conversationId/dispatches/:dispatchId/stop', handle(async (req, res) => {
    const { companyId, principal } = context(req);
    const result = await service.stopDispatch({
      companyId,
      conversationId: req.params.conversationId,
      dispatchId: req.params.dispatchId,
      principal,
    });
    res.status(200).json(result);
  }));

  router.post('/conversations/:conversationId/events', handle((req, res) => {
    const { companyId, principal } = context(req);
    const body = requestBody(req);
    const result = service.createEvent({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      type: body.type === undefined ? 'message' : body.type,
      content: body.content,
      parentEventId: body.parentEventId === undefined ? null : body.parentEventId,
      clientIdempotencyKey: body.clientIdempotencyKey === undefined ? null : body.clientIdempotencyKey,
      metadata: optionalObject(body.metadata, 'metadata'),
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  }));

  router.patch('/conversations/:conversationId/events/:eventId', handle((req, res) => {
    const { companyId, principal } = context(req);
    const body = requestBody(req);
    const result = service.updateEvent({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      eventId: req.params.eventId,
      ...(body.content === undefined ? {} : { content: body.content }),
      ...(body.metadata === undefined ? {} : { metadata: optionalObject(body.metadata, 'metadata') }),
    });
    res.status(200).json(result);
  }));

  router.delete('/conversations/:conversationId/events/:eventId', handle((req, res) => {
    const { companyId, principal } = context(req);
    const result = service.deleteEvent({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      eventId: req.params.eventId,
    });
    res.status(200).json(result);
  }));

  router.get('/conversations/:conversationId/events/:eventId/thread', handle((req, res) => {
    const { companyId, principal } = context(req);
    const thread = service.getThread({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      eventId: req.params.eventId,
      includeDeleted: req.query.includeDeleted !== 'false',
    });
    if (!thread) return res.status(404).json({ error: 'NOT_FOUND', message: 'event not found' });
    res.status(200).json(thread);
  }));

  router.get('/conversations/:conversationId/state', handle((req, res) => {
    const { companyId, principal } = context(req);
    const state = service.getState({ companyId, conversationId: req.params.conversationId, principal });
    res.status(200).json({ state });
  }));

  router.patch('/conversations/:conversationId/state', handle((req, res) => {
    const { companyId, principal } = context(req);
    const body = requestBody(req);
    const state = service.updateState({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      ...(body.pinned === undefined ? {} : { pinned: optionalBoolean(body.pinned, 'pinned') }),
      ...(body.hidden === undefined ? {} : { hidden: optionalBoolean(body.hidden, 'hidden') }),
      ...(body.lastReadEventId === undefined ? {} : { lastReadEventId: body.lastReadEventId }),
    });
    res.status(200).json({ state });
  }));

  router.post('/conversations/:conversationId/attachments', handle(async (req, res) => {
    if (!attachmentStore) return res.status(501).json({ error: 'NOT_CONFIGURED', message: 'attachment storage is not configured' });
    const { companyId, principal } = context(req);
    const body = requestBody(req);
    const attachment = await attachmentStore.createAttachment({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      eventId: body.eventId === undefined ? null : body.eventId,
      filename: body.filename,
      mimeType: body.mimeType,
      bytes: decodeBase64(body.contentBase64),
    });
    res.status(201).json({ attachment });
  }));

  router.get('/conversations/:conversationId/attachments/:attachmentId', handle(async (req, res) => {
    if (!attachmentStore) return res.status(501).json({ error: 'NOT_CONFIGURED', message: 'attachment storage is not configured' });
    const { companyId, principal } = context(req);
    const result = await attachmentStore.readAttachment({
      companyId,
      conversationId: req.params.conversationId,
      principal,
      id: req.params.attachmentId,
    });
    if (!result) return res.status(404).json({ error: 'NOT_FOUND', message: 'attachment not found' });
    const previewRequested = ['1', 'true'].includes(String(req.query.preview || '').toLowerCase());
    if (previewRequested && !isSafePreviewMime(result.metadata.mimeType)) {
      fail('PREVIEW_UNAVAILABLE', 'a safe in-app preview is not available for this file type');
    }
    res.status(200);
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', result.metadata.mimeType || 'application/octet-stream');
    res.set('Content-Length', String(result.bytes.length));
    const filename = result.metadata.filename.replace(/["\\\r\n]/g, '_');
    res.set('Content-Disposition', `${previewRequested ? 'inline' : 'attachment'}; filename="${filename}"`);
    if (previewRequested) {
      const contentSecurityPolicy = previewContentSecurityPolicy(result.metadata.mimeType);
      if (contentSecurityPolicy) res.set('Content-Security-Policy', contentSecurityPolicy);
    }
    res.send(result.bytes);
  }));

  return router;
}

module.exports = {
  ConversationRouterError,
  STATUS_BY_CODE,
  createConversationRouter,
};
