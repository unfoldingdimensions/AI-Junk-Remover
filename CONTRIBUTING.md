# Contributing to AI Tools Junk Remover

Thanks for wanting to help. This is a small, deliberately boring tool: it walks
known folders, classifies what it finds, and deletes some of it. The bar for a
good contribution is simple - does it make the cleanup safer, or the numbers
more honest?

## What we want

- Bug reports with reproduction steps (see Reporting bugs below).
- New AI tool entries in the registry.
- Classification-rule fixes - a cache we miss, or user data we wrongly call junk.
- Accessibility and UI fixes.
- Documentation improvements.

## What we are not looking for

- **New runtime dependencies.** The zero-dependency rule is the whole point: it
  keeps the tool auditable and keeps supply-chain risk out of the one place it
  can actually hurt. `package.json` has no `dependencies` and should stay that way.
- **Build steps.** No bundler, no transpiler, no framework, no `dist/` folder.
  The browser loads `web/index.html` directly.
- **A TypeScript rewrite, or lint/format configs.** Vanilla ES modules and plain
  JavaScript, by design.

## Requirements

- Windows 10 or 11
- Node.js 18 or newer
- git

## Getting set up

```sh
git clone https://github.com/unfoldingdimensions/AI-Junk-Remover.git
cd AI-Junk-Remover
node server.mjs        # or: npm start
npm test               # the sandbox test - see Testing
```

`node server.mjs` starts the server on `http://127.0.0.1:8765`, opens a browser,
and scans automatically. Set `AIJR_NO_OPEN=1` to stop it opening a browser.

## Project layout

| Path | Responsibility |
|---|---|
| `server.mjs` | HTTP server, request guards, API routes, static files |
| `lib/registry.mjs` | The catalog of AI tools and their on-disk locations |
| `lib/rules.mjs` | Name-based classification into Safe / Review / Locked |
| `lib/scanner.mjs` | Folder walks, subtree sizes, per-root scanning |
| `lib/validate.mjs` | Decides whether a path may be deleted or opened |
| `lib/deleter.mjs` | Recycle Bin via PowerShell, permanent delete, history log |
| `web/` | The UI - `index.html`, `style.css`, `app.js`, `favicon.svg` |
| `test/sandbox-test.mjs` | The one automated test |

The rule of thumb: `server.mjs` routes and guards, `lib/` decides. Keep business
logic out of the server.

## Adding an AI tool (the most common contribution)

Edit `lib/registry.mjs` and add an entry to `TOOLS`.

| Field | Meaning |
|---|---|
| `id` | Stable lowercase slug. It appears in URLs (`/api/tool/<id>`), so once it has shipped, do not change it. |
| `name` | Display name. |
| `vendor` | Shown next to the name. Use `'-'` if there genuinely isn't one. |
| `type` | One of `IDE`, `CLI`, `Agent`. Picks the icon in the UI. |
| `processes` | Process names for the tool. **Declared but not consumed anywhere yet** - it is reserved for a future "the tool is running" check. Fill it in correctly anyway. |
| `roots` | The locations to scan. Build them with `dir(...)` or `file(...)`. |

Each root can carry modifiers:

- `label` - human-readable text shown as the item's reason (e.g. `'updater cache'`).
- `junkRoot: 'safe'` - use the `junkRoot(...)` helper. Marks a root that is *pure*
  cache, such as updater leftovers. It becomes exactly one deletable item and the
  scanner will not itemize inside it. Only use this when nothing under the root
  is worth keeping.
- `protect: true` - use the `protectedRoot(...)` helper. The root can never be deleted
  and is shown as Locked.
- `exclude: [names...]` - child names to skip, so two tools sharing a parent do
  not double-count each other. `gemini-cli` and `antigravity` both live under
  `~/.gemini`; that is what this is for.

### Verifying a new entry

Run the server and confirm the tool card appears with a sane total size and that
its itemized junk looks right. If a size looks wrong, suspect an overlapping
root owned by another tool - check whether the path is already covered elsewhere.

## Adding or changing a classification rule

Rules live in `lib/rules.mjs` and match on the file or folder **name**,
case-insensitively. There are three tiers:

| Tier | Meaning | Default |
|---|---|---|
| Safe | caches, logs, crash dumps, telemetry, updater leftovers | pre-checked for deletion |
| Review | session histories, transcripts, plugin caches, archives | shown, unchecked |
| Locked / never | auth, credentials, settings, live skills, memories | never deletable |

The governing principle: **when in doubt, Review - not Safe.** "Safe" is a
promise that the bytes are disposable, and breaking that promise loses someone's
data. Every rule needs a human-readable `reason` string.

You do not need to special-case nested protection: a protected name found
anywhere inside a cache automatically demotes that cache to Blocked (see
`isProtectedName`).

## Safety invariants

These are load-bearing. A change that relaxes any of them needs to say so
explicitly in the PR and explain why.

1. A delete only ever targets a path inside a registered root.
   `validateDeleteTarget` is the single gate; do not bypass it.
2. Protected names are checked at scan time **and** again at delete time.
3. A `junkRoot` root is exactly one item - never itemize inside it.
4. A directory that contains a protected file is never Safe.
5. Recycle Bin is the default; permanent deletion requires a typed `DELETE`.
6. No shell string interpolation for external commands - `spawn` with an
   argument array only. Never build a command line from a path.
7. Every mutating API route is POST, requires `Content-Type: application/json`,
   and passes the loopback origin guard.
8. No outbound network calls. Ever.

## Testing

```sh
npm test        # runs node test/sandbox-test.mjs
```

The test builds a fake tool folder with known byte sizes under `%TEMP%`, asserts
the scanner's exact sizes and tiers, checks that delete validation refuses
paths outside the roots, then recycles a folder through the real PowerShell path
and confirms it reached the Recycle Bin.

Two things to know before you run it:

- It is **Windows-only** and will not work in a Linux or macOS CI container.
- It leaves an entry in your **real Recycle Bin** - that is the proof it worked.
  The temp fixture itself is cleaned up.

New behaviour should come with assertions, especially the nasty cases: a
protected file nested inside a cache, junk nested inside a protected directory,
and paths outside the registered roots.

## Code style

- ES modules (`.mjs`) on the Node side; plain scripts in `web/`.
- No build step, no framework, no transpiler.
- Comments explain *why*, not *what*.
- Prefer a small, obvious implementation over a clever one. This code deletes
  files; readable beats short.

## Submitting a change

- Keep it to one focused change per pull request.
- Commit subject in the imperative mood ("Add Trae updater cache"), with a body
  that explains the why.
- Include evidence: before/after numbers for scanner or classification changes,
  a screenshot for UI changes.
- Say explicitly if your change touches the delete path.

## Reporting bugs

Please include:

- Your Windows version and Node version.
- Which AI tool the issue is about.
- What you expected and what actually happened.
- The relevant item path or scan output.

Security problems do **not** go in a public issue - see [SECURITY.md](SECURITY.md).

## License

This project is licensed under the Apache License 2.0. By contributing, you
agree that your contribution is licensed under the same terms.
