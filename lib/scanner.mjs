// Filesystem scanner: per-tool folder sizes + itemized junk with subtree sizes.
// Never follows symlinks or junctions: Node reports Windows junctions
// (lstat and Dirent alike) as symlinks, so both are skipped by isSymbolicLink().
// Uses \\?\ prefixes for long Windows paths.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { classify, isProtectedName, isNeverName } from './rules.mjs';

const LP_CUTOFF = 240;
const lp = (p) => (p.length >= LP_CUTOFF && !p.startsWith('\\\\?\\') ? '\\\\?\\' + p : p);

function isUnder(child, ancestor) {
  const c = path.resolve(child).toLowerCase();
  const a = path.resolve(ancestor).toLowerCase();
  return c === a || c.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

// Iterative size walk of a subtree. Also flags protected names anywhere inside.
export async function walkSize(rootPath, excludePaths = []) {
  let size = 0;
  let maxMtime = 0;
  let hasProtected = false;
  const stack = [rootPath];
  while (stack.length > 0) {
    const dirPath = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(lp(dirPath), { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions/locked) — contributes 0
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dirPath, ent.name);
      if (excludePaths.some((x) => isUnder(full, x))) continue;
      if (ent.isDirectory()) {
        if (isProtectedName(ent.name, true)) hasProtected = true;
        stack.push(full);
      } else if (ent.isFile()) {
        if (isProtectedName(ent.name, false)) hasProtected = true;
        try {
          const st = await fsp.lstat(lp(full));
          size += st.size;
          const m = st.mtimeMs;
          if (m > maxMtime) maxMtime = m;
        } catch { /* vanished mid-walk */ }
      }
    }
  }
  return { size, maxMtime, hasProtected };
}

// Classification walk of a tool root. Junk matches stop recursion (their whole
// subtree is one deletable item); unmatched dirs are descended into.
async function scanDir(dirPath, root, items, excludePaths) {
  let entries;
  try {
    entries = await fsp.readdir(lp(dirPath), { withFileTypes: true });
  } catch (e) {
    return { size: 0, maxMtime: 0, error: e.code };
  }
  let size = 0;
  let maxMtime = 0;
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const full = path.join(dirPath, ent.name);
    if (excludePaths.some((x) => isUnder(full, x))) continue;
    if (ent.isDirectory()) {
      const cls = classify(ent.name, true);
      if (cls && cls.tier === 'never') {
        // protected dir (skills, agents, memories, …): surface it as a locked
        // item and never descend — nothing beneath it may be classified junk
        const sub = await walkSize(full, excludePaths);
        items.push({
          path: full, name: ent.name, size: sub.size, mtime: sub.maxMtime,
          tier: 'locked', reason: cls.reason,
        });
        size += sub.size;
        if (sub.maxMtime > maxMtime) maxMtime = sub.maxMtime;
      } else if (cls) {
        const sub = await walkSize(full, excludePaths);
        const blocked = sub.hasProtected;
        items.push({
          path: full,
          name: ent.name,
          size: sub.size,
          mtime: sub.maxMtime,
          tier: blocked ? 'blocked' : cls.tier,
          reason: blocked ? 'contains protected files' : cls.reason,
        });
        size += sub.size;
        if (sub.maxMtime > maxMtime) maxMtime = sub.maxMtime;
      } else {
        const sub = await scanDir(full, root, items, excludePaths);
        size += sub.size;
        if (sub.maxMtime > maxMtime) maxMtime = sub.maxMtime;
      }
    } else if (ent.isFile()) {
      let st = { size: 0, mtimeMs: 0 };
      try { st = await fsp.lstat(lp(full)); } catch { continue; }
      size += st.size;
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      const cls = classify(ent.name, false);
      if (cls) {
        items.push({
          path: full, name: ent.name, size: st.size, mtime: st.mtimeMs,
          tier: cls.tier === 'never' ? 'locked' : cls.tier, reason: cls.reason,
        });
      }
    }
  }
  return { size, maxMtime };
}

export async function scanRoot(root) {
  const excludePaths = (root.exclude || []).map((n) => path.join(root.path, n));
  try {
    const st = await fsp.lstat(lp(root.path));
    if (root.kind === 'file' || st.isFile()) {
      const cls = classify(root.path.split(path.sep).pop(), false);
      const locked = root.protect || (cls && cls.tier === 'never');
      return {
        root,
        exists: true,
        size: st.size,
        items: [{
          path: root.path, name: root.path.split(path.sep).pop(),
          size: st.size, mtime: st.mtimeMs,
          tier: 'locked', reason: locked ? (root.label || 'protected') : 'file',
        }],
      };
    }
    // A root explicitly marked as a pure cache is ONE deletable item. Itemizing
    // inside it as well would double-count its bytes (the whole-root item plus
    // each child), and — worse — the whole-root item would bypass the
    // protected-file check that scanDir applies to nested caches, so a cache
    // containing e.g. settings.json would be offered as Safe and delete-all'd.
    if (root.junkRoot === 'safe') {
      const sub = await walkSize(root.path, excludePaths);
      const items = [];
      if (sub.size > 0) {
        items.push({
          path: root.path,
          name: root.path.split(path.sep).pop(),
          size: sub.size,
          mtime: sub.maxMtime,
          tier: sub.hasProtected ? 'blocked' : 'safe',
          reason: sub.hasProtected ? 'contains protected files' : (root.label || 'updater cache'),
        });
      }
      return { root, exists: true, size: sub.size, items };
    }
    const items = [];
    const { size, maxMtime } = await scanDir(root.path, root, items, excludePaths);
    return { root, exists: true, size, items };
  } catch {
    return { root, exists: false, size: 0, items: [] };
  }
}

export async function scanTool(tool, onProgress) {
  const rootsDone = [];
  const items = [];
  const rootResults = [];
  // roots in parallel (4 at a time) for speed on multi-root tools
  const queue = [...tool.roots];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const root = queue.shift();
      const res = await scanRoot(root);
      rootResults.push(res);
      rootsDone.push(root.path);
      if (onProgress) onProgress({ root: root.path, done: rootsDone.length, total: tool.roots.length });
    }
  });
  await Promise.all(workers);

  const merged = { ...tool, roots: [], items: [] };
  let totalSize = 0;
  for (const rr of rootResults) {
    merged.roots.push({
      path: rr.root.path,
      label: rr.root.label || rr.root.path,
      exists: rr.exists,
      size: rr.size,
      junkRoot: rr.root.junkRoot || null,
      protect: !!rr.root.protect,
    });
    totalSize += rr.size;
    merged.items.push(...rr.items);
  }

  // A tool root explicitly marked as pure cache is one big safe item.
  for (const rr of rootResults) {
    if (rr.exists && rr.root.junkRoot === 'safe' && rr.size > 0) {
      const existing = merged.items.find((i) => i.path === rr.root.path);
      if (!existing) {
        merged.items.push({
          path: rr.root.path, name: rr.root.path.split(path.sep).pop(),
          size: rr.size, mtime: 0, tier: 'safe',
          reason: rr.root.label || 'updater cache',
        });
      }
    }
  }

  let safeSize = 0, reviewSize = 0, lockedSize = 0;
  for (const it of merged.items) {
    if (it.tier === 'safe') safeSize += it.size;
    else if (it.tier === 'review') reviewSize += it.size;
    else lockedSize += it.size; // blocked + locked are never deletable
  }

  return {
    id: tool.id, name: tool.name, vendor: tool.vendor, type: tool.type,
    found: totalSize > 0,
    totalSize, safeSize, reviewSize, lockedSize,
    junkSize: safeSize + reviewSize,
    roots: merged.roots,
    items: merged.items,
  };
}

// Scans the selected tools (or all), max 3 tools concurrently.
export async function scanTools(tools, onToolDone, onToolStart, onlyIds = null) {
  const results = new Map();
  const list = onlyIds ? tools.filter((t) => onlyIds.includes(t.id)) : tools;
  let done = 0;
  const queue = [...list];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const tool = queue.shift();
      if (onToolStart) onToolStart(tool, list.length - done, list.length);
      const res = await scanTool(tool);
      results.set(tool.id, res);
      done += 1;
      if (onToolDone) onToolDone(res, done, list.length);
    }
  });
  await Promise.all(workers);
  return results;
}

export { isUnder, isNeverName };
