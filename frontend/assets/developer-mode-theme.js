/* Restore the saved Developer Mode theme before the first stylesheet paints.
   This file is intentionally self-hosted so the page can run with a strict
   script-src policy and no inline executable JavaScript. */
try {
  if (localStorage.getItem('miaos.developerMode') === 'on') {
    document.documentElement.setAttribute('data-theme', 'developer');
  }
} catch (_developerThemeBootstrapError) {}
