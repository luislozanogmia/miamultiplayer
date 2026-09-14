'use strict';

const CHAT_REASONING_EFFORTS = Object.freeze([
  'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const CHAT_SPEEDS = Object.freeze(['normal', 'fast']);

function cleanId(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanLabel(value, fallback) {
  const label = String(value || '').trim();
  return label || fallback;
}

function normalizeCapabilities(capabilities, models) {
  const input = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const result = {};
  for (const model of models) {
    const key = cleanId(model);
    const capability = input[model] || input[key];
    result[key] = {
      fast: Boolean(capability && capability.fast === true),
      reasoning: capability ? capability.reasoning !== false : true,
    };
  }
  return result;
}

// Keep the server's selection boundary independent from the gateway payload
// shape. The gateway inventory is authoritative for which authenticated
// providers/models are selectable; the browser never gets to expand it.
function normalizeChatModelInventory(payload) {
  const rows = payload && Array.isArray(payload.providers) ? payload.providers : [];
  const providers = {};
  for (const row of rows) {
    if (!row || row.authenticated === false) continue;
    const id = cleanId(row.slug || row.id);
    if (!id) continue;
    // MoA is a gateway orchestration preset, not a concrete model/provider
    // choice. Keep the chat picker limited to models the user can select.
    if (id === 'moa') continue;
    const models = Array.from(new Set(
      (Array.isArray(row.models) ? row.models : [])
        .map((model) => String(model || '').trim())
        .filter(Boolean)
    ));
    if (!models.length) continue;
    providers[id] = {
      id,
      label: cleanLabel(row.name || row.label, id),
      models,
      capabilities: normalizeCapabilities(row.capabilities, models),
    };
  }
  return providers;
}

function inventoryResponse(providers) {
  return Object.values(providers || {}).map((provider) => ({
    id: provider.id,
    label: provider.label,
    models: provider.models.slice(),
    capabilities: { ...provider.capabilities },
  }));
}

// Mia is a product-facing picker, not a gateway diagnostics surface. Only
// show providers the user explicitly selected during onboarding, and hide
// context-window variants whose implementation labels are not meaningful to
// non-technical users.
function visibleChatModelInventory(providers, providerIds) {
  const allowed = new Set((providerIds || []).map(cleanId).filter(Boolean));
  const result = {};
  for (const [id, provider] of Object.entries(providers || {})) {
    if (!allowed.has(cleanId(id))) continue;
    const models = provider.models.filter((model) => !/-900k$/i.test(String(model || '').trim()));
    if (!models.length) continue;
    result[id] = {
      ...provider,
      models,
      capabilities: Object.fromEntries(models.map((model) => [
        cleanId(model),
        provider.capabilities[cleanId(model)] || { fast: false, reasoning: true },
      ])),
    };
  }
  return result;
}

function findProviderModel(providers, providerId, modelId) {
  const provider = providers && providers[cleanId(providerId)];
  if (!provider) return null;
  const requested = cleanId(modelId);
  const model = provider.models.find((candidate) => cleanId(candidate) === requested);
  if (!model) return null;
  return { provider, model };
}

function normalizeChatModelSelection(raw, providers) {
  if (!raw || typeof raw !== 'object') return null;
  const found = findProviderModel(providers, raw.provider, raw.model);
  if (!found) throw new Error('selected model is not available for the connected provider');

  const reasoningEffort = cleanId(raw.reasoningEffort || raw.reasoning_effort || 'high');
  if (!CHAT_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error('unsupported reasoning effort');
  }
  const speed = cleanId(raw.speed || (raw.fast === true ? 'fast' : 'normal'));
  if (!CHAT_SPEEDS.includes(speed)) throw new Error('unsupported response speed');

  const capability = found.provider.capabilities[cleanId(found.model)] || { fast: false, reasoning: true };
  if (speed === 'fast' && capability.fast !== true) {
    throw new Error('fast response speed is not available for the selected model');
  }
  if (reasoningEffort !== 'none' && capability.reasoning === false) {
    throw new Error('reasoning effort is not available for the selected model');
  }

  return {
    provider: found.provider.id,
    model: found.model,
    reasoningEffort,
    speed,
    fast: speed === 'fast',
  };
}

function chatModelSelectionInferenceOptions(baseOptions, selection) {
  const options = { ...(baseOptions || {}) };
  if (!selection) return Object.keys(options).length ? options : undefined;
  return {
    ...options,
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    fast: selection.fast === true,
  };
}

function userFacingModelDispatchError(error) {
  const message = String(error && error.message || error || '');
  if (/invalid[_ -]?api[_ -]?key|incorrect api key|\b401\b|unauthori[sz]ed|authentication failed/i.test(message)) {
    return 'Your connected model credential was rejected. Reconnect it in Settings → Access, then try again.';
  }
  if (/\b429\b|rate[_ -]?limit|usage limit|quota|too many requests/i.test(message)) {
    return 'Your provider’s usage limit was reached. Wait or switch models.';
  }
  if (/could not resolve credentials|no [a-z ]*credentials stored/i.test(message)) {
    // Hermes says this both when a provider was never connected and when its
    // only credential is exhausted (usage limit) — name both causes.
    return 'That model’s credential is unavailable right now: it is disconnected or out of usage. Reconnect it in Settings → Access, or switch models.';
  }
  if (/no usable credentials|provider credential missing|set [A-Z0-9_]+_API_KEY/i.test(message)) {
    return 'No usable model credential is connected. Connect one in Settings → Access, then try again.';
  }
  if (/selected model is not available|unsupported reasoning effort|response speed is not available/i.test(message)) {
    return 'That model selection is no longer available. Choose a connected model, then try again.';
  }
  return 'I couldn’t complete that response. Please try again.';
}

module.exports = {
  CHAT_REASONING_EFFORTS,
  CHAT_SPEEDS,
  normalizeChatModelInventory,
  inventoryResponse,
  visibleChatModelInventory,
  normalizeChatModelSelection,
  chatModelSelectionInferenceOptions,
  userFacingModelDispatchError,
};
