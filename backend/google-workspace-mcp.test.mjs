import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backend = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(backend, 'mia-google-workspace-mcp.py');

test('bundled Workspace server exposes the curated non-destructive tools used by Mia and Bots', () => {
  const result = spawnSync('python3', [server, '--describe'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.deepEqual(description.services, ['Gmail', 'Calendar', 'Drive', 'Sheets', 'Docs', 'Slides']);
  for (const name of [
    'google_gmail_list', 'google_gmail_get', 'google_gmail_send',
    'google_calendar_list', 'google_calendar_get', 'google_calendar_create',
    'google_drive_list', 'google_drive_get', 'google_drive_create',
    'google_sheets_get', 'google_sheets_create', 'google_sheets_update', 'google_sheets_append',
    'google_docs_get', 'google_docs_create', 'google_docs_append', 'google_docs_replace',
    'google_slides_get', 'google_slides_create', 'google_slides_add_text_slide', 'google_slides_replace_text',
  ]) assert.ok(description.tools.includes(name), `${name} is missing`);
  assert.equal(description.tools.some((name) => /delete|trash|clear/i.test(name)), false);
});
