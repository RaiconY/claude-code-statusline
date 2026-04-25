#!/usr/bin/env node
// Claude Code Statusline
// Shows: model | task | directory | git sync | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const model = data.model?.display_name || 'Claude';
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;
    const homeDir = os.homedir();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

    // --- Context window ---
    const AUTO_COMPACT_BUFFER_PCT = 16.5;
    let ctx = '';
    if (remaining != null) {
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Bridge file for context-monitor PostToolUse hook
      if (session) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          fs.writeFileSync(bridgePath, JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: used,
            timestamp: Math.floor(Date.now() / 1000)
          }));
        } catch (e) {}
      }

      const filled = Math.floor(used / 10);
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);

      if (used < 50) {
        ctx = ` \x1b[38;2;255;125;218m${bar} ${used}%\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
      } else {
        ctx = ` \x1b[31m\uD83D\uDC80 ${bar} ${used}%\x1b[0m`;
      }
    }

    // --- Current task ---
    let task = '';
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        const files = fs.readdirSync(todosDir)
          .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
          const inProgress = todos.find(t => t.status === 'in_progress');
          if (inProgress) task = inProgress.activeForm || '';
        }
      } catch (e) {}
    }

    // --- Git status (live, local, no network) ---
    let gitInfo = '';
    let branch = '';
    let detachedSha = '';
    try {
      const gitExec = (cmd) => {
        try {
          return execSync(cmd, { encoding: 'utf8', cwd: dir, windowsHide: true, timeout: 1000 }).trim();
        } catch (e) { return null; }
      };
      const parts = [];

      // Uncommitted changes
      const status = gitExec('git status --porcelain');
      if (status) {
        const count = status.split('\n').filter(Boolean).length;
        parts.push(`\x1b[2m${count} uncommitted\x1b[0m`);
      }

      // Behind/ahead origin
      branch = gitExec('git branch --show-current') || '';
      if (!branch) {
        detachedSha = gitExec('git rev-parse --short HEAD') || '';
      }
      if (branch) {
        const behind = parseInt(gitExec(`git rev-list --count HEAD..origin/${branch}`) || '0', 10);
        const ahead = parseInt(gitExec(`git rev-list --count origin/${branch}..HEAD`) || '0', 10);
        if (behind > 0) parts.push(`\x1b[31m\u2193${behind} pull\x1b[0m`);
        if (ahead > 0) parts.push(`\x1b[33m\u2191${ahead} push\x1b[0m`);
      }

      // MD sync check: drift between CLAUDE.md ↔ AGENTS.md ↔ GEMINI.md
      try {
        const claudeMd = path.join(dir, 'CLAUDE.md');
        const agentsMd = path.join(dir, 'AGENTS.md');
        const geminiMd = path.join(dir, 'GEMINI.md');
        if (fs.existsSync(claudeMd) && fs.existsSync(agentsMd) && fs.existsSync(geminiMd)) {
          const SYNC_LINE_RE = /^> \*\*(?:Синхронизация|Sync):\*\*.*$/m;
          const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
          const cs = norm(claudeMd).replace(SYNC_LINE_RE, '');
          const as = norm(agentsMd).replace(SYNC_LINE_RE, '');
          const gs = norm(geminiMd).replace(SYNC_LINE_RE, '');
          if (cs !== as || cs !== gs) {
            parts.push('\x1b[31m\u26A0 md drift\x1b[0m');
          }
        }
      } catch (e) {}

      if (parts.length > 0) {
        gitInfo = ' ' + parts.join(' ');
      }
    } catch (e) {}

    // --- Peak hours indicator ---
    // Peak hours: Mon-Fri, 05:00–11:00 Pacific Time (PT)
    // PT = UTC-8 (PST) or UTC-7 (PDT, second Sun Mar – first Sun Nov)
    let peakIndicator = '';
    try {
      const now = new Date();
      const year = now.getUTCFullYear();
      const isDST = (() => {
        const mar1 = new Date(Date.UTC(year, 2, 1));
        const dstStart = new Date(Date.UTC(year, 2, 1 + (7 - mar1.getUTCDay()) % 7 + 7, 10));
        const nov1 = new Date(Date.UTC(year, 10, 1));
        const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - nov1.getUTCDay()) % 7, 9));
        return now >= dstStart && now < dstEnd;
      })();
      const ptOffsetHours = isDST ? -7 : -8;
      const ptMs = now.getTime() + ptOffsetHours * 3600 * 1000;
      const ptDate = new Date(ptMs);
      const ptDay = ptDate.getUTCDay();
      const ptHour = ptDate.getUTCHours();
      const ptMin = ptDate.getUTCMinutes();
      const isWeekday = ptDay >= 1 && ptDay <= 5;
      const ptTimeMinutes = ptHour * 60 + ptMin;
      const isPeak = isWeekday && ptTimeMinutes >= 300 && ptTimeMinutes < 660;

      const fmtDur = (mins) => {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h >= 1) return `${h}h`;
        return `${m}m`;
      };

      if (isPeak) {
        const left = 660 - ptTimeMinutes;
        peakIndicator = `\x1b[1;33m\u26A1 ${fmtDur(left)} left\x1b[0m`;
      } else {
        let daysUntil;
        if (isWeekday && ptTimeMinutes < 300) {
          // Before peak today — simple delta
          peakIndicator = `\x1b[2m${fmtDur(300 - ptTimeMinutes)} till \u26A1\x1b[0m`;
        } else {
          // After peak or weekend — find next weekday 05:00 PT
          if (ptDay === 5) daysUntil = 3;        // Fri after peak → Mon
          else if (ptDay === 6) daysUntil = 2;    // Sat → Mon
          else if (ptDay === 0) daysUntil = 1;    // Sun → Mon
          else daysUntil = 1;                      // Mon-Thu after peak → tomorrow
          const minsUntil = (1440 - ptTimeMinutes) + (daysUntil - 1) * 1440 + 300;
          peakIndicator = `\x1b[2m${fmtDur(minsUntil)} till \u26A1\x1b[0m`;
        }
      }
    } catch (e) {}

    // --- Rate limits (subscription) ---
    const limitParts = [];
    const rl = data.rate_limits;
    if (rl) {
      const colorPct = (pct) => {
        if (pct < 50) return `\x1b[38;2;255;125;218m${pct}%\x1b[0m`;
        if (pct < 65) return `\x1b[33m${pct}%\x1b[0m`;
        if (pct < 80) return `\x1b[38;5;208m${pct}%\x1b[0m`;
        return `\x1b[31m${pct}%\x1b[0m`;
      };
      const parts = [];
      if (rl.five_hour) {
        const pct = Math.round(rl.five_hour.used_percentage);
        const resetMs = rl.five_hour.resets_at * 1000 - Date.now();
        const resetMin = Math.max(0, Math.ceil(resetMs / 60000));
        const resetStr = resetMin >= 60
          ? `${Math.floor(resetMin / 60)}h${resetMin % 60}m`
          : `${resetMin}m`;
        parts.push(`5h:${colorPct(pct)}\x1b[2m(${resetStr})\x1b[0m`);
      }
      if (rl.seven_day) {
        const pct = Math.round(rl.seven_day.used_percentage);
        parts.push(`7d:${colorPct(pct)}`);
      }
      for (const p of parts) limitParts.push(p);
    }

    // --- Output ---
    const dirname = path.basename(dir);
    const segments = [`\x1b[2m${model}\x1b[0m`];
    if (task) segments.push(`\x1b[1m${task}\x1b[0m`);
    let dirSegment = `\x1b[2m${dirname}\x1b[0m`;
    if (branch) {
      dirSegment += ` \x1b[36m(${branch})\x1b[0m`;
    } else if (detachedSha) {
      dirSegment += ` \x1b[31m(HEAD@${detachedSha})\x1b[0m`;
    }
    segments.push(dirSegment);
    if (gitInfo) segments.push(gitInfo.trim());
    if (ctx) segments.push(ctx.trim());
    for (const lp of limitParts) segments.push(lp);
    if (peakIndicator) segments.push(peakIndicator);

    process.stdout.write(segments.join(' \u2502 '));
  } catch (e) {}
});
