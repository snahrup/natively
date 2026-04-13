import { BrowserWindow, app, screen } from "electron";
import path from "node:path";
import type { WindowHelper } from "./WindowHelper";

const isDev = process.env.NODE_ENV === "development";
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5180";

const startUrl = isDev
  ? devServerUrl
  : `file://${path.join(app.getAppPath(), "dist/index.html")}`;

type WindowActivationOptions = {
  activate?: boolean;
};

export class ChatLogViewerWindowHelper {
  private window: BrowserWindow | null = null;
  private contentProtection = false;
  private windowHelper: WindowHelper | null = null;

  public setWindowHelper(wh: WindowHelper): void {
    this.windowHelper = wh;
  }

  public getWindow(): BrowserWindow | null {
    return this.window;
  }

  public showWindow(options: WindowActivationOptions = {}): void {
    if (!this.window || this.window.isDestroyed()) {
      this.createWindow();
    }

    if (!this.window) return;

    const mainWin = this.windowHelper?.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      this.window.setParentWindow(mainWin);
    }

    const activate = options.activate ?? true;
    this.ensureVisibleOnScreen();
    if (activate) {
      this.window.show();
      this.window.focus();
    } else {
      this.window.showInactive();
    }
  }

  public hideWindow(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.hide();
  }

  public closeWindow(): void {
    this.hideWindow();
  }

  public setContentProtection(enable: boolean): void {
    this.contentProtection = enable;
    if (this.window && !this.window.isDestroyed()) {
      this.window.setContentProtection(enable);
    }
  }

  private createWindow(): void {
    const display = screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const width = Math.min(1280, Math.round(workArea.width * 0.9));
    const height = Math.min(860, Math.round(workArea.height * 0.9));
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + (workArea.height - height) / 2);

    this.window = new BrowserWindow({
      width,
      height,
      x,
      y,
      minWidth: 980,
      minHeight: 620,
      frame: false,
      transparent: true,
      resizable: true,
      fullscreenable: false,
      hasShadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "preload.js"),
        backgroundThrottling: false,
      },
    });

    if (process.platform === "darwin") {
      this.window.setHiddenInMissionControl(true);
    }

    this.window.setContentProtection(this.contentProtection);

    const url = `${startUrl}?window=chat-log-viewer`;
    this.window.loadURL(url).catch((error) => {
      console.error("[ChatLogViewerWindowHelper] Failed to load URL:", error);
    });

    this.window.on("closed", () => {
      this.window = null;
    });
  }

  private ensureVisibleOnScreen(): void {
    if (!this.window || this.window.isDestroyed()) return;

    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const workArea = display.workArea;

    const nextX = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width);
    const nextY = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - bounds.height);

    if (nextX !== bounds.x || nextY !== bounds.y) {
      this.window.setPosition(nextX, nextY);
    }
  }
}
