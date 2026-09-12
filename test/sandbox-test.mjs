// Sandbox verification: builds a fake AI tool folder with known-size junk in
// %TEMP%, checks scanner sizes/classification, recycles through the real
// PowerShell path, confirms the Recycle Bin receipt, and asserts the delete
// validation refuses paths outside tool roots.
//
// Run: node test/sandbox-test.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { scanTool } from '../lib/scanner.mjs';
import { recyclePaths, logHistory, readHistory } from '../lib/deleter.mjs';
import { validateDeleteTarget } from '../lib/validate.mjs';
import { classify } from '../lib/rules.mjs';

const SANDBOX = path.join(os.tmpdir(), 'aijr-sandbox');
const FAKE_HOME = path.join(SANDBOX, '.fakecli');
const FAKE_ROOTS = [{ kind: 'dir', path: FAKE_HOME }];

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function write(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
}

const b64ps = (script) =>
  Buffer.from(script, 'utf16le').toString('base64');

async function main() {
  console.log(`sandbox: ${SANDBOX}`);
  await fsp.rm(SANDBOX, { recursive: true, force: true });

  // fixture with exact sizes
  await write(path.join(FAKE_HOME, 'cache', 'a.bin'), 1000);
  await write(path.join(FAKE_HOME, 'cache', 'nested', 'b.bin'), 250);
  await write(path.join(FAKE_HOME, 'cache', 'settings.json'), 20); // protected inside a cache -> blocked
  await write(path.join(FAKE_HOME, 'cache2', 'blob.bin'), 400);    // unclassified name -> keep
  await write(path.join(FAKE_HOME, 'logs', 'x.log'), 200);
  await write(path.join(FAKE_HOME, 'sessions', 's.jsonl'), 5000);
  await write(path.join(FAKE_HOME, 'settings.json'), 10); // protected at top level
  await write(path.join(FAKE_HOME, 'data', 'keep.bin'), 30000);
  await write(path.join(FAKE_HOME, 'skills', 'my-skill', 'cache', 'junk.bin'), 700); // nested under skills -> locked
  const EXPECT_TOTAL = 1000 + 250 + 20 + 400 + 200 + 5000 + 10 + 30000 + 700;

  const tool = {
    id: 'fakecli', name: 'Fake CLI', vendor: 'Test', type: 'CLI',
    roots: [{ kind: 'dir', path: FAKE_HOME }],
  };

  // 1. scan + sizes
  const res = await scanTool(tool);
  check('tool found', res.found === true);
  check('total size exact', res.totalSize === EXPECT_TOTAL, `got ${res.totalSize}, want ${EXPECT_TOTAL}`);

  const item = (name) => res.items.find((i) => i.name === name);
  check('cache -> blocked, size 1270 (protected inside)',
    item('cache')?.tier === 'blocked' && item('cache').size === 1270, JSON.stringify(item('cache')));
  check('cache2 not offered (unclassified name)', item('cache2') === undefined);
  check('logs -> safe 200', item('logs')?.tier === 'safe' && item('logs').size === 200);
  check('sessions -> review 5000', item('sessions')?.tier === 'review' && item('sessions').size === 5000);
  check('settings.json surfaced as locked, never junk', item('settings.json')?.tier === 'locked', JSON.stringify(item('settings.json')));
  check('skills subtree -> locked (never junk beneath it)',
    item('skills')?.tier === 'locked' && item('skills').size === 700, JSON.stringify(item('skills')));
  check('junkSize = safe + review (5200)', res.junkSize === 5200, `got ${res.junkSize}`);

  // 1b. A root marked junkRoot:'safe' must be ONE item (no double-counting of
  //     its children) and must still be blocked if it holds a protected file.
  const JUNK = path.join(SANDBOX, 'fakeupdater');
  await write(path.join(JUNK, 'cache', 'a.bin'), 1000);
  await write(path.join(JUNK, 'logs', 'x.log'), 200);
  const junkTool = {
    id: 'fakeupdater', name: 'Fake Updater', vendor: 'Test', type: 'CLI',
    roots: [{ kind: 'dir', path: JUNK, junkRoot: 'safe', label: 'updater cache' }],
  };
  const jres = await scanTool(junkTool);
  check('junkRoot total counted once (1200)', jres.totalSize === 1200, `got ${jres.totalSize}`);
  check('junkRoot collapses to a single item', jres.items.length === 1, JSON.stringify(jres.items));
  check('junkRoot safe size not double-counted', jres.safeSize === 1200, `got ${jres.safeSize}`);

  const JUNK2 = path.join(SANDBOX, 'fakeupdater2');
  await write(path.join(JUNK2, 'cache', 'junk.bin'), 900);
  await write(path.join(JUNK2, 'cache', 'settings.json'), 20);
  const junkTool2 = {
    id: 'fakeupdater2', name: 'Fake Updater 2', vendor: 'Test', type: 'CLI',
    roots: [{ kind: 'dir', path: JUNK2, junkRoot: 'safe', label: 'updater cache' }],
  };
  const jres2 = await scanTool(junkTool2);
  check('junkRoot holding a protected file is not Safe',
    jres2.items.length === 1 && jres2.items[0].tier === 'blocked' && jres2.safeSize === 0,
    JSON.stringify(jres2.items));

  // 1c. Session state is Review (shown, unchecked) — never auto-selected Safe.
  check('todos -> review', classify('todos', true)?.tier === 'review');
  check('tasks -> review', classify('tasks', true)?.tier === 'review');
  check('session-env still safe', classify('session-env', true)?.tier === 'safe');

  // 2. delete validation (sandbox injected as an extra root): refuse everything else
  const outside = await validateDeleteTarget(path.join(os.tmpdir(), 'definitely-not-a-tool'));
  check('outside path refused', outside.ok === false, JSON.stringify(outside));
  const sysPath = await validateDeleteTarget('C:\\Windows\\Temp');
  check('system path refused', sysPath.ok === false);
  const wholeRoot = await validateDeleteTarget(FAKE_HOME, FAKE_ROOTS);
  check('whole tool root refused', wholeRoot.ok === false, JSON.stringify(wholeRoot));
  const protectedName = await validateDeleteTarget(path.join(FAKE_HOME, 'settings.json'), FAKE_ROOTS);
  check('protected name refused', protectedName.ok === false);
  const blockedDir = await validateDeleteTarget(path.join(FAKE_HOME, 'cache'), FAKE_ROOTS);
  check('dir containing protected file refused', blockedDir.ok === false);
  const nestedInSkills = await validateDeleteTarget(path.join(FAKE_HOME, 'skills', 'my-skill', 'cache'), FAKE_ROOTS);
  check('junk nested inside protected dir refused', nestedInSkills.ok === false, JSON.stringify(nestedInSkills));
  const legit = await validateDeleteTarget(path.join(FAKE_HOME, 'sessions'), FAKE_ROOTS);
  check('legit junk accepted', legit.ok === true, JSON.stringify(legit));

  // the server skips paths whose reason is exactly 'not found' (already gone)
  const missing = await validateDeleteTarget(path.join(FAKE_HOME, 'nope-missing'), FAKE_ROOTS);
  check('missing path reports reason "not found"', missing.ok === false && missing.reason === 'not found', JSON.stringify(missing));

  // 3. recycle through the real PowerShell path
  const sessionsPath = path.join(FAKE_HOME, 'sessions');
  const recycled = await recyclePaths([sessionsPath]);
  check('recycle ok list', Array.isArray(recycled.ok) && recycled.ok.length === 1, JSON.stringify(recycled));
  check('recycle removed from disk', !fs.existsSync(sessionsPath));

  const rbScript = `
$sh = New-Object -ComObject Shell.Application
$rb = $sh.Namespace(0xA)
($rb.Items() | ForEach-Object { $_.Name }) -join '|'
`;
  const rbList = execSync(
    `powershell -NoProfile -NonInteractive -EncodedCommand ${b64ps(rbScript)}`,
    { encoding: 'utf8' },
  );
  check('item visible in Recycle Bin', rbList.includes('sessions'), `listing: ${rbList.trim().slice(0, 300)}`);

  // 4. history log
  await logHistory({ ts: Date.now(), mode: 'recycle', reclaimedBytes: 5000, count: 1, failedCount: 0, paths: [sessionsPath] });
  const history = await readHistory(10);
  check('history recorded', history.lifetimeBytes >= 5000 && history.entries.length > 0);

  // 5. re-scan after delete reflects the reduction
  const res2 = await scanTool(tool);
  check('rescan shows reduction', res2.totalSize === EXPECT_TOTAL - 5000, `got ${res2.totalSize}`);
  check('rescan drops deleted item', res2.items.find((i) => i.name === 'sessions') === undefined);

  // cleanup fixture (recycle entry stays, as evidence)
  await fsp.rm(SANDBOX, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
