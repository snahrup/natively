import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { buildPromptContextBlock, ContextRetrievalBroker } from "./context";
import { buildClaudeCliEnv } from "./services/ClaudeCliEnvironment";
import { buildLocalCliInvocation, type LocalCliProvider } from "./services/CliProviderResolver";
import { ContinuousOCRService } from "./services/ContinuousOCRService";
import { buildIPCorpContext, buildIPCorpSystemPrompt } from "./services/IPCorpContextBuilder";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type ActiveProvider = "claude" | "codex";

type ChatOptions = {
  ignoreKnowledgeMode?: boolean;
  skipRetrievedContext?: boolean;
  skipIPCorpSystemPrompt?: boolean;
  skipScreenContext?: boolean;
  requestProfile?: "default" | "realtime";
  responseSchema?: Record<string, unknown>;
  /** Real streaming: invoked with each incremental text delta as the CLI produces it. */
  onToken?: (token: string) => void;
  /** Cancellation: aborting kills the underlying CLI process tree immediately. */
  abortSignal?: AbortSignal;
};

type ReviewInput = {
  text: string;
  reviewType: "voice_pass" | "technical_check";
  sourceIntent?: string;
};

type ReviewOutput = {
  reviewType: "voice_pass" | "technical_check";
  reviewerModel: string;
  text: string;
  error?: string;
};

type KnowledgeModeResult = {
  shortCircuit?: string;
  systemPrompt?: string;
  context?: string;
};

type PreparedPrompt = {
  systemPrompt?: string;
  userPrompt: string;
};

type CliRequest = {
  provider: ActiveProvider;
  model: string;
  systemPrompt?: string;
  prompt: string;
  imagePaths?: string[];
  requestProfile?: "default" | "realtime";
  responseSchema?: Record<string, unknown>;
  reasoningEffort?: ReasoningEffort;
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
};

type CodexRequestProfile = {
  effort: ReasoningEffort;
  timeoutMs: number;
  reason: string;
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Natively, a local-first desktop meeting and workflow assistant.",
  "Be direct, precise, and useful.",
  "Prefer concise answers unless the task clearly requires detail.",
  "If context is provided, ground your response in it instead of inventing missing facts.",
].join("\n");

function loadCascadeProjectsEnv(): void {
  const envPath = path.join(os.homedir(), "CascadeProjects", ".env");
  if (!fs.existsSync(envPath)) return;

  try {
    for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const [rawKey, ...rawValueParts] = line.split("=");
      const key = rawKey.trim();
      if (!key || process.env[key]) continue;
      process.env[key] = rawValueParts.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch (error) {
    console.warn("[LLMHelper] Failed to load CascadeProjects AI defaults:", error);
  }
}

loadCascadeProjectsEnv();

const DEFAULT_CLAUDE_MODEL = process.env.AI_CLAUDE_MODEL?.trim() || "claude-opus-4-8";
const DEFAULT_CLAUDE_EFFORT = process.env.AI_CLAUDE_EFFORT?.trim() || "max";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CLI_REQUEST_TIMEOUT_MS = 180_000;

const SUPPORTED_CLAUDE_MODELS = new Set([
  DEFAULT_CLAUDE_MODEL,
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
]);

const SUPPORTED_CODEX_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  "claude-max": DEFAULT_CLAUDE_MODEL,
  "claude-max-opus": DEFAULT_CLAUDE_MODEL,
  "claude-max-opus-4-8": DEFAULT_CLAUDE_MODEL,
  "claude-opus-4-8": DEFAULT_CLAUDE_MODEL,
  "claude-max-opus-4-7": DEFAULT_CLAUDE_MODEL,
  "claude-opus-4-7": DEFAULT_CLAUDE_MODEL,
  "claude-max-opus-4-6": DEFAULT_CLAUDE_MODEL,
  "claude-opus-4-6": DEFAULT_CLAUDE_MODEL,
  "claude-max-sonnet": "claude-sonnet-4-6",
  "claude-max-sonnet-4-6": "claude-sonnet-4-6",
  codex: DEFAULT_CODEX_MODEL,
  "codex-gpt-5.5": DEFAULT_CODEX_MODEL,
  "codex-gpt-5.4": "gpt-5.4",
  "codex-gpt-5.4-mini": "gpt-5.4-mini",
  "codex-gpt-5.3-codex": DEFAULT_CODEX_MODEL,
  "codex-gpt-5.3-codex-spark": DEFAULT_CODEX_MODEL,
  "codex-gpt-5.2": DEFAULT_CODEX_MODEL,
  "gpt-5-codex": DEFAULT_CODEX_MODEL,
  "gpt-5.3-codex": DEFAULT_CODEX_MODEL,
  "gpt-5.3-codex-spark": DEFAULT_CODEX_MODEL,
  "gpt-5.2": DEFAULT_CODEX_MODEL,

  // Removed API-key/cloud routes now normalize to local CLI defaults.
  gemini: DEFAULT_CLAUDE_MODEL,
  "gemini-3.1-flash-lite-preview": DEFAULT_CLAUDE_MODEL,
  "gemini-3.1-pro-preview": DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_CODEX_MODEL,
  groq: DEFAULT_CODEX_MODEL,
  llama: DEFAULT_CODEX_MODEL,
  "llama-3.3-70b-versatile": DEFAULT_CODEX_MODEL,
  natively: DEFAULT_CLAUDE_MODEL,
};

export class LLMHelper {
  private currentModelId: string = DEFAULT_CLAUDE_MODEL;
  private reasoningEffort: ReasoningEffort = "xhigh";
  private aiResponseLanguage = "auto";
  private sttLanguage = "english-us";
  private knowledgeOrchestrator: any = null;
  private ipCorpMode = false;

  constructor(
    _apiKey?: string,
    useOllama: boolean = false,
    _ollamaModel?: string,
    _ollamaUrl?: string,
    _groqApiKey?: string,
    _openaiApiKey?: string,
    _claudeApiKey?: string,
  ) {
    if (useOllama) {
      console.warn("[LLMHelper] Ollama text routing has been removed. Falling back to local CLI models.");
    }
  }

  public setNativelyKey(_apiKey: string | null): void {
    console.log("[LLMHelper] Natively text-model routing disabled. Local CLI routes remain active.");
  }

  public scrubKeys(): void {
    // Intentionally empty. Text-model API keys are no longer stored in this helper.
  }

  public setModel(modelId: string): void {
    this.currentModelId = normalizeModelId(modelId);
    console.log(`[LLMHelper] Active model set to ${this.currentModelId}`);
  }

  public getCurrentProvider(): ActiveProvider {
    return providerForModel(this.currentModelId);
  }

  public getCurrentModel(): string {
    return this.currentModelId;
  }

  public setReasoningEffort(effort: ReasoningEffort): void {
    this.reasoningEffort = effort;
  }

  public getReasoningEffort(): ReasoningEffort {
    return this.reasoningEffort;
  }

  public setAiResponseLanguage(language: string): void {
    this.aiResponseLanguage = language || "auto";
  }

  public setSttLanguage(language: string): void {
    this.sttLanguage = language || "english-us";
  }

  public setKnowledgeOrchestrator(orchestrator: any): void {
    this.knowledgeOrchestrator = orchestrator;
  }

  public setIPCorpMode(enabled: boolean): void {
    this.ipCorpMode = !!enabled;
    if (this.ipCorpMode) {
      buildIPCorpContext().catch((error) => {
        console.warn("[LLMHelper] Failed to warm IP Corp context:", error);
      });
    }
  }

  public getIPCorpMode(): boolean {
    return this.ipCorpMode;
  }

  public startContinuousOCR(): void {
    const service = ContinuousOCRService.getInstance();
    service.setAnalyzer(async (imagePaths: string[], prompt: string) => {
      return this.runCliText({
        provider: this.getCurrentProvider(),
        model: this.currentModelId,
        prompt,
        imagePaths,
      });
    });
    service.start();
  }

  public stopContinuousOCR(): void {
    ContinuousOCRService.getInstance().stop();
  }

  public resetPersistentCliSessions(): void {
    console.log("[LLMHelper] Persistent CLI sessions are disabled. Nothing to reset.");
  }

  public isUsingOllama(): boolean {
    return false;
  }

  public async generateSuggestion(context: string, lastQuestion: string): Promise<string> {
    const prompt = [
      "You are an expert interview coach.",
      "Provide a concise natural response the user could say next.",
      "Rules:",
      "- Be direct and conversational.",
      "- Keep the response under 3 sentences unless complexity requires more.",
      "- Do not preface with 'You could say'.",
      `Question: ${lastQuestion}`,
    ].join("\n");

    return this.chat(prompt, undefined, context);
  }

  public async generateSolution(problemInfo: any): Promise<any> {
    const schema = {
      type: "object",
      properties: {
        solution: {
          type: "object",
          properties: {
            code: { type: "string" },
            problem_statement: { type: "string" },
            context: { type: "string" },
            suggested_responses: {
              type: "array",
              items: { type: "string" },
            },
            reasoning: { type: "string" },
          },
          required: ["code", "problem_statement", "context", "suggested_responses", "reasoning"],
        },
      },
      required: ["solution"],
    };

    const prompt = [
      "Given this problem or situation, return strict JSON.",
      JSON.stringify(problemInfo, null, 2),
      "Return exactly this shape:",
      JSON.stringify({
        solution: {
          code: "",
          problem_statement: "",
          context: "",
          suggested_responses: [""],
          reasoning: "",
        },
      }),
    ].join("\n\n");

    const raw = await this.chat(prompt, undefined, undefined, "Return valid JSON only.", {
      ignoreKnowledgeMode: true,
      skipRetrievedContext: true,
      responseSchema: schema,
    });
    return parseJsonResponse(raw);
  }

  public async generateRollingScript(imagePaths: string[]): Promise<{
    problem_identifier_script: string;
    brainstorm_script: string;
    code: string;
    dry_run_script: string;
    time_complexity: string;
    space_complexity: string;
  }> {
    const schema = {
      type: "object",
      properties: {
        problem_identifier_script: { type: "string" },
        brainstorm_script: { type: "string" },
        code: { type: "string" },
        dry_run_script: { type: "string" },
        time_complexity: { type: "string" },
        space_complexity: { type: "string" },
      },
      required: [
        "problem_identifier_script",
        "brainstorm_script",
        "code",
        "dry_run_script",
        "time_complexity",
        "space_complexity",
      ],
    };

    const prompt = [
      "You are taking a live technical interview.",
      "Inspect the provided screenshots and produce a four-phase response script plus complexity.",
      "Return strict JSON only.",
      JSON.stringify({
        problem_identifier_script: "",
        brainstorm_script: "",
        code: "",
        dry_run_script: "",
        time_complexity: "",
        space_complexity: "",
      }),
    ].join("\n\n");

    const raw = await this.chat(prompt, imagePaths, undefined, "Return valid JSON only.", {
      ignoreKnowledgeMode: true,
      skipRetrievedContext: true,
      responseSchema: schema,
    });
    return parseJsonResponse(raw);
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]): Promise<any> {
    const schema = {
      type: "object",
      properties: {
        solution: {
          type: "object",
          properties: {
            code: { type: "string" },
            problem_statement: { type: "string" },
            context: { type: "string" },
            suggested_responses: {
              type: "array",
              items: { type: "string" },
            },
            reasoning: { type: "string" },
          },
          required: ["code", "problem_statement", "context", "suggested_responses", "reasoning"],
        },
      },
      required: ["solution"],
    };

    const prompt = [
      "Analyze the original problem, the current code, and the debug screenshots.",
      "Return strict JSON with an updated solution package.",
      `Problem:\n${JSON.stringify(problemInfo, null, 2)}`,
      `Current code:\n${currentCode}`,
      JSON.stringify({
        solution: {
          code: "",
          problem_statement: "",
          context: "",
          suggested_responses: [""],
          reasoning: "",
        },
      }),
    ].join("\n\n");

    const raw = await this.chat(prompt, debugImagePaths, undefined, "Return valid JSON only.", {
      ignoreKnowledgeMode: true,
      skipRetrievedContext: true,
      responseSchema: schema,
    });
    return parseJsonResponse(raw);
  }

  public async analyzeImageFiles(imagePaths: string[]): Promise<{ text: string; timestamp: number }> {
    const prompt = [
      "Describe the visible content of the provided image files.",
      "If they contain code or a problem statement, solve it clearly and concisely.",
    ].join("\n");

    const text = await this.chat(prompt, imagePaths, undefined, "Be concise.");
    return { text, timestamp: Date.now() };
  }

  public async chatWithGemini(
    message: string,
    imagePaths?: string[],
    context?: string,
    skipSystemPrompt: boolean = false,
    _alternateGroqMessage?: string,
  ): Promise<string> {
    return this.chat(
      message,
      imagePaths,
      context,
      skipSystemPrompt ? "" : undefined,
    );
  }

  public async *streamChatWithGemini(
    message: string,
    imagePaths?: string[],
    context?: string,
    skipSystemPrompt: boolean = false,
  ): AsyncGenerator<string, void, unknown> {
    yield* this.streamChat(
      message,
      imagePaths,
      context,
      skipSystemPrompt ? "" : undefined,
      // Only RAG uses this entry point. RAG prompts carry their own ranked
      // meeting excerpt and instruct the model to answer ONLY from it — do not
      // layer the broker retrieval pass or the raw screen-OCR dump on top
      // (that silently blended other meetings/emails/screen into answers).
      {
        ignoreKnowledgeMode: true,
        skipRetrievedContext: true,
        skipScreenContext: true,
        skipIPCorpSystemPrompt: true,
      },
    );
  }

  public async generateContentStructured(message: string): Promise<string> {
    return this.chat(message, undefined, undefined, "Return strict JSON only.", {
      ignoreKnowledgeMode: true,
      skipRetrievedContext: true,
    });
  }

  public async generateMeetingSummary(systemPrompt: string, context: string, _groqSystemPrompt?: string): Promise<string> {
    return this.chat(
      `Context:\n${context}`,
      undefined,
      undefined,
      systemPrompt,
      {
        ignoreKnowledgeMode: true,
        skipRetrievedContext: true,
      },
    );
  }

  public async generateWithLocalClaude(userPrompt: string, systemPrompt?: string, model: string = DEFAULT_CLAUDE_MODEL): Promise<string> {
    return this.runCliText({
      provider: "claude",
      model: normalizeClaudeModel(model),
      systemPrompt: systemPrompt ? this.injectLanguageInstruction(systemPrompt) : undefined,
      prompt: userPrompt,
    });
  }

  public async generateWithLocalCodex(
    userPrompt: string,
    systemPrompt?: string,
    model: string = DEFAULT_CODEX_MODEL,
    reasoningEffort: ReasoningEffort = "xhigh",
  ): Promise<string> {
    return this.runCliText({
      provider: "codex",
      model: normalizeCodexModel(model),
      systemPrompt: systemPrompt ? this.injectLanguageInstruction(systemPrompt) : undefined,
      prompt: userPrompt,
      reasoningEffort,
    });
  }

  public async reviewAssistantOutput(input: ReviewInput): Promise<ReviewOutput> {
    const reviewType = input?.reviewType || "voice_pass";
    const model = reviewType === "technical_check" ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
    const provider = reviewType === "technical_check" ? "codex" : "claude";
    const systemPrompt = reviewType === "technical_check"
      ? [
          "You are a strict technical reviewer.",
          "Check for factual errors, weak reasoning, overclaiming, or vague technical language.",
          "Return a revised version only. No preamble.",
        ].join("\n")
      : [
          "You are a communication editor.",
          "Tighten the message for clarity, confidence, and natural spoken delivery.",
          "Return the improved version only. No preamble.",
        ].join("\n");

    const prompt = [
      input.sourceIntent ? `Original intent: ${input.sourceIntent}` : "",
      "Message to review:",
      input.text,
    ].filter(Boolean).join("\n\n");

    const text = await this.runCliText({
      provider,
      model,
      systemPrompt: this.injectLanguageInstruction(systemPrompt),
      prompt,
    });

    return {
      reviewType,
      reviewerModel: model,
      text: text.trim(),
    };
  }

  public async *streamChat(
    message: string,
    imagePaths?: string[],
    context?: string,
    systemPromptOverride?: string,
    chatOptions: boolean | ChatOptions = false,
  ): AsyncGenerator<string, void, unknown> {
    const options = typeof chatOptions === "boolean"
      ? { ignoreKnowledgeMode: chatOptions }
      : chatOptions;

    // Real streaming: bridge the CLI's incremental deltas into this generator
    // through an async queue. Previously this awaited the ENTIRE chat() and
    // yielded once — every "token stream" in the app was one blob at the end.
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let streamedLength = 0;

    const push = (token: string) => {
      if (!token) return;
      queue.push(token);
      streamedLength += token.length;
      wake?.();
      wake = null;
    };

    const chatPromise = this.chat(
      message,
      imagePaths,
      context,
      systemPromptOverride,
      { ...options, onToken: push },
    ).finally(() => {
      finished = true;
      wake?.();
      wake = null;
    });
    // Errors surface via `await chatPromise` below; this guard just prevents
    // an unhandled-rejection crash if the consumer abandons the generator.
    chatPromise.catch(() => {});

    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (finished) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }

    const response = await chatPromise;
    // Yield whatever the deltas didn't cover: short-circuit answers, providers
    // whose output only arrived as a final blob, or a sanitized tail.
    if (response && response.length > streamedLength) {
      yield streamedLength > 0 ? response.slice(streamedLength) : response;
    }
  }

  public async chat(
    message: string,
    imagePaths?: string[],
    context?: string,
    systemPromptOverride?: string,
    options: ChatOptions = {},
  ): Promise<string> {
    const resolvedSystemPrompt = systemPromptOverride === undefined
      ? DEFAULT_SYSTEM_PROMPT
      : systemPromptOverride || undefined;

    const knowledgeMode = await this.applyKnowledgeMode(message, context, resolvedSystemPrompt, options.ignoreKnowledgeMode === true);
    if (knowledgeMode.shortCircuit) {
      return knowledgeMode.shortCircuit;
    }

    let finalSystemPrompt = knowledgeMode.systemPrompt ?? resolvedSystemPrompt;
    if (
      this.ipCorpMode &&
      options.ignoreKnowledgeMode !== true &&
      options.skipIPCorpSystemPrompt !== true &&
      systemPromptOverride !== ""
    ) {
      const ipCorpSystemPrompt = await withTimeout(
        buildIPCorpSystemPrompt(message),
        2_500,
        "",
        "IP Corp system prompt"
      );
      if (ipCorpSystemPrompt) {
        finalSystemPrompt = finalSystemPrompt?.trim()
          ? `${ipCorpSystemPrompt}\n\n<task_instructions>\n${finalSystemPrompt.trim()}\n</task_instructions>`
          : ipCorpSystemPrompt;
      }
    }

    let finalContext = knowledgeMode.context ?? context ?? "";
    finalContext = await this.appendRetrievedContext(message, finalContext, options.skipRetrievedContext === true);
    if (options.skipScreenContext !== true) {
      finalContext = this.appendScreenContext(finalContext);
    }

    const prepared = this.buildPrompt(message, imagePaths, finalContext, finalSystemPrompt);
    return this.runCliText({
      provider: this.getCurrentProvider(),
      model: this.currentModelId,
      systemPrompt: prepared.systemPrompt,
      prompt: prepared.userPrompt,
      imagePaths,
      requestProfile: options.requestProfile,
      responseSchema: options.responseSchema,
      onDelta: options.onToken,
      signal: options.abortSignal,
    });
  }

  private buildPrompt(
    message: string,
    imagePaths: string[] | undefined,
    context: string,
    systemPrompt?: string,
  ): PreparedPrompt {
    const provider = this.getCurrentProvider();
    const sections = [
      context.trim() ? `Context:\n${context.trim()}` : "",
      provider === "claude" && imagePaths?.length
        ? `Local image files available for inspection:\n${imagePaths.join("\n")}`
        : "",
      `User request:\n${message}`,
    ].filter(Boolean);

    if (provider === "claude") {
      return {
        systemPrompt: systemPrompt ? this.injectLanguageInstruction(systemPrompt) : undefined,
        userPrompt: sections.join("\n\n"),
      };
    }

    const codexPrompt = [
      systemPrompt ? `System instructions:\n${this.injectLanguageInstruction(systemPrompt)}` : "",
      ...sections,
    ].filter(Boolean).join("\n\n");

    return { userPrompt: codexPrompt };
  }

  private async appendRetrievedContext(message: string, context: string, skipRetrievedContext: boolean): Promise<string> {
    if (skipRetrievedContext || !message.trim()) {
      return context;
    }

    try {
      const retrieval = await ContextRetrievalBroker.getInstance().retrieve({
        query: message,
        surface: this.ipCorpMode ? "meeting" : "reactive",
        limit: this.ipCorpMode ? 8 : 5,
      });
      const contextBlock = buildPromptContextBlock(retrieval);
      if (!contextBlock) {
        return context;
      }
      return context.trim() ? `${contextBlock}\n\n${context.trim()}` : contextBlock;
    } catch (error) {
      console.warn("[LLMHelper] Context retrieval failed:", error);
      return context;
    }
  }

  private appendScreenContext(context: string): string {
    const ocrContext = ContinuousOCRService.getInstance().getContext();
    if (!ocrContext) {
      return context;
    }
    // Screen text goes BELOW the ranked/caller context, never above it —
    // unranked OCR noise must not be the positionally dominant evidence.
    return context.trim() ? `${context.trim()}\n\n${ocrContext}` : ocrContext;
  }

  private async applyKnowledgeMode(
    message: string,
    context: string | undefined,
    systemPrompt: string | undefined,
    ignoreKnowledgeMode: boolean,
  ): Promise<KnowledgeModeResult> {
    if (ignoreKnowledgeMode || !this.knowledgeOrchestrator?.isKnowledgeMode?.()) {
      return {
        context,
        systemPrompt,
      };
    }

    try {
      this.knowledgeOrchestrator.feedForDepthScoring?.(message);
      const knowledgeResult = await this.knowledgeOrchestrator.processQuestion?.(message);
      if (!knowledgeResult) {
        return {
          context,
          systemPrompt,
        };
      }

      if (knowledgeResult.liveNegotiationResponse) {
        return {
          shortCircuit: JSON.stringify({ __negotiationCoaching: knowledgeResult.liveNegotiationResponse }),
        };
      }

      if (knowledgeResult.isIntroQuestion && knowledgeResult.introResponse) {
        return {
          shortCircuit: String(knowledgeResult.introResponse),
        };
      }

      const mergedContext = knowledgeResult.contextBlock
        ? context?.trim()
          ? `${knowledgeResult.contextBlock}\n\n${context.trim()}`
          : knowledgeResult.contextBlock
        : context;

      return {
        context: mergedContext,
        systemPrompt: knowledgeResult.systemPromptInjection || systemPrompt,
      };
    } catch (error) {
      console.warn("[LLMHelper] Knowledge mode interception failed:", error);
      return {
        context,
        systemPrompt,
      };
    }
  }

  private injectLanguageInstruction(systemPrompt: string): string {
    if (!systemPrompt) return systemPrompt;
    const language = this.aiResponseLanguage?.trim().toLowerCase();
    if (!language || language === "auto") {
      return systemPrompt;
    }

    return [
      `Respond entirely in ${this.aiResponseLanguage}.`,
      systemPrompt,
    ].join("\n\n");
  }

  private async runCliText(request: CliRequest): Promise<string> {
    const provider = request.provider;
    const model = normalizeModelId(request.model);
    const imagePaths = sanitizeImagePaths(request.imagePaths);

    if (provider === "claude") {
      return this.runClaudeCli({
        provider,
        model: normalizeClaudeModel(model),
        systemPrompt: request.systemPrompt,
        prompt: request.prompt,
        imagePaths,
        requestProfile: request.requestProfile,
        responseSchema: request.responseSchema,
        reasoningEffort: request.reasoningEffort,
        onDelta: request.onDelta,
        signal: request.signal,
      });
    }

    return this.runCodexCli({
      provider,
      model: normalizeCodexModel(model),
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      imagePaths,
      requestProfile: request.requestProfile,
      responseSchema: request.responseSchema,
      reasoningEffort: request.reasoningEffort,
      onDelta: request.onDelta,
      signal: request.signal,
    });
  }

  private async runClaudeCli(request: CliRequest): Promise<string> {
    const profile = resolveClaudeRequestProfile(request, this.reasoningEffort);
    const args: string[] = [
      "-p",
      "--verbose",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      // Emit content_block_delta stream events so consumers get real
      // token-level streaming instead of one blob at process exit.
      "--include-partial-messages",
      "--disable-slash-commands",
      "--strict-mcp-config",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      profile.model,
      "--effort",
      profile.effort,
    ];

    if (request.systemPrompt) {
      args.push("--system-prompt", request.systemPrompt);
    }

    if (request.responseSchema) {
      args.push("--json-schema", JSON.stringify(request.responseSchema));
    }

    const extraDirs = uniqueDirectories(request.imagePaths);
    if (extraDirs.length) {
      args.push("--add-dir", ...extraDirs);
    }

    const invocation = buildLocalCliInvocation("claude", args);
    const env = this.buildCliEnv("claude");

    console.log(
      `[LLMHelper] Claude request profile model=${profile.model} effort=${profile.effort} timeout=${Math.round(profile.timeoutMs / 1000)}s reason=${profile.reason}`
    );
    const result = await this.collectJsonlOutput(
      invocation.command,
      invocation.args,
      env,
      "claude",
      request.prompt,
      profile.timeoutMs,
      { onDelta: request.onDelta, signal: request.signal },
    );
    if (result.error) {
      throw new Error(result.error);
    }
    return sanitizeTextResponse(result.text);
  }

  private async runCodexCli(request: CliRequest): Promise<string> {
    const schemaPath = request.responseSchema
      ? this.writeTempJsonFile("natively-codex-schema", request.responseSchema)
      : null;

    try {
      const prompt = request.systemPrompt
        ? `${request.systemPrompt}\n\n${request.prompt}`
        : request.prompt;
      const profile = resolveCodexRequestProfile(request, request.reasoningEffort || this.reasoningEffort, prompt);

      const args: string[] = [
        "exec",
        "--json",
        "--color",
        "never",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        os.tmpdir(),
        "--model",
        request.model,
        "--config",
        `model_reasoning_effort="${profile.effort}"`,
      ];

      if (schemaPath) {
        args.push("--output-schema", schemaPath);
      }

      for (const imagePath of request.imagePaths || []) {
        args.push("--image", imagePath);
      }

      args.push("-");

      const invocation = buildLocalCliInvocation("codex", args);
      const env = this.buildCliEnv("codex");
      console.log(
        `[LLMHelper] Codex request profile model=${request.model} effort=${profile.effort} timeout=${Math.round(profile.timeoutMs / 1000)}s reason=${profile.reason}`
      );
      const result = await this.collectJsonlOutput(
        invocation.command,
        invocation.args,
        env,
        "codex",
        prompt,
        profile.timeoutMs,
        { onDelta: request.onDelta, signal: request.signal },
      );
      if (result.error) {
        throw new Error(result.error);
      }
      return sanitizeTextResponse(result.text);
    } finally {
      if (schemaPath) {
        fs.promises.unlink(schemaPath).catch(() => {});
      }
    }
  }

  private buildCliEnv(provider: LocalCliProvider): NodeJS.ProcessEnv {
    if (provider === "claude") {
      return buildClaudeCliEnv(process.env);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    const homeDir = os.homedir();
    const parsed = path.parse(homeDir);
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
    env.HOMEPATH = homeDir.slice(parsed.root.length - 1);

    if (provider === "codex") {
      env.CODEX_DISABLE_AUTOUPDATES = "1";
      env.CLAUDE_CODE_SIMPLE = "1";
    }

    return env;
  }

  private async collectJsonlOutput(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    provider: ActiveProvider,
    stdinText?: string,
    timeoutMs: number = DEFAULT_CLI_REQUEST_TIMEOUT_MS,
    streamOptions?: { onDelta?: (delta: string) => void; signal?: AbortSignal },
  ): Promise<{ text: string; error?: string }> {
    const onDelta = streamOptions?.onDelta;
    const signal = streamOptions?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve({ text: "", error: "Request cancelled." });
        return;
      }

      const child = spawn(command, args, {
        cwd: os.tmpdir(),
        env,
        windowsHide: true,
        stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let finalText = "";
      let explicitError: string | undefined;
      let stdoutBuffer = "";
      let settled = false;
      let timedOut = false;
      const startedAt = Date.now();
      console.log(`[LLMHelper] Starting ${provider} CLI request: ${path.basename(command)} ${args.slice(0, 8).join(" ")}`);

      if (stdinText !== undefined && child.stdin) {
        child.stdin.end(stdinText, "utf8");
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        explicitError = `${provider === "codex" ? "Codex" : "Claude"} CLI timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
        killProcessTree(child.pid);
        finish({ text: finalText, error: explicitError });
      }, timeoutMs);

      // Cancellation: kill the process tree IMMEDIATELY and settle. Superseded
      // requests previously ran to completion (up to the full timeout) while a
      // new heavyweight CLI process spawned alongside.
      const onAbort = () => {
        killProcessTree(child.pid);
        finish({ text: finalText, error: "Request cancelled." });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (value: { text: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        console.log(`[LLMHelper] ${provider} CLI request finished in ${Date.now() - startedAt}ms${value.error ? " with error" : ""}`);
        resolve(value);
      };

      // Streaming delta emission. Two shapes arrive on stdout:
      //  - direct deltas (claude stream_event content_block_delta, codex
      //    agent_message_delta) — emitted as-is;
      //  - cumulative full-text updates (assistant message events, codex
      //    item/output_text) — the new suffix is emitted, which also makes the
      //    two shapes consistent when both arrive for the same text.
      let emittedText = "";
      const emitDirectDelta = (delta: string) => {
        if (!onDelta || !delta) return;
        emittedText += delta;
        try { onDelta(delta); } catch { /* consumer errors must not kill parsing */ }
      };
      const emitCumulativeText = (full: string) => {
        if (!onDelta || !full) return;
        if (full.length > emittedText.length && full.startsWith(emittedText)) {
          const delta = full.slice(emittedText.length);
          emittedText = full;
          try { onDelta(delta); } catch { /* consumer errors must not kill parsing */ }
        }
      };

      const handleJsonLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          return;
        }

        try {
          const parsed = JSON.parse(trimmed) as any;
          if (provider === "codex") {
            if (parsed?.type === "error" && parsed?.message) {
              explicitError = String(parsed.message);
            }
            const turnFailedMessage = parsed?.type === "turn.failed"
              ? parsed?.error?.message
              : undefined;
            if (turnFailedMessage) {
              explicitError = String(turnFailedMessage);
            }
            if (parsed?.msg?.type === "agent_message_delta" && typeof parsed.msg.delta === "string") {
              emitDirectDelta(parsed.msg.delta);
            }
            const itemText = parsed?.item?.text;
            if (typeof itemText === "string" && itemText.trim()) {
              finalText = itemText;
              emitCumulativeText(itemText);
            }
            const outputText = parsed?.output_text;
            if (typeof outputText === "string" && outputText.trim()) {
              finalText = outputText;
              emitCumulativeText(outputText);
            }
            const resultText = parsed?.result;
            if (typeof resultText === "string" && resultText.trim()) {
              finalText = resultText;
              emitCumulativeText(resultText);
            }
          } else {
            if (
              parsed?.type === "stream_event" &&
              parsed?.event?.type === "content_block_delta" &&
              typeof parsed?.event?.delta?.text === "string"
            ) {
              emitDirectDelta(parsed.event.delta.text);
            }
            const messageText = parsed?.message?.content
              ?.map((part: any) => part?.text || "")
              .join("");
            if (typeof messageText === "string" && messageText.trim()) {
              finalText = messageText;
              emitCumulativeText(messageText);
            }
            if (parsed?.type === "result" && parsed?.is_error) {
              explicitError = parsed?.result || "Claude CLI returned an error.";
            }
          }
        } catch {
          // Ignore non-JSON lines.
        }
      };

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        stdoutBuffer += text;

        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          handleJsonLine(line);
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          handleJsonLine(stdoutBuffer.trim());
        }

        if (explicitError) {
          finish({ text: finalText, error: sanitizeCliFailure(explicitError) });
          return;
        }

        if (timedOut) {
          finish({ text: finalText, error: `${provider === "codex" ? "Codex" : "Claude"} CLI timed out.` });
          return;
        }

        if (code !== 0) {
          const message = sanitizeCliFailure(stderr || stdout || `${provider} CLI exited with code ${code}`);
          finish({ text: finalText, error: message });
          return;
        }

        if (!finalText.trim()) {
          const plainText = sanitizeTextResponse(stdout);
          finish({ text: plainText });
          return;
        }

        finish({ text: finalText });
      });
    });
  }

  private writeTempJsonFile(prefix: string, value: unknown): string {
    const filePath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return filePath;
  }
}

function killProcessTree(pid?: number): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
  } catch {
    // Fall through to process.kill.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

function normalizeModelId(modelId?: string): string {
  const candidate = (modelId || "").trim();
  if (!candidate) return DEFAULT_CLAUDE_MODEL;
  const aliased = LEGACY_MODEL_ALIASES[candidate] || candidate;
  if (SUPPORTED_CLAUDE_MODELS.has(aliased)) return aliased;
  if (SUPPORTED_CODEX_MODELS.has(aliased)) return aliased;
  return DEFAULT_CLAUDE_MODEL;
}

function normalizeClaudeModel(modelId?: string): string {
  const normalized = normalizeModelId(modelId);
  return SUPPORTED_CLAUDE_MODELS.has(normalized) ? normalized : DEFAULT_CLAUDE_MODEL;
}

function normalizeCodexModel(modelId?: string): string {
  const normalized = normalizeModelId(modelId);
  return SUPPORTED_CODEX_MODELS.has(normalized) ? normalized : DEFAULT_CODEX_MODEL;
}

function providerForModel(modelId: string): ActiveProvider {
  const normalized = normalizeModelId(modelId);
  return SUPPORTED_CLAUDE_MODELS.has(normalized) ? "claude" : "codex";
}

type ClaudeRequestProfile = {
  model: string;
  effort: string;
  timeoutMs: number;
  reason: string;
};

// Live-meeting reflex lane: sonnet-class at low effort with a tight timeout.
// opus at max effort takes 30s+ per cold CLI spawn — useless mid-conversation.
const REALTIME_CLAUDE_MODEL = "claude-sonnet-4-6";
const REALTIME_CLAUDE_TIMEOUT_MS = 15_000;

function resolveClaudeRequestProfile(
  request: CliRequest,
  configuredEffort: ReasoningEffort,
): ClaudeRequestProfile {
  if (request.requestProfile === "realtime") {
    return {
      model: REALTIME_CLAUDE_MODEL,
      effort: "low",
      timeoutMs: REALTIME_CLAUDE_TIMEOUT_MS,
      reason: "proactive-realtime",
    };
  }

  const effort = request.reasoningEffort || configuredEffort;
  return {
    model: request.model,
    effort: claudeEffortFlag(effort),
    timeoutMs: DEFAULT_CLI_REQUEST_TIMEOUT_MS,
    reason: request.reasoningEffort ? "explicit-effort" : "configured-effort",
  };
}

// ReasoningEffort uses the codex vocabulary ("xhigh"); the claude CLI's top
// tier is "max" (or the AI_CLAUDE_EFFORT override, preserved as the meaning
// of "what the maximum tier maps to").
function claudeEffortFlag(effort: ReasoningEffort): string {
  return effort === "xhigh" ? DEFAULT_CLAUDE_EFFORT : effort;
}

function resolveCodexRequestProfile(
  request: CliRequest,
  configuredEffort: ReasoningEffort,
  prompt: string,
): CodexRequestProfile {
  const model = normalizeCodexModel(request.model);
  const lower = prompt.toLowerCase();
  const hasImages = !!request.imagePaths?.length;
  const promptChars = prompt.length;
  const hasSchema = !!request.responseSchema;
  const asksForDecision =
    /\b(recommend|recommendation|decision|decide|risk|trade|position|long|short|should i|should we|what would you|next step|blocker)\b/.test(lower);
  const durableInsight =
    /\b(cortex|insight|insights|meeting prep|prep packet|architecture brain|action proposal|outcome ledger|thorough|deep analysis|durable memory)\b/.test(lower);
  const realtimeWidget =
    hasImages ||
    /\b(live screen|screenshot|what'?s on my screen|what is on my screen|right now|voice ask|real-time meeting coach|provide only the answer)\b/.test(lower);
  const quickAction =
    /\b(draft reply|clarify|clarifying question|summarize|recap|suggest follow-up|follow-up questions|concise|2-4 sentences)\b/.test(lower);

  if (request.requestProfile === "realtime") {
    return {
      effort: "low",
      timeoutMs: 9_000,
      reason: "proactive-realtime",
    };
  }

  if (model === "gpt-5.4-mini") {
    const effort: ReasoningEffort = hasImages || asksForDecision ? "medium" : "low";
    return {
      effort,
      timeoutMs: timeoutForCliRequest("codex", model, effort),
      reason: hasImages ? "mini-screen" : "mini-fast",
    };
  }

  if (request.reasoningEffort) {
    return {
      effort: request.reasoningEffort,
      timeoutMs: timeoutForCliRequest("codex", model, request.reasoningEffort),
      reason: "explicit-effort",
    };
  }

  if (durableInsight) {
    const effort: ReasoningEffort = configuredEffort === "xhigh" || configuredEffort === "high"
      ? configuredEffort
      : "high";
    return {
      effort,
      timeoutMs: timeoutForCliRequest("codex", model, effort),
      reason: "durable-insight",
    };
  }

  if (realtimeWidget) {
    const effort: ReasoningEffort = asksForDecision ? "high" : "medium";
    return {
      effort,
      timeoutMs: timeoutForCliRequest("codex", model, effort),
      reason: asksForDecision ? "screen-decision" : "screen-fast",
    };
  }

  if (quickAction) {
    return {
      effort: "medium",
      timeoutMs: timeoutForCliRequest("codex", model, "medium"),
      reason: "quick-action",
    };
  }

  if (hasSchema) {
    return {
      effort: "medium",
      timeoutMs: timeoutForCliRequest("codex", model, "medium"),
      reason: "structured-output",
    };
  }

  if (promptChars > 18_000) {
    return {
      effort: "high",
      timeoutMs: timeoutForCliRequest("codex", model, "high"),
      reason: "long-context",
    };
  }

  return {
    effort: configuredEffort === "xhigh" ? "medium" : configuredEffort,
    timeoutMs: timeoutForCliRequest("codex", model, configuredEffort === "xhigh" ? "medium" : configuredEffort),
    reason: configuredEffort === "xhigh" ? "default-capped" : "default",
  };
}

function timeoutForCliRequest(provider: ActiveProvider, modelId: string, effort: ReasoningEffort): number {
  if (provider !== "codex") {
    return DEFAULT_CLI_REQUEST_TIMEOUT_MS;
  }

  if (modelId === "gpt-5.4-mini" && effort !== "xhigh") {
    return 120_000;
  }

  switch (effort) {
    case "low":
      return 120_000;
    case "medium":
      return 180_000;
    case "high":
      return 240_000;
    case "xhigh":
      return modelId === DEFAULT_CODEX_MODEL ? 300_000 : 240_000;
    default:
      return DEFAULT_CLI_REQUEST_TIMEOUT_MS;
  }
}

function sanitizeImagePaths(imagePaths?: string[]): string[] {
  return (imagePaths || []).map((value) => value?.trim()).filter(Boolean) as string[];
}

function uniqueDirectories(imagePaths?: string[]): string[] {
  return [...new Set((imagePaths || []).map((imagePath) => path.dirname(imagePath)))];
}

function sanitizeTextResponse(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  return trimmed;
}

function sanitizeCliFailure(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "CLI request failed.";
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("202") && !line.includes("WARN codex_"));

  return lines.join("\n").trim() || "CLI request failed.";
}

function parseJsonResponse<T = any>(raw: string): T {
  const trimmed = sanitizeTextResponse(raw);
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]) as T;
    }
    throw new Error("Model response was not valid JSON.");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[LLMHelper] ${label} timed out after ${timeoutMs}ms`);
          resolve(fallback);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn(`[LLMHelper] ${label} failed:`, error);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
