# Claude Code Statusline

A feature-rich, single-file Node.js statusline for [Claude Code](https://claude.ai/code).
One line at the bottom of your terminal that tells you everything you actually need:
which model you're on, what task is in progress, the live git state of your repo, how
much context you've burned, your prompt-cache hit/write state, and your subscription
rate limits.

No dependencies. No build step. Works on macOS, Linux, and Windows.

## Preview

```
claude-opus-4-7 │ Writing README │ my-project (main) │ 3 uncommitted ↑2 push ⚠ md drift │ ████░░░░░░ 40% │ cache ↓75k +360 1h │ 5h:35%(2h15m) 7d:42%
```

Each segment is color-coded (dim, bright, cyan, pink, yellow, orange, red) so the
shape of the line itself communicates urgency at a glance.

## What you see, left to right

| Segment | Meaning |
|---------|---------|
| `claude-opus-4-7` | Current model (dim) |
| `Writing README` | Active task — pulled from your in-progress TODO (bold) |
| `my-project (main)` | Working directory basename (dim) + current branch in cyan; shows `(HEAD@<sha>)` in red for detached HEAD |
| `3 uncommitted` | Untracked + modified files in the repo (dim) |
| `↑2 push` / `↓1 pull` | Local branch is ahead/behind `origin/<branch>` |
| `⚠ md drift` | `CLAUDE.md` ↔ `AGENTS.md` ↔ `GEMINI.md` are out of sync |
| `████░░░░░░ 40%` | Context window usage, adjusted for the auto-compact buffer |
| `cache ↓75k +360 1h` | Prompt cache state from the session transcript: `↓` tokens read from cache (90% discount), `+` or `↑` tokens written, optional `1h` for extended TTL |
| `5h:35%(2h15m)` | 5-hour rate limit usage + reset countdown |
| `7d:42%` | 7-day rate limit usage |

The context bar and rate-limit percentages share the same color scale:

| Used | Color |
|------|-------|
| < 50% | pink |
| 50-65% | yellow |
| 65-80% | orange |
| ≥ 80% | red with a 💀 prefix on the context bar |

## Installation

1. **Clone or download** this repo.
2. **Drop `statusline.js`** anywhere you like. The natural location is `~/.claude/hooks/statusline.js`.
3. **Wire it up** in `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"/absolute/path/to/statusline.js\"",
       "refreshInterval": 60
     }
   }
   ```

   On Windows use forward slashes inside the JSON string: `"node \"C:/Users/you/.claude/hooks/statusline.js\""`.

   `refreshInterval: 60` re-runs the script every 60 seconds in addition to event-driven updates (new assistant message, `/compact`, permission mode change, vim mode toggle). Without it, the cache TTL countdown freezes in idle — Claude Code only refreshes the statusline on those events, so a value rendered 50 minutes ago will keep showing `60m remaining` until you press Enter. 60 seconds is enough to step through the color thresholds (dim → yellow → red) cleanly while staying cheap (the script only reads the last 16 KB of the session transcript). Requires Claude Code ≥2.1.97.

4. **Restart Claude Code.** That's it.

The script reads the standard Claude Code statusline JSON from stdin (model,
workspace, session, context window, rate limits) and writes a single ANSI-coloured
line to stdout. It exits silently on any error so a broken statusline never blocks your
session.

## Optional companion hooks

### Why MD sync matters

Different coding agents read different memory files from your project root:

- **Claude Code** reads `CLAUDE.md`
- **OpenAI Codex** (and most agent-spec compliant tools) read `AGENTS.md`
- **Gemini CLI** reads `GEMINI.md`

If you use more than one agent on the same project, all three need to contain the
same project context — coding conventions, deploy instructions, "don't touch X"
rules. The moment they drift apart, one agent is following outdated rules while the
others aren't, and you start getting inconsistent behavior across tools without
knowing why. Worse: you update one file, forget the other two, and a week later a
different agent confidently violates a rule you thought you'd written down.

The drift detector turns this from an invisible bug into a visible one. The
`sync-md.js` hook below goes further and removes the manual work entirely: edit
`CLAUDE.md` and the other two regenerate from it automatically.

### The hooks

The MD-drift detector inside `statusline.js` only lights up if your project actually
keeps `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` as a synchronized trio. The
[`optional-hooks/`](./optional-hooks/) folder contains three small hooks that make
the rest of the experience whole:

- **`md-sync-check.js`** — `SessionStart` hook. Warns Claude (via `additionalContext`) when the trio drifts.
- **`sync-md.js`** — `PostToolUse` hook. When you `Edit`/`Write` `CLAUDE.md`, it auto-mirrors the content into `AGENTS.md` and `GEMINI.md`, rewriting the per-file `Sync:` line.
- **`github-sync-check.js`** — `SessionStart` hook. Warns about uncommitted files and tells you when your branch has drifted from `origin/<branch>`. Runs `git fetch` in the background so the next session has fresh data.

See [`optional-hooks/README.md`](./optional-hooks/README.md) for installation snippets.
None of them are required for the statusline itself to work.

## How it stays fast

- **All git checks are local.** No `git fetch`, no network, hard 1s timeout per command.
- **Bridge file in `os.tmpdir()`.** The context-usage value is written to `claude-ctx-{session_id}.json` so other hooks (e.g. a `PostToolUse` context monitor) can read the same number without re-parsing stdin.
- **Auto-compact buffer correction.** Claude Code reserves ~16.5% of the window for auto-compaction. The displayed percentage is *usable* context spent, not raw — so 100% means you're actually about to hit the wall, not 16.5% before it.
- **Stdin timeout (3s)** — if Claude Code never sends data, the script exits cleanly instead of hanging.

## Cross-platform notes

- **Windows:** the script uses `windowsHide: true` on every `execSync` call, so no
  console flashes appear during git polling.
- **Path separators:** built on `path.join` and `os.homedir()` throughout, no
  hard-coded `/` or `\`.

## Customization

The script is ~210 lines of dependency-free Node.js. Open it and tweak.
The most common customizations:

- **Hide the cache segment** — delete the `Prompt cache state` block. Useful if you don't run Claude Code in this terminal or don't want token counts visible.
- **Change the colour thresholds** — search for `< 50` / `< 65` / `< 80` and edit.
- **Hide the model name** — remove `\`\x1b[2m${model}\x1b[0m\`` from the `segments` array at the bottom.
- **Use a different separator** — change `' │ '` (the `│` character) on the final line.

## Requirements

- Node.js (any modern version — uses only built-in modules)
- Claude Code with statusline support (`statusLine` in `settings.json`)
- Optional: `git` on `PATH` for the git-status segment

## License

MIT — see [LICENSE](./LICENSE).

## Credits

Built by [Ilya Pluzhnikov](https://github.com/RaiconY).
PRs and forks welcome.
