// Catalog of AI IDEs / CLIs / agents and their on-disk locations on Windows.
// Roots present on this machine were verified; the rest use standard install
// conventions so the tool also works on other PCs.

import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

const dir = (...p) => ({ kind: 'dir', path: path.join(...p) });
const file = (...p) => ({ kind: 'file', path: path.join(...p) });
const junkRoot = (r, label) => ({ ...r, label, junkRoot: 'safe' });
const protectedRoot = (r, label) => ({ ...r, label, protect: true });

export const TOOLS = [
  {
    id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', type: 'CLI',
    processes: ['claude', 'claude.exe'],
    roots: [
      dir(home, '.claude'),
      protectedRoot(file(home, '.claude.json'), 'global state & auth (protected)'),
      dir(local, 'claude-cli-nodejs'),
      dir(local, 'Claude'),
    ],
  },
  {
    id: 'codex', name: 'Codex CLI', vendor: 'OpenAI', type: 'CLI',
    processes: ['codex', 'codex.exe'],
    roots: [
      dir(home, '.codex'),
      dir(local, 'OpenAI'),
    ],
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI', vendor: 'Google', type: 'CLI',
    processes: ['gemini', 'gemini.exe'],
    roots: [
      // Antigravity stores its data inside ~/.gemini too; those subtrees belong
      // to the antigravity entry below and are excluded here to avoid double counting.
      { ...dir(home, '.gemini'), exclude: ['antigravity', 'antigravity-cli', 'antigravity-ide'] },
    ],
  },
  {
    id: 'antigravity', name: 'Antigravity', vendor: 'Google', type: 'IDE',
    processes: ['Antigravity.exe'],
    roots: [
      dir(home, '.gemini', 'antigravity'),
      dir(home, '.gemini', 'antigravity-cli'),
      dir(home, '.gemini', 'antigravity-ide'),
      dir(roaming, 'Antigravity'),
      dir(local, 'antigravity'),
      junkRoot(dir(local, 'antigravity-updater'), 'updater cache'),
    ],
  },
  {
    id: 'zcode', name: 'ZCode', vendor: 'Z.ai', type: 'CLI',
    processes: ['zcode', 'ZCode.exe'],
    roots: [dir(home, '.zcode')],
  },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'SST', type: 'Agent',
    processes: ['opencode', 'opencode.exe'],
    roots: [
      dir(home, '.config', 'opencode'),
      dir(roaming, 'ai.opencode.desktop'),
      junkRoot(dir(local, '@opencode-aidesktop-updater'), 'updater cache'),
    ],
  },
  {
    id: 'hermes', name: 'Hermes Agent', vendor: 'Nous Research', type: 'Agent',
    processes: ['hermes', 'hermes.exe', 'Hermes.exe'],
    roots: [
      dir(home, '.hermes'),
      dir(roaming, 'Hermes'),
      dir(local, 'hermes'),
    ],
  },
  {
    id: 'pi', name: 'Pi', vendor: 'earendil-works', type: 'Agent',
    processes: ['pi', 'pi.exe'],
    roots: [dir(home, '.pi')],
  },
  {
    id: 'qoder', name: 'Qoder', vendor: 'Alibaba', type: 'Agent',
    processes: ['Qoder.exe'],
    roots: [
      dir(home, '.qoder'),
      dir(roaming, 'Qoder'),
      dir(local, 'Qoder'),
    ],
  },
  {
    id: 'browseruse', name: 'Browser Use', vendor: 'browser-use', type: 'Agent',
    processes: ['browseruse'],
    roots: [dir(home, '.config', 'browseruse')],
  },
  {
    id: 'agents', name: 'Agent Skills Library', vendor: '—', type: 'Agent',
    processes: [],
    roots: [dir(home, '.agents')],
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop', vendor: 'Anthropic', type: 'Agent',
    processes: ['Claude.exe'],
    roots: [dir(roaming, 'Claude')],
  },
  {
    id: 'cursor', name: 'Cursor', vendor: 'Anysphere', type: 'IDE',
    processes: ['Cursor.exe'],
    roots: [
      dir(home, '.cursor'),
      dir(home, '.cursor-cli'),
      dir(roaming, 'Cursor'),
      dir(local, 'Cursor'),
    ],
  },
  {
    id: 'windsurf', name: 'Windsurf', vendor: 'Codeium', type: 'IDE',
    processes: ['Windsurf.exe'],
    roots: [
      dir(home, '.windsurf'),
      dir(roaming, 'Windsurf'),
      dir(local, 'Windsurf'),
    ],
  },
  {
    id: 'trae', name: 'Trae', vendor: 'ByteDance', type: 'IDE',
    processes: ['Trae.exe'],
    roots: [dir(roaming, 'Trae'), dir(local, 'Trae')],
  },
  {
    id: 'void', name: 'Void', vendor: 'Void', type: 'IDE',
    processes: ['Void.exe'],
    roots: [dir(roaming, 'Void'), dir(local, 'Void')],
  },
  {
    id: 'zed', name: 'Zed', vendor: 'Zed Industries', type: 'IDE',
    processes: ['zed.exe'],
    roots: [dir(roaming, 'Zed'), dir(local, 'Zed')],
  },
  {
    id: 'qwen-code', name: 'Qwen Code', vendor: 'Alibaba', type: 'CLI',
    processes: ['qwen', 'qwen.exe'],
    roots: [dir(home, '.qwen')],
  },
  {
    id: 'aider', name: 'Aider', vendor: 'Aider AI', type: 'CLI',
    processes: ['aider'],
    roots: [
      dir(home, '.aider'),
      protectedRoot(file(home, '.aider.conf.yml'), 'config (protected)'),
    ],
  },
  {
    id: 'continue', name: 'Continue', vendor: 'Continue Dev', type: 'Agent',
    processes: [],
    roots: [dir(home, '.continue')],
  },
  {
    id: 'copilot', name: 'GitHub Copilot', vendor: 'GitHub', type: 'Agent',
    processes: [],
    roots: [
      dir(home, '.copilot'),
      dir(local, 'GitHub Copilot'),
    ],
  },
  {
    id: 'crush', name: 'Crush', vendor: 'Charm', type: 'CLI',
    processes: ['crush', 'crush.exe'],
    roots: [dir(home, '.config', 'crush')],
  },
  {
    id: 'ollama', name: 'Ollama', vendor: 'Ollama', type: 'CLI',
    processes: ['ollama', 'ollama.exe', 'ollama app.exe'],
    roots: [dir(home, '.ollama'), dir(local, 'Ollama')],
  },
  {
    id: 'lm-studio', name: 'LM Studio', vendor: 'LM Studio', type: 'Agent',
    processes: ['LM Studio.exe'],
    roots: [
      dir(home, '.cache', 'lm-studio'),
      dir(local, 'LM Studio'),
      dir(roaming, 'LM Studio'),
    ],
  },
];

export function allRoots() {
  return TOOLS.flatMap((t) => t.roots.map((r) => ({ ...r, toolId: t.id })));
}
