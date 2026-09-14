'use strict';

// Small Node client for Hermes' headless JSON-RPC/WebSocket gateway.
//
// The native Mia dispatcher owns the durable conversation and stores the
// Hermes `stored_session_id` alongside it. This module owns only the live
// gateway connection and the short-lived in-memory session id returned by
// session.create/session.resume. Keeping those responsibilities separate lets
// a backend restart resume the same Hermes session without making Hermes the
// source of truth for native conversation membership or delivery.

const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 9121;
const CONNECT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 600000;
const MODEL_OPTIONS_TIMEOUT_MS = 30000;
const MODEL_OPTIONS_ATTEMPTS = 10;
const RETRY_DELAY_MS = 250;
const PORT_PROBE_TIMEOUT_MS = 300;

function numericPort(value, fallback = DEFAULT_PORT) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function withToken(url, token) {
  const parsed = new URL(url);
  if (token && !parsed.searchParams.has('token')) parsed.searchParams.set('token', token);
  return parsed.toString();
}

function loopbackGatewayUrl(value) {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Hermes gateway URL must use a loopback host');
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('Hermes gateway URL must use ws or wss');
  }
  if (parsed.username || parsed.password || parsed.searchParams.has('token')) {
    throw new Error('Hermes gateway URL must not embed credentials');
  }
  return parsed.toString();
}

function probePort(port, timeoutMs = PORT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    let timer;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(listening);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

function readTokenFile(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || '';
  } catch (_) {
    return '';
  }
}

function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on Windows */ }
}

function responseError(frame, method) {
  if (!frame || !frame.error) return null;
  const error = new Error(`${method}: ${frame.error.message || 'Hermes gateway request failed'}`);
  error.code = frame.error.code;
  error.gatewayError = frame.error;
  return error;
}

function resultOf(frame, method) {
  const error = responseError(frame, method);
  if (error) throw error;
  if (!frame || !Object.prototype.hasOwnProperty.call(frame, 'result')) {
    throw new Error(`${method}: malformed Hermes gateway response`);
  }
  return frame.result;
}

function turnAbortError() {
  const error = new Error('Hermes gateway turn stopped by user');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function stopExternalHermesGateway(binary, env) {
  return new Promise((resolve, reject) => {
    execFile(binary, ['gateway', 'stop'], {
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(true);
      const detail = String(stderr || stdout || error.message || '').trim();
      if (/not running|not installed|already stopped|service stopped/i.test(detail)) return resolve(false);
      reject(new Error(`could not stop the duplicate Hermes gateway: ${detail.slice(0, 500)}`));
    });
  });
}

class HermesGatewayClient {
  constructor({
    binary,
    env,
    toolsets,
    maxTurns,
    url = process.env.MIAOS_HERMES_GATEWAY_URL || '',
    token = process.env.MIAOS_HERMES_GATEWAY_TOKEN || '',
    port = process.env.MIAOS_HERMES_GATEWAY_PORT,
    WebSocketImpl = globalThis.WebSocket,
    spawnImpl = spawn,
    probePortImpl = probePort,
    fetchImpl = globalThis.fetch,
    tokenFile = process.env.MIAOS_HERMES_GATEWAY_TOKEN_FILE || '',
    now = () => Date.now(),
    onEvent = null,
    stopExternalGatewayImpl = stopExternalHermesGateway,
  } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is not available in this Node runtime');
    this.binary = String(binary || '').trim();
    this.env = { ...(env || process.env) };
    this.toolsets = Array.isArray(toolsets) ? toolsets.filter(Boolean) : [];
    this.maxTurns = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : 150;
    const requestedUrl = String(url || '').trim();
    this.configuredUrl = requestedUrl ? loopbackGatewayUrl(requestedUrl) : '';
    this.configuredToken = String(token || '').trim();
    this.port = numericPort(port);
    this.WebSocketImpl = WebSocketImpl;
    this.spawnImpl = spawnImpl;
    this.probePortImpl = probePortImpl;
    this.fetchImpl = fetchImpl;
    this.tokenFile = tokenFile ? String(tokenFile) : '';
    this.now = now;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.stopExternalGatewayImpl = stopExternalGatewayImpl;
    this.toolProgressMode = String(this.env.HERMES_TUI_TOOL_PROGRESS || '').trim().toLowerCase() === 'verbose'
      ? 'verbose'
      : 'all';
    this.socket = null;
    this.readyPromise = null;
    this.gatewayReadyPromise = null;
    this.gatewayToken = this.configuredToken || (this.tokenFile ? readTokenFile(this.tokenFile) : '');
    this.nextRequestId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.sessions = new Set();
    this.sessionInfo = new Map();
    this.sessionReadyWaiters = new Map();
    // storedSessionId -> serialized picker selection last applied to that
    // session. Pins persist in the stored Hermes row, so a matching cache
    // entry means the per-turn config.set re-pin can be skipped — which also
    // avoids the pinned gateway's lazy-resume bug where `config.set fast`
    // validates against the profile default model instead of the session's
    // pinned one and rejects a model that does support fast mode.
    this.appliedSelections = new Map();
    this.child = null;
    this.shutdownRequested = false;
  }

  endpoint() {
    if (this.configuredUrl) return withToken(this.configuredUrl, this.configuredToken);
    const token = this.gatewayToken ? `?token=${encodeURIComponent(this.gatewayToken)}` : '';
    return `ws://127.0.0.1:${this.port}/api/ws${token}`;
  }

  async ensureGateway() {
    if (this.shutdownRequested) throw new Error('Hermes gateway client closed');
    if (this.configuredUrl) return;
    if (this.gatewayReadyPromise) return this.gatewayReadyPromise;
    this.gatewayReadyPromise = (async () => {
      const alreadyListening = await this.probePortImpl(this.port, PORT_PROBE_TIMEOUT_MS);
      if (this.shutdownRequested) throw new Error('Hermes gateway client closed');
      if (alreadyListening) {
        if (!this.gatewayToken) {
          throw new Error(
            `Hermes gateway is already listening on 127.0.0.1:${this.port}; ` +
            'set MIAOS_HERMES_GATEWAY_TOKEN to connect to it'
          );
        }
        return;
      }

      if (!this.gatewayToken) {
        this.gatewayToken = crypto.randomBytes(32).toString('hex');
        if (!this.tokenFile) {
          throw new Error('MIAOS_HERMES_GATEWAY_TOKEN_FILE is required to start a local Hermes gateway.');
        }
        writeTokenFile(this.tokenFile, this.gatewayToken);
      }

      if (!this.binary) throw new Error('HERMES_BIN is required to start a local Hermes gateway.');

      if (typeof this.stopExternalGatewayImpl === 'function') {
        await this.stopExternalGatewayImpl(this.binary, this.env);
      }

      const gatewayEnv = { ...this.env };
      gatewayEnv.HERMES_DASHBOARD_SESSION_TOKEN = this.gatewayToken;
      // Toolsets are resolved by the profile attached to each session. Mia uses
      // the launch profile; bounded bots use Mia' restricted bot profile.
      // A process-global HERMES_TUI_TOOLSETS value would flatten those two
      // security postures and is therefore intentionally not set here.
      gatewayEnv.HERMES_TUI_MAX_TURNS = String(this.maxTurns);
      gatewayEnv.MIAOS_EXTERNAL_CHAT = '1';
      // The desktop server owns both native chat sessions and cron ticks.
      // Running the scheduler inside this process prevents a second launchd
      // Hermes gateway from drifting onto different credentials/configuration.
      gatewayEnv.HERMES_DESKTOP = '1';
      const child = this.spawnImpl(
        this.binary,
        ['serve', '--host', '127.0.0.1', '--port', String(this.port), '--skip-build'],
        {
          env: gatewayEnv,
          // Never inherit the backend's cwd: on macOS that is inside the
          // installed .app bundle, which reinstalls rm -rf and re-copy. A
          // gateway that outlives a reinstall then sits on a deleted inode and
          // every os.getcwd() inside Hermes raises ENOENT (seen as
          // "config.set: [Errno 2] No such file or directory" on lazy-resume
          // model switches). HERMES_HOME survives reinstalls.
          cwd: gatewayEnv.HERMES_HOME || os.homedir(),
          detached: false,
          stdio: 'ignore',
        }
      );

      // Mia owns only the local runtime it starts. Keep the child attached
      // so backend shutdown can terminate it; an already-listening external
      // runtime never reaches this branch and is therefore never adopted.
      this.child = child || null;
      if (child && typeof child.once === 'function') {
        const release = () => {
          if (this.child === child) this.child = null;
        };
        child.once('error', release);
        child.once('exit', release);
      }
    })();
    try {
      await this.gatewayReadyPromise;
    } finally {
      this.gatewayReadyPromise = null;
    }
  }

  failConnection(error) {
    const socket = this.socket;
    this.socket = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.sessionReadyWaiters.values()) waiter.reject(error);
    this.sessionReadyWaiters.clear();
    this.sessionInfo.clear();
    if (socket) {
      try { socket.close(); } catch (_) { /* already closed */ }
    }
  }

  attachSocket(socket, resolve, reject) {
    this.socket = socket;
    let opened = false;
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) {
        const error = new Error('Hermes gateway connection timed out');
        this.failConnection(error);
        reject(error);
      }
    }, CONNECT_TIMEOUT_MS);

    const complete = () => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      resolve();
    };

    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data || '');
      for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        let frame;
        try { frame = JSON.parse(line); } catch (_) { continue; }
        if (frame.id !== undefined && frame.id !== null) {
          const pending = this.pending.get(String(frame.id));
          if (pending) {
            this.pending.delete(String(frame.id));
            pending.resolve(frame);
          }
          continue;
        }
        const params = frame && frame.params;
        if (frame.method !== 'event' || !params || typeof params !== 'object') continue;
        if (params.type === 'gateway.ready') complete();
        if (this.onEvent) {
          try { this.onEvent(params.type, params.payload || {}); } catch (_) { /* diagnostics must not break chat */ }
        }
        const sessionId = String(params.session_id || '');
        if (sessionId && params.type === 'session.info' && params.payload?.model && !params.payload.lazy) {
          this.sessionInfo.set(sessionId, params.payload);
          this.sessionReadyWaiters.get(sessionId)?.resolve(params.payload);
        }
        if (sessionId && params.type === 'error') {
          this.sessionReadyWaiters.get(sessionId)?.reject(new Error(params.payload?.message || 'Hermes agent initialization failed'));
        }
        const turn = sessionId ? this.turns.get(sessionId) : null;
        if (turn && turn.onEvent) {
          try { turn.onEvent(params.type, params.payload || {}); } catch (_) { /* chat diagnostics must not break the turn */ }
        }
        if (turn) this.handleTurnEvent(turn, params.type, params.payload || {});
      }
    };
    socket.onerror = (event) => {
      const error = event instanceof Error ? event : new Error('Hermes gateway WebSocket error');
      if (!opened || !ready) {
        clearTimeout(timer);
        this.failConnection(error);
        reject(error);
      } else {
        this.failConnection(error);
      }
    };
    socket.onclose = () => {
      if (!ready) {
        clearTimeout(timer);
        const error = new Error('Hermes gateway WebSocket closed before ready');
        this.failConnection(error);
        reject(error);
      } else {
        this.failConnection(new Error('Hermes gateway WebSocket closed'));
      }
    };
  }

  async connect() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      await this.ensureGateway();
      const deadline = this.now() + CONNECT_TIMEOUT_MS;
      let lastError = null;
      while (!this.shutdownRequested && this.now() < deadline) {
        try {
          await new Promise((resolve, reject) => {
            let socket;
            try { socket = new this.WebSocketImpl(this.endpoint()); } catch (error) { reject(error); return; }
            this.attachSocket(socket, resolve, reject);
          });
          return;
        } catch (error) {
          lastError = error;
          if (this.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
      throw lastError || new Error('Hermes gateway unavailable');
    })().catch((error) => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  async request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) throw new Error('Hermes gateway is not connected');
    const id = String(this.nextRequestId++);
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          try { resolve(resultOf(response, method)); } catch (error) { reject(error); }
        },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        socket.send(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  handleTurnEvent(turn, type, payload) {
    if (type === 'message.delta') {
      turn.text += String(payload.text || '');
      return;
    }
    if (type === 'message.complete') {
      const text = String(payload.text || turn.text || '').trim();
      const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
      if (payload.status === 'error') {
        turn.reject(new Error(text || payload.error || 'Hermes gateway turn failed'));
      } else if (!text && artifacts.length === 0) {
        turn.reject(new Error('Hermes gateway returned no reply text'));
      } else {
        turn.resolve({
          text,
          ...(artifacts.length ? { artifacts } : {}),
        });
      }
      this.turns.delete(turn.sessionId);
    }
  }

  async setToolProgressMode(mode) {
    const next = String(mode || '').trim().toLowerCase() === 'verbose' ? 'verbose' : 'all';
    this.toolProgressMode = next;
    this.env.HERMES_TUI_TOOL_PROGRESS = next;
    // Hermes applies config.set to the live session and its supported
    // gateway config path. This is called only after the user explicitly
    // changes the localhost development control. New detached gateways also
    // inherit the env value above; no Mia process owns the gateway.
    const sessionIds = Array.from(this.sessions);
    if (!this.socket || this.socket.readyState !== 1) return;
    const targets = sessionIds.length ? sessionIds : [null];
    await Promise.allSettled(targets.map((sessionId) => this.request('config.set', {
      key: 'verbose',
      value: next,
      ...(sessionId ? { session_id: sessionId } : {}),
    })));
  }

  async waitForSessionReady(sessionId) {
    if (this.sessionInfo.has(sessionId)) return this.sessionInfo.get(sessionId);
    return new Promise((resolve, reject) => {
      const finish = (error, info) => {
        clearTimeout(timer);
        this.sessionReadyWaiters.delete(sessionId);
        if (error) reject(error); else resolve(info);
      };
      const timer = setTimeout(() => finish(new Error('Hermes agent initialization timed out')), CONNECT_TIMEOUT_MS);
      this.sessionReadyWaiters.set(sessionId, {
        resolve: (info) => finish(null, info),
        reject: (error) => finish(error),
      });
    });
  }

  async applySessionSelection(sessionId, base, info) {
    // session.create acknowledges the requested model before the agent exists.
    // Its constructor can normalize that model. Wait for the live agent before
    // switching so a deferred build cannot overwrite a successful selection.
    if (info?.lazy && base.model) info = await this.waitForSessionReady(sessionId);
    // A lazily resumed session reports the profile's global default model in
    // its info, not the override persisted on the stored row, so that info
    // cannot prove the session already matches the picker. Only skip the
    // switch when a live agent reports the same model and provider.
    const current = info && typeof info === 'object' && !info.lazy ? info : null;
    const sameModel = Boolean(current) && base.model && String(current.model || '') === String(base.model);
    const sameProvider = Boolean(current) && (!base.provider
      || String(current.provider || '').toLowerCase() === String(base.provider).toLowerCase());
    if (base.model && !(sameModel && sameProvider)) {
      // config.set model without --global/--session pins the pick to this session only.
      const selected = await this.request('config.set', {
        session_id: sessionId,
        key: 'model',
        value: base.provider ? `${base.model} --provider ${base.provider}` : base.model,
      });
      if (selected.confirm_required) throw new Error(selected.confirm_message || selected.warning || 'Model selection requires confirmation');
    }
    if (base.fast !== undefined) {
      try {
        await this.request('config.set', {
          session_id: sessionId,
          key: 'fast',
          value: base.fast ? 'fast' : 'normal',
        });
      } catch (error) {
        // Pinned-gateway bug: on a lazily resumed session `config.set fast`
        // validates against the profile default model, not the session's
        // just-pinned one, and rejects fast mode the model actually supports.
        // Passing `fast` at session.create works, so the caller recreates the
        // session instead of failing the user's turn.
        if (base.fast === true && /fast mode is not available/i.test(String(error && error.message || ''))) {
          error.fastModeLazyResume = true;
        }
        throw error;
      }
    }
    if (base.reasoning_effort) {
      await this.request('config.set', {
        session_id: sessionId,
        key: 'reasoning',
        value: base.reasoning_effort,
      });
    }
    const live = this.sessionInfo.get(sessionId);
    if (base.model && live && (live.model !== base.model
      || (base.provider && String(live.provider || '').toLowerCase() !== String(base.provider).toLowerCase()))) {
      throw new Error('Hermes did not apply the selected model');
    }
  }

  async createOrResumeSession({ storedSessionId, seedMessages, title, options }) {
    const profile = options && typeof options.profile === 'string'
      ? options.profile.trim()
      : '';
    const base = {
      source: 'miaos-native',
      title: title || 'Mia conversation',
      close_on_disconnect: false,
      ...(profile ? { profile } : {}),
      ...(options && options.provider ? { provider: options.provider } : {}),
      ...(options && options.model ? { model: options.model } : {}),
      ...(options && options.fast !== undefined ? { fast: options.fast === true } : {}),
      ...(options && options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(options && typeof options.artifactWorkspace === 'string' && options.artifactWorkspace
        ? { artifact_workspace: options.artifactWorkspace }
        : {}),
      ...(options && typeof options.workspaceDir === 'string' && options.workspaceDir
        ? { cwd: options.workspaceDir }
        : {}),
    };
    const selectionKey = JSON.stringify([
      base.model || '',
      String(base.provider || '').toLowerCase(),
      base.fast === undefined ? null : base.fast === true,
      base.reasoning_effort || '',
    ]);
    if (storedSessionId) {
      try {
        const resumed = await this.request('session.resume', {
          session_id: storedSessionId,
          source: 'miaos-native',
          ...(profile ? { profile } : {}),
        });
        if (resumed && resumed.session_id) {
          this.sessions.add(String(resumed.session_id));
          // Existing Hermes rows retain their old cwd. Rebind Mia's resumed
          // session to the app-owned workspace before the next turn so its
          // AGENTS.md chain and shell guard apply immediately after upgrade.
          if (base.cwd) {
            await this.request('session.cwd.set', {
              session_id: String(resumed.session_id),
              cwd: base.cwd,
            });
          }
          // session.resume ignores provider/model/fast/reasoning params: the
          // resumed row keeps whatever override it was created with, so a
          // conversation started on OpenAI stayed on OpenAI after the user
          // switched the picker to DeepSeek (401 "Incorrect API key"). Re-apply
          // the current selection through session-scoped config.set (the same
          // path as /model, /fast, /reasoning) before the next turn.
          const storedKey = String(resumed.session_key || storedSessionId);
          // Pins persist in the stored row: skip the per-turn re-pin when this
          // exact selection was already applied to this stored session, so an
          // unchanged picker never re-enters the gateway's lazy-resume
          // `config.set fast` bug.
          if (this.appliedSelections.get(storedKey) !== selectionKey) {
            await this.applySessionSelection(String(resumed.session_id), base, resumed.info);
            this.appliedSelections.set(storedKey, selectionKey);
          }
          return { sessionId: String(resumed.session_id), storedSessionId: storedKey };
        }
      } catch (error) {
        // Hermes state can be cleared independently of the native DB. Start a
        // fresh session in that case; transport/auth/provider errors must still
        // surface instead of silently creating a second conversation. A
        // fast-mode rejection on a lazy resume also falls through: session.create
        // accepts `fast` up front, so recreating (seeded with history below)
        // honors the user's speed pick instead of failing the turn.
        if (error.code !== 4007 && error.fastModeLazyResume !== true) throw error;
      }
    }
    const created = await this.request('session.create', {
      ...base,
      messages: Array.isArray(seedMessages) ? seedMessages : [],
    });
    if (!created || !created.session_id || !created.stored_session_id) {
      throw new Error('Hermes gateway did not return a persistent session id');
    }
    const createdSessionId = String(created.session_id);
    this.sessions.add(createdSessionId);
    // Some profile-backed Hermes sessions initialize their live agent from
    // the profile default even when session.create carries an explicit model.
    // Re-pin the requested selection before the first prompt, exactly as we
    // do after resume, so one-shot helpers cannot silently use that default.
    await this.applySessionSelection(createdSessionId, base, created.info);
    this.appliedSelections.set(String(created.stored_session_id), selectionKey);
    return { sessionId: createdSessionId, storedSessionId: String(created.stored_session_id) };
  }

  async modelOptions({ refresh = false } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch is not available');
    await this.ensureGateway();
    const endpoint = new URL(this.endpoint());
    const token = this.configuredToken || this.gatewayToken || endpoint.searchParams.get('token') || '';
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    endpoint.pathname = '/api/model/options';
    endpoint.search = '';
    endpoint.searchParams.set('include_unconfigured', 'false');
    if (refresh) endpoint.searchParams.set('refresh', 'true');
    let lastError = null;
    // The gateway socket can accept connections a fraction before its HTTP
    // model route is ready during a packaged-app launch. Retry only transport
    // and server-startup failures; authentication/client failures must surface.
    for (let attempt = 1; attempt <= MODEL_OPTIONS_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MODEL_OPTIONS_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(endpoint.toString(), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        const raw = await response.text();
        let payload = null;
        try { payload = raw ? JSON.parse(raw) : null; } catch (_) { /* handled below */ }
        if (!response.ok) {
          const error = new Error(`Hermes gateway model inventory failed (${response.status})`);
          error.status = response.status;
          throw error;
        }
        if (!payload || !Array.isArray(payload.providers)) {
          throw new Error('Hermes gateway returned an invalid model inventory');
        }
        return payload;
      } catch (error) {
        lastError = error;
        const status = Number(error && error.status);
        const retryable = !status || status >= 500;
        if (!retryable || attempt === MODEL_OPTIONS_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(
          resolve,
          Math.min(2000, RETRY_DELAY_MS * 2 * attempt)
        ));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('Hermes gateway model inventory unavailable');
  }

  // Disconnect and clean slate must drop the in-memory agents: a live gateway
  // session keeps the credential it was built with and keeps answering after
  // `hermes auth logout` removed the key from auth.json.
  async closeLiveSessions() {
    const ids = Array.from(this.sessions);
    if (!ids.length) return 0;
    await this.connect();
    let closed = 0;
    for (const sessionId of ids) {
      try {
        await this.request('session.close', { session_id: sessionId });
        closed += 1;
      } catch (_) { /* already gone */ }
      this.sessions.delete(sessionId);
      this.sessionInfo.delete(sessionId);
    }
    return closed;
  }

  // Stored rows pin the provider, model, and API key a conversation was
  // created with (`model_override`); a reset must delete them, not just the
  // Mia-side conversation that pointed at them.
  async deleteStoredSessions(storedSessionIds, { profile } = {}) {
    const ids = Array.from(new Set((storedSessionIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
    if (!ids.length) return 0;
    await this.connect();
    let deleted = 0;
    for (const sessionId of ids) {
      try {
        await this.request('session.delete', { session_id: sessionId, ...(profile ? { profile } : {}) });
        deleted += 1;
      } catch (error) {
        // 4007 = not found (already gone), 4023 = still live (closed above; a
        // race here is not worth failing the whole reset).
        if (error && error.code !== 4007 && error.code !== 4023) throw error;
      }
    }
    return deleted;
  }

  async interrupt(sessionId) {
    return this.request('session.interrupt', { session_id: String(sessionId || '') });
  }

  async steer(sessionId, text) {
    return this.request('session.steer', {
      session_id: String(sessionId || ''),
      text: String(text || ''),
    });
  }

  async run({
    storedSessionId,
    seedMessages,
    title,
    message,
    options,
    imagePaths = [],
    onEvent = null,
    onSession = null,
    signal = null,
  }) {
    const session = await this.createOrResumeSession({ storedSessionId, seedMessages, title, options });
    if (typeof onSession === 'function') onSession(session);
    if (signal && signal.aborted) {
      await this.interrupt(session.sessionId).catch(() => {});
      throw turnAbortError();
    }
    for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
      await this.request('image.attach', {
        session_id: session.sessionId,
        path: String(imagePath || ''),
      });
    }
    const existing = this.turns.get(session.sessionId);
    if (existing) throw new Error('Hermes gateway session already has a running turn');
    const result = new Promise((resolve, reject) => {
      this.turns.set(session.sessionId, {
        sessionId: session.sessionId,
        text: '',
        resolve,
        reject,
        onEvent: typeof onEvent === 'function' ? onEvent : null,
      });
    });
    let rejectAbort = null;
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      this.interrupt(session.sessionId).catch(() => {});
      rejectAbort(turnAbortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const submitted = this.request('prompt.submit', { session_id: session.sessionId, text: String(message || '') });
      await (signal ? Promise.race([submitted, aborted]) : submitted);
      const completed = await (signal ? Promise.race([result, aborted]) : result);
      return {
        text: completed.text,
        storedSessionId: session.storedSessionId,
        ...(Array.isArray(completed.artifacts) ? { artifacts: completed.artifacts } : {}),
      };
    } catch (error) {
      this.turns.delete(session.sessionId);
      throw error;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // Stop the gateway this client started and wait for it to exit, so a fresh
  // client can start a new one instead of probing a port the dying process
  // still holds. Resolves false when no owned gateway was running (an external
  // gateway is never adopted, so it is never restarted either).
  async stopOwnedGateway(timeoutMs = 10000) {
    const child = this.child;
    this.child = null;
    this.failConnection(new Error('Hermes gateway restarting'));
    this.sessions.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null || typeof child.kill !== 'function') return false;
    const exited = new Promise((resolve) => {
      if (typeof child.once === 'function') child.once('exit', () => resolve(true));
    });
    try { child.kill('SIGTERM'); } catch (_) { return false; }
    const timer = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs).unref());
    const clean = await Promise.race([exited, timer]);
    if (!clean) {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), 2000).unref())]);
    }
    return true;
  }

  close() {
    this.shutdownRequested = true;
    this.failConnection(new Error('Hermes gateway client closed'));
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null && typeof child.kill === 'function') {
      try { child.kill('SIGTERM'); } catch (_) { /* child already exited */ }
    }
  }
}

module.exports = {
  HermesGatewayClient,
  DEFAULT_PORT,
};
