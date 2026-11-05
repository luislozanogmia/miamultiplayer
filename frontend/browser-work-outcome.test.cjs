'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {projection, workLabel, workerLabel, displayOrder} = require('./browser-work.js');

test('a finished task reads as done; a stored declinedActions count no longer changes its label', () => {
  const work={id:'w',groupId:'g',status:'done',workers:[{id:'a',status:'done',declinedActions:1},{id:'b',status:'done'}]};
  assert.equal(projection(work,'g').status,'Done');
  assert.equal(workerLabel(work.workers[0]),'Done');
  assert.equal(workLabel(work),'Done');
  assert.equal(Object.hasOwn(projection(work,'g'),'approvals'),false);
  assert.equal(Object.hasOwn(projection(work,'g'),'approvalFailures'),false);
});

test('work the person ended reads as stopped or tab closed; only a bot failure reads as failed', () => {
  assert.equal(workLabel({status:'cancelled',workers:[{status:'done'},{status:'cancelled',stopReason:'stopped'}]}),'Stopped');
  assert.equal(workLabel({status:'cancelled',workers:[{status:'done'},{status:'cancelled',stopReason:'tab_closed'}]}),'Tab closed');
  assert.equal(workLabel({status:'cancelled',workers:[{status:'cancelled',stopReason:'tab_closed'},{status:'cancelled',stopReason:'stopped'}]}),'Stopped');
  assert.equal(workLabel({status:'cancelled',workers:[]}),'Stopped');
  assert.equal(workLabel({status:'failed',workers:[{status:'failed'},{status:'cancelled',stopReason:'tab_closed'}]}),'Failed');
  assert.equal(workerLabel({status:'cancelled',stopReason:'tab_closed'}),'Tab closed');
  assert.equal(workerLabel({status:'cancelled',stopReason:'stopped'}),'Stopped');
  assert.equal(workerLabel({status:'failed',stopReason:'tab_closed'}),'Failed','a stop reason never relabels a failure');
  assert.equal(workerLabel({status:'mystery'}),'Unknown state');
});

test('running work comes first, then the newest finished work', () => {
  const stored=[
    {id:'old-done',groupId:'g',status:'done',createdAt:1,workers:[]},
    {id:'running',groupId:'g',status:'working',createdAt:2,workers:[]},
    {id:'new-done',groupId:'g',status:'done',createdAt:3,workers:[]},
    {id:'waiting',groupId:'g',status:'waiting_for_user',createdAt:0,workers:[]},
    {id:'undated-a',groupId:'g',status:'failed',workers:[]},{id:'undated-b',groupId:'g',status:'failed',workers:[]},
  ];
  assert.deepEqual(displayOrder(stored.map(work=>projection(work,'g'))).map(work=>work.id),['running','waiting','new-done','old-done','undated-b','undated-a']);
  assert.equal(stored[0].id,'old-done','ordering must not reorder durable records');
});
