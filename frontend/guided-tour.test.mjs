import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
