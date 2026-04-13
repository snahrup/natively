/**
 * IPCorpContextBuilder
 *
 * Pulls IP Corp context from Natively's local meeting memory and optional
 * Nexus session context at session start and
 * injects it into the system prompt, turning Natively into a personalised
 * meeting assistant that already knows:
 *   - Who the people in the meeting are
 *   - What projects are active
 *   - Relevant technical decisions and patterns
 *   - Recent durable working memory
 *
 * HTTP endpoints used:
 *   Nexus    → http://localhost:3777/api/memory/context
 */

import http from "http";
import { MeetingMemoryBrain } from "./MeetingMemoryBrain";

const NEXUS_BASE = "http://localhost:3777";

interface SourceFetchResult<T> {
  available: boolean;
  payload: T;
  error?: string;
}

export interface IPCorpContextHealth {
  brainReady: boolean;
  clawmemAvailable: boolean;
  nexusAvailable: boolean;
  usingCache: boolean;
  lastUpdatedAt: string | null;
  warning: string | null;
}

const CONTEXT_CACHE_TTL_MS = 45_000;

let cachedContext:
  | { key: string; value: string; expiresAt: number; builtAt: string; health: IPCorpContextHealth }
  | null = null;
let inflightContextKey: string | null = null;
let inflightContextPromise: Promise<string> | null = null;
let lastHealth: IPCorpContextHealth = {
  brainReady: false,
  clawmemAvailable: false,
  nexusAvailable: false,
  usingCache: false,
  lastUpdatedAt: null,
  warning: "IP Corp context has not been built yet.",
};

async function httpGet(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        resolve(body);
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function fetchNexusContext(): Promise<SourceFetchResult<string>> {
  try {
    const raw = await httpGet(`${NEXUS_BASE}/api/memory/context`);
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") {
      return { available: true, payload: parsed };
    }
    if (parsed.context) {
      return { available: true, payload: parsed.context };
    }
    // Format key-value pairs
    const entries: any[] = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    return {
      available: true,
      payload: entries
      .map((e: any) => `[${e.category ?? "memory"}] ${e.key ?? ""}: ${e.value ?? e.content ?? ""}`)
      .join("\n"),
    };
  } catch {
    return { available: false, payload: "", error: "Nexus unavailable" };
  }
}

/** Lazy-initialize the MeetingMemoryBrain once the DB is ready. */
async function ensureBrainReady(): Promise<boolean> {
  const brain = MeetingMemoryBrain.getInstance();
  if ((brain as any).initialized) return true;
  try {
    const { DatabaseManager } = require("../db/DatabaseManager");
    const dbManager = DatabaseManager.getInstance();
    await brain.initialize(dbManager);
    return true;
  } catch (e: any) {
    console.warn("[IPCorpContextBuilder] Brain init failed:", e.message);
    return false;
  }
}

function getCacheKey(meetingTopic?: string): string {
  return meetingTopic?.trim().toLowerCase() || "__default__";
}

function buildHealthWarning(health: Pick<IPCorpContextHealth, "brainReady" | "nexusAvailable">): string | null {
  if (!health.brainReady) {
    return "Local context engine unavailable. Using minimal meeting context only.";
  }
  if (!health.nexusAvailable) {
    return "Session bus unavailable. Using local meeting memory only.";
  }
  return null;
}

export function getIPCorpContextHealth(): IPCorpContextHealth {
  return { ...lastHealth };
}

export async function warmIPCorpContextCache(meetingTopic?: string): Promise<IPCorpContextHealth> {
  await buildIPCorpContext(meetingTopic, { forceRefresh: true });
  return getIPCorpContextHealth();
}

/**
 * Build the IP Corp system prompt injection block.
 * Queries Natively's local MeetingMemoryBrain and optional Nexus session context.
 *
 * @param meetingTopic Optional hint to focus memory search (e.g. "Jira", "PhantomX")
 */
export async function buildIPCorpContext(
  meetingTopic?: string,
  options?: { forceRefresh?: boolean }
): Promise<string> {
  const key = getCacheKey(meetingTopic);
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();

  if (!forceRefresh && cachedContext && cachedContext.key === key && cachedContext.expiresAt > now) {
    lastHealth = { ...cachedContext.health, usingCache: true };
    return cachedContext.value;
  }

  if (inflightContextPromise && inflightContextKey === key) {
    return inflightContextPromise;
  }

  inflightContextKey = key;
  inflightContextPromise = (async () => {
    const [nexusResult, brainReady] = await Promise.all([
      fetchNexusContext(),
      ensureBrainReady(),
    ]);

    const brain = MeetingMemoryBrain.getInstance();
    const knowledgeQuery = [meetingTopic, "IP Corp meeting", "decision"].filter(Boolean).join(" ");
    const brainContext = brain.search(knowledgeQuery, 6);
    const fullKnowledge = brain.getFullKnowledgeContext(12_000);

    const sections: string[] = [];

    // Full knowledge base (company structure, systems, contacts, past meetings)
    if (fullKnowledge) {
      sections.push(fullKnowledge);
    } else if (brainContext) {
      sections.push(`## Relevant Knowledge\n${brainContext}`);
    }

    // Optional session context from Nexus / Conductor.
    if (nexusResult.payload.trim()) {
      sections.push(`## Active Session Signals\n${nexusResult.payload.trim()}`);
    }

    const builtAt = new Date().toISOString();
    const health: IPCorpContextHealth = {
      brainReady,
      clawmemAvailable: false,
      nexusAvailable: nexusResult.available,
      usingCache: false,
      lastUpdatedAt: builtAt,
      warning: buildHealthWarning({
        brainReady,
        nexusAvailable: nexusResult.available,
      }),
    };

    const value = sections.length === 0 ? "" : sections.join("\n\n");
    cachedContext = {
      key,
      value,
      expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
      builtAt,
      health,
    };
    lastHealth = health;

    return value;
  })();

  try {
    return await inflightContextPromise;
  } finally {
    inflightContextKey = null;
    inflightContextPromise = null;
  }
}

/**
 * Build the full system prompt for the personalized IP Corp meeting mode.
 * Replaces the default assistant framing with a personalised
 * meeting co-pilot that knows the user's active projects and context.
 */
export async function buildIPCorpSystemPrompt(meetingTopic?: string): Promise<string> {
  const contextBlock = await buildIPCorpContext(meetingTopic);

  const basePrompt = `
<identity>
You are Natively in Personalized Meeting mode.
You are the user's proactive meeting and workflow companion.
You know the user's active projects, prior decisions, and relevant context from memory.
Your job is to keep the user sharp in live discussions by surfacing what to say, what to ask, what to correct, and what to watch out for.
</identity>

<behavior>
- PROACTIVE: Don't wait to be asked. If you detect a question directed at the user, a technical topic they clearly know, or a negotiation moment, respond immediately with the strongest useful guidance.
- CONCISE: Responses must be speakable in 10-20 seconds max. Bullet key points. Lead with the most important thing.
- FIRST PERSON: When giving words to say in a meeting, write as if the user is saying them. No "you should say..." framing.
- REAL-TIME: Prioritize what's relevant RIGHT NOW in the conversation. Don't recap history unless asked.
- USER VOICE: Conversational, direct, confident without arrogance, uses contractions, gets to the point fast, zero corporate filler.
- TECHNICAL AUTHORITY: When the topic is technical, sound like a strong engineer in the room. Crisp, calm, and precise.
</behavior>

<proactive_triggers>
Fire a response when you detect:
1. A question ending in "?" directed at or near the user
2. A technical topic the retrieved context says the user knows well
3. A silence > 3 seconds after someone finishes speaking (suggest a follow-up question)
4. A negotiation, scope, or timeline push — suggest the user's strongest counter-position
5. An acronym, product name, or concept appearing for the first time — define it briefly
6. A factual miss, contradiction, or weak framing — correct it immediately
</proactive_triggers>

<response_format>
When the user is in a live meeting, prefer this glanceable structure:
**[SAY THIS]:** <the exact first-person words to say now>
**[CORRECTION]:** <only if something needs correcting>
**[DATA]:** <the single most useful supporting detail>
**[HEADS UP]:** <risk, drift, or missing context>

When the user is speaking directly to you outside a meeting:
- Talk directly to the user in second person.
- Be concise, practical, and direct.

For live technical discussions, use this structure:
1. **[SAY THIS FIRST]:** 1-2 natural sentences they can say immediately
2. **[THE CODE]:** full working code if implementation is needed
3. **[SAY THIS AFTER]:** 1-2 natural sentences for explanation or tradeoffs
4. **[AMMUNITION]:**
   - **Time Complexity:** O(...)
   - **Space Complexity:** O(...)
   - **Key Decision:** one sharp bullet
</response_format>
`.trim();

  if (!contextBlock) {
    return basePrompt;
  }

  return `${basePrompt}

<user_context>
${contextBlock}
</user_context>`;
}
