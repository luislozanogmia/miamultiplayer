'use strict';

// Release profiles are the security boundary for the local Hermes runtime.
// Keep environment interpretation here so provisioning and inference cannot
// silently choose different toolsets for the same process.
const RELEASE_PROFILES = Object.freeze({
  DEFAULT: 'default',
  TRUSTED_LOCAL: 'trusted-local',
  SINGLE_USER: 'single-user',
  TEAM_SEARCH: 'team-search',
});

const RELEASE_PROFILE_VALUES = Object.freeze(Object.values(RELEASE_PROFILES));
const SEARCH_ONLY_TURN_LIMIT = 200;
const FULL_AGENT_TURN_LIMIT = 200;

function envText(env, name) {
  const value = env && env[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

function invalidConfiguration(message) {
  // Configuration errors intentionally contain variable/profile names only;
  // never echo an email, token, path, or any other deployment value.
  return new Error(`invalid Mia release configuration: ${message}`);
}

function parseOptionalBoolean(env, name) {
  const raw = envText(env, name);
  if (!raw) return null;
  if (/^(?:1|true)$/i.test(raw)) return true;
  if (/^(?:0|false)$/i.test(raw)) return false;
  throw invalidConfiguration(`${name} must be one of 0, 1, true, or false`);
}

/**
 * Resolve the effective local release profile from a supplied environment.
 * A supplied object makes the startup contract testable without mutating the
 * caller's process environment.
 */
function resolveReleaseProfile(env = process.env) {
  const requested = envText(env, 'MIAOS_RELEASE_PROFILE').toLowerCase();
  const singleUserEmail = envText(env, 'MIAOS_SINGLE_USER_EMAIL');
  const requestedSearchOnly = parseOptionalBoolean(env, 'MIAOS_AGENT_SEARCH_ONLY');
  const noAuth = /^(?:1|true)$/i.test(envText(env, 'MIAOS_NO_AUTH'));

  if (requested && !RELEASE_PROFILE_VALUES.includes(requested)) {
    throw invalidConfiguration(
      `MIAOS_RELEASE_PROFILE must be one of ${RELEASE_PROFILE_VALUES.join(', ')}`
    );
  }

  const explicitProfile = Boolean(requested);
  const profile = requested || (
    singleUserEmail ? RELEASE_PROFILES.SINGLE_USER : RELEASE_PROFILES.DEFAULT
  );

  // The auth layer still uses MIAOS_SINGLE_USER_EMAIL as its owner boundary.
  // Reject profile combinations that would make the runtime claim one
  // security mode while auth operates in another.
  if (profile === RELEASE_PROFILES.SINGLE_USER && !singleUserEmail) {
    throw invalidConfiguration(
      'MIAOS_RELEASE_PROFILE=single-user requires MIAOS_SINGLE_USER_EMAIL'
    );
  }
  if (
    (profile === RELEASE_PROFILES.DEFAULT || profile === RELEASE_PROFILES.TRUSTED_LOCAL)
    && explicitProfile
    && singleUserEmail
  ) {
    throw invalidConfiguration(
      `MIAOS_RELEASE_PROFILE=${profile} cannot be combined with MIAOS_SINGLE_USER_EMAIL`
    );
  }
  if (profile === RELEASE_PROFILES.TEAM_SEARCH && singleUserEmail) {
    throw invalidConfiguration(
      'MIAOS_RELEASE_PROFILE=team-search cannot be combined with MIAOS_SINGLE_USER_EMAIL'
    );
  }

  const profileSearchOnly = profile === RELEASE_PROFILES.SINGLE_USER
    || profile === RELEASE_PROFILES.TEAM_SEARCH;
  if (profileSearchOnly && noAuth) {
    throw invalidConfiguration(
      `MIAOS_NO_AUTH cannot be enabled for the ${profile} release profile`
    );
  }
  if (profileSearchOnly && requestedSearchOnly === false) {
    throw invalidConfiguration(
      `MIAOS_AGENT_SEARCH_ONLY=false cannot disable the ${profile} confinement`
    );
  }

  const agentSearchOnly = profileSearchOnly || requestedSearchOnly === true;
  return Object.freeze({
    name: profile,
    profile,
    agentSearchOnly,
    maxTurns: agentSearchOnly ? SEARCH_ONLY_TURN_LIMIT : FULL_AGENT_TURN_LIMIT,
    singleUser: profile === RELEASE_PROFILES.SINGLE_USER,
    teamSearch: profile === RELEASE_PROFILES.TEAM_SEARCH,
  });
}

const EFFECTIVE_RELEASE_PROFILE = resolveReleaseProfile(process.env);
const MIAOS_RELEASE_PROFILE = EFFECTIVE_RELEASE_PROFILE.name;
const MIAOS_AGENT_SEARCH_ONLY = EFFECTIVE_RELEASE_PROFILE.agentSearchOnly;
const MIAOS_AGENT_MAX_TURNS = EFFECTIVE_RELEASE_PROFILE.maxTurns;

module.exports = {
  EFFECTIVE_RELEASE_PROFILE,
  FULL_AGENT_TURN_LIMIT,
  MIAOS_AGENT_MAX_TURNS,
  MIAOS_AGENT_SEARCH_ONLY,
  MIAOS_RELEASE_PROFILE,
  RELEASE_PROFILES,
  RELEASE_PROFILE_VALUES,
  SEARCH_ONLY_TURN_LIMIT,
  resolveReleaseProfile,
};
