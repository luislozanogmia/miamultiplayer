import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const start = source.indexOf('  var CHAT_ATTACHMENT_TYPES = ');
const end = source.indexOf('  function clearChatAttachmentError(){', start);
const make = team => new Function('inHubRoom', source.slice(start, end) + 'return {problem: chatAttachmentProblem, type: chatAttachmentType};')(() => team);

test('CSV, Office and text files attach in Solo and in a company, typed by their name', () => {
  for (const team of [false, true]) {
    const { problem, type } = make(team);
    for (const name of ['leads.csv', 'notes.md', 'plan.docx', 'sheet.xlsx', 'deck.pptx', 'readme.txt', 'data.json', 'scan.pdf', 'logo.png']) {
      assert.equal(problem({ name, type: '', size: 1000 }), '', `${name} in ${team ? 'a company' : 'Solo'}`);
    }
    assert.equal(type({ name: 'Leads.CSV', type: 'application/vnd.ms-excel' }), 'text/csv', 'the name decides, as both stores check it');
    assert.match(problem({ name: 'run.exe', type: 'application/octet-stream', size: 10 }), /Choose an image, a PDF/);
  }
  assert.match(make(true).problem({ name: 'page.html', type: 'text/html', size: 10 }), /Web pages can.t be sent to a company/);
  assert.equal(make(false).problem({ name: 'page.html', type: 'text/html', size: 10 }), '');
  assert.match(html, /id="ccFileInput"[^>]*accept="[^"]*\.csv[^"]*\.md[^"]*"/);
});
