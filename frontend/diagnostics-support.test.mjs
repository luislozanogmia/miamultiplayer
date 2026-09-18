import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('diagnostics offers a safe support handoff without exposing content', async () => {
  const [html, source, server] = await Promise.all([
    readFile(resolve(root, 'frontend/index.html'), 'utf8'),
    readFile(resolve(root, 'frontend/app.js'), 'utf8'),
    readFile(resolve(root, 'backend/server.js'), 'utf8'),
  ]);

  assert.match(html, /id="appDevCopySummary"[^>]*>Copy safe support summary/);
  assert.match(html, /Health and capacity state only; no credentials or conversation text\./);
  assert.match(source, /function buildAppDevSupportSummary\(\)[\s\S]*api\('\/healthz'\)[\s\S]*api\('\/api\/dev\/diagnostics'\)/);
  assert.match(source, /Mia safe support summary[\s\S]*Workspace:[\s\S]*Database:[\s\S]*Inference capacity:[\s\S]*Trace events captured:/);
  assert.doesNotMatch(source, /diagnostics\.events\.map|diagnostics\.events\.join/);
  assert.match(source, /copy\.addEventListener\('click'[\s\S]*copyAppDevSupportSummary\(\)/);
  assert.match(server, /function requireLocalDevelopment\(req, res, next\)[\s\S]*!isLoopbackRequest\(req\)[\s\S]*res\.status\(404\)/);
  assert.match(server, /MIAOS_MAX_CONCURRENT_INFERENCE/);
  assert.match(server, /maxConcurrent: MAX_CONCURRENT_INFERENCE[\s\S]*maxQueueDepth: MAX_QUEUE_DEPTH/);
  assert.match(html, /<h3>Compute is transparent<\/h3>[\s\S]*no in-app platform billing/);
});
