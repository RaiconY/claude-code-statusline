#!/usr/bin/env node
// Global PostToolUse hook: mirrors CLAUDE.md edits into AGENTS.md and GEMINI.md
// in any project that has all three siblings. Rewrites the Sync: line per variant.
// Exits 0 on any error so it never blocks the originating tool call.
// Surfaces a visible systemMessage when it actually syncs (no noise on no-ops).

const fs = require('fs');
const path = require('path');

const SYNC_LINE_RE = /^> \*\*(?:Синхронизация|Sync):\*\*.*$/m;
const SYNC_AGENTS = '> **Sync:** Any changes to this file must also be applied to `CLAUDE.md` and `GEMINI.md`.';
const SYNC_GEMINI = '> **Sync:** Any changes to this file must also be applied to `CLAUDE.md` and `AGENTS.md`.';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}');
    const toolName = payload.tool_name;
    const filePath = payload.tool_input && payload.tool_input.file_path;

    if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);
    if (!filePath || path.basename(filePath) !== 'CLAUDE.md') process.exit(0);

    const claudeMd = path.resolve(filePath);
    const projectRoot = path.dirname(claudeMd);
    const agentsMd = path.join(projectRoot, 'AGENTS.md');
    const geminiMd = path.join(projectRoot, 'GEMINI.md');

    // Safety: only sync when both siblings exist — protects unrelated projects.
    if (!fs.existsSync(agentsMd) || !fs.existsSync(geminiMd)) process.exit(0);

    const content = fs.readFileSync(claudeMd, 'utf8');

    fs.writeFileSync(agentsMd, content.replace(SYNC_LINE_RE, SYNC_AGENTS), 'utf8');
    fs.writeFileSync(geminiMd, content.replace(SYNC_LINE_RE, SYNC_GEMINI), 'utf8');

    // Surface a visible success message via hook JSON output.
    process.stdout.write(JSON.stringify({
      systemMessage: '✓ sync-md: CLAUDE.md → AGENTS.md + GEMINI.md',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'sync-md hook fired: AGENTS.md and GEMINI.md were regenerated from CLAUDE.md with per-variant Sync: lines.'
      }
    }));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`sync-md error: ${err.message}\n`);
    process.exit(0);
  }
});
