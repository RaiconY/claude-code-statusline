# Optional Hooks

Three small Claude Code hooks that pair well with `statusline.js`. Each is
independent — install one, two, or all three. None of them block your tools on
failure (they all `process.exit(0)` on any error).

| Hook | Event | Purpose |
|------|-------|---------|
| [`md-sync-check.js`](#md-sync-checkjs) | `SessionStart` | Warns Claude when `CLAUDE.md` ↔ `AGENTS.md` ↔ `GEMINI.md` drift apart |
| [`sync-md.js`](#sync-mdjs) | `PostToolUse` (Edit/Write/MultiEdit) | Auto-mirrors `CLAUDE.md` into `AGENTS.md` and `GEMINI.md` |
| [`github-sync-check.js`](#github-sync-checkjs) | `SessionStart` | Warns about uncommitted files and `origin` divergence |

Recommended placement: drop the files into `~/.claude/hooks/` to keep them
alongside `statusline.js`.

---

## `md-sync-check.js`

**What it does.** Reads the three sibling files (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`) at session start, normalizes line endings and the per-file `Sync:`
line, then compares both line count and content. On drift, it emits an
`additionalContext` block that surfaces inside Claude's session-start system
reminder — so the agent itself sees the warning and can act on it.

**No-op when safe.** If any of the three files is missing, the hook exits silently.
This means it never warns about projects that don't use the synced-trio convention.

**Install.**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/optional-hooks/md-sync-check.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

---

## `sync-md.js`

**What it does.** Watches for `Edit`, `Write`, or `MultiEdit` calls on any file
named `CLAUDE.md`. When one fires, it copies the new content into `AGENTS.md` and
`GEMINI.md` in the same directory, swapping the `Sync:` line so each file references
its two siblings correctly. Surfaces `✓ sync-md: CLAUDE.md → AGENTS.md + GEMINI.md`
as a visible system message after a successful sync.

**Safety.** Only fires when **both** `AGENTS.md` and `GEMINI.md` already exist next
to the edited `CLAUDE.md` — projects that don't use the trio are untouched.

**Pairs with `md-sync-check.js`** — that one *detects* drift, this one *prevents*
it. With both installed, you edit `CLAUDE.md` and the other two stay in sync forever.

**Install.**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/optional-hooks/sync-md.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

---

## `github-sync-check.js`

**What it does.** On session start, surfaces three classes of warnings so you don't
sleepwalk into a dirty merge:

- 🟡 **Uncommitted changes** — count of files with local modifications
- 🟡 **Behind `origin`** — local branch trails the remote (suggests `git pull`)
- 🟡 **Ahead of `origin`** — local has unpushed commits (suggests `git push`)
- 🔴 **Diverged** — both ahead and behind, requires merge or rebase

Warnings are written to **both** stderr (visible in your terminal) and the agent's
system reminder via `additionalContext` (so Claude sees them too).

**How it stays fast.** The session-start check is purely local — no network. After
emitting whatever the previous session cached, it spawns a *detached* background
process that runs `git fetch origin --quiet --no-tags` and writes the fresh
ahead/behind counts to `~/.claude/cache/github-sync.json`. The next time you start
a session, that fresh data is what shows up. So the warning you see is always one
session stale — but you pay zero startup cost for it.

**Skips silently** when:

- Not inside a git repo
- The remote isn't `github.com`
- You're in detached HEAD state

**Install.**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/optional-hooks/github-sync-check.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## Combined snippet (all three + the statusline)

If you want everything wired up at once, here's the full block to merge into
`~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.js\"",
    "refreshInterval": 60
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"/absolute/path/to/optional-hooks/github-sync-check.js\"", "timeout": 10 },
          { "type": "command", "command": "node \"/absolute/path/to/optional-hooks/md-sync-check.js\"",      "timeout": 5  }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node \"/absolute/path/to/optional-hooks/sync-md.js\"", "timeout": 5 }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/` with whatever you used (e.g. `C:/Users/you/.claude/hooks/`
on Windows). Restart Claude Code afterwards.
