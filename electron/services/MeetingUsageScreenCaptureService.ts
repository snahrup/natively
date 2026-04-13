import fs from "fs";
import path from "path";
import { app } from "electron";
import { randomUUID } from "crypto";
import { ContinuousOCRService, OCRDisplayCapture } from "./ContinuousOCRService";

export interface MeetingUsageScreenCapture {
  path: string;
  capturedAt: number;
  displayId: number;
  displayLabel: string;
  alias: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPrimary: boolean;
}

export class MeetingUsageScreenCaptureService {
  private static instance: MeetingUsageScreenCaptureService;
  private readonly baseDir: string;

  private constructor() {
    this.baseDir = path.join(app.getPath("appData"), "natively", "meeting-screen-captures");
  }

  static getInstance(): MeetingUsageScreenCaptureService {
    if (!MeetingUsageScreenCaptureService.instance) {
      MeetingUsageScreenCaptureService.instance = new MeetingUsageScreenCaptureService();
    }
    return MeetingUsageScreenCaptureService.instance;
  }

  async captureForUsage(timestamp = Date.now()): Promise<MeetingUsageScreenCapture[]> {
    const captureService = ContinuousOCRService.getInstance();
    let captures: OCRDisplayCapture[] = [];

    try {
      captures = await captureService.captureDisplaySetNow();
    } catch (error) {
      console.warn("[MeetingUsageScreenCaptureService] Live capture failed, falling back to cached OCR images:", error);
      captures = captureService.getLatestCaptureSet();
    }

    if (!captures.length) {
      return [];
    }

    const dayKey = new Date(timestamp).toISOString().slice(0, 10);
    const captureDir = path.join(this.baseDir, dayKey, `${timestamp}-${randomUUID()}`);
    await fs.promises.mkdir(captureDir, { recursive: true });

    const persisted = await Promise.all(
      captures.map(async (capture, index) => {
        const filename = `${String(index + 1).padStart(2, "0")}-${sanitizeFilename(capture.alias)}.png`;
        const outputPath = path.join(captureDir, filename);
        await fs.promises.writeFile(outputPath, capture.image);
        return {
          path: outputPath,
          capturedAt: capture.capturedAt,
          displayId: capture.displayId,
          displayLabel: capture.displayLabel,
          alias: capture.alias,
          bounds: capture.bounds,
          isPrimary: capture.isPrimary,
        };
      })
    );

    return persisted;
  }

  async deleteCapturedFiles(captures: Array<{ path?: string }> = []): Promise<void> {
    const directories = new Set<string>();

    for (const capture of captures) {
      const filePath = capture?.path;
      if (!filePath || !path.isAbsolute(filePath)) continue;
      if (!filePath.startsWith(this.baseDir)) continue;

      try {
        await fs.promises.unlink(filePath);
        directories.add(path.dirname(filePath));
      } catch (error: any) {
        if (error?.code !== "ENOENT") {
          console.warn("[MeetingUsageScreenCaptureService] Failed to remove capture:", filePath, error);
        }
      }
    }

    for (const directory of Array.from(directories).sort((a, b) => b.length - a.length)) {
      await removeEmptyParents(directory, this.baseDir);
    }
  }
}

function sanitizeFilename(value: string): string {
  return String(value || "display")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "display";
}

async function removeEmptyParents(startDir: string, stopDir: string): Promise<void> {
  let currentDir = startDir;

  while (currentDir.startsWith(stopDir) && currentDir !== stopDir) {
    try {
      const entries = await fs.promises.readdir(currentDir);
      if (entries.length > 0) break;
      await fs.promises.rmdir(currentDir);
      currentDir = path.dirname(currentDir);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        currentDir = path.dirname(currentDir);
        continue;
      }
      if (error?.code === "ENOTEMPTY") {
        break;
      }
      console.warn("[MeetingUsageScreenCaptureService] Failed to clean capture directory:", currentDir, error);
      break;
    }
  }
}
