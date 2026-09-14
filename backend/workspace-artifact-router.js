'use strict';

const express = require('express');
const { WorkspaceArtifactError } = require('./workspace-artifacts');

const STATUS_BY_CODE = Object.freeze({
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  TOO_LARGE: 413,
  CORRUPT_DATA: 500,
});

function createWorkspaceArtifactRouter({ service, resolvePrincipal, requireInteractive }) {
  if (!service || typeof service.createWorkspace !== 'function') throw new Error('workspace artifact service is required');
  if (typeof resolvePrincipal !== 'function') throw new Error('resolvePrincipal is required');
  const router = express.Router();
  const interactive = typeof requireInteractive === 'function'
    ? requireInteractive
    : (_req, _res, next) => next();

  function handle(operation) {
    return (req, res, next) => {
      try {
        return operation(req, res);
      } catch (error) {
        return next(error);
      }
    };
  }

  function principal(req) {
    return resolvePrincipal(req);
  }

  router.get('/workspaces', handle((req, res) => {
    res.status(200).json({ workspaces: service.listWorkspaces({ principal: principal(req) }) });
  }));

  router.post('/workspaces', interactive, handle((req, res) => {
    const workspace = service.createWorkspace({ principal: principal(req), name: req.body && req.body.name });
    res.status(201).json({ workspace });
  }));

  router.get('/workspaces/:workspaceId/members', handle((req, res) => {
    const members = service.listMembers({ workspaceId: req.params.workspaceId, principal: principal(req) });
    res.status(200).json({ members });
  }));

  router.post('/workspaces/:workspaceId/members', interactive, handle((req, res) => {
    const member = service.addMember({
      workspaceId: req.params.workspaceId,
      principal: principal(req),
      member: req.body,
    });
    res.status(201).json({ member });
  }));

  router.delete('/workspaces/:workspaceId/members/:principalType/:principalId', interactive, handle((req, res) => {
    const member = service.removeMember({
      workspaceId: req.params.workspaceId,
      principal: principal(req),
      member: {
        principalId: req.params.principalId,
        principalType: req.params.principalType,
      },
    });
    res.status(200).json({ member });
  }));

  router.get('/workspaces/:workspaceId/artifacts', handle((req, res) => {
    const artifacts = service.listArtifacts({ workspaceId: req.params.workspaceId, principal: principal(req) });
    res.status(200).json({ artifacts });
  }));

  router.post('/workspaces/:workspaceId/artifacts', handle((req, res) => {
    const result = service.createArtifact({
      workspaceId: req.params.workspaceId,
      principal: principal(req),
      payload: req.body,
    });
    res.status(201).json(result);
  }));

  router.get('/workspaces/:workspaceId/artifacts/:artifactId/versions', handle((req, res) => {
    const versions = service.listVersions({
      workspaceId: req.params.workspaceId,
      artifactId: req.params.artifactId,
      principal: principal(req),
    });
    res.status(200).json({ versions });
  }));

  router.post('/workspaces/:workspaceId/artifacts/:artifactId/versions', handle((req, res) => {
    const result = service.createVersion({
      workspaceId: req.params.workspaceId,
      artifactId: req.params.artifactId,
      principal: principal(req),
      payload: req.body,
    });
    res.status(201).json(result);
  }));

  router.get('/workspaces/:workspaceId/artifacts/:artifactId/versions/:versionId/content', handle((req, res) => {
    const result = service.readVersion({
      workspaceId: req.params.workspaceId,
      artifactId: req.params.artifactId,
      versionId: req.params.versionId,
      principal: principal(req),
    });
    const filename = result.version.filename.replace(/["\\\r\n]/g, '_');
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', result.version.mimeType);
    res.set('Content-Length', String(result.bytes.length));
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(200).send(result.bytes);
  }));

  router.use((error, _req, res, next) => {
    if (!(error instanceof WorkspaceArtifactError)) return next(error);
    const status = STATUS_BY_CODE[error.code] || 500;
    return res.status(status).json({ error: error.code, message: error.message });
  });

  return router;
}

module.exports = { createWorkspaceArtifactRouter };
