'use strict';

// One line in every bot prompt (Solo chats, team channels, automations) that
// says where Mia's own code is, so a bot asked about Mia itself can read the
// version the person is running. The desktop shell passes the installed
// app's resources folder (readable backend/ and frontend/, no tests) and its
// version. The home folder is written as ~, so no user name reaches a prompt.

const os = require('os');
const path = require('path');

const MIA_REPO_URL = 'https://github.com/luislozanogmia/miamultiplayer';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

function withoutHome(folder, home = os.homedir()) {
  const full = path.resolve(folder);
  if (!home) return full;
  const relative = path.relative(path.resolve(home), full);
  if (relative === '') return '~';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return '~/' + relative.split(path.sep).join('/');
  return full;
}

function appResourcesFolder(env = process.env) {
  const configured = String(env.MIAOS_APP_RESOURCES || '').trim();
  return withoutHome(configured || path.resolve(__dirname, '..'));
}

function appVersion(env = process.env) {
  const configured = String(env.MIAOS_APP_VERSION || '').trim();
  if (VERSION.test(configured)) return configured;
  try {
    const version = String(require('../macos/package.json').version || '');
    return VERSION.test(version) ? version : '';
  } catch (_) { return ''; }
}

function miaCodeLine(env = process.env) {
  const version = appVersion(env);
  return `Mia's own code, for questions about Mia itself: the installed app${version ? ` (version ${version})` : ''} keeps its readable source in ${appResourcesFolder(env)} (backend/ and frontend/, no tests), and the public repo is ${MIA_REPO_URL}. Treat both as read-only references. When you need tests or history, clone the repo${version ? ` at tag v${version}` : ''} into your working folder.`;
}

module.exports = { MIA_REPO_URL, appResourcesFolder, appVersion, miaCodeLine, withoutHome };
