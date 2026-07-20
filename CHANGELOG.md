# Changelog

## Unreleased

- Recognize successful `bash`-driven `apply_patch` mutations so Senpi can hand
  off after its required patch workflow.
- Keep ordinary and failed shell commands from triggering the model switch.

## 0.1.0 - 2026-07-20

- Add todo-gated frontier-to-executor model handoff.
- Add `/prewalk`, `--prewalk`, and `--prewalk-into` controls.
- Persist handoff state across session resume.
- Hide planning checkpoints from executor context.
- Add bounded continuation and final verification prompts.
- Prevent failed edits and writes from triggering a switch.
- Cover model resolution, gating, continuation, context filtering, rearming,
  persistence, and startup flags with deterministic tests.
