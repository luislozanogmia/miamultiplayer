'use strict';

// Centralized instance identity for this TemplateOS deployment. Every value
// has a neutral default so a fresh checkout runs as "Mia" with no
// client-specific naming baked in — a demo/client deployment is a config of
// this template (env vars), not a fork of the code.

const INSTANCE_NAME = process.env.INSTANCE_NAME || 'Mia';
const INSTANCE_TEAM_DESCRIPTION = process.env.INSTANCE_TEAM_DESCRIPTION || 'an internal operations team';
const INSTANCE_DOMAINS = (process.env.INSTANCE_DOMAINS || 'example.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Legacy shared-password mode (used only while the `users` table is empty)
// works only when INSTANCE_PASSWORD is explicitly set — there is no default,
// so a fresh install accepts no logins until real users are created or a
// password is deliberately configured.
const INSTANCE_PASSWORD = process.env.INSTANCE_PASSWORD || '';

module.exports = { INSTANCE_NAME, INSTANCE_TEAM_DESCRIPTION, INSTANCE_DOMAINS, INSTANCE_PASSWORD };
