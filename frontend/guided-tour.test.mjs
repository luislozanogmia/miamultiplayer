import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

test('guided tour stays available but onboarding starts in chat', () => {
  const tour = source.slice(source.indexOf('var TOUR_STEPS = ['), source.indexOf('var tour = {', source.indexOf('var TOUR_STEPS = [')));
  assert.match(tour, /#workspaceSwitcherToggle/);
  assert.match(tour, /#chatSidebarToolsBtn/);
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

test('updates start at guide step one before browser restoration, once per completed version', () => {
  const saved = new Map([['miaIntroVersion', '0.2.2']]);
  const calls = [];
  const context = {
    window: {miaDesktop: {version: () => '0.2.3', state: {get: key => saved.get(key), set: (key, value) => saved.set(key, value)}}},
    localStorage: {getItem: () => null, setItem: () => {}},
    TOUR_LS_KEY: 'miaosTourDone', tour: {}, localBrowserBootRestoreHandled: false,
    shouldRestoreLocalBrowser: () => true,
    tourStart: () => calls.push('intro'), tourTeardown: () => {},
    openWebBrowserTool: () => calls.push('browser'),
  };
  vm.createContext(context);
  vm.runInContext(['startUpdatedDesktopIntro', 'restoreLocalBrowserAfterBoot', 'tourFinish'].map(functionSource).join('\n'), context);
  context.restoreLocalBrowserAfterBoot();
  assert.deepEqual(calls, ['intro']);
  assert.equal(context.tour.releaseVersion, '0.2.3');
  assert.equal(saved.get('miaIntroVersion'), '0.2.2');
  context.tourFinish();
  assert.equal(saved.get('miaIntroVersion'), '0.2.3');
  context.localBrowserBootRestoreHandled = false;
  context.restoreLocalBrowserAfterBoot();
  assert.deepEqual(calls, ['intro', 'browser']);
});

test('fresh installs retain chat onboarding, legacy installs with a browser receive the introduction', () => {
  for(const existing of [false, true]){
    const saved = new Map();
    let started = false;
    const context = {
      window: {miaDesktop: {version: () => '0.2.3', state: {get: key => saved.get(key), set: (key, value) => saved.set(key, value)}}},
      localStorage: {getItem: () => null}, TOUR_LS_KEY: 'miaosTourDone', tour: {},
      shouldRestoreLocalBrowser: () => existing, tourStart: () => { started = true; },
    };
    vm.createContext(context);
    vm.runInContext(functionSource('startUpdatedDesktopIntro'), context);
    assert.equal(context.startUpdatedDesktopIntro(), existing);
    assert.equal(started, existing);
    assert.equal(saved.get('miaIntroVersion'), existing ? 'legacy' : '0.2.3');
  }
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
