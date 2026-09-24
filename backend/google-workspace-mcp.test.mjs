import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const backend = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(backend, 'mia-google-workspace-mcp.py');

test('Drive content read downloads only to a private temporary file and cleans up', () => {
  const result = spawnSync('python3', ['-c', `
import runpy, os, json, base64
m = runpy.run_path(${JSON.stringify(server)})
paths = []
metadata = {'id':'shared_fixture_123456', 'name':'fixture.bin', 'mimeType':'application/octet-stream', 'size':'3', 'trashed':False, 'capabilities':{'canDownload':True}}
def fake(args, cwd=''):
    params = json.loads(args[args.index('--params') + 1])
    assert params['fileId'] == metadata['id']
    if '--output' in args:
        assert params['alt'] == 'media'
        target = args[args.index('--output') + 1]
        paths.append(target)
        assert cwd == os.path.dirname(target)
        with open(target, 'wb') as stream:
            stream.write(bytes([0, 255, 1]))
        return {'stdout':'', 'stderr':'', 'code':0}
    return {'stdout':json.dumps(metadata), 'stderr':'', 'code':0}
m['_run_gws'].__globals__['_broker_run'] = fake
result = m['google_drive_get_content']('https://drive.google.com/file/d/shared_fixture_123456/view')
assert base64.b64decode(result['content_base64']) == bytes([0, 255, 1])
assert result['id'] == metadata['id']
assert len(paths) == 1 and not os.path.exists(paths[0])
for change in ({'size':'10485761'}, {'trashed':True}, {'capabilities':None}, {'mimeType':'application/vnd.google-apps.document'}):
    original = metadata.copy()
    metadata.update(change)
    try:
        m['google_drive_get_content']('shared_fixture_123456')
        raise AssertionError('unsafe download accepted')
    except ValueError:
        pass
    metadata.clear(); metadata.update(original)
assert len(paths) == 1
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Google CLI failures never expose raw diagnostic credentials or response bodies', () => {
  const result = spawnSync('python3', ['-c', `
import runpy
m = runpy.run_path(${JSON.stringify(server)})
diagnostic = b'{"access_token":"fixture-private-token", "body":"fixture-private-message", "error":"invalid_grant"}'
m['_run_gws'].__globals__['_broker_run'] = lambda args, cwd='': {'stdout':'', 'stderr':diagnostic.decode(), 'code':1}
try:
    m['google_gmail_labels']()
    raise AssertionError('failure swallowed')
except RuntimeError as error:
    assert 'fixture-private' not in str(error)
    assert 'reconnect' in str(error).lower()
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('shared Google links reach bounded file operations and lookalike URLs are rejected', () => {
  const result = spawnSync('python3', ['-c', `
import runpy
m = runpy.run_path(${JSON.stringify(server)})
calls = []
def fake(op, **kwargs):
    calls.append((op, kwargs))
    return {"ok": True}
for name in ('google_sheets_update', 'google_docs_append', 'google_slides_replace_text', 'google_drive_get'):
    m[name].__globals__['_gws'] = fake
file_id = 'shared_fixture_123456'
m['google_sheets_update']('https://docs.google.com/spreadsheets/d/' + file_id + '/edit?gid=12#gid=12', 'Sheet1!A1', [['changed']])
assert calls[-1][1]['params']['spreadsheetId'] == file_id
assert calls[-1][0] == ('sheets', 'spreadsheets', 'values', 'update')
m['google_docs_append']('https://docs.google.com/document/d/' + file_id + '/edit?tab=t.0', 'Added text')
assert calls[-1][1]['params']['documentId'] == file_id
m['google_slides_replace_text']('https://docs.google.com/presentation/d/' + file_id + '/edit', 'before', 'after')
assert calls[-1][1]['params']['presentationId'] == file_id
m['google_drive_get']('https://drive.google.com/open?id=' + file_id)
assert calls[-1][1]['params']['fileId'] == file_id
before = len(calls)
for url in (
    'http://docs.google.com/spreadsheets/d/' + file_id,
    'https://docs.google.com.evil.example/spreadsheets/d/' + file_id,
    'https://evil.example@docs.google.com/spreadsheets/d/' + file_id,
    'https://docs.google.com:443/spreadsheets/d/' + file_id,
    'https://docs.google.com/document/d/' + file_id,
    'https://docs.google.com/spreadsheets/d/' + file_id + '/../../other',
):
    try:
        m['google_sheets_update'](url, 'Sheet1!A1', [['changed']])
        raise AssertionError('invalid link accepted')
    except ValueError:
        pass
assert len(calls) == before
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Workspace tools send only bounded commands through the local broker', () => {
  const result = spawnSync('python3', ['-c', `
import runpy
m = runpy.run_path(${JSON.stringify(server)})
captured = []
def fake(args, cwd=''):
    captured.append((args,cwd))
    return {'stdout':'{}', 'stderr':'', 'code':0}
m['_run_gws'].__globals__['_broker_run'] = fake
m['google_gmail_labels']()
assert captured == [(['gmail','users','labels','list','--params','{"userId":"me"}'],'')]
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('bundled Workspace server exposes only the curated non-destructive tools used by Mia and Bots', () => {
  const result = spawnSync('python3', [server, '--describe'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.deepEqual(description.services, ['Gmail', 'Calendar', 'Drive', 'Sheets', 'Docs', 'Slides']);
  for (const name of [
    'google_gmail_list', 'google_gmail_get', 'google_gmail_send',
    'google_gmail_modify', 'google_gmail_labels', 'google_gmail_create_draft',
    'google_calendar_list', 'google_calendar_get', 'google_calendar_create',
    'google_drive_list', 'google_drive_get', 'google_drive_create', 'google_drive_update_metadata',
    'google_drive_create_file', 'google_drive_update_content', 'google_drive_get_content',
    'google_sheets_get', 'google_sheets_create', 'google_sheets_update', 'google_sheets_append',
    'google_docs_get', 'google_docs_create', 'google_docs_append', 'google_docs_replace',
    'google_slides_get', 'google_slides_create', 'google_slides_add_text_slide', 'google_slides_replace_text',
  ]) assert.ok(description.tools.includes(name), `${name} is missing`);
  assert.deepEqual(description.tools.filter((name) => /delete|trash|clear/i.test(name)), []);
});

test('Drive media create/update preserves file identity and rejects native, trashed, read-only and empty payloads', () => {
  const result = spawnSync('python3', ['-c', `
import runpy, base64
m = runpy.run_path(${JSON.stringify(server)})
calls = []
metadata = {'id': 'shared_fixture_123456', 'mimeType': 'text/plain', 'trashed': False, 'capabilities': {'canEdit': True}}
def fake(op, **kwargs):
    calls.append((op, kwargs))
    return metadata.copy()
update = m['google_drive_update_content']
update.__globals__['_gws'] = fake
payload = base64.b64encode(b'updated contents').decode()
update('shared_fixture_123456', payload)
assert calls[-1] == (('drive', 'files', 'update'), {'params': {'fileId': 'shared_fixture_123456', 'supportsAllDrives': True, 'fields': 'id,name,mimeType,webViewLink'}, 'body': {}, 'media': b'updated contents', 'media_type': 'text/plain'})
for changed in ({'mimeType': 'application/vnd.google-apps.document'}, {'mimeType': 'application/vnd.google-apps.shortcut'}, {'trashed': True}, {'capabilities': {'canEdit': False}}, {'id': 'different_fixture_123456'}):
    original = metadata.copy()
    metadata.update(changed)
    before = len(calls)
    try:
        update('shared_fixture_123456', payload)
        raise AssertionError('unsafe update accepted')
    except ValueError:
        pass
    assert len(calls) == before + 1
    metadata.clear()
    metadata.update(original)
for invalid in ('', 'not base64', '/etc/passwd', 'a' * 14_000_001):
    before = len(calls)
    try:
        update('shared_fixture_123456', invalid)
        raise AssertionError('invalid bytes accepted')
    except ValueError:
        pass
    assert len(calls) == before
m['google_drive_create_file']('Fixture.txt', payload, 'text/plain')
assert calls[-1][0] == ('drive', 'files', 'create')
assert calls[-1][1]['body'] == {'name': 'Fixture.txt', 'mimeType': 'text/plain'}
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Drive upload subprocess receives private temporary bytes and cleans up after success or failure', () => {
  const result = spawnSync('python3', ['-c', `
import runpy, os, stat
m = runpy.run_path(${JSON.stringify(server)})
paths = []
fail = False
def fake(args, cwd=''):
    path = args[args.index('--upload') + 1]
    paths.append(path)
    with open(path, 'rb') as stream:
        assert stream.read() == b'fixture'
    assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
    # The pinned CLI rejects uploads outside its working directory.
    assert cwd == os.path.dirname(path)
    assert args[args.index('--upload-content-type') + 1] == 'text/plain'
    if fail:
        raise RuntimeError('fixture failure')
    return {'stdout':'{}', 'stderr':'', 'code':0}
m['_run_gws'].__globals__['_broker_run'] = fake
m['_gws'](('drive', 'files', 'create'), media=b'fixture', media_type='text/plain')
fail = True
try:
    m['_gws'](('drive', 'files', 'update'), media=b'fixture', media_type='text/plain')
    raise AssertionError('failure lost')
except RuntimeError:
    pass
assert len(paths) == 2
assert all(not os.path.exists(os.path.dirname(path)) for path in paths)
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Drive metadata update has no deletion, movement, sharing, or arbitrary-body escape', () => {
  const result = spawnSync('python3', ['-c', `
import runpy
m = runpy.run_path(${JSON.stringify(server)})
calls = []
def fake(op, **kwargs):
    calls.append((op, kwargs))
    return {"id": "fixture"}
update = m['google_drive_update_metadata']
update.__globals__['_gws'] = fake
update('https://drive.google.com/file/d/shared_fixture_123456/view', name='New name', description='New description')
assert calls == [(('drive', 'files', 'update'), {'params': {'fileId': 'shared_fixture_123456', 'supportsAllDrives': True, 'fields': 'id,name,description,mimeType,webViewLink'}, 'body': {'name': 'New name', 'description': 'New description'}})]
for kwargs in ({}, {'trashed': True}, {'body': {'trashed': True}}, {'addParents': 'other_folder_12345'}, {'permissions': []}, {'name': {'trashed': True}}, {'description': 'x' * 8001}):
    before = len(calls)
    try:
        update('shared_fixture_123456', **kwargs)
        raise AssertionError('invalid update accepted')
    except (ValueError, TypeError):
        pass
    assert len(calls) == before
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('Gmail triage changes labels and saves drafts without permitting trash or sending drafts', () => {
  const result = spawnSync('python3', ['-c', `
import runpy, base64
from email import message_from_bytes
m = runpy.run_path(${JSON.stringify(server)})
calls = []
def fake(op, **kwargs):
    calls.append((op, kwargs))
    return {"id": "fixture"}
for name in ('google_gmail_modify', 'google_gmail_labels', 'google_gmail_create_draft'):
    m[name].__globals__['_gws'] = fake
modify = m['google_gmail_modify']
modify('1234567890abcdef', [], ['UNREAD'])
assert calls[-1][1]['body'] == {'addLabelIds': [], 'removeLabelIds': ['UNREAD']}
modify('1234567890abcdef', ['Label_12'], ['INBOX'])
assert calls[-1][0] == ('gmail', 'users', 'messages', 'modify')
for labels in (['TRASH'], ['SPAM'], ['SENT'], ['DRAFT'], ['Label_../TRASH'], 'UNREAD', [1]):
    before = len(calls)
    try:
        modify('1234567890abcdef', labels, [])
        raise AssertionError('invalid label accepted')
    except ValueError:
        pass
    assert len(calls) == before
for added, removed in (([], []), (['UNREAD'], ['UNREAD'])):
    try:
        modify('1234567890abcdef', added, removed)
        raise AssertionError('invalid change accepted')
    except ValueError:
        pass
m['google_gmail_create_draft']('test@example.com', 'Subject', 'Body')
assert calls[-1][0] == ('gmail', 'users', 'drafts', 'create')
raw = calls[-1][1]['body']['message']['raw']
email = message_from_bytes(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
assert email['To'] == 'test@example.com'
assert email['Subject'] == 'Subject'
assert email.get_payload().strip() == 'Body'
assert all(op != ('gmail', 'users', 'messages', 'send') for op, _ in calls)
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
