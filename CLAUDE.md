# claude-code-statusline

> **Sync:** Any changes to this file must also be applied to `AGENTS.md` and `GEMINI.md`.

A single-file Node.js statusline for Claude Code, plus three optional companion hooks that keep `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` in sync and surface git state at session start.

## Project shape

- `statusline.js` — entry point. Reads JSON from stdin (model, workspace, session_id, context_window, rate_limits) and writes one ANSI-coloured line to stdout.
- `optional-hooks/md-sync-check.js` — SessionStart drift detector for the CLAUDE/AGENTS/GEMINI trio.
- `optional-hooks/sync-md.js` — PostToolUse mirror: writes CLAUDE.md → AGENTS.md + GEMINI.md, swapping the `Sync:` line per file.
- `optional-hooks/github-sync-check.js` — SessionStart git status + cached `origin` divergence + background fetch for next session.

## Rules for contributors (and AI agents)

- **No dependencies.** Everything is built-in Node.js (`fs`, `path`, `os`, `child_process`). Don't add a `package.json` with deps. If a feature needs an npm package, the answer is probably "the feature doesn't belong here".
- **Single-file per concern.** `statusline.js` is one file. Each hook is one file. No build step, no transpiler.
- **Exit 0 on any error.** A broken hook must never block the user's tool call. Wrap risky logic in `try`/`catch` and `process.exit(0)` on failure. Same for `statusline.js` — empty output is acceptable, a thrown error that breaks Claude Code's UI is not.
- **Hot-path budget.** `statusline.js` is invoked on every status refresh. No network, no `git fetch` on the hot path. Use bridge files in `os.tmpdir()` and background `spawn(detached: true).unref()` for anything that takes >100ms.
- **Hide on happy path.** Segments only appear when they have something to say. `0 uncommitted` is invisible. `↑0 push` is invisible. Add new segments with the same discipline.
- **Cross-platform.** Use `path.join`, `os.homedir()`, `windowsHide: true` on every `execSync`. No hard-coded `/` or `\`. No assumptions about which shell.

## Editing this file

If `sync-md.js` is installed in your Claude Code, editing this file auto-updates `AGENTS.md` + `GEMINI.md`. If not — edit all three by hand and commit them together. The drift detector will yell otherwise.

**First-time bootstrap is always manual.** `sync-md.js` only fires when `AGENTS.md` and `GEMINI.md` already exist next to the edited `CLAUDE.md` (safety guard for unrelated projects). The first commit must contain all three files.

## Testing

Manual. Pipe a sample statusline JSON into the script:

```bash
echo '{"model":{"display_name":"claude-opus-4-7"},"workspace":{"current_dir":"."},"session_id":"test","context_window":{"remaining_percentage":60}}' | node statusline.js
```

Visual inspection is the test suite. There is no CI yet.

## License

MIT — see `LICENSE`.
