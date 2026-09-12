// Deletion: Recycle Bin via one batched PowerShell (VB FileIO) invocation —
// zero npm dependencies. If the shell call fails, the batch errors out; it is
// never silently escalated to a permanent delete. Every operation is logged.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HISTORY_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'AIJunkRemover');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.jsonl');

// Windows extended-length paths: Node needs the \\?\ prefix beyond MAX_PATH.
// Mirrors the scanner's own long-path handling.
const LP_CUTOFF = 240;
const lp = (p) => (p.length >= LP_CUTOFF && !p.startsWith('\\\\?\\') ? '\\\\?\\' + p : p);

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$paths = Get-Content -LiteralPath $env:AIJR_PAYLOAD -Encoding Unicode -Raw | ConvertFrom-Json
$ok = @(); $failed = @()
foreach ($p in $paths) {
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
    $ok += $p
  } catch {
    $failed += @{ path = $p; error = $_.Exception.Message }
  }
}
@{ ok = $ok; failed = $failed } | ConvertTo-Json -Depth 3 -Compress
`;

function runPowerShellRecycle(paths) {
  return new Promise((resolve, reject) => {
    const payload = path.join(os.tmpdir(), `aijr-payload-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(payload, JSON.stringify(paths), 'utf16le');
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', PS_SCRIPT,
    ], {
      env: { ...process.env, AIJR_PAYLOAD: payload },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('recycle batch timed out (300s)'));
    }, 300_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      fs.rm(payload, { force: true }, () => {});
      const trimmed = out.trim();
      if (!trimmed) {
        reject(new Error(`recycle batch produced no output${err ? `: ${err.slice(0, 300)}` : ''}`));
        return;
      }
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        reject(new Error(`unparsable recycle output: ${trimmed.slice(0, 300)}`));
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function recyclePaths(paths) {
  if (paths.length === 0) return { ok: [], failed: [] };
  return runPowerShellRecycle(paths);
}

export async function permanentDelete(paths) {
  const ok = [];
  const failed = [];
  for (const p of paths) {
    try {
      await fsp.rm(lp(p), { recursive: true, force: true, maxRetries: 2, retryDelay: 400 });
      ok.push(p);
    } catch (e) {
      failed.push({ path: p, error: e.code === 'EBUSY' || e.code === 'EPERM' ? 'in use — close the tool first' : e.message });
    }
  }
  return { ok, failed };
}

export async function logHistory(entry) {
  try {
    await fsp.mkdir(HISTORY_DIR, { recursive: true });
    await fsp.appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* history is best-effort; never block deletion on it */ }
}

// Cached view of the history file. /api/status polls every ~700 ms and only
// needs the lifetime total; re-reading and re-parsing the whole file each time
// would grow with the log. Cache by (size, mtime) and re-parse only on change.
const HISTORY_ENTRY_CAP = 500;
let historyCache = { size: -1, mtimeMs: -1, entries: [], lifetimeBytes: 0 };

export async function readHistory(limit = 200) {
  try {
    const st = await fsp.stat(HISTORY_FILE);
    if (st.size === historyCache.size && st.mtimeMs === historyCache.mtimeMs) {
      return { entries: historyCache.entries.slice(-limit), lifetimeBytes: historyCache.lifetimeBytes };
    }
    const raw = await fsp.readFile(HISTORY_FILE, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const all = [];
    let lifetimeBytes = 0;
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        all.push(e);
        lifetimeBytes += e.reclaimedBytes || 0;
      } catch { /* skip malformed line */ }
    }
    historyCache = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      entries: all.length > HISTORY_ENTRY_CAP ? all.slice(-HISTORY_ENTRY_CAP) : all,
      lifetimeBytes,
    };
    return { entries: historyCache.entries.slice(-limit), lifetimeBytes };
  } catch {
    return { entries: [], lifetimeBytes: 0 };
  }
}
