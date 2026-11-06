'use strict';

const { hubEndpoint } = require('./hub-client');
const { CLERK_INSTANCES } = require('./clerk-config');

// A client-supplied company tag is never evidence of membership. The Hub and
// the locally linked production Clerk account must agree before it is saved.
async function verifyTeamWorkspaceMembership({ workspace, token, owner, dataDirectory, getIdentity, isOwnerActive, fetcher = fetch }) {
  const teamId = /^hub_([a-f0-9]{32})$/.exec(workspace || '')?.[1];
  if (!teamId || typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,16384}$/.test(token)
      || !isOwnerActive(owner)) return false;
  const identity = getIdentity(owner);
  if (!identity || identity.issuer !== CLERK_INSTANCES.production.issuer || !identity.subject || !identity.email) return false;
  const origin = hubEndpoint(dataDirectory);
  if (!origin) return false;
  try {
    const response = await fetcher(origin + '/v1/me', {
      method: 'GET', redirect: 'error',
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return false;
    const me = await response.json();
    const current = getIdentity(owner);
    if (!isOwnerActive(owner) || !current || current.subject !== identity.subject
        || current.issuer !== identity.issuer || current.email !== identity.email) return false;
    return Array.isArray(me.teams) && me.teams.some(team => team.teamId === teamId
      && team.membership && team.membership.clerk_user_id === identity.subject
      && String(team.membership.email || '').trim().toLowerCase() === String(identity.email).trim().toLowerCase());
  } catch (_) {
    return false;
  }
}

module.exports = { verifyTeamWorkspaceMembership };
