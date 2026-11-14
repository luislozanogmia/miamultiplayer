import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

test('guided tour stays available but onboarding starts in chat', () => {
  const tour = source.slice(source.indexOf('var TOUR_STEPS = ['), source.indexOf('var tour = {', source.indexOf('var TOUR_STEPS = [')));
  assert.match(tour, /\[data-workspace-key="solo"\]/);
  assert.match(tour, /\.sidebar-new-chat/);
  assert.match(tour, /#chatStarterBots/);
  assert.match(tour, /#chatThread/);
  assert.doesNotMatch(tour, /three layers|Data|Agents, and/);
  assert.match(source, /loadHarnessSettings\(true\)\.then\(function\(\)[\s\S]*?harnessSettingsCache\.onboardingComplete\)[\s\S]*?then\(startMiaOnboardingChat\)/);
  assert.doesNotMatch(source, /function tourMaybeAutoStart\(\)\{\s*if\(STYLED_SKIN\) return/);
});

function functionSource(name){
  const start = source.indexOf('  function ' + name + '(');
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

test('an update never starts the guide: the browser comes back and the guide stays in Settings', () => {
  const calls = [];
  const context = {
    localBrowserBootRestoreHandled: false, shouldRestoreLocalBrowser: () => true,
    tourStart: () => calls.push('guide'), openWebBrowserTool: () => calls.push('browser'),
  };
  vm.createContext(context);
  vm.runInContext(functionSource('restoreLocalBrowserAfterBoot'), context);
  context.restoreLocalBrowserAfterBoot();
  assert.deepEqual(calls, ['browser']);
  assert.doesNotMatch(source, /startUpdatedDesktopIntro|releaseVersion/);
  assert.match(source, /settingsReplayTour/);
});

test('the guide starts by itself only for someone new to Mia on this computer', () => {
  const run = (done, seen) => {
    const saved = new Map(seen ? [['miaIntroVersion', seen]] : []);
    let started = 0;
    const context = {
      window: {miaDesktop: {state: {get: key => saved.get(key), set: (key, value) => saved.set(key, value)}}},
      localStorage: {getItem: () => (done ? '1' : null), setItem: () => {}},
      TOUR_LS_KEY: 'miaosTourDone', tour: {}, tourTeardown: () => {},
      setTimeout: fn => fn(), tourStart: () => { started += 1; },
    };
    vm.createContext(context);
    vm.runInContext(['tourMaybeAutoStart', 'tourFinish'].map(functionSource).join('\n'), context);
    context.tourMaybeAutoStart();
    return {started, context, saved};
  };
  assert.equal(run(false, '').started, 1);
  assert.equal(run(true, '').started, 0);
  // An earlier version left its number here; a finished guide leaves 'done'.
  assert.equal(run(false, '0.3.8').started, 0);
  assert.equal(run(false, 'legacy').started, 0);
  const fresh = run(false, '');
  fresh.context.tourFinish();
  assert.equal(fresh.saved.get('miaIntroVersion'), 'done');
});

test('replaying the guide closes native browser before showing HTML and begins at zero', () => {
  const calls = [];
  const context = {
    tour: {active: false}, location: {hash: '#/chat'},
    closeLocalBrowser: () => calls.push('close-browser'), closeChatThread: () => {}, closeChatTasksPanel: () => {},
    tourBuildDom: () => calls.push('build-guide'), el: () => ({style:{}, classList: {add: () => {}}}),
    document: {addEventListener: () => {}}, tourKeydown: () => {},
    tourShowStep: step => calls.push(step),
  };
  vm.createContext(context);
  vm.runInContext(functionSource('tourStart'), context);
  context.tourStart();
  assert.deepEqual(calls, ['close-browser', 'build-guide', 0]);
});

test('Next walks every guide step without needing a target click and Done finishes', () => {
  const nodes = {};
  const node = () => ({textContent: '', style: {}, classList: {add: () => {}, remove: () => {}}});
  ['#miaosTourTitle', '#miaosTourBody', '#miaosTourCount', '#miaosTourBack', '#miaosTourNext', '#miaosTourPopover'].forEach(id => { nodes[id] = node(); });
  const steps = ['A', 'B', 'C', 'D'].map(title => ({title, body: title, route: 'chat'}));
  const routed = [];
  let finished = 0;
  const context = {
    tour: {active: true, step: 0, steps},
    window: {},
    TOUR_LS_KEY: 'miaosTourDone',
    localStorage: {setItem: () => { finished += 1; }},
    location: {hash: '#/chat'},
    route: () => routed.push('route'),
    el: selector => nodes[selector] || null,
    tourWaitFor: (selector, cb) => cb(null),
    tourPosition: () => {},
    requestAnimationFrame: fn => fn(),
    tourTeardown: () => { context.tour.active = false; },
  };
  vm.createContext(context);
  vm.runInContext(['currentTourSteps', 'tourGoto', 'tourRender', 'tourShowStep', 'tourNext', 'tourFinish'].map(functionSource).join('\n'), context);
  context.tourShowStep(0);
  assert.equal(nodes['#miaosTourCount'].textContent, '1 / 4');
  const seen = [];
  for(let i = 0; i < 3; i += 1){
    context.tourNext();
    seen.push(nodes['#miaosTourTitle'].textContent + ' ' + nodes['#miaosTourCount'].textContent);
  }
  assert.deepEqual(seen, ['B 2 / 4', 'C 3 / 4', 'D 4 / 4']);
  assert.equal(nodes['#miaosTourNext'].textContent, 'Done');
  assert.equal(finished, 0);
  context.tourNext();
  assert.equal(finished, 1);
  assert.equal(context.tour.active, false);
  assert.deepEqual(routed, []);
  const wiring = source.slice(source.indexOf('function tourBuildDom'), source.indexOf('function tourGoto'));
  assert.match(wiring, /miaosTourNext'\)\.addEventListener\('click', tourNext\)/);
  assert.match(wiring, /miaosTourSkip'\)\.addEventListener\('click', tourFinish\)/);
});

test('the starter-bots step is left out when every starter bot was dismissed', () => {
  let visible = [];
  const context = { tour: {}, visibleChatStarterBots: () => visible };
  vm.createContext(context);
  const steps = source.slice(source.indexOf('var TOUR_STEPS = ['), source.indexOf('];', source.indexOf('var TOUR_STEPS = [')) + 2);
  vm.runInContext(steps.replace('var TOUR_STEPS', 'globalThis.TOUR_STEPS') + '\n' + functionSource('currentTourSteps'), context);
  const targets = () => context.currentTourSteps().map(step => step.target);
  assert.ok(!targets().includes('#chatStarterBots'));
  assert.equal(context.currentTourSteps().length, context.TOUR_STEPS.length - 1);
  visible = [{name: 'Inbox triage'}];
  assert.ok(targets().includes('#chatStarterBots'));
});
