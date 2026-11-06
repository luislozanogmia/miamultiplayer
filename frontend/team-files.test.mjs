import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const tf = require('./team-files.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const TEAM = 'a'.repeat(32), SPACE = 'b'.repeat(32), FILE = 'c'.repeat(32);
const HOST = `test-storage-${TEAM}.s3.us-east-1.amazonaws.com`;
const ORIGIN = `https://${HOST}`;
const link = (file = FILE, space = SPACE) => `https://${HOST}/spaces/${space}/${file}?X-Amz-Signature=abc&X-Amz-Expires=300`;

test('part maths follows the Hub: 8,000,000-byte parts, a shorter last part, a 500,000,000-byte ceiling', () => {
  assert.equal(tf.partCount(1), 1);
  assert.equal(tf.partCount(8000000), 1);
  assert.equal(tf.partCount(8000001), 2);
  assert.equal(tf.partCount(500000000), 63);
  assert.equal(tf.partSize(8000001, 1), 8000000);
  assert.equal(tf.partSize(8000001, 2), 1);
  assert.equal(tf.partSize(500000000, 63), 500000000 - 62 * 8000000);
  const ranges = tf.partRanges(17000001);
  assert.deepEqual(ranges.map(r => [r.number, r.start, r.end, r.sizeBytes]),
    [[1, 0, 8000000, 8000000], [2, 8000000, 16000000, 8000000], [3, 16000000, 17000001, 1000001]]);
  assert.equal(ranges.reduce((sum, r) => sum + r.sizeBytes, 0), 17000001);
  assert.throws(() => tf.partCount(500000001), { code: 'file_too_large' });
  assert.throws(() => tf.partCount(0), { code: 'empty_file' });
  assert.throws(() => tf.partCount(1.5), { code: 'empty_file' });
  assert.throws(() => tf.partSize(100, 2), { code: 'invalid_parts' });
  assert.throws(() => tf.partSize(100, 0), { code: 'invalid_parts' });
  // At most 16 signed links are requested at a time.
  const groups = tf.batches(tf.partRanges(500000000), tf.PARTS_PER_REQUEST);
  assert.deepEqual(groups.map(g => g.length), [16, 16, 16, 15]);
});

test('the incremental SHA-256 matches Node for every padding edge and for split updates', () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100003]) {
    const bytes = randomBytes(length);
    assert.equal(new tf.Sha256().update(bytes).digestHex(), sha(bytes), `length ${length}`);
    const split = new tf.Sha256();
    for (let i = 0; i < length; i += 37) split.update(bytes.subarray(i, i + 37));
    assert.equal(split.digestHex(), sha(bytes), `split ${length}`);
  }
  assert.equal(new tf.Sha256().update(new TextEncoder().encode('abc')).digestHex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hashing a file gives the whole-file hash and one hash per part, reading part by part', async () => {
  const bytes = randomBytes(17000001);
  const file = new File([bytes], 'big.bin');
  const seen = [];
  const result = await tf.hashFile(file, { onProgress: done => seen.push(done) });
  assert.equal(result.sha256, sha(bytes));
  assert.deepEqual(result.parts.map(p => [p.number, p.sizeBytes]), [[1, 8000000], [2, 8000000], [3, 1000001]]);
  assert.deepEqual(result.parts.map(p => p.sha256), [sha(bytes.subarray(0, 8000000)), sha(bytes.subarray(8000000, 16000000)), sha(bytes.subarray(16000000))]);
  assert.deepEqual(seen, [8000000, 16000000, 17000001]);
  // Without WebCrypto the same answer comes from the built-in hash.
  const slow = await tf.hashFile(new File([bytes.subarray(0, 100)], 'x'), { subtle: null });
  assert.equal(slow.sha256, sha(bytes.subarray(0, 100)));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tf.hashFile(file, { signal: controller.signal }), { code: 'aborted' });
});

test('checksum header is the part hash in base64', () => {
  const bytes = randomBytes(10);
  assert.equal(tf.checksumBase64(sha(bytes)), createHash('sha256').update(bytes).digest('base64'));
});

test('signed links must match the Hub-provided storage origin and this file key', () => {
  const expected = { teamId: TEAM, spaceId: SPACE, fileId: FILE, storageOrigin: ORIGIN };
  assert.equal(tf.validateS3Url(link(), expected), link());
  const bad = [
    link().replace('https:', 'http:'),
    `https://evil.example/spaces/${SPACE}/${FILE}`,
    `https://${HOST}.evil.example/spaces/${SPACE}/${FILE}`,
    `https://evil-${HOST}/spaces/${SPACE}/${FILE}`,
    `https://test-storage-${'f'.repeat(32)}.s3.us-east-1.amazonaws.com/spaces/${SPACE}/${FILE}`,
    `https://${HOST.replace('us-east-1', 'eu-west-1')}/spaces/${SPACE}/${FILE}`,
    `https://s3.us-east-1.amazonaws.com/test-storage-${TEAM}/spaces/${SPACE}/${FILE}`,
    `https://other-bucket.s3.us-east-1.amazonaws.com/spaces/${SPACE}/${FILE}`,
    `https://user:pw@${HOST}/spaces/${SPACE}/${FILE}`,
    `https://${HOST}:8443/spaces/${SPACE}/${FILE}`,
    `https://${HOST}@evil.example/spaces/${SPACE}/${FILE}`,
    link('d'.repeat(32)), link(FILE, 'd'.repeat(32)),
    `https://${HOST}/spaces/${SPACE}/${FILE}/extra`,
    `https://${HOST}/other/${SPACE}/${FILE}`,
    `https://${HOST}/spaces/${SPACE}/${FILE}#frag`,
    'javascript:alert(1)', 'data:text/plain,hi', '', 'not a url', null,
    'https://' + HOST + '/spaces/' + SPACE + '/' + FILE + '?' + 'x'.repeat(5000),
  ];
  for (const url of bad) assert.throws(() => tf.validateS3Url(url, expected), { code: 'unsafe_url' }, String(url).slice(0, 80));
  assert.throws(() => tf.validateS3Url(link(), { teamId: 'nope', spaceId: SPACE, fileId: FILE }), { code: 'unsafe_url' });
  assert.throws(() => tf.validateS3Url(link(), { teamId: TEAM, spaceId: SPACE }), { code: 'unsafe_url' });
  assert.throws(() => tf.validateS3Url(link(), { ...expected, storageOrigin: 'https://other-bucket.s3.us-east-1.amazonaws.com' }), { code: 'unsafe_url' });
  assert.throws(() => tf.validateS3Url(link(), { ...expected, storageOrigin: 'https://user:pass@' + HOST }), { code: 'unsafe_url' });
});

test('upload headers: the checksum must be ours, forbidden headers are dropped, unknown ones refused', () => {
  const hex = sha(Buffer.from('part'));
  const checksum = tf.checksumBase64(hex);
  assert.deepEqual(tf.partHeaders({ 'x-amz-checksum-sha256': checksum }, hex), { 'x-amz-checksum-sha256': checksum });
  // Content-Length is set by the browser from the body and must never be set by a script.
  assert.deepEqual(tf.partHeaders({ 'Content-Length': '8000000', 'X-Amz-Checksum-Sha256': checksum, Host: 'x', Origin: 'y' }, hex), { 'x-amz-checksum-sha256': checksum });
  assert.throws(() => tf.partHeaders({ 'x-amz-checksum-sha256': tf.checksumBase64(sha(Buffer.from('other'))) }, hex), { code: 'unsafe_headers' });
  assert.throws(() => tf.partHeaders({}, hex), { code: 'unsafe_headers' });
  assert.throws(() => tf.partHeaders({ 'x-amz-checksum-sha256': checksum, authorization: 'Bearer x' }, hex), { code: 'unsafe_headers' });
  assert.throws(() => tf.partHeaders({ 'x-amz-checksum-sha256': checksum, 'x-amz-meta-a': 'bad\nvalue' }, hex), { code: 'unsafe_headers' });
  assert.throws(() => tf.partHeaders(null, hex), { code: 'unsafe_headers' });
});

test('upload state machine allows only the documented steps', () => {
  const path = [['queued', 'START', 'hashing'], ['hashing', 'HASHED', 'reserving'], ['reserving', 'RESERVED', 'uploading'],
    ['uploading', 'PARTS_DONE', 'completing'], ['completing', 'COMPLETED', 'scanning'], ['scanning', 'SCAN_CLEAN', 'clean'], ['scanning', 'SCAN_BLOCKED', 'quarantined']];
  for (const [from, event, to] of path) assert.equal(tf.transition(from, event), to);
  assert.equal(tf.transition('uploading', 'FAIL'), 'failed');
  assert.equal(tf.transition('failed', 'RETRY_UPLOAD'), 'uploading');
  assert.equal(tf.transition('failed', 'RETRY_COMPLETE'), 'completing');
  assert.equal(tf.transition('failed', 'RETRY_HASH'), 'hashing');
  assert.equal(tf.transition('uploading', 'INTERRUPT'), 'interrupted');
  assert.equal(tf.transition('interrupted', 'RESUME'), 'hashing');
  assert.equal(tf.transition('failed', 'EXPIRE'), 'expired');
  // Nothing skips the scan, and finished states stay finished.
  assert.throws(() => tf.transition('completing', 'SCAN_CLEAN'), { code: 'bad_transition' });
  assert.throws(() => tf.transition('uploading', 'SCAN_CLEAN'), { code: 'bad_transition' });
  assert.throws(() => tf.transition('quarantined', 'SCAN_CLEAN'), { code: 'bad_transition' });
  assert.throws(() => tf.transition('clean', 'RETRY_UPLOAD'), { code: 'bad_transition' });
  assert.throws(() => tf.transition('scanning', 'CANCEL'), { code: 'bad_transition' });
  assert.throws(() => tf.transition('cancelled', 'START'), { code: 'bad_transition' });
});

test('scan results: only NO_THREATS_FOUND opens a file; every other final answer blocks it', () => {
  assert.equal(tf.scanVerdict({ fileId: FILE, scanStatus: 'NO_THREATS_FOUND', ready: true }), 'clean');
  assert.equal(tf.scanVerdict({ state: 'ready', scanStatus: 'NO_THREATS_FOUND' }), 'clean');
  assert.equal(tf.scanVerdict({ scanStatus: 'PENDING', ready: false }), 'pending');
  assert.equal(tf.scanVerdict({ state: 'pending_scan', scanStatus: 'PENDING' }), 'pending');
  for (const status of ['THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED']) assert.equal(tf.scanVerdict({ scanStatus: status, ready: false }), 'blocked');
  assert.equal(tf.scanVerdict({ state: 'quarantined', scanStatus: 'THREATS_FOUND' }), 'blocked');
  assert.equal(tf.scanVerdict(null), 'pending');
  assert.equal(tf.scanVerdict({}), 'pending');
});

test('the Hub errors people will hit are put in plain language', () => {
  for (const code of ['file_too_large', 'file_quota_exceeded', 'team_files_not_configured', 'file_uploads_disabled']) {
    const message = tf.errorMessage(code);
    assert.match(message, /^[A-Z].*[.]$/, code);
    assert.doesNotMatch(message, new RegExp(code), code);
  }
  assert.match(tf.errorMessage('file_too_large'), /500 MB/);
  assert.match(tf.errorMessage('file_quota_exceeded'), /storage/);
  assert.match(tf.errorMessage('team_files_not_configured'), /not set up/);
  assert.match(tf.errorMessage('file_uploads_disabled'), /turned off/);
  assert.match(tf.errorMessage('file_not_ready'), /scanned/);
  assert.match(tf.errorMessage('download_allowance_exceeded'), /download allowance/);
  assert.match(tf.errorMessage('', 401), /Sign in/);
  assert.match(tf.errorMessage('', 404), /no longer available/);
  assert.match(tf.errorMessage('', 503), /Can’t reach/);
  assert.match(tf.errorMessage('something_new'), /\(something_new\)/);
  // A chat-image error carries its own 8 MB wording; the file wording wins.
  const chatError = Object.assign(new Error('Files must be 8 MB or smaller.'), { code: 'file_too_large', status: 413 });
  assert.match(tf.friendly(chatError), /500 MB/);
  assert.match(tf.deleteErrorMessage(Object.assign(new Error('x'), { code: 'not_found', status: 404 })), /added this file or a company admin/);
  assert.equal(tf.formatBytes(0), '0 B');
  assert.equal(tf.formatBytes(1500000), '1.5 MB');
  assert.equal(tf.formatBytes(100000000000), '100 GB');
});

test('file names and types are shaped to what the Hub accepts', () => {
  assert.equal(tf.safeFilename('a/b\\c\u0001.txt'), 'a_b_c_.txt');
  assert.equal(tf.safeFilename('   '), 'file');
  const long = tf.safeFilename('x'.repeat(300) + '.pdf');
  assert.equal(long.length, 255);
  assert.ok(long.endsWith('.pdf'));
  assert.equal(tf.contentTypeOf('Text/Plain; charset=utf-8'), 'text/plain');
  assert.equal(tf.contentTypeOf(''), 'application/octet-stream');
  assert.equal(tf.contentTypeOf('bad type'), 'application/octet-stream');
});

test('the client only builds the documented routes and rejects bad ids and cursors', async () => {
  const calls = [];
  const client = tf.createClient({ teamId: TEAM, call: async (method, path, body) => {
    calls.push([method, path, body]);
    if (path.endsWith('/usage')) return { usedBytes: 5, quotaBytes: 100000000000 };
    if (path.includes('/file-spaces/')) return { files: [{ fileId: FILE, filename: 'a.txt', contentType: 'text/plain', sizeBytes: 3, sha256: 'e'.repeat(64), createdAt: 1760000000 }, { fileId: 'bad' }], nextCursor: `1760000000/${FILE}` };
    return {};
  } });
  assert.deepEqual(await client.usage(), { usedBytes: 5, quotaBytes: 100000000000 });
  const page = await client.list('channel', SPACE, null);
  assert.equal(page.files.length, 1, 'rows without a valid id or hash are dropped');
  assert.equal(page.nextCursor, `1760000000/${FILE}`);
  await client.list('dm', SPACE, page.nextCursor);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [
    ['GET', `/v1/teams/${TEAM}/files/usage`],
    ['GET', `/v1/teams/${TEAM}/file-spaces/channel/${SPACE}/files`],
    ['GET', `/v1/teams/${TEAM}/file-spaces/dm/${SPACE}/files/before/1760000000/${FILE}`]]);
  assert.throws(() => client.list('automation', SPACE), { code: 'not_found' });
  assert.throws(() => client.list('channel', 'x'), { code: 'not_found' });
  assert.throws(() => client.list('channel', SPACE, '../../x'), { code: 'invalid_cursor' });
  assert.throws(() => client.status('../x'), { code: 'not_found' });
  assert.throws(() => tf.createClient({ teamId: 'x', call() {} }), { code: 'not_found' });
});

// ---- A fake Hub and a fake S3 for the upload and download flows ----------------------
function fakeWorld({ size = 17000001, partBehaviour = () => 200, uploadsDisabled = false } = {}) {
  const bytes = randomBytes(size);
  const file = new File([bytes], 'report.pdf', { type: 'application/pdf' });
  const world = { bytes, file, puts: [], hub: [], removed: [], etagFor: n => `"etag-${n}"`, scan: 'PENDING' };
  const store = new Map();
  world.store = { records: () => [...store.values()], save: (_t, r) => store.set(r.fileId, JSON.parse(JSON.stringify(r))), drop: (_t, id) => store.delete(id), isMine: () => true, map: store };
  world.client = {
    teamId: TEAM,
    reserve: async body => {
      world.hub.push(['reserve', body]);
      if (uploadsDisabled) throw Object.assign(new Error('x'), { code: 'file_uploads_disabled', status: 503 });
      return { fileId: FILE, partBytes: 8000000, partCount: Math.ceil(body.sizeBytes / 8000000), expiresAt: 4102444800 };
    },
    signParts: async (id, parts) => {
      world.hub.push(['parts', parts.map(p => p.number)]);
      return parts.map(p => ({ number: p.number, url: link(), storageOrigin: ORIGIN, sizeBytes: p.sizeBytes,
        headers: { 'content-length': String(p.sizeBytes), 'x-amz-checksum-sha256': tf.checksumBase64(p.sha256) } }));
    },
    complete: async (id, parts) => { world.hub.push(['complete', parts]); return { fileId: id, scanStatus: 'PENDING' }; },
    status: async () => ({ fileId: FILE, scanStatus: world.scan, ready: world.scan === 'NO_THREATS_FOUND' }),
    remove: async id => { world.removed.push(id); return {}; },
  };
  world.fetch = async (url, init) => {
    const body = new Uint8Array(await init.body.arrayBuffer());
    const record = { url, headers: init.headers, size: body.length, checksum: init.headers['x-amz-checksum-sha256'], matches: createHash('sha256').update(body).digest('base64') === init.headers['x-amz-checksum-sha256'] };
    world.puts.push(record);
    const status = partBehaviour(world.puts.length, record);
    return { ok: status >= 200 && status < 300, status, headers: { get: name => (name === 'etag' && status < 300 ? world.etagFor(world.puts.length) : null) } };
  };
  return world;
}
const wait = async condition => { for (let i = 0; i < 400 && !condition(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(condition(), 'timed out waiting'); };
const manager = (world, extra = {}) => tf.createManager({ client: world.client, store: world.store, teamId: TEAM, space: { kind: 'channel', id: SPACE },
  fetch: world.fetch, sleep: async () => {}, now: () => 1760000000000, onChange: () => {}, ...extra });

test('an upload hashes, reserves, sends every part to S3 with its checksum, completes, then shows scanning', async () => {
  const world = fakeWorld();
  const m = manager(world);
  assert.deepEqual(m.add([world.file]), []);
  await wait(() => m.jobs()[0].state === 'scanning');
  const reserve = world.hub.find(h => h[0] === 'reserve')[1];
  assert.deepEqual(Object.keys(reserve).sort(), ['contentType', 'filename', 'sha256', 'sizeBytes', 'spaceId', 'spaceKind']);
  assert.equal(reserve.sha256, sha(world.bytes));
  assert.equal(reserve.sizeBytes, 17000001);
  assert.equal(reserve.contentType, 'application/pdf');
  assert.equal(world.puts.length, 3);
  assert.ok(world.puts.every(p => p.matches && p.url === link()), 'each part carries its own checksum header');
  assert.ok(world.puts.every(p => !('content-length' in p.headers)), 'Content-Length is never set by script');
  const completion = world.hub.find(h => h[0] === 'complete')[1];
  assert.deepEqual(completion.map(p => p.number), [1, 2, 3]);
  assert.ok(completion.every(p => /^"etag-/.test(p.etag) && /^[a-f0-9]{64}$/.test(p.sha256)));
  assert.equal(world.store.map.get(FILE).state, 'scanning', 'a scanning file is remembered');
  // The file is not offered until the scan says clean.
  assert.equal(await m.checkScans(), false);
  assert.equal(m.jobs()[0].state, 'scanning');
  world.scan = 'NO_THREATS_FOUND';
  assert.equal(await m.checkScans(), true);
  assert.equal(m.jobs()[0].state, 'clean');
  assert.equal(world.store.map.has(FILE), false);
});

test('a scan that finds something leaves the file quarantined and still remembered', async () => {
  const world = fakeWorld({ size: 1000 });
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'scanning');
  world.scan = 'THREATS_FOUND';
  await m.checkScans();
  assert.equal(m.jobs()[0].state, 'quarantined');
  assert.equal(world.store.map.get(FILE).state, 'quarantined');
  m.forget(m.jobs()[0].id);
  assert.equal(m.jobs().length, 0);
  assert.equal(world.store.map.has(FILE), false);
});

test('a part that fails is retried by itself, then the whole upload offers a retry that skips finished parts', async () => {
  // Part 2 fails every time (its whole retry budget) until the connection is back.
  let broken = true, part2 = null;
  const world = fakeWorld({ partBehaviour: (call, record) => (broken && record.checksum === part2 ? 503 : 200) });
  part2 = tf.checksumBase64(sha(world.bytes.subarray(8000000, 16000000)));
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'failed');
  const job = m.jobs()[0];
  assert.equal(job.error.code, 'part_failed');
  assert.equal(world.puts.filter(p => p.checksum === part2).length, 3, 'a failing part is tried three times');
  assert.match(job.error.message, /retry/);
  assert.equal(world.hub.some(h => h[0] === 'complete'), false);
  assert.equal(world.store.map.get(FILE).state, 'uploading', 'progress survives for a later retry');
  const sentBefore = world.puts.length;
  broken = false;
  m.retry(job.id);
  await wait(() => m.jobs()[0].state === 'scanning');
  const finished = Object.keys(world.store.map.get(FILE).parts);
  assert.deepEqual(finished.sort(), ['1', '2', '3']);
  const retried = world.puts.slice(sentBefore);
  assert.equal(retried.length, 1, 'parts already stored are not sent again');
  assert.equal(world.hub.filter(h => h[0] === 'reserve').length, 1, 'retry keeps the same reservation');
});

test('a part the storage rejects as corrupt stops the upload instead of retrying', async () => {
  const world = fakeWorld({ size: 1000, partBehaviour: () => 400 });
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'failed');
  assert.equal(world.puts.length, 1);
  assert.equal(m.jobs()[0].error.code, 'part_rejected');
});

test('an expired part link is replaced once with a fresh one', async () => {
  const world = fakeWorld({ size: 1000, partBehaviour: n => (n === 1 ? 403 : 200) });
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'scanning');
  assert.equal(world.hub.filter(h => h[0] === 'parts').length, 2);
});

test('a link to someone else’s storage is never used', async () => {
  const world = fakeWorld({ size: 1000 });
  world.client.signParts = async (id, parts) => parts.map(p => ({ number: p.number, url: 'https://evil.example/x', headers: { 'x-amz-checksum-sha256': tf.checksumBase64(p.sha256) } }));
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'failed');
  assert.equal(world.puts.length, 0);
  assert.equal(m.jobs()[0].error.code, 'unsafe_url');
});

test('a bucket that hides the ETag gives a clear storage message', async () => {
  const world = fakeWorld({ size: 1000 });
  world.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null } });
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'failed');
  assert.equal(m.jobs()[0].error.code, 'storage_unreadable');
});

test('too large, empty, quota and disabled uploads are explained, and nothing is sent', async () => {
  const world = fakeWorld({ size: 1000, uploadsDisabled: true });
  const m = manager(world);
  const rejected = m.add([{ name: 'huge.bin', size: 500000001 }, { name: 'empty.txt', size: 0 }]);
  assert.deepEqual(rejected.map(r => r.code), ['file_too_large', 'empty_file']);
  assert.match(rejected[0].message, /500 MB/);
  assert.equal(m.jobs().length, 0);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'failed');
  assert.match(m.jobs()[0].error.message, /turned off/);
  assert.equal(world.puts.length, 0);
  for (const [code, pattern] of [['file_quota_exceeded', /storage/], ['team_files_not_configured', /not set up/]]) {
    const w = fakeWorld({ size: 1000 });
    w.client.reserve = async () => { throw Object.assign(new Error('raw'), { code, status: 409 }); };
    const mm = manager(w);
    mm.add([w.file]);
    await wait(() => mm.jobs()[0].state === 'failed');
    assert.match(mm.jobs()[0].error.message, pattern);
  }
});

test('an interrupted upload is restored, and a different file of the same size fails safe', async () => {
  const world = fakeWorld();
  const full = await tf.hashFile(world.file);
  world.store.save(TEAM, { fileId: FILE, spaceKind: 'channel', spaceId: SPACE, filename: 'report.pdf', contentType: 'application/pdf',
    sizeBytes: 17000001, sha256: full.sha256, state: 'uploading', parts: { 1: '"etag-old"' }, expiresAt: 4102444800, createdAt: 1 });
  const m = manager(world);
  m.restore();
  assert.equal(m.jobs()[0].state, 'interrupted');
  assert.equal(m.jobs()[0].doneBytes, 8000000);
  // A different file of the same size is not accepted.
  assert.equal(m.resume(m.jobs()[0].id, new File([randomBytes(17000001)], 'other.pdf')).ok, true);
  await wait(() => m.jobs()[0].state === 'failed');
  assert.equal(m.jobs()[0].error.code, 'file_changed');
  assert.equal(world.puts.length, 0);
  assert.equal(m.resume(m.jobs()[0].id, world.file).ok, false, 'a failed job is retried, not resumed');
  assert.equal(m.resume('nope', world.file).ok, false);
});

test('resuming with the matching file uploads only the missing parts and never reserves again', async () => {
  const world = fakeWorld();
  const full = await tf.hashFile(world.file);
  world.store.save(TEAM, { fileId: FILE, spaceKind: 'channel', spaceId: SPACE, filename: 'report.pdf', contentType: 'application/pdf',
    sizeBytes: 17000001, sha256: full.sha256, state: 'uploading', parts: { 1: '"etag-old"' }, expiresAt: 4102444800, createdAt: 1 });
  const m = manager(world);
  m.restore();
  assert.equal(m.resume(m.jobs()[0].id, world.file).ok, true);
  await wait(() => m.jobs()[0].state === 'scanning');
  assert.equal(world.puts.length, 2);
  assert.equal(world.hub.some(h => h[0] === 'reserve'), false);
  const completion = world.hub.find(h => h[0] === 'complete')[1];
  assert.equal(completion[0].etag, '"etag-old"');
  assert.deepEqual(world.hub.find(h => h[0] === 'parts')[1], [2, 3]);
});

test('restored records: expired reservations are dropped, scanning and blocked files come back, other chats are ignored', () => {
  const world = fakeWorld({ size: 1000 });
  const base = { spaceKind: 'channel', spaceId: SPACE, filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5, sha256: 'e'.repeat(64), parts: {}, createdAt: 1 };
  world.store.save(TEAM, { ...base, fileId: '1'.repeat(32), state: 'uploading', expiresAt: 100 });
  world.store.save(TEAM, { ...base, fileId: '2'.repeat(32), state: 'scanning', expiresAt: 100 });
  world.store.save(TEAM, { ...base, fileId: '3'.repeat(32), state: 'quarantined', expiresAt: 100 });
  world.store.save(TEAM, { ...base, fileId: '4'.repeat(32), state: 'scanning', expiresAt: 100, spaceId: 'f'.repeat(32) });
  const m = manager(world);
  m.restore();
  const states = Object.fromEntries(m.jobs().map(j => [j.record.fileId[0], j.state]));
  assert.deepEqual(states, { 1: 'expired', 2: 'scanning', 3: 'quarantined' });
  assert.equal(world.store.map.has('1'.repeat(32)), false);
});

test('cancelling releases the reservation', async () => {
  const world = fakeWorld({ size: 1000 });
  world.fetch = () => new Promise(() => {});
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].record && m.jobs()[0].state === 'uploading');
  m.cancel(m.jobs()[0].id);
  assert.equal(m.jobs()[0].state, 'cancelled');
  assert.deepEqual(world.removed, [FILE]);
  assert.equal(world.store.map.has(FILE), false);
});

test('cancelling while the Hub is still reserving releases the space once it answers', async () => {
  const world = fakeWorld({ size: 1000 });
  const reserve = world.client.reserve;
  let answer;
  world.client.reserve = body => new Promise(resolve => { answer = () => resolve(reserve(body)); });
  const m = manager(world);
  m.add([world.file]);
  await wait(() => m.jobs()[0].state === 'reserving' && answer);
  m.cancel(m.jobs()[0].id);
  assert.equal(m.jobs()[0].state, 'cancelled');
  answer();
  await wait(() => world.removed.length > 0);
  assert.deepEqual(world.removed, [FILE]);
  assert.equal(m.jobs()[0].state, 'cancelled');
  assert.equal(world.puts.length, 0);
  assert.equal(world.store.map.has(FILE), false);
});

test('the local store survives bad data and remembers who added what', () => {
  const memory = new Map();
  const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const store = tf.createStore(storage);
  assert.deepEqual(store.records(TEAM), []);
  memory.set('mia.teamFiles.v1:' + TEAM, '{not json');
  assert.deepEqual(store.records(TEAM), []);
  memory.set('mia.teamFiles.v1:' + TEAM, JSON.stringify({ records: [{ fileId: 'bad' }, null], mine: ['bad', FILE] }));
  assert.deepEqual(store.records(TEAM), []);
  assert.equal(store.isMine(TEAM, FILE), true);
  assert.equal(tf.createStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }).records(TEAM).length, 0);
  store.save(TEAM, { fileId: FILE, spaceKind: 'dm', spaceId: SPACE, filename: 'a', sizeBytes: 1, sha256: 'e'.repeat(64), state: 'scanning', parts: {} });
  store.drop(TEAM, FILE, true);
  assert.equal(store.isMine(TEAM, FILE), true);
  store.drop(TEAM, FILE);
  assert.equal(store.isMine(TEAM, FILE), false);
});

// ---- Downloading ----------------------------------------------------------------------------
function streamOf(bytes, chunk = 5) {
  let at = 0;
  return { getReader: () => ({ read: async () => (at >= bytes.length ? { done: true } : { done: false, value: new Uint8Array(bytes.subarray(at, (at += chunk))) }), cancel() {} }) };
}
test('a download checks the link, streams the bytes, and verifies the whole-file hash before handing them over', async () => {
  const bytes = randomBytes(1234);
  const file = { fileId: FILE, spaceId: SPACE, sha256: sha(bytes), sizeBytes: bytes.length };
  const fetched = [];
  const client = { teamId: TEAM, download: async () => ({ fileId: FILE, url: link(), storageOrigin: ORIGIN, sha256: sha(bytes), expiresIn: 300 }) };
  const blob = await tf.downloadFile({ client, file, fetch: async (url, init) => { fetched.push([url, init.credentials]); return { ok: true, body: streamOf(bytes) }; } });
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  assert.deepEqual(fetched, [[link(), 'omit']]);
  // Corrupt bytes are discarded.
  const tampered = Buffer.from(bytes); tampered[10] ^= 1;
  await assert.rejects(tf.downloadFile({ client, file, fetch: async () => ({ ok: true, body: streamOf(tampered) }) }), { code: 'integrity_failed' });
  // Too many bytes, too few bytes, and a hash that differs from the listed one.
  await assert.rejects(tf.downloadFile({ client, file, fetch: async () => ({ ok: true, body: streamOf(Buffer.concat([bytes, Buffer.from('x')])) }) }), { code: 'integrity_failed' });
  await assert.rejects(tf.downloadFile({ client, file, fetch: async () => ({ ok: true, body: streamOf(bytes.subarray(0, 10)) }) }), { code: 'integrity_failed' });
  await assert.rejects(tf.downloadFile({ client, file: { ...file, sha256: 'd'.repeat(64) }, fetch: async () => { throw new Error('should not fetch'); } }), { code: 'integrity_failed' });
  // A link for a different team or file is never fetched.
  const wrong = { teamId: TEAM, download: async () => ({ url: link('d'.repeat(32)), storageOrigin: ORIGIN, sha256: sha(bytes) }) };
  await assert.rejects(tf.downloadFile({ client: wrong, file, fetch: async () => { throw new Error('should not fetch'); } }), { code: 'unsafe_url' });
  await assert.rejects(tf.downloadFile({ client, file, fetch: async () => ({ ok: false, status: 403 }) }), { code: 'download_failed' });
});
