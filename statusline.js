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
    const shortModel = (name) => {
      const m = name.match(/^(?:claude-)?(Opus|Sonnet|Haiku|Mythos)[\s-]+(\d+(?:[.-]\d+)?)(?:\s*\(([^)]+)\))?/i);
      if (!m) return name;
      const family = m[1].charAt(0).toUpperCase() + m[1].charAt(1).toLowerCase();
      const version = m[2].replace('-', '.');
      const ctx = m[3];
      let suffix = `${family} ${version}`;
      if (ctx) {
        const ctxMatch = ctx.match(/(\d+)\s*([KMG])/i);
        if (ctxMatch) suffix += ` (${ctxMatch[1]}${ctxMatch[2].toLowerCase()})`;
      }
      return suffix;
    };
    const model = shortModel(data.model?.display_name || 'Claude');
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

      const steps = Math.max(0, Math.min(10, Math.floor(used / 10)));
      let bar = '';
      for (let i = 0; i < 5; i++) {
        const cell = Math.max(0, Math.min(2, steps - i * 2));
        bar += cell === 2 ? '\u2588' : cell === 1 ? '\u258c' : '\u2591';
      }

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
          return execSync(cmd, { encoding: 'utf8', cwd: dir, windowsHide: true, timeout: 1000, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch (e) { return null; }
      };
      const parts = [];

      // Uncommitted changes
      const status = gitExec('git status --porcelain');
      if (status) {
        const count = status.split('\n').filter(Boolean).length;
        parts.push(`\x1b[2m${count} dirty\x1b[0m`);
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

    // --- Prompt cache state (from transcript JSONL) ---
    let cacheSegment = '';
    try {
      if (session) {
        const slug = dir.replace(/[:\\\/]/g, '-');
        const transcriptPath = path.join(claudeDir, 'projects', slug, `${session}.jsonl`);
        if (fs.existsSync(transcriptPath)) {
          const stat = fs.statSync(transcriptPath);
          // Read 1 extra byte before the window so the first \n distinguishes
          // a partial line from a clean line boundary.
          const desired = Math.min(stat.size, 16384);
          const startOffset = Math.max(0, stat.size - desired - 1);
          const readBytes = stat.size - startOffset;
          const buf = Buffer.alloc(readBytes);
          const fd = fs.openSync(transcriptPath, 'r');
          fs.readSync(fd, buf, 0, readBytes, startOffset);
          fs.closeSync(fd);
          let content = buf.toString('utf8');
          if (startOffset > 0) {
            const nl = content.indexOf('\n');
            if (nl >= 0) content = content.slice(nl + 1);
          }
          const lines = content.split('\n').filter(Boolean);

          const fmt = (n) => {
            if (n < 1000) return String(n);
            if (n < 10000) return (n / 1000).toFixed(1) + 'k';
            if (n < 1000000) return Math.round(n / 1000) + 'k';
            return (n / 1000000).toFixed(1) + 'M';
          };

          let lastUsage = null;
          let lastTouchTs = null;
          let lastWriteTtl = null;

          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const rec = JSON.parse(lines[i]);
              const u = rec && rec.type === 'assistant' && rec.message ? rec.message.usage : null;
              if (!u || !rec.timestamp) continue;
              const read = u.cache_read_input_tokens || 0;
              const write = u.cache_creation_input_tokens || 0;
              if (read === 0 && write === 0) continue;

              if (!lastUsage) {
                lastUsage = { read, write };
                const ts = new Date(rec.timestamp).getTime();
                lastTouchTs = Number.isFinite(ts) ? ts : 0;
              }
              if (!lastWriteTtl && write > 0 && u.cache_creation) {
                if (u.cache_creation.ephemeral_1h_input_tokens > 0) lastWriteTtl = '1h';
                else if (u.cache_creation.ephemeral_5m_input_tokens > 0) lastWriteTtl = '5m';
              }
              if (lastUsage && lastWriteTtl) break;
            } catch (e) {}
          }

          if (lastUsage) {
            const parts = ['\x1b[2mcache\x1b[0m'];
            if (lastUsage.read > 0) {
              parts.push(`\x1b[1;32m↓${fmt(lastUsage.read)}\x1b[0m`);
            }
            if (lastUsage.write > 0) {
              const sym = lastUsage.read > 0 ? '+' : '↑';
              parts.push(`\x1b[33m${sym}${fmt(lastUsage.write)}\x1b[0m`);
            }
            if (lastWriteTtl) {
              const ttlMs = lastWriteTtl === '5m' ? 300000 : 3600000;
              const remainingSec = (ttlMs - (Date.now() - lastTouchTs)) / 1000;
              const bucketColor = lastWriteTtl === '5m' ? '\x1b[33m' : '\x1b[2;36m';
              let suffix = `${bucketColor}${lastWriteTtl}\x1b[0m`;
              let timeStr;
              if (remainingSec <= 0) timeStr = '0m';
              else if (remainingSec < 60) timeStr = Math.ceil(remainingSec) + 's';
              else if (remainingSec < 3600) timeStr = Math.ceil(remainingSec / 60) + 'm';
              else {
                const h = Math.floor(remainingSec / 3600);
                const m = Math.floor((remainingSec % 3600) / 60);
                timeStr = h + 'h' + (m > 0 ? m + 'm' : '');
              }
              const pct = remainingSec > 0 ? (remainingSec * 1000) / ttlMs : 0;
              let countColor;
              if (pct <= 0) countColor = '\x1b[31m';
              else if (pct < 0.1) countColor = '\x1b[38;5;208m';
              else if (pct < 0.25) countColor = '\x1b[33m';
              else countColor = '\x1b[2m';
              suffix += `${countColor}:${timeStr}\x1b[0m`;
              parts.push(suffix);
            }
            cacheSegment = parts.join(' ');
          }
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
      const formatReset = (resetTs, opts) => {
        if (!Number.isFinite(resetTs)) return null;
        const coarse = !!(opts && opts.coarse);
        const resetMin = Math.max(0, Math.ceil((resetTs * 1000 - Date.now()) / 60000));
        if (resetMin >= 1440) {
          const d = Math.floor(resetMin / 1440);
          const h = Math.floor((resetMin % 1440) / 60);
          if (coarse && d >= 2) return `${d}d`;
          if (d === 1 && h === 0) return '24h';
          return `${d}d${h}h`;
        }
        if (resetMin >= 60) {
          const h = Math.floor(resetMin / 60);
          const m = resetMin % 60;
          return m > 0 ? `${h}h${m}m` : `${h}h`;
        }
        return `${resetMin}m`;
      };
      const withReset = (label, bucket, opts) => {
        const pct = Math.round(bucket.used_percentage);
        const reset = formatReset(bucket.resets_at, opts);
        const main = `${label}:${colorPct(pct)}`;
        return reset ? `${main}\x1b[2m(${reset})\x1b[0m` : main;
      };
      const parts = [];
      if (rl.five_hour) parts.push(withReset('5h', rl.five_hour));
      if (rl.seven_day) parts.push(withReset('7d', rl.seven_day, { coarse: true }));
      for (const p of parts) limitParts.push(p);
    }

    // --- Output ---
    const dirRaw = path.basename(dir);
    const dirShort = dirRaw.length > 15
      ? dirRaw.slice(0, 7) + '…' + dirRaw.slice(-7)
      : dirRaw;
    const buildDirSegment = (name) => {
      let s = `\x1b[2m${name}\x1b[0m`;
      if (branch) s += ` \x1b[36m(${branch})\x1b[0m`;
      else if (detachedSha) s += ` \x1b[31m(HEAD@${detachedSha})\x1b[0m`;
      return s;
    };
    const segments = [`\x1b[2m${model}\x1b[0m`];
    if (task) segments.push(`\x1b[1m${task}\x1b[0m`);
    const dirIndex = segments.length;
    segments.push(buildDirSegment(dirRaw));
    if (gitInfo) segments.push(gitInfo.trim());
    if (ctx) segments.push(ctx.trim());
    if (cacheSegment) segments.push(cacheSegment);
    for (const lp of limitParts) segments.push(lp);

    // Truncate dirname only if the line crosses 100 visible columns.
    if (dirRaw !== dirShort) {
      const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
      let visible = -3; // " \u2502 " separator is 3 chars; pre-subtract one to undo over-counting.
      for (const seg of segments) visible += 3 + stripAnsi(seg).length;
      if (visible > 100) segments[dirIndex] = buildDirSegment(dirShort);
    }

    process.stdout.write(segments.join(' \u2502 '));
  } catch (e) {}
});
