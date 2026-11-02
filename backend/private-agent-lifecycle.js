'use strict';

// Everything around a personal agent that touches more than its registry
// record: its Hermes profile folders, its conversations and its chat.
// Dependencies are injected so this stays testable without a server.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrivateAgentError } = require('./private-agents');
const { privateAgentProfileName } = require('./hermes-bot-profile');

const GATEWAY_MEMBER = 'gateway';

// Moves a folder to the OS Trash instead of deleting it. macOS has a user
// Trash folder; elsewhere the folder is kept in the app's own trash folder so
// it stays recoverable. Returns the new location, or null when absent.
function moveFolderToTrash(folder, { trashDir, now = () => Date.now() } = {}) {
  if (!fs.existsSync(folder)) return null;
  const target = trashDir || (process.platform === 'darwin'
    ? path.join(os.homedir(), '.Trash')
    : path.join(path.dirname(path.dirname(path.resolve(folder))), 'trash'));
  fs.mkdirSync(target, { recursive: true });
  const destination = path.join(target, `${path.basename(folder)} ${now()}`);
  fs.renameSync(folder, destination);
  return destination;
}

function createPrivateAgentLifecycle({
  store,
  repository,
  companyIdFor,
  profilesRoot,
  provisionProfile,
  trashDir,
  isSoloWorkspace = () => true,
}) {
  function conversationsOf(companyId, owner, agentId, includeDeleted = false) {
    return repository.listConversations({ companyId, includeDeleted, limit: 1000 }).filter((conversation) => {
      const metadata = conversation.metadata && typeof conversation.metadata === 'object' ? conversation.metadata : {};
      return conversation.type === 'agent' && metadata.privateAgentId === agentId
        && String(conversation.createdBy || '').toLowerCase() === String(owner).toLowerCase();
    });
  }

  return {
    // Profiles are provisioned when an agent is made and again before a turn
    // (idempotent), so a restored data folder never leaves an agent without one.
    ensureProfiles(agentId) {
      provisionProfile({ agentId, google: false });
      provisionProfile({ agentId, google: true });
    },
    // The agent's main chat: reuses the oldest non-fresh one, else creates it.
    // The conversation is Mia-shaped (type agent, a bound gateway member) with
    // metadata.privateAgentId, which is what selects the agent's profile.
    openConversation(owner, agentId, req) {
      if (!isSoloWorkspace(req)) {
        throw new PrivateAgentError(400, 'solo_only', 'Personal agents are only available in Solo.');
      }
      const agent = store.get(owner, agentId);
      const companyId = companyIdFor(owner, req);
      const existing = conversationsOf(companyId, owner, agentId)
        .filter((conversation) => (conversation.metadata || {}).conversationMode !== 'fresh')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))[0];
      if (existing) return existing;
      const conversation = repository.createConversation({
        companyId,
        type: 'agent',
        name: agent.name,
        createdBy: String(owner).toLowerCase(),
        // No agentId: Mia's chat is the one canonical 'gateway' row per owner
        // (a unique index), so an agent's chat is told apart by privateAgentId.
        metadata: {
          privateAgentId: agentId,
          departments: [],
          workspaceId: 'solo',
          source: 'native-ui-private-agent',
        },
        owner: { principalId: String(owner).toLowerCase(), principalType: 'user' },
      });
      repository.addMember({
        companyId,
        conversationId: conversation.id,
        principalId: GATEWAY_MEMBER,
        principalType: 'agent',
        role: 'agent',
        state: 'active',
        metadata: { name: agent.name, manager: true, departments: [] },
      });
      return conversation;
    },
    // Keep the chat's display name in step with a rename.
    renamed(owner, agentId, req) {
      const companyId = companyIdFor(owner, req);
      for (const conversation of conversationsOf(companyId, owner, agentId)) {
        const agent = store.get(owner, agentId);
        repository.updateConversation({ companyId, id: conversation.id, name: agent.name, updatedAt: conversation.updatedAt });
        repository.addMember({
          companyId, conversationId: conversation.id, principalId: GATEWAY_MEMBER, principalType: 'agent',
          role: 'agent', state: 'active', metadata: { name: agent.name, manager: true, departments: [] },
        });
      }
    },
    // Account removal: the agents go, their Hermes folders go to the Trash.
    removeAllFor(owner) {
      for (const agent of store.list(owner)) {
        for (const google of [false, true]) {
          moveFolderToTrash(path.join(profilesRoot, privateAgentProfileName(agent.id, google)), { trashDir });
        }
      }
      return store.removeAllFor(owner);
    },
    // Order matters: validate, move the Hermes folders to the Trash (a failure
    // leaves everything as it was), hide the conversations, then drop the record.
    remove(owner, agentId, req, { confirm } = {}) {
      store.get(owner, agentId);
      if (confirm !== true) {
        throw new PrivateAgentError(400, 'confirmation_required', 'Confirm to delete this agent.');
      }
      const trashed = [];
      for (const google of [false, true]) {
        const moved = moveFolderToTrash(path.join(profilesRoot, privateAgentProfileName(agentId, google)), { trashDir });
        if (moved) trashed.push(moved);
      }
      const companyId = companyIdFor(owner, req);
      const deletedAt = new Date().toISOString();
      const conversations = conversationsOf(companyId, owner, agentId);
      for (const conversation of conversations) {
        repository.updateConversation({ companyId, id: conversation.id, deletedAt, updatedAt: deletedAt });
      }
      const result = store.remove(owner, agentId, { confirm: true });
      return { ...result, conversationsRemoved: conversations.length, profilesTrashed: trashed.length };
    },
  };
}

module.exports = { createPrivateAgentLifecycle, moveFolderToTrash };
