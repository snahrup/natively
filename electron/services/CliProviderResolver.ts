import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export type LocalCliProvider = "claude" | "codex";
export type LocalCliState = "ready" | "missing";

export interface LocalCliStatus {
  state: LocalCliState;
  path: string | null;
}

export interface LocalCliInvocation {
  command: string;
  args: string[];
  resolvedPath: string;
}

const CACHE_TTL_MS = 5_000;
const resolveCache = new Map<LocalCliProvider, { checkedAt: number; resolvedPath: string | null }>();

function existingFile(candidate: string | null | undefined): candidate is string {
  if (!candidate) return false;
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extensionRank(candidate: string): number {
  if (/\.exe$/i.test(candidate)) return 0;
  if (!path.extname(candidate)) return 1;
  if (/\.cmd$/i.test(candidate)) return 2;
  if (/\.bat$/i.test(candidate)) return 3;
  return 4;
}

function queryPath(provider: LocalCliProvider): string[] {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("where.exe", [provider], {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      });
      if (typeof result.stdout === "string" && result.stdout.trim()) {
        return result.stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean);
      }
      return [];
    }

    const result = spawnSync("which", [provider], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (typeof result.stdout === "string" && result.stdout.trim()) {
      return result.stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    }
  } catch {
    // Ignore lookup failures and continue with fallbacks.
  }
  return [];
}

function collectWindsurfCodexCandidates(): string[] {
  const extensionsDir = path.join(os.homedir(), ".windsurf", "extensions");
  if (!existingFile(extensionsDir)) return [];

  try {
    return fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(extensionsDir, entry.name, "bin", "windows-x86_64", "codex.exe"))
      .filter(existingFile);
  } catch {
    return [];
  }
}

function fallbackCandidates(provider: LocalCliProvider): string[] {
  const homeDir = os.homedir();

  if (provider === "claude") {
    return [
      path.join(homeDir, ".local", "bin", "claude.exe"),
      path.join(homeDir, ".local", "bin", "claude"),
      path.join(homeDir, "AppData", "Local", "Programs", "Claude", "claude.exe"),
    ];
  }

  return [
    path.join(homeDir, ".local", "bin", "codex.exe"),
    path.join(homeDir, ".local", "bin", "codex"),
    "C:\\nodejs\\current\\codex.exe",
    "C:\\nodejs\\current\\codex",
    "C:\\nodejs\\current\\codex.cmd",
    ...collectWindsurfCodexCandidates(),
  ];
}

function buildCommandLine(parts: string[]): string {
  return parts
    .map(part => {
      if (part.length === 0) return '""';
      if (!/[\s"]/u.test(part)) return part;
      return `"${part.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

export function resolveLocalCliPath(provider: LocalCliProvider, refresh: boolean = false): string | null {
  const cached = resolveCache.get(provider);
  if (!refresh && cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.resolvedPath;
  }

  const resolvedPath = uniqueStrings([
    ...queryPath(provider),
    ...fallbackCandidates(provider),
  ])
    .filter(existingFile)
    .sort((left, right) => extensionRank(left) - extensionRank(right))[0] ?? null;

  resolveCache.set(provider, {
    checkedAt: Date.now(),
    resolvedPath,
  });

  return resolvedPath;
}

export function getLocalCliStatus(provider: LocalCliProvider, refresh: boolean = false): LocalCliStatus {
  const resolvedPath = resolveLocalCliPath(provider, refresh);
  return {
    state: resolvedPath ? "ready" : "missing",
    path: resolvedPath,
  };
}

export function isLocalCliAvailable(provider: LocalCliProvider, refresh: boolean = false): boolean {
  return !!resolveLocalCliPath(provider, refresh);
}

export function buildLocalCliInvocation(provider: LocalCliProvider, args: string[], refresh: boolean = false): LocalCliInvocation {
  const resolvedPath = resolveLocalCliPath(provider, refresh);
  if (!resolvedPath) {
    const providerName = provider === "claude" ? "Claude" : "Codex";
    throw new Error(`${providerName} CLI not found. Reinstall the local ${providerName} app/CLI and reopen Natively.`);
  }

  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedPath)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", buildCommandLine([resolvedPath, ...args])],
      resolvedPath,
    };
  }

  return {
    command: resolvedPath,
    args,
    resolvedPath,
  };
}
