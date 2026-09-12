// Junk classification rules. Deterministic, name-based (case-insensitive).
// Tiers: 'safe' (auto-selected junk), 'review' (shown, unchecked), 'never' (locked).
// Unmatched names = keep (scanner recurses into them).

const NEVER_DIRS = new Set([
  'skills', 'commands', 'agents', 'keyrings', 'memories',
]);

const NEVER_FILES = new Set([
  '.claude.json', '.aider.conf.yml', '.env',
  'auth.json', 'credentials.json', 'credentials.yaml',
  'settings.json', 'settings.local.json',
  'config.toml', 'config.json', 'config.yaml', 'config.yml',
  'mcp.json', 'mcp_servers.json', 'keybindings.json',
]);

const NEVER_FILE_RES = [
  /\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i, /^secret/i,
];

const SAFE_DIRS = new Set([
  'cache', 'caches', '.cache', 'code cache', 'gpucache', 'gpu cache',
  'cacheddata', 'cachedfiles', 'cachedextensionvsixs', 'cachedprofiles',
  'cachestorage', 'cache_storage', 'shadercache', 'shader-cache', 'shaders',
  'dawncache', 'dawngraphitecache', 'dawnwebgpucache', 'grshadercache',
  'graphitedawncache', 'gpucachedx12',
  'crashpad', 'crashes', 'crash-dumps', 'crashdumps', 'crashpad-completed',
  'logs', 'log', 'webrtc-event-logs',
  'tmp', 'temp', 'shell-snapshots', 'shellsnapshots',
  'statsig', 'telemetry', 'metrics', 'annotations-metrics',
  'image-cache', 'imagecache', 'image_cache', 'thumbnails',
  'audio_cache', 'audiocache', 'audio-cache',
  'blob_storage', 'service worker', '__pycache__',
  'session-env',
]);

const SAFE_FILE_RES = [
  /\.(log|tmp)(\.\d+)?$/i,
  /^logs_.*\.sqlite(-wal|-shm)?$/i,
  /^debug\.log/i,
];

const REVIEW_DIRS = new Set([
  'sessions', 'session', 'sessiondata', 'session-data',
  'rollout', 'rollouts', 'projects', 'conversations', 'conversation',
  'archived_sessions', 'history', 'plans', 'file-history', 'file_history',
  'brain', 'skills-archive', 'plugins', 'node_modules', 'artifacts',
  'workspacestorage', 'recordings', 'browser_recordings', 'backups',
  'dictation', 'transcripts',
  // user-visible session state, not a cache — shown, but never auto-selected
  'todos', 'tasks',
]);

const REVIEW_FILE_RES = [
  /^\.aider\./i,
  /^history(_\d+)?\.jsonl$/i,
  /^dictation-history\.jsonl$/i,
  /^transcription-history\.jsonl$/i,
];

const REASONS = {
  neverDir: 'protected (user data / config)',
  neverFile: 'protected (config / credentials)',
  safeDir: 'cache or transient data',
  safeFile: 'log or temp file',
  reviewDir: 'session history — check before deleting',
  reviewFile: 'history file — check before deleting',
  protectedInside: 'contains protected files',
};

export function classify(name, isDir) {
  const lower = name.toLowerCase();
  if (isDir) {
    if (NEVER_DIRS.has(lower)) return { tier: 'never', reason: REASONS.neverDir };
    if (SAFE_DIRS.has(lower)) return { tier: 'safe', reason: REASONS.safeDir };
    if (REVIEW_DIRS.has(lower)) return { tier: 'review', reason: REASONS.reviewDir };
    return null;
  }
  if (NEVER_FILES.has(lower) || NEVER_FILE_RES.some((re) => re.test(name))) {
    return { tier: 'never', reason: REASONS.neverFile };
  }
  if (SAFE_FILE_RES.some((re) => re.test(name))) return { tier: 'safe', reason: REASONS.safeFile };
  if (REVIEW_FILE_RES.some((re) => re.test(name))) return { tier: 'review', reason: REASONS.reviewFile };
  return null;
}

// Used during size-walks of junk subtrees: a protected file nested inside a
// cache dir must block deletion of that dir.
export function isProtectedName(name, isDir) {
  const cls = classify(name, isDir);
  return cls !== null && cls.tier === 'never';
}

export function isNeverName(name, isDir) {
  const cls = classify(name, isDir);
  return cls !== null && cls.tier === 'never';
}

// Independent delete-time check for one candidate path (defense in depth).
export function assertDeletableName(name, isDir) {
  if (isProtectedName(name, isDir)) {
    throw new Error(`refusing protected item: ${name}`);
  }
  return true;
}
