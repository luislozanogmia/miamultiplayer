'use strict';

const { PrivateAgentError, assertShareable } = require('./private-agents');

// Routes live under /api/private-agents, apart from /api/agents (Mia's own
// record), so the default agent's responses cannot change.
function registerPrivateAgentRoutes(app, { store, requireAuth }) {
  const handle = (action) => (req, res) => {
    try {
      const body = action(String(req.userEmail || ''), req);
      return res.status(body.status || 200).json(body.json);
    } catch (error) {
      if (error instanceof PrivateAgentError) {
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      return res.status(500).json({ error: 'private_agent_failed' });
    }
  };
  app.get('/api/private-agents', requireAuth, handle((owner) => ({ json: { agents: store.list(owner) } })));
  app.post('/api/private-agents', requireAuth, handle((owner, req) => ({
    status: 201, json: { agent: store.create(owner, req.body) },
  })));
  app.get('/api/private-agents/:id', requireAuth, handle((owner, req) => ({
    json: { agent: store.get(owner, req.params.id) },
  })));
  app.patch('/api/private-agents/:id', requireAuth, handle((owner, req) => ({
    json: { agent: store.rename(owner, req.params.id, req.body) },
  })));
  app.delete('/api/private-agents/:id', requireAuth, handle((owner, req) => ({
    json: store.remove(owner, req.params.id, { confirm: (req.body || {}).confirm === true || req.query.confirm === 'true' }),
  })));
  // There is no way to share a personal agent. This route exists so a direct
  // call gets a clear refusal rather than a missing-route answer.
  app.all('/api/private-agents/:id/share', requireAuth, handle((owner, req) => {
    assertShareable({ id: req.params.id, kind: 'agent' });
    return { json: {} };
  }));
}

module.exports = { registerPrivateAgentRoutes };
