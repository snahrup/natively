import fs from "fs";
import path from "path";
import { app } from "electron";

import type { DesktopContext } from "./types";

export class DesktopContextService {
  private static instance: DesktopContextService;

  public static getInstance(): DesktopContextService {
    if (!DesktopContextService.instance) {
      DesktopContextService.instance = new DesktopContextService();
    }
    return DesktopContextService.instance;
  }

  public getContext(): DesktopContext {
    return {
      capturedAt: new Date().toISOString(),
      knownRepoPaths: this.resolveKnownRepoPaths(),
      activeWindowTitle: null,
    };
  }

  private resolveKnownRepoPaths(): string[] {
    const candidates = [
      process.env.NATIVELY_FMD_REPO_PATH,
      path.join(app.getPath("home"), "CascadeProjects", "FMD_FRAMEWORK"),
    ].filter((value): value is string => !!value);

    const unique = new Set<string>();
    for (const candidate of candidates) {
      try {
        const resolved = path.resolve(candidate);
        if (fs.existsSync(resolved)) {
          unique.add(resolved);
        }
      } catch {
        // Best-effort context only.
      }
    }

    return [...unique];
  }
}
