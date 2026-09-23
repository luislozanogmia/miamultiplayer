# Security Policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/luislozanogmia/miamultiplayer/security/advisories/new)
or email [security@mia-labs.com](mailto:security@mia-labs.com).
Please don't open a public issue for a vulnerability. Mia has no bug bounty.

A useful report includes:
- What an attacker can do, and how serious you think it is.
- The file and lines involved (e.g. `backend/server.js:120-145`).
- Mia version, macOS version, and steps to reproduce on the latest release.

We'll reply within 7 days.

## Supported versions

We fix only the latest release. Mia updates itself, so staying current is
the fix. If a problem is already fixed in a public commit or release, it
isn't a new report.

## What counts

Mia is a desktop app that runs as you, on your Mac. Anything that already
has your Mac account can read your files, so that's the line we defend.

**In scope: someone outside your Mac account reaching what they shouldn't.**
- Your provider keys, Mia Router key, or sign-in leaking off your Mac
  (logs, crash reports, network requests, the update feed).
- Another app, web page, or network device driving Mia or reading its data
  without your approval (e.g. Mia's local server, the browser, bots).
- Using Mia Router or Mia's sign-in to act as another user, or to spend
  someone else's budget.
- A tampered or unsigned update being installed.
- Mia doing something its own docs say it won't.

**Out of scope: report these as regular issues or pull requests.**
Improvements are still welcome, just not through the private channel.
- Things that need access to your Mac account first (reading files in
  `~/Library/Application Support/Mia`, editing its config).
- Prompt injection on its own. Getting a model to say something odd is
  not a vulnerability unless it leads to one of the in-scope outcomes.
- Bots, skills, or plugins you installed yourself doing what they're
  written to do.
- Settings you turned on that remove a protection.

## Disclosure

We fix first, then publish an advisory. The window is 90 days from your
report or until the fix ships, whichever comes first. We credit reporters in
the release notes unless you ask us not to.

## Safe harbor

We won't take legal action against good-faith research that follows this
policy, avoids other people's data, and gives us time to fix the problem.
