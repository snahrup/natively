import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { app } from "electron";

interface PythonInvocation {
  command: string;
  argsPrefix: string[];
  displayPath: string;
}

export interface SemanticaSidecarRuntimeStatus {
  ready: boolean;
  healthy: boolean;
  port: number;
  baseUrl: string;
  healthUrl: string;
  scriptPath: string | null;
  semanticaRoot: string | null;
  pythonPath: string | null;
  pid: number | null;
  lastError: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exists(candidate?: string | null): candidate is string {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function commandWorks(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      windowsHide: true,
      timeout: 4000,
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function httpHealthy(url: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", () => resolve(false));
  });
}

export class SemanticaSidecarManager {
  private static instance: SemanticaSidecarManager;
  private readonly port = Number(process.env.SEMANTICA_SIDECAR_PORT || 8765);
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastResolvedScriptPath: string | null = null;
  private lastResolvedSemanticaRoot: string | null = null;
  private lastResolvedPythonPath: string | null = null;

  public static getInstance(): SemanticaSidecarManager {
    if (!SemanticaSidecarManager.instance) {
      SemanticaSidecarManager.instance = new SemanticaSidecarManager();
    }
    return SemanticaSidecarManager.instance;
  }

  public getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.ensureRunningInternal().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  public async isHealthy(): Promise<boolean> {
    return httpHealthy(`${this.getBaseUrl()}/health`);
  }

  public async getRuntimeStatus(): Promise<SemanticaSidecarRuntimeStatus> {
    const healthy = await this.isHealthy();
    return {
      ready: healthy,
      healthy,
      port: this.port,
      baseUrl: this.getBaseUrl(),
      healthUrl: `${this.getBaseUrl()}/health`,
      scriptPath: this.lastResolvedScriptPath ?? this.resolveScriptPath(),
      semanticaRoot: this.lastResolvedSemanticaRoot ?? this.resolveSemanticaRoot(),
      pythonPath: this.lastResolvedPythonPath ?? this.resolvePythonInvocationSafe()?.displayPath ?? null,
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
    };
  }

  private async ensureRunningInternal(): Promise<void> {
    if (await this.isHealthy()) return;

    const scriptPath = this.resolveScriptPath();
    if (!scriptPath) {
      this.lastError = "Semantica sidecar script was not found.";
      throw new Error(this.lastError);
    }

    const semanticaRoot = this.resolveSemanticaRoot();
    const python = this.resolvePythonInvocation();

    this.lastResolvedScriptPath = scriptPath;
    this.lastResolvedSemanticaRoot = semanticaRoot;
    this.lastResolvedPythonPath = python.displayPath;
    this.lastError = null;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SEMANTICA_SIDECAR_PORT: String(this.port),
    };

    if (semanticaRoot) {
      env.SEMANTICA_UPSTREAM_PATH = semanticaRoot;
    }

    const child = spawn(python.command, [...python.argsPrefix, scriptPath], {
      cwd: path.dirname(scriptPath),
      env,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });

    this.child = child;

    child.once("error", (error) => {
      this.lastError = error.message;
      if (this.child?.pid === child.pid) {
        this.child = null;
      }
    });

    child.once("exit", (code, signal) => {
      if (this.child?.pid === child.pid) {
        this.child = null;
      }
      if (code !== 0) {
        this.lastError = `Semantica sidecar exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}.`;
      }
    });

    const healthy = await this.waitForHealth(30_000);
    if (!healthy) {
      this.lastError = this.lastError || "Semantica sidecar did not become healthy in time.";
      throw new Error(this.lastError);
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.isHealthy()) {
        return true;
      }
      await delay(1000);
    }
    return false;
  }

  private resolveScriptPath(): string | null {
    const appPath = app.getAppPath();
    const homeProjectRoot = path.join(app.getPath("home"), "CascadeProjects", "natively");
    const candidates = uniqueStrings([
      process.env.NATIVELY_SEMANTICA_SCRIPT_PATH,
      path.join(appPath, "sidecars", "semantica-runtime", "main.py"),
      path.join(process.resourcesPath, "sidecars", "semantica-runtime", "main.py"),
      path.join(process.cwd(), "sidecars", "semantica-runtime", "main.py"),
      path.join(homeProjectRoot, "sidecars", "semantica-runtime", "main.py"),
    ]);

    return candidates.find((candidate) => exists(candidate)) ?? null;
  }

  private resolveSemanticaRoot(): string | null {
    const appPath = app.getAppPath();
    const homeProjectRoot = path.join(app.getPath("home"), "CascadeProjects");
    const candidates = uniqueStrings([
      process.env.SEMANTICA_UPSTREAM_PATH,
      path.join(process.resourcesPath, "semantica-upstream"),
      path.join(appPath, "..", "semantica"),
      path.join(homeProjectRoot, "semantica"),
    ]);

    return candidates.find((candidate) => exists(candidate)) ?? null;
  }

  private resolvePythonInvocationSafe(): PythonInvocation | null {
    try {
      return this.resolvePythonInvocation();
    } catch {
      return null;
    }
  }

  private resolvePythonInvocation(): PythonInvocation {
    const appPath = app.getAppPath();
    const homeProjectRoot = path.join(app.getPath("home"), "CascadeProjects", "natively");
    const venvCandidates = uniqueStrings([
      process.env.NATIVELY_SEMANTICA_PYTHON,
      path.join(appPath, "sidecars", "semantica-runtime", "venv", "Scripts", "python.exe"),
      path.join(process.cwd(), "sidecars", "semantica-runtime", "venv", "Scripts", "python.exe"),
      path.join(homeProjectRoot, "sidecars", "semantica-runtime", "venv", "Scripts", "python.exe"),
    ]);

    const directPython = venvCandidates.find((candidate) => exists(candidate));
    if (directPython) {
      return {
        command: directPython,
        argsPrefix: [],
        displayPath: directPython,
      };
    }

    if (commandWorks("py.exe", ["-3.12", "--version"])) {
      return {
        command: "py.exe",
        argsPrefix: ["-3.12"],
        displayPath: "py.exe -3.12",
      };
    }

    if (commandWorks("python.exe", ["--version"])) {
      return {
        command: "python.exe",
        argsPrefix: [],
        displayPath: "python.exe",
      };
    }

    throw new Error("Python 3.12 for the Semantica sidecar was not found.");
  }
}
