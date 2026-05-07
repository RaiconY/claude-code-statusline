#!/usr/bin/env node
// GitHub Sync Check - SessionStart Hook
//
// Суть: при старте сессии проверяет состояние git-репозитория:
//   1. Есть ли незакоммиченные изменения (локально, быстро)
//   2. Синхронизирован ли локальный branch с GitHub (из кэша предыдущей сессии)
//   3. В фоне делает git fetch и обновляет кэш для следующей сессии
//
// ВАЖНО: stderr видит пользователь, а additionalContext попадает только
// в system-reminder агента (Claude). Если агенту нужна эта информация,
// он должен сам учитывать additionalContext.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const cwd = process.cwd();
const homeDir = os.homedir();
const cacheDir = path.join(homeDir, '.claude', 'cache');
const cacheFile = path.join(cacheDir, 'github-sync.json');

try {
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function exec(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd, windowsHide: true, timeout: 5000 }).trim();
  } catch (e) {
    return null;
  }
}

// 1. Git repo check
const gitDir = exec(['rev-parse', '--git-dir']);
if (!gitDir) process.exit(0);

// 2. GitHub remote check
const remoteUrl = exec(['remote', 'get-url', 'origin']);
if (!remoteUrl || !remoteUrl.includes('github.com')) process.exit(0);

// 3. Current branch
const branch = exec(['branch', '--show-current']);
if (!branch) process.exit(0); // Detached HEAD — skip

// 4. Repo name from URL
const repoName = remoteUrl
  .replace(/.*github\.com[:/]/, '')
  .replace(/\.git$/, '');

// 5. Uncommitted changes (fast, no network)
const statusOutput = exec(['status', '--porcelain']);
const hasUncommitted = !!statusOutput && statusOutput.length > 0;

// 6. Read cached remote sync status (from previous session's background check)
const cacheKey = `${cwd}::${branch}`;
let cachedSync = null;
try {
  if (fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.key === cacheKey) {
      cachedSync = cache;
    }
  }
} catch (e) {}

// 7. Build and print alerts
const alerts = [];

if (hasUncommitted) {
  const fileCount = statusOutput.split('\n').filter(Boolean).length;
  alerts.push(
    `⚠️  UNCOMMITTED CHANGES: ${fileCount} file(s) modified/staged in` +
    ` ${repoName} (branch: ${branch}). Consider committing or stashing.`
  );
}

if (cachedSync) {
  const ageMin = Math.floor((Date.now() - cachedSync.checked) / 60000);
  const age = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`;

  const { ahead = 0, behind = 0 } = cachedSync;

  if (ahead > 0 && behind > 0) {
    alerts.push(
      `🔴 GITHUB DIVERGED: ${repoName} (${branch}) is ${ahead} commit(s) ahead` +
      ` AND ${behind} commit(s) behind GitHub! Merge or rebase needed. [checked ${age}]`
    );
  } else if (behind > 0) {
    alerts.push(
      `🟡 GITHUB BEHIND: ${repoName} (${branch}) is ${behind} commit(s) behind` +
      ` GitHub. Run: git pull [checked ${age}]`
    );
  } else if (ahead > 0) {
    alerts.push(
      `🟡 GITHUB AHEAD: ${repoName} (${branch}) is ${ahead} commit(s) ahead` +
      ` of GitHub. Run: git push [checked ${age}]`
    );
  }
  // In sync — no alert needed
}

if (alerts.length > 0) {
  const msg = alerts.join('\n');

  // Structured output → Claude sees it as system-reminder
  // AND user sees it in terminal via stderr
  process.stderr.write('\n' + msg + '\n\n');

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: msg
    }
  };
  process.stdout.write(JSON.stringify(output));
}

// 8. Background process: fetch + update cache for next session
const bgScript = `
const { execFileSync } = require('child_process');
const fs = require('fs');

const cwd = ${JSON.stringify(cwd)};
const branch = ${JSON.stringify(branch)};
const cacheFile = ${JSON.stringify(cacheFile)};
const cacheKey = ${JSON.stringify(cacheKey)};

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd, windowsHide: true, timeout: 30000 }).trim();
  } catch (e) { return null; }
}

// Fetch updates remote tracking refs without touching local branch
git(['fetch', 'origin', '--quiet', '--no-tags']);

// Count divergence
const remoteRef = 'refs/remotes/origin/' + branch;
const behindStr = git(['rev-list', '--count', 'HEAD..' + remoteRef]);
const aheadStr  = git(['rev-list', '--count', remoteRef + '..HEAD']);

const behind = parseInt(behindStr, 10) || 0;
const ahead  = parseInt(aheadStr,  10) || 0;

const result = { key: cacheKey, behind, ahead, checked: Date.now() };
try {
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
} catch (e) {}
`;

const child = spawn(process.execPath, ['-e', bgScript], {
  stdio: 'ignore',
  windowsHide: true,
  detached: true,
  cwd,
});

child.unref();
} catch (e) {
  process.exit(0);
}
