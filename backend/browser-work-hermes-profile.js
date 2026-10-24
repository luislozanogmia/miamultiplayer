'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Called only for browser jobs, leaving ordinary personal Mia/bot profiles intact.
// No credentials are written. Broker credentials arrive via Hermes runtime env.
function provisionBrowserWorkProfile({ profilesRoot, worker, binding }) {
  const suffix = crypto.createHash('sha256').update(`${binding.ownerId}:${worker.botId}`).digest('hex').slice(0, 24);
  const profile = `mia-browser-work-${suffix}`;
  const home = path.join(profilesRoot, profile);
  const plugin = path.join(home, 'plugins', 'mia-browser-work');
  fs.mkdirSync(plugin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(plugin, '__init__.py'), fs.readFileSync(path.join(__dirname, 'browser-work-hermes-plugin.py')), { mode: 0o600 });
  fs.writeFileSync(path.join(plugin, 'plugin.yaml'), 'name: mia-browser-work\nversion: "0.1.0"\ndescription: "Bounded Mia browser workers"\nlicense: MIT\nhooks:\n  - pre_tool_call\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'config.yaml'), [
    '# Managed by Mia browser work. No credentials.',
    'platform_toolsets:', '  cli:', '    - mia_browser_work',
    // Keep the sole bound tool eager: the pinned scheduler admits its exact
    // native name, while deferred tool_call wrappers remain sequential.
    'tools:', '  tool_search:', '    enabled: off',
    'agent:', '  coding_context: off', '  max_turns: 40',
    'plugins:', '  enabled:', '    - mia-browser-work',
    'mcp_servers: {}', ...require('./hermes-runtime-secret-source').runtimeSecretSourceLines(),
    'auxiliary:', '  background_review:', '    enabled: false',
    '',
  ].join('\n'), { mode: 0o600 });
  return { profile, restricted: true };
}
module.exports = { provisionBrowserWorkProfile };
