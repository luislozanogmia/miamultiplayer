'use strict';
const { summarizeWork, workResults } = require('./browser-work-proposal');

const TRUST_CATEGORIES = ['browserWork', 'automations'];
function trustFor(settings, owner) {
  const saved = settings?.miaTrustByUser?.[owner] || {};
  return Object.fromEntries(TRUST_CATEGORIES.map(name => [name, saved[name] === true]));
}

// Every tool Mia can reach through `mia-app`. A route that is not listed here
// cannot be called, whatever Mia asks for.
function createMiaAppTools({ browserWork }) {
  const coordinator = () => {
    const found = browserWork();
    if (!found) throw Object.assign(new Error('Browser work is not available'), { status: 409 });
    return found;
  };
  return {
    browser_work_status: { group: 'A', async run({ owner, args }) {
      if (args.work_id) return summarizeWork(await coordinator().get(owner, String(args.work_id)));
      const works = await coordinator().list(owner);
      return { works: works.map(summarizeWork) };
    } },
    browser_work_results: { group: 'A', async run({ owner, args }) {
      return workResults(await coordinator().get(owner, String(args.work_id || '')));
    } },
  };
}

function registerMiaAppRoutes(app, { requireAuth, requireInteractiveAuth, loadSettings, saveSettings, tools }) {
  app.get('/api/mia-app/trust', requireAuth, (req, res) => res.json({ trust: trustFor(loadSettings(), String(req.userEmail).toLowerCase()) }));
  app.post('/api/mia-app/trust', requireInteractiveAuth, (req, res) => {
    const owner = String(req.userEmail).toLowerCase();
    const settings = loadSettings();
    const next = trustFor(settings, owner);
    for (const name of TRUST_CATEGORIES) if (typeof req.body?.[name] === 'boolean') next[name] = req.body[name];
    settings.miaTrustByUser = { ...(settings.miaTrustByUser || {}), [owner]: next };
    saveSettings(settings);
    res.json({ trust: next });
  });
  app.post('/api/mia-app/call', requireInteractiveAuth, async (req, res) => {
    const tool = Object.hasOwn(tools, req.body?.tool) ? tools[req.body.tool] : null;
    if (!tool) return res.status(403).json({ error: 'Mia cannot use that tool' });
    const args = req.body?.arguments && typeof req.body.arguments === 'object' && !Array.isArray(req.body.arguments) ? req.body.arguments : {};
    try { res.json({ result: await tool.run({ owner: String(req.userEmail).toLowerCase(), args, turn: req.body?.turn }) }); }
    catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'That Mia tool failed' }); }
  });
}
module.exports = { TRUST_CATEGORIES, trustFor, createMiaAppTools, registerMiaAppRoutes };
