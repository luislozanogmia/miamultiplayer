'use strict';

const FAILED_NOTICE = 'Your request was not processed. Send it again if you still want me to carry it out.';
const PARTIAL_NOTICE = 'This turn did not complete. Some actions may already have run; verify their effects before resending.';

function isFailedTurnNotice(content) {
  return [FAILED_NOTICE, PARTIAL_NOTICE].includes(String(content || '').trim());
}

function cronFailureMessage(bot, error, automation, job = {}) {
  const detail = String(error || '');
  // Never interpolate provider error bodies: they can contain secrets or private URLs.
  const providers = {
    'claude-subscription-directsdk-experimental': 'Claude subscription',
    'openai-codex': 'ChatGPT subscription',
    anthropic: 'Claude', openai: 'OpenAI', deepseek: 'DeepSeek',
  };
  const match = detail.match(/provider\s+['"]([^'"]+)['"]/i);
  const provider = providers[job.provider] || providers[match?.[1]?.toLowerCase()] || 'AI model';
  const name = String(automation?.name || bot?.name || 'This automation').trim() || 'This automation';
  if (/billing_error|insufficient[_ ](?:credits?|funds)|credit balance|payment required/i.test(detail)) {
    return `${name} could not complete because its ${provider} provider rejected the model request for a billing or account-access reason. Check the model connection and account access in Mia before retrying. This error alone does not establish that a payment is due.`;
  }
  if (/credentials?|api[_ ]?key|unauthorized|authentication|expired.*(?:login|session|token)|(?:login|session|token).*expired|HTTP\s*401\b/i.test(detail)) {
    return `${name} could not complete because its ${provider} model connection is missing, expired, or was rejected. Reconnect the model in Mia before retrying.`;
  }
  if (/rate[_ -]?limit|quota|HTTP\s*429\b/i.test(detail)) {
    return `${name} could not complete because its ${provider} provider reported a usage or rate limit. Check the account limits and wait before retrying.`;
  }
  if (/ClaudeAPIError|(?:model|provider|upstream).*(?:error|fail|unavailable|response)|HTTP\s*(?:400|402|403|404|5\d\d)\b/i.test(detail)) {
    return `${name} could not complete because its ${provider} model request failed. Check the model connection or try another model before retrying.`;
  }
  return `${name} could not complete this run. Please try again; if it continues, contact your administrator.`;
}

function failureMatchesTranscript(row, failed, timestampMs) {
  if (!row || !failed || !isFailedTurnNotice(row.content)) return false;
  const started = timestampMs(failed.startedAt);
  // A ledger claim can precede session creation. Never use a different run's error.
  return Number.isFinite(started) && started >= timestampMs(row.startedAt) - 60000
    && started <= timestampMs(row.endedAt);
}

module.exports = { cronFailureMessage, isFailedTurnNotice, failureMatchesTranscript };
