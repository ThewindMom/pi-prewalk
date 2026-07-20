export const PREWALK_PLAN_PROMPT = `Stop and write the complete plan in your NEXT reply — before any further exploration. You have already seen enough to commit to a plan; do not defer this.

First, state the plan itself, explicitly and comprehensively:

- Every remaining step in execution order, with the exact files, symbols, commands, and checks involved.
- Known risks, edge cases, and how you will verify each step actually landed. Never modify tests or verification assets to make checks pass.
- What is already done, stated briefly, so no step gets repeated.

Be thorough and concrete — this plan is the reference for the remainder of the run. You may verify details with tools after the plan is written, never before.

Then, only once the plan above is complete, in the SAME reply, capture it with the active todo tool: 5-9 meaningful implementation and verification items. The todo list serves the task, never the reverse.

This is a checkpoint, not a final answer. After recording the todo list, continue the task; do not stop here.`;

export const PREWALK_CONTINUE_PROMPT = "Continue the task now — do not end your turn here.";

export const PREWALK_CHECKLIST_PROMPT = `Before you consider this task finished, verify:

- Consistency: if you changed a pattern, signature, or check in one place, search for every other call site or duplicate copy that needs the identical change.
- Scope: if your diff does more than the minimal change needed, confirm behavior outside the request has not changed.
- Verification: run the full test module or file the issue lives in, not just the one test you expect to flip.

Do not claim the task is complete until these checks are done.`;
