import { buildPromptContextBlock, ContextRetrievalBroker } from "../context";
import { LLMHelper } from "../LLMHelper";
import type { TeamsChat } from "./MicrosoftLocalTypes";

type PlannedActionKind = "none" | "email" | "teams_message" | "calendar_event";

interface ActionPlan {
  action: PlannedActionKind;
  sendIntent?: boolean;
  summary?: string;
  email?: {
    recipientQueries?: string[];
    ccQueries?: string[];
    subject?: string;
    body?: string;
    importance?: "low" | "normal" | "high";
  };
  teams?: {
    chatQuery?: string;
    message?: string;
  };
  calendar?: {
    subject?: string;
    start?: string;
    end?: string;
    location?: string;
    body?: string;
    requiredQueries?: string[];
    optionalQueries?: string[];
  };
}

export type AgentActionProposal =
  | {
      kind: "email";
      ready: boolean;
      note: string;
      sendIntent: boolean;
      missing?: string[];
      draft: {
        toRecipients: string[];
        ccRecipients: string[];
        subject: string;
        body: string;
        importance: "low" | "normal" | "high";
      };
      resolvedRecipients: Array<{ name: string; email: string }>;
      unresolvedRecipients?: string[];
      unresolvedCc?: string[];
    }
  | {
      kind: "teams_message";
      ready: boolean;
      note: string;
      sendIntent: boolean;
      missing?: string[];
      target?: {
        chatId: string;
        label: string;
      };
      unresolvedTarget?: string;
      message: string;
    }
  | {
      kind: "calendar_event";
      ready: boolean;
      note: string;
      sendIntent: boolean;
      missing?: string[];
      event: {
        subject: string;
        start: string;
        end: string;
        location: string;
        body: string;
        required: string[];
        optional: string[];
      };
      unresolvedRequired?: string[];
      unresolvedOptional?: string[];
    };

const ACTION_HINT_RE =
  /\b(send|draft|email|mail|outlook|reply|teams|message|calendar|invite|meeting|schedule)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export class AgentActionPlanner {
  private static instance: AgentActionPlanner;

  public static getInstance(): AgentActionPlanner {
    if (!AgentActionPlanner.instance) {
      AgentActionPlanner.instance = new AgentActionPlanner();
    }
    return AgentActionPlanner.instance;
  }

  public async maybeBuildProposal(userText: string, llmHelper: LLMHelper): Promise<AgentActionProposal | null> {
    if (!ACTION_HINT_RE.test(userText)) {
      return null;
    }

    const retrieval = await ContextRetrievalBroker.getInstance().retrieve({
      query: userText,
      surface: "reactive",
      limit: 5,
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
      includeLiveMicrosoftSources: false,
      includeSemantica: false,
    });
    const contextBlock = buildPromptContextBlock(retrieval);
    const rawPlan = await llmHelper.generateContentStructured(
      this.buildPlannerPrompt(userText, contextBlock)
    );
    const parsed = this.parsePlannerResponse(rawPlan);
    if (!parsed || parsed.action === "none") {
      return null;
    }

    switch (parsed.action) {
      case "email":
        return this.buildEmailProposal(parsed);
      case "teams_message":
        return this.buildTeamsProposal(parsed);
      case "calendar_event":
        return this.buildCalendarProposal(parsed);
      default:
        return null;
    }
  }

  private buildPlannerPrompt(userText: string, contextBlock: string): string {
    return [
      "You convert a user request into a structured Microsoft desktop action proposal.",
      "Supported actions: email, teams_message, calendar_event, none.",
      "Return JSON only. No markdown. No commentary.",
      "Rules:",
      "- Use action=none if the user is asking for advice, analysis, or a normal answer instead of asking you to perform an action.",
      "- For email, extract recipientQueries, ccQueries, subject, body, and importance.",
      "- For teams_message, extract chatQuery and message.",
      "- For calendar_event, extract subject, start, end, location, body, requiredQueries, optionalQueries.",
      "- Dates must be local time in YYYY-MM-DDTHH:mm format.",
      "- sendIntent should be true only if the user explicitly asked to send now, send immediately, reply now, or create and send invites.",
      "- Write drafts in first person as if they are from the user. Keep them direct, concise, and human.",
      "- Do not invent recipients or meeting attendees. Keep unresolved names as raw queries.",
      `Current local time: ${new Date().toISOString()}`,
      contextBlock ? contextBlock : "## Ranked Context\nConfidence: low\nSituation: No ranked context available.\nEvidence:\n- none",
      `User request: ${userText}`,
      "Return exactly one JSON object with this shape:",
      JSON.stringify({
        action: "none",
        sendIntent: false,
        summary: "",
        email: {
          recipientQueries: [],
          ccQueries: [],
          subject: "",
          body: "",
          importance: "normal",
        },
        teams: {
          chatQuery: "",
          message: "",
        },
        calendar: {
          subject: "",
          start: "",
          end: "",
          location: "",
          body: "",
          requiredQueries: [],
          optionalQueries: [],
        },
      }),
    ].join("\n\n");
  }

  private parsePlannerResponse(raw: string): ActionPlan | null {
    try {
      return JSON.parse(raw) as ActionPlan;
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]) as ActionPlan;
      } catch {
        return null;
      }
    }
  }

  private async buildEmailProposal(plan: ActionPlan): Promise<AgentActionProposal> {
    const email = plan.email || {};
    const recipientQueries = uniqueStrings(email.recipientQueries || []);
    const ccQueries = uniqueStrings(email.ccQueries || []);
    const [toResolution, ccResolution] = await Promise.all([
      this.resolveEmailQueries(recipientQueries),
      this.resolveEmailQueries(ccQueries),
    ]);

    const unresolved = recipientQueries.filter((query) => !toResolution.resolvedByQuery.has(query));
    const unresolvedCc = ccQueries.filter((query) => !ccResolution.resolvedByQuery.has(query));
    const ready = toResolution.resolved.length > 0 && unresolved.length === 0;
    const missing = ready ? [] : ["One or more email recipients need an explicit address or a brain-side resolved payload."];

    return {
      kind: "email",
      ready,
      note: plan.summary || (ready
        ? "Review the draft inline, then open it in Outlook or send it directly."
        : "I prepared the draft, but at least one recipient still needs an explicit address. Natively no longer reads Outlook contacts to resolve this at widget time."),
      sendIntent: plan.sendIntent === true,
      missing,
      draft: {
        toRecipients: toResolution.resolved.map((item) => item.email),
        ccRecipients: ccResolution.resolved.map((item) => item.email),
        subject: (email.subject || "").trim(),
        body: (email.body || "").trim(),
        importance: email.importance || "normal",
      },
      resolvedRecipients: toResolution.resolved,
      unresolvedRecipients: unresolved.length ? unresolved : undefined,
      unresolvedCc: unresolvedCc.length ? unresolvedCc : undefined,
    };
  }

  private async buildTeamsProposal(plan: ActionPlan): Promise<AgentActionProposal> {
    const teams = plan.teams || {};
    const target = await this.resolveTeamsChat(teams.chatQuery || "");
    const ready = !!target?.id && !!teams.message?.trim();
    const missing = ready ? [] : [
      !target?.id ? "The Teams chat target needs clarification." : "",
      !teams.message?.trim() ? "The Teams message is empty." : "",
    ].filter(Boolean);

    return {
      kind: "teams_message",
      ready,
      note: plan.summary || (ready
        ? "Review the Teams reply inline, then send it when ready."
        : "I prepared the message, but I still need a brain-provided Teams target or direct chat id. Natively no longer reads Teams chats to resolve this at widget time."),
      sendIntent: plan.sendIntent === true,
      missing,
      target: target ? { chatId: target.id, label: target.topic } : undefined,
      unresolvedTarget: target ? undefined : (teams.chatQuery || undefined),
      message: (teams.message || "").trim(),
    };
  }

  private async buildCalendarProposal(plan: ActionPlan): Promise<AgentActionProposal> {
    const calendar = plan.calendar || {};
    const requiredQueries = uniqueStrings(calendar.requiredQueries || []);
    const optionalQueries = uniqueStrings(calendar.optionalQueries || []);
    const [requiredResolution, optionalResolution] = await Promise.all([
      this.resolveEmailQueries(requiredQueries),
      this.resolveEmailQueries(optionalQueries),
    ]);

    const unresolvedRequired = requiredQueries.filter((query) => !requiredResolution.resolvedByQuery.has(query));
    const unresolvedOptional = optionalQueries.filter((query) => !optionalResolution.resolvedByQuery.has(query));
    const start = normalizeLocalDateTime(calendar.start);
    const end = normalizeLocalDateTime(calendar.end);
    const ready =
      !!calendar.subject?.trim() &&
      !!start &&
      !!end &&
      end > start &&
      unresolvedRequired.length === 0 &&
      unresolvedOptional.length === 0;

    const missing = [
      !calendar.subject?.trim() ? "The meeting title is missing." : "",
      !start ? "The start time is missing or invalid." : "",
      !end ? "The end time is missing or invalid." : "",
      start && end && end <= start ? "The end time must be after the start time." : "",
      unresolvedRequired.length ? "One or more required attendees still need to be resolved." : "",
      unresolvedOptional.length ? "One or more optional attendees still need to be resolved." : "",
    ].filter(Boolean);

    return {
      kind: "calendar_event",
      ready,
      note: plan.summary || (ready
        ? "Review the calendar event inline, then save it or send the invites."
        : "I prepared the meeting invite, but at least one field still needs clarification."),
      sendIntent: plan.sendIntent === true,
      missing,
      event: {
        subject: (calendar.subject || "").trim(),
        start: start || "",
        end: end || "",
        location: (calendar.location || "").trim(),
        body: (calendar.body || "").trim(),
        required: requiredResolution.resolved.map((item) => item.email),
        optional: optionalResolution.resolved.map((item) => item.email),
      },
      unresolvedRequired: unresolvedRequired.length ? unresolvedRequired : undefined,
      unresolvedOptional: unresolvedOptional.length ? unresolvedOptional : undefined,
    };
  }

  private async resolveEmailQueries(queries: string[]): Promise<{
    resolved: Array<{ name: string; email: string }>;
    resolvedByQuery: Set<string>;
  }> {
    const resolved: Array<{ name: string; email: string }> = [];
    const resolvedByQuery = new Set<string>();

    for (const query of queries) {
      const direct = extractEmail(query);
      if (direct) {
        resolved.push({ name: query, email: direct });
        resolvedByQuery.add(query);
      }
    }

    return {
      resolved: dedupeRecipients(resolved),
      resolvedByQuery,
    };
  }

  private async resolveTeamsChat(query: string): Promise<TeamsChat | null> {
    if (!query.trim()) return null;
    const chatIdMatch = query.match(/\bchat(?:id)?[:=]\s*([A-Za-z0-9:_@.-]+)/i);
    if (!chatIdMatch?.[1]) return null;
    return {
      id: chatIdMatch[1],
      topic: query,
      lastMessage: "",
      lastMessageTime: new Date().toISOString(),
      participants: [],
      unreadCount: 0,
      chatType: "group",
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractEmail(input: string): string | null {
  const match = input.match(EMAIL_RE);
  return match ? match[0].toLowerCase() : null;
}

function dedupeRecipients(values: Array<{ name: string; email: string }>): Array<{ name: string; email: string }> {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLocalDateTime(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed) ? trimmed : null;
}
