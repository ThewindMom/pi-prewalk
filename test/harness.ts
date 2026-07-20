import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PrewalkThinkingLevel } from "../src/index.ts";
import { createPrewalkExtension } from "../src/index.ts";

type Handler = (event: any, context: ExtensionContext) => Promise<any> | any;
type Command = { handler: (args: string, context: ExtensionContext) => Promise<void> | void };

export interface SentMessage {
  message: { customType: string; content: unknown; display?: boolean };
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

export function fakeModel(provider: string, id: string): Model<any> {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as Model<any>;
}

export function createHarness(options?: {
  entries?: Array<{ type: string; customType?: string; data?: unknown; [key: string]: unknown }>;
  activeTools?: string[];
  models?: Model<any>[];
  config?: unknown;
  configError?: Error;
  argv?: string[];
  currentModel?: Model<any>;
  setModelResult?: boolean;
  unauthenticatedModels?: string[];
}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const flags = new Map<string, boolean | string>();
  const entries = [...(options?.entries ?? [])];
  const sent: SentMessage[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const modelChanges: Model<any>[] = [];
  const thinkingChanges: PrewalkThinkingLevel[] = [];
  const models = options?.models ?? [fakeModel("frontier", "architect"), fakeModel("fast", "executor")];
  let activeTools = options?.activeTools ?? ["read", "bash", "edit", "write", "todo"];
  let currentModel = options?.currentModel ?? models[0];
  let processing = false;
  let streaming = false;

  const context = {
    ui: {
      notify: (message: string, level?: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      theme: { fg: (_color: string, text: string) => text },
    },
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    sessionManager: { getEntries: () => entries },
    modelRegistry: {
      getAvailable: () => models,
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: (model: Model<any>) => !options?.unauthenticatedModels?.includes(
        `${model.provider}/${model.id}`,
      ),
    },
    get model() {
      return currentModel;
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
  } as unknown as ExtensionContext;

  const pi = {
    registerFlag: (name: string, definition: { default?: boolean | string }) => {
      if (definition.default !== undefined) flags.set(name, definition.default);
    },
    getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: Handler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message: SentMessage["message"], sendOptions?: SentMessage["options"]) => {
      if (processing && !streaming && sendOptions?.triggerTurn) {
        throw new Error("Agent is already processing a prompt.");
      }
      sent.push({ message, options: sendOptions });
    },
    getActiveTools: () => activeTools,
    setModel: async (model: Model<any>) => {
      if (options?.setModelResult === false) return false;
      currentModel = model;
      modelChanges.push(model);
      return true;
    },
    getThinkingLevel: () => thinkingChanges.at(-1) ?? "off",
    setThinkingLevel: (level: PrewalkThinkingLevel) => thinkingChanges.push(level),
  } as unknown as ExtensionAPI;

  const readConfig = options && ("config" in options || "configError" in options)
    ? () => {
      if (options.configError) throw options.configError;
      return JSON.stringify(options.config);
    }
    : () => {
      const error = new Error("missing") as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    };
  createPrewalkExtension({ configPath: "/test/prewalk.json", readConfig, argv: options?.argv ?? [] })(pi);

  async function emit(name: string, event: unknown): Promise<any[]> {
    const results: any[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, context));
    return results;
  }

  return {
    entries,
    sent,
    notifications,
    statuses,
    modelChanges,
    thinkingChanges,
    flags,
    get currentModel() {
      return currentModel;
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
    async start(reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup") {
      await emit("session_start", { type: "session_start", reason });
    },
    async command(args: string) {
      const command = commands.get("prewalk");
      if (!command) throw new Error("prewalk command not registered");
      await command.handler(args, context);
    },
    async turn(toolResults: Array<{
      toolName: string;
      isError?: boolean;
      arguments?: Record<string, unknown>;
    }> = []) {
      const message = {
        role: "assistant",
        content: toolResults.map((result, index) => ({
          type: "toolCall",
          id: `tool-${index}`,
          name: result.toolName,
          arguments: result.arguments ?? {},
        })),
        timestamp: Date.now(),
      };
      processing = true;
      try {
        streaming = true;
        await emit("message_end", { type: "message_end", message });
        streaming = false;
        await emit("turn_end", {
          type: "turn_end",
          turnIndex: 0,
          message,
          toolResults: toolResults.map((result, index) => ({
            role: "toolResult",
            toolCallId: `tool-${index}`,
            toolName: result.toolName,
            content: [],
            isError: result.isError ?? false,
            timestamp: Date.now(),
          })),
        });
      } finally {
        streaming = false;
        processing = false;
      }
    },
    async filterContext(messages: unknown[]) {
      const [result] = await emit("context", { type: "context", messages });
      return result?.messages ?? messages;
    },
  };
}
