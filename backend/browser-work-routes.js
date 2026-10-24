'use strict';
const { serializeBrowserWork } = require('./browser-work-coordinator');
function response(res, body) {
  if (body.work) body.work = serializeBrowserWork(body.work);
  if (body.works) body.works = body.works.map(serializeBrowserWork);
  return res.json(body);
}
function registerBrowserWorkRoutes(app, { coordinator, ownerFromRequest, prefix = '/api/browser-work', onError = () => {} }) {
  if (typeof ownerFromRequest !== 'function') throw new Error('authenticated owner resolver required');
  function route(handler) {
    return async (req, res) => {
      try {
        const ownerId = await ownerFromRequest(req);
        if (!ownerId) return res.status(401).json({ error: 'Sign in required' });
        await handler(req, res, ownerId);
      } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Browser work request failed' }); }
    };
  }
  app.get(prefix, route(async (req, res, owner) => response(res, { works: await coordinator.list(owner, req.query.groupId) })));
  app.get(`${prefix}/:id`, route(async (req, res, owner) => response(res, { work: await coordinator.get(owner, req.params.id) })));
  app.post(prefix, route(async (req, res, owner) => response(res.status(201), { work: await coordinator.create(owner, req.body) })));
  app.post(`${prefix}/plan`, route(async (req, res, owner) => response(res.status(201), { work: await coordinator.plan(owner, req.body) })));
  app.post(`${prefix}/:id/start`, route(async (req, res, owner) => {
    const work = await coordinator.get(owner, req.params.id);
    if (work.status !== 'queued') return res.status(409).json({ error: 'Work requires explicit recovery or is already running' });
    // Durable queued record is acknowledged. Completion comes only from get/list.
    coordinator.start(owner, work.id).catch(onError);
    response(res.status(202), { work });
  }));
  app.post(`${prefix}/:id/stop`, route(async (req, res, owner) => response(res, { work: await coordinator.stop(owner, req.params.id, req.body?.workerId) })));
  app.post(`${prefix}/:id/approvals/:approvalId`, route(async (req, res, owner) => response(res, { work: await coordinator.decideApproval(owner, req.params.id, req.params.approvalId, req.body?.accept) })));
  app.post(`${prefix}/:id/recover`, route(async (req, res, owner) => response(res, { work: await coordinator.recover(owner, req.params.id, req.body?.workerIds) })));
  app.post(`${prefix}/group/:groupId/stop`, route(async (req, res, owner) => response(res, { works: await coordinator.stopGroup(owner, req.params.groupId) })));
  app.post(`${prefix}/:id/reusable/:reusableId/run`, route(async (req, res, owner) => res.json({ results: await coordinator.runReusable(owner, req.body?.sourceWorkId, req.params.reusableId, req.params.id, req.body?.workerId) })));
  app.post(`${prefix}/:id/reusable`, route(async (req, res, owner) => res.json({ reusable: await coordinator.exportReusable(owner, req.params.id, req.body?.workerId) })));
}
module.exports = { registerBrowserWorkRoutes };
