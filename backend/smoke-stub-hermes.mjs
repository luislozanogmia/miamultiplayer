#!/usr/bin/env node
'use strict';

import { appendFileSync } from 'node:fs';

// Stand-in for the `hermes` CLI (see inference.js's runInference), used only
// by smoke.sh via HERMES_BIN. Invoked as:
//   hermes chat -q "<prompt>" -Q --provider deepseek --max-turns 6
// Real hermes -Q output is the reply text plus one "session_id: ..." line
// somewhere in the output (position varies) — runInference() locates and
// strips that line by regex, wherever it lands, so this stub plants it
// mid-output on purpose to exercise that path rather than always trailing it.
//
// Reply content is picked deterministically from the prompt: the
// suggestions prompt (/api/chat/suggestions) asks for "3 short questions" in
// its literal wording, so that's what distinguishes it from a normal
// department/DM reply-job prompt (built by buildContext() in inference.js).

const args = process.argv.slice(2);
const qIndex = args.indexOf('-q');
const prompt = qIndex !== -1 ? args[qIndex + 1] || '' : '';

// Optional: record every prompt this stub receives, for smoke checks that
// need to assert on prompt CONTENT (e.g. "does the platform map actually
// reach the model") rather than just the reply the stub sends back. Off by
// default — only writes when smoke.sh points SMOKE_HERMES_PROMPT_LOG at a
// scratch file. Append mode + separator since many calls land here per run.
const promptLog = process.env.SMOKE_HERMES_PROMPT_LOG;
if (promptLog) {
  try {
    appendFileSync(promptLog, prompt + '\n-----8<-----\n');
  } catch (logErr) { /* best-effort only — never fail the stub over this */ }
}

let lines;
if (/suggest exactly 3 short questions/i.test(prompt)) {
  lines = ['What is the timeline on this?', 'Can you send more details?', 'Who else is looped in?'];
} else {
  lines = ['Sure — here is a quick update on that.'];
}

// Splice the session_id metadata line into the middle of the output (not
// first, not last) so the "position varies" comment in runInference() is
// actually exercised by this stub.
const withSession = lines.slice();
withSession.splice(Math.floor(withSession.length / 2), 0, 'session_id: stub-session-0000');

process.stdout.write(withSession.join('\n') + '\n');
process.exit(0);
