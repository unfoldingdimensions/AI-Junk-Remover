# AI Tools Junk Remover

A zero-dependency, local WebUI for **Windows** that inventories every AI IDE, CLI
and agent on your PC, shows how much space each one uses, itemizes the junk they
leave behind, and deletes it — to the **Recycle Bin** by default.

It knows about Claude Code, Codex, Gemini CLI, Antigravity, ZCode, OpenCode,
Hermes, Pi, Qoder, Cursor, Windsurf, Trae, Zed, Void, Qwen, Aider, Continue,
Copilot, Crush, Ollama, LM Studio, Browser Use and more — **24 tools across 52
known locations**.

Zero npm dependencies. Runs on plain Node.js 18+.

> **Platform: Windows only.** It relies on `%USERPROFILE%`, `%APPDATA%` /
> `%LOCALAPPDATA%`, `explorer.exe` and a PowerShell Recycle-Bin call. macOS and
> Linux are not supported.

## Run

Double-click `start.bat` (or `node server.mjs`). The UI opens at
`http://127.0.0.1:8765` and a scan starts automatically.

## What it does

- **Auto-scan** of 20+ AI tools across `%USERPROFILE%`, `%APPDATA%`, `%LOCALAPPDATA%`.
- **Per-tool sizes**: total folder footprint vs. junk found.
- **Itemized junk**: every cache, log, crash dump, updater leftover and session
  transcript with its own size, path, and classification.
- **Open in Explorer** per item (selects the file/folder).
- **Delete All Junk** (safe tier) or delete per tool / per selection.
- **Cleanup history**: every deletion is logged to
  `%LOCALAPPDATA%\AIJunkRemover\history.jsonl`, with a lifetime "reclaimed" total.

## Safety model

Junk falls into three tiers:

| Tier | Meaning | Default |
|---|---|---|
| **Safe** | caches, logs, crash dumps, telemetry, updater leftovers | pre-checked |
| **Review** | session histories/transcripts, plugin caches, archives | unchecked — your call |
| **Locked** | auth files, settings, configs, live skills, memories | never deletable |

Additional guards:

- The delete API only accepts paths **inside known AI tool roots** — anything else
  (`C:\Windows\…`, `..` tricks) is refused with 403.
- A cache folder that **contains protected files** anywhere inside is demoted to
  Locked automatically.
- Recycle-bin deletion is the default; **permanent** mode requires typing `DELETE`.
- Files in use by a running tool are skipped and reported, not force-deleted.
- The server binds `127.0.0.1` only.

## Why no AI?

Classifying and deleting files is a deterministic job: known vendors publish known
paths, and junk has known names (`Cache`, `Crashpad`, `logs_*.sqlite`). Rules are
instant, offline, free, and auditable — an LLM deciding what to delete would add
hallucination risk to the one place it can't be tolerated. (An optional
"explain this folder" helper could be added later; it stays out of the delete path.)

## Adding a tool

Edit `lib/registry.mjs` — add an entry with its roots; classification rules in
`lib/rules.mjs` apply automatically. `junkRoot: 'safe'` marks a root that is pure
cache (e.g. updater leftovers); `protect: true` marks one that must never be deleted.

## Verify

`node test/sandbox-test.mjs` builds a fake tool folder with known junk in `%TEMP%`,
checks scanner sizes and classification, recycles an item through the real
PowerShell path, and confirms it landed in the Recycle Bin.

The test suite is **Windows-only** and will recycle a temporary fixture folder on
your machine (it appears in your Recycle Bin as evidence, and the fixture itself is
cleaned up). It is not meant to run in a Linux/macOS CI container.

## Requirements

- Windows 10 or 11
- Node.js 18 or newer

## Disclaimer

This tool **deletes files**. Deletion to the Recycle Bin is recoverable; permanent
deletion is not. It refuses paths outside its known AI-tool locations and never
touches protected files, but **you remain responsible for what you delete**. The
software is provided "as is", without warranty of any kind.

This project is not affiliated with, endorsed by, or sponsored by any of the
vendors whose products it knows about — Anthropic, OpenAI, Google, GitHub,
Anysphere (Cursor), Codeium, ByteDance, Alibaba, Charm, Ollama, LM Studio and
others. Product names are used only to identify the software they belong to.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE).
