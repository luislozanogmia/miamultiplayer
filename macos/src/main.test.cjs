"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

test("desktop shell uses the Mia application name and Linux icon", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /app\.setName\("Mia"\)/);
  assert.doesNotMatch(source, /app\.setName\("MiaOS"\)/);
  assert.ok(source.indexOf('app.setName("Mia")') < source.indexOf('resolveClerkConfig(desktopClerkEnvironment())'));
  assert.match(source, /process\.platform === "linux"[\s\S]{0,120}MIA_LINUX_ICON_PATH/);
  assert.match(source, /icon: fs\.existsSync\(windowIconPath\) \? windowIconPath : undefined/);
});

test("main-window trust uses exact parsed origins", () => {
  const main = loadMain();
  assert.equal(main.hasExactOrigin("http://127.0.0.1:4871/chat", "http://127.0.0.1:4871"), true);
  assert.equal(main.hasExactOrigin("http://127.0.0.1:48710/chat", "http://127.0.0.1:4871"), false);
  assert.equal(main.hasExactOrigin("http://127.0.0.1:4871.evil.test/chat", "http://127.0.0.1:4871"), false);
  assert.equal(main.hasExactOrigin("not a url", "http://127.0.0.1:4871"), false);
  assert.equal(main.isTrustedMainWindowUrl("http://127.0.0.1:4871/chat", "http://127.0.0.1:4871"), true);
  assert.equal(main.isTrustedMainWindowUrl("http://127.0.0.1:48710/chat", "http://127.0.0.1:4871"), false);
});

test("test Clerk instance accepts only Clerk's exact shared Google OAuth callback", () => {
  const main = loadMain({ MIAOS_CLERK_INSTANCE: "test" });
  const valid = new URL("https://accounts.google.com/v3/signin/accountchooser");
  valid.searchParams.set("redirect_uri", "https://clerk.shared.lcl.dev/v1/oauth_callback");
  valid.searchParams.set("response_type", "code");

  assert.equal(main.isClerkGoogleOAuthUrl(valid.href), true);
  for (const blocked of [
    "https://accounts.google.com/",
    "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fattacker.example%2Fv1%2Foauth_callback&response_type=code",
    "https://attacker.example/?redirect_uri=https%3A%2F%2Fclerk.shared.lcl.dev%2Fv1%2Foauth_callback&response_type=code",
    "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Fclerk.shared.lcl.dev%2Fv1%2Foauth_callback&response_type=code",
    "https://accounts.google.com:444/o/oauth2/auth?redirect_uri=https%3A%2F%2Fclerk.shared.lcl.dev%2Fv1%2Foauth_callback&response_type=code",
  ]) assert.equal(main.isClerkGoogleOAuthUrl(blocked), false, blocked);
});

test("production Clerk OAuth accepts only the configured exact FAPI callback", () => {
  const clerkHost = "clerk.example.com";
  const main = loadMain({
    CLERK_PUBLISHABLE_KEY: `${["pk", "live"].join("_")}_${Buffer.from(`${clerkHost}$`).toString("base64url")}`,
    CLERK_JWT_KEY: "public-key-fixture",
    CLERK_ISSUER: `https://${clerkHost}`,
  });
  const googleUrl = callback => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("redirect_uri", `${callback}/v1/oauth_callback`);
    url.searchParams.set("response_type", "code");
    return url.href;
  };
  assert.equal(main.isClerkGoogleOAuthUrl(googleUrl(`https://${clerkHost}`)), true);
  assert.equal(main.isClerkGoogleOAuthUrl(googleUrl("https://clerk.shared.lcl.dev")), false);
  assert.equal(main.isClerkGoogleOAuthUrl(googleUrl("https://clerk.example.com.attacker.test")), false);
});

test("desktop Clerk configuration uses dotenv multiline PEM parsing", () => {
  const clerkHost = "clerk.example.com";
  const jwtKey = "-----BEGIN PUBLIC KEY-----\nmultiline-fixture\n-----END PUBLIC KEY-----";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-clerk-env-test-"));
  const envFile = path.join(tempDir, ".env.local");
  fs.writeFileSync(envFile, [
    `CLERK_PUBLISHABLE_KEY=${["pk", "live"].join("_")}_${Buffer.from(`${clerkHost}$`).toString("base64url")}`,
    `CLERK_ISSUER=https://${clerkHost}`,
    `CLERK_JWT_KEY="${jwtKey}"`,
  ].join("\n"));
  try {
    const requireBackend = Module.createRequire(path.join(__dirname, "../../backend/server.js"));
    assert.equal(requireBackend("dotenv").parse(fs.readFileSync(envFile, "utf8")).CLERK_JWT_KEY, jwtKey);
    const main = loadMain({ MIAOS_ENV_FILE: envFile });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("redirect_uri", `https://${clerkHost}/v1/oauth_callback`);
    url.searchParams.set("response_type", "code");
    assert.equal(main.isClerkGoogleOAuthUrl(url.href), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("legacy Clerk Google navigation is denied, never opened in an embedded popup", () => {
  const { EventEmitter } = require("node:events");
  const main = loadMain();
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = handler => { contents.popup = handler; };
  main.configureNavigation({ webContents: contents }, "http://localhost:4871");
  const url = "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fclerk.shared.lcl.dev%2Fv1%2Foauth_callback&response_type=code";
  assert.deepEqual(contents.popup({url}), {action:"deny"});
  let blocked = false;
  contents.emit("will-navigate", {url, preventDefault(){ blocked = true; }});
  assert.equal(blocked, true);
  assert.equal(main.__electron.BrowserWindow.instances.length, 0);
});

test("provider auth redirects preserve nested OAuth windows and their navigation guards", async () => {
  const { EventEmitter } = require("node:events");
  const main = loadMain();
  const contents = new EventEmitter();
  contents.session = { id: "main-session" };
  contents.setWindowOpenHandler = handler => { contents.popup = handler; };
  const parent = { webContents: contents };
  main.configureNavigation(parent, "http://localhost:4871");

  const redirect = "http://localhost:4871/api/settings/harness/auth/redirect?provider=claude-subscription-directsdk-experimental";
  const decision = contents.popup({ url: redirect });
  assert.equal(decision.action, "allow");
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(decision.overrideBrowserWindowOptions.webPreferences.session, contents.session);
  assert.match(decision.overrideBrowserWindowOptions.webPreferences.preload, /google-oauth-preload\.cjs$/);

  const childContents = new EventEmitter();
  childContents.session = contents.session;
  childContents.setWindowOpenHandler = handler => { childContents.popup = handler; };
  const child = { webContents: childContents, loadedUrls: [], loadURL(url) { this.loadedUrls.push(url); } };
  contents.emit("did-create-window", child, { url: redirect });
  const navigate = (eventName, url) => {
    let blocked = false;
    const event = { url, preventDefault() { blocked = true; } };
    if (eventName === "will-redirect") childContents.emit(eventName, event, url);
    else childContents.emit(eventName, event);
    return !blocked;
  };
  assert.equal(navigate("will-navigate", redirect), true, "initial local broker must load before its remote redirect");
  assert.equal(navigate("will-navigate", "http://localhost:4871/"), false);
  assert.equal(navigate("will-navigate", "https://platform.claude.com/oauth/code/callback?state=fixture&code=early"), false);
  const authorization = new URL("https://claude.com/cai/oauth/authorize");
  authorization.searchParams.set("code", "true");
  authorization.searchParams.set("state", "fixture-state");
  authorization.searchParams.set("redirect_uri", "https://platform.claude.com/oauth/code/callback");
  assert.equal(navigate("will-navigate", authorization.toString()), true);
  assert.equal(navigate("will-navigate", redirect), false, "remote auth cannot navigate back into the local broker");
  assert.equal(navigate("will-navigate", "https://accounts.google.com/v3/signin/identifier"), true);
  assert.equal(navigate("will-redirect", "https://platform.claude.com/oauth/code/callback?state=wrong&code=fixture"), false);
  assert.equal(navigate("will-redirect", "https://platform.claude.com/oauth/code/callback?state=fixture-state&code=fixture"), true);
  assert.equal(navigate("will-redirect", "http://127.0.0.1:54132/callback?state=fixture-state&code=fixture"), false);
  assert.equal(navigate("will-navigate", "https://claude.com:444/cai/oauth/authorize"), false);
  assert.equal(navigate("will-navigate", "https://claude.com.attacker.test/"), false);
  assert.equal(navigate("will-redirect", "https://example.com/steal"), false);
  assert.equal(navigate("will-navigate", "file:///tmp/private"), false);
  assert.deepEqual(childContents.popup({ url: "https://example.com/escape" }), { action: "deny" });
  const google = "https://accounts.google.com/o/oauth2/v2/auth";
  const nestedDecision = childContents.popup({ url: google });
  assert.equal(nestedDecision.action, "allow", "Google needs a real Window, not a denied popup followed by parent navigation");
  assert.equal(nestedDecision.overrideBrowserWindowOptions.parent, child);
  assert.equal(nestedDecision.overrideBrowserWindowOptions.webPreferences.session, contents.session);
  assert.equal(nestedDecision.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(nestedDecision.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(nestedDecision.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.loadedUrls, [], "Claude's opener page must survive the Google handoff");
  const googleContents = new EventEmitter();
  googleContents.session = contents.session;
  googleContents.setWindowOpenHandler = handler => { googleContents.popup = handler; };
  const googleWindow = { webContents: googleContents };
  childContents.emit("did-create-window", googleWindow, { url: google });
  const nestedNavigate = url => {
    let blocked = false;
    googleContents.emit("will-redirect", { preventDefault() { blocked = true; } }, url);
    return !blocked;
  };
  assert.equal(nestedNavigate("https://claude.ai/api/auth/callback/google"), true);
  assert.equal(nestedNavigate("https://platform.claude.com/oauth/code/callback?state=fixture-state&code=fixture"), true);
  for (const url of [
    "https://platform.claude.com/oauth/code/callback?state=wrong&code=fixture",
    "https://accounts.google.com.attacker.test/",
    "https://accounts.google.com:444/",
    "file:///tmp/private",
    "http://localhost:4871/",
  ]) {
    assert.equal(nestedNavigate(url), false, url);
    assert.deepEqual(googleContents.popup({ url }), { action: "deny" }, url);
  }
  let completed = 0;
  let closed = false;
  googleContents.session.fetch = async () => { completed += 1; return { status: 202 }; };
  googleWindow.close = () => { closed = true; };
  googleContents.emit("did-navigate", {}, "https://platform.claude.com/oauth/code/callback?state=fixture-state&code=fixture");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, 1, "the live navigation listener submits the code automatically");
  assert.equal(closed, true, "accepted code closes the auth window");
});

test("ChatGPT and Grok sign-in pages open in the system browser, not the Mia popup", () => {
  const { EventEmitter } = require("node:events");
  for (const [provider, signIn] of [
    ["openai-codex", "https://auth.openai.com/codex/device"],
    ["xai-oauth", "https://accounts.x.ai/oauth2/device"],
  ]) {
    const main = loadMain();
    const opened = [];
    main.__electron.shell.openExternal = url => { opened.push(url); return Promise.resolve(); };
    const contents = new EventEmitter();
    contents.session = { id: "main-session" };
    contents.setWindowOpenHandler = handler => { contents.popup = handler; };
    main.configureNavigation({ webContents: contents }, "http://localhost:4871");

    // The local broker still loads in Mia so it can use the signed-in session.
    const redirect = `http://localhost:4871/api/settings/harness/auth/redirect?provider=${provider}`;
    assert.equal(contents.popup({ url: redirect }).action, "allow");
    const childContents = new EventEmitter();
    childContents.setWindowOpenHandler = handler => { childContents.popup = handler; };
    let closed = false;
    const child = { webContents: childContents, close() { closed = true; } };
    contents.emit("did-create-window", child, { url: redirect });

    let blocked = false;
    childContents.emit("will-redirect", { preventDefault() { blocked = true; } }, signIn);
    assert.equal(blocked, true, `${provider} sign-in must not load inside Mia`);
    assert.deepEqual(opened, [signIn], `${provider} sign-in opens in the default browser`);
    assert.equal(closed, true, "the empty Mia popup closes");

    // Anything else still fails closed and is never handed to the system browser.
    blocked = false;
    childContents.emit("will-redirect", { preventDefault() { blocked = true; } }, "https://example.com/steal");
    assert.equal(blocked, true);
    assert.deepEqual(opened, [signIn]);
  }
});

test("provider auth URL allowlists cover existing providers and fail closed", () => {
  const main = loadMain();
  assert.equal(main.isHarnessAuthNavigation("https://auth.openai.com/authorize", "openai-codex"), true);
  assert.equal(main.isHarnessAuthNavigation("https://auth.x.ai/oauth", "xai-oauth"), true);
  assert.equal(main.isHarnessAuthNavigation("https://accounts.x.ai/login", "xai-oauth"), true);
  assert.equal(main.isHarnessAuthNavigation("https://claude.com/cai/oauth/authorize", "claude-subscription-directsdk-experimental"), true);
  assert.equal(main.isHarnessAuthNavigation("https://platform.claude.com/oauth/code/callback?state=fixture", "claude-subscription-directsdk-experimental"), false);
  const contract = main.claudeAuthStartContract("https://claude.com/cai/oauth/authorize?code=true&state=fixture&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback");
  assert.equal(contract.redirectOrigin, "https://platform.claude.com");
  assert.equal(contract.redirectPath, "/oauth/code/callback");
  assert.equal(main.claudeAuthStartContract("https://claude.com/cai/oauth/authorize?code=true&state=fixture&redirect_uri=https%3A%2F%2Fplatform.claude.com.attacker.test%2Foauth%2Fcode%2Fcallback"), null);
  assert.equal(main.isHarnessAuthNavigation("https://auth.openai.com:444/", "openai-codex"), false);
  assert.equal(main.isHarnessAuthNavigation("https://auth.openai.com/", "unknown"), false);
  assert.equal(main.harnessAuthRedirectProvider("http://localhost:48710/api/settings/harness/auth/redirect?provider=openai-codex", "http://localhost:4871"), "");
});

test("Claude callback automatically submits only the bound code using Mia's session", async () => {
  const main = loadMain();
  const contract = { state: "fixture-state", redirectOrigin: "https://platform.claude.com", redirectPath: "/oauth/code/callback" };
  const calls = [];
  const window = { webContents: { session: { fetch: async (...args) => { calls.push(args); return { status: 202 }; } } } };
  const callback = "https://platform.claude.com/oauth/code/callback?state=fixture-state&code=fixture-code";
  for (const url of [callback.replace("fixture-state", "stale"), callback.replace("platform.claude.com", "attacker.test"), callback.replace("fixture-code", "bad%0Acode"), callback.replace("/oauth/code/callback", "/other")]) {
    assert.equal(await main.completeClaudeAuthCallback(window, url, contract, "http://localhost:4871"), false);
  }
  assert.equal(calls.length, 0);
  assert.equal(await main.completeClaudeAuthCallback(window, callback, contract, "http://localhost:4871"), true);
  assert.equal(calls[0][0], "http://localhost:4871/api/settings/harness/auth/complete");
  assert.equal(calls[0][1].credentials, "include");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers.Origin, "http://localhost:4871");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    provider: "claude-subscription-directsdk-experimental", code: "fixture-code#fixture-state", state: "fixture-state",
  });
  window.webContents.session.fetch = async () => ({ status: 409 });
  assert.equal(await main.completeClaudeAuthCallback(window, callback, contract, "http://localhost:4871"), false);
  window.webContents.session.fetch = async () => { throw new Error("offline"); };
  assert.equal(await main.completeClaudeAuthCallback(window, callback, contract, "http://localhost:4871"), false);
});

test("packaged runtime copy is replaced by a new build of the same commit", () => {
  const main = loadMain();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-runtime-sync-test-"));
  try {
    const source = path.join(root, "bundle", "hermes");
    const destination = path.join(root, "userData", "hermes-agent");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, ".miaos-source-commit"), "abc123\n");
    fs.writeFileSync(path.join(source, "module.so"), "ad-hoc build");
    fs.utimesSync(path.join(source, ".miaos-source-commit"), new Date(1000000), new Date(1000000));

    assert.equal(main.syncPackagedDirectory(source, destination), true);
    assert.equal(main.syncPackagedDirectory(source, destination), false);

    // Same commit, rebuilt and re-signed: the stale copy must be replaced.
    fs.writeFileSync(path.join(source, "module.so"), "Developer ID build");
    fs.utimesSync(path.join(source, ".miaos-source-commit"), new Date(2000000), new Date(2000000));
    assert.equal(main.syncPackagedDirectory(source, destination), true);
    assert.equal(fs.readFileSync(path.join(destination, "module.so"), "utf8"), "Developer ID build");

    // A copy made before build stamps existed is refreshed once.
    fs.rmSync(path.join(destination, ".miaos-packaged-build"));
    assert.equal(main.syncPackagedDirectory(source, destination), true);
    assert.equal(main.syncPackagedDirectory(source, destination), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passkey account chooser listens on every session, not on app", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(source, /app\.on\("select-webauthn-account"/);
  assert.match(source, /ses\.on\("select-webauthn-account"/);
  assert.match(source, /attach\(session\.defaultSession\)/);
  assert.match(source, /app\.on\("session-created", attach\)/);
});

test("packaged macOS runtime is self-contained and ignores ambient Hermes", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /app\.isPackaged\s*\?\s*PACKAGED_HERMES_BIN/);
  assert.match(source, /syncPackagedDirectory\(path\.join\(PACKAGED_RUNTIME_ROOT, "hermes"\)/);
  assert.match(source, /syncPackagedDirectory\(path\.join\(PACKAGED_RUNTIME_ROOT, "ghost-cli"\)/);
  assert.match(source, /verbatimSymlinks:\s*true/);
  assert.match(source, /process\.env\.GHOST_IN_APP_BROWSER_SOCKET/);
  assert.match(source, /process\.env\.PYTHONDONTWRITEBYTECODE\s*=\s*"1"/);
  assert.match(source, /process\.env\.HERMES_PYTHON/);
  assert.match(source, /process\.env\.HERMES_GWS_BIN = gwsLauncher/);
  assert.match(source, /process\.env\.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = path\.join\(userData, "google-workspace"\)/);
  assert.match(source, /process\.env\.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND = "file"/);
  assert.match(source, /\[pythonExecutable, hermesLauncher, ghostLauncher, gwsLauncher\]/);
  assert.match(source, /CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR/);
  assert.match(source, /discoverClaudeCodeCommand\(\)/);
  assert.match(source, /\.npm-global[\s\S]*claude/);
});

test("Claude uses its native credential store unless a custom config is explicit", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(source, /CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR:[\s\S]{0,140}path\.join\(app\.getPath\("home"\), "\.claude"\)/);
});

test("bare macOS dev launches prefer Mia's bundled Hermes and preserve explicit overrides", () => {
  const main = loadMain();
  const bundled = '/Applications/Mia.app/Contents/Resources/runtime/bin/hermes';
  assert.equal(main.developmentHermesBinary({}, () => true, 'darwin'), bundled);
  assert.equal(main.developmentHermesBinary({HERMES_BIN:'/custom/hermes'}, () => true, 'darwin'), '/custom/hermes');
  assert.equal(main.developmentHermesBinary({}, () => false, 'darwin'), '');
  assert.notEqual(main.developmentHermesBinary({}, () => true, 'linux'), bundled);
});

test("Claude CLI discovery skips an unreadable PATH entry", () => {
  const main = loadMain();
  const originalPath = process.env.PATH;
  const originalStatSync = fs.statSync;
  try {
    process.env.PATH = ["/unreadable", "/working"].join(path.delimiter);
    fs.statSync = candidate => {
      if (candidate.startsWith("/unreadable/")) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      if (candidate.startsWith("/working/")) return { isFile: () => true };
      return undefined;
    };
    assert.equal(main.discoverClaudeCodeCommand(), path.join("/working", "claude"));
  } finally {
    fs.statSync = originalStatSync;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("packaged runtime resolves platform layout through shared helpers", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /const pythonExecutable = bundledPythonPath\(path\.join\(PACKAGED_RUNTIME_ROOT, "python"\)\)/);
  assert.match(source, /const hermesLauncher = runtimeLauncherPath\(runtimeBin, "hermes"\)/);
  assert.match(source, /const ghostLauncher = runtimeLauncherPath\(runtimeBin, "ghost-cli"\)/);
  assert.match(source, /const gwsLauncher = nativeRuntimeBinaryPath\(runtimeBin, "gws"\)/);
  assert.match(source, /process\.env\.HERMES_PYTHON = venvPythonPath\(venvRoot\)/);
  assert.match(source, /venvPythonPath\(path\.join\(hermesHome, "hermes-agent", "venv"\)\)/);
  // The Unix shell launchers are regenerated only where they exist; Windows
  // venvs keep their shipped Scripts\python.exe redirector.
  assert.match(source, /if \(process\.platform !== "win32"\) \{\s*\n\s*for \(const name of \["python", "python3", "python3\.11"\]\)/);
  assert.doesNotMatch(source, /"python", "bin", "python3\.11"/);
});

test("runtime path helpers map both the Unix and Windows layouts", () => {
  const main = loadMain();
  const withPlatform = (platform, run) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    try { return run(); } finally { Object.defineProperty(process, "platform", original); }
  };

  withPlatform("darwin", () => {
    assert.equal(main.venvBinDir("/venv"), path.join("/venv", "bin"));
    assert.equal(main.venvPythonPath("/venv"), path.join("/venv", "bin", "python"));
    assert.equal(main.bundledPythonPath("/rt/python"), path.join("/rt/python", "bin", "python3.11"));
    assert.equal(main.runtimeLauncherPath("/rt/bin", "hermes"), path.join("/rt/bin", "hermes"));
    assert.equal(main.nativeRuntimeBinaryPath("/rt/bin", "gws"), path.join("/rt/bin", "gws"));
  });
  withPlatform("win32", () => {
    assert.equal(main.venvBinDir("C:\\venv"), path.join("C:\\venv", "Scripts"));
    assert.equal(main.venvPythonPath("C:\\venv"), path.join("C:\\venv", "Scripts", "python.exe"));
    assert.equal(main.bundledPythonPath("C:\\rt\\python"), path.join("C:\\rt\\python", "python.exe"));
    assert.equal(main.runtimeLauncherPath("C:\\rt\\bin", "hermes"), path.join("C:\\rt\\bin", "hermes.cmd"));
    assert.equal(main.nativeRuntimeBinaryPath("C:\\rt\\bin", "gws"), path.join("C:\\rt\\bin", "gws.exe"));
  });
});

test("Windows launchers spawn through cmd.exe instead of direct .cmd execution", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /function spawnRuntimeCommand\(command, args, options\)/);
  assert.match(source, /process\.platform === "win32" && \/\\\.\(cmd\|bat\)\$\/i\.test\(command\)/);
  assert.match(source, /spawn\("cmd\.exe", \["\/d", "\/s", "\/c"/);
  assert.match(source, /windowsVerbatimArguments: true/);
  assert.match(source, /windowsHide: true/);
});

test("all privileged main-window IPC checks include renderer URL validation", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.doesNotMatch(source, /url\.startsWith\(backendUrl\)/);
  for (const channel of [
    "miaos-retry-connection",
    "miaos-renderer-ready",
    "miaos-renderer-hydrated",
    "miaos-state-get",
    "miaos-state-set",
    "miaos-artifact-open",
    "miaos-reset-relaunch",
  ]) {
    const start = source.indexOf(`\"${channel}\"`);
    assert.ok(start >= 0, channel);
    assert.match(source.slice(start, start + 350), /isMainWindowSender\(event\)/, channel);
  }
});

function loadMain(environment = {}) {
  const previousEnvironment = new Map();
  for (const [name, value] of Object.entries(environment)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  const electron = {
    app: {
      setName() {},
      requestSingleInstanceLock() { return true; },
      quit() {},
      getPath() { return "/tmp/miaos-main-test"; },
      whenReady() { return { then() {} }; },
      on() {},
      dock: null,
    },
    autoUpdater: {
      on() {},
      setFeedURL() {},
      checkForUpdates() { return Promise.resolve(); },
      quitAndInstall() {},
    },
    BrowserWindow: class FakeBrowserWindow {
      static instances = [];
      constructor(options) {
        const { EventEmitter } = require("node:events");
        this.options = options;
        this.webContents = new EventEmitter();
        this.webContents.setWindowOpenHandler = handler => { this.webContents.popup = handler; };
        this.loadedUrls = [];
        this.closed = false;
        FakeBrowserWindow.instances.push(this);
      }
      loadURL(url) { this.loadedUrls.push(url); }
      close() { this.closed = true; }
    },
    dialog: { showMessageBox() { return Promise.resolve({ response: 1 }); } },
    ipcMain: { handle() {}, on() {}, removeHandler() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate(template) { return template; } },
    session: { fromPartition() { return {}; } },
    shell: { openExternal() {} },
    WebContentsView: class {},
  };
  const load = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "electron") return electron;
    return load.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./main.cjs")];
    return { ...require("./main.cjs"), __electron: electron };
  } finally {
    Module._load = load;
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("Development menu controls the single Mia-owned runtime", async () => {
  const main = loadMain();
  const calls = [];
  const menu = main.createDevelopmentMenu({
    startServer: () => calls.push("startServer"),
    stopServer: () => calls.push("stopServer"),
    restartServer: () => calls.push("restartServer"),
    openServerLog: () => calls.push("openServerLog"),
    refreshUi: () => calls.push("refreshUi"),
  });

  assert.equal(menu.label, "Development");
  assert.deepEqual(menu.submenu.filter(item => item.label).map(item => item.label), [
    "Start server",
    "Stop server",
    "Restart server",
    "Open CMD with server log",
    "UI refresh",
  ]);

  for (const item of menu.submenu) item.click?.();
  assert.deepEqual(calls, [
    "startServer",
    "stopServer",
    "restartServer",
    "openServerLog",
    "refreshUi",
  ]);
  await Promise.resolve();
});

test("Development menu is part of the native application menu", () => {
  const main = loadMain();
  const template = main.createApplicationMenuTemplate();
  assert.equal(template.find(item => item.label === "Development")?.label, "Development");
});

test("application menu keeps macOS-only roles off Windows and adds a quit item there", () => {
  const main = loadMain();
  const withPlatform = (platform, run) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform });
    try { return run(); } finally { Object.defineProperty(process, "platform", original); }
  };

  const macTemplate = withPlatform("darwin", () => main.createApplicationMenuTemplate());
  assert.equal(macTemplate[0].role, "appMenu");
  assert.equal(macTemplate.some(item => item.label === "File" && item.submenu.some(entry => entry.role === "quit")), false);

  const winTemplate = withPlatform("win32", () => main.createApplicationMenuTemplate());
  assert.equal(winTemplate.some(item => item.role === "appMenu"), false);
  const winFile = winTemplate.find(item => item.label === "File");
  assert.equal(winFile.submenu.some(entry => entry.role === "quit"), true);
  const help = winTemplate.find(item => item.role === "help");
  assert.equal(help.submenu[0].enabled, true);
});

test("OTA updates default to the GitHub releases feed and use signed-app update controls", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /provider: "github", owner: UPDATE_GITHUB_OWNER, repo: UPDATE_GITHUB_REPO/);
  assert.match(source, /MIAOS_UPDATE_FEED_URL/);
  assert.match(source, /url\.protocol !== "https:"/);
  assert.match(source, /provider: "generic", url: feedUrl/);
  assert.match(source, /\.checkForUpdates\(\)/);
  assert.match(source, /attachUpdateReadiness\(/);
  assert.match(source, /scheduleUpdateChecks\(\{ check: \(\) => checkForMiaUpdate\(\) \}\)/);
  assert.match(source, /label: "Check for Updates…"/);
});

test("OTA updates run in packaged builds on macOS and Windows only", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /if \(!app\.isPackaged \|\| !\["darwin", "win32"\]\.includes\(process\.platform\)\) return false/);
  assert.match(source, /enabled: \["darwin", "win32"\]\.includes\(process\.platform\)/);
  assert.doesNotMatch(source, /enabled: process\.platform === "darwin"/);
});

test("packaged desktop disables developer menus and backend output capture", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /if \(!app\.isPackaged\) viewItems\.unshift\(\{ role: "toggleDevTools" \}\)/);
  assert.match(source, /if \(!app\.isPackaged\) template\.splice\(5, 0, createDevelopmentMenu\(\)\)/);
  assert.match(source, /stdio: app\.isPackaged \? "ignore"/);
});

test("Development server actions share one in-flight operation", async () => {
  const main = loadMain();
  let releaseStart;
  let startCalls = 0;
  let restartCalls = 0;
  const startPromise = new Promise(resolve => { releaseStart = resolve; });
  const menu = main.createDevelopmentMenu({
    startServer: () => {
      startCalls += 1;
      return startPromise;
    },
    restartServer: () => {
      restartCalls += 1;
      return Promise.resolve();
    },
  });
  const start = menu.submenu.find(item => item.label === "Start server");
  const restart = menu.submenu.find(item => item.label === "Restart server");

  const first = start.click();
  const duplicate = restart.click();
  assert.equal(duplicate, first);
  assert.equal(startCalls, 1);
  assert.equal(restartCalls, 0);

  releaseStart("http://127.0.0.1:4871");
  await first;
  await Promise.resolve();
  await restart.click();
  assert.equal(restartCalls, 1);
});

test("restart uses the renderer's exact managed port and waits for healthy replacement", async () => {
  const main = loadMain();
  const managedProcess = {};
  const order = [];
  let reportHealthy;
  const healthy = new Promise(resolve => { reportHealthy = resolve; });
  let completed = false;

  const restarting = main.restartManagedBackend({
    managedProcess,
    managedUrl: "http://127.0.0.1:4871",
    rendererUrl: "http://localhost:4871",
    stop: async processToStop => {
      assert.equal(processToStop, managedProcess);
      order.push("stop:managed");
      return true;
    },
    start: async port => {
      order.push(`start:${port}`);
      return healthy;
    },
    reload: async url => order.push(`reload:${url}`),
  }).then(url => {
    completed = true;
    return url;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["stop:managed", "start:4871"]);
  assert.equal(completed, false);
  reportHealthy("http://127.0.0.1:4871");

  assert.equal(await restarting, "http://127.0.0.1:4871");
  assert.deepEqual(order, [
    "stop:managed",
    "start:4871",
    "reload:http://127.0.0.1:4871",
  ]);
});

test("restart refuses a stale or wrong managed process", async () => {
  const main = loadMain();
  let stopCalls = 0;
  let startCalls = 0;

  await assert.rejects(main.restartManagedBackend({
    managedProcess: {},
    managedUrl: "http://127.0.0.1:4872",
    rendererUrl: "http://127.0.0.1:4871",
    stop: async () => { stopCalls += 1; return true; },
    start: async () => { startCalls += 1; return "http://127.0.0.1:4871"; },
  }), /does not match this Mia window/);
  assert.equal(stopCalls, 0);
  assert.equal(startCalls, 0);
});

async function listeningLoopbackServer() {
  const net = require("node:net");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

test("production Clerk startup fails on its occupied stable port without falling back", async (t) => {
  const main = loadMain();
  const occupied = await listeningLoopbackServer();
  t.after(() => occupied.close());
  const port = occupied.address().port;

  await assert.rejects(
    main.selectLocalBackendPort(null, { production: true, preferredPort: port - 1 }),
    new RegExp(`stable Mia desktop origin http://localhost:${port} is already in use`),
  );
});

test("production Clerk startup uses the default or configured stable port exactly", async () => {
  const main = loadMain();
  const calls = [];
  const findPort = async (port, options) => {
    calls.push({ port, options });
    return port;
  };

  assert.equal(await main.selectLocalBackendPort(null, {
    production: true, preferredPort: 4870, findPort,
  }), 4871);
  assert.equal(await main.selectLocalBackendPort(null, {
    production: true, preferredPort: 5900, findPort,
  }), 5901);
  assert.deepEqual(calls, [
    { port: 4871, options: { allowFallback: false } },
    { port: 5901, options: { allowFallback: false } },
  ]);
});

test("development startup retains free-port fallback", async (t) => {
  const main = loadMain();
  const occupied = await listeningLoopbackServer();
  t.after(() => occupied.close());
  const port = occupied.address().port;

  const selected = await main.selectLocalBackendPort(null, { production: false, preferredPort: port - 1 });
  assert.ok(selected > port, `expected a fallback after occupied port ${port}, received ${selected}`);
});

test("a configured managed-backend port remains exact in every environment", async (t) => {
  const main = loadMain();
  const reservation = await listeningLoopbackServer();
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  assert.equal(await main.selectLocalBackendPort(port, { production: false }), port);

  const occupied = await listeningLoopbackServer();
  t.after(() => occupied.close());
  const occupiedPort = occupied.address().port;
  await assert.rejects(
    main.selectLocalBackendPort(occupiedPort, { production: false }),
    new RegExp(`cannot restart its managed backend because http://localhost:${occupiedPort} is already in use`),
  );
});

test("UI refresh raises the renderer loading gate before reloading", async () => {
  const main = loadMain();
  const order = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async (script) => {
        assert.match(script, /appLoadingOverlay/);
        order.push("loading-gate");
      },
      reloadIgnoringCache: () => { order.push("reload"); },
    },
  };

  assert.equal(await main.developmentRefreshUi(window), true);
  assert.deepEqual(order, ["loading-gate", "reload"]);
});

test("service controls stay detached and UI refresh bypasses the renderer cache", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const frontend = fs.readFileSync(path.join(__dirname, "../../frontend/index.html"), "utf8");
  assert.match(source, /spawnRuntimeCommand\(configuredHermesBinary\(\), \["gateway", action\]/);
  assert.match(source, /detached: true/);
  assert.match(source, /window\.webContents\.reloadIgnoringCache\(\)/);
  assert.match(frontend, /id="appLoadingOverlay"[\s\S]*<span>Loading<\/span>/);
  assert.match(source, /tail -n 100 -f/);
});

test("localhost frontend stays inside the native desktop host", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /preload: path\.join\(__dirname, "preload\.cjs"\)/);
  assert.match(source, /const url = `http:\/\/localhost:\$\{port\}`/);
  assert.match(source, /explicitlyConfiguredUrl[\s\S]*CLERK_CONFIG\.environment === "production" \? null : `http:\/\/localhost:\$\{PREFERRED_PORT\}`/);
  assert.match(source, /explicitlyConfiguredUrl\s*\? normalizeBaseUrl\(explicitlyConfiguredUrl\)/);
  assert.doesNotMatch(source, /process\.env\.MIAOS_URL \|\| `http:\/\/localhost:\$\{PREFERRED_PORT\}`/);
  assert.match(source, /mainWindow\.loadURL\(`\$\{resolvedBackend\}\/\#\/chat`\)/);
  assert.match(source, /createBrowser\(\s*window/);
});

test("cold startup stays hidden until the renderer can display its loading gate", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const fallbackSource = fs.readFileSync(path.join(__dirname, "renderer", "index.html"), "utf8");

  assert.match(mainSource, /new BrowserWindow\(\{[\s\S]*?show:\s*false,/);
  assert.match(mainSource, /ipcMain\.on\("miaos-renderer-ready"/);
  assert.match(mainSource, /ipcMain\.on\("miaos-renderer-hydrated"/);
  assert.match(mainSource, /developmentRefreshUi[\s\S]*executeJavaScript[\s\S]*appLoadingOverlay[\s\S]*reloadIgnoringCache/);
  assert.match(preloadSource, /ready:\s*\(\)\s*=>\s*ipcRenderer\.send\("miaos-renderer-ready"\)/);
  assert.match(preloadSource, /hydrated:\s*\(\)\s*=>\s*ipcRenderer\.send\("miaos-renderer-hydrated"\)/);
  assert.match(fallbackSource, /window\.miaDesktop\.ready\(\)/);
  assert.match(mainSource, /ipcMain\.on\("miaos-state-get"/);
  assert.match(mainSource, /ipcMain\.on\("miaos-state-set"/);
  assert.match(preloadSource, /sendSync\("miaos-state-get", key\)/);
  assert.match(preloadSource, /send\("miaos-state-set", key, value\)/);
});

test("native chat artifact previews use the sandboxed Mia artifact pane", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");

  assert.match(preloadSource, /artifact:\s*\{[\s\S]*ipcRenderer\.invoke\("miaos-artifact-open", url\)/);
  assert.match(mainSource, /ipcMain\.handle\("miaos-artifact-open"/);
  assert.match(mainSource, /isNativeArtifactTarget\(target\)/);
  assert.match(mainSource, /Only Mia conversation artifact previews can open here/);
  assert.match(mainSource, /syncArtifactSessionCookies\(target\)/);
  assert.match(mainSource, /ARTIFACT_PARTITION = "miaos-artifacts"/);
  assert.doesNotMatch(mainSource, /persist:miaos-artifacts/);
  assert.match(mainSource, /partition: ARTIFACT_PARTITION,[\s\S]*contextIsolation: true,[\s\S]*nodeIntegration: false,[\s\S]*sandbox: true/);
});

test("general browser uses a persistent isolated profile with user-facing and clean-slate resets", () => {
  const browserSource = fs.readFileSync(path.join(__dirname, "browser.cjs"), "utf8");
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(browserSource, /BROWSER_PARTITION = "persist:mia-browser"/);
  assert.match(browserSource, /session\.fromPartition\(BROWSER_PARTITION/);
  assert.match(browserSource, /async function clearData\(\)/);
  assert.match(mainSource, /label: "Clear Browser Data"/);
  assert.match(mainSource, /session\.fromPartition\(BROWSER_PARTITION\)/);
});

test("artifact preview parsing is exact, origin-bound, and never accepts file or arbitrary URLs", () => {
  const main = loadMain();
  const backend = "http://127.0.0.1:4870";
  const native = `${backend}/api/conversations/conversation-1/attachments/attachment-1?preview=true&workspace=solo`;

  assert.equal(main.isNativeArtifactTarget(native, backend), true);
  assert.equal(main.normalizeArtifactTarget(native, backend), native);
  for (const blocked of [
    "file:///tmp/report.pdf",
    "https://attacker.example/report.pdf",
    `${backend}/api/conversations/conversation-1/attachments/attachment-1`,
    `${backend}/api/conversations/conversation-1/attachments/attachment-1?preview=1&workspace=solo`,
    `${backend}/api/conversations/conversation-1/attachments/attachment-1?preview=true&next=https%3A%2F%2Fattacker.example`,
    `${backend}/api/conversations/conversation-1/attachments/attachment-1?preview=true#external`,
  ]) {
    assert.equal(main.isNativeArtifactTarget(blocked, backend), false, blocked);
    assert.throws(() => main.normalizeArtifactTarget(blocked, backend), /Only exact Mia conversation attachment preview URLs/);
  }
});

test("artifact preview controls cannot turn the pane into a general browser", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const toolbar = fs.readFileSync(path.join(__dirname, "renderer", "artifact-toolbar.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "artifact-preload.cjs"), "utf8");

  assert.match(mainSource, /will-redirect/);
  assert.match(mainSource, /External links open in your normal browser/);
  assert.match(mainSource, /shell\.openExternal/);
  assert.doesNotMatch(mainSource, /miaos-artifact-navigate/);
  assert.match(toolbar, /readonly/);
  assert.match(toolbar, /Mia attachment preview URL/);
  assert.doesNotMatch(preload, /navigate/);
});

test("UI refresh never adds a temporary native compositor layer", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = mainSource.indexOf("async function developmentRefreshUi");
  const end = mainSource.indexOf("\nasync function resolveBackend", start);
  const refresh = mainSource.slice(start, end);
  assert.doesNotMatch(refresh, /new LoadingView|new WebContentsView|addChildView|removeChildView/);
});

test("service retry preserves an already-loaded renderer while restarting its backend", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

  assert.match(
    mainSource,
    /ipcMain\.handle\("miaos-retry-connection"[\s\S]*?rendererBackendUrl\(mainWindow\)[\s\S]*?resolveBackend\(\)[\s\S]*?return loadMiaOS\(\)/,
  );
});

test("development and packaged launches share Electron's single-instance lock", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /if \(!hasSingleInstanceLock\) app\.quit\(\)/);
  assert.match(mainSource, /app\.on\("second-instance"/);
  assert.match(mainSource, /function activateMainWindow\(\)[\s\S]*createWindow\(\)[\s\S]*loadMiaOS\(\)[\s\S]*mainWindow\.focus\(\)/);
  assert.match(mainSource, /app\.on\("second-instance",[\s\S]*receiveAuthCallback\(value\)[\s\S]*activateMainWindow\(\)/);
  assert.match(mainSource, /BrowserWindow\.getAllWindows\(\)\.length === 0\) activateMainWindow\(\)/);
  assert.match(mainSource, /mainWindow\.restore\(\)/);
  assert.match(mainSource, /mainWindow\.focus\(\)/);
  assert.match(mainSource, /if \(hasSingleInstanceLock\) app\.whenReady\(\)/);
});

test("browser menu never falls through to closing or reloading the Mia window", () => {
  const mainSource = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
  const preloadSource = fs.readFileSync(require.resolve("./preload.cjs"), "utf8");

  assert.match(mainSource, /\["l", "t"\]\.includes\(key\)[\s\S]*?webContents\.send\("miaos-browser-open", key\)/);
  assert.doesNotMatch(mainSource, /if \(key === "w"\) mainWindow\.close\(\)/);
  assert.doesNotMatch(mainSource, /if \(key === "r"\) mainWindow\.webContents\.reload\(\)/);
  assert.match(preloadSource, /onOpen:[\s\S]*?ipcRenderer\.on\("miaos-browser-open"/);
});

test("closing a window explicitly releases both artifact renderer views", () => {
  const main = loadMain();
  const removed = [];
  const window = {
    isDestroyed: () => false,
    contentView: { removeChildView: view => removed.push(view) },
  };
  const view = () => ({
    webContents: {
      closed: false,
      isDestroyed() { return this.closed; },
      close() { this.closed = true; },
    },
  });
  const toolbar = view();
  const content = view();

  main.disposeArtifactPanel(window, toolbar, content);
  main.disposeArtifactPanel(window, toolbar, content);

  assert.deepEqual(removed, [toolbar, content, toolbar, content]);
  assert.equal(toolbar.webContents.closed, true);
  assert.equal(content.webContents.closed, true);
});

test("desktop state permits only scoped chat selection and browser-open state", () => {
  const source = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
  assert.match(source, /normalized === "miaBrowserOpen"/);
  assert.match(source, /\^miaChatActive:/);
  assert.match(source, /windowNativeBrowser\.prepareToClose\(\)/);
  assert.match(source, /new Promise\(resolve => setTimeout\(resolve, 1000\)\)/);
});

test("prepared window close resumes a macOS application quit", () => {
  const source = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
  assert.match(source, /closePrepared = true;[\s\S]*window\.close\(\);[\s\S]*if \(isQuitting\) setImmediate\(\(\) => app\.quit\(\)\)/);
});

test("closing the final desktop window quits the owned runtime on macOS", () => {
  const source = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
  assert.match(source, /app\.on\("window-all-closed", \(\) => \{\s*(?:\/\/[^^\n]*\n\s*)*app\.quit\(\);\s*\}\)/);
  assert.doesNotMatch(source, /window-all-closed[\s\S]{0,120}process\.platform !== "darwin"/);
});

test("startup reclaims only a profile-owned orphaned backend before spawning", () => {
  const source = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
  assert.match(source, /BACKEND_LEASE_FILENAME = "miaos-backend-owner\.json"/);
  assert.match(source, /lease\.databasePath !== backendDatabasePath\(\)/);
  assert.match(source, /process\.kill\(-lease\.pid, "SIGTERM"\)/);
  assert.match(source, /const reclaimed = await reclaimOrphanedBackend\(\)/);
  assert.match(source, /backend launch blocked because the profile-owned orphan could not be reclaimed/);
  assert.match(source, /writeBackendLease\(child\.pid, url, databasePath\)/);
  assert.match(source, /clearBackendLease\(child\.pid\)/);
});

test("packaged app discovers bundled runtime and uses Electron's Node", () => {
  const source = fs.readFileSync(require.resolve("./main.cjs"), "utf8");
  assert.match(source, /if \(process\.resourcesPath\) candidates\.push\(process\.resourcesPath\)/);
  assert.match(source, /const nodeExecutable = String\(process\.env\.MIAOS_NODE_PATH/);
  assert.doesNotMatch(source, /\/opt\/homebrew\/bin\/node|\/usr\/local\/bin\/node|\/usr\/bin\/node/);
  assert.match(source, /if \(nodeExecutable === process\.execPath\) childEnvironment\.ELECTRON_RUN_AS_NODE = "1"/);
  assert.match(source, /MIAOS_LOCAL_PROFILE: process\.env\.MIAOS_LOCAL_PROFILE \|\| "1"/);
  assert.match(source, /app\.isPackaged \? path\.join\(dataDirectory, "\.env\.local"\)/);
  assert.match(source, /app\.isPackaged \? path\.join\(dataDirectory, "workspace-artifacts"\)/);
  assert.match(source, /app\.isPackaged \? path\.join\(dataDirectory, "conversation-attachments"\)/);
  assert.match(source, /app\.isPackaged[\s\S]*path\.join\(process\.resourcesPath, "electron\.icns"\)/);
  assert.match(source, /process\.platform === "darwin" && !app\.isPackaged && app\.dock/);
});
