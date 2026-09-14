import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { stripTaskOpeningNotice, humanTaskStatus, shouldPostTaskStatus } = require('./background-status.js');

test('removes the duplicate thread-opening sentence from the main acknowledgement', () => {
  assert.equal(
    stripTaskOpeningNotice("On it, Dana — I’ll check the sources.\n\nOpening a thread now — I’ll post the final result there."),
    'On it, Dana — I’ll check the sources.'
  );
});

test('keeps a normal acknowledgement unchanged', () => {
  assert.equal(stripTaskOpeningNotice('On it, Dana — I’ll check the sources.'), 'On it, Dana — I’ll check the sources.');
});

test('uses plain-language queued and running status lines', () => {
  assert.equal(humanTaskStatus('queued', 0), 'I’m waiting for a turn to start — I’ll keep you posted.');
  assert.equal(humanTaskStatus('queued', 1), 'I’m queued up and still waiting for a turn.');
  assert.equal(humanTaskStatus('running', 0), 'I’m working through this now.');
  assert.equal(humanTaskStatus('running', 3), 'I’m pulling the answer together.');
  assert.equal(humanTaskStatus('running', 5), 'I’m still on it — I’ll keep you posted.');
  assert.equal(humanTaskStatus('running', 99), 'I’m still checking the details.');
});

test('does not repost an unchanged thread status', () => {
  assert.equal(shouldPostTaskStatus(null, 'I’m doing a final pass now.'), true);
  assert.equal(shouldPostTaskStatus('I’m doing a final pass now.', 'I’m doing a final pass now.'), false);
  assert.equal(shouldPostTaskStatus('I’m doing a final pass now.', 'I’m checking the important details.'), true);
});

test('native background work posts one progress event for every target and excludes it from inference history', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const executionStart = source.indexOf('async function runNativeConversationAgentReply(');
  const executionEnd = source.indexOf('\nasync function executeNativeConversationDispatch(', executionStart);
  const execution = source.slice(executionStart, executionEnd);

  assert.notEqual(executionStart, -1);
  assert.match(execution, /const parentEventId = nativeReplyParentEventId\(trigger\);/);
  assert.match(execution, /const agent = nativeDispatchActor\(dispatch, conversation, trigger\);/);
  assert.match(execution, /if \(rawChatModelSelection && !Object\.keys\(availableChatModelProviders\)\.length\)/);
  assert.match(execution, /await getHermesGatewayModelOptions\(\{ refresh: true \}\)/);
  assert.match(execution, /rememberNativeChatModelInventory\(payload\)/);
  assert.match(execution, /content: \{ text: humanTaskStatus\('running', 0\) \}/);
  assert.match(source, /function nativeReplyParentEventId\(trigger\) \{[\s\S]*return trigger && trigger\.parentEventId \? trigger\.parentEventId : null;/);
  assert.match(execution, /clientIdempotencyKey: `native-dispatch-progress-\$\{dispatch\.id\}`/);
  assert.match(execution, /progress: true,/);
  assert.match(execution, /clientIdempotencyKey: `native-dispatch-\$\{dispatch\.id\}`/);
  assert.match(execution, /parentEventId,/);
  assert.match(execution, /\.filter\(\(event\) => event\.id !== trigger\.id && !isNativeProgressEvent\(event\)\)/);
  assert.match(source, /function isNativeProgressEvent\(event\) \{[\s\S]*metadata\.progress === true/);
  assert.match(source, /event\.id === triggerId \|\| isNativeProgressEvent\(event\)/);
  assert.doesNotMatch(execution, /if \(dispatch\.targetType === 'agent'\) \{[\s\S]*native-dispatch-progress/);
  assert.doesNotMatch(execution, /postHumanStatus|setInterval\(postHumanStatus/);
  assert.doesNotMatch(source, /Working on this now — I’ll post the result here\./);
  assert.match(source, /function scheduleNativeConversationDispatch\(dispatch\)/);
  assert.match(source, /nativeDispatchChainKey\(dispatch\)/);
  assert.doesNotMatch(source, /setImmediate\(\(\) => executeNativeConversationDispatch\(dispatch\)\)/);
});

test('interactive and scheduled bot delivery share the native artifact attachment boundary', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const executionStart = source.indexOf('async function runNativeConversationAgentReply(');
  const executionEnd = source.indexOf('\nasync function executeNativeConversationDispatch(', executionStart);
  const execution = source.slice(executionStart, executionEnd);
  const cronStart = source.indexOf('async function deliverBotCronResults()');
  const cron = source.slice(cronStart);

  assert.match(execution, /artifactWorkspaceForBot\(agent\)/);
  assert.match(execution, /validateBotArtifacts\(/);
  assert.match(execution, /createNativeArtifactAttachments\(/);
  assert.match(execution, /artifactSource: 'interactive'/);
  assert.match(cron, /createNativeArtifactAttachments\(\{ conversation, principal, artifact \}\)/);
  assert.match(source, /function createNativeArtifactAttachments\(/);
  assert.doesNotMatch(cron, /fs\.readFileSync\(artifact\.filePath\)/);
});
