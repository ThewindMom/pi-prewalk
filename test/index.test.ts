import { describe, expect, test } from "bun:test";
import { initialState, resolveTarget } from "../src/index.ts";
import { createHarness, fakeModel } from "./harness.ts";

describe("pi-prewalk", () => {
  test("resolves exact model ids and rejects ambiguous ids", () => {
    const models = [fakeModel("a", "fast"), fakeModel("b", "fast"), fakeModel("b", "unique")];
    expect(resolveTarget("b/fast", models).model).toBe(models[1]);
    expect(resolveTarget("unique", models).model).toBe(models[2]);
    expect(resolveTarget("fast", models).error).toContain("ambiguous");
  });

  test("manual command arms and injects the hidden plan", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    expect(harness.sent[0].message.customType).toStartWith("pi-prewalk-plan:");
    expect(harness.sent[0].message.display).toBe(false);
    expect(harness.statuses.get("pi-prewalk")).toContain("fast/executor");
  });

  test("ordinary bash and todo do not switch; first edit after todo does", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    await harness.turn([{ toolName: "bash" }]);
    await harness.turn([{ toolName: "todo" }]);
    expect(harness.modelChanges).toHaveLength(0);

    await harness.turn([{ toolName: "edit" }]);
    expect(harness.modelChanges.map((model) => `${model.provider}/${model.id}`)).toEqual(["fast/executor"]);
    expect(harness.sent.at(-1)?.message.customType).toBe("pi-prewalk-checklist");
  });

  test("successful bash apply_patch switches after todo", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    await harness.turn([{ toolName: "todo" }]);
    await harness.turn([{
      toolName: "bash",
      arguments: { command: "printf 'apply_patch is available'" },
    }]);
    await harness.turn([{
      toolName: "bash",
      arguments: { command: "printf '%s' 'printf patch | apply_patch'" },
    }]);
    await harness.turn([{
      toolName: "bash",
      arguments: { command: "printf patch # | apply_patch" },
    }]);
    await harness.turn([{
      toolName: "bash",
      isError: true,
      arguments: { command: "printf '%s\\n' '*** Begin Patch' '*** End Patch' | apply_patch" },
    }]);
    expect(harness.modelChanges).toHaveLength(0);

    await harness.turn([{
      toolName: "bash",
      arguments: { command: "printf '%s\\n' '*** Begin Patch' '*** End Patch' | apply_patch" },
    }]);
    expect(harness.modelChanges.map((model) => `${model.provider}/${model.id}`)).toEqual(["fast/executor"]);
    expect(harness.notifications.at(-1)?.message).toContain("after the first apply_patch");
  });

  test("successful direct apply_patch heredoc switches after todo", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    await harness.turn([{ toolName: "todo" }]);
    await harness.turn([{
      toolName: "bash",
      arguments: { command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH" },
    }]);

    expect(harness.modelChanges.map((model) => `${model.provider}/${model.id}`)).toEqual(["fast/executor"]);
  });

  test("edit before todo waits for a later edit", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    await harness.turn([{ toolName: "edit" }]);
    expect(harness.modelChanges).toHaveLength(0);
    await harness.turn([{ toolName: "todo" }, { toolName: "edit" }]);
    expect(harness.modelChanges).toHaveLength(1);
  });

  test("inactive todo tool opens the action gate", async () => {
    const harness = createHarness({ activeTools: ["read", "edit", "write"] });
    await harness.start();
    await harness.command("fast/executor");
    await harness.turn([{ toolName: "write" }]);
    expect(harness.modelChanges).toHaveLength(1);
  });

  test("failed mutations never switch models", async () => {
    const harness = createHarness({ activeTools: ["read", "edit"] });
    await harness.start();
    await harness.command("fast/executor");
    await harness.turn([{ toolName: "edit", isError: true }]);
    expect(harness.modelChanges).toHaveLength(0);
  });

  test("text-only planning continuation is bounded", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    await harness.turn();
    expect(harness.sent[0].message.customType).toStartWith("pi-prewalk-plan:");
    expect(harness.sent[1].message.customType).toBe("pi-prewalk-continue");
    await harness.turn();
    expect(harness.sent).toHaveLength(2);
  });

  test("executor context excludes the hidden planning instruction", async () => {
    const harness = createHarness({ activeTools: ["edit"] });
    await harness.start();
    await harness.command("fast/executor");
    await harness.turn([{ toolName: "edit" }]);

    const filtered = await harness.filterContext([
      { role: "custom", customType: harness.sent[0].message.customType, content: "hidden" },
      { role: "assistant", content: "the plan" },
    ]);
    expect(filtered).toEqual([{ role: "assistant", content: "the plan" }]);
  });

  test("persisted switched state keeps plan scrubbing on resume", async () => {
    const persisted = {
      ...initialState(),
      phase: "switched" as const,
      target: { provider: "fast", id: "executor" },
      planMessageType: "pi-prewalk-plan:restored",
      planInjected: true,
      scrubPlan: true,
    };
    const harness = createHarness({
      entries: [{ type: "custom", customType: "pi-prewalk-state", data: persisted }],
    });
    await harness.start();
    const filtered = await harness.filterContext([
      { role: "custom", customType: "pi-prewalk-plan:restored", content: "hidden" },
    ]);
    expect(filtered).toEqual([]);
  });

  test("startup flags arm after the frontier model gets its first turn", async () => {
    const harness = createHarness();
    harness.flags.set("prewalk", true);
    harness.flags.set("prewalk-into", "fast/executor");
    await harness.start();
    expect(harness.sent).toHaveLength(0);

    await harness.turn([{ toolName: "read" }]);
    expect(harness.sent[0].message.customType).toStartWith("pi-prewalk-plan:");
    expect(harness.modelChanges).toHaveLength(0);
  });

  test("off disables an armed handoff and scrubs its stale plan", async () => {
    const harness = createHarness({ activeTools: ["edit"] });
    await harness.start();
    await harness.command("fast/executor");
    await harness.command("off");
    await harness.turn([{ toolName: "edit" }]);
    expect(harness.modelChanges).toHaveLength(0);
    expect(await harness.filterContext([
      { role: "custom", customType: harness.sent[0].message.customType, content: "hidden" },
    ])).toEqual([]);
  });

  test("rearming exposes only the current planning checkpoint", async () => {
    const harness = createHarness({ activeTools: ["edit"] });
    await harness.start();
    await harness.command("fast/executor");
    const firstPlanType = harness.sent[0].message.customType;
    await harness.command("off");
    await harness.command("fast/executor");
    const secondPlanType = harness.sent.at(-1)?.message.customType;

    const filtered = await harness.filterContext([
      { role: "custom", customType: firstPlanType, content: "old" },
      { role: "custom", customType: secondPlanType, content: "current" },
    ]);
    expect(filtered).toEqual([{ role: "custom", customType: secondPlanType, content: "current" }]);
  });
});
