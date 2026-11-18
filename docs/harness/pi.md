# pstack in Pi

Read this contract before following any pstack skill in this session, then keep it for the whole session. `<pstack>` is this package's directory. This contract overrides runtime-specific tool, model, and path assumptions in the upstream skill text. Repository `AGENTS.md` gates (coding, testing, git rules) are constraints inside the pstack flow, not a replacement for it.

## Playbooks and checklist

- On a task, match it to a playbook and open `<pstack>/skills/poteto-mode/playbooks/<title>.md` before any task-specific work. Copy the playbook's steps verbatim into a visible checklist and keep it updated: each step is done, in progress, or carries a `skip: <reason>` line.
- Pi has no task-tracking tool. The checklist is an uncommitted `todo.md` in the work dir (`.audit/<task-slug>.todo.md` when sessions share the checkout), holding the playbook steps verbatim plus task todos.

## Delegation

- The Claude Code `Task` tool is Pi's `Agent` tool.
- Playbook-step code delegates and helpers use `subagent_type: "poteto-agent"` (bare name; likewise `comment-sicko`). The namespaced form `pstack:poteto-agent` does not exist on Pi.
- Spawn in the background (`run_in_background: true`) and continue independent work; inspect the diff and results yourself before using them.
- Fresh subagents by default, with consolidated scope. The parent owns every subagent's work.
- A review gate stays closed when no independent reviewer can run; record `BLOCKED: independent review` in the checklist.

## Models

- The role model names in the skill text (`fable`, `opus`, `sonnet`, `haiku`) are configured presets in `~/.pi/agent/pstack-models.md`, one per line: `fable: provider/modelId @level`. Pass the bare alias in the `model` field; the preset routes to the configured physical model and reasoning level.
- Pass reasoning adjustments in the `thinking` field; the preset forwards the level to the physical model.
- If a preset is not configured or the tool rejects the name, omit `model` so the child inherits the parent model, and say so in your reply.

## Tool mapping

| Upstream | Pi |
| --- | --- |
| `Task` | `Agent` |
| `AskUserQuestion` | Ask in conversation and wait |
| Todolist tool | `todo.md` checklist per above |
| Run another pstack skill | Resolve it through Pi's skill list (`/skill:<name>`), read its `SKILL.md` in full |
| Principles (not listed to the model) | Read `<pstack>/skills/<name>/SKILL.md` by path |
| `/deslop` | Apply the cleanup procedure to the diff: remove redundant narration, speculative scaffolding, forwarding-only helpers, catches that hide failures; keep behavior and required checks |
| `Grep`, `Glob` | `bash` with `rg` / `find`, and `read` for contents |
| Cursor paths `.cursor/...` | `.pi/skills/`, `~/.pi/agent/...` |
| Transcripts `~/.cursor/projects/...` | `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/` |
