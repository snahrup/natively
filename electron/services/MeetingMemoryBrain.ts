/**
 * MeetingMemoryBrain
 *
 * The unified knowledge layer for Natively's meeting assistant.
 * Aggregates and makes searchable:
 *
 *   1. IP Corp architecture brain (ipcorp-architecture-brain/**) - company structure,
 *      systems, stakeholders, decisions, glossary, gotchas
 *   2. Past meeting transcripts & summaries from Natively's SQLite DB
 *   3. Imported operational context and future feeds
 *
 * Everything runs in the Electron main process so it has direct FS + DB access.
 * Search is keyword-based for v1 (fast, no embedding cost).
 * RAG via sqlite-vec is the planned v2 upgrade.
 *
 * Usage:
 *   const brain = MeetingMemoryBrain.getInstance();
 *   await brain.initialize(dbManager);
 *   const context = brain.search("M3 ERP budget approval");
 */

import fs from "fs";
import path from "path";
import os from "os";

// ─── Types ───────────────────────────────────────────────────────────────────

interface KnowledgeChunk {
  source: string;        // file path or "meeting:<id>"
  type: "knowledge" | "transcript" | "summary" | "entity" | "contradiction";
  title: string;
  content: string;
  date?: string;         // ISO string for temporal ranking
  keywords: string[];    // pre-extracted lowercase terms
  superseded?: boolean;
  supersededBy?: string;
}

interface SearchResult {
  chunk: KnowledgeChunk;
  score: number;
}

export interface MemorySearchHit {
  source: string;
  type: KnowledgeChunk["type"];
  title: string;
  content: string;
  date?: string;
  score: number;
}

// ─── Brain ───────────────────────────────────────────────────────────────────

const IPCORP_BRAIN_PATH = path.join(
  os.homedir(),
  "CascadeProjects",
  "ipcorp-architecture-brain"
);

const LEGACY_KNOWLEDGE_BASE_PATH = path.join(
  os.homedir(),
  "CascadeProjects",
  "fabric_toolbox",
  "knowledge"
);

// Files to always load first from the canonical IP Corp architecture brain.
const IPCORP_PRIORITY_FILES = [
  "README.md",
  "MEMORY.md",
  "AGENTS.md",
  "CLAUDE.md",
  "agent-prompts/system-doctrine.md",
  "agent-prompts/meeting-intelligence.md",
  "agent-prompts/fabric-mdm-advisor.md",
  "project-memory/README.md",
  "project-memory/company-context.md",
  "project-memory/company-structure.md",
  "project-memory/systems-landscape.md",
  "project-memory/source-databases.md",
  "project-memory/stakeholder-map.md",
  "project-memory/open-questions.md",
  "project-memory/risk-register.md",
  "project-memory/purview-implementation-strategy.md",
  "project-memory/source-systems/m3.md",
  "project-memory/source-systems/mes.md",
  "project-memory/decisions/_index.md",
  "project-memory/decisions/ADR-0001-knowledge-consolidation.md",
  "project-memory/decisions/ADR-0002-purview-parallel-governance-track.md",
  "project-memory/decisions/ADR-0003-meeting-source-priority-and-evidence-index.md",
  "execution-package/00_Read_First/00_SUMMARY_AND_USAGE_GUIDE.md",
  "execution-package/00_Read_First/01_EXECUTIVE_ACTION_MEMO.md",
  "execution-package/02_Implementation_Playbooks/01_Fabric_Implementation_Guide.md",
  "execution-package/02_Implementation_Playbooks/02_Medallion_Layer_Standards.md",
  "execution-package/03_Domain_Documentation/Shared_Conformed_Dimensions.md",
];

const IPCORP_SCAN_DIRS = [
  "project-memory",
  "memory",
  "natively/meeting-captures",
  "natively/live-captures",
  "meetings/summaries",
  "execution-package/00_Read_First",
  "execution-package/01_Strategy_and_Governance",
  "execution-package/02_Implementation_Playbooks",
  "execution-package/03_Domain_Documentation",
  "books",
];

const TEXT_FILE_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const MAX_KNOWLEDGE_FILE_BYTES = 450_000;

// Legacy fallback only. The canonical source is ipcorp-architecture-brain.
const LEGACY_PRIORITY_FILES = [
  "knowledge-docs/IP-Corp-Fabric-Knowledge-Base-Complete.txt",
  "IP-CORP-SYSTEM-OVERVIEW.md",
  "ipcorp-knowledge.md",
  "ipcorp-fabric-engagement.md",
];

// Entity JSON files (contacts, companies, etc.)
const ENTITY_FILES = [
  "entities/contacts.json",
  "entities/companies.json",
  "entities/systems.json",
  "entities/glossary.json",
];

// Learnings JSON files
const LEARNING_FILES = [
  "learnings/decisions.json",
  "learnings/discoveries.json",
  "learnings/gotchas.json",
];

export class MeetingMemoryBrain {
  private static instance: MeetingMemoryBrain;

  private chunks: KnowledgeChunk[] = [];
  public initialized = false;
  private db: any = null;   // better-sqlite3 Database instance
  private initPromise: Promise<void> | null = null;  // reload mutex

  static getInstance(): MeetingMemoryBrain {
    if (!MeetingMemoryBrain.instance) {
      MeetingMemoryBrain.instance = new MeetingMemoryBrain();
    }
    return MeetingMemoryBrain.instance;
  }

  /** Call once after app startup. Pass the DatabaseManager instance (or its .db). */
  async initialize(dbOrManager: any): Promise<void> {
    // Mutex: if already initializing, wait for that to complete
    if (this.initPromise) return this.initPromise;
    if (this.initialized) return;

    console.log("[MeetingMemoryBrain] Initializing...");

    // Accept either a DatabaseManager (with .db) or a raw better-sqlite3 db
    if (dbOrManager) this.db = dbOrManager?.db ?? dbOrManager;

    this.initPromise = (async () => {
      await Promise.all([this.loadKnowledgeBase(), this.loadPastMeetings()]);
      await this.loadContradictions();
      this.initialized = true;
      this.initPromise = null;
      console.log(`[MeetingMemoryBrain] Ready — ${this.chunks.length} chunks indexed`);
    })();

    return this.initPromise;
  }

  /** Reload all sources (call after a new meeting ends). */
  async reload(): Promise<void> {
    // Wait for any in-progress init to settle before clearing
    if (this.initPromise) await this.initPromise;
    this.chunks = [];
    this.initialized = false;
    await this.initialize(null);
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  /**
   * Keyword search across all knowledge chunks.
   * Returns the top N most relevant chunks as a formatted context block.
   */
  search(query: string, topN = 8): string {
    const top = this.searchEntries(query, topN);
    if (top.length === 0) return "";

    return top
      .map(r => `### [${r.type.toUpperCase()}] ${r.title}\n${r.content.slice(0, 1200)}`)
      .join("\n\n---\n\n");
  }

  searchEntries(query: string, topN = 8): MemorySearchHit[] {
    if (!query.trim() || this.chunks.length === 0) return [];

    const terms = tokenize(query);
    const scored: SearchResult[] = [];

    for (const chunk of this.chunks) {
      if (chunk.superseded) continue;
      const score = scoreChunk(chunk, terms);
      if (score > 0) scored.push({ chunk, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map(({ chunk, score }) => ({
        source: chunk.source,
        type: chunk.type,
        title: chunk.title,
        content: chunk.content,
        date: chunk.date,
        score,
      }));
  }

  /**
   * Returns the full IP Corp knowledge base context (for initial system prompt injection).
   * Limits total tokens by summarising long sections.
   */
  getFullKnowledgeContext(maxChars = 20_000): string {
    const priority = this.chunks
      .filter(c => !c.superseded && c.type === "knowledge" && isPriorityKnowledgeSource(c.source))
      .map(c => c.content)
      .join("\n\n");

    const entities = this.chunks
      .filter(c => !c.superseded && c.type === "entity")
      .map(c => `${c.title}: ${c.content}`)
      .join("\n");

    const recentMeetings = this.chunks
      .filter(c => !c.superseded && c.type === "summary")
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, 10)
      .map(c => `[${c.date?.slice(0, 10) ?? "unknown"}] ${c.title}: ${c.content}`)
      .join("\n");

    const resolvedFacts = this.chunks
      .filter(c => c.type === "contradiction")
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, 10)
      .map(c => `[${c.date?.slice(0, 10) ?? "unknown"}] ${c.title}: ${c.content}`)
      .join("\n");

    const parts: string[] = [];
    if (priority) parts.push(`## IP Corp Knowledge Base\n${priority}`);
    if (entities) parts.push(`## People & Systems\n${entities}`);
    if (recentMeetings) parts.push(`## Recent Meeting History\n${recentMeetings}`);
    if (resolvedFacts) parts.push(`## Current Ground Truth Updates\n${resolvedFacts}`);

    let combined = parts.join("\n\n");
    if (combined.length > maxChars) {
      combined = combined.slice(0, maxChars) + "\n\n[...truncated for context window]";
    }
    return combined;
  }

  // ─── Loaders ─────────────────────────────────────────────────────────────

  private async loadKnowledgeBase(): Promise<void> {
    const loadedFiles = new Set<string>();

    if (fs.existsSync(IPCORP_BRAIN_PATH)) {
      console.log("[MeetingMemoryBrain] Loading canonical IP Corp architecture brain:", IPCORP_BRAIN_PATH);

      for (const rel of IPCORP_PRIORITY_FILES) {
        this.addKnowledgeFile(path.join(IPCORP_BRAIN_PATH, rel), loadedFiles, { priority: true });
      }

      for (const relDir of IPCORP_SCAN_DIRS) {
        const dir = path.join(IPCORP_BRAIN_PATH, relDir);
        for (const full of collectTextFiles(dir)) {
          this.addKnowledgeFile(full, loadedFiles);
        }
      }

      console.log(`[MeetingMemoryBrain] IP Corp architecture brain loaded - ${this.chunks.length} chunks`);
      return;
    }

    console.warn(
      "[MeetingMemoryBrain] Canonical IP Corp architecture brain not found. Falling back to legacy knowledge base:",
      IPCORP_BRAIN_PATH
    );
    this.loadLegacyKnowledgeBase(loadedFiles);
    console.log(`[MeetingMemoryBrain] Legacy knowledge base loaded - ${this.chunks.length} chunks`);
  }

  private addKnowledgeFile(
    fullPath: string,
    loadedFiles: Set<string>,
    options: { priority?: boolean } = {}
  ): void {
    const resolved = path.resolve(fullPath);
    if (loadedFiles.has(resolved) || !fs.existsSync(resolved)) return;

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return;
      if (!TEXT_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return;
      if (stat.size > MAX_KNOWLEDGE_FILE_BYTES) {
        console.warn("[MeetingMemoryBrain] Skipping very large knowledge file:", resolved);
        return;
      }

      const content = fs.readFileSync(resolved, "utf-8");
      const relativeTitle = getKnowledgeTitle(resolved);
      const chunkSize = options.priority ? 2200 : 1600;
      const date = extractDateFromFilename(path.basename(resolved)) ?? inferDateFromPath(resolved, stat);
      const type = inferChunkType(resolved);

      chunkText(content, chunkSize).forEach((text, i) => {
        this.chunks.push({
          source: resolved,
          type,
          title: `${relativeTitle} (part ${i + 1})`,
          content: text,
          date,
          keywords: tokenize(`${relativeTitle} ${text}`),
        });
      });

      loadedFiles.add(resolved);
    } catch (e: any) {
      console.warn("[MeetingMemoryBrain] Failed to read knowledge file:", resolved, e?.message || e);
    }
  }

  private loadLegacyKnowledgeBase(loadedFiles: Set<string>): void {
    if (!fs.existsSync(LEGACY_KNOWLEDGE_BASE_PATH)) {
      console.warn("[MeetingMemoryBrain] Legacy knowledge base path not found:", LEGACY_KNOWLEDGE_BASE_PATH);
      return;
    }

    for (const rel of LEGACY_PRIORITY_FILES) {
      this.addKnowledgeFile(path.join(LEGACY_KNOWLEDGE_BASE_PATH, rel), loadedFiles, { priority: true });
    }

    const docsDir = path.join(LEGACY_KNOWLEDGE_BASE_PATH, "knowledge-docs");
    for (const full of collectTextFiles(docsDir)) {
      if (path.extname(full).toLowerCase() === ".md") {
        this.addKnowledgeFile(full, loadedFiles);
      }
    }

    for (const rel of ENTITY_FILES) {
      this.loadJsonItems(path.join(LEGACY_KNOWLEDGE_BASE_PATH, rel), "entity");
    }

    for (const rel of LEARNING_FILES) {
      this.loadJsonItems(path.join(LEGACY_KNOWLEDGE_BASE_PATH, rel), "knowledge");
    }

    for (const file of fs.readdirSync(LEGACY_KNOWLEDGE_BASE_PATH)) {
      if (!file.startsWith("Feed") || !file.endsWith(".md")) continue;
      this.addKnowledgeFile(path.join(LEGACY_KNOWLEDGE_BASE_PATH, file), loadedFiles);
    }
  }

  private loadJsonItems(fullPath: string, type: KnowledgeChunk["type"]): void {
    if (!fs.existsSync(fullPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      const items: any[] = Array.isArray(raw) ? raw : Object.values(raw);
      for (const item of items) {
        const text = typeof item === "string" ? item : JSON.stringify(item);
        const title = item.name ?? item.id ?? item.term ?? item.title ?? item.decision ?? path.basename(fullPath);
        this.chunks.push({
          source: fullPath,
          type,
          title,
          content: text,
          keywords: tokenize(`${title} ${text}`),
        });
      }
    } catch (e: any) {
      console.warn("[MeetingMemoryBrain] Failed to read JSON knowledge file:", fullPath, e?.message || e);
    }
  }

  private async loadPastMeetings(): Promise<void> {
    if (!this.db) return;

    try {
      const rows: any[] = this.db.prepare(`
        SELECT id, title, created_at, summary_json
        FROM meetings
        ORDER BY created_at DESC
        LIMIT 100
      `).all();

      for (const row of rows) {
        // Summary/key points — supports both legacy {summary, keyPoints, actionItems}
        // and current {detailedSummary: {overview, keyPoints, actionItems}} schemas
        let summaryText = "";
        let actionItems: string[] = [];
        try {
          const parsed = JSON.parse(row.summary_json ?? "{}");
          // Current schema: { detailedSummary: { overview, keyPoints, actionItems } }
          const detailed = parsed.detailedSummary ?? parsed;
          summaryText = detailed.overview ?? detailed.summary ?? "";
          actionItems = detailed.actionItems ?? parsed.actionItems ?? [];
          const keyPoints: string[] = detailed.keyPoints ?? parsed.keyPoints ?? [];
          if (keyPoints.length) summaryText += "\n" + keyPoints.join("\n");
        } catch {}

        if (summaryText) {
          this.chunks.push({
            source: `meeting:${row.id}`,
            type: "summary",
            title: row.title || "Untitled Meeting",
            content: summaryText + (actionItems.length ? `\nAction items:\n- ${actionItems.join("\n- ")}` : ""),
            date: row.created_at,
            keywords: tokenize(summaryText + " " + row.title),
          });
        }

        // Load transcript segments for full-text search
        try {
          const tRows: any[] = this.db.prepare(`
            SELECT content FROM transcripts WHERE meeting_id = ? ORDER BY timestamp_ms ASC LIMIT 200
          `).all(row.id);

          const fullTranscript = tRows.map(t => t.content).join(" ");
          if (fullTranscript.length > 100) {
            chunkText(fullTranscript, 1200).forEach((text, i) => {
              this.chunks.push({
                source: `meeting:${row.id}:transcript`,
                type: "transcript",
                title: `${row.title || "Meeting"} transcript (part ${i + 1})`,
                content: text,
                date: row.created_at,
                keywords: tokenize(text),
              });
            });
          }
        } catch {}
      }

      console.log(`[MeetingMemoryBrain] Loaded ${rows.length} past meetings`);
    } catch (e: any) {
      console.warn("[MeetingMemoryBrain] Failed to load meetings:", e.message);
    }
  }

  private async loadContradictions(): Promise<void> {
    if (!this.db) return;

    try {
      const rows: any[] = this.db.prepare(`
        SELECT meeting_id, meeting_title, detected_at, new_claim, prior_fact, prior_source, resolution, notes
        FROM contradictions
        WHERE resolution = 'newer_wins'
        ORDER BY detected_at DESC
        LIMIT 200
      `).all();

      for (const row of rows) {
        this.markSupersededChunks(row.prior_source, row.prior_fact, row.new_claim);

        const text = [
          `Current accepted fact: ${row.new_claim}`,
          `Superseded fact: ${row.prior_fact}`,
          `Superseded source: ${row.prior_source}`,
          row.notes ? `Why: ${row.notes}` : "",
        ].filter(Boolean).join("\n");

        this.chunks.push({
          source: `contradiction:${row.meeting_id}:${row.detected_at}`,
          type: "contradiction",
          title: `Resolved update from ${row.meeting_title || "meeting"}`,
          content: text,
          date: row.detected_at,
          keywords: tokenize(`${row.new_claim} ${row.prior_fact} ${row.meeting_title ?? ""}`),
        });
      }

      console.log(`[MeetingMemoryBrain] Loaded ${rows.length} contradiction updates`);
    } catch (e: any) {
      console.warn("[MeetingMemoryBrain] Failed to load contradictions:", e.message);
    }
  }

  private markSupersededChunks(priorSource: string, priorFact: string, replacementFact: string): void {
    const normalizedFact = normalizeForMatch(priorFact);
    if (!priorSource || !normalizedFact) return;

    for (const chunk of this.chunks) {
      if (!matchesSupersededSource(chunk.source, priorSource)) continue;
      if (!normalizeForMatch(chunk.content).includes(normalizedFact)) continue;
      chunk.superseded = true;
      chunk.supersededBy = replacementFact;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 || /^[a-z]*\d+[a-z]*$/.test(t));
}

function scoreChunk(chunk: KnowledgeChunk, queryTerms: string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    const titleHits = chunk.title.toLowerCase().includes(term) ? 3 : 0;
    const kwHits = chunk.keywords.filter(k => k.includes(term)).length;
    score += titleHits + Math.min(kwHits, 10);
  }

  if (isPriorityKnowledgeSource(chunk.source)) {
    score += 5;
  } else if (isWithin(chunk.source, IPCORP_BRAIN_PATH)) {
    score += 2;
  }

  // Boost recent content
  if (chunk.date) {
    const ageDays = (Date.now() - new Date(chunk.date).getTime()) / 86_400_000;
    score += Math.max(0, 5 - ageDays / 30);  // up to +5 for very recent
  }
  return score;
}

function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    // Try to break on a paragraph boundary
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n\n", end);
      if (newline > i + maxChars / 2) end = newline;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(c => c.length > 50);
}

function extractDateFromFilename(filename: string): string | undefined {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function collectTextFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TEXT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(full);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function getKnowledgeTitle(fullPath: string): string {
  if (isWithin(fullPath, IPCORP_BRAIN_PATH)) {
    return path.relative(IPCORP_BRAIN_PATH, fullPath);
  }
  if (isWithin(fullPath, LEGACY_KNOWLEDGE_BASE_PATH)) {
    return path.relative(LEGACY_KNOWLEDGE_BASE_PATH, fullPath);
  }
  return path.basename(fullPath);
}

function isPriorityKnowledgeSource(source: string): boolean {
  const normalizedSource = normalizePath(source);
  return IPCORP_PRIORITY_FILES.some((rel) => normalizedSource.endsWith(normalizePath(path.join(IPCORP_BRAIN_PATH, rel)))) ||
    LEGACY_PRIORITY_FILES.some((rel) => normalizedSource.endsWith(normalizePath(path.join(LEGACY_KNOWLEDGE_BASE_PATH, rel))));
}

function inferChunkType(fullPath: string): KnowledgeChunk["type"] {
  const normalized = normalizePath(fullPath);
  if (normalized.includes("/project-memory/entities/") || normalized.includes("/entities/")) return "entity";
  if (normalized.includes("/meetings/summaries/")) return "summary";
  if (path.basename(fullPath).toLowerCase().startsWith("feed")) return "transcript";
  return "knowledge";
}

function inferDateFromPath(fullPath: string, stat: fs.Stats): string | undefined {
  const pathDate = extractDateFromFilename(fullPath);
  if (pathDate) return pathDate;
  if (normalizePath(fullPath).includes("/meetings/")) return stat.mtime.toISOString();
  return undefined;
}

function isWithin(filePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function matchesSupersededSource(chunkSource: string, priorSource: string): boolean {
  if (chunkSource === priorSource) return true;
  if (priorSource.startsWith("meeting:")) {
    return chunkSource.startsWith(priorSource);
  }
  return false;
}
