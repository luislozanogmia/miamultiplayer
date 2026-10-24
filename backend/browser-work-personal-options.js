'use strict';
const { chatModelSelectionInferenceOptions } = require('./chat-model-selection');

async function resolveBrowserWorkPersonalOptions({ owner, requested, refreshInventory, resolveSelection, defaultOptions }) {
  await refreshInventory();
  const selection = requested === undefined ? null : await resolveSelection(requested, owner);
  if (requested !== undefined && !selection) throw Object.assign(new Error('Choose a connected model for Mia'), { status: 409 });
  const options = chatModelSelectionInferenceOptions(await defaultOptions(owner), selection);
  if (!options?.model) throw Object.assign(new Error('Choose a connected model for Mia'), { status: 409 });
  return options;
}
module.exports = { resolveBrowserWorkPersonalOptions };
