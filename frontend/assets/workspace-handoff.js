/* A workspace switch reloads the page. When the page that switched left a
   fresh handoff, paint the app shell from the first frame instead of the
   loading screen and sign-in wall; app.js finishes the switch in the
   background. Self-hosted for the same strict script-src policy as
   developer-mode-theme.js. */
try {
  var miaWorkspaceHandoff = JSON.parse(sessionStorage.getItem('miaWorkspaceHandoff') || 'null');
  if (miaWorkspaceHandoff && Date.now() - Number(miaWorkspaceHandoff.at || 0) < 30000) {
    document.documentElement.classList.add('workspace-handoff');
  }
} catch (_workspaceHandoffBootstrapError) {}
