'use strict';

// Models Mia no longer offers on a provider, and what a saved choice of one
// becomes. Bots, chats and schedules that picked a retired model keep working
// on its successor instead of failing or dropping to the provider default.
// Scoped by provider: another provider may still serve the same name.
const RETIRED_HERMES_MODELS = Object.freeze({
  'openai-codex': Object.freeze({
    'gpt-6-sol': 'gpt-6.1-sol',
    'gpt-6-luna': 'gpt-6.1-sol',
  }),
  'claude-subscription-directsdk-experimental': Object.freeze({
    'claude-sonnet-5': 'claude-sonnet-5-5[1m]',
    'claude-sonnet-5[1m]': 'claude-sonnet-5-5[1m]',
    'claude-haiku-4-5': 'claude-haiku-5-5',
    'claude-haiku-4-5-20251001': 'claude-haiku-5-5',
    'claude-opus-5': 'claude-opus-5-5[1m]',
    'claude-opus-5[1m]': 'claude-opus-5-5[1m]',
    'claude-opus-4-8': 'claude-opus-5-5[1m]',
    'claude-opus-4-8[1m]': 'claude-opus-5-5[1m]',
  }),
});

function retiredModels(provider) {
  return RETIRED_HERMES_MODELS[String(provider || '').trim().toLowerCase()] || {};
}

function isRetiredHermesModel(provider, model) {
  return Object.prototype.hasOwnProperty.call(retiredModels(provider), String(model || '').trim().toLowerCase());
}

function currentHermesModel(provider, model) {
  const raw = String(model || '').trim();
  return isRetiredHermesModel(provider, raw) ? retiredModels(provider)[raw.toLowerCase()] : raw;
}

module.exports = { RETIRED_HERMES_MODELS, isRetiredHermesModel, currentHermesModel };
