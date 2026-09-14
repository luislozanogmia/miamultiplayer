import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_AGENTS,
  miaosWorkspacePromptContext,
  provisionMiaosWorkspace,
} = require('./miaos-workspace');

test('Mia provisions a private workspace AGENTS.md without overwriting user instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-workspace-'));
  try {
    const first = provisionMiaosWorkspace({ workspaceDir: root });
    assert.equal(first.created, true);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(first.agentsPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(first.agentsPath, 'utf8'), DEFAULT_AGENTS);

    const custom = '# Project-specific instructions\n\nUse the user\'s preferred format.\n';
    fs.writeFileSync(first.agentsPath, custom);
    const second = provisionMiaosWorkspace({ workspaceDir: root });
    assert.equal(second.created, false);
    assert.equal(fs.readFileSync(second.agentsPath, 'utf8'), custom);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace prompt includes the active AGENTS.md path and content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-workspace-prompt-'));
  try {
    const { agentsPath } = provisionMiaosWorkspace({ workspaceDir: root });
    fs.writeFileSync(agentsPath, '# Local rule\nKeep generated files here.\n');
    const prompt = miaosWorkspacePromptContext({ workspaceDir: root });
    assert.doesNotMatch(prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt, /terminal current directory is the app-owned local workspace/);
    assert.match(prompt, /Workspace instructions:/);
    assert.match(prompt, /Keep generated files here/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
