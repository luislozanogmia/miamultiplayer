'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
require('dotenv').config({
  path: process.env.MIAOS_ENV_FILE || path.join(__dirname, '.env.local'),
});
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mia-os.db');
const RUNTIME_DIR = path.resolve(
  process.env.MIAOS_RUNTIME_DIR || path.dirname(path.resolve(DB_PATH))
);
process.env.HERMES_HOME = String(process.env.HERMES_HOME || '').trim()
  || path.join(RUNTIME_DIR, 'hermes');
process.env.MIAOS_HERMES_GATEWAY_TOKEN_FILE = String(process.env.MIAOS_HERMES_GATEWAY_TOKEN_FILE || '').trim()
  || path.join(process.env.HERMES_HOME, 'gateway.token');
process.env.HERMES_AGENT_ROOT = String(process.env.HERMES_AGENT_ROOT || '').trim()
  || path.join(process.env.HERMES_HOME, 'hermes-agent');
process.env.HERMES_STATE_DB = String(process.env.HERMES_STATE_DB || '').trim()
  || path.join(process.env.HERMES_HOME, 'state.db');
process.env.HERMES_CRON_JOBS_FILE = String(process.env.HERMES_CRON_JOBS_FILE || '').trim()
  || path.join(process.env.HERMES_HOME, 'cron', 'jobs.json');
process.env.HERMES_CRON_EXECUTIONS_DB = String(process.env.HERMES_CRON_EXECUTIONS_DB || '').trim()
  || path.join(process.env.HERMES_HOME, 'cron', 'executions.db');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR = String(process.env.MIAOS_AUTOMATION_ARTIFACT_DIR || '').trim()
  || path.join(RUNTIME_DIR, 'bot-artifacts');
const { EFFECTIVE_RELEASE_PROFILE, MIAOS_AGENT_SEARCH_ONLY } = require('./release-profile');
const { provisionHermesWebSearchConfig } = require('./hermes-web-search-config');
const { provisionHermesRuntimeProfiles } = require('./hermes-bot-profile');
// Only terminal-free search releases receive the hosted-search credential.
// Full local agents can execute commands and must not share that secret scope.
provisionHermesWebSearchConfig({
  gatewayUrl: MIAOS_AGENT_SEARCH_ONLY ? process.env.MIAOS_FIRECRAWL_GATEWAY_URL : '',
  gatewayToken: MIAOS_AGENT_SEARCH_ONLY ? process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN : '',
});
provisionHermesRuntimeProfiles();
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const { verifyToken: verifyClerkToken } = require('@clerk/backend');
const { CLERK_INSTANCES, resolveClerkConfig, clerkClaimsProfile, clerkVerifyOptions } = require('./clerk-config');
const { buildPageCsp, replacePageCsp } = require('../frontend/csp-policy.cjs');

const db = require('./db');
const { preferredName, openingMessage, nameAnswer, NEWS_INTRO, newsBriefing } = require('./onboarding-chat');
const {
  buildContext,
  buildBotContext,
  userInstructionSection,
  runInference,
  runInferenceViaHermesGateway,
  steerHermesGatewaySession,
  getHermesGatewayModelOptions,
  startHermesGatewayRuntime,
  closeHermesGatewayRuntime,
  HERMES_SUBSCRIPTION_MODEL_OPTIONS,
  HERMES_ALLOWED_MODELS_BY_PROVIDER,
  MANAGED_ROUTER_HERMES_PROVIDER,
  normalizeHermesModelSelection,
  isAllowedHermesModel,
  loadMiaGhostSkill,
  MIAOS_BROWSER_TURN_POLICY,
  MIAOS_AGENT_MAX_TURNS,
  MIAOS_BOT_MAX_TURNS,
  appOwnedToolPolicy,
  getHermesDiagnostics,
  setHermesDiagnostics,
  closeHermesGatewaySessions,
  deleteHermesGatewaySessions,
  restartHermesGatewayRuntime,
  stopHermesGatewayRuntime,
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  hermesTokenBudgetFromOptions,
  hermesCharBudgetFromTokens,
} = require('./inference');
const {
  listHermesCredentialProviders,
  readProviderRootCredentials,
  removeProviderProfileCredentials,
  removeProviderRootCredentials,
  resetHermesHome,
} = require('./hermes-home-reset');
const {
  CHAT_REASONING_EFFORTS,
  CHAT_SPEEDS,
  normalizeChatModelInventory,
  inventoryResponse,
  visibleChatModelInventory,
  normalizeChatModelSelection,
  chatModelSelectionInferenceOptions,
  userFacingModelDispatchError,
} = require('./chat-model-selection');
const { sanitizeChatReply } = require('./chat-security');
const {
  SERVER_OWNED_AGENT_FIELDS,
  isValidAgentAvatarColor,
  normalizeAgentAvatarColor,
  stripServerOwnedAgentFields,
} = require('./agent-record-security');
const googleWorkspace = require('./google-gmail');
const googleWorkspaceContext = require('./google-workspace-context');
const googleWorkspaceActions = require('./google-workspace-actions');
const { createGoogleAccountConnector, createOwnerBoundGoogleAccount } = require('./google-account-connector');
const { stripTaskOpeningNotice, humanTaskStatus, shouldPostTaskStatus } = require('./background-status');
const {
  buildAgentSetupPrompt,
  fallbackAgentDraft,
  normalizeAgentDraft,
} = require('./agent-setup');
const { INSTANCE_NAME, INSTANCE_TEAM_DESCRIPTION, INSTANCE_DOMAINS, INSTANCE_PASSWORD } = require('./instance');
const cronSync = require('./cron-sync');
const {
  cancelBotAutomationFromChat,
  managerAutomationRequestFromChat,
  scheduleBotAutomationFromChat,
} = require('./bot-automation-chat');
const {
  createConversationRepository,
  USER_CANCELLED_DISPATCH_ERROR,
} = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const { createConversationService, canonicalBotConversationCandidates } = require('./conversation-service');
const { createConversationDispatchService, dispatchOwnerAccountIsActive } = require('./conversation-dispatch');
const { resolveMentionedBots } = require('./conversation-routing');
const { createConversationRealtime } = require('./conversation-realtime');
const { createConversationAttachmentStore } = require('./conversation-attachments');
const { createConversationRouter } = require('./conversation-router');
const { attachConversationWebSocketServer } = require('./conversation-websocket');
const { createWorkspaceArtifactService } = require('./workspace-artifacts');
const { createWorkspaceArtifactRouter } = require('./workspace-artifact-router');
const { configuredHermesLaunch, requiredConfiguredExecutable } = require('./runtime-paths');
const {
  nativeDispatchTimeoutMs,
  NATIVE_DISPATCH_TIMEOUT_CODE,
  createNativeDispatchWatchdog,
  NATIVE_DISPATCH_TOKEN_BUDGET_CODE,
  createNativeDispatchTokenBudgetTracker,
} = require('./native-dispatch-runtime');
const { miaosWorkspacePromptContext, workspaceDir: miaosWorkspaceDir } = require('./miaos-workspace');
const {
  DEFAULT_WORKSPACE_ID,
  departmentsMetaKey,
  recordBelongsToCompany,
  workspaceCompanyId,
  workspaceIdForRecord,
  workspaceIdFromRequest,
} = require('./workspace-scope');

const PORT = process.env.PORT || 4870;
const MAX_BOTS = 100;
const HERMES_BIN = String(process.env.HERMES_BIN || '').trim();
const NATIVE_DISPATCH_TIMEOUT_MS = nativeDispatchTimeoutMs(process.env.MIAOS_NATIVE_DISPATCH_TIMEOUT_MS);
const MIAOS_HERMES_GUARD_BIN = path.join(__dirname, 'miaos-hermes-bin');
const adminModule = require('./admin');
const DATA_DIR = process.env.DATA_DIR || '';
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(__dirname, process.env.STATIC_DIR) : '';
const BOT_PACKAGE_DIR = path.resolve(process.env.MIAOS_BOT_PACKAGE_DIR || path.join(path.dirname(path.resolve(DB_PATH)), 'bots'));
const conn = db.openDb(DB_PATH, DATA_DIR, { botPackageDir: BOT_PACKAGE_DIR });
const configuredAdminEmails = String(process.env.ADMIN_EMAILS || '')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const storedAdminEmails = db.listUsers(conn)
  .filter((user) => user.role === 'admin' && !user.disabled)
  .map((user) => String(user.email || '').trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS = configuredAdminEmails.length ? configuredAdminEmails : storedAdminEmails;
function isAdmin(email) {
  const normalized = String(email || '').toLowerCase();
  return normalized === String(process.env.MIAOS_SINGLE_USER_EMAIL || '').trim().toLowerCase()
    || ADMIN_EMAILS.includes(normalized);
}
// Explicit local preview escape hatch. It is off unless the process is
// started with MIAOS_NO_AUTH=1; production and normal development retain the
// session/API-key auth path below.
const MIAOS_NO_AUTH = /^(1|true)$/i.test(process.env.MIAOS_NO_AUTH || '');
// Built-in production/test Clerk instances and fork overrides: clerk-config.js.
const CLERK_CONFIG = resolveClerkConfig(process.env);
const CLERK_PUBLISHABLE_KEY = CLERK_CONFIG.publishableKey;
const CLERK_JWT_KEY = CLERK_CONFIG.jwtKey;
const CLERK_ISSUER = CLERK_CONFIG.issuer;
const MIAOS_CLERK_AUTH = CLERK_CONFIG.enabled;
const MIAOS_PAGE_CSP = buildPageCsp(CLERK_CONFIG.issuerOrigin);
const CLERK_SUBJECT_META_KEY = 'clerk.installation.subject';
const CLERK_EMAIL_META_KEY = 'clerk.installation.email';
const CLERK_NAME_META_KEY = 'clerk.installation.name';
const CLERK_ISSUER_META_KEY = 'clerk.installation.issuer';
// Links made before the issuer was recorded came from the only built-in
// instance at the time, Mia's test instance.
const CLERK_LEGACY_LINK_ISSUER = CLERK_INSTANCES.test.issuer;
// A local OSS installation has one durable profile without requiring the
// person running it to invent an email address. The internal principal keeps
// existing ownership/storage contracts intact, but is never shown as an
// account address in the UI.
const MIAOS_LOCAL_PROFILE = (MIAOS_NO_AUTH || MIAOS_CLERK_AUTH)
  && /^(1|true)$/i.test(process.env.MIAOS_LOCAL_PROFILE || '');
const LOCAL_PROFILE_PRINCIPAL = 'local-user@localhost';
const MIAOS_TEAM_SEARCH = EFFECTIVE_RELEASE_PROFILE.teamSearch;
// When configured, the Internet-facing release has one exact human identity.
// The first successful owner login may bootstrap its real users-table row;
// after that, cookies and API keys always resolve through that durable row.
const MIAOS_SINGLE_USER_EMAIL = String(process.env.MIAOS_SINGLE_USER_EMAIL || '').trim().toLowerCase();
if (MIAOS_SINGLE_USER_EMAIL) {
  const domain = MIAOS_SINGLE_USER_EMAIL.split('@').pop() || '';
  if (!MIAOS_SINGLE_USER_EMAIL.includes('@') || !INSTANCE_DOMAINS.includes(domain)) {
    throw new Error('MIAOS_SINGLE_USER_EMAIL must be an exact email on an INSTANCE_DOMAINS domain');
  }
}

// The backend must never use the request's Host header to decide which
// origins are trusted. Host is attacker-controlled input on a local HTTP
// listener, and using it as the expected origin turns a cross-site request
// into a same-origin request by construction. Build the allowlist once from
// the configured public origin and the address this process is configured to
// bind. Loopback aliases are explicit because the Electron shell may use
// either localhost or 127.0.0.1 while still reaching the same bound service.
const MIAOS_BIND_HOST = MIAOS_TEAM_SEARCH
  ? '127.0.0.1'
  : String(process.env.MIAOS_BIND_HOST || '').trim()
    || (MIAOS_NO_AUTH || MIAOS_SINGLE_USER_EMAIL ? '127.0.0.1' : '');
const MIAOS_ORIGIN_ENV_VALUES = [
  ['MIAOS_ORIGIN', process.env.MIAOS_ORIGIN],
  ['MIAOS_PUBLIC_BASE_URL', process.env.MIAOS_PUBLIC_BASE_URL],
  ['PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL],
].filter(([, value]) => String(value || '').trim() !== '');

function configuredMiaOrigin(value, sourceName) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(value); } catch (_error) {
    throw new Error(`${sourceName} must be a valid http(s) origin`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error(`${sourceName} must be a valid http(s) origin`);
  }
  return parsed.origin.toLowerCase();
}

const MIAOS_CONFIGURED_ORIGINS = new Set(
  MIAOS_ORIGIN_ENV_VALUES.map(([name, value]) => configuredMiaOrigin(String(value).trim(), name))
);
if (MIAOS_CONFIGURED_ORIGINS.size > 1) {
  throw new Error('MIAOS_ORIGIN, MIAOS_PUBLIC_BASE_URL, and PUBLIC_BASE_URL must identify the same Mia origin');
}
const MIAOS_CONFIGURED_ORIGIN = Array.from(MIAOS_CONFIGURED_ORIGINS)[0] || null;
const CLEAN_SLATE_CONFIRMATION_TTL_MS = 60 * 1000;
const cleanSlateConfirmations = new Map();

// ---------- per-user workspaces ----------
// One instance, many users: agents, department rooms, and the departments
// list are scoped to whichever user owns them, not shared globally. Every
// pre-existing row (from before this feature) has no `owner` field, so it's
// migrated onto DEFAULT_OWNER at boot (migrateWorkspaceOwnership) rather than
// treated as ownerless — an ownerless record would just be unreachable for
// everyone via sameOwner().
const DEFAULT_OWNER = MIAOS_LOCAL_PROFILE
  ? LOCAL_PROFILE_PRINCIPAL
  : (MIAOS_SINGLE_USER_EMAIL || ADMIN_EMAILS[0] || db.firstUserEmail(conn) || '');
if (MIAOS_LOCAL_PROFILE && !db.getUserByEmail(conn, LOCAL_PROFILE_PRINCIPAL)) {
  db.createUser(conn, {
    email: LOCAL_PROFILE_PRINCIPAL,
    // Local-profile mode has no login route. Store an unrecoverable random
    // credential so this row can never introduce a reusable default password.
    passwordHash: adminModule.hashPassword(crypto.randomBytes(32).toString('hex')),
    role: 'admin',
    displayName: 'Local user',
    initials: 'LU',
  });
}
const TEAM_RELEASE_BOOTSTRAP_EMAIL = MIAOS_TEAM_SEARCH
  ? String(DEFAULT_OWNER || '').trim().toLowerCase()
  : '';
if (MIAOS_TEAM_SEARCH) {
  const domain = TEAM_RELEASE_BOOTSTRAP_EMAIL.split('@').pop() || '';
  if (!TEAM_RELEASE_BOOTSTRAP_EMAIL || !TEAM_RELEASE_BOOTSTRAP_EMAIL.includes('@')
    || !INSTANCE_DOMAINS.includes(domain)) {
    throw new Error('team-search requires the first ADMIN_EMAILS identity on an INSTANCE_DOMAINS domain');
  }
}
function ownerOf(record) {
  return String((record && record.owner) || DEFAULT_OWNER).toLowerCase();
}
function sameOwner(record, email) {
  return ownerOf(record) === String(email || '').toLowerCase();
}
function sameWorkspace(record, req) {
  return sameOwner(record, req && req.userEmail)
    && workspaceIdForRecord(record) === workspaceIdFromRequest(req);
}
function botVisibleInWorkspace(record, req) {
  const workspaceId = workspaceIdFromRequest(req);
  if (workspaceIdForRecord(record) !== workspaceId) return false;
  return isActiveWorkspaceUser(ownerOf(record))
    && (workspaceId === DEFAULT_WORKSPACE_ID || sameOwner(record, req && req.userEmail));
}
function botMutableInWorkspace(record, req) {
  const caller = String(req && req.userEmail || '').toLowerCase();
  const user = caller ? db.getUserByEmail(conn, caller) : null;
  return botVisibleInWorkspace(record, req)
    && (sameOwner(record, caller) || isAdmin(caller) || (user && user.role === 'admin'));
}
const SESSION_COOKIE = 'miaos_sid';
// 30-day rolling TTL: a session expires 30 days after its *last* request,
// not 30 days after login, so an active user never gets logged out mid-use.
// Touching last_seen_at on every request would mean a write per request, so
// touchSessionIfStale() below only bumps it once this often.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const GATEWAY_AGENT_ID = 'gateway';
const ALLOWED_DOMAINS = INSTANCE_DOMAINS;
const MAX_CHAT_HISTORY = 40;
const MAX_MEDIA_UPLOAD_REQUEST_BYTES = 12 * 1024 * 1024;

// Human identity is database-owned. Shared rosters are projected only from
// active users on this instance's configured domains, never from old room
// membership rows, bot owners, or presentation fixtures. A disposable local
// no-auth preview may have no users table rows, so its configured owner is the
// sole temporary identity in that one mode.
function activeWorkspaceUsers() {
  const users = db.listUsers(conn).filter((user) => {
    const email = String(user && user.email || '').trim().toLowerCase();
    const domain = email.split('@').pop() || '';
    return email && !user.disabled
      && (ALLOWED_DOMAINS.includes(domain) || (MIAOS_LOCAL_PROFILE && email === LOCAL_PROFILE_PRINCIPAL));
  });
  if (users.length || !MIAOS_NO_AUTH || !DEFAULT_OWNER) return users;
  return [{ email: DEFAULT_OWNER, displayName: null, initials: null, role: 'admin', disabled: false }];
}

function isActiveWorkspaceUser(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return activeWorkspaceUsers().some((user) => String(user.email || '').trim().toLowerCase() === normalized);
}

// The official gws profile is installation/process-scoped. A deleted user
// may later be recreated with the same email, so an email comparison alone
// would hand the old external credential back to the new account. The
// deleted_users row is durable and intentionally retained as a revocation
// tombstone; query failures deny access rather than guessing that the profile
// is safe to reuse.
function googleAccountBindingRevoked(ownerEmail) {
  const normalized = String(ownerEmail || '').trim().toLowerCase();
  if (!normalized) return true;
  try {
    return Boolean(conn.prepare(
      'SELECT 1 FROM deleted_users WHERE lower(email) = ? LIMIT 1'
    ).get(normalized));
  } catch (_) {
    return true;
  }
}

const googleAccountConnector = createGoogleAccountConnector();
const googleAccountOwnerEmail = String(
  process.env.MIAOS_GOOGLE_ACCOUNT_OWNER || MIAOS_SINGLE_USER_EMAIL || DEFAULT_OWNER || ''
).trim().toLowerCase();
// A pristine desktop install has no database user until onboarding. Google is
// simply disconnected in that state; it must not crash the entire backend or
// invent an owner identity. Once a real owner exists, the strict binding below
// continues to enforce that only that database/config identity can use it.
const googleAccountOwnerBinding = googleAccountOwnerEmail
  ? createOwnerBoundGoogleAccount(googleAccountConnector, googleAccountOwnerEmail, { isRevoked: googleAccountBindingRevoked })
  : Object.freeze({ ownerEmail: '', owns: () => false, connectorFor: () => null });
function runtimeStorageDir(envName, localFallback) {
  const configured = String(process.env[envName] || '').trim();
  if (!MIAOS_SINGLE_USER_EMAIL && !MIAOS_TEAM_SEARCH) return configured || localFallback;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error(`${envName} must be an absolute path for a confined release profile`);
  }
  const resolved = path.resolve(configured);
  const sourceRoot = fs.realpathSync(path.resolve(__dirname, '..'));
  let existingAncestor = resolved;
  const suffix = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    suffix.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonical = path.resolve(fs.realpathSync(existingAncestor), ...suffix);
  if (canonical === sourceRoot || canonical.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error(`${envName} must be outside the Mia source tree for a confined release profile`);
  }
  return resolved;
}

const WORKSPACE_ARTIFACT_DIR = runtimeStorageDir(
  'MIAOS_ARTIFACT_DIR',
  path.join(DATA_DIR || __dirname, 'workspace-artifacts')
);
const workspaceArtifactService = createWorkspaceArtifactService({ database: conn, rootDir: WORKSPACE_ARTIFACT_DIR });
const NATIVE_COMPANY_ID = process.env.MIAOS_COMPANY_ID || INSTANCE_DOMAINS[0] || 'miaos';
function nativeCompanyId(workspaceId, email) {
  return workspaceCompanyId(NATIVE_COMPANY_ID, workspaceId, email);
}
const NATIVE_ATTACHMENT_DIR = runtimeStorageDir(
  'MIAOS_ATTACHMENT_DIR',
  path.join(DATA_DIR || __dirname, 'conversation-attachments')
);
const nativeConversationRepository = createConversationRepository(conn);
const nativeConversationAuthorization = createConversationAuthorization(nativeConversationRepository);
const nativeConversationRealtime = createConversationRealtime(nativeConversationAuthorization);
const nativeConversationDispatchPlanner = createConversationDispatchService({
  repository: nativeConversationRepository,
});

// Keep turns for the same native actor in a conversation ordered. In
// particular, two quick messages to Mia must not start two browser sessions
// against the same embedded page at once: that consumes both global Hermes
// slots, races the browser state, and makes the first reply wait behind a
// timeout/recovery loop. Different conversations and different worker agents
// remain eligible to run concurrently.
const nativeDispatchChains = new Map();
const nativeDispatchAbortControllers = new Map();
const nativeActiveGatewaySessions = new Map();
// A deletion request is a local process-wide revocation barrier. The users
// row is also marked disabled before dispatch cleanup begins, so the guard
// remains fail-closed for any other request sharing this database.
const nativeDeletingUsers = new Set();

function nativeDispatchUserIsActive(dispatch, trigger) {
  if (!trigger || trigger.senderType !== 'user') return true;
  const owner = String(trigger.senderId || '').trim().toLowerCase();
  const user = db.getUserByEmail(conn, owner);
  if (!dispatchOwnerAccountIsActive({
    owner,
    user,
    noAuth: MIAOS_NO_AUTH,
    defaultOwner: DEFAULT_OWNER,
    deleting: nativeDeletingUsers.has(owner),
  })) return false;
  try {
    const member = nativeConversationRepository.getMember({
      companyId: dispatch.companyId,
      conversationId: dispatch.conversationId,
      principalId: owner,
      principalType: 'user',
    });
    return Boolean(member && member.state === 'active');
  } catch (_) {
    return false;
  }
}

function nativeCronBotOwnerIsActive(bot) {
  const owner = ownerOf(bot);
  if (!owner || nativeDeletingUsers.has(owner)) return false;
  const user = db.getUserByEmail(conn, owner);
  // The no-auth preview intentionally has no durable users row. Preserve its
  // configured local owner while requiring a real row for every authenticated
  // cron owner.
  if (!user) return MIAOS_NO_AUTH && owner === String(DEFAULT_OWNER || '').toLowerCase();
  return !user.disabled;
}

function throwIfNativeCronBotOwnerInactive(bot) {
  if (nativeCronBotOwnerIsActive(bot)) return;
  const error = new Error('cron result owner is no longer active');
  error.code = 'USER_DELETED';
  throw error;
}

function cancelNativeDispatchForInactiveUser(dispatch, trigger) {
  if (nativeDispatchUserIsActive(dispatch, trigger)) return false;
  try {
    nativeConversationRepository.cancelDispatch({
      companyId: dispatch.companyId,
      conversationId: dispatch.conversationId,
      id: dispatch.id,
      cancelledAt: new Date().toISOString(),
    });
  } catch (error) {
    // A concurrent stop/deletion can make the row terminal before this guard
    // reaches it. The fail-closed decision still holds either way.
    if (!error || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) {
      console.error('native dispatch revocation failed', dispatch.id, error && error.message ? error.message : error);
    }
  }
  const controller = nativeDispatchAbortControllers.get(dispatch.id);
  if (controller && !controller.signal.aborted) controller.abort();
  return true;
}

function throwIfNativeDispatchUserInactive(dispatch, trigger) {
  if (!cancelNativeDispatchForInactiveUser(dispatch, trigger)) return;
  const error = new Error(USER_CANCELLED_DISPATCH_ERROR);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function createNativeDispatchEvent(dispatch, trigger, input) {
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  return nativeConversationService.createEvent(input);
}

function nativeDispatchRowsForUser(email) {
  const owner = String(email || '').trim().toLowerCase();
  if (!owner) return [];
  return conn.prepare(
    `SELECT d.company_id AS companyId, d.conversation_id AS conversationId, d.id
       FROM conversation_dispatches d
       JOIN events e
         ON e.company_id = d.company_id AND e.conversation_id = d.conversation_id
        AND e.id = d.event_id
      WHERE lower(e.sender_id) = ? AND e.sender_type = 'user'
        AND d.status IN ('pending', 'claimed')`
  ).all(owner);
}

function beginNativeUserDeletion(email) {
  const owner = String(email || '').trim().toLowerCase();
  if (!owner) return { owner: '', cancelled: 0 };
  nativeDeletingUsers.add(owner);
  // Make the durable identity fail authorization while the asynchronous
  // cleanup hook scans and cancels its work. This closes the gap between the
  // admin request and db.deleteUser(), including other local dispatch paths.
  conn.prepare('UPDATE users SET disabled = 1 WHERE lower(email) = ?').run(owner);
  let cancelled = 0;
  for (const row of nativeDispatchRowsForUser(owner)) {
    try {
      const result = nativeConversationRepository.cancelDispatch({
        companyId: row.companyId,
        conversationId: row.conversationId,
        id: row.id,
        cancelledAt: new Date().toISOString(),
      });
      if (result && result.dispatch && result.dispatch.lastError === USER_CANCELLED_DISPATCH_ERROR) cancelled += 1;
    } catch (error) {
      if (!error || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) {
        console.error('native dispatch cancellation during user deletion failed', row.id, error && error.message ? error.message : error);
      }
    }
    const controller = nativeDispatchAbortControllers.get(row.id);
    if (controller && !controller.signal.aborted) controller.abort();
  }
  return { owner, cancelled };
}

function finishNativeUserDeletion(owner) {
  const normalized = String(owner || '').trim().toLowerCase();
  if (!normalized) return;
  // admin.js performs db.deleteUser immediately after its awaited hook. Keep
  // the barrier through that synchronous commit, then release the in-memory
  // entry; the deleted users row remains the durable fail-closed guard.
  setImmediate(() => nativeDeletingUsers.delete(normalized));
}

function nativeDispatchChainKey(dispatch) {
  return [
    dispatch && dispatch.companyId,
    dispatch && dispatch.conversationId,
    dispatch && dispatch.targetType,
    dispatch && dispatch.targetId,
    dispatch && dispatch.targetType === 'gateway' && dispatch.metadata && dispatch.metadata.requestedBy,
  ].map((value) => String(value || '')).join(':');
}

function queueNativeConversationDispatch(dispatch) {
  const key = nativeDispatchChainKey(dispatch);
  const previous = nativeDispatchChains.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => executeNativeConversationDispatch(dispatch));
  const settled = next.finally(() => {
    if (nativeDispatchChains.get(key) === settled) nativeDispatchChains.delete(key);
  });
  nativeDispatchChains.set(key, settled);
  return settled;
}

function scheduleNativeConversationDispatch(dispatch) {
  const key = nativeDispatchChainKey(dispatch);
  const activeGateway = dispatch && dispatch.targetType === 'gateway'
    ? nativeActiveGatewaySessions.get(key)
    : null;
  if (activeGateway && activeGateway.dispatchId !== dispatch.id) {
    return trySteerNativeConversationDispatch(dispatch, activeGateway).then((steered) => (
      steered ? undefined : queueNativeConversationDispatch(dispatch)
    ));
  }
  return queueNativeConversationDispatch(dispatch);
}

const nativeConversationDispatch = {
  planAndEnqueue(args) {
    const result = nativeConversationDispatchPlanner.planAndEnqueue(args);
    for (const dispatch of result.dispatches || []) {
      if (!dispatch || dispatch.status === 'completed') continue;
      setImmediate(() => scheduleNativeConversationDispatch(dispatch).catch(() => {}));
    }
    return result;
  },
  cancelRunning(dispatch) {
    const controller = dispatch && nativeDispatchAbortControllers.get(dispatch.id);
    if (controller && !controller.signal.aborted) controller.abort();
  },
};

// Shared conversations expose shared bots, never a user's private agent.
// A private agent conversation is a strict 1:1: its owner plus its bound
// agent. Delegated bot work belongs in the bot's own conversation.
function ensureNativeConversationMembers({ conversation, repository }) {
  if (!conversation || !repository) return;
  if (conversation.type === 'agent') {
    const owner = String(conversation.createdBy || '').trim().toLowerCase();
    for (const member of repository.listMembers({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      includeRemoved: false,
    })) {
      const isOwner = member.principalType === 'user'
        && String(member.principalId || '').toLowerCase() === owner;
      const isBoundAgent = member.principalType === 'agent'
        && member.principalId === GATEWAY_AGENT_ID;
      if (!isOwner && !isBoundAgent) {
        repository.removeMember({
          companyId: conversation.companyId,
          conversationId: conversation.id,
          principalId: member.principalId,
          principalType: member.principalType,
        });
      }
    }
    return;
  }
  if (conversation.type === 'channel') {
    const metadata = conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata : {};
    // Channels created before visibility metadata existed remain public for
    // compatibility. A private channel is opt-in and its membership is
    // durable: boot/read reconciliation must never repopulate it from the
    // installation-wide active-user roster.
    if (metadata.visibility === 'private') {
      const owner = String(conversation.createdBy || '').trim().toLowerCase();
      if (owner && isActiveWorkspaceUser(owner)) {
        const ownerMember = repository.getMember({
          companyId: conversation.companyId,
          conversationId: conversation.id,
          principalId: owner,
          principalType: 'user',
        });
        if (!ownerMember || ownerMember.state !== 'active') {
          repository.addMember({
            companyId: conversation.companyId,
            conversationId: conversation.id,
            principalId: owner,
            principalType: 'user',
            role: 'owner',
            state: 'active',
            metadata: { workspaceId: DEFAULT_WORKSPACE_ID },
          });
        }
      }
      return;
    }
    const owner = String(conversation.createdBy || '').trim().toLowerCase();
    const expectedUsers = conversation.companyId === NATIVE_COMPANY_ID
      ? activeWorkspaceUsers()
      : activeWorkspaceUsers().filter((user) => String(user.email || '').trim().toLowerCase() === owner);
    const expectedUserEmails = new Set(expectedUsers.map((user) => String(user.email || '').trim().toLowerCase()));
    for (const user of expectedUsers) {
      const email = String(user.email || '').trim().toLowerCase();
      repository.addMember({
        companyId: conversation.companyId,
        conversationId: conversation.id,
        principalId: email,
        principalType: 'user',
        role: email === owner ? 'owner' : 'member',
        state: 'active',
        metadata: { workspaceId: conversation.companyId === NATIVE_COMPANY_ID ? DEFAULT_WORKSPACE_ID : 'solo' },
      });
    }
    for (const member of repository.listMembers({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      includeRemoved: false,
    })) {
      if (member.principalType === 'user'
        && !expectedUserEmails.has(String(member.principalId || '').trim().toLowerCase())) {
        repository.removeMember({
          companyId: conversation.companyId,
          conversationId: conversation.id,
          principalId: member.principalId,
          principalType: member.principalType,
        });
      }
    }
  }
  if (conversation.type !== 'agent') {
    const legacyGateway = repository.getMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: GATEWAY_AGENT_ID,
      principalType: 'agent',
    });
    if (legacyGateway && legacyGateway.state === 'active') {
      repository.removeMember({
        companyId: conversation.companyId,
        conversationId: conversation.id,
        principalId: GATEWAY_AGENT_ID,
        principalType: 'agent',
      });
    }
  }
  if (conversation.type === 'home') {
    db.loadAll(conn, 'bots')
      .filter((bot) => recordBelongsToCompany(bot, NATIVE_COMPANY_ID, conversation.companyId))
      .forEach((bot) => repository.addMember({
        companyId: conversation.companyId,
        conversationId: conversation.id,
        principalId: bot.id,
        principalType: 'bot',
        role: 'bot',
        state: 'active',
        metadata: {
          name: bot.name || bot.id,
          manager: false,
          departments: Array.isArray(bot.departments) ? bot.departments : [],
        },
      }));
  }
}

function resolveNativeConversationParticipants({ companyId, conversationId, event }) {
  const participants = nativeConversationRepository.listMembers({
    companyId,
    conversationId,
    includeRemoved: false,
  }).map((member) => {
    const metadata = member.metadata && typeof member.metadata === 'object' ? member.metadata : {};
    return {
      id: member.principalId,
      name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : member.principalId,
      manager: metadata.manager === true,
      principalType: member.principalType,
    };
  });
  if (!event || event.senderType !== 'user' || participants.some((participant) => participant.id === GATEWAY_AGENT_ID)) {
    return participants;
  }
  const canonicalMia = nativeConversationRepository.listGatewayConversations({
    companyId,
    createdBy: event.senderId,
  }).find((conversation) => {
    const ownerMember = nativeConversationRepository.getMember({
      companyId,
      conversationId: conversation.id,
      principalId: event.senderId,
      principalType: 'user',
    });
    const gatewayMember = nativeConversationRepository.getMember({
      companyId,
      conversationId: conversation.id,
      principalId: GATEWAY_AGENT_ID,
      principalType: 'agent',
    });
    return ownerMember && ownerMember.state === 'active' && ownerMember.role === 'owner'
      && gatewayMember && gatewayMember.state === 'active' && gatewayMember.role === 'agent';
  });
  if (canonicalMia) {
    participants.push({
      id: GATEWAY_AGENT_ID,
      name: canonicalMia.name || 'Mia',
      manager: true,
      principalType: 'agent',
      private: true,
    });
  }
  return participants;
}

const nativeConversationService = createConversationService({
  repository: nativeConversationRepository,
  authorization: nativeConversationAuthorization,
  realtime: nativeConversationRealtime,
  dispatch: nativeConversationDispatch,
  resolveParticipants: resolveNativeConversationParticipants,
  ensureMembers: ensureNativeConversationMembers,
});
const nativeConversationAttachmentStore = createConversationAttachmentStore({
  repository: nativeConversationRepository,
  authorization: nativeConversationAuthorization,
  rootDir: NATIVE_ATTACHMENT_DIR,
});
adminModule.bootstrapAdmins(conn, ADMIN_EMAILS);
if (db.listUsers(conn).length > 0 && INSTANCE_PASSWORD) {
  console.log('[auth] users table is populated; INSTANCE_PASSWORD shared-login fallback is off.');
}
// ---------- live state version ----------
// A single in-memory counter clients poll (GET /api/state/version) to know
// whether to re-fetch shared data (agents, departments, conversations, user
// profiles). In-memory only: a restart resets it to 1, but clients treat ANY
// change — including a decrease — as "something changed", so that's fine.
// Cheap by design: no DB read on the polling path, just an int compare.
let stateVersion = 1;
function bumpVersion() {
  stateVersion += 1;
}

// Belt-and-suspenders for the TTL enforced in sessionFromCookie(): that check
// only fires on a request against the specific expired token, so a session
// nobody ever presents again would sit in the table forever without this.
// Runs once at boot (covers whatever piled up while the process was down)
// and every 24h after. .unref() so a pending sweep never keeps the process
// alive on shutdown.
function sweepExpiredSessions() {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  const removed = db.deleteExpiredSessions(conn, cutoff);
  if (removed) console.log(`session sweep: removed ${removed} expired session(s)`);
}
sweepExpiredSessions();
setInterval(sweepExpiredSessions, 24 * 60 * 60 * 1000).unref();

// ---------- inference concurrency guard ----------

// runInference() (inference.js) submits turns to the singleton Hermes service.
// Nothing here limits how many rooms can queue a reply job or hit
// /api/chat/suggestions at once, so every call site MUST go through
// scheduleInference() below instead of calling runInference() directly: a
// global semaphore caps simultaneous inference turns, with the rest
// FIFO-queued. Two tiers, not one —
// chat replies are the product, suggestion pills are best-effort UX sugar —
// so the 'reply' tier always drains before 'suggestion' jobs get a turn;
// within a tier it's plain FIFO. MAX_QUEUE_DEPTH bounds how many jobs can be
// waiting at once: past that, scheduleInference() rejects immediately rather
// than growing the queue without bound under sustained load. Both current
// call sites already treat a rejected/failed inference as a soft failure
// (see their own comments), so this degrades gracefully rather than crashing
// anything.
function boundedCapacityValue(raw, fallback, minimum, maximum) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

// Keep the local defaults stable, but make capacity explicit so a hosted
// deployment can define a tier without changing scheduling code. This is a
// capacity contract, not a billing meter: provider charges still belong to
// the connected provider account.
const MAX_CONCURRENT_INFERENCE = boundedCapacityValue(process.env.MIAOS_MAX_CONCURRENT_INFERENCE, 2, 1, 32);
const MAX_QUEUE_DEPTH = boundedCapacityValue(process.env.MIAOS_MAX_QUEUE_DEPTH, 12, 0, 1000);
let runningInferenceCount = 0;
const inferenceQueues = { reply: [], suggestion: [] };

function inferenceQueueDepth() {
  return inferenceQueues.reply.length + inferenceQueues.suggestion.length;
}

// Exposed so a future health endpoint can report load without reaching into
// this module's private state directly.
// tasks reports the separate background hermes-task queue (defined below,
// alongside scheduleHermesTask) — hermesTaskStats() is declared after this
// function but hoisting makes that fine, they're both plain function
// declarations in the same module scope.
function inferenceStats() {
  return {
    running: runningInferenceCount,
    waiting: inferenceQueueDepth(),
    capacity: { maxConcurrent: MAX_CONCURRENT_INFERENCE, maxQueueDepth: MAX_QUEUE_DEPTH },
    tasks: { running: 0, waiting: 0 },
  };
}

// Starts as many queued jobs as there's room for, reply tier first. Called
// whenever a slot might have opened up (a job just finished) or a job was
// just enqueued (in case a slot was already free).
function pumpInferenceQueue() {
  while (runningInferenceCount < MAX_CONCURRENT_INFERENCE) {
    const job = inferenceQueues.reply.shift() || inferenceQueues.suggestion.shift();
    if (!job) return;
    runningInferenceCount++;
    runInference(job.prompt, job.options).then(
      (result) => {
        runningInferenceCount--;
        job.resolve(result);
        pumpInferenceQueue();
      },
      (err) => {
        runningInferenceCount--;
        job.reject(err);
        pumpInferenceQueue();
      }
    );
  }
}

// priority: 'reply' (default) or 'suggestion'. A job that can't start right
// away joins the FIFO queue for its tier; once MAX_QUEUE_DEPTH jobs are
// already waiting (across both tiers — depth only sits above 0 while every
// slot is busy, since pumpInferenceQueue() drains eagerly otherwise), this
// rejects immediately instead of queueing, so callers fail fast rather than
// piling up behind an already-saturated VM.
function scheduleInference(prompt, priority, options) {
  const tier = priority === 'suggestion' ? 'suggestion' : 'reply';
  if (inferenceQueueDepth() >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error('inference queue full'));
  }
  return new Promise((resolve, reject) => {
    inferenceQueues[tier].push({ prompt, resolve, reject, options });
    pumpInferenceQueue();
  });
}

const app = express();
// Caddy terminates TLS and proxies to us over plain HTTP on 127.0.0.1, so
// req.secure needs a trusted hop reading X-Forwarded-Proto for the session
// cookie to mark itself Secure in prod. 'loopback' trusts only
// 127.0.0.1/::1 as a forwarding proxy — anything else can't spoof the header.
app.set('trust proxy', 'loopback');
// Small, dependency-free response hardening that is safe for both the local
// app and the HTTPS deployment. A full CSP belongs to the browser lane because
// it must be verified against the live frontend before enforcement.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.path === '/api' || req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// There is no multipart middleware in this backend. The browser upload
// contract therefore uses strict JSON base64, with a request ceiling that is
// large enough for one 8 MiB image plus base64/JSON overhead but still bounded
// before route code runs.
app.use(express.json({ limit: MAX_MEDIA_UPLOAD_REQUEST_BYTES }));
app.use(cookieParser());
// Apply the boundary before any route-specific authentication. This prevents
// the no-auth local preview from turning a cross-site POST into a destructive
// action and ensures every API route checks the request Host against the
// process configuration instead of deriving trust from that Host value.
app.use((req, res, next) => {
  if (!(req.path === '/api' || req.path.startsWith('/api/'))) return next();
  if (rejectRequestBoundary(req, res)) return;
  return next();
});
app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err instanceof SyntaxError)) {
    return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid media upload' });
  }
  return next(err);
});

// ---------- auth: cookie sessions + bearer API keys, one middleware ----------

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Reads the session, enforcing the rolling TTL: an expired row is deleted on
// the spot (not left for the sweep — no reason to trust a session that just
// failed its own check) and treated as no session. A session that's still
// valid gets last_seen_at bumped, but only once per SESSION_TOUCH_INTERVAL_MS
// — the common case (another request minutes later) is a read, not a write.
function legacySharedPasswordMode() {
  return !MIAOS_SINGLE_USER_EMAIL && !!INSTANCE_PASSWORD && db.listUsers(conn).length === 0;
}

function credentialEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return '';
  const user = db.getUserByEmail(conn, normalized);
  if (user) {
    if (user.disabled) return '';
    if (MIAOS_SINGLE_USER_EMAIL && normalized !== MIAOS_SINGLE_USER_EMAIL) return '';
    return String(user.email || normalized).trim().toLowerCase();
  }
  if (!legacySharedPasswordMode()) return '';
  const domain = normalized.split('@').pop() || '';
  return ALLOWED_DOMAINS.includes(domain) ? normalized : '';
}

function sessionFromCookie(req, { touch = true } = {}) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = db.getSession(conn, token);
  if (!session) return null;
  const email = credentialEmail(session.email);
  if (!email) {
    db.deleteSession(conn, token);
    return null;
  }
  session.email = email;
  const lastSeenMs = Date.parse(session.lastSeenAt || session.createdAt);
  const now = Date.now();
  if (now - lastSeenMs > SESSION_TTL_MS) {
    db.deleteSession(conn, token);
    return null;
  }

  if (touch && now - lastSeenMs > SESSION_TOUCH_INTERVAL_MS) {
    db.touchSession(conn, token, new Date(now).toISOString());
  }
  return session;
}

function emailFromBearer(req, { touch = true } = {}) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(mia_\S+)$/.exec(header);
  if (!match) return null;
  const record = db.findApiKeyByHash(conn, hashApiKey(match[1]));
  if (!record || !record.active) return null;
  const email = credentialEmail(record.ownerEmail);
  if (!email) return null;
  if (touch) db.touchApiKey(conn, record.id);
  return email;
}

function isWildcardBindHost(value) {
  return value === '' || value === '0.0.0.0' || value === '::' || value === '[::]';
}

function isLoopbackBindHost(value) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(value || '').toLowerCase());
}

function configuredBindHostname(value) {
  const raw = String(value || '').trim();
  if (!raw || isWildcardBindHost(raw)) return null;
  const candidate = raw.includes(':') && !(raw.startsWith('[') && raw.endsWith(']'))
    ? `[${raw}]`
    : raw;
  let parsed;
  try { parsed = new URL(`http://${candidate}`); } catch (_error) {
    throw new Error('MIAOS_BIND_HOST must be a valid hostname or IP address');
  }
  if (parsed.port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('MIAOS_BIND_HOST must be a hostname or IP address without a port');
  }
  return parsed.hostname.toLowerCase();
}

function originForBoundHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host.includes(':') ? `[${host}]` : host;
}

const MIAOS_TRUSTED_ORIGINS = new Set();
const MIAOS_TRUSTED_HOSTS = new Set();
function addTrustedOrigin(origin) {
  const normalized = String(origin || '').trim().toLowerCase();
  if (!normalized) return;
  MIAOS_TRUSTED_ORIGINS.add(normalized);
  MIAOS_TRUSTED_HOSTS.add(new URL(normalized).host);
}

if (MIAOS_CONFIGURED_ORIGIN) addTrustedOrigin(MIAOS_CONFIGURED_ORIGIN);

const configuredBindHostnameValue = configuredBindHostname(MIAOS_BIND_HOST);
if (isWildcardBindHost(MIAOS_BIND_HOST) || isLoopbackBindHost(MIAOS_BIND_HOST)) {
  addTrustedOrigin(`http://127.0.0.1:${PORT}`);
  addTrustedOrigin(`http://localhost:${PORT}`);
  addTrustedOrigin(`http://[::1]:${PORT}`);
} else if (configuredBindHostnameValue) {
  addTrustedOrigin(`http://${originForBoundHostname(configuredBindHostnameValue)}:${PORT}`);
}

if (MIAOS_TRUSTED_ORIGINS.size === 0) {
  throw new Error('Mia requires a configured origin or a concrete bound host before serving requests');
}

function requestHeader(request, name) {
  const headers = request && request.headers ? request.headers : {};
  return headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
}

function normalizedRequestHost(request) {
  const raw = String(requestHeader(request, 'host') || '').trim();
  if (!raw || raw.length > 255 || /[\r\n]/.test(raw)) {
    return { code: 'missing_host', message: 'A Host header matching the bound Mia origin is required.' };
  }
  let parsed;
  try { parsed = new URL(`http://${raw}`); } catch (_error) {
    return { code: 'invalid_host', message: 'The request Host is not a valid Mia host.' };
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || parsed.host.toLowerCase() !== raw.toLowerCase()) {
    return { code: 'invalid_host', message: 'The request Host is not a valid Mia host.' };
  }
  if (!MIAOS_TRUSTED_HOSTS.has(parsed.host.toLowerCase())) {
    return { code: 'invalid_host', message: 'The request Host is not an accepted Mia host.' };
  }
  return { host: parsed.host.toLowerCase() };
}

function normalizedRequestOrigin(request) {
  const raw = String(requestHeader(request, 'origin') || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch (_error) {
    return { code: 'invalid_origin', message: 'The request Origin is not a valid Mia origin.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { code: 'invalid_origin', message: 'The request Origin is not a valid Mia origin.' };
  }
  const origin = parsed.origin.toLowerCase();
  if (!MIAOS_TRUSTED_ORIGINS.has(origin)) {
    return { code: 'cross_site_request', message: 'Cross-site requests are not accepted by Mia.' };
  }
  return { origin, host: parsed.host.toLowerCase() };
}

function hasExplicitBearer(request) {
  return /^Bearer\s+mia_\S+$/.test(String(requestHeader(request, 'authorization') || ''));
}

function hasSessionCookie(request) {
  return String(requestHeader(request, 'cookie') || '').split(';').some((pair) => {
    const separator = pair.indexOf('=');
    return separator >= 0 && pair.slice(0, separator).trim() === SESSION_COOKIE;
  });
}

function allowsUnauthenticatedNoOrigin(request) {
  const method = String(request && request.method || '').toUpperCase();
  const pathname = String(request && (request.path || request.url || '') || '').split('?')[0];
  // These are explicit capability/authentication exchanges rather than
  // authenticated state mutations. They still require an accepted Host and
  // reject a supplied foreign Origin.
  return method === 'POST' && (
    pathname === '/api/login'
    || pathname === '/api/clerk/session'
    || /^\/api\/invite\/[^/]+\/accept$/.test(pathname)
    || pathname === '/api/desktop/auth'
  );
}

function requestBoundaryError(request, { websocket = false } = {}) {
  const host = normalizedRequestHost(request);
  if (host.code) return host;

  const origin = normalizedRequestOrigin(request);
  if (origin && origin.code) return origin;
  if (origin && origin.host !== host.host) {
    return {
      code: 'origin_host_mismatch',
      message: 'The request Origin must match the accepted Mia Host for this connection.',
    };
  }

  const fetchSite = String(requestHeader(request, 'sec-fetch-site') || '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    return { code: 'cross_site_request', message: 'Cross-site requests are not accepted by Mia.' };
  }

  const method = String(request && request.method || '').toUpperCase();
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if ((unsafe || websocket) && !origin && !hasExplicitBearer(request) && !hasSessionCookie(request)
    && !allowsUnauthenticatedNoOrigin(request)) {
    return {
      code: 'origin_required',
      message: websocket
        ? 'A browser WebSocket must send a trusted Origin; non-browser clients must use an explicit Mia API key or session.'
        : 'Unsafe browser requests require a trusted Origin; non-browser clients must use an explicit Mia API key or session.',
    };
  }
  return null;
}

function rejectRequestBoundary(request, response, options) {
  const error = requestBoundaryError(request, options);
  if (!error) return false;
  response.status(403).json({ error: error.code, message: error.message });
  return true;
}

// Accepts either a cookie session or a bearer key; attaches req.userEmail and,
// for cookie sessions only, req.session (used to persist chat history).
function requireAuth(req, res, next) {
  if (MIAOS_NO_AUTH) {
    req.session = null;
    req.userEmail = DEFAULT_OWNER;
    return next();
  }
  const session = sessionFromCookie(req);
  if (session) {
    req.session = session;
    req.userEmail = session.email;
    return next();
  }
  const email = emailFromBearer(req);
  if (email) {
    req.session = null;
    req.userEmail = email;
    return next();
  }
  return res.status(401).json({ error: 'unauthorized' });
}

// Key management is cookie-session only — a leaked bearer key should never be
// able to mint or revoke other keys.
function requireSessionAuth(req, res, next) {
  const session = sessionFromCookie(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.session = session;
  req.userEmail = session.email;
  next();
}

// Cookie-backed actions that change user-owned state require a human browser
// session. API keys remain useful for Mia automation but cannot perform them.
function requireInteractiveAuth(req, res, next) {
  if (MIAOS_NO_AUTH) {
    req.session = null;
    req.userEmail = DEFAULT_OWNER;
    return next();
  }
  return requireSessionAuth(req, res, next);
}

// The loopback-only no-auth preview has an owner identity even when its fresh
// database has no users row yet. Keep that escape hatch local to the preview:
// normal deployments and preview requests for a disabled/member row still
// use the database-backed admin policy unchanged.
const requireDatabaseAdmin = adminModule.requireAdmin(conn);
function requireMiaAdmin(req, res, next) {
  const owner = String(DEFAULT_OWNER || '').toLowerCase();
  const caller = String(req.userEmail || '').trim().toLowerCase();
  if (MIAOS_NO_AUTH && owner && caller === owner && !db.getUserByEmail(conn, caller)) {
    req.adminUser = { email: DEFAULT_OWNER, role: 'admin', disabled: false };
    return next();
  }
  return requireDatabaseAdmin(req, res, next);
}

function nativeConversationPrincipal(email, workspaceId = DEFAULT_WORKSPACE_ID) {
  const principalId = String(email || '').trim().toLowerCase();
  return {
    companyId: nativeCompanyId(workspaceId, principalId),
    principalId,
    principalType: 'user',
  };
}

function workspaceIdFromUpgrade(request) {
  try {
    const url = new URL(request && request.url || '/', 'http://miaos.invalid');
    return workspaceIdFromRequest({ headers: request && request.headers, query: { workspace: url.searchParams.get('workspace') } });
  } catch (_error) {
    return DEFAULT_WORKSPACE_ID;
  }
}

function sessionTokenFromUpgrade(request) {
  const cookieHeader = request && request.headers ? request.headers.cookie : '';
  for (const pair of String(cookieHeader || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function authenticateNativeConversationWebSocket(request, { touchCredentials = true } = {}) {
  if (requestBoundaryError(request, { websocket: true })) return null;
  const workspaceId = workspaceIdFromUpgrade(request);
  if (MIAOS_NO_AUTH) return nativeConversationPrincipal(DEFAULT_OWNER, workspaceId);
  const token = sessionTokenFromUpgrade(request);
  if (token) {
    const session = sessionFromCookie(
      { cookies: { [SESSION_COOKIE]: token } },
      { touch: touchCredentials }
    );
    if (session) return nativeConversationPrincipal(session.email, workspaceId);
  }
  const email = emailFromBearer(request, { touch: touchCredentials });
  return email ? nativeConversationPrincipal(email, workspaceId) : null;
}

function startSession(req, res, email) {
  const token = db.createSession(conn, email);
  // Only real (users-table) rows have a login timestamp to bump — legacy
  // shared-password logins have no row at all.
  if (db.getUserByEmail(conn, email)) db.touchLastLogin(conn, email, new Date().toISOString());
  // Secure only when the request itself came in over HTTPS — in prod that's
  // every request ('trust proxy' above lets req.secure read Caddy's
  // X-Forwarded-Proto), while direct-http local test scripts (curl against
  // 127.0.0.1:PORT, no proxy hop) still get a non-Secure cookie so
  // cookie-jar-based test runs keep working. NOT res.cookie's `secure:
  // 'auto'` — res.cookie has no auto mode (that's cookie-session); any
  // truthy value there just hard-enables Secure.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  return res.status(200).json({ ok: true, email });
}

function clerkAccountProfile() {
  if (!MIAOS_CLERK_AUTH) return null;
  const subject = String(db.getMeta(conn, CLERK_SUBJECT_META_KEY) || '').trim();
  if (!subject) return null;
  const issuer = String(db.getMeta(conn, CLERK_ISSUER_META_KEY) || '').trim() || CLERK_LEGACY_LINK_ISSUER;
  return {
    subject,
    issuer,
    email: String(db.getMeta(conn, CLERK_EMAIL_META_KEY) || '').trim().toLowerCase(),
    displayName: String(db.getMeta(conn, CLERK_NAME_META_KEY) || '').trim() || null,
  };
}

app.post('/api/clerk/session', async (req, res) => {
  if (!MIAOS_CLERK_AUTH || !CLERK_PUBLISHABLE_KEY || !CLERK_JWT_KEY) {
    return res.status(404).json({ error: 'not_found' });
  }
  const match = /^Bearer\s+([^\s]+)$/.exec(String(req.get('authorization') || ''));
  if (!match) return res.status(401).json({ error: 'clerk_token_missing' });

  const verification = clerkVerifyOptions(match[1], {
    jwtKey: CLERK_JWT_KEY,
    requestOrigin: req.get('origin'),
    trustedOrigins: MIAOS_TRUSTED_ORIGINS,
  });
  if (verification.error) return res.status(401).json({ error: verification.error });
  let claims;
  try {
    claims = await verifyClerkToken(match[1], verification.options);
  } catch (_error) {
    return res.status(401).json({ error: 'clerk_token_invalid' });
  }
  if (verification.native && claims && claims.azp !== undefined) {
    return res.status(401).json({ error: 'clerk_token_invalid' });
  }
  const profile = clerkClaimsProfile(claims, CLERK_ISSUER);
  if (profile.error === 'clerk_token_invalid') return res.status(401).json({ error: profile.error });
  if (profile.error) return res.status(422).json({ error: profile.error });
  const { primaryEmail, displayName } = profile;

  const previous = clerkAccountProfile();
  // Clerk instances are separate user stores, so a link made on another
  // instance (e.g. test before production became the default) cannot match
  // this subject. The operator chose the instance; relink on first sign-in.
  const relink = Boolean(previous && previous.issuer !== CLERK_ISSUER);
  const linked = relink ? null : previous;
  if (linked && linked.subject !== claims.sub) {
    return res.status(409).json({ error: 'clerk_installation_already_linked' });
  }
  if (!linked) db.setMeta(conn, CLERK_SUBJECT_META_KEY, claims.sub);
  db.setMeta(conn, CLERK_ISSUER_META_KEY, CLERK_ISSUER);
  db.setMeta(conn, CLERK_EMAIL_META_KEY, primaryEmail);
  if (displayName) db.setMeta(conn, CLERK_NAME_META_KEY, displayName);
  else if (relink) db.setMeta(conn, CLERK_NAME_META_KEY, '');

  const localUser = db.getUserByEmail(conn, LOCAL_PROFILE_PRINCIPAL);
  if (localUser && displayName && (!localUser.displayName || localUser.displayName === 'Local user')) {
    db.updateUserProfile(conn, LOCAL_PROFILE_PRINCIPAL, {
      displayName,
      initials: displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'LU',
    });
  }
  db.appendAuditLog(conn, {
    actor: LOCAL_PROFILE_PRINCIPAL,
    action: linked ? 'clerk.login' : (relink ? 'clerk.installation.relink' : 'clerk.installation.link'),
    target: LOCAL_PROFILE_PRINCIPAL,
  });
  const token = db.createSession(conn, LOCAL_PROFILE_PRINCIPAL);
  db.touchLastLogin(conn, LOCAL_PROFILE_PRINCIPAL, new Date().toISOString());
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  // Auto-provision a managed-router key in the background on first sign-in,
  // authorized by the user's own verified Clerk token. This runs after the
  // response so the user sees the app immediately.
  if (MANAGED_ROUTER_URL) {
    rememberManagedRouterToken(primaryEmail, match[1]);
    void autoProvisionManagedRouter(primaryEmail, match[1]);
  }

  return res.status(200).json({ ok: true, email: primaryEmail });
});

// ---------- auth routes ----------
// Per-user auth when a users table is populated (migrated from users.json);
// otherwise legacy shared-password mode, exactly as the old server behaved.

app.post('/api/login', adminModule.loginRateLimit, (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'domain' });
  }

  const normalizedEmail = email.toLowerCase();
  if (MIAOS_SINGLE_USER_EMAIL && normalizedEmail !== MIAOS_SINGLE_USER_EMAIL) {
    return res.status(400).json({ ok: false, error: 'domain' });
  }

  const users = db.listUsers(conn);
  const user = users.find((candidate) => candidate.email.toLowerCase() === normalizedEmail);
  if (user) {
    if (user.disabled) {
      db.appendAuditLog(conn, { actor: user.email, action: 'login.failure', target: user.email, detail: { reason: 'disabled' } });
      return res.status(401).json({ ok: false, error: 'password' });
    }
    if (!verifyPassword(password, user.password)) {
      db.appendAuditLog(conn, { actor: email.toLowerCase(), action: 'login.failure', target: user.email, detail: { reason: 'password' } });
      return res.status(401).json({ ok: false, error: 'password' });
    }
    db.appendAuditLog(conn, { actor: user.email, action: 'login.success', target: user.email });
    return startSession(req, res, user.email);
  }

  if (MIAOS_SINGLE_USER_EMAIL) {
    if (!INSTANCE_PASSWORD || password !== INSTANCE_PASSWORD) {
      return res.status(401).json({ ok: false, error: 'password' });
    }
    db.createUser(conn, {
      email: MIAOS_SINGLE_USER_EMAIL,
      passwordHash: adminModule.hashPassword(password),
      role: 'admin',
    });
    db.appendAuditLog(conn, {
      actor: MIAOS_SINGLE_USER_EMAIL,
      action: 'admin.bootstrap.single_user',
      target: MIAOS_SINGLE_USER_EMAIL,
    });
    return startSession(req, res, MIAOS_SINGLE_USER_EMAIL);
  }

  if (MIAOS_TEAM_SEARCH) {
    // A fresh team release has one exact, configured bootstrap identity. Do
    // not let the legacy shared password mint the first account for an
    // arbitrary allowed-domain email; after this row exists the normal
    // users-table path below permanently disables that fallback.
    if (users.length || normalizedEmail !== TEAM_RELEASE_BOOTSTRAP_EMAIL) {
      return res.status(400).json({ ok: false, error: 'domain' });
    }
    if (!INSTANCE_PASSWORD || password !== INSTANCE_PASSWORD) {
      return res.status(401).json({ ok: false, error: 'password' });
    }
    db.createUser(conn, {
      email: TEAM_RELEASE_BOOTSTRAP_EMAIL,
      passwordHash: adminModule.hashPassword(password),
      role: 'admin',
    });
    db.appendAuditLog(conn, {
      actor: TEAM_RELEASE_BOOTSTRAP_EMAIL,
      action: 'admin.bootstrap.team_search',
      target: TEAM_RELEASE_BOOTSTRAP_EMAIL,
    });
    return startSession(req, res, TEAM_RELEASE_BOOTSTRAP_EMAIL);
  }

  if (users.length) return res.status(400).json({ ok: false, error: 'domain' });

  const domain = email.split('@').pop().toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    return res.status(400).json({ ok: false, error: 'domain' });
  }
  if (!INSTANCE_PASSWORD || password !== INSTANCE_PASSWORD) return res.status(401).json({ ok: false, error: 'password' });
  // Legacy shared-password mode only ever applies while the users table is
  // empty (see the startup log next to bootstrapAdmins above) — the moment a
  // real user row exists, INSTANCE_PASSWORD stops being honored entirely.
  return startSession(req, res, email);
});

// These routers expose `/conversations/...` and `/workspaces/...` routes, but
// are mounted at `/api` so their existing route paths remain unchanged. Keep
// authentication scoped to those prefixes: a broad `/api` auth middleware
// would intercept public callbacks and metadata routes registered below this
// point (invites and instance identity).
function requireAuthForApiPrefix(prefix) {
  const normalizedPrefix = `/${String(prefix || '').replace(/^\/+|\/+$/g, '')}`;
  return (req, res, next) => {
    const requestPath = req.path || '/';
    if (requestPath === normalizedPrefix || requestPath.startsWith(`${normalizedPrefix}/`)) {
      return requireAuth(req, res, next);
    }
    return next();
  };
}

app.use('/api', requireAuthForApiPrefix('/conversations'), createConversationRouter({
  service: nativeConversationService,
  attachmentStore: nativeConversationAttachmentStore,
  resolvePrincipal: (req) => nativeConversationPrincipal(req.userEmail, workspaceIdFromRequest(req)),
}));

// Backend-first multiplayer slice. The existing workspace switcher is not an
// authorization boundary here: every route resolves the workspace from its
// resource path and verifies durable membership inside the service.
app.use('/api', requireAuthForApiPrefix('/workspaces'), createWorkspaceArtifactRouter({
  service: workspaceArtifactService,
  requireInteractive: requireInteractiveAuth,
  resolvePrincipal: (req) => ({
    principalId: String(req.userEmail || '').trim().toLowerCase(),
    principalType: 'user',
  }),
}));

// ---------- invites (public: no auth) ----------

app.use('/api/invite', adminModule.createInviteRouter({ conn, startSession }));

// ---------- instance identity (unauthenticated) ----------
// Public branding and local-preview state are sufficient before login. Keep
// configured login domains behind authenticated administration APIs.

app.get('/api/instance', (req, res) => {
  res.status(200).json({
    name: INSTANCE_NAME,
    localPreview: MIAOS_NO_AUTH,
    auth: MIAOS_CLERK_AUTH ? {
      provider: 'clerk',
      publishableKey: CLERK_PUBLISHABLE_KEY,
      frontendApi: CLERK_ISSUER,
    } : null,
    // Present only when this deployment offers a managed router; the label is
    // deployment branding for the onboarding card.
    managedRouter: MANAGED_ROUTER_URL ? { label: MANAGED_ROUTER_LABEL } : null,
  });
});

function isLoopbackRequest(req) {
  const address = String(req.socket && req.socket.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

// Development diagnostics are intentionally narrower than normal API auth:
// they are exposed only by the explicit no-auth localhost preview and only to
// a loopback socket. A production/reverse-proxy deployment cannot turn this
// into a remote command or trace surface.
function requireLocalDevelopment(req, res, next) {
  if (!MIAOS_NO_AUTH || !isLoopbackRequest(req)) return res.status(404).json({ error: 'not found' });
  return next();
}

function cleanSlateConfirmationBinding(req, owner) {
  const sessionToken = req.cookies && req.cookies[SESSION_COOKIE];
  if (sessionToken) return `session:${hashApiKey(sessionToken)}`;
  return `local:${String(owner || '').trim().toLowerCase()}`;
}

function issueCleanSlateConfirmation(req, owner) {
  const now = Date.now();
  for (const [digest, entry] of cleanSlateConfirmations) {
    if (!entry || entry.expiresAt <= now) cleanSlateConfirmations.delete(digest);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + CLEAN_SLATE_CONFIRMATION_TTL_MS;
  cleanSlateConfirmations.set(hashApiKey(token), {
    owner: String(owner || '').trim().toLowerCase(),
    binding: cleanSlateConfirmationBinding(req, owner),
    expiresAt,
  });
  return { token, expiresAt };
}

function consumeCleanSlateConfirmation(req, owner, token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 256) {
    return { ok: false, code: 'clean_slate_confirmation_required' };
  }
  const digest = hashApiKey(token);
  const entry = cleanSlateConfirmations.get(digest);
  // Consume a matching token before checking its binding. A capability must
  // never be reusable, even after a failed replay from a different session.
  if (entry) cleanSlateConfirmations.delete(digest);
  const normalizedOwner = String(owner || '').trim().toLowerCase();
  if (!entry || entry.expiresAt <= Date.now()
    || entry.owner !== normalizedOwner
    || entry.binding !== cleanSlateConfirmationBinding(req, owner)) {
    return { ok: false, code: 'clean_slate_confirmation_invalid' };
  }
  return { ok: true };
}

app.get('/api/dev/diagnostics', requireLocalDevelopment, (_req, res) => {
  res.status(200).json({ diagnostics: getHermesDiagnostics() });
});

app.post('/api/dev/diagnostics', requireLocalDevelopment, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.verboseHermes !== undefined && typeof body.verboseHermes !== 'boolean') {
    return res.status(400).json({ error: 'verboseHermes must be boolean' });
  }
  if (body.traceCommands !== undefined && typeof body.traceCommands !== 'boolean') {
    return res.status(400).json({ error: 'traceCommands must be boolean' });
  }
  return res.status(200).json({ diagnostics: setHermesDiagnostics(body) });
});

app.post('/api/dev/clean-slate/confirmation', requireLocalDevelopment, requireAuth, (req, res) => {
  if (workspaceIdFromRequest(req) !== 'solo') {
    return res.status(409).json({ error: 'clean_slate_requires_solo', message: 'Switch to Solo before requesting a clean-slate confirmation.' });
  }
  const owner = String(req.userEmail || '').trim().toLowerCase();
  const confirmation = issueCleanSlateConfirmation(req, owner);
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({
    confirmationToken: confirmation.token,
    expiresAt: new Date(confirmation.expiresAt).toISOString(),
  });
});

// Clean slate is not clean while Hermes still holds the old provider, key,
// and sessions: a DeepSeek key stored under the OpenAI slot survived a "clean"
// reset and every resumed conversation kept dispatching to api.openai.com.
// Best effort per step; failures are reported, never hidden, and never abort
// the Mia-side reset that already happened.
async function resetHermesForOwner(owner, storedGatewaySessionIds) {
  const result = { disconnectedProviders: [], deletedSessions: 0, gatewayRestarted: false, failures: [] };

  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  let settingsChanged = false;
  if (settings.harnessByUser && typeof settings.harnessByUser === 'object' && settings.harnessByUser[owner]) {
    delete settings.harnessByUser[owner];
    settingsChanged = true;
  }
  if (settings.instructionsByUser && typeof settings.instructionsByUser === 'object' && settings.instructionsByUser[owner]) {
    delete settings.instructionsByUser[owner];
    settingsChanged = true;
  }
  if (settingsChanged) db.saveSingleton(conn, 'settings', settings);

  let connectedProviders = [];
  try {
    const payload = await getHermesGatewayModelOptions({ refresh: true });
    connectedProviders = (payload && Array.isArray(payload.providers) ? payload.providers : [])
      .map((provider) => String(provider && provider.id || '').trim().toLowerCase())
      .filter((id) => HERMES_DISCONNECT_PROVIDERS.has(id));
  } catch (error) {
    result.failures.push(`inventory: ${error.message}`);
  }
  for (const provider of connectedProviders) {
    disconnectHermesAuth(owner, provider);
    try {
      await runHermesLogout(provider);
      hermesDisconnectedProviders.add(provider);
      result.disconnectedProviders.push(provider);
    } catch (error) {
      result.failures.push(`${provider}: ${error.message}`);
    }
  }
  nativeChatModelProviders = {};

  try {
    await closeHermesGatewaySessions();
    result.deletedSessions = await deleteHermesGatewaySessions(storedGatewaySessionIds);
  } catch (error) {
    result.failures.push(`sessions: ${error.message}`);
  }
  // Files are clean now; the running gateway still holds the old pool and
  // agents in memory. Restart the one Mia owns so nothing survives in RAM.
  try {
    result.gatewayRestarted = await restartHermesGatewayRuntime();
  } catch (error) {
    result.gatewayRestarted = false;
    result.failures.push(`gateway restart: ${error.message}`);
  }
  return result;
}

// Everything-scope reset: the Hermes home is treated as a Mia-managed
// installation, so every credential goes, whoever added it, and every stored
// session, memory, cron job, and log with it. Files are wiped only while the
// owned gateway is stopped; an external gateway is never adopted, so its
// state.db is left alone and the caller is told.
async function resetHermesEverything() {
  const result = {
    disconnectedProviders: [], deletedSessions: 0, gatewayRestarted: false,
    homeReset: false, failures: [],
  };
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  settings.harnessByUser = {};
  settings.instructionsByUser = {};
  db.saveSingleton(conn, 'settings', settings);
  for (const owner of Array.from(harnessAuthByUser.keys())) {
    const entry = harnessAuthByUser.get(owner);
    if (entry && entry.provider) disconnectHermesAuth(owner, entry.provider);
  }
  harnessAuthByUser.clear();

  const hermesHome = String(process.env.HERMES_HOME || '').trim();
  const providers = listHermesCredentialProviders(hermesHome);
  for (const provider of providers) {
    try {
      await runHermesLogout(provider);
      result.disconnectedProviders.push(provider);
    } catch (error) {
      // The auth files are removed below regardless; report so the caller
      // knows the CLI did not acknowledge this one.
      result.failures.push(`${provider}: ${error.message}`);
    }
  }

  let ownedGatewayStopped = false;
  try {
    await closeHermesGatewaySessions();
    ownedGatewayStopped = await stopHermesGatewayRuntime();
  } catch (error) {
    result.failures.push(`gateway stop: ${error.message}`);
  }
  if (ownedGatewayStopped || !hermesGatewayLooksAlive()) {
    const home = resetHermesHome(hermesHome);
    result.homeReset = home.failures.length === 0;
    home.failures.forEach((failure) => result.failures.push(`home: ${failure}`));
    try {
      provisionHermesRuntimeProfiles();
    } catch (error) {
      result.failures.push(`profiles: ${error.message}`);
    }
  } else {
    result.failures.push('home: an external Hermes gateway is running; its state.db was not wiped');
  }

  nativeChatModelProviders = {};
  hermesDisconnectedProviders.clear();
  try {
    result.gatewayRestarted = await startHermesGatewayRuntime();
  } catch (error) {
    result.failures.push(`gateway start: ${error.message}`);
  }
  return result;
}

function hermesGatewayLooksAlive() {
  const tokenFile = String(process.env.MIAOS_HERMES_GATEWAY_TOKEN_FILE || '').trim();
  if (!tokenFile) return false;
  const hermesHome = String(process.env.HERMES_HOME || '').trim();
  const ledger = path.join(hermesHome, 'spawn-ledger.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(ledger, 'utf8')); } catch (_) { return false; }
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const pid = Number(entry && entry.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  });
}

function removeDirectoryContents(dir, failures) {
  const root = String(dir || '').trim();
  if (!root) return 0;
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (error) {
    if (error.code !== 'ENOENT') failures.push(`${root}: ${error.message}`);
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failures.push(`${path.join(root, name)}: ${error.message}`);
    }
  }
  return removed;
}

// Mia-side wipe for the everything scope: every table that holds user or
// agent state, for every owner and workspace, plus the blob directories
// behind them. The caller's own user row and session survive so the reset
// can be reported back; local-profile provisioning would recreate the user
// anyway on the next boot.
function wipeMiaDataForEverything({ keepEmail, keepSessionToken }) {
  const failures = [];
  const companies = conn.prepare('SELECT DISTINCT company_id AS id FROM conversations').all().map((row) => row.id);
  let conversations = 0;
  const attachments = [];
  for (const companyId of companies) {
    const cleared = nativeConversationRepository.deleteCompanyData({ companyId });
    conversations += cleared.conversations;
    attachments.push(...cleared.attachments);
  }
  const wipe = conn.transaction(() => {
    for (const table of ['bots', 'agents', 'department_rooms', 'dm_rooms', 'trash']) {
      conn.prepare(`DELETE FROM ${table}`).run();
    }
    for (const table of [
      'room_human_memberships', 'agent_permissions', 'background_tasks', 'chat_history',
      'api_keys', 'google_gmail_connections', 'google_oauth_states', 'invites', 'audit_log',
      'deleted_users', 'workspace_artifact_versions', 'workspace_artifacts', 'workspace_members', 'workspaces',
    ]) {
      try { conn.prepare(`DELETE FROM ${table}`).run(); } catch (error) {
        if (!/no such table/i.test(error.message)) throw error;
      }
    }
    conn.prepare("DELETE FROM meta WHERE key LIKE 'departments:%'").run();
    db.saveSingleton(conn, 'settings', { ...DEFAULT_SETTINGS, harnessByUser: {}, instructionsByUser: {} });
    if (keepSessionToken) conn.prepare('DELETE FROM sessions WHERE token <> ?').run(keepSessionToken);
    else conn.prepare('DELETE FROM sessions').run();
    if (keepEmail) conn.prepare('DELETE FROM users WHERE LOWER(email) <> ?').run(keepEmail);
  });
  wipe();
  const directories = {
    attachments: removeDirectoryContents(NATIVE_ATTACHMENT_DIR, failures),
    workspaceArtifacts: removeDirectoryContents(WORKSPACE_ARTIFACT_DIR, failures),
    automationArtifacts: removeDirectoryContents(process.env.MIAOS_AUTOMATION_ARTIFACT_DIR, failures),
  };
  return { conversations, attachments, directories, failures };
}

app.post('/api/dev/clean-slate', requireLocalDevelopment, requireAuth, async (req, res) => {
  if (workspaceIdFromRequest(req) !== 'solo') {
    return res.status(409).json({ error: 'clean_slate_requires_solo', message: 'Switch to Solo before resetting the workspace.' });
  }

  const owner = String(req.userEmail || '').trim().toLowerCase();
  const confirmation = consumeCleanSlateConfirmation(req, owner, req.body && req.body.confirmationToken);
  if (!confirmation.ok) {
    const message = confirmation.code === 'clean_slate_confirmation_required'
      ? 'Request a fresh clean-slate confirmation from the Mia UI.'
      : 'The clean-slate confirmation is expired, already used, or bound to another Mia session. Confirm again in the Mia UI.';
    return res.status(confirmation.code === 'clean_slate_confirmation_required' ? 400 : 403).json({
      error: confirmation.code,
      message,
    });
  }
  const scope = req.body && req.body.scope === 'everything' ? 'everything' : 'solo';
  const companyId = nativeCompanyId('solo', owner);
  const targetBots = scope === 'everything'
    ? db.loadAll(conn, 'bots')
    : db.loadAll(conn, 'bots').filter((bot) => sameOwner(bot, owner) && workspaceIdForRecord(bot) === 'solo');

  // A bot must not disappear while its recurring job survives. Fail before
  // touching SQLite when the scheduler cannot confirm removal; retrying is
  // safe because removing an already-removed job is idempotent.
  try {
    for (const bot of targetBots) await cronSync.removeBotCron(bot);
  } catch (error) {
    console.error('clean slate: automation removal failed', error.message);
    return res.status(503).json({ error: 'automation_cleanup_failed' });
  }

  const activeDispatchIds = (scope === 'everything'
    ? conn.prepare("SELECT id FROM conversation_dispatches WHERE status IN ('pending', 'claimed')").all()
    : conn.prepare(
      "SELECT id FROM conversation_dispatches WHERE company_id = ? AND status IN ('pending', 'claimed')"
    ).all(companyId)
  ).map((row) => row.id);
  activeDispatchIds.forEach((dispatchId) => {
    const controller = nativeDispatchAbortControllers.get(dispatchId);
    if (controller && !controller.signal.aborted) controller.abort();
  });

  if (scope === 'everything') {
    const wiped = wipeMiaDataForEverything({
      keepEmail: owner,
      keepSessionToken: req.cookies && req.cookies[SESSION_COOKIE] || null,
    });
    let attachmentCleanupFailures = 0;
    for (const attachment of wiped.attachments) {
      try {
        await nativeConversationAttachmentStore.removeAttachmentObject(attachment.storagePath);
      } catch (_) {
        // The whole attachment directory is emptied below; a missing object is fine.
        attachmentCleanupFailures += 1;
      }
    }
    const hermes = await resetHermesEverything();
    agentExamplesCache.clear();
    cleanSlateConfirmations.clear();
    bumpVersion();
    return res.status(200).json({
      ok: true,
      scope,
      deleted: {
        bots: targetBots.length,
        conversations: wiped.conversations,
        attachments: wiped.attachments.length - attachmentCleanupFailures,
        legacyRooms: 0,
        directories: wiped.directories,
        hermesSessions: hermes.deletedSessions,
        hermesProviders: hermes.disconnectedProviders,
      },
      hermesHomeReset: hermes.homeReset,
      gatewayRestarted: hermes.gatewayRestarted,
      attachmentCleanupFailures,
      hermesFailures: hermes.failures.concat(wiped.failures),
    });
  }

  // Hermes rows outlive Mia's conversations and pin the provider, model, and
  // API key each one was created with. Collect their ids before the Mia rows
  // go so the reset can delete them too.
  const storedGatewaySessionIds = nativeConversationRepository
    .listConversations({ companyId, includeDeleted: true, limit: 1000 })
    .map((conversation) => conversation.metadata && conversation.metadata.hermesGatewaySessionId)
    .filter(Boolean);
  const legacySoloRooms = ['department_rooms', 'dm_rooms'].flatMap((table) =>
    db.loadAll(conn, table)
      .filter((record) => sameOwner(record, owner) && workspaceIdForRecord(record) === 'solo')
      .map((record) => ({ table, id: record.id }))
  );
  const cleared = nativeConversationRepository.deleteCompanyData({ companyId });
  const deleteSoloDocuments = conn.transaction(() => {
    targetBots.forEach((bot) => db.deleteOne(conn, 'bots', bot.id));
    legacySoloRooms.forEach((record) => db.deleteOne(conn, record.table, record.id));
    db.setMeta(conn, departmentsMetaKey(owner, 'solo'), '[]');
  });
  deleteSoloDocuments();

  let attachmentCleanupFailures = 0;
  for (const attachment of cleared.attachments) {
    try {
      await nativeConversationAttachmentStore.removeAttachmentObject(attachment.storagePath);
    } catch (error) {
      attachmentCleanupFailures += 1;
      console.error('clean slate: attachment cleanup failed', attachment.id, error.message);
    }
  }

  const hermes = await resetHermesForOwner(owner, storedGatewaySessionIds);

  agentExamplesCache.clear();
  bumpVersion();
  return res.status(200).json({
    ok: true,
    scope,
    deleted: {
      bots: targetBots.length,
      conversations: cleared.conversations,
      attachments: cleared.attachments.length - attachmentCleanupFailures,
      legacyRooms: legacySoloRooms.length,
      hermesSessions: hermes.deletedSessions,
      hermesProviders: hermes.disconnectedProviders,
    },
    attachmentCleanupFailures,
    hermesFailures: hermes.failures,
  });
});

// A user row's role='admin' is the source of truth once one exists; the
// env ADMIN_EMAILS allowlist (isAdmin()) is only the fallback for
// MIAOS_NO_AUTH / legacy shared-password sessions that have no row to read.
function effectiveRole(email, user) {
  if (user) return user.role || 'member';
  return isAdmin(email) ? 'admin' : 'member';
}

app.get('/api/me', (req, res) => {
  if (MIAOS_NO_AUTH) {
    const user = db.listUsers(conn).find((u) => u.email.toLowerCase() === DEFAULT_OWNER.toLowerCase());
    const role = effectiveRole(DEFAULT_OWNER, user);
    return res.status(200).json({
      email: DEFAULT_OWNER,
      // The local no-auth preview has no session to hydrate, but it should
      // still represent the real owner rather than a synthetic Preview user.
      displayName: (user && user.displayName) || null,
      initials: (user && user.initials) || null,
      role,
      isAdmin: role === 'admin',
      ...(MIAOS_LOCAL_PROFILE ? { localProfile: true } : {}),
    });
  }
  const session = sessionFromCookie(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  const user = db.listUsers(conn).find((u) => u.email.toLowerCase() === session.email.toLowerCase());
  const clerkProfile = session.email === LOCAL_PROFILE_PRINCIPAL ? clerkAccountProfile() : null;
  const role = effectiveRole(session.email, user);
  return res.status(200).json({
    email: session.email,
    ...(clerkProfile ? { accountEmail: clerkProfile.email } : {}),
    displayName: preferredName(user && user.displayName) || (clerkProfile && clerkProfile.displayName) || null,
    initials: (user && user.initials) || null,
    role,
    isAdmin: role === 'admin',
    ...(clerkProfile ? { clerk: true } : {}),
  });
});

// Authenticated human directory for native DMs, mentions, and the people
// picker. This is an application-owned projection, not an external room or agent
// directory: only active users on a configured instance domain are exposed,
// and the caller is never returned to themself.
function humanDirectoryUsersForWorkspace(users, caller, workspaceId) {
  if (workspaceId !== DEFAULT_WORKSPACE_ID) return [];
  const normalizedCaller = String(caller || '').trim().toLowerCase();
  return (users || [])
    .map((user) => ({
      email: String(user.email || '').trim(),
      displayName: user.displayName || null,
      initials: user.initials || null,
    }))
    .filter((user) => user.email.toLowerCase() !== normalizedCaller);
}

app.get('/api/users', requireAuth, (req, res) => {
  const caller = String(req.userEmail || '').trim().toLowerCase();
  const users = humanDirectoryUsersForWorkspace(activeWorkspaceUsers(), caller, workspaceIdFromRequest(req));
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ users });
});

// Self-service profile edit: display name + initials, editable by each user
// in the Settings drawer. 409s in legacy shared-password mode where the
// caller has no row in `users` yet (nothing to attach the profile to).
app.put('/api/me', requireAuth, (req, res) => {
  const { displayName, initials } = req.body || {};
  const patch = {};

  if (displayName !== undefined) {
    if (typeof displayName !== 'string') return res.status(400).json({ error: 'displayName must be a string' });
    const trimmed = displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      return res.status(400).json({ error: 'displayName must be 1-80 characters' });
    }
    patch.displayName = trimmed;
  }

  if (initials !== undefined) {
    if (typeof initials !== 'string') return res.status(400).json({ error: 'initials must be a string' });
    const trimmed = initials.trim();
    if (trimmed.length < 1 || trimmed.length > 3 || !/^[a-zA-Z0-9]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'initials must be 1-3 letters/digits' });
    }
    patch.initials = trimmed.toUpperCase();
  }

  const updated = db.updateUserProfile(conn, req.userEmail, patch);
  if (!updated) return res.status(409).json({ error: 'no user record' });
  bumpVersion();

  const user = db.listUsers(conn).find((u) => u.email.toLowerCase() === req.userEmail.toLowerCase());
  return res.status(200).json({
    email: req.userEmail,
    displayName: (user && user.displayName) || null,
    initials: (user && user.initials) || null,
    ...(MIAOS_LOCAL_PROFILE ? { localProfile: true } : {}),
  });
});

function onboardingKey(owner) { return `mia.onboarding.chat:${owner}`; }
function onboardingState(owner) {
  try { return JSON.parse(db.getMeta(conn, onboardingKey(owner)) || 'null'); }
  catch (_) { return null; }
}

// Only the authenticated owner's private Mia conversation can receive this
// exchange. State and events use the existing local database and transaction.
app.post('/api/onboarding/chat', requireAuth, (req, res) => {
  const principal = nativeConversationPrincipal(req.userEmail, 'solo');
  const owner = principal.principalId;
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  if (!harnessPreferenceForUser(settings, owner).onboardingComplete) {
    return res.status(409).json({ error: 'Connect your AI before starting with Mia.' });
  }
  const published = [];
  const body = req.body || {};
  if (body.action && onboardingNewsInFlight.has(owner)) return res.status(409).json({error:'Your briefing is still being created.'});
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const result = conn.transaction(() => {
    let state = onboardingState(owner);
    const explicitNameReply = /^(?:please )?(?:call me|my name is|i['’]d like(?: you to call me)?|i prefer)\s+/i.test(text);
    if (state && state.phase === 'done' && !explicitNameReply && body.action !== 'start-news') return { ...state, handled: false };
    let conversation = state && nativeConversationRepository.getConversation({
      companyId: principal.companyId, id: state.conversationId, includeDeleted: true,
    });
    if (conversation && conversation.deletedAt) {
      state = { ...state, phase: 'done' };
      db.setMeta(conn, onboardingKey(owner), JSON.stringify(state));
      return { ...state, handled: false };
    }
    if (!conversation) conversation = nativeConversationRepository.listGatewayConversations({
      companyId: principal.companyId, createdBy: owner,
    })[0] || nativeConversationService.createConversation({
      companyId: principal.companyId, principal, type: 'agent', name: 'Mia',
      metadata: { agentId: 'gateway', source: 'onboarding', workspaceId: 'solo' },
    });
    function append(text, human = false) {
      const created = nativeConversationRepository.createEvent({
        companyId: principal.companyId, conversationId: conversation.id,
        senderId: human ? owner : 'gateway', senderType: human ? 'user' : 'agent',
        type: human ? 'message' : 'agent_message', content: { text },
        metadata: { onboarding: true },
      });
      published.push(created.event);
    }
    if (!state) {
      const user = db.getUserByEmail(conn, owner);
      const account = owner === LOCAL_PROFILE_PRINCIPAL ? clerkAccountProfile() : null;
      const name = preferredName(user && user.displayName) || preferredName(account && account.displayName);
      state = { conversationId: conversation.id, phase: 'name', suggestedName: name };
      append(openingMessage(name));
    }
    let handled = false;
    if (body.action === 'start-news' && state.phase === 'done' && !state.newsBotId) {
      state.phase = 'topics';
      append(NEWS_INTRO);
      handled = true;
    } else if (body.action === 'skip-news' && ['topics', 'schedule'].includes(state.phase)) {
      state.phase = 'done';
      append('No problem. What would you like a hand with today?');
      handled = true;
    } else if (body.action === 'edit-topics' && state.phase === 'schedule' && !state.newsBotId) {
      state.phase = 'topics';
      append(NEWS_INTRO);
      handled = true;
    } else if (body.action === 'topics' && ['topics', 'schedule'].includes(state.phase)) {
      const topics = Array.isArray(body.topics) ? [...new Set(body.topics.map(value => String(value).trim()).filter(Boolean))] : [];
      if (!topics.length || topics.length > 8 || topics.some(value => value.length > 120)) return { ...state, error: 'Choose up to eight topics, each under 120 characters.' };
      state.topics = topics;
      state.phase = 'schedule';
      append(topics.join(', '), true);
      append('When would you like your briefing? Choose a schedule, time, and time zone.');
      handled = true;
    } else if (body.action === 'finish-news' && state.phase === 'news-created') {
      state.phase = 'done';
      append('You’re all set. Find your briefing anytime under Tools → Automations. What would you like to work on now?');
      handled = true;
    } else if (text && (state.phase === 'name' || explicitNameReply)) {
      const answer = nameAnswer(text, state.suggestedName);
      handled = !answer.passthrough;
      if (handled) append(text, true);
      if (answer.askName) {
        state.suggestedName = '';
        append('What should I call you? You can say “Call me…” or skip for now.');
      } else {
        if (answer.name) {
          const initials = answer.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]).join('').toUpperCase();
          if (!db.updateUserProfile(conn, owner, { displayName: answer.name, initials })) {
            throw new Error('Could not save your preferred name.');
          }
          state.preferredName = answer.name;
        }
        if (handled) state.phase = 'topics';
        if (handled) append((answer.name ? `Nice to meet you, ${answer.name}. ` : '') + NEWS_INTRO);
      }
    }
    db.setMeta(conn, onboardingKey(owner), JSON.stringify(state));
    return { ...state, handled };
  })();
  published.forEach((event) => nativeConversationRealtime.publish(event));
  if (published.length) bumpVersion();
  return res.json(result);
});

const onboardingNewsInFlight = new Set();
app.post('/api/onboarding/news', requireAuth, async (req, res) => {
  const principal = nativeConversationPrincipal(req.userEmail, 'solo');
  const owner = principal.principalId;
  if (onboardingNewsInFlight.has(owner)) return res.status(409).json({error: 'Your briefing is still being created.'});
  onboardingNewsInFlight.add(owner);
  let pendingRecord;
  try {
    let state = onboardingState(owner);
    if (state && state.newsBotId && ['news-created', 'done'].includes(state.phase)) return res.json(state);
    if (!state || state.phase !== 'schedule') return res.status(409).json({error: 'Choose your news topics first.'});
    const automation = newsBriefing({...req.body, topics: state.topics});
    const selection = await chatModelSelectionForUser(req.body.modelSelection, req.userEmail);
    if (!selection || !selection.model) return res.status(409).json({error: 'Choose a connected model before creating your briefing.'});
    if (!state.newsBotId && db.loadAll(conn, 'bots').length >= MAX_BOTS) return res.status(409).json({error: 'Bot limit reached.'});
    state.newsBotId = state.newsBotId || `bot-${crypto.randomUUID()}`;
    db.setMeta(conn, onboardingKey(owner), JSON.stringify(state));
    const existing = db.loadAll(conn, 'bots').find(bot => bot.id === state.newsBotId);
    const record = {...existing, id: state.newsBotId, name: 'News briefing', owner, workspaceId: 'solo',
      instructions: 'Research reliable current news and produce concise briefings with source links.',
      model: selection.model, modelProvider: selection.provider, avatarColor: '#60a5fa',
      status: 'draft', replyAlways: false, createdAt: existing && existing.createdAt || new Date().toISOString(),
      automations: [{...automation, deliveryConversationId: state.conversationId, deliveryCompanyId: principal.companyId}],
    };
    db.saveOne(conn, 'bots', record.id, record);
    pendingRecord = record;
    await ensureNativeBotConversation(record);
    await syncBotAutomationWithInstructions(record);
    if (!record.hermesCronJobIds || !record.hermesCronJobIds[automation.id]) throw new Error('The scheduler did not confirm your briefing. Please retry.');
    record.status = 'running';
    const event = conn.transaction(() => {
      db.saveOne(conn, 'bots', record.id, record);
      state = {...state, phase: 'news-created', newsAutomationId: automation.id};
      db.setMeta(conn, onboardingKey(owner), JSON.stringify(state));
      return nativeConversationRepository.createEvent({companyId: principal.companyId, conversationId: state.conversationId,
        senderId: 'gateway', senderType: 'agent', type: 'agent_message',
        content: {text: 'Your news briefing is ready. Let me show you where to find it and how to change or stop it.'}, metadata: {onboarding: true}}).event;
    })();
    nativeConversationRealtime.publish(event);
    bumpVersion();
    return res.json(state);
  } catch (error) {
    if (pendingRecord) {
      pendingRecord.status = 'draft';
      pendingRecord.automations.forEach(automation => { automation.enabled = false; });
      db.saveOne(conn, 'bots', pendingRecord.id, pendingRecord);
      try { await cronSync.removeBotCron(pendingRecord); }
      catch (_) { return res.status(503).json({error:'The scheduler could not finish or cancel setup. Open Automations to check the briefing before retrying.'}); }
    }
    return res.status(400).json({error: error.message || 'Could not create your briefing. Please retry.'});
  } finally { onboardingNewsInFlight.delete(owner); }
});

// Polled by the frontend every few seconds to detect changes made by this
// session or any other logged-in session (new/renamed/deleted agents,
// department edits, conversation changes, profile edits) without a reload.
// Dirt cheap on purpose: just the in-memory counter, no DB hit.
app.get('/api/state/version', requireAuth, (req, res) => {
  res.status(200).json({ version: stateVersion });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) db.deleteSession(conn, token);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return res.status(200).json({ ok: true });
});

// ---------- health ----------
// UNAUTHENTICATED on purpose: a local health check has no session cookie
// and no API key, and this is the one endpoint that must still answer when
// everything else is broken (e.g. sessions table gone). Nothing below leaks
// anything an outside prober shouldn't see — no version strings, hostnames,
// paths, or emails, just booleans/counts.
//
// Native conversation readiness and reconnect contract.
app.get('/healthz', (req, res) => {
  let dbOk = false;
  try {
    conn.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const ok = dbOk;
  return res.status(ok ? 200 : 503).json({
    ok,
    db: dbOk,
    inference: inferenceStats(),
    uptime: Math.round(process.uptime()),
  });
});

// ---------- bearer API key management (session-only) ----------

app.post('/api/keys', requireSessionAuth, (req, res) => {
  const { name } = req.body || {};
  const raw = `mia_${crypto.randomBytes(24).toString('hex')}`;
  const prefix = raw.slice(0, 12);
  const keyName = typeof name === 'string' && name.trim() ? name.trim() : 'unnamed key';
  db.createApiKey(conn, {
    id: crypto.randomUUID(),
    name: keyName,
    keyHash: hashApiKey(raw),
    keyPrefix: prefix,
    ownerEmail: req.userEmail,
  });
  return res.status(201).json({ key: raw, prefix, name: keyName });
});

app.get('/api/keys', requireSessionAuth, (req, res) => {
  return res.status(200).json({ keys: db.listApiKeys(conn, req.userEmail) });
});

app.delete('/api/keys/:id', requireSessionAuth, (req, res) => {
  const revoked = db.revokeApiKey(conn, req.params.id, req.userEmail);
  if (!revoked) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ ok: true });
});

// Bot records and their conversations are one native data model. A
// conversation is provisioned lazily here as well as during boot so bots
// created by the admin/API surface are immediately addressable in chat.
function nativeBotConversation(bot, includeDeleted = false) {
  return canonicalBotConversationCandidates(nativeBotConversations(bot, includeDeleted))[0] || null;
}

function nativeBotConversations(bot, includeDeleted = false) {
  if (!bot || !bot.id) return [];
  const companyId = nativeCompanyId(workspaceIdForRecord(bot), ownerOf(bot));
  return nativeConversationRepository
    .listConversations({ companyId, includeDeleted, limit: 1000 })
    .filter((conversation) => {
      const metadata = conversation.metadata && typeof conversation.metadata === 'object'
        ? conversation.metadata : {};
      return conversation.type === 'bot'
        && metadata.botId === bot.id;
    })
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
}

function nativeMiaOwners() {
  return Array.from(new Set([
    DEFAULT_OWNER,
    ...db.listUsers(conn).map((user) => user.email),
    ...db.loadAll(conn, 'bots').map((bot) => ownerOf(bot)),
  ].map((email) => String(email || '').trim().toLowerCase()).filter(Boolean)));
}

// Mia is not a user-created bot. There is one manager conversation per
// owner/workspace, and the oldest active record is canonical so legacy
// history remains attached to the conversation users already know.
function reconcileNativeMiaConversations() {
  const workspaceIds = [DEFAULT_WORKSPACE_ID, 'solo'];
  for (const owner of nativeMiaOwners()) {
    for (const workspaceId of workspaceIds) {
      const companyId = nativeCompanyId(workspaceId, owner);
      try {
        const candidates = nativeConversationRepository.listGatewayConversations({ companyId, createdBy: owner });
        if (!candidates.length) continue;
        let canonical = candidates[0];
        for (const duplicate of candidates.slice(1)) {
          const merged = nativeConversationRepository.mergeConversations({
            companyId,
            targetId: canonical.id,
            sourceId: duplicate.id,
            mergedAt: new Date().toISOString(),
          });
          canonical = merged.conversation;
          console.log(`native Mia reconciliation: merged ${duplicate.id} into ${canonical.id} (${merged.mergedEvents} events)`);
        }
        const metadata = canonical.metadata && typeof canonical.metadata === 'object'
          ? { ...canonical.metadata }
          : {};
        metadata.agentId = 'gateway';
        metadata.departments = Array.isArray(metadata.departments) ? metadata.departments : [];
        metadata.workspaceId = workspaceId;
        if (!metadata.source) metadata.source = 'native-ui';
        const metadataChanged = JSON.stringify(metadata) !== JSON.stringify(canonical.metadata || {});
        if (canonical.name !== 'Mia' || metadataChanged) {
          nativeConversationRepository.updateConversation({
            companyId,
            id: canonical.id,
            name: 'Mia',
            metadata,
            updatedAt: canonical.updatedAt,
          });
        }
        for (const member of nativeConversationRepository.listMembers({
          companyId,
          conversationId: canonical.id,
          includeRemoved: false,
        })) {
          const isOwner = member.principalType === 'user'
            && String(member.principalId).toLowerCase() === owner;
          const isBoundAgent = member.principalType === 'agent'
            && member.principalId === GATEWAY_AGENT_ID;
          if (!isOwner && !isBoundAgent) {
            nativeConversationRepository.removeMember({
              companyId,
              conversationId: canonical.id,
              principalId: member.principalId,
              principalType: member.principalType,
            });
          }
        }
      } catch (err) {
        console.error(`native Mia reconciliation failed for ${companyId}`, err.message);
      }
    }
  }
}

async function ensureNativeBotConversation(bot) {
  if (!bot || !bot.id) return null;
  const owner = ownerOf(bot);
  if (!isActiveWorkspaceUser(owner)) return null;
  const workspaceId = workspaceIdForRecord(bot);
  const companyId = nativeCompanyId(workspaceId, owner);
  const existing = nativeBotConversation(bot);
  const metadata = {
    ...(existing && existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
    botId: bot.id,
    departments: departmentsOf(bot),
    workspaceId,
    source: 'native-bot-provisioning',
  };
  delete metadata.agentId;
  const conversation = existing
    ? nativeConversationRepository.updateConversation({
      companyId,
      id: existing.id,
      name: bot.name,
      metadata,
      updatedAt: new Date().toISOString(),
    })
    : nativeConversationService.createConversation({
      companyId,
      principal: nativeConversationPrincipal(owner, workspaceId),
      type: 'bot',
      name: bot.name,
      metadata,
    });
  const expectedUsers = workspaceId === DEFAULT_WORKSPACE_ID
    ? activeWorkspaceUsers()
    : activeWorkspaceUsers().filter((user) => String(user.email || '').toLowerCase() === owner);
  const expectedUserEmails = new Set(expectedUsers.map((user) => String(user.email || '').toLowerCase()));
  for (const user of expectedUsers) {
    nativeConversationRepository.addMember({
      companyId,
      conversationId: conversation.id,
      principalId: user.email,
      principalType: 'user',
      role: user.email.toLowerCase() === owner ? 'owner' : 'member',
      state: 'active',
      metadata: { workspaceId },
    });
  }
  for (const member of nativeConversationRepository.listMembers({
    companyId,
    conversationId: conversation.id,
    includeRemoved: false,
  })) {
    const removeAgent = member.principalType === 'agent';
    const removeStaleUser = member.principalType === 'user'
      && !expectedUserEmails.has(String(member.principalId || '').toLowerCase());
    if (removeAgent || removeStaleUser) {
      nativeConversationRepository.removeMember({
        companyId,
        conversationId: conversation.id,
        principalId: member.principalId,
        principalType: member.principalType,
      });
    }
  }
  cronSync.migrateBotAutomations(bot);
  const needsAutomationDestination = bot.automations.some((automation) =>
    automation.deliveryConversationId !== conversation.id
      || automation.deliveryCompanyId !== conversation.companyId
  );
  if (needsAutomationDestination) {
    bot.automations = bot.automations.map((automation) => ({
      ...automation,
      deliveryConversationId: conversation.id,
      deliveryCompanyId: conversation.companyId,
    }));
    bot.updatedAt = new Date().toISOString();
    db.saveOne(conn, 'bots', bot.id, bot);
  }
  return conversation;
}

async function reconcileNativeBotConversations() {
  for (const bot of db.loadAll(conn, 'bots')) {
    try {
      const candidates = canonicalBotConversationCandidates(nativeBotConversations(bot));
      if (candidates.length > 1) {
        let canonical = candidates[0];
        for (const duplicate of candidates.slice(1)) {
          const merged = nativeConversationRepository.mergeConversations({
            companyId: canonical.companyId,
            targetId: canonical.id,
            sourceId: duplicate.id,
            mergedAt: new Date().toISOString(),
          });
          canonical = merged.conversation;
          console.log(`native bot reconciliation: merged ${duplicate.id} into ${canonical.id} (${merged.mergedEvents} events)`);
        }
      }
      await ensureNativeBotConversation(bot);
    } catch (err) {
      console.error('native bot conversation reconcile failed', bot.id, err.message);
    }
  }
}

// ---------- resource CRUD factory ----------

function registerResource(cfg) {
  const base = `/api/${cfg.path}`;
  const project = cfg.listProjection || ((record) => record);

  app.get(base, requireAuth, (req, res) => {
    let records = db.loadAll(conn, cfg.table);
    if (cfg.listFilter) records = records.filter((record) => cfg.listFilter(record, req));
    if (cfg.sort) records = records.slice().sort(cfg.sort);
    res.status(200).json({ [cfg.plural]: records.map(project) });
  });

  // cfg.accessCheck(record, req), when it returns false, 404s rather than
  // 403s — a resource this caller doesn't own should read as not existing,
  // not as "exists but you can't have it".
  app.get(`${base}/:id`, requireAuth, (req, res) => {
    const record = db.loadOne(conn, cfg.table, req.params.id);
    if (!record) return res.status(404).json({ error: 'not_found' });
    if (cfg.accessCheck && !cfg.accessCheck(record, req)) return res.status(404).json({ error: 'not_found' });
    res.status(200).json({ [cfg.singular]: record });
  });

  // cfg.afterCreate(record) / cfg.afterUpdate(record, existing) are optional
  // async hooks that may return a replacement record (e.g. stamping on a
// conversation id) before it's saved and returned. cfg.beforeSave(record, req)
// runs first (synchronously) — its job is stamping ownership/identity
// fields before afterCreate does anything with them. Only
  // agents uses these today; every other resource ignores them, and a hook
  // throwing/rejecting never fails the request — the caller decides how to
  // degrade.
  if (cfg.allowCreate !== false) {
    app.post(base, requireAuth, async (req, res) => {
      const body = req.body || {};
      if (cfg.validate) {
        const error = cfg.validate(body);
        if (error) return res.status(400).json({ error });
      }
      const existing = db.loadAll(conn, cfg.table);
      if (cfg.maxRecords && existing.length >= cfg.maxRecords) {
        return res.status(409).json({ error: `${cfg.singular}_limit_reached`, limit: cfg.maxRecords });
      }
      const id = cfg.idGenerator(existing, body);
      let record;
      if (cfg.trackTimeline) {
        const now = new Date().toISOString();
        record = Object.assign({}, cfg.defaults, body, {
          id,
          createdAt: now,
          updatedAt: now,
          timeline: [{ ts: now, event: `${cfg.singular} created` }],
        });
      } else {
        record = Object.assign({}, body, { id });
      }
      if (cfg.beforeSave) cfg.beforeSave(record, req);
      // Reserve the id before any asynchronous provisioning hook. Creation
      // must fail on a collision instead of silently replacing an existing
      // document through the update-oriented saveOne helper.
      db.insertOne(conn, cfg.table, id, record);
      if (cfg.afterCreate) {
        try {
          record = (await cfg.afterCreate(record, req)) || record;
        } catch (err) {
          // External synchronization is best-effort. The primary agent record
          // must still be created when a scheduler is
          // unavailable; the next native chat refresh can expose the agent.
          console.error(`${cfg.singular}: afterCreate hook failed for`, record.id, err.message);
        }
      }
      db.saveOne(conn, cfg.table, id, record);
      if (cfg.bumpOnMutate) bumpVersion();
      res.status(201).json({ [cfg.singular]: record });
    });
  }

  app.put(`${base}/:id`, requireAuth, async (req, res) => {
    const existing = db.loadOne(conn, cfg.table, req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const writeAccessCheck = cfg.writeAccessCheck || cfg.accessCheck;
    if (writeAccessCheck && !writeAccessCheck(existing, req)) return res.status(404).json({ error: 'not_found' });

    const body = Object.assign({}, req.body || {});
    delete body.id;
    // Fields the client may never rewrite (ownership/identity stamps) — a
    // PUT body carrying them would otherwise merge straight onto the record,
    // e.g. re-homing an agent into another user's workspace.
    if (cfg.protectedFields) for (const f of cfg.protectedFields) delete body[f];
    let record;
    if (cfg.trackTimeline) {
      delete body.timeline;
      delete body.createdAt;
      const now = new Date().toISOString();
      record = Object.assign({}, existing, body, { updatedAt: now });
      record.timeline = Array.isArray(record.timeline) ? record.timeline : [];
      record.timeline.push({ ts: now, event: `${cfg.singular} updated` });
    } else {
      record = Object.assign({}, existing, body, { id: existing.id });
    }
    if (cfg.validate) {
      const error = cfg.validate(record);
      if (error) return res.status(400).json({ error });
    }
    let packageChange = null;
    let packageSaveAttempted = false;
    try {
      if (cfg.beforeUpdate) cfg.beforeUpdate(record, existing, req);
      if (cfg.prepareUpdate) packageChange = cfg.prepareUpdate(record, existing, req);
      if (cfg.afterUpdate) record = (await cfg.afterUpdate(record, existing)) || record;
      packageSaveAttempted = true;
      db.saveOne(conn, cfg.table, record.id, record, { botPackageChange: packageChange });
    } catch (error) {
      if (packageChange && !packageSaveAttempted) packageChange.rollback();
      if (error && error.statusCode) {
        return res.status(error.statusCode).json({ error: error.code || 'bot_package_error', message: error.message });
      }
      throw error;
    }
    if (cfg.afterPersistUpdate) {
      try {
        const started = JSON.parse(JSON.stringify(record));
        const synchronized = (await cfg.afterPersistUpdate(record, existing)) || record;
        const current = db.loadOne(conn, cfg.table, record.id);
        if (!current) return res.status(409).json({ error: 'not_found' });
        record = cfg.mergeAfterPersistUpdate
          ? cfg.mergeAfterPersistUpdate(current, synchronized, started)
          : synchronized;
        db.saveOne(conn, cfg.table, record.id, record);
      } catch (error) {
        console.error(`${cfg.singular}: afterPersistUpdate hook failed for`, record.id, error.message);
      }
    }
    record = db.loadOne(conn, cfg.table, record.id);
    if (cfg.bumpOnMutate) bumpVersion();
    res.status(200).json({ [cfg.singular]: record });
  });

  app.delete(`${base}/:id`, requireAuth, async (req, res) => {
    const removed = db.loadOne(conn, cfg.table, req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found' });
    const writeAccessCheck = cfg.writeAccessCheck || cfg.accessCheck;
    if (writeAccessCheck && !writeAccessCheck(removed, req)) return res.status(404).json({ error: 'not_found' });
    if (cfg.beforeDelete) {
      const blocked = cfg.beforeDelete(removed);
      if (blocked) return res.status(blocked.status || 400).json({ error: blocked.message });
    }
    if (cfg.afterDelete) {
      // Best-effort: a hook failure (e.g. the cron CLI being down) never
      // blocks the delete itself — the boot reconcile self-heals later.
      await cfg.afterDelete(removed).catch((err) =>
        console.error(`${cfg.singular}: afterDelete hook failed for`, removed.id, err.message)
      );
    }
    db.deleteOne(conn, cfg.table, req.params.id);
    db.moveToTrash(conn, cfg.singular, removed);
    if (cfg.bumpOnMutate) bumpVersion();
    res.status(200).json({ ok: true });
  });
}

// ---------- settings (key handling, guardrails, backup) ----------

const DEFAULT_SETTINGS = {
  guardrails: { allowedProviders: ['anthropic'] },
  lastBackup: null,
  // 'concise' (final reply only) or 'verbose' (working steps stream into the
  // transcript). Durable so the choice survives restarts and reinstalls.
  chatOutput: 'verbose',
  // The harness owns OAuth/API credentials. Mia keeps only each user's
  // product preference and workspace mode in the existing settings document.
  harnessByUser: {},
  // User-authored preferences are separate from app-owned safety and tool
  // policy. Agent instructions guide Mia/general agents; bot instructions
  // layer onto every bot's own brief.
  instructionsByUser: {},
  // Starter-bot template names the user dismissed from the sidebar. Stored
  // server-side so a dismissal survives desktop profile switches and
  // reinstalls (localStorage is per-Electron-profile and does not).
  hiddenStarterBots: [],
};
const MAX_GLOBAL_INSTRUCTIONS_LENGTH = 8000;

function normalizeInstructionSettings(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    agent: String(input.agent || '').trim().slice(0, MAX_GLOBAL_INSTRUCTIONS_LENGTH),
    bot: String(input.bot || '').trim().slice(0, MAX_GLOBAL_INSTRUCTIONS_LENGTH),
  };
}

function instructionSettingsForUser(settings, email) {
  const byUser = settings && settings.instructionsByUser && typeof settings.instructionsByUser === 'object'
    ? settings.instructionsByUser
    : {};
  return normalizeInstructionSettings(byUser[String(email || '').trim().toLowerCase()]);
}

function currentInstructionSettings(email) {
  return instructionSettingsForUser(db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS), email);
}

function syncBotAutomationWithInstructions(bot, existingJob, existingRegistry) {
  const owner = ownerOf(bot);
  const globalInstructions = currentInstructionSettings(owner).bot;
  return cronSync.syncBotAutomation(bot, existingJob, existingRegistry, { globalInstructions });
}
let runtimeApiKey = '';
function getApiKey() {
  return runtimeApiKey || process.env.ANTHROPIC_API_KEY || '';
}

// The Mia Router is the hosted ecosystem's managed provider: signing in
// mints a budget-capped router key for the user (see the managed-router
// auto-provision section below). The endpoint URL ships as the built-in
// default — it is only an API address; the caller's Clerk session token is
// the sole authorization and without one the endpoint does nothing. The
// service itself (minting, budgets, secrets) lives entirely in AWS, not in
// this repo. Forks may point these at their own service or leave the URL
// empty to hide the provider.
const MANAGED_ROUTER_URL = 'MIAOS_MANAGED_ROUTER_URL' in process.env
  ? String(process.env.MIAOS_MANAGED_ROUTER_URL || '').trim()
  : 'https://oiptiwgulndjf3nzjfvrhx7blq0eekdr.lambda-url.us-east-1.on.aws/';
const MANAGED_ROUTER_LABEL = String(process.env.MIAOS_MANAGED_ROUTER_LABEL || '').trim() || 'Mia Router';

const CLAUDE_SUBSCRIPTION_PROVIDER = 'claude-subscription-directsdk-experimental';
const HERMES_ONBOARDING_PROVIDERS = new Set([
  'managed-router', CLAUDE_SUBSCRIPTION_PROVIDER, 'openai-codex', 'xai-oauth', 'openai-api',
]);
const HERMES_ONBOARDING_MODES = new Set(['solo', 'multiplayer']);

// This is the API-key slice of Hermes' provider catalog. Subscription and
// machine-identity providers stay in their own flows: ChatGPT/Grok use OAuth,
// while Bedrock/Vertex/ACP require environment or process configuration that
// cannot be represented by a pasted API key. Keep these ids canonical for
// `hermes auth add`, `hermes auth status`, and Hermes session providers.
const HERMES_API_PROVIDER_CATALOG = Object.freeze([
  { id: 'managed-router', label: MANAGED_ROUTER_LABEL },
  { id: 'openai-api', label: 'OpenAI' },
  { id: 'xai', label: 'xAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'gemini', label: 'Google AI Studio' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'alibaba', label: 'Qwen Cloud' },
  { id: 'alibaba-coding-plan', label: 'Alibaba Cloud (Coding Plan)' },
  { id: 'openrouter', label: MANAGED_ROUTER_URL ? MANAGED_ROUTER_LABEL : 'OpenRouter' },
  { id: 'fireworks', label: 'Fireworks AI' },
  { id: 'novita', label: 'NovitaAI' },
  { id: 'lmstudio', label: 'LM Studio' },
  { id: 'nvidia', label: 'NVIDIA NIM' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'huggingface', label: 'Hugging Face' },
  { id: 'xiaomi', label: 'Xiaomi MiMo' },
  { id: 'tencent-tokenhub', label: 'Tencent TokenHub' },
  { id: 'zai', label: 'Z.AI / GLM' },
  { id: 'kimi-coding', label: 'Kimi / Kimi Coding Plan' },
  { id: 'kimi-coding-cn', label: 'Kimi / Moonshot (China)' },
  { id: 'stepfun', label: 'StepFun Step Plan' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'minimax-cn', label: 'MiniMax (China)' },
  { id: 'ollama-cloud', label: 'Ollama Cloud' },
  { id: 'arcee', label: 'Arcee AI' },
  { id: 'gmi', label: 'GMI Cloud' },
  { id: 'kilocode', label: 'Kilo Code' },
  { id: 'opencode-zen', label: 'OpenCode Zen' },
  { id: 'opencode-go', label: 'OpenCode Go' },
  { id: 'azure-foundry', label: 'Azure Foundry' },
  { id: 'ai-gateway', label: 'Vercel AI Gateway' },
  { id: 'deepinfra', label: 'DeepInfra' },
  { id: 'upstage', label: 'Upstage Solar' },
]);
const HERMES_API_KEY_PROVIDERS = new Set(HERMES_API_PROVIDER_CATALOG.map(({ id }) => id));
const HERMES_API_PROVIDER_LABELS = Object.freeze(Object.fromEntries(
  HERMES_API_PROVIDER_CATALOG.map(({ id, label }) => [id, label])
));

function normalizeHermesApiProvider(value) {
  const input = String(value || '').trim().toLowerCase();
  // Older Mia settings used `openai`; accept it on read and migrate it to
  // Hermes' canonical `openai-api` id when the preference is next saved.
  // managed-router is the product-facing name that maps to openrouter at
  // runtime (mia-router is its pre-rename spelling, accepted on read).
  if (input === 'managed-router' || input === 'mia-router') return 'openrouter';
  const provider = input === 'openai' ? 'openai-api' : input;
  return HERMES_API_KEY_PROVIDERS.has(provider) ? provider : null;
}

function normalizeHarnessPreference(value) {
  const input = value && typeof value === 'object' ? value : {};
  const provider = HERMES_ONBOARDING_PROVIDERS.has(String(input.provider || '').trim())
    ? String(input.provider).trim()
    : null;
  const apiProvider = normalizeHermesApiProvider(input.apiProvider) || 'openai-api';
  const mode = HERMES_ONBOARDING_MODES.has(String(input.mode || '').trim())
    ? String(input.mode).trim()
    : 'solo';
  const modelSelection = provider && provider !== 'openai-api'
    ? normalizeHermesModelSelection(provider, input.model, input.fast === true || input.model === 'fast')
    : { model: null, fast: false };
  return {
    provider,
    apiProvider: provider === 'openai-api' ? apiProvider : null,
    model: modelSelection.model,
    fast: modelSelection.fast,
    mode,
    onboardingComplete: Boolean(provider && input.onboardingComplete === true),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  };
}

function harnessPreferenceForUser(settings, email) {
  const byUser = settings && settings.harnessByUser && typeof settings.harnessByUser === 'object'
    ? settings.harnessByUser
    : {};
  return normalizeHarnessPreference(byUser[String(email || '').trim().toLowerCase()]);
}

function harnessProviderDisconnectedForUser(settings, email, provider) {
  const byUser = settings && settings.harnessDisconnectedByUser && typeof settings.harnessDisconnectedByUser === 'object'
    ? settings.harnessDisconnectedByUser
    : {};
  const providers = byUser[String(email || '').trim().toLowerCase()];
  return Array.isArray(providers) && providers.includes(provider);
}

function setHarnessProviderDisconnected(email, provider, disconnected) {
  const owner = String(email || '').trim().toLowerCase();
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  if (!settings.harnessDisconnectedByUser || typeof settings.harnessDisconnectedByUser !== 'object') {
    settings.harnessDisconnectedByUser = {};
  }
  const providers = new Set(Array.isArray(settings.harnessDisconnectedByUser[owner])
    ? settings.harnessDisconnectedByUser[owner]
    : []);
  if (disconnected) providers.add(provider); else providers.delete(provider);
  settings.harnessDisconnectedByUser[owner] = Array.from(providers);
  const preference = settings.harnessByUser && settings.harnessByUser[owner];
  const selected = preference && (preference.provider === 'openai-api'
    ? preference.apiProvider
    : preference.provider);
  if (disconnected && selected === provider) {
    preference.onboardingComplete = false;
  }
  db.saveSingleton(conn, 'settings', settings);
}

// Providers the user connected through Mia (setup, Settings → Access or the
// picker's Connect links). Hermes can also report credentials that reached
// it some other way, for example a GitHub CLI login read as Copilot; only
// this record, the saved preference and the signed-in user's Mia Router
// make a provider selectable in the chat picker.
function harnessConnectedProvidersForUser(settings, email) {
  const byUser = settings && settings.harnessConnectedByUser && typeof settings.harnessConnectedByUser === 'object'
    ? settings.harnessConnectedByUser
    : {};
  const providers = byUser[String(email || '').trim().toLowerCase()];
  return Array.isArray(providers) ? providers.slice() : [];
}

function setHarnessProviderConnected(email, provider, connected) {
  const owner = String(email || '').trim().toLowerCase();
  const id = String(provider || '').trim().toLowerCase();
  if (!owner || !id) return;
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  if (!settings.harnessConnectedByUser || typeof settings.harnessConnectedByUser !== 'object') {
    settings.harnessConnectedByUser = {};
  }
  const providers = new Set(harnessConnectedProvidersForUser(settings, owner));
  if (connected) providers.add(id); else providers.delete(id);
  settings.harnessConnectedByUser[owner] = Array.from(providers);
  db.saveSingleton(conn, 'settings', settings);
}

// These are product-facing choices mapped to the provider names understood by
// the Hermes service. Credentials remain in Hermes; Mia only selects the
// provider route for the authenticated user's agent work.
const HERMES_CLI_PROVIDER_BY_ONBOARDING_PROVIDER = Object.freeze({
  [CLAUDE_SUBSCRIPTION_PROVIDER]: CLAUDE_SUBSCRIPTION_PROVIDER,
  'openai-codex': 'openai-codex',
  'xai-oauth': 'xai-oauth',
  'openai-api': 'openai-api',
  xai: 'xai',
});

// ---------- Managed-router auto-provision ----------
// A hosted deployment can point MIAOS_MANAGED_ROUTER_URL at an endpoint that
// mints a per-user router key. The only authorization the backend presents is
// the user's own verified Clerk session token — the endpoint verifies it
// again server-side and having an account IS the authorization; there is no
// static provisioning secret and no manual fallback. The minted key is
// injected into Hermes automatically; the user never sees or handles it.
const MANAGED_ROUTER_TIMEOUT_MS = 15000;

// In-memory set of emails that have already been provisioned in this backend
// lifetime. Avoids redundant mint calls on every Clerk token refresh.
const managedRouterProvisionedEmails = new Set();

// Clerk session tokens are short-lived (~60s). Cache the newest one per email
// at sign-in so provisioning triggered shortly afterwards (onboarding choice,
// admin re-provision) can still authenticate; anything later waits for the
// next sign-in.
const managedRouterClerkTokens = new Map();

function rememberManagedRouterToken(email, clerkToken) {
  if (!MANAGED_ROUTER_URL || !email || !clerkToken) return;
  managedRouterClerkTokens.set(email, { token: clerkToken, storedAt: Date.now() });
}

function freshManagedRouterToken(email) {
  const entry = managedRouterClerkTokens.get(email);
  if (!entry) return null;
  // Conservative: treat anything older than 45s as expired.
  if (Date.now() - entry.storedAt > 45000) {
    managedRouterClerkTokens.delete(email);
    return null;
  }
  return entry.token;
}

async function provisionManagedRouterKey(email, clerkToken) {
  if (!MANAGED_ROUTER_URL || !clerkToken) return null;
  if (managedRouterProvisionedEmails.has(email)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANAGED_ROUTER_TIMEOUT_MS);
  try {
    const response = await fetch(MANAGED_ROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clerkToken}`,
      },
      body: JSON.stringify({ action: 'provision' }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.key) {
      console.warn('[managed-router] provision failed for', email, result?.error || response.status);
      return null;
    }
    console.log('[managed-router] provisioned key for', email);
    return result.key;
  } catch (error) {
    console.warn('[managed-router] provision error for', email, error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ask OpenRouter whether a stored key is still live (GET /key is metadata
// only — no spend). Transient failures count as live: rotating a working key
// over a network blip would be worse than retrying on the next sign-in.
async function openRouterKeyIsLive(key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return false;
    if (response.ok) {
      const body = await response.json().catch(() => null);
      if (body?.data?.disabled === true) return false;
    }
    return true;
  } catch (_) {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// Make `key` the ONLY managed-router credential everywhere. The gateway must
// be down while auth stores change: a running gateway flushes its in-memory
// pool on shutdown, resurrecting exactly the dead keys being removed.
async function installManagedRouterKey(key) {
  try { await stopHermesGatewayRuntime(); } catch (_) { /* not running */ }
  removeProviderRootCredentials(process.env.HERMES_HOME, MANAGED_ROUTER_HERMES_PROVIDER);
  removeProviderProfileCredentials(process.env.HERMES_HOME, MANAGED_ROUTER_HERMES_PROVIDER);
  await runHermesApiKeyAdd(MANAGED_ROUTER_HERMES_PROVIDER, key);
  try { await startHermesGatewayRuntime(); } catch (_) { /* best effort */ }
}

async function autoProvisionManagedRouter(email, clerkToken, { force = false } = {}) {
  if (managedRouterProvisionedEmails.has(email)) return;
  try {
    // A mint rotates the user's key server-side (the endpoint cannot re-read
    // an existing key's secret), so never mint while a stored key still
    // works. The check is against the auth-store FILE, validated against
    // OpenRouter — never a gateway probe, which fails during boot and must
    // not be mistaken for "no key". Admin re-provision forces a rotation.
    if (!force) {
      const stored = readProviderRootCredentials(process.env.HERMES_HOME, MANAGED_ROUTER_HERMES_PROVIDER);
      let live = null;
      for (const candidate of stored.slice().reverse()) {
        if (await openRouterKeyIsLive(candidate)) { live = candidate; break; }
      }
      if (live) {
        // Prune to exactly the live key when dead siblings are in any pool —
        // auxiliary clients pick pool entries blindly and 401 on dead ones.
        if (stored.length > 1) {
          await installManagedRouterKey(live);
          console.log('[managed-router] pruned dead credentials for', email);
        }
        managedRouterProvisionedEmails.add(email);
        hermesDisconnectedProviders.delete(MANAGED_ROUTER_HERMES_PROVIDER);
        hermesDisconnectedProviders.delete('managed-router');
        return;
      }
      if (stored.length) console.log('[managed-router] stored key is dead for', email, '- re-provisioning');
    }
    const token = clerkToken || freshManagedRouterToken(email);
    if (!token) {
      console.log('[managed-router] no fresh Clerk token for', email, '- will provision on next sign-in');
      return;
    }
    const key = await provisionManagedRouterKey(email, token);
    if (!key) return;
    await installManagedRouterKey(key);
    managedRouterProvisionedEmails.add(email);
    managedRouterClerkTokens.delete(email);
    hermesDisconnectedProviders.delete(MANAGED_ROUTER_HERMES_PROVIDER);
    hermesDisconnectedProviders.delete('managed-router');
    console.log('[managed-router] auto-provisioned and connected for', email);
  } catch (error) {
    console.warn('[managed-router] auto-connect failed for', email, error.message);
  }
}

// Subscription sign-in belongs to Hermes. Mia starts Hermes' device flow
// for the selected provider and exposes only the URL, one-time code, and
// coarse lifecycle state; credentials never cross this process boundary.
const HERMES_AUTH_TIMEOUT_MS = 16 * 60 * 1000;
const HERMES_AUTH_PROMPT_WAIT_MS = 30 * 1000;
const HERMES_AUTH_OUTPUT_LIMIT = 32 * 1024;
const HERMES_AUTH_PROVIDERS = new Set([CLAUDE_SUBSCRIPTION_PROVIDER, 'openai-codex', 'xai-oauth']);
const HERMES_DISCONNECT_PROVIDERS = new Set([
  CLAUDE_SUBSCRIPTION_PROVIDER,
  'openai-codex',
  'xai-oauth',
  ...HERMES_API_KEY_PROVIDERS,
]);
const HERMES_STATUS_PROVIDERS = new Set([
  CLAUDE_SUBSCRIPTION_PROVIDER,
  'openai-codex',
  'xai-oauth',
  ...HERMES_API_KEY_PROVIDERS,
]);
let nativeChatModelProviders = {};
// Providers the user disconnected in this backend's lifetime. The gateway
// inventory cannot carry this signal: it also drops providers that are merely
// rate-limited or unreachable, so an empty inventory must never be read as
// "disconnected". A provider leaves this set when a key is added or a sign-in
// completes for it.
const hermesDisconnectedProviders = new Set();
const HERMES_LOGOUT_TIMEOUT_MS = 15 * 1000;
const HERMES_API_KEY_TIMEOUT_MS = 15 * 1000;
const HERMES_STATUS_TIMEOUT_MS = 10 * 1000;
const HERMES_STATUS_CONCURRENCY = 4;

async function boundedMap(items, limit, mapper) {
  const values = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      values[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => worker()
  ));
  return values;
}
const HERMES_AUTH_PROVIDER_LABELS = Object.freeze({
  [CLAUDE_SUBSCRIPTION_PROVIDER]: 'Claude Subscription',
  'openai-codex': 'ChatGPT',
  'xai-oauth': 'Grok',
  ...HERMES_API_PROVIDER_LABELS,
});
const harnessAuthByUser = new Map();

function stripTerminalControlSequences(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '');
}

function parseHermesAuthOutput(provider, value) {
  const text = stripTerminalControlSequences(value);
  let verificationUrl = null;
  let userCode = null;
  if (provider === 'openai-codex') {
    const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\b/);
    const code = text.match(/Enter this code:\s*([A-Z0-9][A-Z0-9-]{2,})/i);
    verificationUrl = url ? url[0] : null;
    userCode = code ? code[1] : null;
  } else if (provider === 'xai-oauth') {
    // Hermes prints the complete xAI device URL, followed by the optional
    // human-readable code. Keep the URL/code parser deliberately narrow so
    // no unrelated CLI output is exposed to the browser.
    const url = text.match(/https:\/\/(?:auth|accounts)\.x\.ai\/[^\s"'<>]+/i);
    const code = text.match(/enter code:\s*([A-Z0-9][A-Z0-9-]{2,})/i);
    verificationUrl = url ? url[0].replace(/[),.;]+$/, '') : null;
    userCode = code ? code[1] : null;
  } else if (provider === CLAUDE_SUBSCRIPTION_PROVIDER) {
    // Claude Code owns this PKCE flow. Mia only forwards the exact official
    // authorization URL printed by `claude auth login --claudeai`; query
    // parameters must remain intact for the CLI to validate the completion.
    // Require a delimiter after the query. Stream chunks may end halfway
    // through `state` or the PKCE challenge; publishing at buffer-end would
    // open a valid-looking but unusable truncated URL.
    const url = text.match(/https:\/\/(?:claude\.com\/cai|claude\.ai)\/oauth\/authorize\?[^\s"'<>]+(?=\s|["'<>])/i);
    verificationUrl = url ? url[0] : null;
  }
  return {
    verificationUrl,
    userCode,
  };
}

function publicHermesAuthState(entry) {
  if (!entry) return { state: 'idle', provider: null };
  return {
    state: entry.state,
    provider: entry.provider,
    verificationUrl: entry.verificationUrl || null,
    userCode: entry.userCode || null,
    startedAt: entry.startedAt || null,
    error: entry.state === 'error'
      ? `Could not complete ${HERMES_AUTH_PROVIDER_LABELS[entry.provider] || 'provider'} sign-in. Try again.`
      : null,
  };
}

const HERMES_CREDENTIAL_ENV_KEYS = Object.freeze([
  // Claude Code keys macOS credentials by OS username. Preserve the same
  // identity as hermesProcessEnv so login/status and inference share a store.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR',
  'HERMES_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'GH_CONFIG_DIR',
  // Windows process basics. The argv launch vector spawns python.exe
  // directly (no cmd.exe launcher), so the interpreter needs the standard
  // Windows locations plus the venv coordinates the .cmd shim used to set.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERPROFILE',
  'TEMP', 'TMP', 'USERNAME',
  'PYTHONPATH', 'PYTHONNOUSERSITE',
  'PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX',
  'CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND',
  'CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR',
]);

function runClaudeSubscriptionStatus() {
  return new Promise((resolve) => {
    const python = String(process.env.HERMES_PYTHON || '').trim();
    const pluginDir = path.join(__dirname, 'hermes-plugins', CLAUDE_SUBSCRIPTION_PROVIDER);
    if (!python) {
      resolve({ available: false, loggedIn: false, detail: 'The bundled Hermes Python runtime is unavailable.' });
      return;
    }
    execFile(
      python,
      [
        '-c',
        'import json,sys; sys.path.insert(0, sys.argv[1]); from directsdk_setup import setup_status; print(json.dumps(setup_status()))',
        pluginDir,
      ],
      {
        cwd: process.cwd(),
        env: hermesCredentialProcessEnv(),
        timeout: HERMES_STATUS_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
      },
      (error, stdout) => {
        let status = null;
        try { status = JSON.parse(String(stdout || '').trim()); } catch (_) { /* plugin probe failed */ }
        const loggedIn = !error && status && status.logged_in === true;
        resolve({
          available: Boolean(status && status.available === true),
          loggedIn,
          plan: loggedIn ? String(status.plan || '') : '',
          detail: loggedIn ? '' : String(status && status.detail || 'Could not inspect the Claude Code login.'),
        });
      }
    );
  });
}

function hermesCredentialProcessEnv(extra = {}) {
  const env = {};
  for (const key of HERMES_CREDENTIAL_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const isolatedHome = String(process.env.MIAOS_HERMES_PROCESS_HOME || '').trim();
  if (isolatedHome) {
    env.HOME = isolatedHome;
    // Windows resolves the home directory through USERPROFILE, not HOME.
    if (process.platform === 'win32') env.USERPROFILE = isolatedHome;
  }
  env.PATH = [MIAOS_HERMES_GUARD_BIN, env.PATH || ''].filter(Boolean).join(path.delimiter);
  return { ...env, ...extra };
}

// On Windows the Hermes CLI is not a directly spawnable binary; the desktop
// shell publishes an argv launch vector (interpreter + script) in
// MIAOS_HERMES_ARGV_JSON. spawnHermesCli/execFileHermesCli resolve that
// vector (falling back to HERMES_BIN) so every call site works on both forms.
function spawnHermesCli(args, options) {
  const launch = configuredHermesLaunch(HERMES_BIN);
  return spawn(launch.command, [...launch.prefixArgs, ...args], options);
}

function execFileHermesCli(args, options, callback) {
  const launch = configuredHermesLaunch(HERMES_BIN);
  return execFile(launch.command, [...launch.prefixArgs, ...args], options, callback);
}

function startHermesAuth(email, provider) {
  const owner = String(email || '').trim().toLowerCase();
  const existing = harnessAuthByUser.get(owner);
  if (existing && existing.provider === provider && ['starting', 'waiting'].includes(existing.state)) return existing;
  if (existing && existing.child && !existing.settled) {
    existing.settled = true;
    try { existing.child.kill('SIGTERM'); } catch (_) { /* process may already be gone */ }
  }

  const entry = {
    provider,
    state: 'starting',
    verificationUrl: null,
    userCode: null,
    startedAt: new Date().toISOString(),
    child: null,
    settled: false,
    output: '',
    timeout: null,
  };
  harnessAuthByUser.set(owner, entry);

  const finish = (state) => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = null;
    entry.child = null;
    entry.output = '';
    entry.state = state;
    if (state === 'connected') {
      hermesDisconnectedProviders.delete(provider);
      setHarnessProviderConnected(owner, provider, true);
    }
    const cleanup = setTimeout(() => {
      if (harnessAuthByUser.get(owner) === entry) harnessAuthByUser.delete(owner);
    }, 10 * 60 * 1000);
    cleanup.unref();
  };

  const read = (chunk) => {
    // Keep the buffer bounded and parse only the stable device-flow fields.
    // Never return or log the raw Hermes output: it can contain implementation
    // details that are not part of Mia' public contract.
    entry.output = (entry.output + String(chunk || '')).slice(-HERMES_AUTH_OUTPUT_LIMIT);
    const parsed = parseHermesAuthOutput(provider, entry.output);
    if (parsed.verificationUrl) entry.verificationUrl = parsed.verificationUrl;
    if (parsed.userCode) entry.userCode = parsed.userCode;
    if (entry.verificationUrl && entry.userCode && !entry.settled) {
      entry.state = 'waiting';
      entry.output = '';
    }
  };

  try {
    const child = spawnHermesCli(['auth', 'add', provider, '--type', 'oauth', '--no-browser'], {
      cwd: process.cwd(),
      // Hermes prints the device URL while its Python process is attached to
      // a pipe. Disable Python block buffering so the browser handoff gets
      // the prompt immediately instead of waiting for process exit.
      env: hermesCredentialProcessEnv({ PYTHONUNBUFFERED: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    entry.child = child;
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', () => finish('error'));
    child.once('close', (code) => finish(code === 0 ? 'connected' : 'error'));
    entry.timeout = setTimeout(() => {
      if (entry.settled) return;
      try { child.kill('SIGTERM'); } catch (_) { /* process may already be gone */ }
      finish('error');
    }, HERMES_AUTH_TIMEOUT_MS);
    entry.timeout.unref();
  } catch (_) {
    finish('error');
  }

  return entry;
}

function startClaudeSubscriptionAuth(email) {
  const provider = CLAUDE_SUBSCRIPTION_PROVIDER;
  const owner = String(email || '').trim().toLowerCase();
  const existing = harnessAuthByUser.get(owner);
  if (existing && existing.provider === provider && ['starting', 'waiting', 'completing'].includes(existing.state)) {
    return existing;
  }
  if (existing && existing.child && !existing.settled) disconnectHermesAuth(owner, existing.provider);

  const entry = {
    provider,
    state: 'starting',
    verificationUrl: null,
    userCode: null,
    startedAt: new Date().toISOString(),
    child: null,
    settled: false,
    completionSubmitted: false,
    output: '',
    timeout: null,
  };
  harnessAuthByUser.set(owner, entry);

  const finish = (state, { terminate = false } = {}) => {
    if (entry.settled) return;
    entry.settled = true;
    const child = entry.child;
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = null;
    if (terminate && child && child.exitCode === null) {
      try { child.kill('SIGTERM'); } catch (_) { /* process may already be gone */ }
    }
    entry.child = null;
    entry.output = '';
    entry.state = state;
    if (state === 'connected') {
      hermesDisconnectedProviders.delete(provider);
      setHarnessProviderConnected(owner, provider, true);
    }
    const cleanup = setTimeout(() => {
      if (harnessAuthByUser.get(owner) === entry) harnessAuthByUser.delete(owner);
    }, 10 * 60 * 1000);
    cleanup.unref();
  };
  const verifyCompletion = async (code) => {
    if (entry.settled) return;
    if (code !== 0) {
      finish('error');
      return;
    }
    entry.state = 'completing';
    const status = await runClaudeSubscriptionStatus();
    if (entry.settled) return;
    finish(status.loggedIn ? 'connected' : 'error');
  };
  const read = (chunk) => {
    // The raw CLI stream can contain one-time authorization material. Keep a
    // bounded private buffer and expose only the allowlisted official URL.
    entry.output = (entry.output + String(chunk || '')).slice(-HERMES_AUTH_OUTPUT_LIMIT);
    const parsed = parseHermesAuthOutput(provider, entry.output);
    if (parsed.verificationUrl) {
      entry.verificationUrl = parsed.verificationUrl;
      if (!entry.settled && !entry.completionSubmitted) entry.state = 'waiting';
      entry.output = '';
    }
  };

  try {
    const command = requiredConfiguredExecutable(
      'CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND',
      process.env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND || 'claude'
    );
    const env = hermesCredentialProcessEnv({
      NO_COLOR: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      // Prevent Claude Code from launching a system browser. Mia forwards the
      // URL it prints into the desktop's isolated provider-auth popup.
      BROWSER: path.join(MIAOS_HERMES_GUARD_BIN, 'open'),
    });
    const configDir = String(process.env.CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR || '').trim();
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    const child = spawn(command, ['auth', 'login', '--claudeai'], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    entry.child = child;
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.stdin.on('error', () => finish('error', { terminate: true }));
    child.once('error', () => finish('error', { terminate: true }));
    child.once('close', (code) => { void verifyCompletion(code); });
    entry.timeout = setTimeout(() => {
      if (entry.settled) return;
      finish('error', { terminate: true });
    }, HERMES_AUTH_TIMEOUT_MS);
    entry.timeout.unref();
  } catch (_) {
    finish('error');
  }

  return entry;
}

function disconnectHermesAuth(email, provider) {
  const owner = String(email || '').trim().toLowerCase();
  const existing = harnessAuthByUser.get(owner);
  if (!existing || existing.provider !== provider) return;
  existing.settled = true;
  if (existing.timeout) clearTimeout(existing.timeout);
  existing.timeout = null;
  if (existing.child) {
    try { existing.child.kill('SIGTERM'); } catch (_) { /* process may already be gone */ }
  }
  if (harnessAuthByUser.get(owner) === existing) harnessAuthByUser.delete(owner);
}

function disconnectAllHermesAuth() {
  for (const owner of Array.from(harnessAuthByUser.keys())) {
    const entry = harnessAuthByUser.get(owner);
    if (entry && entry.provider) disconnectHermesAuth(owner, entry.provider);
  }
  harnessAuthByUser.clear();
}

function runHermesLogout(provider) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (err) reject(err);
      else resolve();
    };
    let child;
    try {
      // Hermes owns the credential store. Keep stdout/stderr private so the
      // Mia API can never accidentally return provider or token details.
      child = spawnHermesCli(['auth', 'logout', provider], {
        cwd: process.cwd(),
        env: hermesCredentialProcessEnv(),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.once('error', () => finish(new Error('Could not disconnect provider')));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new Error('Could not disconnect provider'));
      });
      timeout = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_) { /* process may already be gone */ }
        finish(new Error('Provider disconnect timed out'));
      }, HERMES_LOGOUT_TIMEOUT_MS);
      timeout.unref();
    } catch (_) {
      finish(new Error('Could not disconnect provider'));
    }
  });
}

function runHermesApiKeyAdd(provider, apiKey) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (err) reject(err);
      else resolve();
    };
    let child;
    try {
      // Pass the key through Hermes' documented --api-key flag. Feeding the
      // hidden prompt over a stdin pipe is not part of the CLI contract and
      // hangs on Windows, where Python getpass reads the console rather than
      // stdin. The argv value is visible only to same-user processes for the
      // seconds the command runs; stdout/stderr stay discarded so the key
      // never reaches Mia's logs or API responses.
      child = spawnHermesCli([
        'auth', 'add', provider, '--type', 'api-key', '--api-key', apiKey,
      ], {
        cwd: process.cwd(),
        env: hermesCredentialProcessEnv(),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.once('error', () => finish(new Error('Could not add API credential')));
      child.once('close', (code) => {
        if (code === 0) finish();
        else finish(new Error('Could not add API credential'));
      });
      timeout = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_) { /* process may already be gone */ }
        finish(new Error('API credential setup timed out'));
      }, HERMES_API_KEY_TIMEOUT_MS);
      timeout.unref();
    } catch (_) {
      finish(new Error('Could not add API credential'));
    }
  });
}

function runHermesAuthStatus(provider) {
  return new Promise((resolve) => {
    execFileHermesCli(
      ['auth', 'status', provider],
      {
        cwd: process.cwd(),
        env: hermesCredentialProcessEnv(),
        timeout: HERMES_STATUS_TIMEOUT_MS,
        maxBuffer: 16 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      (error, stdout, stderr) => {
        // Hermes owns the credential store. Mia only projects the boolean
        // status and intentionally discards all CLI text.
        const output = `${String(stdout || '')}\n${String(stderr || '')}`;
        resolve(!error && /logged\s+in/i.test(output));
      }
    );
  });
}

function hermesRuntimeAvailable() {
  return new Promise((resolve) => {
    execFileHermesCli(
      ['--version'],
      {
        cwd: process.cwd(),
        env: hermesCredentialProcessEnv(),
        timeout: HERMES_STATUS_TIMEOUT_MS,
        maxBuffer: 8 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      (error, stdout, stderr) => {
        const output = `${String(stdout || '')}\n${String(stderr || '')}`;
        resolve(!error && /Hermes Agent/i.test(output));
      }
    );
  });
}

async function hermesConnectionStatuses(email) {
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  const providers = Array.from(HERMES_STATUS_PROVIDERS);
  const values = await boundedMap(providers, HERMES_STATUS_CONCURRENCY, async (provider) => [
    provider,
    hermesDisconnectedProviders.has(provider) || harnessProviderDisconnectedForUser(settings, email, provider)
      ? false
      : (provider === CLAUDE_SUBSCRIPTION_PROVIDER
        ? (await runClaudeSubscriptionStatus()).loggedIn
        : await runHermesAuthStatus(provider)),
  ]);
  return Object.fromEntries(values);
}

function rememberNativeChatModelInventory(payload) {
  const providers = normalizeChatModelInventory(payload);
  nativeChatModelProviders = providers;
  return providers;
}

async function chatModelSelectionForUser(rawSelection, email) {
  if (!rawSelection || typeof rawSelection !== 'object') return null;
  let providers = visibleChatModelProvidersForUser(nativeChatModelProviders, email);
  // Match normal chat's startup behavior: a cached browser selection can
  // arrive before this backend has hydrated its authenticated inventory.
  if (!Object.keys(providers).length) {
    const payload = await getHermesGatewayModelOptions({ refresh: true });
    providers = visibleChatModelProvidersForUser(
      rememberNativeChatModelInventory(payload),
      email
    );
  }
  return normalizeChatModelSelection(rawSelection, providers);
}

function forgetNativeChatModelProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  const aliases = normalized === 'openai-api'
    ? ['openai-api', 'openai']
    : normalized === 'xai-oauth'
      ? ['xai-oauth', 'xai']
      : [normalized];
  for (const id of aliases) delete nativeChatModelProviders[id];
}

function waitForHermesAuthPrompt(entry, timeoutMs) {
  const limit = Number(timeoutMs) || 5000;
  if (!entry || entry.state !== 'starting') return Promise.resolve(entry);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (!entry || entry.state !== 'starting' || Date.now() - startedAt >= limit) {
        resolve(entry);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function harnessCliProviderForUser(email) {
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  const preference = harnessPreferenceForUser(settings, email);
  const selected = preference.provider === 'openai-api' ? preference.apiProvider : preference.provider;
  if (harnessProviderDisconnectedForUser(settings, email, selected)) return null;
  if (preference.provider === 'openai-api') return preference.apiProvider || 'openai-api';
  return HERMES_CLI_PROVIDER_BY_ONBOARDING_PROVIDER[preference.provider] || null;
}

function chatModelProviderIdsForPreference(preference) {
  if (!preference || !preference.onboardingComplete) return [];
  const provider = preference.provider === 'openai-api'
    ? preference.apiProvider || 'openai-api'
    : preference.provider;
  if (provider === 'openai-api') return ['openai-api', 'openai'];
  // Hermes releases have used both ids for the same signed-in Grok account.
  if (provider === 'xai-oauth') return ['xai-oauth', 'xai'];
  return provider ? [provider] : [];
}

// Models the Mia Router exposes. The default matches what the hosted
// service actually serves; env overrides it, and an explicitly empty value
// disables the filter (all provider models visible).
const MANAGED_ROUTER_MODEL_ALLOWLIST_RAW = 'MIAOS_MANAGED_ROUTER_MODEL_ALLOWLIST' in process.env
  ? String(process.env.MIAOS_MANAGED_ROUTER_MODEL_ALLOWLIST || '')
  : 'deepseek/deepseek-v4.1-flash';
const MANAGED_ROUTER_MODEL_ALLOWLIST = MANAGED_ROUTER_MODEL_ALLOWLIST_RAW.trim()
  ? new Set(MANAGED_ROUTER_MODEL_ALLOWLIST_RAW.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  : null;

// Hermes reports some product providers under a second id. Map those back to
// the id Mia uses for connection status and disconnect records.
function chatModelStatusProviderId(id) {
  const normalized = String(id || '').trim().toLowerCase();
  if (normalized === 'openai') return 'openai-api';
  if (normalized === 'xai') return 'xai-oauth';
  return normalized;
}

// The saved preference only picks the default model. Every other provider
// the user connected through Mia, and has not disconnected, stays selectable
// per turn, so connecting a second provider (for example Mia Router after
// Claude) never hides the first one.
function chatModelProviderIdsForUser(providers, settings, email, preference) {
  if (!preference || !preference.onboardingComplete) return [];
  const owner = String(email || '').trim().toLowerCase();
  const connected = new Set(harnessConnectedProvidersForUser(settings, owner));
  if (managedRouterProvisionedEmails.has(owner)) connected.add(MANAGED_ROUTER_HERMES_PROVIDER);
  const ids = new Set(chatModelProviderIdsForPreference(preference));
  for (const id of Object.keys(providers || {})) {
    const statusId = chatModelStatusProviderId(id);
    if (!connected.has(id) && !connected.has(statusId)) continue;
    if (hermesDisconnectedProviders.has(statusId)
      || harnessProviderDisconnectedForUser(settings, email, statusId)) continue;
    ids.add(id);
  }
  return Array.from(ids);
}

function visibleChatModelProvidersForUser(providers, email) {
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  const preference = harnessPreferenceForUser(settings, email);
  const visible = visibleChatModelInventory(
    providers,
    chatModelProviderIdsForUser(providers, settings, email, preference)
  );
  if (MANAGED_ROUTER_MODEL_ALLOWLIST && visible.openrouter) {
    const provider = visible.openrouter;
    const models = provider.models.filter(m => MANAGED_ROUTER_MODEL_ALLOWLIST.has(String(m).toLowerCase()));
    if (models.length) {
      visible.openrouter = {
        ...provider,
        models,
        capabilities: Object.fromEntries(models.map(m => [
          m, provider.capabilities[m] || { fast: false, reasoning: true },
        ])),
      };
    } else {
      delete visible.openrouter;
    }
  }
  for (const [id, provider] of Object.entries(visible)) {
    const label = HERMES_AUTH_PROVIDER_LABELS[chatModelStatusProviderId(id)] || HERMES_AUTH_PROVIDER_LABELS[id];
    if (label) provider.label = label;
  }
  return visible;
}

function inferenceOptionsForUser(email, baseOptions) {
  const options = Object.assign({}, baseOptions || {});
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  const preference = harnessPreferenceForUser(settings, email);
  const provider = harnessCliProviderForUser(email);
  if (provider) options.provider = provider;
  if (provider && preference.model) {
    options.model = preference.model;
    if (preference.fast) options.fast = true;
  } else if (provider && !options.model) {
    // A provider without a model is never applied downstream (the gateway
    // client only pins provider alongside an explicit model), which would
    // silently hand the turn to whatever the Hermes profile defaults to.
    // Resolve the user's first visible model instead — for a managed router
    // that is the allowlisted model.
    // Several providers can be visible; only the preferred one (under
    // either of its Hermes ids) may supply the default model.
    const visible = visibleChatModelProvidersForUser(nativeChatModelProviders, email);
    const entry = visible[provider] || chatModelProviderIdsForPreference(preference)
      .map((id) => visible[id]).find(Boolean);
    if (entry && entry.models.length) options.model = entry.models[0];
  }
  return Object.keys(options).length ? options : undefined;
}

// Provider credentials and guardrails are process-wide settings, so changing
// them must require a human admin session. Bearer API keys are intentionally
// excluded even when their owner is an admin; an API key is for automation,
// not interactive control of the shared inference policy.
function requireGlobalSettingsAdmin(req, res, next) {
  if (MIAOS_NO_AUTH) {
    req.session = null;
    req.userEmail = DEFAULT_OWNER;
    return next();
  }
  return requireInteractiveAuth(req, res, () => {
    const user = db.getUserByEmail(conn, req.userEmail);
    const allowed = user
      ? !user.disabled && user.role === 'admin'
      : isAdmin(req.userEmail);
    if (!allowed) return res.status(403).json({ error: 'forbidden' });
    return next();
  });
}

app.get('/api/settings', requireAuth, (req, res) => {
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  res.status(200).json({
    liveMode: Boolean(getApiKey()),
    guardrails: settings.guardrails,
    lastBackup: settings.lastBackup || null,
    chatOutput: settings.chatOutput === 'verbose' ? 'verbose' : 'concise',
    instructions: instructionSettingsForUser(settings, req.userEmail),
    harness: harnessPreferenceForUser(settings, req.userEmail),
    hiddenStarterBots: Array.isArray(settings.hiddenStarterBots)
      ? settings.hiddenStarterBots.filter((name) => typeof name === 'string')
      : [],
  });
});

// Dismissing a starter-bot template is a durable choice: the full hidden
// list replaces the stored one (the client owns merge semantics).
app.post('/api/settings/starter-bots', requireAuth, (req, res) => {
  const hidden = (req.body || {}).hidden;
  if (!Array.isArray(hidden) || hidden.some((name) => typeof name !== 'string')) {
    return res.status(400).json({ error: 'hidden must be an array of template names' });
  }
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  settings.hiddenStarterBots = [...new Set(hidden.map((name) => name.slice(0, 200)))].slice(0, 50);
  db.saveSingleton(conn, 'settings', settings);
  return res.status(200).json({ hiddenStarterBots: settings.hiddenStarterBots });
});

// Chat output detail is a first-class user setting (Settings → General), not
// a localhost-only diagnostic: 'verbose' streams the working steps into the
// transcript, 'concise' keeps only the final reply.
app.post('/api/settings/output', requireAuth, (req, res) => {
  const output = String((req.body || {}).output || '').trim().toLowerCase();
  if (output !== 'verbose' && output !== 'concise') {
    return res.status(400).json({ error: 'output must be "verbose" or "concise"' });
  }
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  settings.chatOutput = output;
  db.saveSingleton(conn, 'settings', settings);
  applyChatOutputSetting(output);
  return res.status(200).json({ chatOutput: output });
});

app.post('/api/settings/instructions', requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.agent !== 'string' || typeof body.bot !== 'string') {
    return res.status(400).json({ error: 'agent and bot instructions must be strings' });
  }
  if (body.agent.length > MAX_GLOBAL_INSTRUCTIONS_LENGTH || body.bot.length > MAX_GLOBAL_INSTRUCTIONS_LENGTH) {
    return res.status(400).json({ error: `instructions must be ${MAX_GLOBAL_INSTRUCTIONS_LENGTH} characters or fewer` });
  }
  const owner = String(req.userEmail || '').trim().toLowerCase();
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  if (!settings.instructionsByUser || typeof settings.instructionsByUser !== 'object') settings.instructionsByUser = {};
  const instructions = normalizeInstructionSettings(body);
  settings.instructionsByUser[owner] = instructions;
  db.saveSingleton(conn, 'settings', settings);

  // Scheduled prompts are stored in Hermes cron jobs. Refresh the user's
  // active bots so this preference applies there as well as on the next chat.
  const bots = db.loadAll(conn, 'bots').filter((bot) => ownerOf(bot) === owner && bot.status !== 'draft');
  const synced = await Promise.allSettled(bots.map((bot) => syncBotAutomationWithInstructions(bot)));
  synced.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      db.saveOne(conn, 'bots', bots[index].id, bots[index]);
    } else {
      console.error('cron-sync: failed to apply global bot instructions for', bots[index].id, result.reason && result.reason.message);
    }
  });
  return res.status(200).json({ instructions });
});

// The harness owns provider login and credentials. This endpoint records only
// the authenticated user's preferred provider route and collaboration mode;
// Mia never accepts, forwards, or persists a provider secret here.
app.post('/api/settings/harness', requireAuth, (req, res) => {
  const body = req.body || {};
  const provider = String(body.provider || '').trim();
  const mode = String(body.mode || '').trim();
  const requestedApiProvider = normalizeHermesApiProvider(body.apiProvider);
  if (!HERMES_ONBOARDING_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'unsupported provider' });
  }
  const isManagedRouter = provider === 'managed-router';
  const effectiveProvider = isManagedRouter ? 'openai-api' : provider;
  const effectiveApiProvider = isManagedRouter ? 'openrouter' : (requestedApiProvider || 'openai-api');
  if (!HERMES_ONBOARDING_MODES.has(mode)) {
    return res.status(400).json({ error: 'unsupported collaboration mode' });
  }
  if (effectiveProvider === 'openai-api' && !isManagedRouter && body.apiProvider && !requestedApiProvider) {
    return res.status(400).json({ error: 'unsupported API provider' });
  }
  // A picker without an explicit model sends null. Treat it like an omitted
  // model and let the harness catalog choose its default below.
  if (effectiveProvider !== 'openai-api' && body.model != null
    && !isAllowedHermesModel(effectiveProvider, body.model, body.fast === true)) {
    return res.status(400).json({ error: 'unsupported model for provider' });
  }
  if (effectiveProvider !== 'openai-api' && body.fast !== undefined && typeof body.fast !== 'boolean') {
    return res.status(400).json({ error: 'invalid fast setting' });
  }
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  if (!settings.harnessByUser || typeof settings.harnessByUser !== 'object') settings.harnessByUser = {};
  const owner = String(req.userEmail || '').trim().toLowerCase();
  const preference = {
    provider: effectiveProvider,
    apiProvider: effectiveProvider === 'openai-api' ? effectiveApiProvider : null,
    ...(effectiveProvider === 'openai-api'
      ? { model: null, fast: false }
      : normalizeHermesModelSelection(effectiveProvider, body.model, body.fast === true || body.model === 'fast')),
    mode,
    onboardingComplete: true,
    updatedAt: new Date().toISOString(),
  };
  const previous = normalizeHarnessPreference(settings.harnessByUser[owner]);
  settings.harnessByUser[owner] = preference;
  db.saveSingleton(conn, 'settings', settings);
  // Changing the default must not drop the provider it replaces from the
  // picker, so both stay recorded as connected.
  const previousProvider = previous && previous.onboardingComplete
    && (previous.provider === 'openai-api' ? previous.apiProvider : previous.provider);
  if (previousProvider && !harnessProviderDisconnectedForUser(settings, owner, previousProvider)) {
    setHarnessProviderConnected(owner, previousProvider, true);
  }
  setHarnessProviderConnected(owner, effectiveProvider === 'openai-api' ? effectiveApiProvider : effectiveProvider, true);
  if (effectiveProvider === CLAUDE_SUBSCRIPTION_PROVIDER) {
    // A successful explicit selection reconnects Mia to the existing external
    // Claude Code login. The probe itself must not re-enable dispatch before
    // the user finishes saving this preference.
    setHarnessProviderDisconnected(owner, effectiveProvider, false);
  }
  bumpVersion();
  if (isManagedRouter && MANAGED_ROUTER_URL) {
    void autoProvisionManagedRouter(owner);
  }
  return res.status(200).json({ harness: preference });
});

// Adds a provider to the chat picker without changing the saved default.
// The picker's Connect links use this after setup confirms the credential,
// so connecting a second provider never reloads the app or switches models.
app.post('/api/settings/harness/connected', requireAuth, async (req, res) => {
  const owner = String(req.userEmail || '').trim().toLowerCase();
  let provider = String((req.body || {}).provider || '').trim().toLowerCase();
  if (provider === 'managed-router' || provider === 'mia-router') provider = MANAGED_ROUTER_HERMES_PROVIDER;
  if (!HERMES_STATUS_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'unsupported provider' });
  }
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  if (hermesDisconnectedProviders.has(provider) || harnessProviderDisconnectedForUser(settings, owner, provider)) {
    return res.status(409).json({ error: 'That provider is not connected yet.' });
  }
  const connected = provider === CLAUDE_SUBSCRIPTION_PROVIDER
    ? (await runClaudeSubscriptionStatus()).loggedIn
    : (provider === MANAGED_ROUTER_HERMES_PROVIDER && managedRouterProvisionedEmails.has(owner))
      || await runHermesAuthStatus(provider);
  if (!connected) return res.status(409).json({ error: 'That provider is not connected yet.' });
  setHarnessProviderConnected(owner, provider, true);
  return res.status(200).json({ ok: true, provider });
});

// Mia only brokers the Hermes-owned device flow for subscription choices.
// Hermes performs the OAuth exchange and stores the credential in its own auth
// store; no token or raw CLI output is returned.
app.get('/api/settings/harness/auth', requireAuth, (req, res) => {
  const owner = String(req.userEmail || '').trim().toLowerCase();
  return res.status(200).json({ auth: publicHermesAuthState(harnessAuthByUser.get(owner)) });
});

app.get('/api/settings/harness/auth/status', requireAuth, async (req, res) => {
  const [connections, hermesAgent] = await Promise.all([
    hermesConnectionStatuses(req.userEmail),
    hermesRuntimeAvailable(),
  ]);
  return res.status(200).json({ connections, runtimes: { hermesAgent } });
});

// Keep the API-key picker aligned with the provider universe supported by the
// installed Hermes release. OAuth and machine-identity entries intentionally
// stay out of this list because they have separate setup flows.
app.get('/api/settings/harness/providers', requireAuth, (req, res) => {
  return res.status(200).json({ providers: HERMES_API_PROVIDER_CATALOG });
});

// Managed router: check provision status or trigger re-provision.
app.get('/api/settings/managed-router/status', requireAuth, (req, res) => {
  const email = String(req.userEmail || '').trim().toLowerCase();
  return res.status(200).json({
    provisioned: managedRouterProvisionedEmails.has(email),
    available: Boolean(MANAGED_ROUTER_URL),
    label: MANAGED_ROUTER_LABEL,
  });
});

app.post('/api/settings/managed-router/provision', requireGlobalSettingsAdmin, async (req, res) => {
  const email = String(req.userEmail || '').trim().toLowerCase();
  if (!MANAGED_ROUTER_URL) {
    return res.status(503).json({ error: `${MANAGED_ROUTER_LABEL} is not configured on this installation` });
  }
  if (!freshManagedRouterToken(email)) {
    // Provisioning authenticates with the user's own Clerk token; without a
    // fresh one the mint endpoint would reject us anyway.
    return res.status(409).json({ error: 'Sign in again to re-provision (the Clerk session token has expired)' });
  }
  try {
    managedRouterProvisionedEmails.delete(email);
    await autoProvisionManagedRouter(email, null, { force: true });
    return res.status(200).json({
      ok: true,
      provisioned: managedRouterProvisionedEmails.has(email),
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Provision failed' });
  }
});

app.get('/api/settings/harness/models', requireAuth, (req, res) => {
  return res.status(200).json({
    providers: Object.fromEntries(Object.entries(HERMES_SUBSCRIPTION_MODEL_OPTIONS).map(([provider, options]) => [
      provider,
      {
        defaultModel: normalizeHermesModelSelection(provider, null, false).model,
        options: options.map(({ id, model, label, fast }) => ({ id, model, label, fast: fast === true })),
      },
    ])),
  });
});

// The composer uses Hermes' authenticated picker inventory rather than a
// second Mia-maintained model list. This keeps connected API and
// subscription models in sync with the gateway's live capabilities.
app.get('/api/settings/harness/chat-models', requireAuth, async (req, res) => {
  try {
    const payload = await getHermesGatewayModelOptions({
      refresh: String(req.query.refresh || '').toLowerCase() === 'true',
    });
    const allProviders = rememberNativeChatModelInventory(payload);
    const providers = visibleChatModelProvidersForUser(allProviders, req.userEmail);
    return res.status(200).json({
      providers: inventoryResponse(providers),
      reasoningEfforts: CHAT_REASONING_EFFORTS,
      speeds: CHAT_SPEEDS,
    });
  } catch (error) {
    nativeChatModelProviders = {};
    console.warn('[Mia] connected model inventory unavailable:', error && error.message ? error.message : 'unknown error');
    return res.status(502).json({ error: 'Connected model inventory unavailable' });
  }
});

app.post('/api/settings/harness/auth/start', requireGlobalSettingsAdmin, async (req, res) => {
  const provider = String((req.body || {}).provider || '').trim();
  if (!HERMES_AUTH_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'unsupported harness sign-in' });
  }
  if (provider === CLAUDE_SUBSCRIPTION_PROVIDER) {
    const status = await runClaudeSubscriptionStatus();
    if (status.loggedIn && (req.body || {}).reauthenticate !== true) {
      setHarnessProviderConnected(req.userEmail, provider, true);
      return res.status(200).json({ auth: {
        state: 'connected', provider, plan: status.plan || null,
      } });
    }
    if (!status.available) {
      return res.status(409).json({ error: status.detail, auth: {
        state: 'error', provider, error: status.detail,
      } });
    }
    const auth = await waitForHermesAuthPrompt(
      startClaudeSubscriptionAuth(req.userEmail),
      HERMES_AUTH_PROMPT_WAIT_MS
    );
    return res.status(200).json({ auth: publicHermesAuthState(auth) });
  }
  const auth = await waitForHermesAuthPrompt(startHermesAuth(req.userEmail, provider), HERMES_AUTH_PROMPT_WAIT_MS);
  return res.status(200).json({ auth: publicHermesAuthState(auth) });
});

app.post('/api/settings/harness/auth/complete', requireGlobalSettingsAdmin, (req, res) => {
  const provider = String((req.body || {}).provider || '').trim();
  const code = typeof (req.body || {}).code === 'string' ? req.body.code.trim() : '';
  if (provider !== CLAUDE_SUBSCRIPTION_PROVIDER) {
    return res.status(400).json({ error: 'unsupported harness sign-in completion' });
  }
  if (!code || code.length > 8192 || /[\s\x00-\x1f\x7f]/.test(code)) {
    return res.status(400).json({ error: 'Paste the one-time code shown by Claude.' });
  }
  const owner = String(req.userEmail || '').trim().toLowerCase();
  const auth = harnessAuthByUser.get(owner);
  if (!auth || auth.provider !== provider || auth.state !== 'waiting' || auth.settled
    || !auth.child || !auth.child.stdin || !auth.child.stdin.writable) {
    return res.status(409).json({ error: 'No Claude sign-in is waiting for a code.' });
  }
  if (auth.completionSubmitted) {
    return res.status(409).json({ error: 'That Claude sign-in is already completing.' });
  }
  // Desktop auto-completion is bound to the currently waiting CLI flow, so
  // a late callback from an older popup cannot finish a replacement login.
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'state')) {
    let expectedState = '';
    try { expectedState = new URL(auth.verificationUrl).searchParams.get('state') || ''; } catch (_) {}
    if (!expectedState || req.body.state !== expectedState || !code.endsWith(`#${expectedState}`)) {
      return res.status(409).json({ error: 'This Claude sign-in has expired. Start sign-in again.' });
    }
  }
  auth.completionSubmitted = true;
  auth.state = 'completing';
  auth.child.stdin.end(`${code}\n`);
  return res.status(202).json({ auth: publicHermesAuthState(auth) });
});

app.post('/api/settings/harness/auth/cancel', requireGlobalSettingsAdmin, (req, res) => {
  const provider = String((req.body || {}).provider || '').trim();
  if (provider !== CLAUDE_SUBSCRIPTION_PROVIDER) {
    return res.status(400).json({ error: 'unsupported harness sign-in' });
  }
  const owner = String(req.userEmail || '').trim().toLowerCase();
  const auth = harnessAuthByUser.get(owner);
  if (auth && auth.provider === provider) disconnectHermesAuth(owner, provider);
  return res.status(200).json({ auth: { state: 'idle', provider: null } });
});

app.post('/api/settings/harness/auth/logout', requireGlobalSettingsAdmin, async (req, res) => {
  const provider = String((req.body || {}).provider || '').trim();
  if (!HERMES_DISCONNECT_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'unsupported harness disconnect provider' });
  }
  disconnectHermesAuth(req.userEmail, provider);
  setHarnessProviderConnected(req.userEmail, provider, false);
  if (provider === CLAUDE_SUBSCRIPTION_PROVIDER) {
    forgetNativeChatModelProvider(provider);
    setHarnessProviderDisconnected(req.userEmail, provider, true);
    let closedSessions = 0;
    try { closedSessions = await closeHermesGatewaySessions(); } catch (_) { /* next turn still rechecks persisted state */ }
    bumpVersion();
    return res.status(200).json({
      ok: true, provider, state: 'disconnected', closedSessions, externalCredentialsPreserved: true,
    });
  }
  try {
    await runHermesLogout(provider);
    forgetNativeChatModelProvider(provider);
    hermesDisconnectedProviders.add(provider);
    // The credential is gone from auth.json, but live gateway sessions keep
    // the agent (and key) they were built with. Close them so the next turn
    // rebuilds against the current credential set instead of the old one.
    let closedSessions = 0;
    try {
      closedSessions = await closeHermesGatewaySessions();
    } catch (error) {
      console.error('harness disconnect: closing live gateway sessions failed', error.message);
    }
    bumpVersion();
    return res.status(200).json({ ok: true, provider, state: 'disconnected', closedSessions });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Could not disconnect provider' });
  }
});

app.post('/api/settings/harness/api-key', requireGlobalSettingsAdmin, async (req, res) => {
  const body = req.body || {};
  let provider = String(body.provider || '').trim();
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  // managed-router is the product-facing name; Hermes knows it as openrouter.
  if (provider === 'managed-router' || provider === 'mia-router') provider = MANAGED_ROUTER_HERMES_PROVIDER;
  if (!HERMES_API_KEY_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'unsupported API provider' });
  }
  // API keys never contain whitespace. Rejecting it here catches the classic
  // bad paste (Finder file names, prose, a shell command) before the gateway
  // caches an unusable credential for its agent profiles.
  if (!apiKey || apiKey.length > 4096 || /[\s\0]/.test(apiKey)) {
    return res.status(400).json({ error: 'That does not look like an API key. Paste the key itself, with no spaces.' });
  }
  disconnectHermesAuth(req.userEmail, provider);
  try {
    await runHermesApiKeyAdd(provider, apiKey);
    // Re-keying must actually take effect: drop any stale copy of this
    // provider from the per-profile pools (the root store just written is
    // authoritative) and bounce the Mia-owned gateway so no live session
    // stays pinned to the credential it was built with.
    removeProviderProfileCredentials(process.env.HERMES_HOME, provider);
    await restartHermesGatewayRuntime();
    hermesDisconnectedProviders.delete(provider);
    setHarnessProviderConnected(req.userEmail, provider, true);
    return res.status(200).json({ ok: true, provider, state: 'connected' });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Could not add API credential' });
  }
});

// This is a browser navigation rather than a JSON API: the frontend opens it
// directly from the user's click, preserving popup permission. It starts (or
// reuses) the same Hermes-owned flow and redirects only after the real device
// URL exists, so no placeholder tab is shown.
app.get('/api/settings/harness/auth/redirect', requireGlobalSettingsAdmin, async (req, res) => {
  const provider = String(req.query.provider || 'openai-codex').trim();
  if (!HERMES_AUTH_PROVIDERS.has(provider)) {
    return res.status(400).type('text/plain').send('Unsupported harness sign-in provider. Return to Mia and try again.');
  }
  let auth;
  if (provider === CLAUDE_SUBSCRIPTION_PROVIDER) {
    const status = await runClaudeSubscriptionStatus();
    if (!status.loggedIn && !status.available) {
      return res.status(409).type('text/plain').send(status.detail || 'Claude Code is unavailable. Return to Mia and try again.');
    }
    if (status.loggedIn && req.query.reauthenticate !== 'true') {
      return res.status(200).type('text/plain').send('Claude is already connected. You can close this window.');
    }
    auth = await waitForHermesAuthPrompt(startClaudeSubscriptionAuth(req.userEmail), HERMES_AUTH_PROMPT_WAIT_MS);
  } else {
    auth = await waitForHermesAuthPrompt(startHermesAuth(req.userEmail, provider), HERMES_AUTH_PROMPT_WAIT_MS);
  }
  if (auth && auth.verificationUrl) return res.redirect(302, auth.verificationUrl);
  return res.status(503).type('text/plain').send('Unable to start sign-in. Return to Mia and try again.');
});

app.post('/api/settings/key', requireGlobalSettingsAdmin, (req, res) => {
  const { key } = req.body || {};
  runtimeApiKey = typeof key === 'string' ? key.trim() : '';
  res.status(200).json({ ok: true, liveMode: Boolean(getApiKey()) });
});

app.post('/api/settings/guardrails', requireGlobalSettingsAdmin, (req, res) => {
  const body = req.body || {};
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  settings.guardrails = {
    allowedProviders: Array.isArray(body.allowedProviders)
      ? body.allowedProviders.filter((p) => typeof p === 'string')
      : (settings.guardrails && settings.guardrails.allowedProviders) || ['anthropic'],
  };
  db.saveSingleton(conn, 'settings', settings);
  res.status(200).json({ guardrails: settings.guardrails });
});

// ---------- Google Account connector (Hermes-owned OAuth and execution) ----------

function sendGoogleAccountStatus(res, status, httpStatus = 200) {
  res.set('Cache-Control', 'no-store');
  return res.status(httpStatus).json(status);
}

function unownedGoogleAccountStatus() {
  return {
    name: 'Google Account',
    state: 'not_connected',
    connected: false,
    canStart: false,
    access: { read: false, write: false, delete: false, trash: false, destructive: false },
  };
}

async function googleAccountStatusHandler(req, res) {
  const connector = googleAccountOwnerBinding.connectorFor(req.userEmail);
  if (!connector) return sendGoogleAccountStatus(res, unownedGoogleAccountStatus());
  try {
    return sendGoogleAccountStatus(res, await connector.status());
  } catch (_) {
    return sendGoogleAccountStatus(res, {
      name: 'Google Account',
      state: 'connection_error',
      connected: false,
      canStart: false,
      access: { read: true, write: true, delete: false, trash: false, destructive: false },
    });
  }
}

async function googleAccountStartHandler(req, res) {
  const connector = googleAccountOwnerBinding.connectorFor(req.userEmail);
  if (!connector) return sendGoogleAccountStatus(res, unownedGoogleAccountStatus(), 403);
  try {
    const result = await connector.start();
    const status = result.state === 'setup_required' ? 409 : result.state === 'unavailable' ? 503 : 200;
    return sendGoogleAccountStatus(res, result, status);
  } catch (_) {
    return sendGoogleAccountStatus(res, { name: 'Google Account', state: 'connection_error', connected: false }, 503);
  }
}

async function googleAccountLegacyStartHandler(req, res) {
  const connector = googleAccountOwnerBinding.connectorFor(req.userEmail);
  if (!connector) return sendGoogleAccountStatus(res, unownedGoogleAccountStatus(), 403);
  try {
    const result = await connector.start();
    if (result.authorizationUrl) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, result.authorizationUrl);
    }
    return sendGoogleAccountStatus(res, result, result.state === 'setup_required' ? 409 : 503);
  } catch (_) {
    return sendGoogleAccountStatus(res, { name: 'Google Account', state: 'connection_error', connected: false }, 503);
  }
}

async function googleAccountTestHandler(req, res) {
  const connector = googleAccountOwnerBinding.connectorFor(req.userEmail);
  if (!connector) return sendGoogleAccountStatus(res, unownedGoogleAccountStatus(), 403);
  try {
    const result = await connector.testConnection();
    return sendGoogleAccountStatus(res, result, result.connected ? 200 : 409);
  } catch (_) {
    return sendGoogleAccountStatus(res, { name: 'Google Account', state: 'connection_error', connected: false }, 503);
  }
}

async function googleAccountDisconnectHandler(req, res) {
  const connector = googleAccountOwnerBinding.connectorFor(req.userEmail);
  if (!connector) return sendGoogleAccountStatus(res, unownedGoogleAccountStatus(), 403);
  try {
    return sendGoogleAccountStatus(res, await connector.disconnect());
  } catch (_) {
    return sendGoogleAccountStatus(res, { name: 'Google Account', state: 'connection_error', connected: false }, 503);
  }
}

app.get([
  '/api/connections/google/account',
  '/api/connections/google/workspace',
  '/api/connections/google/gmail',
], requireAuth, googleAccountStatusHandler);
app.post('/api/connections/google/account/start', requireInteractiveAuth, googleAccountStartHandler);
app.get([
  '/api/connections/google/workspace/start',
  '/api/connections/google/gmail/start',
], requireInteractiveAuth, googleAccountLegacyStartHandler);
app.post('/api/connections/google/account/test', requireInteractiveAuth, googleAccountTestHandler);
app.post('/api/connections/google/account/disconnect', requireInteractiveAuth, googleAccountDisconnectHandler);

// Legacy direct-Google helpers remain below for data compatibility, but none
// of their routes are registered. New OAuth tokens and operations are owned by
// the Hermes Google Workspace skill, never by the Mia database.

function googleFrontendRedirect(res, result, req) {
  const config = googleWorkspace.configFromEnv();
  try {
    // Trust only the configured frontend URL for this redirect target; a
    // deployment that needs to derive it from the request host should set
    // GOOGLE_FRONTEND_URL explicitly rather than special-casing a domain here.
    const frontendUrl = config.frontendUrl;
    const target = new URL(frontendUrl);
    target.hash = `#/chat?google=${result}`;
    res.set('Cache-Control', 'no-store');
    return res.redirect(303, target.toString());
  } catch (_) {
    return res.status(500).send('Google Workspace connection could not return to Mia.');
  }
}

function googleServiceStates(scopes) {
  const access = googleWorkspace.serviceAccess(scopes);
  return Object.fromEntries(
    Object.entries(access).map(([service, connected]) => [service, {
      connected,
      readOnly: connected && !googleWorkspace.serviceSupportsWrite(service),
      readWrite: connected && googleWorkspace.serviceSupportsWrite(service),
    }])
  );
}

function googleWorkspaceStatusPayload(config, connection) {
  if (!googleWorkspace.isConfigured(config)) {
    return { state: 'not_configured', connected: false, readOnly: false, readWrite: false, services: googleServiceStates([]) };
  }
  if (!connection) {
    return { state: 'not_connected', connected: false, readOnly: false, readWrite: false, services: googleServiceStates([]) };
  }
  const ready = googleWorkspace.hasRequiredScopes(connection.grantedScopes);
  return {
    state: ready ? 'connected' : 'needs_reconnect',
    connected: ready,
    connectedEmail: connection.googleEmail,
    grantedScopes: connection.grantedScopes,
    readOnly: false,
    readWrite: ready,
    services: googleServiceStates(connection.grantedScopes),
  };
}

function googleWorkspaceStatusHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  const config = googleWorkspace.configFromEnv();
  const connection = db.getGoogleWorkspaceConnection(conn, req.userEmail);
  return res.status(200).json(googleWorkspaceStatusPayload(config, connection));
}

async function googleWorkspaceAgentContextForOwner(ownerEmail, message) {
  const connector = googleAccountOwnerBinding.connectorFor(ownerEmail);
  if (!connector) {
    return 'Google Workspace connector (authoritative server state): NOT CONNECTED for this user. Ask them to connect it from Plugins.';
  }
  const result = await googleWorkspaceContext.buildGoogleWorkspaceAgentContext({
    // The authenticated event owner is resolved by native authorization
    // before this function is called. Google OAuth and resource operations are
    // owned by Hermes; no Mia refresh-token row is consulted here.
    connector,
    ownerEmail,
    message,
  });
  return result.text;
}

// Legacy route intentionally unregistered.
// Backwards compatibility for the existing Gmail-only card and local clients.
// Legacy route intentionally unregistered.

// This endpoint redirects the browser directly to Google. It does not return
// an authorization URL to frontend JavaScript, and never logs or serializes
// client secrets, access tokens, or refresh tokens.
function googleWorkspaceStartHandler(req, res) {
  const config = googleWorkspace.configFromEnv();
  if (!googleWorkspace.isConfigured(config)) return googleFrontendRedirect(res, 'not_configured', req);

  const state = googleWorkspace.createOAuthState(config.stateSigningSecret);
  db.deleteExpiredGoogleOAuthStates(conn, new Date().toISOString());
  db.createGoogleOAuthState(conn, {
    nonce: state.nonce,
    ownerEmail: req.userEmail,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
  });
  res.set('Cache-Control', 'no-store');
  return res.redirect(302, googleWorkspace.buildAuthorizationUrl(config, state.value));
}

// Legacy direct OAuth start routes intentionally unregistered.

// Google calls this route without Mia's session cookie in some local setups
// because localhost and 127.0.0.1 are different cookie hosts. The one-time,
// HMAC-signed state plus the server-side state row is therefore the only
// authorization boundary for the callback; no frontend user/workspace id is
// accepted or trusted here.
async function legacyGoogleWorkspaceCallbackHandler(req, res) {
  const config = googleWorkspace.configFromEnv();
  const signedState = googleWorkspace.verifyOAuthState(req.query && req.query.state, config.stateSigningSecret);
  if (!signedState) return googleFrontendRedirect(res, 'error', req);

  const stateRecord = db.consumeGoogleOAuthState(conn, signedState.nonce, new Date().toISOString());
  if (!stateRecord) return googleFrontendRedirect(res, 'error', req);
  if (req.query && req.query.error) return googleFrontendRedirect(res, 'error', req);

  const code = req.query && req.query.code;
  if (typeof code !== 'string' || !code) return googleFrontendRedirect(res, 'error', req);
  if (!googleWorkspace.isConfigured(config)) return googleFrontendRedirect(res, 'error', req);

  try {
    const tokenResponse = await googleWorkspace.exchangeAuthorizationCode(code, config);
    const grantedScopes = googleWorkspace.normalizeScopes(tokenResponse.scope);
    if (!googleWorkspace.hasRequiredScopes(grantedScopes) || !tokenResponse.refresh_token) {
      return googleFrontendRedirect(res, 'error', req);
    }

    const profile = await googleWorkspace.fetchGmailProfile(tokenResponse.access_token);
    const googleEmail = String(profile && profile.emailAddress || '').trim().toLowerCase();
    if (!googleEmail) return googleFrontendRedirect(res, 'error', req);

    const now = new Date().toISOString();
    db.saveGoogleWorkspaceConnection(conn, {
      ownerEmail: stateRecord.ownerEmail,
      googleEmail,
      grantedScopes,
      encryptedRefreshToken: googleWorkspace.encryptRefreshToken(tokenResponse.refresh_token, config.tokenEncryptionKey),
      connectedAt: now,
      updatedAt: now,
    });
    bumpVersion();
    return googleFrontendRedirect(res, 'connected', req);
  } catch (_) {
    // Provider responses can contain credentials or account data. Do not log
    // them; the browser receives only a generic reconnectable error state.
    return googleFrontendRedirect(res, 'error', req);
  }
}

async function googleServiceTestHandler(req, res) {
  const service = String(req.params && req.params.service || '').toLowerCase();
  res.set('Cache-Control', 'no-store');
  if (!Object.prototype.hasOwnProperty.call(googleWorkspace.GOOGLE_SERVICE_SCOPES, service)) {
    return res.status(404).json({ ok: false, reason: 'unknown_service' });
  }
  const config = googleWorkspace.configFromEnv();
  const connection = db.getGoogleWorkspaceConnection(conn, req.userEmail);
  if (!googleWorkspace.isConfigured(config)) return res.status(200).json({ state: 'not_configured', connected: false, readOnly: false, readWrite: false });
  if (!connection) return res.status(200).json({ state: 'not_connected', connected: false, readOnly: false, readWrite: false });
  if (!googleWorkspace.hasRequiredScopes(connection.grantedScopes)) {
    return res.status(200).json({ ok: false, state: 'needs_reconnect', connected: false, readOnly: false, readWrite: false, reason: 'reconnect_required' });
  }

  let refreshToken;
  try {
    refreshToken = googleWorkspace.decryptRefreshToken(connection.encryptedRefreshToken, config.tokenEncryptionKey);
    const accessToken = await googleWorkspace.refreshAccessToken(refreshToken, config);
    const check = await googleWorkspace.testGoogleService(service, accessToken);
    const readOnly = !googleWorkspace.serviceSupportsWrite(service);
    const ok = Boolean(check.readVerified && check.cleanupOk && (readOnly || check.writeVerified));
    return res.status(200).json({
      ok,
      state: ok ? 'connected' : 'connection_error',
      connected: true,
      connectedEmail: String(check.emailAddress || connection.googleEmail).toLowerCase(),
      readOnly,
      readWrite: !readOnly,
      service,
      readVerified: Boolean(check.readVerified),
      writeVerified: Boolean(check.writeVerified),
      cleanupOk: Boolean(check.cleanupOk),
      reason: ok ? undefined : (check.cleanupOk ? 'test_failed' : 'cleanup_failed'),
      services: googleServiceStates(connection.grantedScopes),
    });
  } catch (err) {
    if (err && (err.code === 'invalid_grant' || err.status === 401)) {
      db.deleteGoogleWorkspaceConnection(conn, req.userEmail);
      bumpVersion();
      return res.status(200).json({ ok: false, state: 'not_connected', connected: false, readOnly: false, readWrite: false, reason: 'reconnect_required' });
    }
    const readOnly = !googleWorkspace.serviceSupportsWrite(service);
    return res.status(200).json({ ok: false, state: 'connection_error', connected: true, readOnly, readWrite: !readOnly, service, reason: 'test_failed' });
  } finally {
    refreshToken = null;
  }
}

// Legacy direct service-test routes intentionally unregistered.

async function googleWorkspaceTestHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  const config = googleWorkspace.configFromEnv();
  const connection = db.getGoogleWorkspaceConnection(conn, req.userEmail);
  if (!googleWorkspace.isConfigured(config)) return res.status(200).json({ state: 'not_configured', connected: false, readOnly: false, readWrite: false });
  if (!connection) return res.status(200).json({ state: 'not_connected', connected: false, readOnly: false, readWrite: false });
  if (!googleWorkspace.hasRequiredScopes(connection.grantedScopes)) {
    return res.status(200).json({ ok: false, state: 'needs_reconnect', connected: false, readOnly: false, readWrite: false, reason: 'reconnect_required' });
  }

  let refreshToken;
  try {
    refreshToken = googleWorkspace.decryptRefreshToken(connection.encryptedRefreshToken, config.tokenEncryptionKey);
    const accessToken = await googleWorkspace.refreshAccessToken(refreshToken, config);
    const results = {};
    for (const service of Object.keys(googleWorkspace.GOOGLE_SERVICE_SCOPES)) {
      try {
        const check = await googleWorkspace.testGoogleService(service, accessToken);
        const readOnly = !googleWorkspace.serviceSupportsWrite(service);
        results[service] = {
          ok: Boolean(check.readVerified && check.cleanupOk && (readOnly || check.writeVerified)),
          readVerified: Boolean(check.readVerified),
          writeVerified: Boolean(check.writeVerified),
          cleanupOk: Boolean(check.cleanupOk),
          readOnly,
          readWrite: !readOnly,
        };
      } catch (_) {
        const readOnly = !googleWorkspace.serviceSupportsWrite(service);
        results[service] = { ok: false, readVerified: false, writeVerified: false, cleanupOk: false, readOnly, readWrite: !readOnly };
      }
    }
    const ok = Object.values(results).every((result) => result.ok);
    return res.status(200).json({
      ok,
      state: ok ? 'connected' : 'connection_error',
      connected: true,
      connectedEmail: connection.googleEmail,
      readOnly: false,
      readWrite: true,
      results,
      services: googleServiceStates(connection.grantedScopes),
      reason: ok ? undefined : 'test_failed',
    });
  } catch (err) {
    if (err && (err.code === 'invalid_grant' || err.status === 401)) {
      db.deleteGoogleWorkspaceConnection(conn, req.userEmail);
      bumpVersion();
      return res.status(200).json({ ok: false, state: 'not_connected', connected: false, readOnly: false, readWrite: false, reason: 'reconnect_required' });
    }
    return res.status(200).json({ ok: false, state: 'connection_error', connected: true, readOnly: false, readWrite: true, reason: 'test_failed' });
  } finally {
    refreshToken = null;
  }
}

async function googleWorkspaceDisconnectHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  const config = googleWorkspace.configFromEnv();
  const connection = db.getGoogleWorkspaceConnection(conn, req.userEmail);
  if (connection && googleWorkspace.isConfigured(config)) {
    try {
      const refreshToken = googleWorkspace.decryptRefreshToken(connection.encryptedRefreshToken, config.tokenEncryptionKey);
      await googleWorkspace.revokeGoogleToken(refreshToken);
    } catch (_) {
      // Deletion from Mia is authoritative even if Google's revoke endpoint
      // is unavailable or the token was already revoked.
    }
  }
  const deleted = db.deleteGoogleWorkspaceConnection(conn, req.userEmail);
  if (deleted) bumpVersion();
  return res.status(200).json({ ok: true, state: 'not_connected', connected: false, readOnly: false, readWrite: false, services: googleServiceStates([]) });
}

// Legacy direct disconnect routes intentionally unregistered.

// Versioned native conversation export and health.
app.get('/api/backup', requireGlobalSettingsAdmin, (req, res) => {
  const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
  const exportedAt = new Date().toISOString();
  const backup = {
    exportedAt,
    settings: { guardrails: settings.guardrails },
  };
  settings.lastBackup = exportedAt;
  db.saveSingleton(conn, 'settings', settings);

  res.setHeader('Content-Disposition', `attachment; filename="miaos-backup-${exportedAt.slice(0, 10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify(backup, null, 2));
});

// Suggests short create-agent prompts for the create cinema's example pills,
// grounded on this instance's identity (INSTANCE_NAME/INSTANCE_TEAM_DESCRIPTION
// — never hardcoded, so every instance gets its own flavor) plus the caller's
// own workspace: their agents roster and departments, so the model can steer
// away from agents they already have. Same 'suggestion' inference tier as
// suggest-name/chat-suggestions above — best-effort UX sugar, never allowed
// to starve real chat replies. Cached per-user in memory, keyed by a hash of
// the roster names + department list, so re-visiting the create cinema
// doesn't cost a fresh inference call every time; the cache naturally
// invalidates itself the moment the roster or department list changes. Never
// surfaces inference failures as an error status — an empty list is
// something the frontend already falls back to BENCH_EXAMPLES for. Registered
// This fixed path precedes the generic bot route so
// registerResource's GET /api/bots/:id cannot shadow it
// (Express matches route registration order, and 'examples' would just look
// like an agent id).
const agentExamplesCache = new Map(); // `${owner}:${hash}` -> string[]

app.get('/api/bots/examples', requireAuth, async (req, res) => {
  const owner = String(req.userEmail || '').toLowerCase();
  const workspaceId = workspaceIdFromRequest(req);
  const rosterNames = db
    .loadAll(conn, 'bots')
    .filter((a) => workspaceIdForRecord(a) === workspaceId && (workspaceId === DEFAULT_WORKSPACE_ID || sameOwner(a, owner)))
    .map((a) => a.name)
    .filter(Boolean);
  const departments = loadDepartmentsList(owner, workspaceId);
  const cacheKey = `${owner}:${workspaceId}:${crypto
    .createHash('sha256')
    .update(JSON.stringify({ rosterNames: rosterNames.slice().sort(), departments: departments.slice().sort() }))
    .digest('hex')}`;

  const cached = agentExamplesCache.get(cacheKey);
  if (cached) return res.status(200).json({ examples: cached });

  const prompt =
    `${INSTANCE_NAME} is an operating system for ${INSTANCE_TEAM_DESCRIPTION}. ` +
    'Suggest 4 new task bots this team could create next, as short create-bot prompts in the ' +
    'user\'s own voice: imperative, 6 words or fewer, no trailing period, one per line, no numbering, ' +
    'no quotes, no preamble. Do not suggest anything that duplicates a bot they already have.\n\n' +
    `Bots they already have: ${rosterNames.join(', ') || 'none yet'}\n` +
    `Departments: ${departments.join(', ') || 'none yet'}`;

  try {
    const reply = await scheduleInference(
      prompt,
      'suggestion',
      inferenceOptionsForUser(req.userEmail)
    );
    const examples = String(reply || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim().replace(/^["'\-*•]+\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/["'.]+$/, ''))
      .filter((l) => l && l.length <= 60)
      .slice(0, 4);
    if (examples.length) agentExamplesCache.set(cacheKey, examples);
    res.status(200).json({ examples });
  } catch (err) {
    res.status(200).json({ examples: [] });
  }
});

// Chat-native agent setup: turn the user's plain-language intent into an
// editable proposal. No agent, room, or automation is created here; creation
// remains behind the separate explicit confirmation POST /api/bots.
app.post('/api/bots/interpret', requireAuth, async (req, res) => {
  const intent = String((req.body || {}).intent || '').trim().slice(0, 2000);
  if (!intent) return res.status(400).json({ error: 'intent required' });
  let modelSelection;
  try {
    modelSelection = await chatModelSelectionForUser(
      req.body && req.body.modelSelection,
      req.userEmail
    );
  } catch (error) {
    return res.status(409).json({
      error: 'model_selection_unavailable',
      message: userFacingModelDispatchError(error),
    });
  }
  let draft = fallbackAgentDraft(intent);
  try {
    const reply = await scheduleInference(
      buildAgentSetupPrompt(intent),
      'suggestion',
      chatModelSelectionInferenceOptions(
        inferenceOptionsForUser(req.userEmail),
        modelSelection
      )
    );
    draft = normalizeAgentDraft(reply, intent);
  } catch (err) {
    // Naming/setup inference is UX assistance, not an availability boundary.
    // A deterministic proposal still lets the user edit and confirm safely.
  }
  res.status(200).json({ draft });
});

// Live automation status comes from active Hermes cron sessions, not from
// normal native chat dispatches. Keep the payload workspace-scoped and expose
// only the fields the right-hand Automations panel needs.
app.get('/api/automations/active', requireAuth, (req, res) => {
  let runs;
  try {
    runs = cronSync.listActiveBotCronRuns(conn);
  } catch (error) {
    console.error('active automation scan failed', error.message);
    return res.status(503).json({ error: 'automation_status_unavailable' });
  }
  const visible = runs
    .filter((run) => run && run.bot && botVisibleInWorkspace(run.bot, req))
    .map((run) => {
      const conversation = nativeBotConversation(run.bot);
      return {
        id: run.sessionId,
        botId: run.bot.id,
        automationId: run.automationId,
        name: (run.automation && run.automation.name) || run.bot.name || run.bot.id,
        botName: run.bot.name || run.bot.id,
        conversationId: conversation ? conversation.id : null,
        startedAt: run.startedAt,
      };
    });
  res.status(200).json({ runs: visible });
});

// Bot Store: read-only catalog of predefined bots the user can install with
// one click. Served straight from the repo's bots-catalog/ folder — no DB
// table, nothing writable through these routes. Installing a bot goes through
// the existing POST /api/bots create path (see frontend), not through here.
// Registered before the generic bot resource below (fixed multi-segment
// /api/bots routes precede it, same as /api/bots/examples above) so
// registerResource's GET /api/bots/:id cannot shadow 'catalog' as an id.
const BOTS_CATALOG_DIR = path.join(__dirname, '..', 'bots-catalog');
const BOTS_CATALOG_INDEX_PATH = path.join(BOTS_CATALOG_DIR, 'catalog.json');
const BOTS_CATALOG_MANIFEST_DIR = path.join(BOTS_CATALOG_DIR, 'bots');
const BOT_CATALOG_ID_RE = /^[a-z0-9-]+$/;

function readCatalogJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('bot catalog read failed', filePath, error.message);
    return null;
  }
}

app.get('/api/bots/catalog', requireAuth, (req, res) => {
  const index = readCatalogJsonFile(BOTS_CATALOG_INDEX_PATH);
  if (!index) return res.status(404).json({ error: 'catalog_unavailable' });
  res.status(200).json(index);
});

app.get('/api/bots/catalog/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  if (!BOT_CATALOG_ID_RE.test(id)) return res.status(404).json({ error: 'not_found' });
  const manifestPath = path.join(BOTS_CATALOG_MANIFEST_DIR, `${id}.json`);
  // Defense in depth against path traversal even though the id regex above
  // already excludes '/', '.', and any other path-breaking characters.
  if (path.dirname(manifestPath) !== BOTS_CATALOG_MANIFEST_DIR) {
    return res.status(404).json({ error: 'not_found' });
  }
  const manifest = readCatalogJsonFile(manifestPath);
  if (!manifest) return res.status(404).json({ error: 'not_found' });
  res.status(200).json(manifest);
});

// Registered after fixed multi-segment /api/bots routes so :id cannot shadow them.
registerResource({
  path: 'bots',
  table: 'bots',
  singular: 'bot',
  plural: 'bots',
  idGenerator: () => `bot-${crypto.randomUUID()}`,
  maxRecords: MAX_BOTS,
  trackTimeline: true,
  bumpOnMutate: true,
  defaults: { status: 'running', replyAlways: false },
  // Per-user workspace: every agent belongs to exactly one owner (the user
  // who created it, or DEFAULT_OWNER for pre-migration rows — see
  // migrateWorkspaceOwnership). listFilter scopes the list endpoint;
  // accessCheck 404s a GET-one/PUT/DELETE against another user's agent
  // (never 403 — a workspace shouldn't reveal that a given id exists at
  // all); beforeSave stamps ownership at create time, before afterCreate
  // does anything conversation-side.
  listFilter: (record, req) => botVisibleInWorkspace(record, req),
  accessCheck: (record, req) => botVisibleInWorkspace(record, req),
  writeAccessCheck: (record, req) => botMutableInWorkspace(record, req),
  protectedFields: SERVER_OWNED_AGENT_FIELDS,
  beforeSave: (record, req) => {
    // POST bodies can't smuggle these either — stamp/strip regardless of input.
    stripServerOwnedAgentFields(record);
    if (record.avatarColor !== undefined) record.avatarColor = normalizeAgentAvatarColor(record.avatarColor);
    record.owner = String(req.userEmail || '').toLowerCase();
    record.workspaceId = workspaceIdFromRequest(req);
    record.modelProvider = harnessCliProviderForUser(req.userEmail);
    cronSync.migrateBotAutomations(record);
  },
  beforeUpdate: (record, existing, req) => {
    if (record.avatarColor !== undefined) record.avatarColor = normalizeAgentAvatarColor(record.avatarColor);
    if (record.model !== existing.model) record.modelProvider = harnessCliProviderForUser(req.userEmail);
    cronSync.migrateBotAutomations(record);
  },
  prepareUpdate: (record, existing, req) => {
    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'instructions')) return null;
    if (String(record.instructions) === String(existing.instructions)) return null;
    if (!req.body || !req.body.expectedInstructionsRevision) {
      const error = new Error('Reload the bot before saving instructions.');
      error.code = 'INSTRUCTIONS_REVISION_REQUIRED';
      error.statusCode = 409;
      throw error;
    }
    return db.prepareBotPackageUpdate(conn, record, {
      writeInstructions: true,
      instructions: record.instructions,
      expectedRevision: req.body && req.body.expectedInstructionsRevision,
    });
  },
  // Newest-created agent first so a just-created bot lands at the top.
  // createdAt is always set (trackTimeline), the id-suffix compare is just a
  // stable fallback for any pre-existing row that somehow lacks it.
  sort: (a, b) => {
    const at = Date.parse(a.createdAt || '') || 0;
    const bt = Date.parse(b.createdAt || '') || 0;
    if (bt !== at) return bt - at;
    const an = parseInt(String(a.id || '').replace(/\D+/g, ''), 10) || 0;
    const bn = parseInt(String(b.id || '').replace(/\D+/g, ''), 10) || 0;
    return bn - an;
  },
  // Every agent gets a native conversation in the same SQLite database as its
  // agent record. Provisioning is best-effort so a temporary database error
  // does not discard the agent row; the boot reconciler retries it.
  afterCreate: async (record) => {
    delete record.setupIntent;
    await ensureNativeBotConversation(record);
    // Schedule the agent's automation as a Hermes cron job (best-effort —
    // a CLI failure leaves no job and the boot reconcile retries it).
    if (record.status !== 'draft') {
      await syncBotAutomationWithInstructions(record).catch((err) =>
        console.error('cron-sync: failed to schedule automation for', record.id, err.message)
      );
    }
    return record;
  },
  afterPersistUpdate: async (record, existing) => {
    await ensureNativeBotConversation(record);
    // Keep the Hermes cron job in step with the agent's automation config
    // (create/update on enable or schedule change, pause on disable). The
    // record already carries hermesCronJobId from `existing`, so edits and
    // pauses address the right job.
    const cronOperation = record.status === 'draft'
      ? cronSync.removeBotCron(record)
      : syncBotAutomationWithInstructions(record);
    await cronOperation.catch((err) =>
      console.error('cron-sync: failed to sync automation for', record.id, err.message)
    );
    return record;
  },
  mergeAfterPersistUpdate: cronSync.mergeBotCronSyncState,
  afterDelete: async (record) => {
    const deletedAt = new Date().toISOString();
    for (const conversation of nativeBotConversations(record)) {
      nativeConversationRepository.updateConversation({
        companyId: conversation.companyId,
        id: conversation.id,
        deletedAt,
        updatedAt: deletedAt,
      });
    }
    // Deleting the agent removes its cron job — no schedule should outlive
    // the agent that owned it.
    await cronSync.removeBotCron(record);
  },
  // Every persisted bot is deletable, including legacy records marked builtin.
  validate: (body) => {
    if (!String(body.name || '').trim() || !String(body.instructions || '').trim()) {
      return 'name and instructions required';
    }
    if (!String(body.model || '').trim()) return 'connected model required';
    if (body.status && ['draft', 'running', 'watch'].indexOf(body.status) === -1) {
      return 'status must be draft, running, or watch';
    }
    if (body.departments !== undefined && (!Array.isArray(body.departments) || body.departments.some((d) => typeof d !== 'string' || !d.trim()))) {
      return 'departments must be an array of non-empty strings';
    }
    if (body.replyAlways !== undefined && typeof body.replyAlways !== 'boolean') {
      return 'replyAlways must be a boolean';
    }
    if (body.avatarColor !== undefined && !isValidAgentAvatarColor(body.avatarColor)) {
      return 'avatarColor must be a six-digit hex color or null';
    }
    if (body.setupIntent !== undefined && (typeof body.setupIntent !== 'string' || !body.setupIntent.trim() || body.setupIntent.length > 2000)) {
      return 'setupIntent must be a non-empty string up to 2000 characters';
    }
    const automations = body.automations !== undefined
      ? body.automations
      : (body.automation !== undefined ? [body.automation] : []);
    if (!Array.isArray(automations)) return 'automations must be an array';
    if (automations.length > cronSync.MAX_BOT_AUTOMATIONS) return `a bot can have up to ${cronSync.MAX_BOT_AUTOMATIONS} automations`;
    const automationIds = new Set();
    for (const automation of automations) {
      if (!automation || typeof automation !== 'object' || Array.isArray(automation)) return 'each automation must be an object';
      if (automation.id !== undefined && (!/^[a-zA-Z0-9_-]{1,80}$/.test(automation.id) || automationIds.has(automation.id))) {
        return 'automation ids must be unique letters, numbers, dashes, or underscores';
      }
      if (automation.id !== undefined) automationIds.add(automation.id);
      if (body.automations !== undefined && !String(automation.name || '').trim()) return 'automation.name is required';
      if (typeof automation.enabled !== 'boolean') return 'automation.enabled must be a boolean';
      if (['none', 'interval', 'daily', 'weekly', 'monthly'].indexOf(automation.frequency) === -1) return 'automation.frequency is invalid';
      if (automation.enabled && automation.frequency === 'none') return 'enabled automation requires a frequency';
      if (automation.utcOffsetMinutes !== undefined && (!Number.isInteger(automation.utcOffsetMinutes) || automation.utcOffsetMinutes < -840 || automation.utcOffsetMinutes > 720)) return 'automation time zone is invalid';
      if (automation.weekdaysOnly !== undefined && typeof automation.weekdaysOnly !== 'boolean') return 'automation weekdaysOnly must be a boolean';
      if (automation.frequency === 'interval'
        && (!Number.isInteger(automation.intervalMinutes) || automation.intervalMinutes < 1 || automation.intervalMinutes > 1440
          || (automation.intervalMinutes > 60 && automation.intervalMinutes % 60 !== 0))) {
        return 'automation.intervalMinutes must be 1-60 minutes or a whole number of hours up to 24';
      }
      if (automation.day !== undefined && typeof automation.day !== 'string') return 'automation.day must be a string';
      if (automation.time !== undefined && automation.time !== '' && !cronSync.isValidAutomationTime(automation.time)) {
        return 'automation.time must use HH:MM in 24-hour time';
      }
    }
    return null;
  },
});

// Private agents are a different resource from shared task bots. Mia is the
// current trusted agent and is projected only for the authenticated owner and
// selected workspace; there is intentionally no shared list or public lookup.
function privateGatewayAgent(req) {
  const owner = String(req.userEmail || '').toLowerCase();
  const workspaceId = workspaceIdFromRequest(req);
  const companyId = nativeCompanyId(workspaceId, owner);
  const conversation = nativeConversationRepository.listGatewayConversations({ companyId, createdBy: owner })[0];
  if (!conversation) return null;
  const metadata = conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
  return {
    id: metadata.agentId || GATEWAY_AGENT_ID,
    name: conversation.name || 'Mia',
    kind: 'agent',
    owner,
    workspaceId,
    conversationId: conversation.id,
    private: true,
  };
}

app.get('/api/agents', requireAuth, (req, res) => {
  const agent = privateGatewayAgent(req);
  res.status(200).json({ agents: agent ? [agent] : [] });
});

app.get('/api/agents/gateway', requireAuth, (req, res) => {
  const agent = privateGatewayAgent(req);
  if (!agent) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ agent });
});

app.post('/api/bots/:id/departments', requireAuth, async (req, res) => {
  const existing = db.loadOne(conn, 'bots', req.params.id);
  if (!existing || !botMutableInWorkspace(existing, req)) return res.status(404).json({ error: 'not_found' });
  const name = String((req.body || {}).add || '').trim();
  if (!name) return res.status(400).json({ error: 'add (department name) required' });
  const departments = departmentsOf(existing);
  if (!departments.includes(name)) departments.push(name);
  const record = Object.assign({}, existing, { departments, updatedAt: new Date().toISOString() });
  db.saveOne(conn, 'bots', record.id, record);
  await ensureNativeBotConversation(record);
  bumpVersion();
  return res.status(200).json({ bot: record });
});

// Suggests a short professional name for an in-progress agent, given the
// instructions text typed into the create cinema so far. Same 'suggestion'
// inference tier as /api/chat/suggestions above (via scheduleInference) —
// naming is best-effort UX sugar, never allowed to starve real chat replies
// for an inference slot. Never surfaces inference failures as a 500: an
// error/empty reply is something the frontend can just ignore and fall back
// to its own kind-derived name, so this returns 502 (not app-fatal) rather
// than pretending a name exists.
app.post('/api/bots/suggest-name', requireAuth, async (req, res) => {
  const instructions = String((req.body || {}).instructions || '').trim();
  if (!instructions) return res.status(400).json({ error: 'instructions required' });
  const capped = instructions.slice(0, 2000);
  const prompt =
    'Suggest a short, professional name for a task bot whose job is described below. ' +
    'Answer with ONLY the name — 1 to 3 words, no quotes, no punctuation, no preamble.\n\n' +
    capped;

  try {
    const reply = await scheduleInference(
      prompt,
      'suggestion',
      inferenceOptionsForUser(req.userEmail)
    );
    const name = String(reply || '')
      .split(/\r?\n/)[0]
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/[.!?,;:]+$/, '')
      .slice(0, 40)
      .trim();
    if (!name) return res.status(502).json({ error: 'no name suggested' });
    res.status(200).json({ name });
  } catch (err) {
    res.status(502).json({ error: 'suggestion unavailable' });
  }
});

// ---------- bot permissions ----------
// Permission grants are shared IAM policy, not per-user workspace data. Keep
// both the frontend and the effective-permission endpoint behind the same admin
// boundary as the rest of the IAM surface; ordinary members must not be able
// to enumerate or rewrite another account's grants.

const PERMISSION_LEVELS = ['none', 'read', 'write'];
// The resource universe the frontend's mock IAM access model uses today
// (hos-iam-access / IAM_SCOPES in app.js). Grants aren't restricted to this
// list — resource is a free string — but GET /api/permissions advertises it
// as the known set for UI building.
const PERMISSION_RESOURCES = ['Files', 'Web', 'Email', 'Calendar'];

// Mirrors the frontend's hardcoded IAM access model (app.js) so built-in agents
// keep behaving the way the old localStorage demo implied: true -> 'read',
// false -> 'none'. Custom bots (created via /api/bots) have no such
// precedent, so they default to 'none' everywhere until granted.
const BUILTIN_AGENTS = [];
const BUILTIN_DEFAULT_PERMISSIONS = {};

function validateGrant(g) {
  if (!g || typeof g !== 'object') return 'grant must be an object';
  if (g.subjectType !== 'bot' && g.subjectType !== 'department') return 'subjectType must be bot or department';
  const subjectKey = typeof g.subjectKey === 'string' ? g.subjectKey.trim() : '';
  if (!subjectKey || subjectKey.length > 128) return 'subjectKey is required (max 128 chars)';
  const resource = typeof g.resource === 'string' ? g.resource.trim() : '';
  if (!resource || resource.length > 64) return 'resource is required (max 64 chars)';
  if (PERMISSION_LEVELS.indexOf(g.level) === -1) return 'level must be none, read or write';
  return null;
}

app.get('/api/permissions', requireAuth, requireMiaAdmin, (req, res) => {
  res.status(200).json({ resources: PERMISSION_RESOURCES, grants: db.listPermissions(conn) });
});

// Bulk upsert, idempotent. level:'none' is stored as an explicit deny row
// (not deleted) so it can override a lower-tier (department) grant — see
// db.upsertPermission. Returns the full grant list post-write so the caller
// can just replace local state.
app.put('/api/permissions', requireGlobalSettingsAdmin, (req, res) => {
  const grants = (req.body && req.body.grants) || [];
  if (!Array.isArray(grants) || grants.length === 0) {
    return res.status(400).json({ error: 'grants array is required' });
  }
  for (const g of grants) {
    const error = validateGrant(g);
    if (error) return res.status(400).json({ error });
  }
  for (const g of grants) {
    db.upsertPermission(conn, {
      subjectType: g.subjectType,
      subjectKey: g.subjectKey.trim(),
      resource: g.resource.trim(),
      level: g.level,
    });
  }
  bumpVersion();
  res.status(200).json({ ok: true, count: grants.length, resources: PERMISSION_RESOURCES, grants: db.listPermissions(conn) });
});

// An agent belongs to zero or more departments (record.departments, an
// array of department-name strings) and inherits every department's grants.
// record.department (legacy single string, from before multi-department
// membership) is still honored as a one-element array when departments
// isn't present.
function departmentsOf(record) {
  if (!record) return [];
  if (Array.isArray(record.departments)) return record.departments.filter((d) => typeof d === 'string' && d);
  if (typeof record.department === 'string' && record.department) return [record.department];
  return [];
}

// ---------- departments (workspace-scoped list, meta-key backed) ----------
// Was per-browser localStorage; durable workspaces need a server-owned list.
// Stored as a JSON array through the same meta key/value mechanism as the
// conversation_cleared:<conversationId> timestamps above.

const DEFAULT_DEPARTMENTS = [];

function initialDepartmentsForWorkspace(workspaceId, fromAgents) {
  const agentDepartments = Array.from(fromAgents || []).sort((a, b) => a.localeCompare(b));
  if (workspaceId !== DEFAULT_WORKSPACE_ID) return agentDepartments;
  const seeded = DEFAULT_DEPARTMENTS.slice();
  const seededLower = new Set(seeded.map((department) => department.toLowerCase()));
  agentDepartments
    .filter((department) => !seededLower.has(department.toLowerCase()))
    .forEach((department) => seeded.push(department));
  return seeded;
}

// Old Solo reads persisted this exact signature: all default Multiplayer Test workspace defaults first,
// followed by alphabetically sorted bot-derived extras. Remove only unassigned
// defaults from that recognizable legacy seed; preserve custom departments and
// any default-named department an actual Solo bot still uses.
function reconcileLegacySoloDepartments(departments, fromAgents) {
  if (!Array.isArray(departments)) return departments;
  const defaultNames = new Set(DEFAULT_DEPARTMENTS.map((department) => department.toLowerCase()));
  const extras = departments.slice(DEFAULT_DEPARTMENTS.length);
  if (extras.some((department) => typeof department !== 'string' || defaultNames.has(department.toLowerCase()))) {
    return departments;
  }
  const sortedExtras = extras.slice().sort((a, b) => a.localeCompare(b));
  if (extras.some((department, index) => department !== sortedExtras[index])) return departments;
  const assigned = new Set(Array.from(fromAgents || []).map((department) => department.toLowerCase()));
  return departments.filter((department, index) =>
    index >= DEFAULT_DEPARTMENTS.length || assigned.has(department.toLowerCase())
  );
}

// First read ever (per owner/workspace): the default Multiplayer Test workspace keeps its
// established defaults plus bot-derived extras. Solo starts only from this
// owner's actual Solo bot departments, or an empty list. Stored under the
// workspace-scoped meta key so reconciling Solo never mutates the default
// Multiplayer Test workspace's department data.
function loadDepartmentsList(email, workspaceId = DEFAULT_WORKSPACE_ID) {
  const owner = String(email || DEFAULT_OWNER).toLowerCase();
  const normalizedWorkspaceId = workspaceIdForRecord({ workspaceId });
  const metaKey = departmentsMetaKey(owner, normalizedWorkspaceId);
  const raw = db.getMeta(conn, metaKey);
  let parsed = null;
  if (raw !== null) {
    try {
      const candidate = JSON.parse(raw);
      if (Array.isArray(candidate)) parsed = candidate;
    } catch (err) {
      // fall through to reseed on corrupt meta
    }
  }
  if (normalizedWorkspaceId === DEFAULT_WORKSPACE_ID && parsed && parsed.length) return parsed;
  const fromAgents = new Set();
  for (const bot of db.loadAll(conn, 'bots')) {
    if (workspaceIdForRecord(bot) !== normalizedWorkspaceId) continue;
    if (normalizedWorkspaceId !== DEFAULT_WORKSPACE_ID && !sameOwner(bot, owner)) continue;
    for (const d of departmentsOf(bot)) fromAgents.add(d);
  }
  if (normalizedWorkspaceId !== DEFAULT_WORKSPACE_ID && parsed) {
    const reconciled = reconcileLegacySoloDepartments(parsed, fromAgents);
    if (JSON.stringify(reconciled) !== JSON.stringify(parsed)) {
      db.setMeta(conn, metaKey, JSON.stringify(reconciled));
    }
    return reconciled;
  }
  const seeded = initialDepartmentsForWorkspace(normalizedWorkspaceId, fromAgents);
  db.setMeta(conn, metaKey, JSON.stringify(seeded));
  return seeded;
}

function validateDepartmentsList(departments) {
  if (!Array.isArray(departments) || departments.length === 0) return 'departments array is required';
  if (departments.length > 50) return 'departments: max 50 entries';
  for (const d of departments) {
    if (typeof d !== 'string' || d.trim().length < 1 || d.trim().length > 40) {
      return 'departments: each entry must be a 1-40 character non-empty string';
    }
  }
  return null;
}

function dedupeDepartmentsCaseInsensitive(departments) {
  const seen = new Set();
  const out = [];
  for (const raw of departments) {
    const trimmed = raw.trim();
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

app.get('/api/departments', requireAuth, (req, res) => {
  res.status(200).json({ departments: loadDepartmentsList(req.userEmail, workspaceIdFromRequest(req)) });
});

app.put('/api/departments', requireAuth, (req, res) => {
  const departments = (req.body || {}).departments;
  const error = validateDepartmentsList(departments);
  if (error) return res.status(400).json({ error });
  const stored = dedupeDepartmentsCaseInsensitive(departments);
  db.setMeta(conn, departmentsMetaKey(req.userEmail, workspaceIdFromRequest(req)), JSON.stringify(stored));
  bumpVersion();
  res.status(200).json({ departments: stored });
});

const LEVEL_RANK = { none: 0, read: 1, write: 2 };

// Most-permissive-wins union across an agent's departments for one resource:
// a department that doesn't grant the resource at all doesn't participate,
// so an explicit department-level 'none' only shows through if no sibling
// department grants read/write — joining a department adds capability, it
// never takes capability away from another department's grant.
function unionDepartmentGrant(departmentGrants, resource) {
  let best = null;
  for (const { department, grants } of departmentGrants) {
    if (!grants.has(resource)) continue;
    const level = grants.get(resource);
    if (!best || LEVEL_RANK[level] > LEVEL_RANK[best.level]) best = { level, department };
  }
  return best;
}

// Resolved effective permissions for one agent: an agent-level grant wins
// outright, including an explicit agent-level 'none' overriding department
// grants — that stays an absolute override, unlike the department union
// below. Short of an agent-level grant, resources are resolved from the
// most-permissive grant across the agent's departments, then the built-in/
// custom default. Registered after the fixed /api/bots/... feed routes
// and the agents CRUD block above for the same route-ordering reason those
// are — this is a 2-segment path (:id/permissions) so it can't actually
// collide with the single-segment :id routes, but keeping it in this spot
// keeps the ordering story in one place instead of split across the file.
app.get('/api/bots/:id/permissions', requireAuth, requireMiaAdmin, (req, res) => {
  const id = req.params.id;
  const record = db.loadOne(conn, 'bots', id);
  const isBuiltin = !record && BUILTIN_AGENTS.indexOf(id) !== -1;
  if (!record && !isBuiltin) return res.status(404).json({ error: 'not_found' });

  const departments = departmentsOf(record);
  const defaults = isBuiltin ? BUILTIN_DEFAULT_PERMISSIONS[id] || {} : {};

  const botGrants = new Map(db.getPermissionsFor(conn, 'bot', id).map((r) => [r.resource, r.level]));
  const departmentGrants = departments.map((department) => ({
    department,
    grants: new Map(db.getPermissionsFor(conn, 'department', department).map((r) => [r.resource, r.level])),
  }));

  const resourceSet = new Set(PERMISSION_RESOURCES);
  for (const r of botGrants.keys()) resourceSet.add(r);
  for (const { grants } of departmentGrants) for (const r of grants.keys()) resourceSet.add(r);
  for (const r of Object.keys(defaults)) resourceSet.add(r);

  const permissions = Array.from(resourceSet)
    .sort()
    .map((resource) => {
      if (botGrants.has(resource)) return { resource, level: botGrants.get(resource), source: 'bot' };
      const won = unionDepartmentGrant(departmentGrants, resource);
      if (won) return { resource, level: won.level, source: 'department', sourceDepartment: won.department };
      return { resource, level: defaults[resource] || 'none', source: 'default' };
    });

  res.status(200).json({ botId: id, kind: isBuiltin ? 'builtin' : 'custom', departments, permissions });
});


function senderDisplayName(sender) {
  const raw = String(sender || '');
  if (!raw.includes('@')) return raw;
  const email = raw.toLowerCase();
  const user = db.listUsers(conn).find((u) => u.email.toLowerCase() === email);
  if (user && user.displayName) return user.displayName;
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!local) return raw;
  return local.length <= 3 ? local.toUpperCase() : local.replace(/\b\w/g, (c) => c.toUpperCase());
}

function confirmedSenderDisplayName(sender) {
  const raw = String(sender || '');
  if (!raw.includes('@')) return raw;
  const email = raw.toLowerCase();
  const user = db.listUsers(conn).find((candidate) => candidate.email.toLowerCase() === email);
  return user && user.displayName ? String(user.displayName).trim() : '';
}


function buildPlatformContext(includeAgentCreationGuidance, ownerEmail, companyId = NATIVE_COMPANY_ID) {
  const today = new Date().toISOString().slice(0, 10);
  // Bot roster and departments are the only app state Mia needs in ordinary
  // chat. Retired vertical-specific tables must not leak into a generic OSS
  // installation's prompt just because their legacy storage still exists.
  const agents = db.loadAll(conn, 'bots').filter((a) => recordBelongsToCompany(a, NATIVE_COMPANY_ID, companyId));
  const workspaceId = companyId === NATIVE_COMPANY_ID ? DEFAULT_WORKSPACE_ID : 'solo';
  const departments = loadDepartmentsList(ownerEmail, workspaceId);

  const agentSample = agents.slice(0, 8).map((a) => a.name).filter(Boolean);
  const agentsLine = agents.length
    ? `Bot roster (${agents.length}): ${agentSample.join(', ')}${agents.length > agentSample.length ? ', ...' : ''}.`
    : 'No bots created yet.';

  const lines = [
    `Instance: ${INSTANCE_NAME}, an operating system for ${INSTANCE_TEAM_DESCRIPTION}. Today is ${today}.`,
    `Departments: ${departments.length ? departments.join(', ') : 'none configured'}.`,
    agentsLine,
    `Available workspace surfaces include chat, bots, connected apps, documents, a web browser, and settings.`,
    `If a question needs facts beyond this conversation or connected apps — such as current ` +
      `research or news — use the tools available in the ` +
      `configured harness when they are available; otherwise say plainly you don't ` +
      `have enough information.`,
  ];

  if (includeAgentCreationGuidance) {
    lines.push(
      `You're a shared conversation assistant here, not a dedicated agent. If the user asks for ` +
        `a specific, recurring job (not just a question), briefly point them to the ` +
        `Bots layer -> "New bot" to describe a reusable task bot for that first, then ` +
        `still help with what you can right now.`
    );
  }

  return lines.join('\n');
}

// Mia is a default Chief-of-Staff member in every agent-capable chat. The
// roster entry is synthetic because Mia is the manager persona, not a row in
// the user-created agents table; Mia is the shared manager identity that
// posts her replies.
function miaRosterAgent(department) {
  return {
    id: 'gateway',
    name: 'Mia',
    department: department || 'Mia',
    manager: true,
    replyAlways: true,
    inChat: true,
    status: 'idle',
  };
}

// Mia — the manager persona answering "@mia" / "@mia os" in the home
// room. Not an agents row: built fresh per message so the roster block in
// extraContext (appended to the platform context by runRoomReplyJob) is
// always current. `manager: true` is what makes runRoomReplyJob scan her
// reply for "@Name" handoffs afterwards; real agents never carry the flag,
// so a called-in agent's own reply can't recursively call anyone else.
function miaManagerAgent(ownerEmail, companyId = NATIVE_COMPANY_ID) {
  const agents = db.loadAll(conn, 'bots').filter((a) => recordBelongsToCompany(a, NATIVE_COMPANY_ID, companyId));
  const roster = agents.map((a) => {
    const depts = departmentsOf(a).join('/') || 'no department';
    const what = String(a.instructions || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    return `- ${a.name} (${depts})${what ? `: ${what}` : ''}`;
  });
  return {
    id: 'gateway',
    name: 'Mia',
    department: 'Mia',
    manager: true,
    instructions:
      `You are Mia, the owner's private trusted agent and manager of the shared task bots ` +
      `in this workspace. Your full bot roster is in the context below. When the user asks ` +
      `who can help, or asks for work a bot should own, pick the best bot and hand off by ` +
      `@-mentioning it by its exact ` +
      `name (e.g. "@Researcher X") in your reply, with a one-line brief of what it ` +
      `should do — a mentioned bot is automatically called in and will reply here. ` +
      `Only @-mention a bot when you actually want it to act, and hand off to at ` +
      `most 3 bots in one reply. You are the only agent who may manage bots; ` +
      `when the user tags several bots at once you coordinate them (a short acknowledgment, ` +
      `each bot working in its own thread, your summary after). When LISTING or describing bots — a roster ` +
      `answer, a who-does-what overview — never put @ before their names: every ` +
      `@-name calls that bot into the conversation, so an @-prefixed list summons the ` +
      `whole team to introduce themselves. Write list entries as plain names ` +
      `("Researcher X — web investigation"). If nobody fits, say so and suggest ` +
      `creating a new bot for it`,
    extraContext:
      `Full bot roster (name (departments): what they do):\n` +
      (roster.length ? roster.join('\n') : '(no bots created yet)'),
  };
}

function miaReplyAgent(ownerEmail, department, companyId) {
  return Object.assign(miaManagerAgent(ownerEmail, companyId), miaRosterAgent(department));
}


function nativeEventText(event) {
  const content = event && event.content && typeof event.content === 'object' ? event.content : {};
  if (typeof content.text === 'string') return content.text.trim();
  if (typeof content.body === 'string') return content.body.trim();
  if (typeof content.message === 'string') return content.message.trim();
  return '';
}

function isNativeProgressEvent(event) {
  return Boolean(event && event.metadata && event.metadata.progress === true);
}

function nativePromptLine(event) {
  const body = nativeEventText(event);
  if (!body) return null;
  if (event.senderType === 'agent' || event.senderType === 'bot') {
    const bot = event.senderType === 'bot' ? db.loadOne(conn, 'bots', event.senderId) : null;
    const name = event.senderId === 'gateway'
      ? 'Mia'
      : (bot && bot.name ? bot.name : event.senderId);
    return `[${name}] ${body}`;
  }
  if (event.senderType === 'system') return body;
  return `${senderDisplayName(event.senderId)}: ${body}`;
}

function allNativeConversationEvents({ companyId, conversationId, includeDeleted = false, excludedSenderTypes = [] }) {
  const events = [];
  let afterSequence = null;
  let hasMore = true;
  while (hasMore) {
    const page = nativeConversationRepository.listEvents({
      companyId,
      conversationId,
      includeDeleted,
      limit: 100,
      excludedSenderTypes,
      ...(afterSequence === null ? {} : { afterSequence }),
    });
    events.push(...page.events);
    hasMore = page.hasMore;
    afterSequence = page.nextAfterSequence;
  }
  return events;
}

function nativeDispatchActor(dispatch, conversation, trigger) {
  if (dispatch.targetType === 'gateway') {
    const department = conversation.metadata && conversation.metadata.department;
    return miaReplyAgent(trigger.senderId, department || 'Mia', conversation.companyId);
  }
  const bot = db.loadOne(conn, 'bots', dispatch.targetId);
  if (!bot || !recordBelongsToCompany(bot, NATIVE_COMPANY_ID, conversation.companyId)) {
    throw new Error(`native bot ${dispatch.targetId} not found`);
  }
  return Object.assign({}, bot, {
    department: bot.department || departmentsOf(bot)[0] || 'Mia',
  });
}

function nativeBotCreationRequest(message) {
  const text = String(message || '').trim();
  // Questions about the product ("how do I create a bot?") are answered by
  // Mia, never turned into a creation side effect.
  if (/^(?:how|what|why|where|when|which|is|are|does|do i|should)\b/i.test(text.replace(/^(?:hey|hi|hello|mia)[,!\s]+/i, ''))) return null;
  // Explicitly named forms: "create/make/build/add/set up a (new) bot/agent
  // named/called X [that/who/to Y]".
  const named = /\b(?:create|make|build|add|set\s*up|spin\s*up)\s+(?:an?\s+)?(?:new\s+)?(?:bot|agent)\s+(?:named|called)\s+["']?([^"'\n]+?)["']?(?:\s+(?:that|who|to)\s+(.+?))?[.!?]?\s*$/i.exec(text);
  if (named) {
    return {
      name: named[1].trim(),
      role: (named[2] || '').trim() || 'Help with the work described in the request.',
    };
  }
  // Descriptive form with no explicit name: "can we create a newsletter
  // agent?", "make a research bot that tracks AI papers". The words between
  // the verb and bot/agent name the bot; a trailing that/who/to clause is
  // its role.
  const descriptive = /\b(?:create|make|build|add|set\s*up|spin\s*up)\s+(?:an?\s+)?(?:new\s+)?((?:[A-Za-z][\w-]*\s+){0,4}?)(?:bot|agent)\b\s*(.*)$/i.exec(text);
  if (!descriptive) return null;
  const modifier = String(descriptive[1] || '').replace(/\b(?:new|another|little|simple|quick)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const clause = /^(?:that|who|to)\s+(.+?)[.!?]?\s*$/i.exec(String(descriptive[2] || '').trim());
  if (!modifier && !clause) return null;
  const name = modifier
    ? modifier.split(/\s+/).slice(0, 3).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ')
    : null;
  const role = clause
    ? clause[1].trim()
    : `Help with ${modifier.toLowerCase()} work.`;
  if (!name) {
    // "create a bot that tracks AI news" — name it from the role's leading words.
    const roleWords = role.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter((word) =>
      word && !/^(?:the|a|an|my|our|and|for|with|that|who|to)$/i.test(word)).slice(0, 2);
    if (!roleWords.length) return null;
    return {
      name: roleWords.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' '),
      role,
    };
  }
  return { name, role };
}

function nativeReplyParentEventId(trigger) {
  // A normal chat event is already a root message. Only preserve an existing
  // parent when the user explicitly replied from an open thread; automatic Mia
  // replies must stay in the main conversation instead of turning every
  // ordinary @Mia exchange into a thread.
  return trigger && trigger.parentEventId ? trigger.parentEventId : null;
}

function nativeMiaHandoffBots(conversation, reply) {
  if (!conversation || conversation.type === 'bot') return [];
  const roster = db.loadAll(conn, 'bots')
    .filter((bot) => recordBelongsToCompany(bot, NATIVE_COMPANY_ID, conversation.companyId))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      manager: false,
      principalType: 'bot',
    }));
  return resolveMentionedBots(reply, roster);
}

function createNativeDispatchReplyEvent(dispatch, trigger, input) {
  const conversation = nativeConversationRepository.getConversation({
    companyId: dispatch.companyId,
    id: dispatch.conversationId,
  });
  if (dispatch.targetType === 'gateway' && conversation.type !== 'agent') {
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    return nativeConversationService.createInvokedAgentEvent({
      ...input,
      companyId: dispatch.companyId,
      dispatchId: dispatch.id,
    });
  }
  return createNativeDispatchEvent(dispatch, trigger, {
    ...input,
    companyId: dispatch.companyId,
    conversationId: dispatch.conversationId,
    principal: {
      companyId: dispatch.companyId,
      principalId: dispatch.targetType === 'gateway' ? 'gateway' : dispatch.targetId,
      principalType: dispatch.targetType === 'gateway' ? 'agent' : 'bot',
    },
  });
}

// The legacy room transport used to turn Mia's @-mentions into worker calls after her message
// posted. Native conversations mirror the user's delegated request into each
// bot's own chat; the private Mia conversation remains a strict 1:1.
async function enqueueNativeMiaHandoffs(conversation, trigger, miaEvent, reply, dispatch = null) {
  if (dispatch && cancelNativeDispatchForInactiveUser(dispatch, trigger)) return [];
  const bots = nativeMiaHandoffBots(conversation, reply);
  if (!bots.length) return [];
  const text = nativeEventText(trigger);
  return Promise.all(bots.map(async (bot) => {
    if (dispatch && cancelNativeDispatchForInactiveUser(dispatch, trigger)) return null;
    const botConversation = await ensureNativeBotConversation(bot);
    if (!botConversation) return null;
    const result = createNativeDispatchEvent(dispatch, trigger, {
      companyId: botConversation.companyId,
      conversationId: botConversation.id,
      principal: {
        companyId: botConversation.companyId,
        principalId: trigger.senderId,
        principalType: 'user',
      },
      type: 'message',
      content: { text },
      clientIdempotencyKey: `native-mia-handoff-${miaEvent.id}-${bot.id}`,
      metadata: {
        delegatedBy: 'gateway',
        sourceConversationId: conversation.id,
        sourceEventId: trigger.id,
      },
      routing: {
        oneToOneAgent: {
          id: bot.id,
          name: bot.name || bot.id,
          manager: false,
          principalType: 'bot',
        },
        metadata: {
          runtime: 'hermes',
          kind: 'mia-handoff',
          sourceEventId: miaEvent.id,
          botName: bot.name || bot.id,
        },
      },
    });
    return result.dispatch || null;
  }));
}

async function createNativeBotFromMiaRequest(companyId, ownerEmail, message, model, modelProvider) {
  const request = nativeBotCreationRequest(message);
  if (!request || !request.name || !request.role) return null;
  if (!model) throw new Error('Choose a connected model before asking Mia to create a bot');
  if (!modelProvider) throw new Error('Choose a connected model provider before asking Mia to create a bot');
  const owner = String(ownerEmail || '').trim().toLowerCase();
  const name = request.name.slice(0, 40);
  const role = request.role.slice(0, 500);
  let bot = db.loadAll(conn, 'bots').find((candidate) =>
    recordBelongsToCompany(candidate, NATIVE_COMPANY_ID, companyId)
      && String(candidate.name || '').trim().toLowerCase() === name.toLowerCase()
  );
  if (!bot) {
    const existingBots = db.loadAll(conn, 'bots');
    if (existingBots.length >= MAX_BOTS) throw new Error(`This Mia installation supports up to ${MAX_BOTS} bots.`);
    const now = new Date().toISOString();
    bot = {
      id: `bot-${crypto.randomUUID()}`,
      name,
      role,
      output: 'A clear one-sentence answer to the user’s question.',
      instructions: `Role: ${role}\n\nDesired output: A clear one-sentence answer to the user’s question.`,
      model,
      modelProvider,
      status: 'running',
      replyAlways: false,
      departments: [],
      owner,
      workspaceId: companyId === NATIVE_COMPANY_ID ? DEFAULT_WORKSPACE_ID : 'solo',
      createdAt: now,
      updatedAt: now,
      timeline: [{ ts: now, event: 'bot created by Mia in native channel' }],
    };
    db.insertOne(conn, 'bots', bot.id, bot);
    bumpVersion();
  }
  const conversation = nativeConversationRepository.listConversations({ companyId, limit: 1000 }).find((candidate) => {
    const metadata = candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {};
    return candidate.type === 'bot' && metadata.botId === bot.id;
  }) || await ensureNativeBotConversation(bot);
  return { bot, conversation };
}

// Native dispatches are already durable: the dispatch row is claimed before
// this function runs and completed only after the final agent event is saved.
// Keep the prompt builder explicit so the same authenticated-owner Google
// context and write capability are carried into that durable Hermes call.
function buildHermesTaskPrompt(agentForPrompt, transcript, message, senderLabel, workspaceContext, googleResourceRefs, allowGoogleWorkspaceWrite, globalInstructions) {
  const basePrompt = buildBotContext(
    agentForPrompt,
    transcript,
    message,
    workspaceContext,
    senderLabel ? confirmedSenderDisplayName(senderLabel) : '',
    globalInstructions
  );
  const actionInstruction = allowGoogleWorkspaceWrite
    && /authoritative server state\): CONNECTED/.test(String(workspaceContext || ''))
    ? googleWorkspaceActions.googleWorkspaceActionInstruction(
      googleResourceRefs,
      googleWorkspaceActions.googleWorkspaceWriteKinds(message, googleResourceRefs)
    )
    : '';
  return [basePrompt, appOwnedToolPolicy({ botWorker: true }), actionInstruction].filter(Boolean).join('\n\n');
}

function buildHermesGatewaySystemPrompt(agentForPrompt, senderLabel, globalInstructions) {
  // The legacy gateway session carried the persona and browser boundary for the
  // room, then received only the new user message on each turn. Native Mia
  // keeps that same shape: the durable native transcript is seeded once and
  // Hermes owns the ongoing tool/session history after that.
  const basePrompt = buildContext(
    agentForPrompt,
    [],
    '',
    '',
    senderLabel ? senderDisplayName(senderLabel) : '',
    globalInstructions
  );
  const onboardingGuide = 'For a new user, help them get one useful thing done. Ask one relevant question at a time. If they ask to be shown around, briefly explain chat, connected apps, bots, and automations, then offer a small first task. Do not require a biography or invent a name from an email address. Respect the preferred name confirmed in the conversation.';
  return [basePrompt, onboardingGuide, loadMiaGhostSkill(), miaosAgentWorkspacePromptContext()].filter(Boolean).join('\n\n');
}

function miaosAgentWorkspacePromptContext() {
  // Search-only releases intentionally have no terminal or file tools. Do not
  // advertise a local workspace or ghost_file_open path in that profile.
  return EFFECTIVE_RELEASE_PROFILE.agentSearchOnly ? '' : miaosWorkspacePromptContext();
}

function buildHermesGatewayTurnMessage(message, senderLabel, workspaceContext, googleResourceRefs, allowGoogleWorkspaceWrite, globalInstructions) {
  const actionInstruction = allowGoogleWorkspaceWrite
    && /authoritative server state\): CONNECTED/.test(String(workspaceContext || ''))
    ? googleWorkspaceActions.googleWorkspaceActionInstruction(
      googleResourceRefs,
      googleWorkspaceActions.googleWorkspaceWriteKinds(message, googleResourceRefs)
    )
    : '';
  const currentContext = workspaceContext
    ? `Current Mia platform state for this turn:\n${workspaceContext}`
    : '';
  const userLine = `${senderLabel ? senderDisplayName(senderLabel) : 'user'}: ${String(message || '').trim()}`;
  const instructionSection = userInstructionSection('Agent', globalInstructions);
  // A Hermes session can outlive a Mia backend or browser bridge restart.
  // Repeat the complete app-owned browser contract on every turn so a resumed
  // session probes current native state instead of trusting stale history or
  // the system prompt from when the session was first created.
  return [currentContext, miaosAgentWorkspacePromptContext(), actionInstruction, loadMiaGhostSkill(), instructionSection, userLine]
    .filter(Boolean).join('\n\n');
}

function nativeHermesGatewaySeedMessages(systemPrompt, events, triggerId) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const event of events || []) {
    if (!event || event.id === triggerId || isNativeProgressEvent(event)) continue;
    const body = nativeEventText(event);
    if (!body) continue;
    const role = event.senderType === 'agent' || event.senderType === 'bot'
      ? 'assistant'
      : event.senderType === 'system' ? 'system' : 'user';
    messages.push({ role, content: nativePromptLine(event) || body });
  }
  return messages;
}

function persistNativeHermesGatewaySession(conversation, eventId, storedSessionId, profile) {
  if (!conversation || !eventId || !storedSessionId) return conversation;
  return nativeConversationRepository.persistGatewaySessionIfEventLive({
    companyId: conversation.companyId,
    conversationId: conversation.id,
    eventId,
    sessionId: storedSessionId,
    profile,
    updatedAt: new Date().toISOString(),
  });
}

function googleNativeActionError(code, userMessage) {
  const error = new Error(code);
  error.code = code;
  error.userMessage = userMessage;
  return error;
}

function redactHermesChatDetail(value) {
  let text = String(value || '');
  text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  text = text.replace(/(["']?(?:api[_-]?key|token|password|secret|client_secret)["']?\s*[:=]\s*)["']?[^"'\s,;}]+["']?/gi, '$1[REDACTED]');
  // The runtime's name never reaches the transcript: verbose output is a
  // regular user-facing setting now, and the product surface says "agent".
  text = text.replace(/Hermes/g, 'Agent').replace(/hermes/g, 'agent').replace(/HERMES/g, 'AGENT');
  return text;
}

function hermesDebugEventText(type, payload) {
  const eventType = String(type || '').trim();
  const event = payload && typeof payload === 'object' ? payload : {};
  if (!eventType || [
    'gateway.ready',
    'message.start',
    'message.delta',
    'message.complete',
    'thinking.delta',
    'reasoning.delta',
    'session.info',
  ].includes(eventType)) return '';

  if (eventType === 'message.interim') {
    return redactHermesChatDetail(event.text || event.rendered || '');
  }
  if (eventType === 'reasoning.available') {
    const reasoning = redactHermesChatDetail(event.text || '');
    return reasoning ? `Reasoning summary\n${reasoning}` : '';
  }
  if (eventType === 'status.update') {
    const status = redactHermesChatDetail(event.text || event.message || '');
    const kind = String(event.kind || '').trim();
    return status ? `Status${kind ? ` — ${kind}` : ''}\n${status}` : '';
  }

  const name = String(event.name || event.tool || '').trim();
  const lines = [`Debug · ${eventType}${name ? ` — ${name}` : ''}`];
  const args = event.args || event.arguments || event.input;
  const argsText = event.args_text || (args
    ? (typeof args === 'string' ? args : JSON.stringify(args, null, 2))
    : '');
  if (argsText) lines.push(`Arguments:\n${redactHermesChatDetail(argsText)}`);
  if (event.context && !argsText) lines.push(`Context: ${redactHermesChatDetail(event.context)}`);

  const result = event.result_text !== undefined ? event.result_text
    : event.result !== undefined ? event.result
      : event.output !== undefined ? event.output
        : event.error !== undefined ? event.error
          : event.text !== undefined ? event.text
            : undefined;
  if (result !== undefined && result !== '') {
    lines.push(`Result:\n${redactHermesChatDetail(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}`);
  }
  if (event.summary) lines.push(`Summary: ${redactHermesChatDetail(event.summary)}`);
  if (event.inline_diff) lines.push(`Diff:\n${redactHermesChatDetail(event.inline_diff)}`);
  if (event.duration_s !== undefined) lines.push(`Duration: ${Number(event.duration_s).toFixed(2)}s`);

  if (lines.length === 1) {
    const details = { ...event };
    delete details.session_id;
    delete details.name;
    delete details.tool;
    if (Object.keys(details).length) lines.push(`Details:\n${redactHermesChatDetail(JSON.stringify(details, null, 2))}`);
  }
  return lines.join('\n');
}

function splitHermesDebugText(text, maxLength = 7000) {
  const source = String(text || '');
  if (!source) return [];
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += maxLength) {
    chunks.push(source.slice(offset, offset + maxLength));
  }
  return chunks;
}

// The gateway emits one thinking/reasoning delta per token, so verbose mode
// cannot post a progress event per event without spamming the transcript.
// This buffers consecutive same-kind deltas and hands the caller one string
// to post, on whichever comes first: the char cap (cut at a sentence or
// line boundary, never mid-word), the idle timer (which resets on every
// delta, so an actively streaming burst is never chopped mid-thought), or
// an explicit flush (a kind switch, or a caller-chosen boundary such as
// message.complete/status change).
const HERMES_DELTA_FLUSH_CHARS = 1200;
const HERMES_DELTA_FLUSH_MS = 1500;

// Where to cut an over-cap buffer: the last newline or sentence end inside
// the cap, provided it keeps at least half a chunk; otherwise the last
// whitespace; only a truly unbroken run gets a hard cut at the cap.
function hermesDeltaCutIndex(buffer) {
  const window = buffer.slice(0, HERMES_DELTA_FLUSH_CHARS);
  const minimum = Math.floor(HERMES_DELTA_FLUSH_CHARS / 2);
  const newline = window.lastIndexOf('\n');
  if (newline >= minimum) return newline + 1;
  const sentence = Math.max(
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentence >= minimum) return sentence + 2;
  const space = window.lastIndexOf(' ');
  if (space >= minimum) return space + 1;
  return HERMES_DELTA_FLUSH_CHARS;
}

function createHermesDeltaCoalescer(onFlush) {
  let buffer = '';
  let kind = null;
  let timer = null;
  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function emit(text, flushedKind) {
    if (text) onFlush(flushedKind, text);
  }
  function flush() {
    clearTimer();
    if (!buffer) return;
    const text = buffer;
    const flushedKind = kind;
    buffer = '';
    kind = null;
    emit(text, flushedKind);
  }
  return {
    push(eventKind, text) {
      if (!text) return;
      if (kind && kind !== eventKind) flush();
      kind = eventKind;
      buffer += text;
      while (buffer.length >= HERMES_DELTA_FLUSH_CHARS) {
        const cut = hermesDeltaCutIndex(buffer);
        emit(buffer.slice(0, cut), kind);
        buffer = buffer.slice(cut);
      }
      // Idle timer, not a deadline: reset on every delta so a continuous
      // stream coalesces until it pauses (or hits the char cap above).
      clearTimer();
      if (buffer) timer = setTimeout(flush, HERMES_DELTA_FLUSH_MS);
    },
    flush,
  };
}

function throwIfNativeGoogleActionStopped(dispatch, trigger, signal) {
  // The deletion barrier and the dispatch AbortController are deliberately
  // checked together. A user can be revoked before db.deleteUser() commits,
  // while an in-memory dispatch can also be stopped independently.
  throwIfNativeDispatchStopped(signal);
  throwIfNativeDispatchUserInactive(dispatch, trigger);
}

function deletionGuardedGoogleConnector(connector, dispatch, trigger, signal) {
  const guard = () => throwIfNativeGoogleActionStopped(dispatch, trigger, signal);
  return {
    status: async (...args) => {
      guard();
      const result = await connector.status(...args);
      // A status/read that was already in flight must not open the write
      // boundary after the owner is revoked.
      guard();
      return result;
    },
    runOperation: async (operation, args) => {
      // This is the last server-side check before the connector can invoke
      // the provider. The optional third argument lets a future connector
      // propagate the AbortSignal down to a cancellable provider call while
      // preserving the current connector's two-argument contract.
      guard();
      const result = await connector.runOperation(operation, args, { signal });
      // Do not allow a stale provider result to reach native persistence.
      // The current gws connector cannot roll back a provider call that has
      // already started; only the pre-call guard can prevent that mutation.
      guard();
      return result;
    },
  };
}

async function applyNativeGoogleWorkspaceAction({
  ownerEmail,
  rawResult,
  googleResourceRefs,
  googleWorkspaceWriteAuthorized,
  googleWorkspaceWriteKinds,
  dispatch,
  trigger,
  signal,
}) {
  throwIfNativeGoogleActionStopped(dispatch, trigger, signal);
  const writeSubject = Array.isArray(googleWorkspaceWriteKinds)
    && googleWorkspaceWriteKinds.length === 1
    && googleWorkspaceWriteKinds[0] === 'docs'
    ? 'document'
    : 'spreadsheet';
  // `ownerEmail` is intentionally supplied by the authenticated native event
  // and never accepted from model output. The Hermes connector owns the
  // account credential; this binding keeps the action tied to this dispatch's
  // authenticated owner at the server boundary.
  if (!String(ownerEmail || '').trim()) {
    throw googleNativeActionError(
      'unauthorized_google_workspace_action',
      `I didn't change the ${writeSubject} because the authenticated owner was missing.`
    );
  }
  const ownerConnector = googleAccountOwnerBinding.connectorFor(ownerEmail);
  if (!ownerConnector) {
    throw googleNativeActionError(
      'unauthorized_google_workspace_action',
      `I didn't change the ${writeSubject} because this Google account belongs to another Mia user.`
    );
  }
  const extracted = googleWorkspaceActions.extractGoogleWorkspaceAction(rawResult);
  throwIfNativeGoogleActionStopped(dispatch, trigger, signal);
  if (extracted.error) {
    throw googleNativeActionError(
      'invalid_google_workspace_action',
      `I couldn't safely apply the ${writeSubject} update. Please try again.`
    );
  }
  if (!extracted.action) return extracted.text;
  const actionKind = googleWorkspaceActions.googleWorkspaceActionKind(extracted.action);
  if (googleWorkspaceWriteAuthorized !== true
    || (actionKind && (!Array.isArray(googleWorkspaceWriteKinds) || !googleWorkspaceWriteKinds.includes(actionKind)))) {
    throw googleNativeActionError(
      'unauthorized_google_workspace_action',
      `I didn't change the ${actionKind === 'docs' ? 'document' : writeSubject} because this request did not explicitly authorize a write.`
    );
  }

  try {
    const guardedConnector = deletionGuardedGoogleConnector(ownerConnector, dispatch, trigger, signal);
    const applied = await googleWorkspaceActions.applyGoogleWorkspaceAction({
      action: extracted.action,
      refs: googleResourceRefs,
      connector: guardedConnector,
    });
    throwIfNativeGoogleActionStopped(dispatch, trigger, signal);
    return extracted.text || (actionKind === 'docs'
      ? 'Edited the shared Google Doc.'
      : `Updated ${applied.updatedCells} cells in the shared spreadsheet.`);
  } catch (err) {
    // Preserve cancellation semantics so executeNativeConversationDispatch
    // does not turn a revoked user's stale Google turn into a failure reply.
    // applyGoogleWorkspaceAction intentionally normalizes connector.status()
    // errors to reconnect_required, so re-check the owner barrier here before
    // translating any provider error into a user-facing action error.
    throwIfNativeGoogleActionStopped(dispatch, trigger, signal);
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw err;
    if (err && err.code === 'google_workspace_reconnect_required') {
      throw googleNativeActionError(
        err.code,
        `I couldn't update the ${actionKind === 'docs' ? 'document' : 'spreadsheet'} because Google needs to be reconnected in Plugins.`
      );
    }
    if (err && err.code === 'invalid_google_workspace_action') {
      throw googleNativeActionError(
        err.code,
        `I couldn't safely apply the ${actionKind === 'docs' ? 'document' : 'spreadsheet'} update. Please try again.`
      );
    }
    if (err && err.code === 'google_request_timeout') {
      throw googleNativeActionError(
        err.code,
        `Google didn't respond in time, so I didn't change the ${actionKind === 'docs' ? 'document' : 'spreadsheet'}. Please try again.`
      );
    }
    throw googleNativeActionError(
      'google_workspace_action_failed',
      actionKind === 'docs'
        ? "I couldn't apply the document update. Please confirm the Doc still allows access and try again."
        : "I couldn't apply the spreadsheet update. Please confirm the sheet still allows access and try again."
    );
  }
}

function throwIfNativeDispatchStopped(signal) {
  if (!signal || !signal.aborted) return;
  const error = new Error(USER_CANCELLED_DISPATCH_ERROR);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
}

function nativeDispatchWasStopped(dispatch) {
  const current = nativeConversationRepository.getDispatch({
    companyId: dispatch.companyId,
    id: dispatch.id,
  });
  return !!(current && current.status === 'failed' && current.lastError === USER_CANCELLED_DISPATCH_ERROR);
}

// A stopped dispatch never posts a final reply, so nothing supersedes its
// transient "working…" status row — without cleanup the cancelled run leaves
// a permanent "I'm working through this now." bot message in the thread and
// sidebar preview. Soft-delete the row and tell live clients about it.
function removeNativeDispatchProgressEvent(dispatch) {
  try {
    const row = conn.prepare(
      `SELECT id FROM events
        WHERE company_id = ? AND conversation_id = ? AND client_idempotency_key = ?
          AND deleted_at IS NULL`
    ).get(dispatch.companyId, dispatch.conversationId, `native-dispatch-progress-${dispatch.id}`);
    if (!row) return;
    const event = nativeConversationRepository.deleteEvent({
      companyId: dispatch.companyId,
      id: row.id,
    });
    try { nativeConversationRealtime.publish(event); } catch (_publishError) {}
  } catch (error) {
    console.error('stopped dispatch progress cleanup failed', dispatch.id, error && error.message);
  }
}

async function createNativeArtifactAttachments({ conversation, principal, artifact }) {
  const attachments = [];
  if (artifact && artifact.preview) {
    attachments.push(await nativeConversationAttachmentStore.createAttachment({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principal,
      filename: artifact.preview.filename,
      mimeType: artifact.preview.mimeType,
      bytes: artifact.preview.bytes,
    }));
  }
  attachments.push(await nativeConversationAttachmentStore.createAttachment({
    companyId: conversation.companyId,
    conversationId: conversation.id,
    principal,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
  }));
  return attachments;
}

async function trySteerNativeConversationDispatch(dispatch, activeGateway) {
  const trigger = nativeConversationRepository.getEvent({
    companyId: dispatch.companyId,
    id: dispatch.eventId,
    includeDeleted: false,
  });
  const message = trigger && trigger.senderType === 'user' ? nativeEventText(trigger) : '';
  if (!message || !activeGateway || !activeGateway.sessionId) return false;
  if (cancelNativeDispatchForInactiveUser(dispatch, trigger)) return true;
  let result;
  try {
    result = await steerHermesGatewaySession(activeGateway.sessionId, message);
  } catch (_) {
    return false;
  }
  if (cancelNativeDispatchForInactiveUser(dispatch, trigger)) return true;
  if (!result || result.status !== 'queued') return false;
  const claimToken = `native-steer-${crypto.randomUUID()}`;
  const claimed = nativeConversationRepository.claimDispatch({
    companyId: dispatch.companyId,
    id: dispatch.id,
    claimToken,
  });
  if (!claimed.idempotent) {
    nativeConversationRepository.completeDispatch({
      companyId: dispatch.companyId,
      id: dispatch.id,
      claimToken,
    });
  }
  return true;
}

// budgetTracker.record() is fed streamed-character counts from delta events
// below; native-dispatch-runtime.js's tracker aborts `signal`'s controller
// once the char-approximated token budget is exceeded (see
// executeNativeConversationDispatch, the caller of this function).
function budgetTrackingOnEvent(budgetTracker) {
  return (type, payload) => {
    if (type !== 'message.delta' && type !== 'thinking.delta' && type !== 'reasoning.delta') return;
    budgetTracker.record(payload && payload.text);
  };
}

async function runNativeConversationAgentReply(dispatch, signal, budgetTracker) {
  throwIfNativeDispatchStopped(signal);
  const conversation = nativeConversationRepository.getConversation({
    companyId: dispatch.companyId,
    id: dispatch.conversationId,
  });
  const trigger = nativeConversationRepository.getEvent({
    companyId: dispatch.companyId,
    id: dispatch.eventId,
    includeDeleted: false,
  });
  if (!trigger || trigger.senderType !== 'user') return;
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  const isGatewayAgent = dispatch.targetType === 'gateway';
  const triggerMessage = nativeEventText(trigger);
  const message = !isGatewayAgent
    && dispatch.metadata
    && dispatch.metadata.kind === 'mia-automation-handoff'
    && typeof dispatch.metadata.automationTask === 'string'
    ? dispatch.metadata.automationTask
    : triggerMessage;
  const rawChatModelSelection = trigger.metadata && trigger.metadata.chatModelSelection;
  // After Disconnect the resumed gateway session would still answer with the
  // agent it built from the removed key. Refuse before touching the gateway
  // when the user's provider was disconnected here, so "no model" in the
  // composer means no model answers. (Inventory emptiness is not the signal:
  // a rate-limited provider also disappears from it and must still dispatch
  // so the user gets the usage-limit reply.)
  const dispatchProvider = isGatewayAgent ? harnessCliProviderForUser(trigger.senderId) : null;
  if (dispatchProvider && hermesDisconnectedProviders.has(dispatchProvider)) {
    throw new Error(`no usable credentials: ${dispatchProvider} was disconnected for this user`);
  }
  const chatModelSelection = await chatModelSelectionForUser(
    rawChatModelSelection,
    trigger.senderId
  );
  if (!message) return;
  const parentEventId = nativeReplyParentEventId(trigger);
  const agent = nativeDispatchActor(dispatch, conversation, trigger);
  const globalInstructions = currentInstructionSettings(isGatewayAgent ? trigger.senderId : ownerOf(agent));
  const replyPrincipalType = isGatewayAgent ? 'agent' : 'bot';
  const replyEventType = isGatewayAgent ? 'agent_message' : 'bot_message';
  await createNativeDispatchReplyEvent(dispatch, trigger, {
    type: replyEventType,
    content: { text: humanTaskStatus('running', 0) },
    parentEventId,
    clientIdempotencyKey: `native-dispatch-progress-${dispatch.id}`,
    metadata: {
      runtime: 'hermes',
      dispatchId: dispatch.id,
      status: 'working',
      progress: true,
      agentName: agent.name,
    },
  });
  throwIfNativeDispatchStopped(signal);
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  if (!isGatewayAgent) {
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    let cancelled;
    try {
      cancelled = await cancelBotAutomationFromChat({
        bot: agent,
        message,
      }, {
        canSchedule: (record) => sameOwner(record, trigger.senderId) || isAdmin(trigger.senderId),
        syncBotAutomation: syncBotAutomationWithInstructions,
        saveBot: (record) => {
          throwIfNativeDispatchUserInactive(dispatch, trigger);
          return db.saveOne(conn, 'bots', record.id, record);
        },
      });
    } catch (error) {
      return createNativeDispatchEvent(dispatch, trigger, {
        companyId: dispatch.companyId,
        conversationId: dispatch.conversationId,
        principal: {
          companyId: dispatch.companyId,
          principalId: dispatch.targetId,
          principalType: 'bot',
        },
        type: 'bot_message',
        content: { text: `I couldn’t cancel that automation: ${String(error && error.message || 'the scheduler is unavailable')}. No schedule was changed.` },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
        metadata: { runtime: 'hermes', dispatchId: dispatch.id, automation: 'cancel-failed', agentName: agent.name },
      });
    }
    if (cancelled) {
      throwIfNativeDispatchUserInactive(dispatch, trigger);
      bumpVersion();
      return createNativeDispatchEvent(dispatch, trigger, {
        companyId: dispatch.companyId,
        conversationId: dispatch.conversationId,
        principal: {
          companyId: dispatch.companyId,
          principalId: dispatch.targetId,
          principalType: 'bot',
        },
        type: 'bot_message',
        content: { text: cancelled.confirmation },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
        metadata: {
          runtime: 'hermes',
          dispatchId: dispatch.id,
          automation: 'cancelled',
          cronJobId: cancelled.bot && cancelled.bot.hermesCronJobIds && cancelled.bot.hermesCronJobIds[cancelled.automation.id],
          agentName: agent.name,
        },
      });
    }
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    let scheduled;
    try {
      scheduled = await scheduleBotAutomationFromChat({
        bot: agent,
        message,
        conversationId: conversation.id,
        companyId: conversation.companyId,
      }, {
        canSchedule: (record) => sameOwner(record, trigger.senderId) || isAdmin(trigger.senderId),
        syncBotAutomation: syncBotAutomationWithInstructions,
        saveBot: (record) => {
          throwIfNativeDispatchUserInactive(dispatch, trigger);
          return db.saveOne(conn, 'bots', record.id, record);
        },
      });
      throwIfNativeDispatchUserInactive(dispatch, trigger);
    } catch (error) {
      return createNativeDispatchEvent(dispatch, trigger, {
        companyId: dispatch.companyId,
        conversationId: dispatch.conversationId,
        principal: {
          companyId: dispatch.companyId,
          principalId: dispatch.targetId,
          principalType: 'bot',
        },
        type: 'bot_message',
        content: { text: `I couldn’t create that automation: ${String(error && error.message || 'the scheduler is unavailable')}. No schedule was saved.` },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
        metadata: { runtime: 'hermes', dispatchId: dispatch.id, automation: 'failed', agentName: agent.name },
      });
    }
    if (scheduled) {
      throwIfNativeDispatchUserInactive(dispatch, trigger);
      bumpVersion();
      return createNativeDispatchEvent(dispatch, trigger, {
        companyId: dispatch.companyId,
        conversationId: dispatch.conversationId,
        principal: {
          companyId: dispatch.companyId,
          principalId: dispatch.targetId,
          principalType: 'bot',
        },
        type: 'bot_message',
        content: { text: scheduled.confirmation },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
        metadata: {
          runtime: 'hermes',
          dispatchId: dispatch.id,
          automation: 'created',
          cronJobId: scheduled.bot.hermesCronJobIds && scheduled.bot.hermesCronJobIds[scheduled.automation.id],
          agentName: agent.name,
        },
      });
    }
  }
  if (dispatch.targetType === 'gateway') {
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    const created = await createNativeBotFromMiaRequest(
      dispatch.companyId,
      trigger.senderId,
      message,
      chatModelSelection && chatModelSelection.model,
      chatModelSelection && chatModelSelection.provider
    );
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    if (created) {
      return createNativeDispatchReplyEvent(dispatch, trigger, {
        type: 'agent_message',
        content: { text: `Created ${created.bot.name}. The bot is ready in its native chat.` },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
        metadata: { runtime: 'hermes', dispatchId: dispatch.id, action: 'create-native-bot', botId: created.bot.id, agentName: 'Mia' },
      });
    }
    const automationRequest = managerAutomationRequestFromChat(
      message,
      db.loadAll(conn, 'bots').filter((bot) =>
        recordBelongsToCompany(bot, NATIVE_COMPANY_ID, conversation.companyId)
      )
    );
    if (automationRequest) {
      if (!sameOwner(automationRequest.bot, trigger.senderId) && !isAdmin(trigger.senderId)) {
        return createNativeDispatchReplyEvent(dispatch, trigger, {
          type: 'agent_message',
          content: { text: `I can’t change ${automationRequest.bot.name}’s automation because only its owner or a workspace admin can do that.` },
          parentEventId,
          clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
          metadata: { runtime: 'hermes', dispatchId: dispatch.id, action: 'schedule-bot-automation-denied', botId: automationRequest.bot.id, agentName: 'Mia' },
        });
      }
      throwIfNativeDispatchUserInactive(dispatch, trigger);
      const botConversation = await ensureNativeBotConversation(automationRequest.bot);
      if (!botConversation) throw new Error(`bot conversation unavailable for ${automationRequest.bot.id}`);
      throwIfNativeDispatchUserInactive(dispatch, trigger);
      const miaResult = await createNativeDispatchReplyEvent(dispatch, trigger, {
        type: 'agent_message',
        content: {
          text: `I asked ${automationRequest.bot.name} to create and own this ${automationRequest.summary} automation.`,
        },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
        metadata: {
          runtime: 'hermes',
          action: 'schedule-bot-automation',
          botId: automationRequest.bot.id,
          agentName: 'Mia',
        },
      });
      createNativeDispatchEvent(dispatch, trigger, {
        companyId: botConversation.companyId,
        conversationId: botConversation.id,
        principal: {
          companyId: botConversation.companyId,
          principalId: trigger.senderId,
          principalType: 'user',
        },
        type: 'message',
        content: { text: automationRequest.task },
        clientIdempotencyKey: `native-mia-automation-handoff-${dispatch.id}-${automationRequest.bot.id}`,
        metadata: {
          delegatedBy: 'gateway',
          sourceConversationId: conversation.id,
          sourceEventId: trigger.id,
        },
        routing: {
          oneToOneAgent: {
            id: automationRequest.bot.id,
            name: automationRequest.bot.name || automationRequest.bot.id,
            manager: false,
            principalType: 'bot',
          },
          metadata: {
            runtime: 'hermes',
            kind: 'mia-automation-handoff',
            sourceEventId: miaResult.event.id,
            botName: automationRequest.bot.name || automationRequest.bot.id,
            automationTask: automationRequest.task,
          },
        },
      });
      return miaResult;
    }
  }
  const historyEvents = allNativeConversationEvents({
    companyId: dispatch.companyId,
    conversationId: dispatch.conversationId,
    includeDeleted: false,
    excludedSenderTypes: conversation.type === 'agent' ? ['bot'] : [],
  });
  const transcript = historyEvents
    .filter((event) => event.id !== trigger.id && !isNativeProgressEvent(event))
    .map(nativePromptLine)
    .filter(Boolean);
  const senderLabel = String(trigger.senderId || conversation.createdBy || '').trim().toLowerCase();
  const googleContextInput = googleWorkspaceContext.googleResourceContextInput(transcript, message);
  const googleResourceRefs = googleWorkspaceContext.extractGoogleResourceRefs(googleContextInput);
  const googleWorkspaceSheetWriteRequested = googleWorkspaceActions.explicitSheetWriteRequested(message, googleResourceRefs);
  const googleWorkspaceDocsWriteRequested = googleWorkspaceActions.explicitDocsWriteRequested(message, googleResourceRefs);
  const googleWorkspaceWriteKinds = googleWorkspaceActions.googleWorkspaceWriteKinds(message, googleResourceRefs);
  const googleWorkspaceWriteRequested = googleWorkspaceSheetWriteRequested || googleWorkspaceDocsWriteRequested;
  const workspaceContext = await googleWorkspaceAgentContextForOwner(senderLabel, googleContextInput);
  const googleWorkspaceConnected = /authoritative server state\): CONNECTED/.test(String(workspaceContext || ''));
  const googleGatewayProfile = googleWorkspaceConnected && googleAccountOwnerBinding.connectorFor(senderLabel)
    ? MIAOS_AGENT_GOOGLE_HERMES_PROFILE
    : MIAOS_AGENT_HERMES_PROFILE;
  const safeGoogleRefs = googleWorkspaceConnected
    ? googleWorkspaceActions.safeGoogleResourceRefs(googleResourceRefs)
    : [];
  const googleWorkspaceWriteAuthorized = googleWorkspaceWriteRequested
    && googleWorkspaceWriteKinds.length > 0
    && googleWorkspaceConnected;
  const platformContext = `${buildPlatformContext(false, senderLabel, conversation.companyId)}\n${workspaceContext}`;
  const artifactWorkspace = !isGatewayAgent ? cronSync.artifactWorkspaceForBot(agent) : null;
  // Without an explicit model the gateway session would fall back to profile
  // defaults, so hydrate the inventory when the composer sent no selection
  // and the cache cannot resolve one (e.g. right after a gateway restart).
  let userOptions = inferenceOptionsForUser(trigger.senderId);
  if (!chatModelSelection && userOptions && userOptions.provider && !userOptions.model) {
    try {
      rememberNativeChatModelInventory(await getHermesGatewayModelOptions({ refresh: true }));
      userOptions = inferenceOptionsForUser(trigger.senderId);
    } catch (_) { /* inventory unavailable; dispatch surfaces the real error */ }
  }
  const inferenceOptions = {
    ...userOptions,
    ...(chatModelSelection ? {
      provider: chatModelSelection.provider,
      model: chatModelSelection.model,
      reasoningEffort: chatModelSelection.reasoningEffort,
      fast: chatModelSelection.fast,
    } : {}),
    // Native agent turns are the action-capable path. Give browser and
    // workspace work the same room as the dedicated Hermes task runner,
    // rather than the six-turn fast-reply default.
    agentic: isGatewayAgent,
    botWorker: !isGatewayAgent,
    maxTurns: isGatewayAgent ? MIAOS_AGENT_MAX_TURNS : MIAOS_BOT_MAX_TURNS,
    // Output budget mirrors the turn cap above: a per-run ceiling that
    // executeNativeConversationDispatch enforces via the same abort path the
    // wall-clock timeout uses (see the token budget tracker there).
    maxTokens: hermesTokenBudgetFromOptions(userOptions),
    ...(isGatewayAgent ? { profile: googleGatewayProfile } : {}),
    ...(isGatewayAgent && !EFFECTIVE_RELEASE_PROFILE.agentSearchOnly
      && String(process.env.MIAOS_WORKSPACE_DIR || '').trim()
      ? { workspaceDir: miaosWorkspaceDir() }
      : {}),
    ...(artifactWorkspace ? { artifactWorkspace } : {}),
  };
  let rawReply;
  let inferenceResult;
  let validatedArtifacts = [];
  // Shared verbose-diagnostics progress poster. Both dispatch flavors route
  // gateway events through the same Hermes gateway client (client.run()'s
  // onEvent), so both need the same coalescing/posting wiring — this used to
  // live only inside the `dispatch.targetType === 'gateway'` branch, which
  // meant bot-worker dispatches (the non-gateway else-branch below) silently
  // dropped thinking.delta/reasoning.delta even with verbose chatOutput on.
  let hermesProgressSequence = Promise.resolve();
  let hermesProgressIndex = 0;
  const postHermesProgressText = (hermesEventType, text) => {
    const sequence = ++hermesProgressIndex;
    hermesProgressSequence = hermesProgressSequence.then(() => createNativeDispatchReplyEvent(dispatch, trigger, {
      type: replyEventType,
      content: { text },
      parentEventId,
      clientIdempotencyKey: `native-dispatch-hermes-progress-${dispatch.id}-${sequence}`,
      metadata: {
        runtime: 'hermes',
        dispatchId: dispatch.id,
        progress: true,
        diagnostic: true,
        hermesEventType,
        agentName: agent.name,
      },
    })).catch(() => {});
  };
  // thinking.delta/reasoning.delta arrive one token at a time; coalesce them
  // into a single progress line per burst instead of one event per token.
  const hermesDeltaCoalescer = createHermesDeltaCoalescer((kind, text) => {
    postHermesProgressText(kind === 'Thinking' ? 'thinking.delta' : 'reasoning.delta', `${kind}\n${text}`);
  });
  const trackBudget = budgetTracker ? budgetTrackingOnEvent(budgetTracker) : null;
  // Some providers (the Claude subscription route) report the final answer
  // again as a completed reasoning block, which showed the reply twice. Hold
  // the reasoning summary until the next event and drop it when it only
  // repeats the reply.
  let pendingReasoningSummary = '';
  const sameReplyText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim()
    === String(b || '').replace(/\s+/g, ' ').trim();
  const flushPendingReasoningSummary = (replyText) => {
    const text = pendingReasoningSummary;
    pendingReasoningSummary = '';
    if (!text) return;
    if (replyText && sameReplyText(text.replace(/^Reasoning summary\n/, ''), redactHermesChatDetail(replyText))) return;
    for (const chunk of splitHermesDebugText(text)) postHermesProgressText('reasoning.available', chunk);
  };
  const flushHermesProgress = (replyText) => {
    hermesDeltaCoalescer.flush();
    flushPendingReasoningSummary(replyText);
  };
  const postHermesProgress = (type, payload) => {
    if (trackBudget) trackBudget(type, payload);
    const diagnostics = getHermesDiagnostics();
    if (!diagnostics.verboseHermes && !diagnostics.traceCommands) return;
    // Verbose mode surfaces the live thinking/reasoning stream instead of
    // silently dropping it (hermesDebugEventText() still drops it — that
    // pure per-event function has no buffer to coalesce into). gateway.ready
    // and session.info stay dropped either way; message.delta is left out
    // too, since its content is the final reply already posted separately.
    if (diagnostics.verboseHermes && (type === 'thinking.delta' || type === 'reasoning.delta')) {
      const text = redactHermesChatDetail(String((payload && payload.text) || ''));
      if (text) hermesDeltaCoalescer.push(type === 'thinking.delta' ? 'Thinking' : 'Reasoning', text);
      return;
    }
    // Any other event is a natural boundary (a tool call, a status change,
    // message.complete): flush whatever delta text is buffered first so
    // ordering in the transcript matches the gateway's own event order.
    hermesDeltaCoalescer.flush();
    if (type === 'reasoning.available') {
      flushPendingReasoningSummary();
      pendingReasoningSummary = hermesDebugEventText(type, payload);
      return;
    }
    // message.complete without text (streamed replies) keeps the summary
    // until the run returns the final reply to compare against.
    const completedText = type === 'message.complete' ? String((payload && payload.text) || '') : '';
    if (type !== 'message.complete' || completedText) flushPendingReasoningSummary(completedText);
    for (const text of splitHermesDebugText(hermesDebugEventText(type, payload))) {
      postHermesProgressText(type, text);
    }
  };
  if (dispatch.targetType === 'gateway') {
    const systemPrompt = buildHermesGatewaySystemPrompt(agent, senderLabel, globalInstructions.agent);
    const gatewayMessage = buildHermesGatewayTurnMessage(
      message,
      senderLabel,
      platformContext,
      safeGoogleRefs,
      googleWorkspaceWriteAuthorized && googleGatewayProfile !== MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
      globalInstructions.agent
    );
    const gatewayKey = nativeDispatchChainKey(dispatch);
    const ownsPrivateAgentConversation = conversation.type === 'agent'
      && String(conversation.createdBy || '').toLowerCase() === senderLabel;
    let activeGatewayRecord = null;
    let gatewayResult;
    try {
      gatewayResult = await runInferenceViaHermesGateway({
        storedSessionId: ownsPrivateAgentConversation && conversation.metadata
          && (conversation.metadata.hermesGatewayProfile
            ? conversation.metadata.hermesGatewayProfile === googleGatewayProfile
            : googleGatewayProfile === MIAOS_AGENT_HERMES_PROFILE)
          ? conversation.metadata.hermesGatewaySessionId
          : null,
        seedMessages: nativeHermesGatewaySeedMessages(systemPrompt, historyEvents, trigger.id),
        title: conversation.name || 'Mia conversation',
        message: gatewayMessage,
        options: inferenceOptions,
        onEvent: postHermesProgress,
        onSession: (session) => {
          throwIfNativeDispatchUserInactive(dispatch, trigger);
          activeGatewayRecord = { dispatchId: dispatch.id, sessionId: session.sessionId };
          nativeActiveGatewaySessions.set(gatewayKey, activeGatewayRecord);
          if (ownsPrivateAgentConversation) {
            persistNativeHermesGatewaySession(conversation, trigger.id, session.storedSessionId, googleGatewayProfile);
          }
        },
        signal,
      });
    } finally {
      if (activeGatewayRecord && nativeActiveGatewaySessions.get(gatewayKey) === activeGatewayRecord) {
        nativeActiveGatewaySessions.delete(gatewayKey);
      }
    }
    flushHermesProgress(gatewayResult && gatewayResult.text);
    throwIfNativeDispatchStopped(signal);
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    await hermesProgressSequence;
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    if (ownsPrivateAgentConversation) {
      const sessionOwner = persistNativeHermesGatewaySession(
        conversation,
        trigger.id,
        gatewayResult.storedSessionId,
        googleGatewayProfile
      );
      if (gatewayResult.storedSessionId && !sessionOwner) return;
    }
    inferenceResult = gatewayResult;
    rawReply = gatewayResult.text;
  } else {
    const systemPrompt = buildHermesTaskPrompt(
      agent,
      [],
      message,
      senderLabel,
      platformContext,
      safeGoogleRefs,
      googleWorkspaceWriteAuthorized,
      globalInstructions.bot
    );
    inferenceResult = await scheduleInference(nativePromptLine(trigger) || message, 'reply', {
      ...inferenceOptions,
      seedMessages: nativeHermesGatewaySeedMessages(systemPrompt, historyEvents, trigger.id),
      signal,
      onEvent: postHermesProgress,
    });
    flushHermesProgress(typeof inferenceResult === 'string' ? inferenceResult : inferenceResult && inferenceResult.text);
    throwIfNativeDispatchStopped(signal);
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    await hermesProgressSequence;
    throwIfNativeDispatchUserInactive(dispatch, trigger);
    rawReply = typeof inferenceResult === 'string' ? inferenceResult : inferenceResult && inferenceResult.text;
    validatedArtifacts = cronSync.validateBotArtifacts(
      agent,
      inferenceResult && Array.isArray(inferenceResult.artifacts) ? inferenceResult.artifacts : []
    );
  }
  throwIfNativeDispatchStopped(signal);
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  const agentSignature = `[${agent.name}]`;
  const escapedSignature = agentSignature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  const actionReply = await applyNativeGoogleWorkspaceAction({
    ownerEmail: senderLabel,
    rawResult: rawReply,
    googleResourceRefs: safeGoogleRefs,
    googleWorkspaceWriteAuthorized,
    googleWorkspaceWriteKinds,
    dispatch,
    trigger,
    signal,
  });
  throwIfNativeDispatchStopped(signal);
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  // A restart can happen while the model/browser work is in flight. Do not
  // let that stale run repopulate the fresh conversation after the user
  // explicitly cleared it.
  const stillLive = nativeConversationRepository.getEvent({
    companyId: dispatch.companyId,
    id: dispatch.eventId,
    includeDeleted: false,
  });
  if (!stillLive) return;
  throwIfNativeDispatchUserInactive(dispatch, trigger);
  const safeReply = sanitizeChatReply(actionReply)
    .replace(/^\s*\[[^\]\n]{1,120}\]\s*/, '')
    .replace(new RegExp(`\\s*${escapedSignature}\\s*$`, 'i'), '')
    .trim();
  if (!safeReply && validatedArtifacts.length === 0) throw new Error('native agent produced no user-facing reply');
  if (validatedArtifacts.length > 0) {
    let lastResult = null;
    for (let index = 0; index < validatedArtifacts.length; index++) {
      const artifact = validatedArtifacts[index];
      const attachments = await createNativeArtifactAttachments({
        conversation,
        principal: {
          companyId: conversation.companyId,
          principalId: dispatch.targetId,
          principalType: 'bot',
        },
        artifact,
      });
      const created = await nativeConversationService.createEvent({
        companyId: conversation.companyId,
        conversationId: conversation.id,
        principal: {
          companyId: conversation.companyId,
          principalId: dispatch.targetId,
          principalType: 'bot',
        },
        type: replyEventType,
        content: {
          text: index === 0 && safeReply ? safeReply : `Created ${artifact.filename}`,
          attachments,
        },
        parentEventId,
        clientIdempotencyKey: `native-dispatch-${dispatch.id}-artifact-${index}`,
        metadata: {
          runtime: 'hermes',
          dispatchId: dispatch.id,
          agentName: agent.name,
          artifact: true,
          artifactSource: 'interactive',
        },
      });
      for (const attachment of attachments) {
        nativeConversationRepository.attachToEvent({
          companyId: conversation.companyId,
          id: attachment.id,
          eventId: created.event.id,
        });
      }
      lastResult = created;
    }
    if (dispatch.targetType === 'gateway') {
      await enqueueNativeMiaHandoffs(conversation, trigger, lastResult.event, safeReply || '');
    }
    return lastResult;
  }
  const result = await createNativeDispatchReplyEvent(dispatch, trigger, {
    type: replyEventType,
    content: { text: safeReply },
    parentEventId,
    clientIdempotencyKey: `native-dispatch-${dispatch.id}`,
    metadata: { runtime: 'hermes', dispatchId: dispatch.id, agentName: agent.name },
  });
  if (dispatch.targetType === 'gateway') {
    await enqueueNativeMiaHandoffs(conversation, trigger, result.event, safeReply, dispatch);
  }
  return result;
}

async function executeNativeConversationDispatch(dispatch) {
  const claimToken = `native-${crypto.randomUUID()}`;
  let claimed = null;
  let timeoutError = null;
  let budgetError = null;
  let watchdog = null;
  const abortController = new AbortController();
  // Same abort path the wall-clock watchdog uses below. The tracker only
  // counts characters (the gateway stream exposes no per-turn token usage;
  // see hermesCharBudgetFromTokens in inference.js) and fires once.
  const budgetTracker = createNativeDispatchTokenBudgetTracker({
    charBudget: hermesCharBudgetFromTokens(hermesTokenBudgetFromOptions()),
    onExceeded: (error) => {
      budgetError = error;
      abortController.abort();
    },
  });
  try {
    claimed = nativeConversationRepository.claimDispatch({
      companyId: dispatch.companyId,
      id: dispatch.id,
      claimToken,
    });
    if (claimed.idempotent) return;
    const claimedTrigger = nativeConversationRepository.getEvent({
      companyId: dispatch.companyId,
      id: claimed.dispatch.eventId,
      includeDeleted: false,
    });
    if (claimedTrigger && cancelNativeDispatchForInactiveUser(claimed.dispatch, claimedTrigger)) return;
    nativeDispatchAbortControllers.set(dispatch.id, abortController);
    watchdog = createNativeDispatchWatchdog({
      timeoutMs: NATIVE_DISPATCH_TIMEOUT_MS,
      onTimeout: (error) => {
        timeoutError = error;
        abortController.abort();
      },
    });
    await runNativeConversationAgentReply(claimed.dispatch, abortController.signal, budgetTracker);
    // Abort is cooperative. A runtime that ignores the signal can still
    // resolve after the watchdog fires; the timeout (and the output budget)
    // must win over completion so the durable dispatch cannot be marked
    // successful after its deadline.
    if (timeoutError) throw timeoutError;
    if (budgetError) throw budgetError;
    if (nativeDispatchWasStopped(dispatch)) {
      removeNativeDispatchProgressEvent(dispatch);
      return;
    }
    nativeConversationRepository.completeDispatch({
      companyId: dispatch.companyId,
      id: dispatch.id,
      claimToken,
    });
  } catch (error) {
    const timedOut = timeoutError || (error && error.code === NATIVE_DISPATCH_TIMEOUT_CODE ? error : null);
    const budgetExceeded = budgetError || (error && error.code === NATIVE_DISPATCH_TOKEN_BUDGET_CODE ? error : null);
    let stopped = nativeDispatchWasStopped(dispatch);
    if ((timedOut || budgetExceeded) && !stopped && claimed && claimed.dispatch) {
      try {
        nativeConversationRepository.failDispatch({
          companyId: dispatch.companyId,
          id: dispatch.id,
          claimToken,
          error: (timedOut || budgetExceeded).message,
        });
      } catch (failureError) {
        // An explicit Stop can win immediately after the watchdog (or budget
        // tracker) fires. The durable row decides which terminal state the
        // user should see.
        if (!nativeDispatchWasStopped(dispatch)) {
          console.error('native dispatch timeout state update failed', dispatch.id, failureError.message);
        }
      }
      stopped = nativeDispatchWasStopped(dispatch);
    }
    const cancelled = !timedOut && !budgetExceeded && (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
    if (stopped || cancelled) {
      removeNativeDispatchProgressEvent(dispatch);
      return;
    }
    if (!timedOut && !budgetExceeded && claimed && claimed.dispatch) {
      try {
        nativeConversationRepository.failDispatch({
          companyId: dispatch.companyId,
          id: dispatch.id,
          claimToken,
          error: error && error.message ? error.message : 'native agent dispatch failed',
        });
      } catch (failureError) {
        console.error('native dispatch failure state update failed', dispatch.id, failureError.message);
      }
    }
    // Every terminal failure must retire the transient working row. Leaving
    // it behind makes a failed or timed-out turn look active after reload.
    removeNativeDispatchProgressEvent(dispatch);
    console.error('native conversation dispatch failed', dispatch.id, error && error.message ? error.message : error);
    try {
      const failureTrigger = nativeConversationRepository.getEvent({
        companyId: dispatch.companyId,
        id: dispatch.eventId,
        includeDeleted: false,
      });
      if (!failureTrigger) return;
      if (cancelNativeDispatchForInactiveUser(dispatch, failureTrigger)) return;
      const failureAgent = dispatch.targetType === 'gateway'
        ? 'Mia'
        : ((db.loadOne(conn, 'bots', dispatch.targetId) || {}).name || dispatch.targetId);
      const failurePrincipal = {
        companyId: dispatch.companyId,
        principalId: dispatch.targetType === 'gateway' ? 'gateway' : dispatch.targetId,
        principalType: dispatch.targetType === 'gateway' ? 'agent' : 'bot',
      };
      await createNativeDispatchEvent(dispatch, failureTrigger, {
        companyId: dispatch.companyId,
        conversationId: dispatch.conversationId,
        principal: failurePrincipal,
        type: dispatch.targetType === 'gateway' ? 'agent_message' : 'bot_message',
        // Fail loudly under the debugging toggle: append the raw dispatch
        // error so a local developer never has to dig it out of the DB
        // (the generic copy alone hid a gateway ENOENT for hours).
        content: {
          text: budgetExceeded
            // A distinct, named notice rather than the generic failure copy:
            // the run wasn't broken, it just kept going past its output cap.
            ? '⏹ Stopped: this response reached its output budget before finishing. Nothing else was changed.'
            : userFacingModelDispatchError(timedOut || error)
              + (getHermesDiagnostics().verboseHermes && error && error.message
                ? `\n\nDebug · dispatch error\n${redactHermesChatDetail(String(error.message).slice(0, 2000))}`
                : ''),
        },
        parentEventId: nativeReplyParentEventId(failureTrigger),
        clientIdempotencyKey: `native-dispatch-failure-${dispatch.id}`,
        metadata: {
          runtime: 'hermes',
          dispatchId: dispatch.id,
          status: budgetExceeded ? 'budget_exceeded' : 'failed',
          agentName: failureAgent,
        },
      });
    } catch (failureEventError) {
      console.error('native dispatch failure event failed', dispatch.id, failureEventError.message);
    }
  } finally {
    if (watchdog) watchdog.cancel();
    if (nativeDispatchAbortControllers.get(dispatch.id) === abortController) {
      nativeDispatchAbortControllers.delete(dispatch.id);
    }
  }
}

function recoverNativeConversationDispatches() {
  const companyIds = conn.prepare(
    "SELECT DISTINCT company_id AS companyId FROM conversation_dispatches WHERE status = 'claimed'"
  ).all().map((row) => row.companyId);
  if (!companyIds.includes(NATIVE_COMPANY_ID)) companyIds.push(NATIVE_COMPANY_ID);
  const dispatches = companyIds.flatMap((companyId) => nativeConversationRepository.requeueClaimedDispatches({ companyId }));
  for (const dispatch of dispatches) setImmediate(() => scheduleNativeConversationDispatch(dispatch).catch(() => {}));
  if (dispatches.length) console.log(`native dispatch recovery: requeued ${dispatches.length} claimed dispatch(es)`);
}

// Native conversation event API and outbox.

// Suggests up to 3 short follow-up questions in the human's voice, given the
// tail of a conversation — used to populate the chat composer's pill row.
// Never surfaces inference failures to the client: an empty list just means
// no pills render.
app.post('/api/chat/suggestions', requireAuth, async (req, res) => {
  const transcript = (req.body || {}).transcript;
  if (!Array.isArray(transcript) || transcript.length === 0 || !transcript.every((l) => typeof l === 'string')) {
    return res.status(400).json({ error: 'transcript must be a non-empty array of strings' });
  }
  const lines = transcript.slice(-15).map((l) => l.slice(0, 300));
  const prompt =
    'Given this conversation, suggest exactly 3 short questions the human user would ' +
    'plausibly send next, whether continuing their own line of thought or following up on ' +
    'the latest reply. Phrase each in the user\'s own voice, 10 words or fewer, one per ' +
    'line, no numbering, no quotes, no preamble.\n\n' +
    lines.join('\n');

  try {
    const reply = await scheduleInference(
      prompt,
      'suggestion',
      inferenceOptionsForUser(req.userEmail)
    );
    const suggestions = String(reply || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim().replace(/^["'\-*•]+\s*/, '').replace(/^\d+[.)]\s*/, '').replace(/["']+$/, ''))
      .filter((l) => l && l.length <= 80)
      .slice(0, 3);
    res.status(200).json({ suggestions });
  } catch (err) {
    res.status(200).json({ suggestions: [] });
  }
});

// ---------- admin ----------
// GET /api/admin/backup mirrors GET /api/backup's payload exactly (same
// fields, same settings.lastBackup side effect) — duplicated here rather
// than extracted into a shared function because that route body lives
// outside this lane's owned region (see admin.js top comment).
app.use(
  '/api/admin',
  requireInteractiveAuth,
  requireMiaAdmin,
  adminModule.createAdminRouter({
    conn,
    instanceName: INSTANCE_NAME,
    instanceDomains: INSTANCE_DOMAINS,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.MIAOS_PUBLIC_BASE_URL || '',
    defaultOwner: DEFAULT_OWNER,
    onUserDeleted: async (email) => {
      const owner = String(email || '').trim().toLowerCase();
      let deletionBarrier = false;
      try {
        const barrier = beginNativeUserDeletion(owner);
        deletionBarrier = true;
        try {
          const result = await googleAccountOwnerBinding.disconnectFor(owner);
          if (result && ['connected', 'connection_error'].includes(result.state)) {
            console.error('Google account credential cleanup was incomplete for deleted user', result.state);
          }
        } catch (err) {
          // The durable deleted_users tombstone below still blocks this email
          // from reusing the process profile when external logout fails.
          console.error('Google account credential cleanup failed for deleted user', err.message);
        }
        const ownedAgents = db.loadAll(conn, 'bots').filter((agent) => ownerOf(agent) === owner);
        const deletedAt = new Date().toISOString();
        for (const agent of ownedAgents) {
          for (const conversation of nativeBotConversations(agent, true)) {
            nativeConversationRepository.updateConversation({
              companyId: conversation.companyId,
              id: conversation.id,
              deletedAt,
              updatedAt: deletedAt,
            });
          }
          db.deleteOne(conn, 'bots', agent.id);
          db.moveToTrash(conn, 'bot', agent);
          await cronSync.removeBotCron(agent).catch((err) =>
            console.error('cron-sync: failed to remove deleted user bot', agent.id, err.message)
          );
        }
        return { agentsDeleted: ownedAgents.length, dispatchesCancelled: barrier.cancelled };
      } catch (error) {
        // If cleanup fails, leave the account usable rather than silently
        // converting a failed deletion into a permanent disabled account.
        conn.prepare('UPDATE users SET disabled = 0 WHERE lower(email) = ?').run(owner);
        throw error;
      } finally {
        if (deletionBarrier || owner) finishNativeUserDeletion(owner);
      }
    },
    getBackupPayload: () => {
      const settings = db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS);
      const exportedAt = new Date().toISOString();
      const backup = {
        exportedAt,
        settings: { guardrails: settings.guardrails },
      };
      settings.lastBackup = exportedAt;
      db.saveSingleton(conn, 'settings', settings);
      return backup;
    },
  })
);

// Keep the API contract JSON even when a client reaches an unknown endpoint.
// Without this boundary Express emits an HTML 404 page, which is especially
// confusing for the Hermes onboarding client because it expects JSON.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ---------- admin panel + invite acceptance (no auth required here; the
// pages themselves call /api/me and /api/invite/:token to gate content) ----------

app.get('/admin', (req, res) => {
  const filePath = STATIC_DIR && path.join(STATIC_DIR, 'admin.html');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

app.get('/invite/:token', (req, res) => {
  const filePath = STATIC_DIR && path.join(STATIC_DIR, 'invite.html');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// ---------- showcase (no auth required, old server route) ----------
// Unlike the old server, this doesn't hardcode ../public — it only serves
// showcase.html out of the configured STATIC_DIR, if one is set.

app.get('/showcase', (req, res) => {
  const filePath = STATIC_DIR && path.join(STATIC_DIR, 'showcase.html');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

// ---------- static frontend (optional) ----------

if (STATIC_DIR) {
  app.use('/vendor/clerk-js', express.static(path.dirname(require.resolve('@clerk/clerk-js'))));
  app.use('/vendor/clerk-ui', express.static(path.join(path.dirname(require.resolve('@clerk/ui/package.json')), 'dist')));
  const sendIndex = (_req, res) => {
    const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
    res.setHeader('Content-Security-Policy', MIAOS_PAGE_CSP);
    res.type('html').send(replacePageCsp(html, MIAOS_PAGE_CSP));
  };
  app.get(['/', '/index.html'], sendIndex);
  app.use(express.static(STATIC_DIR));
}

// ---------- one-time boot migration: pre-workspace rows -> DEFAULT_OWNER ----------
// Every agent/department_rooms row and every 'departments' list written
// before per-user workspaces shipped has no owner — it's the previous
// single shared workspace, so it becomes DEFAULT_OWNER's on upgrade rather
// than becoming unreachable. Idempotent (only touches rows actually
// missing the field) and safe to run on every boot.
function migrateWorkspaceOwnership() {
  for (const record of db.loadAll(conn, 'bots')) {
    let touched = false;
    const automationStateBefore = JSON.stringify({
      automation: record.automation,
      automations: record.automations,
      hermesCronJobId: record.hermesCronJobId,
      hermesCronJobIds: record.hermesCronJobIds,
      hermesCronDeliveries: record.hermesCronDeliveries,
    });
    cronSync.migrateBotAutomations(record);
    if (automationStateBefore !== JSON.stringify({
      automation: record.automation,
      automations: record.automations,
      hermesCronJobId: record.hermesCronJobId,
      hermesCronJobIds: record.hermesCronJobIds,
      hermesCronDeliveries: record.hermesCronDeliveries,
    })) touched = true;
    if (!record.owner) {
      record.owner = DEFAULT_OWNER;
      touched = true;
    }
    // The switcher existed before workspace scope did. Every bot that
    // predates this field is company work and therefore belongs to the
    // default Multiplayer Test workspace; Solo starts empty and only receives bots
    // explicitly created there.
    if (!record.workspaceId) {
      record.workspaceId = DEFAULT_WORKSPACE_ID;
      touched = true;
    }
    if (record.model && !record.modelProvider) {
      record.modelProvider = harnessCliProviderForUser(record.owner);
      touched = true;
    }
    if (String(record.id || '').startsWith('builtin-') && !record.builtinSlug) {
      record.builtinSlug = String(record.id).slice('builtin-'.length);
      touched = true;
    }
    // Paused is the old inactive state; drafts are intentionally preserved so
    // an unfinished bot remains visible and does not block other channels.
    if (record.status === 'paused') {
      record.status = 'watch';
      touched = true;
    }
    if (touched) db.saveOne(conn, 'bots', record.id, record);
  }
  for (const record of db.loadAll(conn, 'department_rooms')) {
    if (!record.owner) {
      // Old rows are keyed by bare department name — kept as-is (see
      // findDepartmentRoom); only new post-migration rows use the
      // owner-prefixed key.
      record.owner = DEFAULT_OWNER;
      db.saveOne(conn, 'department_rooms', record.department, record);
    }
  }
  const legacyDepartments = db.getMeta(conn, 'departments');
  if (legacyDepartments !== null && db.getMeta(conn, `departments:${DEFAULT_OWNER}`) === null) {
    db.setMeta(conn, `departments:${DEFAULT_OWNER}`, legacyDepartments);
  }
}

const nativeConversationHttpServer = http.createServer(app);
const nativeConversationWebSocket = attachConversationWebSocketServer({
  server: nativeConversationHttpServer,
  realtime: nativeConversationRealtime,
  authenticate: authenticateNativeConversationWebSocket,
  reauthorize: (request, principal) => {
    const current = authenticateNativeConversationWebSocket(request, { touchCredentials: false });
    return !!current
      && current.companyId === principal.companyId
      && current.principalId === principal.principalId
      && current.principalType === principal.principalType;
  },
  listHistory: ({ principal, conversationId, afterSequence }) => nativeConversationService.listEvents({
    companyId: principal.companyId,
    conversationId,
    principal,
    afterSequence,
    includeDeleted: false,
    limit: 100,
  }),
});

let backendShutdownStarted = false;
function shutdownBackend() {
  if (backendShutdownStarted) return;
  backendShutdownStarted = true;
  disconnectAllHermesAuth();
  closeHermesGatewayRuntime();
  nativeConversationWebSocket.close();

  const forceExit = setTimeout(() => process.exit(0), 2000);
  forceExit.unref();
  if (!nativeConversationHttpServer.listening) return process.exit(0);
  nativeConversationHttpServer.close(() => process.exit(0));
}

process.once('SIGTERM', shutdownBackend);
process.once('SIGINT', shutdownBackend);

async function deliverBotCronResults() {
  let results;
  try {
    results = await cronSync.listUndeliveredBotCronResults(conn);
  } catch (error) {
    console.error('bot cron delivery scan failed', error.message);
    return;
  }
  for (const result of results) {
    try {
      // The scan returns a snapshot of bot rows. A user can be deleted while
      // this result is waiting on conversation/filesystem work, so every
      // post-await mutation must revalidate that snapshot's human owner.
      throwIfNativeCronBotOwnerInactive(result.bot);
      // Cron output belongs to the bot that owns the automation. Never trust
      // a legacy origin-chat pointer: it may identify the user's private Mia
      // conversation and would break that conversation's 1:1 boundary.
      const conversation = await ensureNativeBotConversation(result.bot);
      throwIfNativeCronBotOwnerInactive(result.bot);
      if (!conversation) throw new Error('bot conversation unavailable');
      const text = sanitizeChatReply(result.content).trim();
      const principal = {
        companyId: conversation.companyId,
        principalId: result.bot.id,
        principalType: 'bot',
      };
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      if (artifacts.length > 0) {
        for (let index = 0; index < artifacts.length; index++) {
          const artifact = artifacts[index];
          throwIfNativeCronBotOwnerInactive(result.bot);
          const attachments = await createNativeArtifactAttachments({ conversation, principal, artifact });
          throwIfNativeCronBotOwnerInactive(result.bot);
          const created = await nativeConversationService.createEvent({
            companyId: conversation.companyId,
            conversationId: conversation.id,
            principal,
            type: 'bot_message',
            content: {
              text: index === 0 && text ? text : `Created ${artifact.filename}`,
              attachments,
            },
            clientIdempotencyKey: `bot-cron-${result.jobId}-${result.sessionId}-artifact-${index}`,
            metadata: {
              scheduled: true,
              cronJobId: result.jobId,
              cronSessionId: result.sessionId,
              botName: result.bot.name || result.bot.id,
              automationId: result.automationId,
              automationName: result.automation && result.automation.name,
              artifact: true,
            },
          });
          for (const attachment of attachments) {
            throwIfNativeCronBotOwnerInactive(result.bot);
            nativeConversationRepository.attachToEvent({
              companyId: conversation.companyId,
              id: attachment.id,
              eventId: created.event.id,
            });
          }
        }
      } else if (text) {
        throwIfNativeCronBotOwnerInactive(result.bot);
        await nativeConversationService.createEvent({
          companyId: conversation.companyId,
          conversationId: conversation.id,
          principal,
          type: 'bot_message',
          content: { text },
          clientIdempotencyKey: `bot-cron-${result.jobId}-${result.sessionId}`,
          metadata: {
            scheduled: true,
            cronJobId: result.jobId,
            cronSessionId: result.sessionId,
            botName: result.bot.name || result.bot.id,
            automationId: result.automationId,
            automationName: result.automation && result.automation.name,
          },
        });
      }
      throwIfNativeCronBotOwnerInactive(result.bot);
      cronSync.migrateBotAutomations(result.bot);
      result.bot.hermesCronDeliveries[result.automationId] = {
        sessionId: result.sessionId,
        deliveredAt: new Date().toISOString(),
      };
      db.saveOne(conn, 'bots', result.bot.id, result.bot);
    } catch (error) {
      console.error('bot cron delivery failed', result.bot.id, error.message);
    }
  }
}

function applyChatOutputSetting(output) {
  const verbose = output === 'verbose';
  setHermesDiagnostics({ verboseHermes: verbose, traceCommands: verbose });
}

function onBackendListening() {
  console.log(`Mia backend listening on port ${PORT}`);
  startHermesGatewayRuntime().catch((err) =>
    console.error('Mia Hermes runtime failed to start', err.message)
  );
  // Output detail is a persisted user setting; re-arm the in-process
  // diagnostics from it so verbose mode survives restarts and reinstalls.
  applyChatOutputSetting(db.loadSingleton(conn, 'settings', DEFAULT_SETTINGS).chatOutput);
  migrateWorkspaceOwnership();
  // Reconcile managed-router credentials at boot: validates the stored key
  // and prunes dead siblings from the auth stores. This path never mints —
  // minting is authorized only by a fresh Clerk session token, which exists
  // at sign-in, not at startup; a user whose key is missing or dead gets a
  // new one on their next Clerk sign-in.
  if (MANAGED_ROUTER_URL) {
    const linked = clerkAccountProfile();
    if (linked && linked.email) void autoProvisionManagedRouter(linked.email);
  }
  reconcileNativeMiaConversations();
  recoverNativeConversationDispatches();
  reconcileNativeBotConversations()
    // Conversation ownership must settle before cron reconciliation reads
    // bot records. Running these in parallel allowed a stale origin-chat
    // pointer to overwrite the repaired bot-conversation destination.
    .then(() => cronSync.reconcileBotCrons(conn, {
      globalInstructionsForBot: (bot) => currentInstructionSettings(ownerOf(bot)).bot,
    }))
    .then(deliverBotCronResults)
    .catch((err) => console.error('bot/cron boot reconciliation failed', err.message));
  setInterval(deliverBotCronResults, 15000).unref();
}

// Preview, team-release, and single-user traffic must enter through the local
// app or same-host TLS proxy. Team release deliberately ignores a remote bind
// override while this local multiplayer slice is being validated.
if (MIAOS_BIND_HOST) nativeConversationHttpServer.listen(PORT, MIAOS_BIND_HOST, onBackendListening);
else nativeConversationHttpServer.listen(PORT, onBackendListening);


// The local Google OAuth client is registered for localhost:4870 while the
// The local preview normally serves Mia on 4930. Keep the preview URL stable and
// also listen on the configured callback port so Google can return to the
// server without requiring a second backend process. This listener is only
// enabled for loopback callback URLs and never changes production bindings.
function localOAuthCallbackPort() {
  // The localhost callback listener belongs only to the no-auth local preview.
  // Production may have a loopback redirect configured for another service
  // (the rollback app owns 4870), so never bind that port from the public app.
  if (process.env.MIAOS_NO_AUTH !== '1') return null;
  try {
    const redirect = new URL(googleWorkspace.configFromEnv().redirectUri);
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(redirect.hostname)) return null;
    const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port < 65536 && port !== Number(PORT) ? port : null;
  } catch (_) {
    return null;
  }
}

const oauthCallbackPort = localOAuthCallbackPort();
if (oauthCallbackPort) {
  app.listen(oauthCallbackPort, '127.0.0.1', () => {
    console.log(`Mia OAuth callback listening on port ${oauthCallbackPort}`);
  });
}
