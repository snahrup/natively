import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { buildPromptContextBlock, ContextRetrievalBroker } from "./context";
import { buildLocalCliInvocation, type LocalCliProvider } from "./services/CliProviderResolver";
import { ContinuousOCRService } from "./services/ContinuousOCRService";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type ActiveProvider = "claude" | "codex";

type ChatOptions = {
  ignoreKnowledgeMode?: boolean;
  skipRetrievedContext?: boolean;
  responseSchema?: Record<string, unknown>;
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
  responseSchema?: Record<string, unknown>;
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Natively, a local-first desktop meeting and workflow assistant.",
  "Be direct, precise, and useful.",
  "Prefer concise answers unless the task clearly requires detail.",
  "If context is provided, ground your response in it instead of inventing missing facts.",
].join("\n");

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
const DEFAULT_CODEX_MODEL = "gpt-5.4";

const SUPPORTED_CLAUDE_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6",
]);

const SUPPORTED_CODEX_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
]);

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  "claude-max": DEFAULT_CLAUDE_MODEL,
  "claude-max-sonnet": DEFAULT_CLAUDE_MODEL,
  "claude-max-sonnet-4-6": DEFAULT_CLAUDE_MODEL,
  "claude-max-opus": "claude-opus-4-6",
  "claude-max-opus-4-6": "claude-opus-4-6",
  codex: DEFAULT_CODEX_MODEL,
  "codex-gpt-5.4": DEFAULT_CODEX_MODEL,
  "codex-gpt-5.4-mini": "gpt-5.4-mini",
  "codex-gpt-5.3-codex": "gpt-5.3-codex",
  "codex-gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "codex-gpt-5.2": "gpt-5.2",

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
    ignoreKnowledgeMode: boolean = false,
  ): AsyncGenerator<string, void, unknown> {
    const response = await this.chat(
      message,
      imagePaths,
      context,
      systemPromptOverride,
      { ignoreKnowledgeMode },
    );
    if (response) {
      yield response;
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

    const finalSystemPrompt = knowledgeMode.systemPrompt ?? resolvedSystemPrompt;
    let finalContext = knowledgeMode.context ?? context ?? "";
    finalContext = await this.appendRetrievedContext(message, finalContext, options.skipRetrievedContext === true);
    finalContext = this.appendScreenContext(finalContext);

    const prepared = this.buildPrompt(message, imagePaths, finalContext, finalSystemPrompt);
    return this.runCliText({
      provider: this.getCurrentProvider(),
      model: this.currentModelId,
      systemPrompt: prepared.systemPrompt,
      prompt: prepared.userPrompt,
      imagePaths,
      responseSchema: options.responseSchema,
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
    return context.trim() ? `${ocrContext}\n\n${context.trim()}` : ocrContext;
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
        responseSchema: request.responseSchema,
      });
    }

    return this.runCodexCli({
      provider,
      model: normalizeCodexModel(model),
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      imagePaths,
      responseSchema: request.responseSchema,
    });
  }

  private async runClaudeCli(request: CliRequest): Promise<string> {
    const args: string[] = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      request.model,
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

    args.push(request.prompt);

    const invocation = buildLocalCliInvocation("claude", args);
    const env = this.buildCliEnv("claude");

    const result = await this.collectJsonlOutput(invocation.command, invocation.args, env, "claude");
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

      const args: string[] = [
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        request.model,
      ];

      if (schemaPath) {
        args.push("--output-schema", schemaPath);
      }

      for (const imagePath of request.imagePaths || []) {
        args.push("--image", imagePath);
      }

      args.push(prompt);

      const invocation = buildLocalCliInvocation("codex", args);
      const env = this.buildCliEnv("codex");
      const result = await this.collectJsonlOutput(invocation.command, invocation.args, env, "codex");
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    const homeDir = os.homedir();
    const parsed = path.parse(homeDir);
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
    env.HOMEPATH = homeDir.slice(parsed.root.length - 1);
    env.CLAUDE_CODE_SIMPLE = "1";

    if (provider === "codex") {
      env.CODEX_DISABLE_AUTOUPDATES = "1";
    }

    return env;
  }

  private async collectJsonlOutput(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    provider: ActiveProvider,
  ): Promise<{ text: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let finalText = "";
      let explicitError: string | undefined;
      let stdoutBuffer = "";

      const handleJsonLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
          return;
        }

        try {
          const parsed = JSON.parse(trimmed) as any;
          if (provider === "codex") {
            const itemText = parsed?.item?.text;
            if (typeof itemText === "string" && itemText.trim()) {
              finalText = itemText;
            }
            const outputText = parsed?.output_text;
            if (typeof outputText === "string" && outputText.trim()) {
              finalText = outputText;
            }
            const resultText = parsed?.result;
            if (typeof resultText === "string" && resultText.trim()) {
              finalText = resultText;
            }
          } else {
            const messageText = parsed?.message?.content
              ?.map((part: any) => part?.text || "")
              .join("");
            if (typeof messageText === "string" && messageText.trim()) {
              finalText = messageText;
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

      child.on("error", (error) => reject(error));

      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          handleJsonLine(stdoutBuffer.trim());
        }

        if (explicitError) {
          resolve({ text: finalText, error: explicitError });
          return;
        }

        if (code !== 0) {
          const message = sanitizeCliFailure(stderr || stdout || `${provider} CLI exited with code ${code}`);
          resolve({ text: finalText, error: message });
          return;
        }

        if (!finalText.trim()) {
          const plainText = sanitizeTextResponse(stdout);
          resolve({ text: plainText });
          return;
        }

        resolve({ text: finalText });
      });
    });
  }

  private writeTempJsonFile(prefix: string, value: unknown): string {
    const filePath = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return filePath;
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
