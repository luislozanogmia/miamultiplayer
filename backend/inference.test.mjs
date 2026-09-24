import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import inference from './inference.js';
import hermesGatewayClientModule from './hermes-gateway-client.js';

const { HermesGatewayClient } = hermesGatewayClientModule;

test('Hermes subprocess environment is a strict allowlist', () => {
  const original = { ...process.env };
  const allowed = {
    PATH: '/safe/bin',
    HOME: '/safe/home',
    DEEPSEEK_API_KEY: 'deepseek-provider-key',
    DEEPSEEK_BASE_URL: 'https://provider.example/v1',
    XAI_API_KEY: 'xai-provider-key',
    XAI_BASE_URL: 'https://xai.example/v1',
    HERMES_HOME: '/safe/hermes',
    GH_CONFIG_DIR: '/safe/miaos/isolated-github',
    MIAOS_WORKSPACE_DIR: '/safe/miaos/workspace',
    MIAOS_HERMES_GUARD_BIN: '/safe/miaos/guard-from-parent',
    HERMES_STATE_DB: '/safe/hermes/state.db',
    HERMES_CRON_JOBS_FILE: '/safe/hermes/cron/jobs.json',
    HERMES_CRON_EXECUTIONS_DB: '/safe/hermes/cron/executions.db',
    MIAOS_AUTOMATION_ARTIFACT_DIR: '/safe/miaos/artifacts',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: '/safe/miaos/python-cache',
    CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: '/safe/bin/claude',
    CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR: '/safe/claude-config',
    MIAOS_FIRECRAWL_GATEWAY_URL: 'https://search.example.com',
    MIAOS_FIRECRAWL_GATEWAY_TOKEN: 'miaos-installation-token-with-entropy',
  };
  const denied = {
    AWS_ACCESS_KEY_ID: 'aws-key',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_SESSION_TOKEN: 'aws-session',
    AWS_CONFIG_FILE: '/private/aws/config',
    MIAOS_SESSION_SECRET: 'session-secret',
    MIAOS_ENCRYPTION_KEY: 'encryption-secret',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: 'google-encryption-secret',
    MIAOS_ENV_FILE: '/private/backend/.env',
    UNRELATED_INHERITED_SECRET: 'must-not-inherit',
    ANTHROPIC_API_KEY: 'must-not-fall-back-to-paid-api',
    ANTHROPIC_BASE_URL: 'https://must-not-route.example',
    CLAUDE_CONFIG_DIR: '/ambient/claude-config',
  };

  try {
    for (const [key, value] of Object.entries({ ...allowed, ...denied })) process.env[key] = value;
    process.env.MIAOS_HERMES_PROCESS_HOME = '/safe/miaos/runtime-home';
    const childEnv = inference.hermesProcessEnv();
    for (const [key, value] of Object.entries(allowed)) {
      const expected = key === 'PATH' ? `${inference.MIAOS_HERMES_GUARD_BIN}:${value}`
        : key === 'HOME' ? '/safe/miaos/runtime-home'
        : key === 'MIAOS_HERMES_GUARD_BIN' ? inference.MIAOS_HERMES_GUARD_BIN
        : ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'XAI_API_KEY', 'XAI_BASE_URL',
          'MIAOS_FIRECRAWL_GATEWAY_URL', 'MIAOS_FIRECRAWL_GATEWAY_TOKEN'].includes(key) ? undefined
        : value;
      assert.equal(childEnv[key], expected, key);
    }
    assert.equal(childEnv.FIRECRAWL_API_URL, undefined);
    assert.equal(childEnv.FIRECRAWL_API_KEY, undefined);
    for (const key of Object.keys(denied)) assert.equal(childEnv[key], undefined, key);
    assert.equal(childEnv.MIAOS_EXTERNAL_CHAT, '1');
    assert.ok(Object.keys(childEnv).every((key) => [
      'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
      'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'NO_COLOR', 'CI',
      'PYTHONDONTWRITEBYTECODE',
      'PYTHONPYCACHEPREFIX',
      'CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND', 'CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR',
      'GH_CONFIG_DIR',
      'MIAOS_WORKSPACE_DIR', 'MIAOS_HERMES_GUARD_BIN',
      'HERMES_HOME', 'HERMES_STATE_DB', 'HERMES_CRON_JOBS_FILE',
      'HERMES_CRON_EXECUTIONS_DB', 'MIAOS_AUTOMATION_ARTIFACT_DIR',
      'MIAOS_EXTERNAL_CHAT',
    ].includes(key)), 'unexpected environment key leaked');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(original)) process.env[key] = value;
  }
});

test('Hermes process environment never receives hosted-search credentials', () => {
  const originalUrl = process.env.MIAOS_FIRECRAWL_GATEWAY_URL;
  const originalToken = process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN;
  try {
    process.env.MIAOS_FIRECRAWL_GATEWAY_URL = 'https://search.example.com';
    delete process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN;
    assert.equal(inference.hermesProcessEnv().FIRECRAWL_API_URL, undefined);
    assert.equal(inference.hermesProcessEnv().FIRECRAWL_API_KEY, undefined);

    process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN = 'valid-installation-token-with-32-chars';
    process.env.MIAOS_FIRECRAWL_GATEWAY_URL = 'http://search.example.com';
    assert.equal(inference.hermesProcessEnv().FIRECRAWL_API_URL, undefined);
    assert.equal(inference.hermesProcessEnv().FIRECRAWL_API_KEY, undefined);
  } finally {
    if (originalUrl === undefined) delete process.env.MIAOS_FIRECRAWL_GATEWAY_URL;
    else process.env.MIAOS_FIRECRAWL_GATEWAY_URL = originalUrl;
    if (originalToken === undefined) delete process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN;
    else process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN = originalToken;
  }
});

test('provider API-key setup uses the documented --api-key flag with discarded stdio', () => {
  // The key travels on Hermes' public CLI contract (--api-key). Feeding the
  // hidden prompt over a stdin pipe hung on Windows, where Python getpass
  // reads the console rather than stdin. All stdio is discarded so the key
  // can never echo back through Mia's logs or API responses.
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function runHermesApiKeyAdd');
  const end = source.indexOf('\nfunction runHermesAuthStatus', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(implementation, /'--api-key', apiKey/);
  assert.match(implementation, /stdio:\s*\['ignore', 'ignore', 'ignore'\]/);
  assert.match(implementation, /env:\s*hermesCredentialProcessEnv\(\)/);
  assert.doesNotMatch(implementation, /child\.stdin/);
});

test('Hermes credential checks cannot borrow the ambient GitHub CLI login', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function hermesCredentialProcessEnv');
  const end = source.indexOf('\nfunction startHermesAuth', start);
  const implementation = source.slice(start, end);
  const guard = fs.readFileSync(new URL('./miaos-hermes-bin/gh', import.meta.url), 'utf8');
  assert.match(implementation, /MIAOS_HERMES_GUARD_BIN/);
  assert.match(implementation, /env\.PATH\s*=/);
  assert.match(guard, /ambient GitHub CLI credentials are unavailable/);
  assert.match(guard, /exit 1/);
});

test('provider status checks use bounded subprocess concurrency', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function hermesConnectionStatuses');
  const end = source.indexOf('\nfunction rememberNativeChatModelInventory', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(source, /const HERMES_STATUS_CONCURRENCY = 4/);
  assert.match(implementation, /boundedMap\(providers, HERMES_STATUS_CONCURRENCY/);
  assert.doesNotMatch(implementation, /Promise\.all\(providers\.map/);
});

test('subscription model selections stay inside the provider allowlist', () => {
  assert.deepEqual(inference.normalizeHermesModelSelection('claude-subscription-directsdk-experimental', 'sonnet', false), {
    model: 'claude-sonnet-5[1m]',
    fast: false,
  });
  assert.equal(inference.isAllowedHermesModel('claude-subscription-directsdk-experimental', 'claude-opus-5[1m]', false), true);
  assert.equal(inference.isAllowedHermesModel('claude-subscription-directsdk-experimental', 'claude-opus-5', false), false);
  assert.deepEqual(inference.normalizeHermesModelSelection('openai-codex', null, false), {
    model: 'gpt-5.6-luna',
    fast: false,
  });
  assert.deepEqual(inference.normalizeHermesModelSelection('xai-oauth', null, false), {
    model: 'grok-4.6',
    fast: false,
  });
  assert.deepEqual(inference.normalizeHermesModelSelection('openai-codex', 'fast', true), {
    model: 'gpt-5.6-luna',
    fast: true,
  });
  assert.deepEqual(inference.normalizeHermesModelSelection('openai-codex', 'gpt-6-astra', false), {
    model: 'gpt-6-astra',
    fast: false,
  });
  assert.deepEqual(inference.normalizeHermesModelSelection('xai-oauth', 'grok-4.6', false), {
    model: 'grok-4.6',
    fast: false,
  });
  assert.equal(inference.isAllowedHermesModel('openai-codex', 'gpt-6-astra', false), true);
  assert.equal(inference.isAllowedHermesModel('openai-codex', 'gpt-6-astra', true), false);
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    assert.deepEqual(inference.normalizeHermesModelSelection('openai-codex', model, false), { model, fast: false });
    assert.equal(inference.isAllowedHermesModel('openai-codex', model, false), true);
  }
  assert.equal(inference.isAllowedHermesModel('xai-oauth', 'deepseek-v4-flash', false), false);
  assert.equal(inference.MIAOS_BOT_MAX_TURNS, 100);
  assert.equal(inference.hermesTurnsFromOptions({ maxTurns: 200 }), 200);
  assert.equal(inference.hermesTurnsFromOptions({ maxTurns: 201 }), 200);
  assert.equal(inference.hermesTurnsFromOptions({ maxTurns: 200, botWorker: true }), inference.MIAOS_BOT_MAX_TURNS);
});

test('the output token budget defaults safely, clamps a request, and converts to a char budget', () => {
  assert.equal(inference.MIAOS_BOT_MAX_TOKENS, 200000);
  // No request (or an invalid one) falls back to the deployment ceiling —
  // every caller gets a budget by default, unlike the turn cap above.
  assert.equal(inference.hermesTokenBudgetFromOptions(), inference.MIAOS_BOT_MAX_TOKENS);
  assert.equal(inference.hermesTokenBudgetFromOptions({}), inference.MIAOS_BOT_MAX_TOKENS);
  assert.equal(inference.hermesTokenBudgetFromOptions({ maxTokens: 0 }), inference.MIAOS_BOT_MAX_TOKENS);
  assert.equal(inference.hermesTokenBudgetFromOptions({ maxTokens: 5000 }), 5000);
  assert.equal(
    inference.hermesTokenBudgetFromOptions({ maxTokens: inference.MIAOS_BOT_MAX_TOKENS + 1 }),
    inference.MIAOS_BOT_MAX_TOKENS
  );
  assert.equal(
    inference.hermesCharBudgetFromTokens(5000),
    5000 * inference.NATIVE_DISPATCH_CHARS_PER_TOKEN
  );
  assert.equal(
    inference.hermesCharBudgetFromTokens(),
    inference.MIAOS_BOT_MAX_TOKENS * inference.NATIVE_DISPATCH_CHARS_PER_TOKEN
  );
});

test('localhost diagnostics control Hermes verbosity without exposing secrets', () => {
  const before = inference.getHermesDiagnostics();
  const enabled = inference.setHermesDiagnostics({ verboseHermes: true, traceCommands: true });
  assert.equal(enabled.localOnly, true);
  assert.equal(enabled.verboseHermes, true);
  assert.equal(enabled.traceCommands, true);
  inference.setHermesDiagnostics({ verboseHermes: false, traceCommands: false });
  const after = inference.getHermesDiagnostics();
  assert.equal(after.verboseHermes, false);
  assert.equal(after.traceCommands, false);
  assert.deepEqual(after.events, []);
  assert.equal(before.localOnly, true);
});

test('all standalone Mia inference uses the agent profile in the singleton Hermes service', async () => {
  const requests = [];
  const gatewayClient = {
    async run(request) {
      requests.push(request);
      return { text: 'agent result', storedSessionId: 'stored-agent' };
    },
  };

  const result = await inference.runInference('perform the full task', {
    agentic: true,
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    gatewayClient,
  });

  assert.equal(result, 'agent result');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.profile, inference.MIAOS_AGENT_HERMES_PROFILE);
  assert.equal(requests[0].options.gatewayClient, undefined);
  assert.equal(requests[0].message, 'perform the full task');
});

test('standalone image turns stay in the singleton service and use the vision route', async () => {
  const requests = [];
  const gatewayClient = {
    async run(request) {
      requests.push(request);
      return { text: 'image result', storedSessionId: 'stored-image' };
    },
  };

  assert.equal(await inference.runInference('inspect this', {
    imagePaths: ['/tmp/example.png'],
    gatewayClient,
  }), 'image result');
  assert.deepEqual(requests[0].imagePaths, ['/tmp/example.png']);
  assert.equal(requests[0].options.profile, inference.MIAOS_AGENT_HERMES_PROFILE);
  assert.equal(requests[0].options.provider, inference.VISION_PROVIDER);
  assert.equal(requests[0].options.model, inference.VISION_MODEL);
});

test('inference owner has no per-turn Hermes CLI launch path', () => {
  const source = fs.readFileSync(new URL('./inference.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bexecFile\s*\(/);
  assert.doesNotMatch(source, /runInferenceViaHermesCli|runHermesTask|buildHermesCliArgs/);
});

test('native gateway inference forwards the per-turn event stream', async () => {
  const seen = [];
  const onEvent = (type, payload) => seen.push({ type, payload });
  const client = {
    async run(request) {
      assert.equal(request.onEvent, onEvent);
      assert.equal(request.options.profile, 'miaos-agent-runtime');
      request.onEvent('tool.complete', {
        name: 'terminal',
        args: { command: 'printf gateway-stream' },
        result_text: 'gateway-stream',
      });
      return { text: 'done', storedSessionId: 'stored-native' };
    },
  };

  const result = await inference.runInferenceViaHermesGateway({
    storedSessionId: 'stored-native',
    seedMessages: [],
    title: 'Mia',
    message: 'run it',
    options: { provider: 'openai-codex' },
    onEvent,
  }, client);

  assert.deepEqual(result, { text: 'done', storedSessionId: 'stored-native' });
  assert.deepEqual(seen, [{
    type: 'tool.complete',
    payload: {
      name: 'terminal',
      args: { command: 'printf gateway-stream' },
      result_text: 'gateway-stream',
    },
  }]);
});

test('Mia tasks load the app-owned native browser policy', () => {
  const skill = inference.loadMiaGhostSkill();
  assert.match(skill, /Mia browser policy/i);
  assert.match(skill, /ghost_instance_create/);
  assert.match(skill, /"miaos":true/);
  assert.match(skill, /browser module is bundled and app-owned/);
  assert.match(skill, /availability is live state/i);
  assert.match(skill, /on every request[\s\S]*run ghost_instance_create/i);
  assert.match(skill, /macOS.*open.*forbidden/i);
  assert.match(skill, /ghost_file_open/);
  assert.doesNotMatch(skill, /live-status|live-connect|chrome-devtools-mcp/i);
  assert.match(inference.MIAOS_BROWSER_TURN_POLICY, /macOS open command/i);
  assert.match(inference.hermesProcessEnv().PATH, /miaos-hermes-bin/);
  assert.ok(!inference.MIAOS_HERMES_TOOLSETS.includes('browser'));
  assert.ok(!inference.MIAOS_HERMES_TOOLSETS.includes('skills'));
  assert.ok(inference.MIAOS_HERMES_TOOLSETS.includes('terminal'));
});

test('Mia tasks load the guarded app-owned bot creation skill', () => {
  const skill = inference.loadMiaBotCreationSkill();
  assert.match(skill, /miaos-bot create --confirmed/);
  assert.match(skill, /explicitly confirms/i);
  assert.match(skill, /do not inspect the source tree/i);
  const policy = inference.appOwnedToolPolicy({ botWorker: false });
  assert.match(policy, /# Mia bot creation/);
  assert.match(policy, /# Mia browser/);
});

test('full-mode bot workers get a compact local-browser boundary without the full Mia harness', () => {
  const policy = inference.appOwnedToolPolicy({ botWorker: true });
  assert.doesNotMatch(policy, /web_search|web_extract/);
  assert.match(policy, /browser\s+embedded in Mia/);
  assert.match(policy, /ghost-cli/);
  assert.match(policy, /Do not inspect Mia's source code, databases, logs/);
  assert.doesNotMatch(policy, /miaos-bot create/);
  assert.doesNotMatch(policy, /# Mia browser/);
});

test('bot context keeps durable instructions while Hermes owns structured conversation context', () => {
  const prompt = inference.buildBotContext({
    name: 'News briefing',
    instructions: 'Research reliable current news and produce concise briefings with source links.',
    automations: [
      {name:'My news briefing', enabled:true, frequency:'daily', time:'09:00', prompt:'Create today’s concise news briefing about architecture in Mexico.'},
      {name:'Weekly digest', enabled:false, frequency:'weekly', day:'Friday', time:'16:00', prompt:'Summarize the week.'},
    ],
  }, Array.from({length:20}, (_, index) => `turn ${index + 1}`), 'run it now', 'Google connection: available.', 'Luis');

  assert.match(prompt, /You are News briefing, a specialized task bot inside Mia\./);
  assert.match(prompt, /What you are:\nYou are a focused worker/);
  assert.match(prompt, /Who Mia is:\nMia is the user’s primary private AI assistant/);
  assert.match(prompt, /Who the user is:\nYou are working for Luis, the authorized user interacting with this bot/);
  assert.match(prompt, /never infer a name from an email address/);
  assert.match(prompt, /Capabilities: answer in chat/);
  assert.match(prompt, /Keep responses, reasoning, and tool use concise and tight/);
  assert.match(prompt, /“run it now”/);
  assert.match(prompt, /My news briefing \(daily at 09:00\)/);
  assert.match(prompt, /Task: Create today’s concise news briefing about architecture in Mexico\./);
  assert.match(prompt, /Weekly digest \(paused\)/);
  assert.match(prompt, /Current Mia context \(authoritative\):\nGoogle connection: available\./);
  assert.doesNotMatch(prompt, /turn 1\n/);
  assert.doesNotMatch(prompt, /turn 20\n/);
  assert.doesNotMatch(prompt, /Luis: run it now/);
  assert.match(prompt, /latest explicit user instruction overrides older scope/);
  assert.match(prompt, /says “full stop,” or says not to overengineer/);
  assert.match(prompt, /Once the requested result is sufficient, stop/);
});

test('scheduled bot prompt states bot, Mia, owner, scope, and exact automation task', () => {
  const prompt = inference.buildScheduledBotPrompt({
    name: 'News briefing',
    instructions: 'Research reliable current news and produce concise briefings with source links.',
  }, {
    name: 'My news briefing',
    enabled: true,
    frequency: 'daily',
    time: '09:00',
    prompt: 'Create today’s concise news briefing about architecture in Mexico.',
  });

  assert.match(prompt, /^You are News briefing, a specialized task bot inside Mia\./);
  assert.match(prompt, /You are not Mia, a general assistant, or an administrator/);
  assert.match(prompt, /Mia is the user’s primary private AI assistant and the coordinator/);
  assert.match(prompt, /working for the authorized owner of this bot/);
  assert.match(prompt, /never infer a name from an email address/);
  assert.match(prompt, /Keep responses, reasoning, and tool use concise and tight/);
  assert.match(prompt, /Automation:\nName: My news briefing\nSchedule: daily at 09:00/);
  assert.match(prompt, /Task:\nCreate today’s concise news briefing about architecture in Mexico\.$/);
});

test('bot replies use a restricted session in the existing Hermes runtime', async () => {
  const requests = [];
  const gatewayClient = {
    async run(request) {
      requests.push(request);
      return {
        text: 'bot result',
        storedSessionId: 'stored-bot',
        artifacts: [{ filename: 'result.pdf', mimeType: 'application/pdf' }],
      };
    },
  };

  const result = await inference.runInference('perform the bounded task', {
    botWorker: true,
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    signal: new AbortController().signal,
    seedMessages: [
      { role: 'system', content: 'bounded bot instructions' },
      { role: 'user', content: 'earlier request' },
      { role: 'assistant', content: 'earlier result' },
    ],
    gatewayClient,
  });

  assert.deepEqual(result, {
    text: 'bot result',
    artifacts: [{ filename: 'result.pdf', mimeType: 'application/pdf' }],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message, 'perform the bounded task');
  assert.equal(requests[0].options.profile, inference.MIAOS_BOT_HERMES_PROFILE);
  assert.equal(requests[0].options.botWorker, true);
  assert.deepEqual(requests[0].seedMessages, [
    { role: 'system', content: 'bounded bot instructions' },
    { role: 'user', content: 'earlier request' },
    { role: 'assistant', content: 'earlier result' },
  ]);
  assert.equal(requests[0].options.seedMessages, undefined);
});

test('Google bot turns use the no-terminal Google profile', async () => {
  const requests = [];
  const gatewayClient = { async run(request) { requests.push(request); return { text: 'google result' }; } };
  await inference.runInference('list my inbox', {
    botWorker: true,
    profile: inference.MIAOS_BOT_GOOGLE_HERMES_PROFILE,
    provider: 'openai-codex', model: 'gpt-5.6-luna', gatewayClient,
  });
  assert.equal(requests[0].options.profile, inference.MIAOS_BOT_GOOGLE_HERMES_PROFILE);
});

test('backend shutdown closes and releases its singleton Hermes gateway client', async () => {
  const originalModelOptions = HermesGatewayClient.prototype.modelOptions;
  const originalClose = HermesGatewayClient.prototype.close;
  let closeCalls = 0;
  HermesGatewayClient.prototype.modelOptions = async (options) => {
    assert.equal(options.profile, 'miaos-agent-runtime');
    return [];
  };
  HermesGatewayClient.prototype.close = function closeForTest() { closeCalls += 1; };

  try {
    assert.deepEqual(await inference.getHermesGatewayModelOptions(), []);
    assert.equal(inference.closeHermesGatewayRuntime(), true);
    assert.equal(closeCalls, 1);
    assert.equal(inference.closeHermesGatewayRuntime(), false);
    assert.equal(closeCalls, 1);
  } finally {
    HermesGatewayClient.prototype.modelOptions = originalModelOptions;
    HermesGatewayClient.prototype.close = originalClose;
  }
});
