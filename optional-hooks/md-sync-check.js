#!/usr/bin/env node
// Global SessionStart hook: verifies CLAUDE.md, AGENTS.md and GEMINI.md
// are in sync (line count match + content match after stripping the
// per-variant Sync: line). Silent no-op in projects without the trio.
// On drift: emits hookSpecificOutput.additionalContext so the warning
// shows up in Claude's session-start system reminder (matches the
// github-sync-check pattern). Never blocks; exits 0 on any error.

const fs = require('fs');
const path = require('path');

const SYNC_LINE_RE = /^> \*\*(?:Синхронизация|Sync):\*\*.*$/m;

function tryReadNormalized(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function countLines(text) {
  if (text.length === 0) return 0;
  const count = text.split('\n').length;
  return text.endsWith('\n') ? count - 1 : count;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const cwd = process.cwd();
    const repoName = path.basename(cwd);
    const claudeMd = path.join(cwd, 'CLAUDE.md');
    const agentsMd = path.join(cwd, 'AGENTS.md');
    const geminiMd = path.join(cwd, 'GEMINI.md');

    const claude = tryReadNormalized(claudeMd);
    const agents = tryReadNormalized(agentsMd);
    const gemini = tryReadNormalized(geminiMd);

    if (claude === null || agents === null || gemini === null) process.exit(0);

    const claudeLines = countLines(claude);
    const agentsLines = countLines(agents);
    const geminiLines = countLines(gemini);

    const claudeStripped = claude.replace(SYNC_LINE_RE, '');
    const agentsStripped = agents.replace(SYNC_LINE_RE, '');
    const geminiStripped = gemini.replace(SYNC_LINE_RE, '');

    const lineCountMatch = claudeLines === agentsLines && claudeLines === geminiLines;
    const contentMatch = claudeStripped === agentsStripped && claudeStripped === geminiStripped;

    if (lineCountMatch && contentMatch) process.exit(0);

    let warning;
    if (!lineCountMatch) {
      warning = `⚠️  MD DRIFT: CLAUDE.md/AGENTS.md/GEMINI.md out of sync in ${repoName} — lines ${claudeLines}/${agentsLines}/${geminiLines}. Run Edit on CLAUDE.md to trigger re-sync, or inspect manually.`;
    } else {
      warning = `⚠️  MD DRIFT: CLAUDE.md/AGENTS.md/GEMINI.md content differs in ${repoName} (line counts match at ${claudeLines}). Run Edit on CLAUDE.md to trigger re-sync, or inspect manually.`;
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: warning
      }
    }));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`md-sync-check error: ${err.message}\n`);
    process.exit(0);
  }
});
