'use strict';

// Everything around a personal agent that touches more than its registry
// record: its Hermes profile folders, its conversations and its chat.
// Dependencies are injected so this stays testable without a server.

const fs = require('fs');
const path = require('path');
const { moveFile, moveToTrash } = require('./artifacts');
const { PrivateAgentError } = require('./private-agents');
const { privateAgentProfileName } = require('./hermes-bot-profile');

const GATEWAY_MEMBER = 'gateway';

// Moves a folder to the OS Trash (the Recycle Bin on Windows) instead of deleting
// it, so it stays recoverable. Returns null when the folder is absent, otherwise
// the new location, which Windows does not report. `trashDir` is for tests.
function moveFolderToTrash(folder, { trashDir, now = () => Date.now(), platform, home, runPowerShell } = {}) {
  if (!fs.existsSync(folder)) return null;
  if (!trashDir) return moveToTrash(folder, { platform, home, runPowerShell });
  fs.mkdirSync(trashDir, { recursive: true });
  const destination = path.join(trashDir, `${path.basename(folder)} ${now()}`);
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

  // Both folders or neither: if the second cannot move, the first moves back. The
  // Recycle Bin gives no path to move back from, so on Windows the first stays there.
  function trashProfiles(agentId) {
    const moved = [];
    try {
      for (const google of [false, true]) {
        const folder = path.join(profilesRoot, privateAgentProfileName(agentId, google));
        const destination = moveFolderToTrash(folder, { trashDir });
        if (destination !== null) moved.push({ folder, destination });
      }
    } catch (error) {
      for (const { folder, destination } of moved) {
        if (destination) moveFile(destination, folder);
      }
      throw error;
    }
    return moved.length;
  }

  function hideConversations(companyId, owner, agentId) {
    const deletedAt = new Date().toISOString();
    const conversations = conversationsOf(companyId, owner, agentId);
    for (const conversation of conversations) {
      repository.updateConversation({ companyId, id: conversation.id, deletedAt, updatedAt: deletedAt });
    }
    return conversations.length;
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
    // Account removal: the agents go, their Hermes folders go to the Trash and
    // their chats are hidden, the same as deleting each one.
    removeAllFor(owner) {
      const companyId = companyIdFor(owner);
      for (const agent of store.list(owner)) {
        trashProfiles(agent.id);
        hideConversations(companyId, owner, agent.id);
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
      const profilesTrashed = trashProfiles(agentId);
      const conversationsRemoved = hideConversations(companyIdFor(owner, req), owner, agentId);
      const result = store.remove(owner, agentId, { confirm: true });
      return { ...result, conversationsRemoved, profilesTrashed };
    },
  };
}

module.exports = { createPrivateAgentLifecycle, moveFolderToTrash };
