# pi-prewalk

Use a frontier model to understand the task, make the plan, and start the first
edit. Then hand the same conversation to a faster, cheaper model to finish the
implementation and verification.

`pi-prewalk` packages the [Prewalk](https://stencil.so/blog/prewalk) technique
as a standalone [Pi](https://github.com/badlogic/pi-mono) extension. It follows
the todo-gated handoff implemented by
[oh-my-pi](https://github.com/can1357/oh-my-pi) without requiring a Pi fork.

## Why Prewalk

Traditional planner/executor workflows give the expensive model only the plan.
Prewalk gives the executor a richer trajectory:

```text
frontier model                              fast model
──────────────                              ──────────
inspect → reason → plan → todo → first edit → continue → verify
                                      │
                                      └── one conversation, one handoff
```

The frontier model establishes the approach in the actual session, including
tool history and the first concrete implementation decision. The executor then
continues from that exact state.

Stencil's published SWE-Bench Pro experiment reported 97% of frontier-model
performance, 41% lower cost, and 1.9x faster completion. Those numbers are
model- and workload-dependent; benchmark your own model pair before making it
the default.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/ThewindMom/pi-prewalk
```

Restart Pi after installation. To pin this release:

```bash
pi install git:github.com/ThewindMom/pi-prewalk@v0.1.0
```

Pi packages execute code with your user permissions. Review third-party source
before installation.

## Use

Arm Prewalk inside an existing session:

```text
/prewalk google/gemini-2.5-flash
```

The model must already be available and authenticated in Pi. A bare model id is
accepted when it identifies exactly one available model:

```text
/prewalk gemini-2.5-flash
```

Other commands:

```text
/prewalk status
/prewalk off
```

Start Pi with Prewalk enabled:

```bash
pi --prewalk --prewalk-into google/gemini-2.5-flash
```

Or configure the default target through the environment:

```bash
export PI_PREWALK_MODEL=google/gemini-2.5-flash
pi --prewalk
```

## Exact handoff behavior

Prewalk is intentionally conservative:

1. The frontier model gets the task and explores normally.
2. A hidden checkpoint asks it to write a concrete plan and create a todo list.
3. Ordinary `bash`, reads, searches, and the todo call itself do not trigger a
   switch.
4. The first successful `edit`, `write`, or `bash`-driven `apply_patch` after
   todo exists triggers the one-way model switch.
5. If todo is not an active tool, the first successful mutation above triggers
   the switch directly.
6. The executor inherits the plan and tool history, but not the hidden planning
   instruction.
7. A hidden checklist asks the executor to check consistency, scope, and the
   complete relevant test module before finishing.

A failed mutation never triggers the switch. For Senpi compatibility,
`apply_patch` is recognized when it is executed directly or as a pipeline
consumer by a successful `bash` tool call; quoted mentions and shell comments
do not trigger a handoff. Multiple tool calls in one assistant turn produce at
most one handoff because switching occurs at `turn_end`.

## Configuration

| Surface | Meaning |
| --- | --- |
| `/prewalk <provider/model>` | Arm immediately in the current session |
| `/prewalk status` | Show idle, armed, or switched state |
| `/prewalk off` | Cancel an armed handoff |
| `--prewalk` | Arm automatically at session start |
| `--prewalk-into <provider/model>` | Set the automatic executor model |
| `PI_PREWALK_MODEL` | Fallback executor model when the flag is omitted |

State is stored in the Pi session. If the session is resumed, the extension
continues filtering the hidden planning checkpoint from executor context.

## Compatibility

- Pi `0.80.10` or later is the tested baseline.
- The runtime imports are type-only, so the extension has no production
  dependency and can work with compatible Pi distributions exposing the same
  public extension API.
- The target model must be present in Pi's model registry with configured
  credentials.

## Development

```bash
bun install
bun run check
bun qa/manual-driver.ts
```

The test suite uses deterministic fake models. It does not call paid providers.

## Credits

Prewalk was created by [Can Bölük](https://github.com/can1357) and described in
[You only need the frontier model for one single
edit](https://stencil.so/blog/prewalk). This extension adapts the MIT-licensed
implementation and prompts from
[oh-my-pi](https://github.com/can1357/oh-my-pi) to Pi's public extension API.

Maintained by [ThewindMom](https://github.com/ThewindMom).

## License

MIT. See [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
