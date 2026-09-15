'use strict';

function preferredName(value) {
  const name = String(value || '').trim();
  return name && name.length <= 80 && !name.includes('@') && !/[\r\n]/.test(name)
    && !/^(local user|user|there)$/i.test(name) ? name : '';
}

function openingMessage(displayName) {
  const name = preferredName(displayName);
  return name
    ? `Hi ${name}! Is ${name} what you’d like me to call you?`
    : 'Hi, I’m Mia! What should I call you?';
}

// This first exchange is an app-owned profile confirmation. An ordinary task
// must still reach the model, and must never become the person's display name.
function nameAnswer(text, suggestedName) {
  const value = String(text || '').trim();
  if (/^(yes|yes please|that’s right|that's right|correct)[.!]?$/i.test(value)) {
    const name = preferredName(suggestedName);
    return name ? { name } : { askName: true };
  }
  if (/^(no|no thanks|another name|use another name)[.!]?$/i.test(value)) return { askName: true };
  if (/^(skip|skip for now)[.!]?$/i.test(value)) return { skip: true };
  const explicit = /^(?:please )?(?:call me|my name is|i['’]d like(?: you to call me)?|i prefer)\s+(.+?)[.!]?$/i.exec(value);
  const name = preferredName(explicit ? explicit[1] : value);
  // Bare single names are unambiguous in direct response to the name question.
  // Multiword names can use "Call me …" or the explicit name confirmation UI.
  const explicitName = explicit && /^[\p{L}][\p{L}\p{M}'’-]*(?: [\p{L}][\p{L}\p{M}'’-]*){0,3}$/u.test(name)
    && !/^(a|an|the|to|some|help|you|working|something)\b/i.test(name);
  if (name && (explicitName || (!explicit && /^[\p{L}][\p{L}\p{M}'’-]*$/u.test(name)))
    && !/^(hello|hi|hey|help|test|thanks|okay|ok)$/i.test(name)) return { name };
  return { passthrough: true };
}

module.exports = { preferredName, openingMessage, nameAnswer };
