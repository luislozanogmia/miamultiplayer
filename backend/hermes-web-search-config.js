'use strict';

const fs = require('fs');
const path = require('path');

const MANAGED_KEYS = new Set(['FIRECRAWL_API_URL', 'FIRECRAWL_API_KEY']);
const MANAGED_COMMENT = '# Managed by Mia: installation-scoped hosted web-search gateway.';

function hermesHome() {
  const configured = String(process.env.HERMES_HOME || '').trim();
  if (!configured) throw new Error('Mia requires HERMES_HOME to be configured.');
  return path.resolve(configured);
}

function normalizedGatewayUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function provisionHermesWebSearchConfig({
  envPath = path.join(hermesHome(), '.env'),
  gatewayUrl = process.env.MIAOS_FIRECRAWL_GATEWAY_URL,
  gatewayToken = process.env.MIAOS_FIRECRAWL_GATEWAY_TOKEN,
} = {}) {
  const url = normalizedGatewayUrl(gatewayUrl);
  const token = String(gatewayToken || '').trim();
  const configured = !!url && token.length >= 32;

  let existing = '';
  try { existing = fs.readFileSync(envPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const hadManagedMarker = existing.split(/\r?\n/).some((line) => line.trim() === MANAGED_COMMENT);
  let removedManaged = false;
  const preserved = existing
    .split(/\r?\n/)
    .filter((line) => {
      if (line.trim() === MANAGED_COMMENT) {
        removedManaged = true;
        return false;
      }
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && MANAGED_KEYS.has(match[1]) && (configured || hadManagedMarker)) {
        removedManaged = true;
        return false;
      }
      return true;
    });
  while (preserved.length && preserved.at(-1) === '') preserved.pop();
  if (!configured && !removedManaged) return { configured: false, changed: false };
  const next = [
    ...preserved,
    ...(configured && preserved.length ? [''] : []),
    ...(configured ? [
      MANAGED_COMMENT,
      `FIRECRAWL_API_URL=${url}`,
      `FIRECRAWL_API_KEY=${token}`,
    ] : []),
    '',
  ].join('\n');
  if (existing === next) {
    try { fs.chmodSync(envPath, 0o600); } catch (_) { /* best effort on Windows */ }
    return { configured, changed: false };
  }

  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const temporary = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, envPath);
    fs.chmodSync(envPath, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed or already absent */ }
  }
  return { configured, changed: true };
}

module.exports = { provisionHermesWebSearchConfig, normalizedGatewayUrl };
