# Runtime secret helper preflight

Read-only review of root's uncommitted candidate atop
`bf059f63195921a476e704cf2dc31cafb2b405a9`. This is candidate evidence,
not integrated or actual provider/UI acceptance.

Reviewed file SHA-256 values:

- `backend/hermes-runtime-secret-source.js`:
  `aaadb6dacc53c728259e639bd0fc0d1a4c7cd27ea22440176596c184d2290f86`
- `backend/browser-work-hermes-profile.js`:
  `c3d214df0e916af9c96929527246b03eb76da2db03ef884fb06df60de1bbcac6`
- `backend/hermes-bot-profile.js`:
  `cd0996f4d49c9d9389400e6cd0fa2f0eff8d644ce821e18a95b66cc1cabcd86e`

The helper is configured only from workstation process environment, not model
or HTTP request input. An absent helper retains `secrets.sources: []`. Configured
paths must be absolute, reject newline/NUL, refer directly to a regular file
without a symlink, belong to the current UID, have owner execute permission,
and lack group/world write permission. The generated YAML contains the quoted
path, not credentials. Worker `platform_toolsets.cli` remains exclusively
`mia_browser_work`; the change does not expand model tools.

Independent execution of the two candidate helper tests PASS. The additional
`secret-helper-evidence.cjs` probe PASS uses the installed locally patched pinned
Hermes runtime's actual YAML parser and `CommandSource.fetch` with a disposable
fake helper. A filename containing quotes and shell substitution remains inert,
the fake KEY=VALUE map is parsed, and fake helper stderr is discarded. No real
helper, credential store, provider key or model was accessed by this lane.

Pinned Hermes command sources run once at startup with empty
`HERMES_SECRET_KEY` and expect a bulk KEY=VALUE map, rather than only a requested
single-key value. The configured helper timeout is three seconds; Hermes
captures its output and emits structured failure diagnostics.

Root must commit the candidate and establish actual provider dispatch from
Mia's bot UI. This preflight cannot resolve the diagnosed `missing_api_key`
failure by itself and does not establish actual worker answers or synthesis.
