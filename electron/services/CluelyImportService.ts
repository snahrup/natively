import crypto from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";

import type { LLMHelper } from "../LLMHelper";
import type { RAGManager } from "../rag/RAGManager";
import {
  MeetingImportService,
  type MeetingImportArtifact,
  type MeetingImportResult,
} from "./MeetingImportService";

interface CluelyUserSession {
  user?: {
    email?: string;
  };
  accessToken?: string;
  refreshToken?: string;
}

interface CluelyResolvedProfile {
  appDataDir: string;
  sessionPath: string;
  localStorageDir: string;
  version: "legacy" | "v2";
}

interface CluelyResolvedAccess {
  primaryProfile: CluelyResolvedProfile | null;
  primarySession: CluelyUserSession | null;
  primaryLocalSession: { sessionEmail?: string; authenticated: boolean };
  liveProfile: CluelyResolvedProfile | null;
  liveSession: CluelyUserSession | null;
  liveTokenFresh?: boolean;
  staleTokenProfile: CluelyResolvedProfile | null;
  staleTokenExpiryMs?: number;
}

export interface CluelyImportCandidate {
  sessionId: string;
  meetingTitle: string;
  date?: string;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasUsage: boolean;
  source: "live" | "cached";
}

export interface CluelyDiscoveryResult {
  candidates: CluelyImportCandidate[];
  mode: "live" | "cached" | "unavailable";
  warning?: string;
  sessionEmail?: string;
  tokenFresh?: boolean;
}

export interface CluelyImportRunResult extends MeetingImportResult {
  attemptedSessions: number;
  discoveredCandidates: number;
  mode: "live" | "cached" | "unavailable";
  warning?: string;
}

export class CluelyImportService {
  async discoverCandidates(limit = 12): Promise<CluelyDiscoveryResult> {
    const access = this.resolveAccess();
    const primaryProfile = access.primaryProfile;
    const sessionEmail = access.liveSession?.user?.email || access.primarySession?.user?.email || access.primaryLocalSession.sessionEmail;
    const cached = primaryProfile ? this.discoverCachedCandidates(limit, primaryProfile) : [];

    if (access.liveProfile && access.liveSession?.accessToken) {
      try {
        const items = await this.fetchSessionList(access.liveSession.accessToken, Math.max(limit, 20));
        const candidates = items
          .map((item) => this.normalizeLiveCandidate(item))
          .filter(Boolean)
          .slice(0, limit) as CluelyImportCandidate[];

        return {
          candidates,
          mode: "live",
          sessionEmail,
          tokenFresh: access.liveTokenFresh,
          warning: this.buildLiveWarning(access, candidates.length),
        };
      } catch (error: any) {
        return {
          candidates: cached,
          mode: cached.length > 0 ? "cached" : "unavailable",
          sessionEmail,
          tokenFresh: access.liveTokenFresh,
          warning: this.buildUnavailableWarning(access, cached.length > 0, error?.message),
        };
      }
    }

    return {
      candidates: cached,
      mode: cached.length > 0 ? "cached" : "unavailable",
      sessionEmail,
      tokenFresh: access.liveTokenFresh,
      warning: this.buildUnavailableWarning(access, cached.length > 0),
    };
  }

  async importRecentCandidates(
    deps: { llmHelper: LLMHelper; ragManager?: RAGManager | null },
    options?: { limit?: number; sessionIds?: string[] }
  ): Promise<CluelyImportRunResult> {
    const discovery = await this.discoverCandidates(options?.limit ?? 8);

    if (discovery.mode !== "live") {
      return {
        importedMeetings: [],
        skippedArtifacts: [{
          name: "Cluely Import",
          reason: discovery.warning || "Cluely live import is unavailable. Open Cluely and retry.",
        }],
        totalArtifacts: 0,
        attemptedSessions: 0,
        discoveredCandidates: discovery.candidates.length,
        mode: discovery.mode,
        warning: discovery.warning,
      };
    }

    const access = this.resolveAccess();
    if (!access.liveSession?.accessToken) {
      return {
        importedMeetings: [],
        skippedArtifacts: [{
          name: "Cluely Import",
          reason: discovery.warning || "No live-capable Cluely session token is available.",
        }],
        totalArtifacts: 0,
        attemptedSessions: 0,
        discoveredCandidates: discovery.candidates.length,
        mode: "unavailable",
        warning: discovery.warning,
      };
    }

    const candidates = options?.sessionIds?.length
      ? discovery.candidates.filter((candidate) => options.sessionIds!.includes(candidate.sessionId))
      : discovery.candidates;

    const artifacts: MeetingImportArtifact[] = [];
    const skippedArtifacts: Array<{ name: string; reason: string }> = [];

    for (const candidate of candidates) {
      try {
        const detail = await this.fetchSessionDetail(access.liveSession.accessToken, candidate.sessionId);
        const builtArtifacts = this.buildArtifactsFromSession(detail, candidate);
        if (builtArtifacts.length === 0) {
          skippedArtifacts.push({
            name: candidate.meetingTitle,
            reason: "No transcript, summary, or usage payload was detected in the Cluely session response.",
          });
          continue;
        }
        artifacts.push(...builtArtifacts);
      } catch (error: any) {
        skippedArtifacts.push({
          name: candidate.meetingTitle,
          reason: error?.message || "Failed to fetch Cluely session details.",
        });
      }
    }

    if (artifacts.length === 0) {
      return {
        importedMeetings: [],
        skippedArtifacts,
        totalArtifacts: candidates.length,
        attemptedSessions: candidates.length,
        discoveredCandidates: discovery.candidates.length,
        mode: "live",
        warning: discovery.warning,
      };
    }

    const importResult = await new MeetingImportService().importArtifacts(artifacts, deps);
    return {
      ...importResult,
      skippedArtifacts: [...skippedArtifacts, ...importResult.skippedArtifacts],
      totalArtifacts: candidates.length,
      attemptedSessions: candidates.length,
      discoveredCandidates: discovery.candidates.length,
      mode: "live",
      warning: discovery.warning,
    };
  }

  private getProfileCandidates(): CluelyResolvedProfile[] {
    const appDataRoot = app.getPath("appData");
    return [
      {
        appDataDir: path.join(appDataRoot, "cluely-v2"),
        sessionPath: path.join(appDataRoot, "cluely-v2", "user.session"),
        localStorageDir: path.join(appDataRoot, "cluely-v2", "Local Storage", "leveldb"),
        version: "v2",
      },
      {
        appDataDir: path.join(appDataRoot, "cluely"),
        sessionPath: path.join(appDataRoot, "cluely", "user.session"),
        localStorageDir: path.join(appDataRoot, "cluely", "Local Storage", "leveldb"),
        version: "legacy",
      },
    ];
  }

  private resolveProfile(): CluelyResolvedProfile | null {
    const candidates = this.getProfileCandidates()
      .filter((candidate) =>
        fs.existsSync(candidate.appDataDir) &&
        (fs.existsSync(candidate.localStorageDir) || fs.existsSync(candidate.sessionPath))
      )
      .sort((a, b) => this.getProfileFreshness(b) - this.getProfileFreshness(a));

    return candidates[0] || null;
  }

  private resolveAccess(): CluelyResolvedAccess {
    const candidates = this.getProfileCandidates()
      .filter((candidate) =>
        fs.existsSync(candidate.appDataDir) &&
        (fs.existsSync(candidate.localStorageDir) || fs.existsSync(candidate.sessionPath))
      )
      .sort((a, b) => this.getProfileFreshness(b) - this.getProfileFreshness(a));

    const primaryProfile = candidates[0] || null;
    const primarySession = primaryProfile ? this.readUserSession(primaryProfile) : null;
    const primaryLocalSession = primaryProfile ? this.inferLocalSession(primaryProfile) : { authenticated: false };

    const tokenCandidates = candidates
      .map((profile) => {
        const session = this.readUserSession(profile);
        const expiryMs = this.getTokenExpiryMs(session?.accessToken);
        const tokenFresh = session?.accessToken ? this.isTokenFresh(session.accessToken) : undefined;
        return { profile, session, expiryMs, tokenFresh };
      })
      .filter((entry) => !!entry.session?.accessToken);

    const liveCandidate =
      tokenCandidates.find((entry) => primaryProfile && entry.profile.appDataDir === primaryProfile.appDataDir && entry.tokenFresh !== false) ||
      tokenCandidates.find((entry) => entry.tokenFresh !== false) ||
      null;

    const staleCandidate = tokenCandidates.find((entry) => entry.tokenFresh === false) || null;

    return {
      primaryProfile,
      primarySession,
      primaryLocalSession,
      liveProfile: liveCandidate?.profile || null,
      liveSession: liveCandidate?.session || null,
      liveTokenFresh: liveCandidate?.tokenFresh,
      staleTokenProfile: staleCandidate?.profile || null,
      staleTokenExpiryMs: staleCandidate?.expiryMs,
    };
  }

  private getProfileFreshness(profile: CluelyResolvedProfile): number {
    const markers = [
      path.join(profile.localStorageDir, "LOG"),
      path.join(profile.localStorageDir, "LOG.old"),
      path.join(profile.appDataDir, "Preferences"),
      path.join(profile.appDataDir, "shared-state.json"),
      profile.sessionPath,
    ];

    for (const marker of markers) {
      try {
        if (fs.existsSync(marker)) {
          return fs.statSync(marker).mtimeMs;
        }
      } catch {
        // ignore
      }
    }

    return 0;
  }

  private readUserSession(profile: CluelyResolvedProfile): CluelyUserSession | null {
    try {
      if (!fs.existsSync(profile.sessionPath)) return null;
      return JSON.parse(fs.readFileSync(profile.sessionPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private inferLocalSession(profile: CluelyResolvedProfile): { sessionEmail?: string; authenticated: boolean } {
    if (!fs.existsSync(profile.localStorageDir)) return { authenticated: false };

    const entries = fs.readdirSync(profile.localStorageDir).filter((entry) => /\.(?:ldb|log)$/i.test(entry));
    for (const entry of entries) {
      const filePath = path.join(profile.localStorageDir, entry);
      const buffer = fs.readFileSync(filePath);
      const printable = extractPrintableStrings(buffer);

      let email: string | undefined;
      let authenticated = false;

      for (const text of printable) {
        if (!email) {
          const emailMatch = text.match(/"email":"([^"]+@[^"]+)"/i);
          if (emailMatch) email = emailMatch[1];
        }
        if (text.includes('"$user_state":"identified"')) {
          authenticated = true;
        }
        if (email && authenticated) {
          return { sessionEmail: email, authenticated: true };
        }
      }
    }

    return { authenticated: false };
  }

  private isTokenFresh(token?: string): boolean | undefined {
    const expiryMs = this.getTokenExpiryMs(token);
    return typeof expiryMs === "number" ? expiryMs > Date.now() : undefined;
  }

  private getTokenExpiryMs(token?: string): number | undefined {
    if (!token) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
      return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
    } catch {
      return undefined;
    }
  }

  private buildLiveWarning(access: CluelyResolvedAccess, candidateCount: number): string | undefined {
    if (candidateCount === 0) {
      return "Authenticated Cluely session found, but no importable meetings were returned.";
    }

    if (
      access.primaryProfile?.version === "v2" &&
      access.liveProfile &&
      access.liveProfile.appDataDir !== access.primaryProfile.appDataDir
    ) {
      return "Cluely 2.0 is the active profile. Live import is currently using a legacy token fallback because the v2 profile does not expose a reusable local session token.";
    }

    return undefined;
  }

  private buildUnavailableWarning(
    access: CluelyResolvedAccess,
    hasCachedCandidates: boolean,
    liveError?: string
  ): string {
    if (liveError) {
      return liveError;
    }

    if (access.primaryProfile?.version === "v2" && access.primaryLocalSession.authenticated) {
      if (access.staleTokenProfile && access.staleTokenExpiryMs) {
        return `Cluely 2.0 session detected. ${hasCachedCandidates ? "Cached discovery is available, but " : ""}the fallback legacy token expired on ${this.formatAbsoluteDate(access.staleTokenExpiryMs)}. Open Cluely 2.0 and re-authenticate to restore live import.`;
      }
      return hasCachedCandidates
        ? "Cluely 2.0 session detected. Cached discovery is available, but the v2 profile does not expose a reusable local session token for live import."
        : "Cluely 2.0 session detected, but no reusable local session token or cached meetings were found for live import.";
    }

    if (access.staleTokenProfile && access.staleTokenExpiryMs) {
      return `Cluely session token expired on ${this.formatAbsoluteDate(access.staleTokenExpiryMs)}. Open Cluely and re-authenticate to restore live import.`;
    }

    return hasCachedCandidates
      ? "Cluely live import is unavailable, but cached discovery is still available from local app data."
      : "No usable Cluely session or cached meeting history was found on this machine.";
  }

  private formatAbsoluteDate(timestampMs: number): string {
    return new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(timestampMs));
  }

  private async fetchSessionList(accessToken: string, limit: number): Promise<any[]> {
    const data = await this.postRpc("sessions/list", { limit }, accessToken);
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.sessions)) return data.sessions;
    if (Array.isArray(data)) return data;
    return [];
  }

  private async fetchSessionDetail(accessToken: string, sessionId: string): Promise<any> {
    return this.postRpc("sessions/get", { id: sessionId }, accessToken);
  }

  private async postRpc(route: string, input: Record<string, unknown>, accessToken: string): Promise<any> {
    const response = await fetch(`https://api.v2.cluely.com/rpc/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ json: input }),
    });

    const text = await response.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Cluely RPC ${route} returned non-JSON output.`);
    }

    const body = parsed?.json ?? parsed;
    if (!response.ok) {
      throw new Error(body?.message || `Cluely RPC ${route} failed with status ${response.status}`);
    }

    return body;
  }

  private normalizeLiveCandidate(raw: any): CluelyImportCandidate | null {
    const sessionId = this.extractFirstString(raw, ["id", "sessionId"]);
    if (!sessionId) return null;

    const transcriptText = this.extractTranscriptText(raw);
    const summaryText = this.extractSummaryText(raw);
    const usageText = this.extractUsageText(raw);

    return {
      sessionId,
      meetingTitle: this.extractFirstString(raw, ["title", "meetingTitle", "name", "topic"]) || `Cluely Session ${sessionId.slice(0, 8)}`,
      date: this.extractFirstString(raw, ["startedAt", "createdAt", "updatedAt", "date"]),
      hasTranscript: !!transcriptText,
      hasSummary: !!summaryText,
      hasUsage: !!usageText || Number(raw?.messagesLength || 0) > 0,
      source: "live",
    };
  }

  private buildArtifactsFromSession(detail: any, candidate: CluelyImportCandidate): MeetingImportArtifact[] {
    const meetingTitle = this.extractFirstString(detail, ["title", "meetingTitle", "name", "topic"]) || candidate.meetingTitle;
    const meetingDate = this.extractFirstString(detail, ["startedAt", "createdAt", "updatedAt", "date"]) || candidate.date;
    const sessionId = this.extractFirstString(detail, ["id", "sessionId"]) || candidate.sessionId;

    const artifacts: MeetingImportArtifact[] = [];
    const summaryText = this.extractSummaryText(detail);
    const transcriptText = this.extractTranscriptText(detail);
    const usageText = this.extractUsageText(detail);

    if (summaryText) {
      artifacts.push({
        inputType: "text",
        name: `cluely-${meetingTitle}-summary.md`,
        content: summaryText,
        kind: "summary",
        sourceFormat: "cluely",
        meetingTitle,
        meetingDate,
        id: `${sessionId}-summary`,
      });
    }

    if (transcriptText) {
      artifacts.push({
        inputType: "text",
        name: `cluely-${meetingTitle}-transcript.txt`,
        content: transcriptText,
        kind: "transcript",
        sourceFormat: "cluely",
        meetingTitle,
        meetingDate,
        id: `${sessionId}-transcript`,
      });
    }

    if (usageText) {
      artifacts.push({
        inputType: "text",
        name: `cluely-${meetingTitle}-usage.md`,
        content: usageText,
        kind: "usage",
        sourceFormat: "cluely",
        meetingTitle,
        meetingDate,
        id: `${sessionId}-usage`,
      });
    }

    return artifacts;
  }

  private extractSummaryText(root: any): string {
    const blocks: string[] = [];
    const summaryValue = this.extractFirstValue(root, ["summary", "recap", "overview"]);
    if (summaryValue) {
      const rendered = this.renderSummaryValue(summaryValue);
      if (rendered) blocks.push(rendered);
    }

    const keyPoints = this.extractStringArray(root, ["keyPoints", "highlights"]);
    if (keyPoints.length > 0) {
      blocks.push(`Key Points:\n${keyPoints.map((item) => `- ${item}`).join("\n")}`);
    }

    const actionItems = this.extractStringArray(root, ["actionItems", "nextSteps"]);
    if (actionItems.length > 0) {
      blocks.push(`Action Items:\n${actionItems.map((item) => `- ${item}`).join("\n")}`);
    }

    return blocks.join("\n\n").trim();
  }

  private renderSummaryValue(value: any): string {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) {
      return value.map((entry) => this.renderSummaryValue(entry)).filter(Boolean).join("\n");
    }
    if (value && typeof value === "object") {
      const parts: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (child == null) continue;
        if (typeof child === "string") {
          parts.push(`${prettifyKey(key)}: ${child.trim()}`);
          continue;
        }
        if (Array.isArray(child)) {
          const lines = child.map((item) => cleanInlineText(String(item))).filter(Boolean);
          if (lines.length > 0) {
            parts.push(`${prettifyKey(key)}:\n${lines.map((item) => `- ${item}`).join("\n")}`);
          }
        }
      }
      return parts.join("\n\n").trim();
    }
    return "";
  }

  private extractTranscriptText(root: any): string {
    const transcriptStrings = this.collectStringsFromKeys(root, [
      "transcript",
      "transcriptAll",
      "transcriptMic",
      "transcriptSystem",
      "audioTranscript",
    ]);
    const transcriptArrays = this.collectArraysFromKeys(root, [
      "transcript",
      "transcriptAll",
      "transcriptMic",
      "transcriptSystem",
      "audioTranscript",
    ]);

    const renderedArrays = transcriptArrays
      .map((value) => this.renderTranscriptArray(value))
      .filter(Boolean);

    return dedupeStrings([...transcriptStrings, ...renderedArrays]).join("\n\n").trim();
  }

  private extractUsageText(root: any): string {
    const usageArrays = this.collectArraysFromKeys(root, ["messages", "usage", "chat", "interactions"]);
    const rendered = usageArrays
      .map((value) => this.renderUsageArray(value))
      .filter(Boolean);

    return dedupeStrings(rendered).join("\n\n").trim();
  }

  private renderTranscriptArray(value: unknown[]): string {
    const lines = value
      .map((entry) => {
        if (typeof entry === "string") return cleanInlineText(entry);
        if (!entry || typeof entry !== "object") return "";
        const speaker = cleanInlineText(
          String((entry as any).speaker || (entry as any).role || (entry as any).participant || (entry as any).name || "Speaker")
        );
        const text = cleanInlineText(
          String((entry as any).text || (entry as any).content || (entry as any).message || (entry as any).utterance || "")
        );
        if (!text) return "";
        return `${speaker}: ${text}`;
      })
      .filter(Boolean);

    return lines.join("\n").trim();
  }

  private renderUsageArray(value: unknown[]): string {
    const lines = value
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const role = cleanInlineText(
          String((entry as any).role || (entry as any).type || (entry as any).sender || "message")
        );
        const text = cleanInlineText(
          String((entry as any).text || (entry as any).content || (entry as any).message || "")
        );
        if (!text) return "";
        return `${role}: ${text}`;
      })
      .filter(Boolean);

    return lines.join("\n").trim();
  }

  private extractFirstString(root: any, keys: string[]): string | undefined {
    const value = this.extractFirstValue(root, keys);
    if (typeof value === "string" && value.trim()) return value.trim();
    return undefined;
  }

  private extractStringArray(root: any, keys: string[]): string[] {
    const values = this.collectArraysFromKeys(root, keys);
    return dedupeStrings(
      values.flatMap((value) =>
        value
          .map((item) => cleanInlineText(typeof item === "string" ? item : JSON.stringify(item)))
          .filter(Boolean)
      )
    );
  }

  private extractFirstValue(root: any, keys: string[]): any {
    const normalizedKeys = new Set(keys.map(normalizeKeyName));
    const queue: any[] = [root];
    const seen = new Set<any>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);

      for (const [key, value] of Object.entries(current)) {
        if (normalizedKeys.has(normalizeKeyName(key)) && value != null) {
          return value;
        }
        if (value && typeof value === "object") queue.push(value);
      }
    }

    return undefined;
  }

  private collectStringsFromKeys(root: any, keys: string[]): string[] {
    return this.collectValuesFromKeys(root, keys)
      .flatMap((value) => typeof value === "string" ? [cleanInlineText(value)] : [])
      .filter(Boolean);
  }

  private collectArraysFromKeys(root: any, keys: string[]): unknown[][] {
    return this.collectValuesFromKeys(root, keys)
      .filter((value): value is unknown[] => Array.isArray(value));
  }

  private collectValuesFromKeys(root: any, keys: string[]): any[] {
    const normalizedKeys = new Set(keys.map(normalizeKeyName));
    const queue: any[] = [root];
    const seen = new Set<any>();
    const values: any[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);

      for (const [key, value] of Object.entries(current)) {
        if (normalizedKeys.has(normalizeKeyName(key)) && value != null) {
          values.push(value);
        }
        if (value && typeof value === "object") queue.push(value);
      }
    }

    return values;
  }

  private discoverCachedCandidates(limit: number, profile: CluelyResolvedProfile): CluelyImportCandidate[] {
    if (!fs.existsSync(profile.localStorageDir)) return [];

    const titles = new Set<string>();
    const sessionIds = new Set<string>();
    const entries = fs.readdirSync(profile.localStorageDir).filter((entry) => /\.(?:ldb|log)$/i.test(entry));

    for (const entry of entries) {
      const filePath = path.join(profile.localStorageDir, entry);
      const buffer = fs.readFileSync(filePath);
      for (const text of extractPrintableStrings(buffer)) {
        const normalized = cleanInlineText(text);
        const sessionMatches = normalized.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
        if (sessionMatches) {
          for (const sessionId of sessionMatches) {
            sessionIds.add(sessionId);
          }
        }
        if (!looksLikeMeetingTitle(normalized)) continue;
        titles.add(normalized);
        if (titles.size >= limit * 3) break;
      }
      if (titles.size >= limit * 3) break;
    }

    const titledCandidates = Array.from(titles)
      .slice(0, limit);

    if (titledCandidates.length > 0) {
      return titledCandidates.map((meetingTitle) => ({
        sessionId: `cached-${crypto.createHash("sha1").update(meetingTitle).digest("hex").slice(0, 12)}`,
        meetingTitle,
        hasTranscript: false,
        hasSummary: false,
        hasUsage: false,
        source: "cached" as const,
      }));
    }

    return Array.from(sessionIds)
      .slice(0, limit)
      .map((sessionId) => ({
        sessionId: `cached-${sessionId}`,
        meetingTitle: `Cluely Session ${sessionId.slice(0, 8)}`,
        hasTranscript: false,
        hasSummary: false,
        hasUsage: false,
        source: "cached" as const,
      }));
  }
}

function normalizeKeyName(input: string): string {
  return input.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function prettifyKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function extractPrintableStrings(buffer: Buffer): string[] {
  const strings: string[] = [];
  let current = "";

  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= 18) strings.push(current);
    current = "";
  }

  if (current.length >= 18) strings.push(current);
  return strings;
}

function looksLikeMeetingTitle(value: string): boolean {
  if (value.length < 8 || value.length > 120) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/[{}<>[\]]/.test(value)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  if (/^[0-9a-f]{12,}$/i.test(value)) return false;
  if (/^cached-[0-9a-f-]+$/i.test(value)) return false;
  const lower = value.toLowerCase();
  if (["meeting", "sync", "standup", "review", "catchup", "1:1", "retro", "planning", "recap"].some((token) => lower.includes(token))) {
    return true;
  }
  return /^[A-Z0-9][A-Za-z0-9 &'/:().,-]+$/.test(value);
}
