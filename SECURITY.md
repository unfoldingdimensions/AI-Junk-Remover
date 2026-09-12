# Security Policy

## Scope

AI Tools Junk Remover is a **local, single-user Windows tool**. It runs a web
server on `127.0.0.1` and deletes files on the machine it runs on. Its security
model rests on one assumption: the only person who can reach the server is the
person sitting at the machine.

## Threat model

| Concern | Mitigation |
|---|---|
| Another web page driving the local API (CSRF) | Every `/api` request must pass Host, Origin and Sec-Fetch-Site checks. Mutating routes require `Content-Type: application/json`, which forces a CORS preflight this server never answers. |
| DNS rebinding | The `Host` header must name `127.0.0.1` or `localhost`. |
| Deleting outside the AI tool directories | Delete paths are validated against the registry's known roots; anything else (system paths, `..` tricks) is refused with 403. |
| Deleting protected files | Auth files, credentials, settings, live skills and memories are hard-locked. A cache that contains a protected file anywhere inside is demoted to Locked. |
| Shell injection through a file path | Explorer is opened with `spawn` and an argument array; no shell ever parses a path. |
| Silent permanent deletion | Recycle Bin is the default. Permanent mode requires typing `DELETE`. |
| Network exposure | The server binds `127.0.0.1` only and makes no outbound requests. |

## Out of scope

- A local attacker who can already run code as your user. They can delete your
  files directly; this tool adds no new capability for them.
- Issues that only exist after someone edits the source.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting on this repository
(Security -> Report a vulnerability), or contact the maintainer directly.

Include what you did, what you expected, what actually happened, and the impact
you believe it has. A minimal proof of concept helps a lot.

Expect an acknowledgement within a few days. This is a small project maintained
in spare time, and there is no bug bounty.

## Supported versions

Only the latest commit on `main` is supported.
