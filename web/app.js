/* AI Tools Junk Remover — vanilla JS, no build step. */

'use strict';

const S = {
  scanning: false,
  deleting: false,
  status: null,
  details: new Map(),   // toolId -> full tool object (items etc.)
  selection: new Map(), // path -> { size, toolId }
  unchecked: new Set(), // paths the user explicitly unchecked — survive rescans
  expanded: new Set(),
  lastTools: [],        // last full tool list — shown dimmed while rescanning
  ageDays: 0,
  tierFilter: { safe: true, review: true, blocked: true }, // 'blocked' covers blocked + locked tiers
  itemSort: 'size-desc',
  toolSort: 'junk',
};

const $ = (sel) => document.querySelector(sel);
const els = {
  junkPill: $('#junkPill'),
  rescan: $('#rescanBtn'),
  deleteAll: $('#deleteAllBtn'),
  sumTools: $('#sumTools'),
  sumFootprint: $('#sumFootprint'),
  sumSafe: $('#sumSafe'),
  sumReview: $('#sumReview'),
  sumLifetime: $('#sumLifetime'),
  ageFilter: $('#ageFilter'),
  toolSort: $('#toolSort'),
  tools: $('#tools'),
  empty: $('#empty'),
  statusText: $('#statusText'),
  modal: $('#confirmModal'),
  modalTitle: $('#modalTitle'),
  modalSummary: $('#modalSummary'),
  modalFailures: $('#modalFailures'),
  permanentConfirm: $('#permanentConfirm'),
  confirmInput: $('#confirmInput'),
  modalCancel: $('#modalCancel'),
  modalConfirm: $('#modalConfirm'),
  deleteBar: $('#deleteBar'),
  deleteBarFill: $('#deleteBarFill'),
  deleteSummary: $('#deleteSummary'),
  dsBody: $('#dsBody'),
  dsClose: $('#dsClose'),
  scanBanner: $('#scanBanner'),
  scanTitle: $('#scanTitle'),
  scanSub: $('#scanSub'),
  scanFill: $('#scanFill'),
  toasts: $('#toasts'),
};

// ---------- utils ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

const TYPE_ICONS = {
  IDE: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M7 6.5h.01"/></svg>',
  CLI: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
  Agent: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.2"/></svg>',
};

const TIER_LABEL = { safe: 'Safe', review: 'Review', blocked: 'Locked', locked: 'Locked' };

// Hidden items are also excluded from selection sizes and every delete flow.
function isFiltered(item) {
  const tierKey = item.tier === 'blocked' || item.tier === 'locked' ? 'blocked' : item.tier;
  if (!S.tierFilter[tierKey]) return true;
  if (item.tier !== 'review' || S.ageDays === 0) return false;
  const cutoff = Date.now() - S.ageDays * 86400_000;
  return item.mtime > cutoff;
}

function sortItems(items) {
  const arr = [...items];
  if (S.itemSort === 'size-desc') arr.sort((a, b) => b.size - a.size);
  else if (S.itemSort === 'size-asc') arr.sort((a, b) => a.size - b.size);
  else if (S.itemSort === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr;
}

// Deletable-visible items of a tool (safe/review, not hidden by tier or age
// filters) and how many of them are currently selected.
function selectionStats(toolId) {
  const d = S.details.get(toolId);
  const items = d ? visibleItems(d).filter((it) => !isFiltered(it) && (it.tier === 'safe' || it.tier === 'review')) : [];
  const selected = items.filter((it) => S.selection.has(it.path));
  return {
    deletable: items,
    selectedCount: selected.length,
    selectedSize: selected.reduce((s, i) => s + i.size, 0),
  };
}

// Safe items start checked so unchecking any row (safe included) reliably
// excludes it. Paths in S.unchecked were explicitly unchecked by the user and
// stay unchecked across rescans.
function autoSelectSafe(tool) {
  for (const it of tool.items) {
    if (it.tier === 'safe' && !isFiltered(it) && !S.selection.has(it.path) && !S.unchecked.has(it.path)) {
      S.selection.set(it.path, { size: it.size });
    }
  }
}

function adoptDetail(id, d) {
  const prev = S.details.get(id);
  if (prev) {
    // Prune bookkeeping for this tool's paths that vanished in the fresh scan
    // (just-deleted rows) — keep everything the user had picked or unchecked.
    const fresh = new Set(d.items.map((it) => it.path));
    for (const it of prev.items) {
      if (!fresh.has(it.path)) {
        S.selection.delete(it.path);
        S.unchecked.delete(it.path);
      }
    }
  }
  autoSelectSafe(d);
  S.details.set(id, d);
  renderTools();
}

// Patches the select-all checkbox and Delete Selected label in place, so row
// checkbox clicks don't need a full list re-render.
function refreshDetailToolbar(toolId) {
  const card = document.querySelector(`.tool-card.open[data-id="${toolId}"]`);
  if (!card || !S.details.has(toolId)) return;
  const { deletable, selectedCount, selectedSize } = selectionStats(toolId);
  const sa = card.querySelector('[data-action="select-all"]');
  if (sa) {
    sa.checked = deletable.length > 0 && selectedCount === deletable.length;
    sa.indeterminate = selectedCount > 0 && selectedCount < deletable.length;
    sa.disabled = deletable.length === 0;
  }
  const note = card.querySelector('.sel-note');
  if (note) note.textContent = `${selectedCount} sel · ${fmtBytes(selectedSize)}`;
  const btn = card.querySelector('[data-action="delete-tool"]');
  if (btn) {
    btn.textContent = 'Delete Selected' + (selectedCount ? ` (${selectedCount} · ${fmtBytes(selectedSize)})` : '');
    btn.disabled = selectedCount === 0;
  }
}

function visibleItems(tool) {
  // 'blocked' (contains protected files) and 'locked' (protected itself) are
  // both shown as Locked rows; lockedSize in the chips sums both.
  return tool.items.filter((it) => it.tier === 'safe' || it.tier === 'review' || it.tier === 'blocked' || it.tier === 'locked');
}

// ---------- rendering ----------

function renderSummary() {
  const t = S.status ? S.status.totals : { footprint: 0, safe: 0, review: 0, junk: 0, found: 0 };
  els.sumTools.textContent = t.found;
  els.sumFootprint.textContent = fmtBytes(t.footprint);
  els.sumSafe.textContent = fmtBytes(t.safe);
  els.sumReview.textContent = fmtBytes(t.review);
  const lifetime = S.status ? S.status.lifetimeReclaimedBytes : 0;
  els.sumLifetime.textContent = fmtBytes(lifetime);
  els.junkPill.textContent = `Junk: ${fmtBytes(t.junk)}`;
  els.deleteAll.disabled = S.scanning || S.deleting || !t.safe;
  els.rescan.disabled = S.scanning || S.deleting;
  els.rescan.textContent = S.scanning ? 'Scanning…' : 'Scan PC';
}

const TOOL_SORTERS = {
  junk: (a, b) => b.junkSize - a.junkSize || b.totalSize - a.totalSize,
  total: (a, b) => b.totalSize - a.totalSize,
  name: (a, b) => a.name.localeCompare(b.name),
};

function renderTools() {
  const tools = [...((S.status && S.status.tools) || [])];
  // While a scan runs, the server drops tools it hasn't re-found yet — fill
  // the gap from the last known snapshot, marked stale, so the list stays put
  // instead of emptying and popping cards back in one by one.
  if (S.scanning && S.lastTools.length) {
    const fresh = new Set(tools.map((t) => t.id));
    for (const t of S.lastTools) {
      if (!fresh.has(t.id)) tools.push({ ...t, stale: true });
    }
  }
  // Expanded cards whose details exist but whose tool is mid-rescan: keep them
  // renderable even if the snapshot above has nothing on file for them yet.
  if (S.scanning) {
    for (const id of S.expanded) {
      if (tools.some((t) => t.id === id)) continue;
      const d = S.details.get(id);
      if (d) {
        tools.push({
          id, name: d.name, vendor: d.vendor, type: d.type, found: d.found,
          totalSize: d.totalSize, safeSize: d.safeSize, reviewSize: d.reviewSize,
          lockedSize: d.lockedSize, junkSize: d.junkSize,
        });
      }
    }
  }
  tools.sort(TOOL_SORTERS[S.toolSort] || TOOL_SORTERS.junk);
  els.empty.classList.toggle('hidden', tools.length > 0 || S.scanning);
  els.tools.innerHTML = tools.map((t) => {
    const open = S.expanded.has(t.id);
    const d = S.details.get(t.id);
    return `
    <article class="tool-card${open ? ' open' : ''}${t.stale ? ' stale' : ''}" data-id="${esc(t.id)}">
      <div class="tool-head" data-action="toggle" data-id="${esc(t.id)}" role="button" tabindex="0"
           aria-expanded="${open}">
        <div class="tool-icon ${esc(t.type.toLowerCase())}">${TYPE_ICONS[t.type] || TYPE_ICONS.CLI}</div>
        <div class="tool-title">
          <h2>${esc(t.name)}</h2>
          <span class="badge">${esc(t.type)}</span>
          <span class="vendor">${esc(t.vendor)}</span>
        </div>
        <div class="tool-sizes">
          <div class="size-block"><span class="mono">${fmtBytes(t.totalSize)}</span><span class="cap">total</span></div>
          <div class="chips">
            ${t.safeSize > 0 ? `<span class="chip safe">Safe ${fmtBytes(t.safeSize)}</span>` : ''}
            ${t.reviewSize > 0 ? `<span class="chip review">Review ${fmtBytes(t.reviewSize)}</span>` : ''}
            ${t.lockedSize > 0 ? `<span class="chip blocked">Locked ${fmtBytes(t.lockedSize)}</span>` : ''}
            ${t.found === false ? '<span class="chip blocked">not found</span>' : ''}
          </div>
        </div>
        <svg class="chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </div>
      ${open ? renderDetail(t, d) : ''}
    </article>`;
  }).join('');
}

function renderDetail(summary, d) {
  if (S.scanning && !d) {
    return `<div class="tool-detail"><div class="detail-note">Scanning…</div></div>`;
  }
  if (!d) return `<div class="tool-detail"><div class="detail-note">Loading…</div></div>`;
  const items = visibleItems(d);
  if (items.length === 0) {
    return `<div class="tool-detail"><div class="detail-note">No junk-classified items — everything here looks like real data or app binaries.</div></div>`;
  }
  const rows = sortItems(items).map((it) => {
    const locked = it.tier === 'blocked' || it.tier === 'locked';
    const filtered = isFiltered(it);
    const checked = S.selection.has(it.path) && !filtered && !locked;
    const size = S.selection.has(it.path) && !filtered && !locked ? it.size : 0;
    return `
    <tr class="${locked ? 'row-locked' : ''}${filtered ? ' is-filtered' : ''}" data-path="${esc(it.path)}">
      <td><input type="checkbox" data-action="select" data-path="${esc(it.path)}"
                 ${checked ? 'checked' : ''} ${locked ? 'disabled' : ''}
                 aria-label="${locked ? `${esc(it.name)} — locked, cannot be deleted`
                   : `Select ${esc(it.name)} (${TIER_LABEL[it.tier] || it.tier}, ${fmtBytes(it.size)})`}"
                 ${locked ? 'title="Protected — cannot be deleted"' : ''}></td>
      <td class="item-name">${esc(it.name)}</td>
      <td><span class="chip ${esc(it.tier)}">${TIER_LABEL[it.tier] || it.tier}</span> <span class="vendor">${esc(it.reason || '')}</span></td>
      <td class="cell-size mono">${fmtBytes(it.size)}</td>
      <td class="item-path" title="${esc(it.path)}"><span>${esc(it.path)}</span></td>
      <td><button class="icon-btn" data-action="open" data-path="${esc(it.path)}" title="Show in Explorer" aria-label="Show ${esc(it.name)} in Explorer">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1M3 8h18l-1.6 9.2a2 2 0 0 1-2 1.8H6.6a2 2 0 0 1-2-1.8L3 8Z"/></svg>
      </button></td>
    </tr>`;
  }).join('');
  const chip = (key, label, size) =>
    `<button class="filter-chip ${key}${S.tierFilter[key] ? ' on' : ''}" data-action="tier-filter" data-tier="${key}"
       aria-pressed="${S.tierFilter[key]}"
       title="${S.tierFilter[key] ? 'Click to hide' : 'Click to show'}">${label} · ${fmtBytes(size)}</button>`;
  const shownCount = items.filter((it) => !isFiltered(it)).length;
  const filterNote = shownCount < items.length
    ? `<span class="filter-note mono" title="Rows hidden by the tier chips or the age filter">showing ${shownCount} of ${items.length}</span>`
    : '';
  const sortOpts = [['size-desc', 'Size ↓'], ['size-asc', 'Size ↑'], ['name', 'Name']]
    .map(([v, l]) => `<option value="${v}"${S.itemSort === v ? ' selected' : ''}>${l}</option>`).join('');
  const { deletable: sel, selectedCount, selectedSize } = selectionStats(summary.id);
  const allSelected = sel.length > 0 && selectedCount === sel.length;
  return `
  <div class="tool-detail">
    <div class="detail-toolbar">
      <label class="select-all" title="Selects visible (unfiltered) deletable items — Locked items are never included">
        <input type="checkbox" data-action="select-all" ${allSelected ? 'checked' : ''} ${sel.length ? '' : 'disabled'}>
        <span>Select all</span>
      </label>
      <span class="sel-note mono" id="sel-note-${esc(summary.id)}">${selectedCount} sel · ${fmtBytes(selectedSize)}</span>
      ${filterNote}
      <span class="detail-note">Safe is pre-selected · Review is your call · Locked is never deletable.</span>
      <span class="spacer"></span>
      <div class="tier-chips">
        ${chip('safe', 'Safe', d.safeSize)}
        ${chip('review', 'Review', d.reviewSize)}
        ${chip('blocked', 'Locked', d.lockedSize)}
      </div>
      <select class="detail-sort" data-action="sort-items" title="Sort items">${sortOpts}</select>
      <button class="btn btn-danger" data-action="delete-tool" data-id="${esc(summary.id)}" id="del-btn-${esc(summary.id)}"
        ${selectedCount ? '' : 'disabled'}>Delete Selected${selectedCount ? ` (${selectedCount} · ${fmtBytes(selectedSize)})` : ''}</button>
    </div>
    <table class="items">
      <thead><tr><th></th><th>Name</th><th>Class</th><th style="text-align:right">Size</th><th>Path</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderStatus() {
  if (S.deleting) return; // the delete progress label owns the status line
  if (!S.status) { els.statusText.textContent = 'Starting…'; return; }
  if (S.scanning) {
    const p = S.status.progress;
    els.statusText.textContent = `Scanning ${p.currentTool || '…'} — ${p.toolsDone}/${p.toolsTotal} tools`;
    return;
  }
  const t = S.status.totals;
  const secs = S.status.lastScanMs ? (S.status.lastScanMs / 1000).toFixed(1) : '?';
  els.statusText.textContent =
    `Scan complete in ${secs}s · ${t.found} tools · ${fmtBytes(t.footprint)} footprint · ${fmtBytes(t.junk)} junk found`;
}

function renderScanBanner() {
  const scanning = S.scanning;
  els.scanBanner.classList.toggle('hidden', !scanning);
  document.body.classList.toggle('scanning', scanning);
  if (!scanning) return;
  const p = S.status ? S.status.progress : { currentTool: null, toolsDone: 0, toolsTotal: 0 };
  const total = p.toolsTotal || 0;
  els.scanFill.classList.toggle('indeterminate', !total);
  if (total) els.scanFill.style.width = `${Math.round((p.toolsDone / total) * 100)}%`;
  els.scanTitle.textContent = S.status ? 'Scanning your PC for AI tool junk…' : 'Starting up…';
  els.scanSub.textContent = total
    ? `${p.currentTool || 'Wrapping up'} — ${p.toolsDone} of ${total} tools`
    : 'Looking for AI tools…';
}

let lastToolsKey = '';

function renderAll() {
  renderSummary();
  renderStatus();
  renderScanBanner();
  if (!S.scanning && S.status && S.status.tools.length) S.lastTools = S.status.tools;
  // Only rebuild the tools DOM when scan data actually changed — the 700ms
  // poll must not replace nodes the user is interacting with.
  const key = JSON.stringify([S.status && S.status.tools, S.status && S.status.progress, S.scanning]);
  if (key !== lastToolsKey) {
    renderTools();
    lastToolsKey = key;
  }
}

// ---------- data flow ----------

async function pollStatus() {
  try {
    S.status = await api('/api/status');
    const wasScanning = S.scanning;
    S.scanning = S.status.scanning;
    for (const t of S.status.tools) {
      // Fetch detail for any expanded tool as soon as the server has it —
      // including mid-scan — so an expanded card can never stay stuck on
      // "Loading…" (the reported "Claude Code comes up empty" race).
      if (S.expanded.has(t.id) && !S.details.has(t.id)) {
        api(`/api/tool/${t.id}`).then((d) => adoptDetail(t.id, d)).catch(() => {});
      }
    }
    renderAll();
    if (wasScanning && !S.scanning) {
      // scan just finished — refresh any expanded details
      for (const id of S.expanded) {
        api(`/api/tool/${id}`).then((d) => adoptDetail(id, d)).catch(() => {});
      }
    }
  } catch { /* server restarting etc. */ }
}

async function triggerScan(onlyIds) {
  try {
    await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: onlyIds || null }),
    });
  } catch { /* already scanning */ }
  // Details and selection survive the rescan (stale-while-revalidate):
  // adoptDetail swaps in fresh data per tool and prunes just-deleted paths,
  // so expanded cards never collapse and user selections stick.
  pollStatus();
  schedulePoll(FAST_POLL_MS); // a scan just started, get on the fast cadence now
}

function setSelection(path, item, on) {
  if (on) {
    S.selection.set(path, { size: item.size, toolId: null });
    S.unchecked.delete(path);
  } else {
    S.selection.delete(path);
    S.unchecked.add(path);
  }
}

async function performDelete(paths) {
  return api('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, mode: S.deleteMode, confirm: S.deleteMode === 'permanent' ? 'DELETE' : undefined }),
  });
}

function excludeUncheckedSafe() {
  const exclude = [];
  for (const d of S.details.values()) {
    for (const it of d.items) {
      if (it.tier === 'safe' && !isFiltered(it) && !S.selection.has(it.path)) exclude.push(it.path);
    }
  }
  return exclude;
}

// Checked, visible Review items across loaded details — Delete All honors
// them with the same contract as Delete Selected.
function selectedReviewPaths() {
  const out = [];
  for (const d of S.details.values()) {
    for (const it of d.items) {
      if (it.tier === 'review' && !isFiltered(it) && S.selection.has(it.path)) out.push(it.path);
    }
  }
  return out;
}

async function afterDelete(res) {
  const failed = res.failed || [];
  const absent = res.absent || 0;
  const lines = [`Reclaimed ${fmtBytes(res.reclaimedBytes)} from ${res.ok.length} item(s)`];
  if (absent) lines.push(`${absent} skipped — already gone`);
  if (failed.length) lines.push(`${failed.length} failed — in use? Close the tool and retry`);
  showDeleteSummary(lines);
  hideDeleteBar();
  // Already-gone paths left stale rows behind — rescan those tools too.
  if (res.ok.length > 0 || res.absent > 0) await triggerScan(res.affectedTools || []);
}

function refusalToast(e) {
  if (e.data && e.data.rejections) {
    const reasons = [...new Set(e.data.rejections.map((r) => r.reason))];
    toast(`Refused: ${reasons.join('; ')}`, true);
  } else {
    toast(`Delete failed: ${e.message}`, true);
  }
}

// ---------- delete progress + completion summary ----------

function setDeleteProgress(done, total) {
  els.deleteBar.classList.remove('hidden');
  els.deleteBarFill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  els.statusText.textContent = `Deleting… ${done} of ${total}`;
}

function hideDeleteBar() {
  els.deleteBar.classList.add('hidden');
  els.deleteBarFill.style.width = '0';
}

let summaryTimer = null;

function showDeleteSummary(lines) {
  els.dsBody.replaceChildren(...lines.map((t) => {
    const d = document.createElement('div');
    d.textContent = t;
    return d;
  }));
  els.deleteSummary.classList.remove('hidden');
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(hideDeleteSummary, 5000);
}

function hideDeleteSummary() {
  els.deleteSummary.classList.add('hidden');
  clearTimeout(summaryTimer);
}

const DELETE_CHUNK = 25;

// Deletes in chunks so progress is real (the recycle shell reports nothing
// until a whole batch finishes) and one failed chunk never blocks the rest.
async function runChunkedDelete(paths) {
  const agg = { ok: [], failed: [], absent: 0, reclaimedBytes: 0 };
  const affected = new Set();
  for (let i = 0; i < paths.length; i += DELETE_CHUNK) {
    setDeleteProgress(Math.min(i, paths.length), paths.length);
    try {
      const res = await performDelete(paths.slice(i, i + DELETE_CHUNK));
      agg.ok.push(...res.ok);
      agg.failed.push(...(res.failed || []));
      agg.absent += res.absent || 0;
      agg.reclaimedBytes += res.reclaimedBytes || 0;
      for (const t of res.affectedTools || []) affected.add(t);
    } catch (e) {
      const rejected = e.data && e.data.rejections;
      agg.failed.push(...(rejected
        ? rejected.map((r) => ({ path: r.path }))
        : paths.slice(i, i + DELETE_CHUNK).map((p) => ({ path: p }))));
    }
  }
  setDeleteProgress(paths.length, paths.length);
  return { ...agg, affectedTools: [...affected] };
}

async function handleDelete(paths) {
  if (S.deleting) { toast('A delete is already in progress…'); return; }
  S.deleting = true;
  els.deleteAll.disabled = true;
  els.statusText.textContent = `Deleting ${paths.length} item(s)…`;
  try {
    const res = await runChunkedDelete(paths);
    await afterDelete(res);
  } catch (e) {
    refusalToast(e);
  } finally {
    S.deleting = false;
    hideDeleteBar();
    renderSummary();
  }
}

async function handleDeleteAll() {
  if (S.deleting) { toast('A delete is already in progress…'); return; }
  S.deleting = true;
  els.deleteAll.disabled = true;
  els.statusText.textContent = 'Deleting all junk…';
  try {
    const { paths } = await api('/api/delete-all/paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exclude: excludeUncheckedSafe(),
        include: selectedReviewPaths(),
      }),
    });
    if (paths.length === 0) {
      showDeleteSummary(['Nothing to delete — everything is already gone.']);
      return;
    }
    const res = await runChunkedDelete(paths);
    await afterDelete(res);
  } catch (e) {
    refusalToast(e);
  } finally {
    S.deleting = false;
    hideDeleteBar();
    renderSummary();
  }
}

// ---------- confirm modal ----------

let pendingPaths = [];

function openConfirm(title, summaryText, paths) {
  pendingPaths = paths;
  S.pendingAll = false;
  els.modalTitle.textContent = title;
  els.modalSummary.textContent = summaryText;
  els.modalFailures.classList.add('hidden');
  els.permanentConfirm.classList.add('hidden');
  els.confirmInput.value = '';
  document.querySelector('input[name="delMode"][value="recycle"]').checked = true;
  S.deleteMode = 'recycle';
  updateModalConfirm();
  els.modal.showModal();
}

function updateModalConfirm() {
  const permanent = S.deleteMode === 'permanent';
  els.permanentConfirm.classList.toggle('hidden', !permanent);
  els.modalConfirm.disabled = permanent && els.confirmInput.value !== 'DELETE';
  els.modalConfirm.textContent = permanent ? 'Delete Permanently' : 'Move to Recycle Bin';
}

// ---------- events ----------

document.querySelector('input[name="delMode"]')?.closest('.mode-row').addEventListener('change', (e) => {
  if (e.target.name === 'delMode') {
    S.deleteMode = e.target.value;
    updateModalConfirm();
  }
});

els.confirmInput.addEventListener('input', updateModalConfirm);
els.modalCancel.addEventListener('click', () => els.modal.close());
els.dsClose.addEventListener('click', hideDeleteSummary);
els.modalConfirm.addEventListener('click', async () => {
  const all = S.pendingAll;
  els.modal.close();
  if (all) await handleDeleteAll();
  else await handleDelete([...pendingPaths]);
});

els.rescan.addEventListener('click', () => triggerScan(null));

els.deleteAll.addEventListener('click', () => {
  if (S.deleting) { toast('A delete is already in progress…'); return; }
  const t = S.status ? S.status.totals : null;
  if (!t || !t.safe) { toast('No safe junk found to delete.'); return; }
  const exclude = excludeUncheckedSafe();
  const include = selectedReviewPaths();
  const sizeOf = (p) => {
    for (const d of S.details.values()) {
      const it = d.items.find((i) => i.path === p);
      if (it) return it.size;
    }
    return 0;
  };
  const count = (t.safeCount || 0) - exclude.length + include.length;
  const size = t.safe - exclude.reduce((s, p) => s + sizeOf(p), 0) + include.reduce((s, p) => s + sizeOf(p), 0);
  S.pendingAll = true;
  openConfirm('Delete All Junk',
    `${count} item(s) · ${fmtBytes(size)} across every tool` +
    `${include.length ? `, including ${include.length} checked Review item(s)` : ''}. ` +
    'Unchecked items are excluded. Recycle Bin by default (recoverable); Permanent is unrecoverable.',
    []);
});

els.ageFilter.addEventListener('change', () => {
  S.ageDays = Number(els.ageFilter.value);
  renderAll();
});

els.tools.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === 'toggle') {
    if (e.target.closest('button, input')) return;
    const id = actionEl.dataset.id;
    if (S.expanded.has(id)) {
      S.expanded.delete(id);
    } else {
      S.expanded.add(id);
      if (!S.details.has(id)) {
        try {
          const d = await api(`/api/tool/${id}`);
          adoptDetail(id, d);
        } catch { /* poll loop will retry */ }
      }
    }
    renderTools();
    return;
  }

  if (action === 'select') {
    const path = actionEl.dataset.path;
    const checked = actionEl.checked;
    let item = null;
    let cardId = null;
    const card = actionEl.closest('.tool-card');
    if (card) cardId = card.dataset.id;
    if (cardId && S.details.has(cardId)) {
      item = S.details.get(cardId).items.find((i) => i.path === path);
    } else {
      for (const d of S.details.values()) {
        item = d.items.find((i) => i.path === path);
        if (item) break;
      }
    }
    if (item) setSelection(path, item, checked);
    renderSummary();
    if (cardId) refreshDetailToolbar(cardId);
    return;
  }

  if (action === 'select-all') {
    const card = actionEl.closest('.tool-card');
    const id = card && card.dataset.id;
    const d = id && S.details.get(id);
  if (d) {
    const checked = actionEl.checked;
    for (const it of d.items) {
      if (!isFiltered(it) && (it.tier === 'safe' || it.tier === 'review')) {
        if (checked) {
          S.selection.set(it.path, { size: it.size });
          S.unchecked.delete(it.path);
        } else {
          S.selection.delete(it.path);
          S.unchecked.add(it.path);
        }
      }
    }
  }
    renderTools();
    renderSummary();
    return;
  }

  if (action === 'tier-filter') {
    const tier = actionEl.dataset.tier;
    S.tierFilter[tier] = !S.tierFilter[tier];
    renderTools();
    return;
  }

  if (action === 'open') {
    try {
      await api('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: actionEl.dataset.path }),
      });
    } catch (err) { toast(`Could not open Explorer: ${err.message}`, true); }
    return;
  }

  if (action === 'delete-tool') {
    if (S.deleting) { toast('A delete is already in progress…'); return; }
    const id = actionEl.dataset.id;
    const d = S.details.get(id);
    if (!d) return;
    const { selectedCount, selectedSize } = selectionStats(id);
    if (selectedCount === 0) { toast('Nothing selected in this tool.'); return; }
    const paths = d.items
      .filter((it) => S.selection.has(it.path) && !isFiltered(it) && (it.tier === 'safe' || it.tier === 'review'))
      .map((it) => it.path);
    openConfirm(`Delete ${d.name} junk`, `${selectedCount} selected item(s) · ${fmtBytes(selectedSize)} — Recycle Bin by default (recoverable); Permanent is unrecoverable.`, paths);
  }
});

// keyboard: Enter/Space toggles a focused tool head
els.tools.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.action === 'toggle') {
    e.preventDefault();
    e.target.click();
  }
});

// item sort selects inside tool details
els.tools.addEventListener('change', (e) => {
  if (e.target.dataset && e.target.dataset.action === 'sort-items') {
    S.itemSort = e.target.value;
    renderTools();
  }
});

els.toolSort.addEventListener('change', () => {
  S.toolSort = els.toolSort.value;
  renderTools();
});

// ---------- boot ----------

// Poll fast while a scan or delete is in flight, and slowly when idle. The
// status endpoint is cheap, but hitting it 1.4x/second forever is pointless.
const FAST_POLL_MS = 700;
const IDLE_POLL_MS = 5000;

let pollTimer = null;

function schedulePoll(delayMs) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollStatus();
    schedulePoll(S.scanning || S.deleting ? FAST_POLL_MS : IDLE_POLL_MS);
  }, delayMs);
}

(async function boot() {
  renderStatus();
  await pollStatus();
  await triggerScan(null); // full scan; clears stale details/selection from any prior session
  schedulePoll(S.scanning ? FAST_POLL_MS : IDLE_POLL_MS);
})();
