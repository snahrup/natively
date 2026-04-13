import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { app } from "electron";

export interface ContextStackBootstrapStatus {
  conductorReady: boolean;
  nexusGatewayReady: boolean;
  outlookRunning: boolean;
  teamsRunning: boolean;
  cluelyRunning: boolean;
}

const CONDUCTOR_HEALTH_URL = "http://127.0.0.1:3777/api/health";
const NEXUS_GATEWAY_HEALTH_URL = "http://127.0.0.1:3800/api/health";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpHealthy(url: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", () => resolve(false));
  });
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export class ContextStackBootstrapService {
  private static instance: ContextStackBootstrapService;
  private bootstrapPromise: Promise<ContextStackBootstrapStatus> | null = null;

  public static getInstance(): ContextStackBootstrapService {
    if (!ContextStackBootstrapService.instance) {
      ContextStackBootstrapService.instance = new ContextStackBootstrapService();
    }
    return ContextStackBootstrapService.instance;
  }

  public ensureRunning(): Promise<ContextStackBootstrapStatus> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.ensureRunningInternal().finally(() => {
        this.bootstrapPromise = null;
      });
    }
    return this.bootstrapPromise;
  }

  private async ensureRunningInternal(): Promise<ContextStackBootstrapStatus> {
    const outlookReady = this.ensureDesktopProcess(
      ["OUTLOOK.exe", "olk.exe"],
      [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft Office", "root", "Office16", "OUTLOOK.EXE"),
        path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "olk.exe"),
      ]
    );

    const teamsReady = this.ensureDesktopProcess(
      ["ms-teams.exe"],
      [path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "ms-teams.exe")]
    );

    const cluelyReady = this.ensureDesktopProcess(
      ["Cluely.exe"],
      [path.join(process.env.LOCALAPPDATA || "", "Programs", "cluely", "Cluely.exe")]
    );

    const [conductorReady, nexusGatewayReady, outlookRunning, teamsRunning, cluelyRunning] = await Promise.all([
      this.ensureConductor(),
      this.ensureNexusGateway(),
      outlookReady,
      teamsReady,
      cluelyReady,
    ]);

    return {
      conductorReady,
      nexusGatewayReady,
      outlookRunning,
      teamsRunning,
      cluelyRunning,
    };
  }

  private getCascadeRoot(): string {
    return path.join(app.getPath("home"), "CascadeProjects");
  }

  private getDesktopAppsDir(): string {
    return path.join(app.getPath("desktop"), "Apps");
  }

  private resolveNodeExecutable(): string {
    try {
      const raw = execFileSync("where.exe", ["node"], {
        encoding: "utf8",
        stdio: "pipe",
        windowsHide: true,
      });
      const first = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) return first;
    } catch {
      // fall through
    }
    return "node";
  }

  private isProcessRunning(imageNames: string[]): boolean {
    return imageNames.some((imageName) => {
      try {
        const output = execFileSync("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], {
          encoding: "utf8",
          stdio: "pipe",
          windowsHide: true,
        });
        return !!output.trim() && !output.includes("No tasks are running");
      } catch {
        return false;
      }
    });
  }

  private startDetached(filePath: string, args: string[] = [], cwd?: string, env?: NodeJS.ProcessEnv): void {
    const child = spawn(filePath, args, {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.unref();
  }

  private async waitForHealth(url: string, timeoutMs = 20_000): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await httpHealthy(url)) return true;
      await delay(1000);
    }
    return false;
  }

  private async ensureDesktopProcess(imageNames: string[], launchCandidates: string[]): Promise<boolean> {
    if (this.isProcessRunning(imageNames)) return true;

    const launchPath = launchCandidates.find((candidate) => candidate && exists(candidate));
    if (!launchPath) return false;

    try {
      this.startDetached(launchPath);
      await delay(2500);
      return this.isProcessRunning(imageNames);
    } catch {
      return false;
    }
  }

  private async ensureConductor(): Promise<boolean> {
    if (await httpHealthy(CONDUCTOR_HEALTH_URL)) return true;

    const conductorRoot = path.join(this.getCascadeRoot(), "conductor");
    const manageScript = path.join(conductorRoot, "service", "manage.cjs");
    if (!exists(manageScript)) return false;

    try {
      this.startDetached(this.resolveNodeExecutable(), [manageScript, "start"], conductorRoot);
      return await this.waitForHealth(CONDUCTOR_HEALTH_URL);
    } catch {
      return false;
    }
  }

  private async ensureNexusGateway(): Promise<boolean> {
    if (await httpHealthy(NEXUS_GATEWAY_HEALTH_URL)) return true;

    const serverRoot = path.join(this.getCascadeRoot(), "nexus", "server");
    const serverEntry = path.join(serverRoot, "dist", "index.js");
    if (!exists(serverEntry)) return false;

    try {
      this.startDetached(
        this.resolveNodeExecutable(),
        [serverEntry],
        serverRoot,
        {
          ...process.env,
          PORT: "3800",
          NEXUS_DASHBOARD_PORT: "3810",
        }
      );
      return await this.waitForHealth(NEXUS_GATEWAY_HEALTH_URL, 15_000);
    } catch {
      return false;
    }
  }
}
