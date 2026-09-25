# Mia Multiplayer — Product

## What it is

A desktop OS layer (Electron) that gives users an AI agent (Mia) with chat,
automations, browser control, Google Workspace integration, and bot creation.
Open-source core at github.com/luislozanogmia/miamultiplayer.

## Bot creation in Mia chat — review candidate

Describe a bot in Mia's chat, revise the draft through messages or the review
card, then choose **Create bot**. Drafting and **Not now** do not create a bot.
After submission, **Check creation** recovers the same request if the response
is interrupted; **Open bot chat** retries opening an already-created bot's chat.
Creation cannot be cancelled once submitted. Drafts are local to the current
page and are not a durable draft history.

The visible catalog name is **Bot Marketplace**. This change does not relax
instruction-file approvals or establish per-bot filesystem isolation; that
permissions work remains separate.

## Inference routing

### Current (Beta)

- **Mia Router** = OpenRouter as the backend. We provision a per-user OpenRouter
  API key via Lambda, restrict the model picker to DeepSeek V4.1 Flash only,
  and brand it as "Mia Router." OpenRouter load-balances across upstream
  providers (Relace, Wafer, etc.).

### Next

- **Direct to DeepSeek.** Drop OpenRouter and route directly to DeepSeek's API
  (`api.deepseek.com`). We handle the routing ourselves. Reasons:
  - Cut out the middleman markup — DeepSeek direct pricing is cheaper.
  - Full control over routing, rate limits, and failover.
  - No dependency on OpenRouter's availability or provider selection.
  - Can negotiate volume pricing directly with DeepSeek.
- Still brand as "Mia Router" in the UI — users don't need to know the backend changed.
- Requires: DeepSeek API key management in Lambda, update Hermes provider from
  `openrouter` to `deepseek`, update model allowlist to DeepSeek's native model IDs.

## Model strategy

- Beta: DeepSeek V4.1 Flash only (cheapest reasoning model, ~$0.15/M in, $0.60/M out).
- Future: add model tiers (free tier = Flash, paid tier = unlocks Claude/GPT).

## Todo — approved, not started

- **Model family picker: provider list on back.** DONE 2026-09-19. The
  back screen lists all five setup providers; connected rows selectable,
  unconnected rows get a Connect pill into the real setup flow. Caveat:
  Claude and Gemini have no CLI-subscription harness today (only
  openai-codex and xai-oauth exist), so their Connect goes through the
  generic API-key card, captioned honestly. Decision (2026-09-19): this
  stays API-key-only — neither Anthropic nor Google permits third-party
  apps like Mia to ride their consumer CLI subscriptions.

## Roadmap — P1 (approved, not started)

- **Hold-to-talk dictation (whisper.cpp, MIT).** Muse-style "hold a key and
  talk" voice input. Engine: whisper.cpp via `nodejs-whisper` (both MIT, as
  are OpenAI's Whisper weights — clean license chain, attribution via a
  NOTICE file only). UX built in-house in Electron (`globalShortcut` +
  hold/release), cross-platform; OpenSuperWhisper (MIT, Swift/macOS-only)
  is UX inspiration, not a dependency. Known cost: bundled models add
  ~100MB+ and need per-platform native builds.

- **Post-alpha: delegate agent-runtime primitives to Hermes.** This is P1
  architectural cleanup after the alpha, not an alpha launch blocker. Mia
  continues to own context engineering, prompt engineering and the multiplayer
  product layer; it should stop maintaining parallel implementations of
  primitives that Hermes now provides. When a required primitive is missing or
  incomplete, prefer fixing or proposing it upstream in Hermes so the wider
  ecosystem benefits instead of creating a permanent Mia-only harness.

  **Delegate to Hermes:**
  - One persistent, resumable Hermes session for each bot-and-conversation
    pairing, including native transcript persistence and recovery across Mia or
    Hermes restarts.
  - Context-window accounting, automatic compaction/compression, summaries,
    compression lineage and context-overflow recovery. Remove Mia's local
    message windows and full-transcript replay during ordinary turns.
  - The reasoning and tool-execution loop, including tool-call state,
    continuation, runtime retries and completion detection. Mia must not grow a
    second agent loop around Hermes.
  - Agent memory, session search and Hermes-native background review where the
    product policy enables them. Do not build a separate Mia memory primitive.
  - Native progress, reasoning, tool and terminal events; interruption; usage
    reporting; and terminal success/failure state. Mia should translate these
    events for its UI rather than infer equivalent state independently.
  - Model/provider selection and per-session runtime configuration, including
    correct behavior when a user changes the selected model.
  - Cron execution, scheduling state and run lifecycle. Mia owns automation
    setup and delivery UX, but does not implement a competing scheduler.
  - Artifact generation and Hermes artifact descriptors. Mia retains the
    security boundary for validating, storing, previewing and authorizing
    access to those artifacts.
  - Hermes-native error and recovery contracts. Mia may convert them into safe,
    useful product messages but should not recreate the underlying recovery
    machinery.
  - Replace Mia's estimated token/output controls with native Hermes limits and
    usage signals when available. Keep only deliberate outer safety boundaries,
    such as a final wall-clock watchdog and the user's Stop control.

  **Keep in Mia:**
  - Bot purpose, identity, persona, task framing and other prompt engineering.
  - Context engineering: deciding which people, bots, room events, permissions,
    connected resources and current product state are relevant to a turn.
  - The canonical multiplayer product record: users, bots, rooms, memberships,
    messages, threads, mentions, routing, presence and shared-browser actors.
  - A thin session adapter mapping a Mia bot-and-conversation pair to its Hermes
    session plus the last synchronized Mia event sequence. Because a bot may
    miss intervening events in a multiplayer room, send only unseen events in
    order before the current instruction; do not replay the whole room.
  - Authentication, authorization, connector ownership, credential isolation,
    tool/profile policy, attachment and artifact validation, and all other
    product security boundaries.
  - Automation authoring, permissions, status and result delivery; durable and
    idempotent dispatch; Stop/restart controls; and presentation of Hermes
    events and results in the Mia UI.

  **No-loss migration gates:**
  - Introduce the persistent-session path behind a reversible switch. Seed an
    existing Mia conversation once, then persist both the Hermes session ID and
    the last synchronized Mia event sequence.
  - If Hermes state is missing or cannot resume, create a replacement session
    from Mia's canonical history and advance the synchronization cursor only
    after Hermes accepts the seed or delta.
  - Prove long-conversation compaction retains the latest instruction and bot
    identity without Mia-managed truncation or ordinary-turn transcript replay.
  - Prove cold start, backend restart, Hermes restart, compression continuation
    and model changes resume the same logical conversation without lost or
    duplicated messages.
  - Prove multiplayer catch-up sends every unseen human/bot event exactly once,
    in sequence, while preserving mention and thread routing semantics.
  - Prove Stop interrupts the matching Hermes session and that stale work cannot
    write a reply after a conversation restart, deletion or user revocation.
  - Prove browser and connected-app tools retain their permission boundaries;
    generated artifacts retain ownership, integrity and preview protections;
    and no credentials enter prompts or transcripts.
  - Prove interactive bot work and scheduled automations retain model choice,
    progress, failure reporting, artifacts and exactly-once result delivery.
  - Keep the current replay path as a temporary recovery fallback until these
    gates pass in integrated tests and dogfooding. Remove it—along with obsolete
    context windows, prompt reconstruction and duplicate runtime controls—only
    after parity is demonstrated.

## Roadmap — P2 (approved, after P1)

- **Sidebar tool pins: icons and logic pass.** Revisit the pinned-tool
  glyphs (e.g. a "your bots" reading for the bot pin instead of the
  create-a-bot robot) and the open/close logic of the tools they trigger,
  so every pin reads clearly and toggles predictably.

## Roadmap — P3 (future, not scheduled)

- **Deprecate and remove Agent Bench.** Agent Bench is a legacy MiaOS surface,
  not part of Mia Multiplayer's product direction. Remove its route, modal,
  department controls and `guessDepartmentsFor` heuristics after confirming
  that bot creation, editing, testing and deletion all have supported homes in
  the chat-native bot flows. Do not invest in preserving Bench-only behavior.
- **MiaOS-era leftovers sweep.** The compact bot editor's DEPARTMENTS picker
  became a read-only WORKPLACES label on 2026-09-20. Audit the skills editor
  and remaining supported surfaces for other MiaOS-only concepts, then remove
  or rename them where they do not belong in Multiplayer.
- **Descriptive, editable conversation titles.** Generate a useful title from
  each conversation's content, let the user rename it, and show that title in
  History so multiple conversations with the same bot remain distinguishable.
- **Website and app bookmarks.** Extend bookmarks beyond conversations so
  users can save and return to websites and apps from Mia.

The remaining P3 items are sourced from a Sept 2026 competitive scan of Meta's
Muse agent and Alexandr Wang's public product commentary.

- **Approval gating for autonomous bots.** Extend the existing
  `agent_permissions` model with an "ask first" tier between denied and
  auto-approved: approvals scoped one-time, per-session, per-task, or
  time-bounded, evaluated at action time for connector and browser-mode
  actions (Muse's "Sentinel" pattern). Hermes auto-approve already covers the
  static grant half; this adds the runtime half.
- **Self-healing harness.** Instead of plain in-app bug reporting: when Mia
  detects a bug (error, failed automation, crash), it asks the user "want me
  to fix this?" On yes, a dedicated fixer account — running a stronger model
  on high reasoning — takes the bug report and fixes it with its own harness,
  then verifies. Turns every user into a contributor without leaving the app.
- **Fine-grained, time-boxed automations.** Beyond the current
  interval/daily/weekly/monthly cadences: narrow ad-hoc watches like "monitor
  X tomorrow between 2-4pm and act when it changes."
- **Credential isolation broker.** Connector secrets stored via Electron
  `safeStorage` (Keychain / DPAPI / libsecret — native on all three
  platforms, not implemented today). Bots reference credentials by name only;
  the backend injects values in-process at call time. Product-izes the repo's
  existing no-secrets contract.
