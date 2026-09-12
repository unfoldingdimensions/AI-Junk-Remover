// Local WebUI server. Binds 127.0.0.1 only. Zero npm dependencies.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { TOOLS } from './lib/registry.mjs';
import { scanTools } from './lib/scanner.mjs';
import { findRootFor, validateDeleteTarget, validateOpenTarget } from './lib/validate.mjs';
import { recyclePaths, permanentDelete, logHistory, readHistory } from './lib/deleter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');
const HOST = '127.0.0.1';

const state = {
  scanning: false,
  progress: { currentTool: null, toolsDone: 0, toolsTotal: 0 },
  results: new Map(),
  lastScanAt: null,
  lastScanMs: null,
  startedAt: null,
};

// ---------- helpers ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFile(res, filePath, type) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function totals() {
  let footprint = 0, safe = 0, review = 0;
  let found = 0, safeCount = 0;
  for (const t of state.results.values()) {
    footprint += t.totalSize;
    safe += t.safeSize;
    review += t.reviewSize;
    safeCount += t.items.filter((i) => i.tier === 'safe').length;
    if (t.found) found += 1;
  }
  return { footprint, safe, review, junk: safe + review, found, safeCount };
}

function toolSummaries() {
  return [...state.results.values()]
    .sort((a, b) => b.junkSize - a.junkSize || b.totalSize - a.totalSize)
    .map((t) => ({
      id: t.id, name: t.name, vendor: t.vendor, type: t.type, found: t.found,
      totalSize: t.totalSize, safeSize: t.safeSize, reviewSize: t.reviewSize,
      lockedSize: t.lockedSize, junkSize: t.junkSize,
      itemCount: t.items.length,
    }));
}

function startScan(onlyIds = null) {
  if (state.scanning) return false;
  state.scanning = true;
  state.startedAt = Date.now();
  state.progress = { currentTool: null, toolsDone: 0, toolsTotal: onlyIds ? onlyIds.length : TOOLS.length };
  // Invalidate cached results for the tools being (re)scanned so /api/status
  // and /api/tool/:id never serve stale pre-rescan data (e.g. items that were
  // just deleted would otherwise reappear in the UI until the rescan ended).
  if (onlyIds) for (const id of onlyIds) state.results.delete(id);
  else state.results.clear();
  scanTools(
    TOOLS,
    (res, done, total) => {
      state.results.set(res.id, res);
      state.progress = { currentTool: null, toolsDone: done, toolsTotal: total };
    },
    (tool, remaining, total) => {
      state.progress = { currentTool: tool.name, toolsDone: total - remaining, toolsTotal: total };
    },
    onlyIds,
  ).then(() => {
    state.scanning = false;
    state.lastScanAt = Date.now();
    state.lastScanMs = Date.now() - state.startedAt;
  }).catch((e) => {
    state.scanning = false;
    state.lastScanAt = Date.now();
    state.lastScanMs = Date.now() - state.startedAt;
    console.error('scan failed:', e);
  });
  return true;
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/scan' && req.method === 'GET') {
    const only = url.searchParams.get('tools');
    const onlyIds = only ? only.split(',').filter(Boolean) : null;
    const started = startScan(onlyIds);
    json(res, 200, { started, alreadyScanning: !started });
    return;
  }

  if (route === '/api/status' && req.method === 'GET') {
    const history = await readHistory(50);
    json(res, 200, {
      scanning: state.scanning,
      progress: state.progress,
      lastScanAt: state.lastScanAt,
      lastScanMs: state.lastScanMs,
      totals: totals(),
      tools: toolSummaries(),
      lifetimeReclaimedBytes: history.lifetimeBytes,
    });
    return;
  }

  const toolMatch = route.match(/^\/api\/tool\/([\w-]+)$/);
  if (toolMatch && req.method === 'GET') {
    const t = state.results.get(toolMatch[1]);
    if (!t) { json(res, 404, { error: 'not scanned yet' }); return; }
    json(res, 200, t);
    return;
  }

  if (route === '/api/history' && req.method === 'GET') {
    json(res, 200, await readHistory(200));
    return;
  }

  if (route === '/api/open' && req.method === 'GET') {
    const p = url.searchParams.get('path') || '';
    if (!validateOpenTarget(p)) { json(res, 400, { error: 'path not allowed' }); return; }
    exec(`explorer.exe /select,"${p}"`, () => {});
    json(res, 200, { opened: p });
    return;
  }

  if (route === '/api/delete' && req.method === 'POST') {
    if (state.scanning) { json(res, 409, { error: 'scan in progress' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const paths = Array.isArray(body.paths) ? body.paths : [];
    if (paths.length === 0) { json(res, 400, { error: 'no paths given' }); return; }
    await runDelete(res, paths, body);
    return;
  }

  function collectDeleteAllPaths(excludeSet, includeSet) {
  const paths = [];
  for (const t of state.results.values()) {
    for (const item of t.items) {
      if (item.tier === 'safe' && !excludeSet.has(item.path.toLowerCase())) paths.push(item.path);
      else if (item.tier === 'review' && includeSet.has(item.path)) paths.push(item.path);
    }
  }
  return paths;
}

if (route === '/api/delete-all' && req.method === 'POST') {
    if (state.scanning) { json(res, 409, { error: 'scan in progress' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.map((p) => String(p).toLowerCase()) : []);
    // `include` opts checked Review items into Delete All — same contract as
    // Delete Selected. Membership in the scan results (review tier only) is
    // enforced here, so the client can never smuggle in arbitrary paths.
    const include = new Set(Array.isArray(body.include) ? body.include.map(String) : []);
    const paths = collectDeleteAllPaths(exclude, include);
    if (paths.length === 0) { json(res, 400, { error: 'no safe junk to delete' }); return; }
    await runDelete(res, paths, body);
    return;
  }

  // Read-only listing so the client can drive a chunked Delete All with
  // progress. Same tier/exclude/include rules as /api/delete-all.
  if (route === '/api/delete-all/paths' && req.method === 'POST') {
    if (state.scanning) { json(res, 409, { error: 'scan in progress' }); return; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.map((p) => String(p).toLowerCase()) : []);
    const include = new Set(Array.isArray(body.include) ? body.include.map(String) : []);
    json(res, 200, { paths: collectDeleteAllPaths(exclude, include) });
    return;
  }

  json(res, 404, { error: 'unknown api route' });
}

// Shared delete pipeline: validate → recycle/permanent → history → response.
async function runDelete(res, paths, body) {
  const mode = body.mode === 'permanent' ? 'permanent' : 'recycle';
  if (mode === 'permanent' && body.confirm !== 'DELETE') {
    json(res, 400, { error: 'permanent delete requires confirm: "DELETE"' });
    return;
  }
  const rejections = [];
  const valid = [];
  const seen = new Set();
  const absentPaths = [];
  for (const p of paths) {
    const v = await validateDeleteTarget(p);
    if (!v.ok) {
      // Already gone — junk churns between scan and delete. Nothing to do for
      // this path; it must not veto the rest of the batch.
      if (v.reason === 'not found') { absentPaths.push(p); continue; }
      rejections.push({ path: p, reason: v.reason });
    } else if (!seen.has(p)) { seen.add(p); valid.push(p); }
  }
  if (rejections.length > 0) {
    json(res, 403, { error: 'some paths refused', rejections });
    return;
  }
  if (valid.length === 0) {
    json(res, 200, { ok: [], failed: [], reclaimedBytes: 0, absent: absentPaths.length, affectedTools: toolsForPaths(absentPaths) });
    return;
  }
  let result;
  if (mode === 'recycle') {
    try {
      result = await recyclePaths(valid);
    } catch (e) {
      json(res, 500, { error: `recycle failed: ${e.message}` });
      return;
    }
  } else {
    result = await permanentDelete(valid);
  }
  // reclaimed bytes from the cached scan results
  let reclaimedBytes = 0;
  for (const p of result.ok) {
    for (const t of state.results.values()) {
      const item = t.items.find((i) => i.path.toLowerCase() === p.toLowerCase());
      if (item) reclaimedBytes += item.size;
    }
  }
  await logHistory({
    ts: Date.now(), mode, reclaimedBytes,
    count: result.ok.length,
    failedCount: result.failed.length,
    paths: result.ok,
  });
  // invalidate cached results for affected tools so the UI can rescan them —
  // absent paths too, so the UI drops rows that no longer exist on disk
  const affectedToolIds = new Set([...toolsForPaths(result.ok), ...toolsForPaths(absentPaths)]);
  json(res, 200, {
    ok: result.ok,
    failed: result.failed,
    reclaimedBytes,
    absent: absentPaths.length,
    affectedTools: [...affectedToolIds],
  });
}

function toolsForPaths(paths) {
  const ids = new Set();
  for (const p of paths) {
    const hit = findRootFor(p);
    if (hit) ids.add(hit.root.toolId);
  }
  return [...ids];
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      console.error(e);
      json(res, 500, { error: String(e.message || e) });
    });
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(404); res.end(); return; }
  const type = MIME[path.extname(name)] || 'application/octet-stream';
  sendFile(res, path.join(WEB_DIR, name), type);
});

function listenOn(port) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < 8779) {
      listenOn(port + 1);
    } else {
      console.error('server error:', e.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`AI Tools Junk Remover running at ${url}  (Ctrl+C to stop)`);
    if (process.platform === 'win32' && !process.env.AIJR_NO_OPEN) {
      exec(`start "" "${url}"`, () => {});
    }
    startScan();
  });
}

listenOn(8765);
