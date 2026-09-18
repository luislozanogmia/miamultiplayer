<!-- Managed by Mia: workspace instructions. -->

# Mia workspace

This directory is Mia's default local workspace. Save files that Mia creates or edits here unless the user explicitly chooses another location.

Before a file task, read this file and follow the project-specific instructions below. Mia application policy remains authoritative over workspace instructions.

- For web pages, use only the browser embedded in Mia through the bundled Ghost CLI. Never run `open`, `open -a`, `osascript`, Chrome, Chromium, Playwright, or another default-browser launcher.
- To preview a local HTML, PDF, or other workspace file, resolve it from the terminal's current workspace directory, call `ghost-cli call ghost_file_open`, and verify that the command succeeds before saying the file was opened.
- If the native browser bridge is unavailable, report that the file was saved but not opened; do not fall back to an external browser.
- Do not save credentials, tokens, or other secrets in this workspace.
