'use strict';

// Finds and stops the process behind a localhost address on the Apps page. Mia
// did not start these servers, so it asks the system which process holds the port.
const { execFile } = require('child_process');

const run = (command, args) => new Promise(resolve => {
  execFile(command, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error && !stdout ? null : String(stdout || '')));
});

function portOf(value) {
  const url = new URL(value);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// lsof -F prints one field per line: p<pid>, then c<name>.
function parseLsof(output) {
  const found = new Map();
  let pid = null;
  for (const line of String(output).split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); if (Number.isInteger(pid) && pid > 0) found.set(pid, ''); else pid = null; }
    else if (line[0] === 'c' && pid) found.set(pid, line.slice(1));
  }
  return [...found].map(([id, name]) => ({ pid: id, name }));
}

function parseNetstat(output, port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'TCP' && parts[3] === 'LISTENING' && parts[1].endsWith(`:${port}`) && Number(parts[4]) > 0) pids.add(Number(parts[4]));
  }
  return [...pids];
}

async function listeners(port, { platform = process.platform, exec = run } = {}) {
  if (platform === 'win32') {
    const pids = parseNetstat(await exec('netstat', ['-ano', '-p', 'tcp']), port);
    return Promise.all(pids.map(async pid => {
      const row = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      return { pid, name: (/^"([^"]+)"/.exec(String(row || '').trim()) || [])[1] || '' };
    }));
  }
  const args = ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'];
  for (const lsof of ['/usr/sbin/lsof', '/usr/bin/lsof']) {
    const output = await exec(lsof, args);
    if (output !== null) return parseLsof(output);
  }
  return [];
}

// Mia itself and the helpers it runs must never be stopped from this page.
async function protectedPids({ self = process.pid, parent = process.ppid, platform = process.platform, exec = run } = {}) {
  const pids = new Set([self, parent]);
  if (platform !== 'win32') {
    const rows = await exec('ps', ['-A', '-o', 'pid=,ppid=']);
    for (const row of String(rows || '').split('\n')) {
      const [pid, ppid] = row.trim().split(/\s+/).map(Number);
      if (ppid === self || ppid === parent) pids.add(pid);
    }
  }
  return pids;
}

async function serverBehind(url, options = {}) {
  const port = portOf(url);
  const found = port ? await listeners(port, options) : [];
  if (!found.length) return { found: false };
  const shielded = await protectedPids(options);
  if (found.some(item => shielded.has(item.pid))) return { found: true, protected: true };
  return { found: true, name: found[0].name || 'A program', pids: found.map(item => item.pid) };
}

// Asks politely, the way closing a terminal does: a server can save and exit.
async function stopServer(url, expectedPids, options = {}) {
  const { kill = process.kill.bind(process), sleep = ms => new Promise(done => setTimeout(done, ms)) } = options;
  const server = await serverBehind(url, options);
  if (!server.found) return { stopped: true };
  if (server.protected) return { stopped: false, reason: 'protected' };
  const expected = new Set(expectedPids);
  if (!server.pids.every(pid => expected.has(pid))) return { stopped: false, reason: 'changed' };
  try { for (const pid of server.pids) kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') return { stopped: false, reason: error.code === 'EPERM' ? 'denied' : 'failed' }; }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(300);
    if (!(await serverBehind(url, options)).found) return { stopped: true };
  }
  return { stopped: false, reason: 'still_running' };
}

module.exports = { parseLsof, parseNetstat, portOf, protectedPids, serverBehind, stopServer };
