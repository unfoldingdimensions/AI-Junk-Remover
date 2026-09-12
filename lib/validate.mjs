// Delete/open path validation. Shared by the server and the sandbox test.

import fs from 'node:fs';
import path from 'node:path';
import { allRoots } from './registry.mjs';
import { walkSize, isUnder } from './scanner.mjs';
import { isProtectedName, isNeverName } from './rules.mjs';

export function findRootFor(targetPath, extraRoots = []) {
  for (const r of [...allRoots(), ...extraRoots]) {
    if (path.resolve(targetPath).toLowerCase() === path.resolve(r.path).toLowerCase()) {
      return { root: r, isRootItself: true };
    }
    if (isUnder(targetPath, r.path)) return { root: r, isRootItself: false };
  }
  return null;
}

// A delete target must live under a known tool root, must not itself be a
// protected name, and (for dirs) must contain no protected files anywhere.
export async function validateDeleteTarget(p, extraRoots = []) {
  const resolved = path.resolve(p);
  const hit = findRootFor(resolved, extraRoots);
  if (!hit) return { ok: false, reason: 'outside known AI tool locations' };
  const root = hit.root;
  if (hit.isRootItself && root.junkRoot !== 'safe') {
    return { ok: false, reason: 'refusing to delete an entire tool root' };
  }
  if (root.protect) return { ok: false, reason: 'root is protected' };
  const name = path.basename(resolved);
  let isDir = false;
  try { isDir = fs.lstatSync(resolved).isDirectory(); }
  catch (e) {
    // Distinguish "already gone" (routine for junk that churns between scan
    // and delete) from inaccessible/broken paths, which stay hard refusals.
    if (e.code === 'ENOENT') return { ok: false, reason: 'not found' };
    return { ok: false, reason: `not accessible (${e.code})` };
  }
  if (isNeverName(name, isDir)) return { ok: false, reason: `protected name: ${name}` };
  // refuse anything nested inside a protected directory (e.g. skills/foo/cache)
  const rel = path.relative(path.resolve(root.path), resolved);
  const ancestors = rel.split(path.sep).slice(0, -1);
  if (ancestors.some((s) => isProtectedName(s, true))) {
    return { ok: false, reason: 'inside a protected directory' };
  }
  if (isDir) {
    const sub = await walkSize(resolved);
    if (sub.hasProtected) return { ok: false, reason: 'contains protected files' };
  }
  return { ok: true, root };
}

export function validateOpenTarget(p) {
  const resolved = path.resolve(p);
  return findRootFor(resolved) !== null && fs.existsSync(resolved);
}
