'use strict';

// Models Mia no longer offers on a provider, and what a saved choice of one
// becomes. Bots, chats and schedules that picked a retired model keep working
// on its successor instead of failing or dropping to the provider default.
// Scoped by provider: another provider may still serve the same name.
const RETIRED_HERMES_MODELS = Object.freeze({
  'openai-codex': Object.freeze({
    'gpt-5.6-sol': 'gpt-6.1-sol',
    'gpt-5.6-terra': 'gpt-6.1-terra',
    'gpt-5.6-luna': 'gpt-6-luna',
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

// ChatGPT accounts still list older models. Mia offers GPT-6 and newer there,
// so anything else a saved choice or a live list names moves to Luna.
const CHATGPT_PROVIDER = 'openai-codex';
const CHATGPT_OLDEST_VERSION = 6;
const CHATGPT_SUCCESSOR = 'gpt-6-luna';

function isOlderChatgptModel(provider, model) {
  if (String(provider || '').trim().toLowerCase() !== CHATGPT_PROVIDER || !model.startsWith('gpt-')) return false;
  const version = /^gpt-(\d+)/.exec(model);
  return !version || Number(version[1]) < CHATGPT_OLDEST_VERSION;
}

function isRetiredHermesModel(provider, model) {
  const name = String(model || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(retiredModels(provider), name) || isOlderChatgptModel(provider, name);
}

function currentHermesModel(provider, model) {
  const raw = String(model || '').trim();
  if (!isRetiredHermesModel(provider, raw)) return raw;
  return retiredModels(provider)[raw.toLowerCase()] || CHATGPT_SUCCESSOR;
}

module.exports = { RETIRED_HERMES_MODELS, isRetiredHermesModel, currentHermesModel };
