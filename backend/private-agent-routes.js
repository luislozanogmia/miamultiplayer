'use strict';

const { PrivateAgentError, assertShareable } = require('./private-agents');

// Routes live under /api/private-agents, apart from /api/agents (Mia's own
// record), so the default agent's responses cannot change.
function registerPrivateAgentRoutes(app, { store, requireAuth, lifecycle = null }) {
  const handle = (action) => (req, res) => {
    try {
      const body = action(String(req.userEmail || ''), req);
      return res.status(body.status || 200).json(body.json);
    } catch (error) {
      if (error instanceof PrivateAgentError) {
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      console.error('personal agent request failed', error && error.message);
      return res.status(500).json({ error: 'private_agent_failed' });
    }
  };
  app.get('/api/private-agents', requireAuth, handle((owner) => ({ json: { agents: store.list(owner) } })));
  app.post('/api/private-agents', requireAuth, handle((owner, req) => {
    const agent = store.create(owner, req.body);
    if (lifecycle) {
      try {
        lifecycle.ensureProfiles(agent.id);
      } catch (error) {
        store.remove(owner, agent.id, { confirm: true });
        throw error;
      }
    }
    return { status: 201, json: { agent } };
  }));
  app.get('/api/private-agents/:id', requireAuth, handle((owner, req) => ({
    json: { agent: store.get(owner, req.params.id) },
  })));
  app.patch('/api/private-agents/:id', requireAuth, handle((owner, req) => {
    const agent = store.rename(owner, req.params.id, req.body);
    if (lifecycle) lifecycle.renamed(owner, agent.id, req);
    return { json: { agent } };
  }));
  // Deleting also moves the agent's Hermes folders to the Trash and removes
  // its conversations; it needs an explicit confirm flag.
  app.delete('/api/private-agents/:id', requireAuth, handle((owner, req) => {
    const confirm = (req.body || {}).confirm === true || req.query.confirm === 'true';
    return {
      json: lifecycle
        ? lifecycle.remove(owner, req.params.id, req, { confirm })
        : store.remove(owner, req.params.id, { confirm }),
    };
  }));
  // The agent's chat: returns (creating if needed) its native conversation.
  app.post('/api/private-agents/:id/conversation', requireAuth, handle((owner, req) => {
    if (!lifecycle) throw new PrivateAgentError(501, 'not_available');
    lifecycle.ensureProfiles(store.get(owner, req.params.id).id);
    return { json: { conversation: lifecycle.openConversation(owner, req.params.id, req) } };
  }));
  // There is no way to share a personal agent. This route exists so a direct
  // call gets a clear refusal rather than a missing-route answer.
  app.all('/api/private-agents/:id/share', requireAuth, handle((owner, req) => {
    assertShareable({ id: req.params.id, kind: 'agent' });
    return { json: {} };
  }));
}

module.exports = { registerPrivateAgentRoutes };
