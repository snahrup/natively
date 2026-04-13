/**
 * ContinuousOCRService
 *
 * Watches ALL screens every N seconds using Electron's desktopCapturer,
 * sends the frames to the vision LLM for text extraction, and maintains a
 * rolling buffer of extracted text. The buffer is exposed as context to
 * LLMHelper so every AI call automatically includes "what's on screen".
 *
 * Design goals:
 * - Zero user interaction required (no hotkeys, no manual screenshots)
 * - Multi-monitor aware (captures every display)
 * - Low overhead (3 s interval default, skips if LLM busy)
 * - Rolling 60-second window so stale content ages out
 */

import { desktopCapturer, screen } from "electron";
import sharp from "sharp";
import { randomUUID } from "crypto";
import { ContextObservationStore } from "../context";

export interface OCRFrame {
  capturedAt: number;          // unix ms
  text: string;                // extracted text
  displayCount: number;        // how many screens were captured
}

export interface OCRDisplayCapture {
  image: Buffer;
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

interface SessionDisplay {
  id: number;
  label: string;
  alias: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPrimary: boolean;
}

type VisionAnalyzerFn = (imagePaths: string[], prompt: string) => Promise<string>;

export class ContinuousOCRService {
  private static instance: ContinuousOCRService;

  private intervalMs: number;
  private rollingWindowMs: number;
  private frames: OCRFrame[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private analyzerFn: VisionAnalyzerFn | null = null;
  private busy = false;
  private runToken = 0;

  // Cached last capture as base64 buffers (skip encoding to disk for speed)
  private lastCaptureSet: OCRDisplayCapture[] = [];
  private lastDisplayReferences: string[] = [];
  private sessionDisplays: SessionDisplay[] = [];

  private constructor(intervalMs = 5000, rollingWindowMs = 60_000) {
    this.intervalMs = intervalMs;
    this.rollingWindowMs = rollingWindowMs;
  }

  static getInstance(): ContinuousOCRService {
    if (!ContinuousOCRService.instance) {
      ContinuousOCRService.instance = new ContinuousOCRService();
    }
    return ContinuousOCRService.instance;
  }

  /**
   * Provide the vision analysis function (LLMHelper.analyzeImageWithVision or similar).
   * The service calls this with in-memory base64 images.
   */
  setAnalyzer(fn: VisionAnalyzerFn) {
    this.analyzerFn = fn;
  }

  /** Start continuous capture loop. Safe to call multiple times (idempotent). */
  start() {
    if (this.running) return;
    this.runToken += 1;
    this.running = true;
    this.sessionDisplays = this.captureSessionDisplayLayout();
    this.lastDisplayReferences = this.sessionDisplays.map((display) => {
      const primarySuffix = display.isPrimary ? " (primary)" : "";
      return `${display.alias} -> OS display ${display.label}${primarySuffix}`;
    });
    console.log(`[ContinuousOCR] Starting — interval ${this.intervalMs}ms`);
    this.timer = setInterval(() => this.captureAndExtract(), this.intervalMs);
    // Immediate first capture
    this.captureAndExtract();
  }

  stop() {
    this.runToken += 1;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frames = [];
    this.lastCaptureSet = [];
    this.lastDisplayReferences = [];
    this.sessionDisplays = [];
    console.log("[ContinuousOCR] Stopped");
  }

  /** Returns true only if the capture loop is actively running. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Returns the rolling OCR context as a single string, newest first.
   * Suitable for injection into LLMHelper context.
   */
  getContext(): string {
    this.pruneOldFrames();
    if (this.frames.length === 0) return "";

    const displayReferenceGuide = this.lastDisplayReferences.length > 0
      ? `Current display reference map:\n${this.lastDisplayReferences.map((line) => `- ${line}`).join("\n")}\n\n`
      : "";

    const lines = this.frames
      .slice()
      .reverse()
      .map(f => {
        const ago = Math.round((Date.now() - f.capturedAt) / 1000);
        return `[Screen content captured ${ago}s ago]\n${f.text}`;
      });

    return `## Live Screen Context\n${displayReferenceGuide}${lines.join("\n\n")}`;
  }

  /** Latest raw screenshot buffers (PNG) for multimodal calls. */
  getLatestImages(): Buffer[] {
    return this.lastCaptureSet.map((capture) => Buffer.from(capture.image));
  }

  getLatestCaptureSet(): OCRDisplayCapture[] {
    return this.lastCaptureSet.map((capture) => ({
      ...capture,
      image: Buffer.from(capture.image),
    }));
  }

  async captureDisplaySetNow(): Promise<OCRDisplayCapture[]> {
    const captures = await this.captureAllDisplays();
    const capturedAt = Date.now();
    this.rememberCaptureSet(captures, capturedAt);
    return this.getLatestCaptureSet();
  }

  // ─────────────────────────────────────────────────────
  private captureSessionDisplayLayout(): SessionDisplay[] {
    const primaryDisplayId = screen.getPrimaryDisplay().id;
    const displays = screen.getAllDisplays()
      .slice()
      .sort((a, b) => {
        if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
        if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
        return a.id - b.id;
      });

    return displays.map((display, index) => ({
      id: display.id,
      label: String(display.label || display.id),
      alias: buildDisplayAlias(index, displays.length),
      bounds: display.bounds,
      isPrimary: display.id === primaryDisplayId,
    }));
  }

  private async captureAllDisplays(): Promise<Array<Omit<OCRDisplayCapture, "capturedAt">>> {
    const displays = this.sessionDisplays.length > 0
      ? this.sessionDisplays
      : this.captureSessionDisplayLayout();
    const captures: Array<Omit<OCRDisplayCapture, "capturedAt">> = [];

    for (const display of displays) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
        });

        const displayIdStr = display.id.toString();
        let source = sources.find(s => ("display_id" in s) && s.display_id === displayIdStr);
        if (!source) source = sources[0];
        if (!source) continue;

        // Resize to a sensible OCR resolution (1280px wide max) to keep tokens low
        const raw = source.thumbnail.toPNG();
        const resized = await sharp(raw)
          .resize({ width: 1280, withoutEnlargement: true })
          .png()
          .toBuffer();

        captures.push({
          image: resized,
          displayId: display.id,
          displayLabel: display.label,
          alias: display.alias,
          bounds: display.bounds,
          isPrimary: display.isPrimary,
        });
      } catch (err: any) {
        console.warn(`[ContinuousOCR] Capture failed for display ${display.id}:`, err.message);
      }
    }

    return captures;
  }

  private rememberCaptureSet(captures: Array<Omit<OCRDisplayCapture, "capturedAt">>, capturedAt: number) {
    this.lastCaptureSet = captures.map((capture) => ({
      ...capture,
      capturedAt,
      image: Buffer.from(capture.image),
    }));
    this.lastDisplayReferences = captures.map((capture) => {
      const primarySuffix = capture.isPrimary ? " (primary)" : "";
      return `${capture.alias} -> OS display ${capture.displayLabel}${primarySuffix}`;
    });
  }

  private async captureAndExtract() {
    if (this.busy || !this.analyzerFn) return;
    this.busy = true;
    const runToken = this.runToken;

    try {
      const captures = await this.captureAllDisplays();
      if (captures.length === 0) return;
      if (!this.running || runToken !== this.runToken) return;

      const capturedAt = Date.now();
      this.rememberCaptureSet(captures, capturedAt);

      // Write temp files so analyzerFn can read them (most vision helpers take file paths)
      const os = await import("os");
      const path = await import("path");
      const fs = await import("fs");
      const tmpDir = os.default.tmpdir();
      const tmpPaths: string[] = [];

      for (let i = 0; i < captures.length; i++) {
        const p = path.default.join(tmpDir, `natively_ocr_${process.pid}_${Date.now()}_${i}_${randomUUID()}.png`);
        await fs.default.promises.writeFile(p, captures[i].image);
        tmpPaths.push(p);
      }

      const extractedByDisplay: string[] = [];
      try {
        for (let i = 0; i < tmpPaths.length; i++) {
          const capture = captures[i];
          const prompt = [
            "Extract ALL visible text from this screen capture.",
            "Include text from every window, dialog, browser tab, document, and UI element visible.",
            "Return only the raw text from this single display with no commentary.",
            "If the screen is blank or has no readable text, return an empty string.",
            `This image corresponds to the ${capture.alias}.`,
          ].join(" ");
          const extracted = await this.analyzerFn([tmpPaths[i]], prompt);
          const cleaned = extracted?.trim();
          if (cleaned && cleaned.length > 10) {
            const primarySuffix = capture.isPrimary ? " | primary" : "";
            extractedByDisplay.push(
              `[${capture.alias} | OS display ${capture.displayLabel}${primarySuffix} | x=${capture.bounds.x}]\n${cleaned}`
            );
          }
        }
      } finally {
        // Always clean up temp files regardless of analyzer success/failure
        for (const p of tmpPaths) {
          fs.default.unlink(p, () => {});
        }
      }

      if (!this.running || runToken !== this.runToken) return;
      const combinedExtracted = extractedByDisplay.join("\n\n").trim();
      if (combinedExtracted.length > 10) {
        this.frames.push({
          capturedAt,
          text: combinedExtracted,
          displayCount: captures.length,
        });
        ContextObservationStore.getInstance().recordOCRObservation({
          text: combinedExtracted,
          capturedAt,
          displayCount: captures.length,
        });
        this.pruneOldFrames();
        console.log(`[ContinuousOCR] Captured ${captures.length} screen(s), ${combinedExtracted.length} chars`);
      }
    } catch (err: any) {
      console.warn("[ContinuousOCR] Extract failed:", err.message);
    } finally {
      this.busy = false;
    }
  }

  private pruneOldFrames() {
    const cutoff = Date.now() - this.rollingWindowMs;
    this.frames = this.frames.filter(f => f.capturedAt >= cutoff);
  }
}

function buildDisplayAlias(index: number, total: number): string {
  if (total <= 1) return "main display";
  if (total === 2) return index === 0 ? "left display" : "right display";
  if (total === 3) {
    if (index === 0) return "left display";
    if (index === 1) return "middle display";
    return "right display";
  }
  if (index === 0) return "leftmost display";
  if (index === total - 1) return "rightmost display";
  return `center display ${index}`;
}
