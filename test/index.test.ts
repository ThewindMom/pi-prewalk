import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfigPath, initialState, parsePrewalkConfig, resolveTarget } from "../src/index.ts";
import { createHarness, fakeModel } from "./harness.ts";

describe("pi-prewalk", () => {
  test("uses Pi's default and configured agent directories", () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      expect(defaultConfigPath()).toBe(join(homedir(), ".pi", "agent", "prewalk.json"));

      process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";
      expect(defaultConfigPath()).toBe(join(homedir(), "custom-pi-agent", "prewalk.json"));

      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
      expect(defaultConfigPath()).toBe("/tmp/pi-agent/prewalk.json");
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });

  test("resolves exact model ids and rejects ambiguous ids", () => {
    const models = [fakeModel("a", "fast"), fakeModel("b", "fast"), fakeModel("b", "unique")];
    expect(resolveTarget("b/fast", models).model).toBe(models[1]);
    expect(resolveTarget("unique", models).model).toBe(models[2]);
    expect(resolveTarget("fast", models).error).toContain("ambiguous");
  });

  test("validates dedicated configuration", () => {
    expect(parsePrewalkConfig({
      enabled: true,
      planner: { model: "frontier/architect", thinking: "medium" },
      executor: { model: "fast/executor", thinking: "low" },
    })).toEqual({
      enabled: true,
      planner: { model: "frontier/architect", thinking: "medium" },
      executor: { model: "fast/executor", thinking: "low" },
    });
    expect(() => parsePrewalkConfig({ enabled: true })).toThrow("executor");
    expect(() => parsePrewalkConfig({
      enabled: false,
      executor: { model: "fast/executor", thinking: "turbo" },
    })).toThrow("thinking");
    expect(() => parsePrewalkConfig({ enabled: false, surprise: true })).toThrow("unknown");
  });

  test("new sessions apply configured planner and executor settings", async () => {
    const harness = createHarness({
      config: {
        enabled: true,
        planner: { model: "frontier/architect", thinking: "medium" },
        executor: { model: "fast/executor", thinking: "low" },
      },
      currentModel: fakeModel("other", "default"),
      models: [
        fakeModel("other", "default"),
        fakeModel("frontier", "architect"),
        fakeModel("fast", "executor"),
      ],
    });
    await harness.start();

    expect(harness.modelChanges.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "frontier/architect",
    ]);
    expect(harness.thinkingChanges).toEqual(["medium"]);
    expect(harness.statuses.get("pi-prewalk")).toContain("fast/executor");

    await harness.turn([{ toolName: "todo" }, { toolName: "edit" }]);
    expect(harness.modelChanges.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "frontier/architect",
      "fast/executor",
    ]);
    expect(harness.thinkingChanges).toEqual(["medium", "low"]);
  });

  test("resume and reload preserve session model and handoff state", async () => {
    const persisted = {
      ...initialState(),
      phase: "armed" as const,
      target: { provider: "fast", id: "executor" },
      executorThinking: "high" as const,
    };
    const resumedModel = fakeModel("resumed", "session-model");
    const harness = createHarness({
      config: {
        enabled: true,
        planner: { model: "frontier/architect", thinking: "medium" },
        executor: { model: "fast/executor", thinking: "low" },
      },
      entries: [{ type: "custom", customType: "pi-prewalk-state", data: persisted }],
      currentModel: resumedModel,
      models: [resumedModel, fakeModel("frontier", "architect"), fakeModel("fast", "executor")],
    });

    await harness.start("resume");
    await harness.start("reload");
    expect(harness.currentModel).toBe(resumedModel);
    expect(harness.modelChanges).toHaveLength(0);
    expect(harness.thinkingChanges).toHaveLength(0);
    expect(harness.statuses.get("pi-prewalk")).toContain("fast/executor");
  });

  test("startup metadata is new but startup conversation is resumed", async () => {
    const config = {
      enabled: true,
      planner: { model: "frontier/architect", thinking: "medium" },
      executor: { model: "fast/executor", thinking: "low" },
    };
    const metadataOnly = createHarness({
      config,
      entries: [
        { type: "model_change", provider: "other", modelId: "default" },
        { type: "thinking_level_change", thinkingLevel: "off" },
      ],
    });
    await metadataOnly.start();
    expect(metadataOnly.statuses.get("pi-prewalk")).toContain("fast/executor");

    const withConversation = createHarness({
      config,
      entries: [{ type: "message", message: { role: "user", content: "existing session" } }],
    });
    await withConversation.start();
    expect(withConversation.statuses.get("pi-prewalk")).toBeUndefined();
    expect(withConversation.modelChanges).toHaveLength(0);
    expect(withConversation.thinkingChanges).toHaveLength(0);
  });

  test("CLI flags override config and can disable automatic arming", async () => {
    const config = {
      enabled: true,
      planner: { model: "frontier/architect", thinking: "medium" },
      executor: { model: "fast/executor", thinking: "low" },
    };
    const disabled = createHarness({ config });
    disabled.flags.set("no-prewalk", true);
    await disabled.start();
    expect(disabled.statuses.get("pi-prewalk")).toBeUndefined();

    const modelOnly = createHarness({
      config,
      activeTools: ["write"],
      models: [
        fakeModel("frontier", "architect"),
        fakeModel("fast", "executor"),
        fakeModel("other", "custom"),
      ],
    });
    modelOnly.flags.set("prewalk-into", "other/custom");
    await modelOnly.start();
    await modelOnly.turn([{ toolName: "write" }]);
    expect(modelOnly.thinkingChanges).toEqual(["medium", "low"]);

    const overridden = createHarness({
      config,
      argv: ["--model", "other/custom", "--thinking", "high"],
      models: [
        fakeModel("frontier", "architect"),
        fakeModel("fast", "executor"),
        fakeModel("other", "custom"),
      ],
    });
    overridden.flags.set("prewalk-into", "other/custom");
    overridden.flags.set("prewalk-executor-thinking", "max");
    await overridden.start();
    expect(overridden.modelChanges).toHaveLength(0);
    expect(overridden.thinkingChanges).toHaveLength(0);
    expect(overridden.statuses.get("pi-prewalk")).toContain("other/custom");
    await overridden.turn([{ toolName: "todo" }, { toolName: "write" }]);
    expect(overridden.thinkingChanges).toEqual(["max"]);
  });

  test("session command overrides configured executor thinking", async () => {
    const harness = createHarness({
      config: {
        enabled: false,
        executor: { model: "fast/executor", thinking: "low" },
      },
      activeTools: ["write"],
    });
    await harness.start();
    await harness.command("fast/executor high");
    await harness.turn([{ toolName: "write" }]);
    expect(harness.thinkingChanges).toEqual(["high"]);
  });

  test("invalid configuration is reported without changing the session", async () => {
    const harness = createHarness({ config: { enabled: true } });
    await harness.start();
    expect(harness.notifications[0]).toEqual({
      message: expect.stringContaining("Invalid prewalk.json"),
      level: "error",
    });
    expect(harness.modelChanges).toHaveLength(0);
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

  test("successful apply_patch tool switches after todo", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("fast/executor");

    await harness.turn([{ toolName: "todo" }]);
    await harness.turn([{ toolName: "apply_patch" }]);

    expect(harness.modelChanges.map((model) => `${model.provider}/${model.id}`)).toEqual(["fast/executor"]);
    expect(harness.notifications.at(-1)?.message).toContain("after the first apply_patch");
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

  test("same-model target scrubs the plan without a redundant handoff", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.command("frontier/architect high");

    await harness.turn([{ toolName: "todo" }]);
    await harness.turn([{ toolName: "edit" }]);

    expect(harness.currentModel.id).toBe("architect");
    expect(harness.modelChanges).toHaveLength(0);
    expect(harness.sent.at(-1)?.message.customType).not.toBe("pi-prewalk-checklist");
    expect(harness.notifications.some(({ message }) => message.includes("switched"))).toBe(false);
    expect(harness.entries.at(-1)?.data).toMatchObject({ phase: "idle", scrubPlan: true });
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
