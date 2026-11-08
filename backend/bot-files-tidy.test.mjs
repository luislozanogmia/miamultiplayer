import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tidy = require('./bot-files-tidy.js');

function tree(root, files) {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
}

test('only technical files and all-technical folders move; people files, Mia folders and hidden files stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-'));
  const mia = path.join(root, 'mia');
  tree(mia, {
    'AGENTS.md': 'x', 'Report.pdf': 'x', 'ICP.md': 'x', 'page.html': 'x', 'leads.csv': 'x', 'notes.txt': 'x',
    'linkedin_invite_helper.py': 'x', 'cookies.json': 'x', 'run.log': 'x', '.hidden.py': 'x',
    'scraper/main.py': 'x', 'scraper/out.json': 'x',
    'mixed/a.py': 'x', 'mixed/Summary.pdf': 'x',
    'bots/Helper/.miaos-artifact-scope.json': '{}', 'bots/Helper/deck.pdf': 'x', 'bots/Helper/fetch.js': 'x',
    'companies/Acme/x.py': 'x', 'App bundles/a.json': 'x',
  });
  const plan = tidy.planTidy({
    miaFolder: mia, tidiedFolder: path.join(root, 'data', 'tidied'),
    bots: [{ folder: path.join(mia, 'bots', 'Helper'), workFolder: path.join(root, 'data', 'bots', 'Helper--b1') }],
  });
  const names = plan.map((move) => path.relative(mia, move.from)).sort();
  assert.deepEqual(names, ['bots/Helper/fetch.js', 'cookies.json', 'linkedin_invite_helper.py', 'run.log', 'scraper']);
  assert.equal(plan.find((move) => move.from.endsWith('fetch.js')).toFolder, path.join(root, 'data', 'bots', 'Helper--b1', 'tidied-files'));
});

test('moves never overwrite or delete, and each one is recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-'));
  const mia = path.join(root, 'mia');
  const tidied = path.join(root, 'tidied');
  tree(mia, { 'a.py': 'new', 'b.json': 'b' });
  tree(tidied, { 'a.py': 'old' });
  const result = tidy.runTidy(tidy.planTidy({ miaFolder: mia, tidiedFolder: tidied }));
  assert.equal(result.moved.length, 2);
  assert.equal(fs.readFileSync(path.join(tidied, 'a.py'), 'utf8'), 'old', 'an existing file is never replaced');
  assert.equal(fs.readFileSync(path.join(tidied, 'a (2).py'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(tidied, 'b.json'), 'utf8'), 'b');
  assert.deepEqual(fs.readdirSync(mia), []);
  assert.deepEqual(result.moved.map((m) => path.basename(m.to)).sort(), ['a (2).py', 'b.json']);
});

test('review names every nested file and moves only approved unchanged entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-review-'));
  const mia = path.join(root, 'mia');
  const tidied = path.join(root, 'tidied');
  try {
    tree(mia, {
      'my-data.json': 'mine', 'bot-output.py': 'bot',
      'scraper/main.py': 'script', 'scraper/.hidden.txt': 'hidden',
    });
    const plan = tidy.planTidy({ miaFolder: mia, tidiedFolder: tidied });
    const reviewed = tidy.reviewPlan(mia, plan);
    assert.deepEqual(reviewed.map(item => item.id).sort(), ['bot-output.py', 'my-data.json', 'scraper']);
    assert.ok(reviewed.find(item => item.id === 'scraper').contents.includes('scraper/.hidden.txt'));
    const approved = tidy.approvedMoves(mia, plan, [reviewed.find(item => item.id === 'bot-output.py')]);
    assert.equal(tidy.runTidy(approved).moved.length, 1);
    assert.equal(fs.readFileSync(path.join(mia, 'my-data.json'), 'utf8'), 'mine');
    assert.equal(fs.existsSync(path.join(mia, 'scraper', '.hidden.txt')), true);

    const stillReviewed = tidy.reviewPlan(mia, tidy.planTidy({ miaFolder: mia, tidiedFolder: tidied }));
    const own = stillReviewed.find(item => item.id === 'my-data.json');
    const staleMove = tidy.approvedMoves(mia, tidy.planTidy({ miaFolder: mia, tidiedFolder: tidied }), [own]);
    fs.writeFileSync(path.join(mia, 'my-data.json'), 'changed after review');
    assert.equal(tidy.approvedMoves(mia, tidy.planTidy({ miaFolder: mia, tidiedFolder: tidied }), [own]).length, 0);
    assert.equal(tidy.runTidy(staleMove).moved.length, 0);
    assert.equal(fs.readFileSync(path.join(mia, 'my-data.json'), 'utf8'), 'changed after review');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('state is saved and read back; a missing file reads as empty', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-')), 'state.json');
  assert.deepEqual(tidy.readState(file), {});
  tidy.writeState(file, { state: 'declined' });
  assert.equal(tidy.readState(file).state, 'declined');
});

test('a bot is told to keep only shareable files in its Mia folder', () => {
  const { botFilesRule, buildBotContext } = require('./inference.js');
  const rule = botFilesRule('/home/p/Documents/mia/bots/Helper');
  assert.match(rule, /Your Mia folder is \/home\/p\/Documents\/mia\/bots\/Helper\. Save there only finished files a person would open or share/);
  assert.match(rule, /Keep everything else in your current working folder: scripts/);
  assert.match(buildBotContext({ name: 'Helper', filesFolder: '/x/bots/Helper' }, [], '', '', '', null), /Your files:/);
  assert.doesNotMatch(buildBotContext({ name: 'Helper' }, [], '', '', '', null), /Your files:/);
});

test('Mia gets the list once, and her plan moves only listed entries she did not keep', () => {
  const items = [
    { id: 'raw-leads.json', folder: false, contents: [] },
    { id: 'old-scripts', folder: true, contents: ['old-scripts/a.py', 'old-scripts/b.py'] },
    { id: 'my-notes.json', folder: false, contents: [] },
  ];
  const brief = tidy.tidyBrief(items);
  assert.match(brief, /Do not move, rename, edit or delete anything yourself/);
  assert.match(brief, /- old-scripts\/ \(folder, 2 entries inside\)/);
  assert.doesNotMatch(tidy.tidyBrief(items, { withList: false }), /raw-leads\.json/, 'later turns get the rules, not the list');

  const reply = 'I\'ll move 2 and leave your notes.\n<MIA_TIDY_PLAN>{"schemaVersion":1,"keep":["my-notes.json","made-up.txt"]}</MIA_TIDY_PLAN>';
  const extracted = tidy.extractTidyPlan(reply, items);
  assert.equal(extracted.text, 'I\'ll move 2 and leave your notes.');
  assert.deepEqual(extracted.plan, { move: ['raw-leads.json', 'old-scripts'], keep: ['my-notes.json'] });
  assert.equal(tidy.extractTidyPlan('<MIA_TIDY_PLAN>{"keep":[]}</MIA_TIDY_PLAN>', items).error, 'invalid_plan');
  assert.equal(tidy.extractTidyPlan('All yours.<MIA_TIDY_PLAN>{"schemaVersion":1,"keep":["raw-leads.json","old-scripts","my-notes.json"]}</MIA_TIDY_PLAN>', items).error, 'nothing_to_move');
  assert.equal(tidy.stripTidyPlanBlocks('Plan below <MIA_TIDY_PLAN>{"schema'), 'Plan below', 'a cut-off block never shows');
});
