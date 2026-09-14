#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

const MAX_STDIN_BYTES = 32 * 1024;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function cleanText(value, field, maxLength) {
  const text = String(value || '').trim();
  if (!text) fail(`${field} is required`, 2);
  if (text.length > maxLength) fail(`${field} must be ${maxLength} characters or fewer`, 2);
  return text;
}

function normalizePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('payload must be a JSON object', 2);
  const name = cleanText(input.name, 'name', 40);
  const role = cleanText(input.role, 'role', 500);
  const output = cleanText(input.output, 'output', 500);
  const departments = input.departments === undefined ? [] : input.departments;
  if (!Array.isArray(departments) || departments.length > 10) {
    fail('departments must be an array with at most 10 values', 2);
  }
  const normalizedDepartments = departments.map((value) => cleanText(value, 'department', 80));
  return {
    name,
    role,
    output,
    instructions: `Role: ${role}\n\nDesired output: ${output}`,
    departments: normalizedDepartments,
    status: 'running',
    replyAlways: false,
  };
}

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_STDIN_BYTES) {
        reject(Object.assign(new Error('payload is too large'), { exitCode: 2 }));
        stream.destroy();
      }
    });
    stream.on('end', () => resolve(body));
    stream.on('error', reject);
  });
}

function requestJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body === null ? null : JSON.stringify(body);
    const request = transport.request(target, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 15000,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { /* handled by caller */ }
        resolve({ status: response.statusCode || 0, data });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Mia request timed out')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function apiConfig(env = process.env) {
  const baseUrl = String(env.MIAOS_BASE_URL || `http://127.0.0.1:${env.MIAOS_PORT || '4871'}`).replace(/\/+$/, '');
  const workspace = String(env.MIAOS_WORKSPACE || 'solo').trim().toLowerCase() === 'multiplayer_test' ? 'multiplayer_test' : 'solo';
  const token = String(env.MIAOS_API_KEY || '').trim();
  return {
    baseUrl,
    headers: {
      'x-miaos-workspace': workspace,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
}

async function createBot(payload, { request = requestJson, env = process.env } = {}) {
  const bot = normalizePayload(payload);
  const config = apiConfig(env);
  const listed = await request(`${config.baseUrl}/api/bots`, { headers: config.headers });
  if (listed.status === 401) fail('Mia authorization is required', 3);
  if (listed.status !== 200 || !listed.data || !Array.isArray(listed.data.bots)) {
    fail('Mia is unavailable or returned an invalid bot list', 3);
  }
  const existing = listed.data.bots.find((candidate) =>
    String(candidate && candidate.name || '').trim().toLowerCase() === bot.name.toLowerCase()
  );
  if (existing) return { status: 'existing', bot: { id: existing.id, name: existing.name } };

  const created = await request(`${config.baseUrl}/api/bots`, {
    method: 'POST',
    headers: config.headers,
    body: bot,
  });
  if (created.status === 401) fail('Mia authorization is required', 3);
  if (created.status !== 201 || !created.data || !created.data.bot) {
    fail((created.data && (created.data.message || created.data.error)) || 'Mia could not create the bot', 3);
  }
  return { status: 'created', bot: { id: created.data.bot.id, name: created.data.bot.name } };
}

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    if (argv[0] !== 'create') fail('usage: miaos-bot create --confirmed', 2);
    if (!argv.includes('--confirmed')) fail('explicit confirmation is required; review the proposal first', 2);
    const raw = await readStdin(io.stdin || process.stdin);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { fail('stdin must contain one valid JSON object', 2); }
    const result = await createBot(parsed, io);
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ status: 'error', error: error.message || 'bot creation failed' })}\n`);
    return error.exitCode || 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { apiConfig, createBot, main, normalizePayload };
