import fs from "fs";
import os from "os";
import path from "path";

function getUserHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function getAppDataDir(): string {
  return process.env.APPDATA || path.join(getUserHomeDir(), "AppData", "Roaming");
}

function syncFileIfPresent(sourcePath: string, targetPath: string): void {
  try {
    if (!fs.existsSync(sourcePath)) return;

    const sourceStats = fs.statSync(sourcePath);
    const targetStats = fs.existsSync(targetPath) ? fs.statSync(targetPath) : null;
    const targetIsCurrent = !!targetStats
      && targetStats.size === sourceStats.size
      && targetStats.mtimeMs >= sourceStats.mtimeMs;

    if (targetIsCurrent) return;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  } catch (error) {
    console.warn("[ClaudeCliEnvironment] Failed to sync file:", sourcePath, error);
  }
}

export function getStableClaudeConfigDir(): string {
  return path.join(getAppDataDir(), "Natively", "claude-config");
}

export function prepareStableClaudeConfigDir(): string {
  const configDir = getStableClaudeConfigDir();
  const homeDir = getUserHomeDir();

  fs.mkdirSync(configDir, { recursive: true });
  syncFileIfPresent(path.join(homeDir, ".claude", ".credentials.json"), path.join(configDir, ".credentials.json"));
  syncFileIfPresent(path.join(homeDir, ".claude.json"), path.join(configDir, ".claude.json"));

  return configDir;
}

export function buildClaudeCliEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const homeDir = getUserHomeDir();
  const parsed = path.parse(homeDir);

  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, "");
  env.HOMEPATH = homeDir.slice(parsed.root.length - 1);
  env.CLAUDE_CONFIG_DIR = prepareStableClaudeConfigDir();
  delete env.CLAUDE_CODE_SIMPLE;

  return env;
}
