# Changelog

## 0.2.1 - 2026-07-20

- Queue planning and continuation prompts while Pi is still streaming so the
  extension uses `steer()` instead of attempting a nested prompt.
- Append the executor checklist at the mutation turn boundary without starting
  another prompt while the current agent request is still processing.
- Model Pi's processing-versus-streaming lifecycle in the regression harness.

## 0.2.0 - 2026-07-20

- Use Pi's official `getAgentDir()` API and `PI_CODING_AGENT_DIR` for
  `~/.pi/agent/prewalk.json` configuration.
- Declare the official Pi coding-agent package as a runtime dependency.
- Add validated persistent planner and executor model and thinking settings.
- Apply persistent defaults only to new sessions while preserving model,
  thinking, and Prewalk state on resume, fork, and reload.
- Add explicit CLI and session-local overrides with documented precedence.
- Recognize Pi's direct `apply_patch` tool as a successful mutation.
- Recognize successful `bash`-driven `apply_patch` mutations so Pi can hand
  off after its required patch workflow.
- Keep ordinary and failed shell commands from triggering the model switch.
- Avoid redundant handoff notices and checklist prompts when the executor is
  already the active model.
- Add Pi-path, same-model, lifecycle, gating, persistence, and handoff
  regression coverage.

## 0.1.0 - 2026-07-20

- Add todo-gated frontier-to-executor model handoff.
- Add `/prewalk`, `--prewalk`, and `--prewalk-into` controls.
- Persist handoff state across session resume.
- Hide planning checkpoints from executor context.
- Add bounded continuation and final verification prompts.
- Prevent failed edits and writes from triggering a switch.
- Cover model resolution, gating, continuation, context filtering, rearming,
  persistence, and startup flags with deterministic tests.
