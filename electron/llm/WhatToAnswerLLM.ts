import { LLMHelper } from "../LLMHelper";
import { UNIVERSAL_WHAT_TO_ANSWER_PROMPT } from "./prompts";
import { TemporalContext } from "./TemporalContextBuilder";
import { IntentResult } from "./IntentClassifier";

export class WhatToAnswerLLM {
    private llmHelper: LLMHelper;

    constructor(llmHelper: LLMHelper) {
        this.llmHelper = llmHelper;
    }

    // Deprecated non-streaming method (redirect to streaming or implement if needed)
    async generate(cleanedTranscript: string): Promise<string> {
        // Simple wrapper around stream
        const stream = this.generateStream(cleanedTranscript);
        let full = "";
        for await (const chunk of stream) full += chunk;
        return full;
    }

    async *generateStream(
        cleanedTranscript: string,
        temporalContext?: TemporalContext,
        intentResult?: IntentResult,
        imagePaths?: string[],
        preparedMeetingContext?: string | null,
        proactiveMode?: boolean
    ): AsyncGenerator<string> {
        try {
            // Build a rich message context
            // Note: We can't easily inject the complex temporal/intent logic into universal prompt *variables* 
            // but we can prepend it to the message.

            let contextParts: string[] = [];

            if (intentResult) {
                contextParts.push(`<intent_and_shape>
DETECTED INTENT: ${intentResult.intent}
ANSWER SHAPE: ${intentResult.answerShape}
</intent_and_shape>`);
            }

            if (temporalContext && temporalContext.hasRecentResponses) {
                // ... simplify temporal context injection for universal prompt ...
                // Just dump it in context if possible
                const history = temporalContext.previousResponses.map((r, i) => `${i + 1}. "${r}"`).join('\n');
                contextParts.push(`PREVIOUS RESPONSES (Avoid Repetition):\n${history}`);
            }

            if (preparedMeetingContext?.trim()) {
                contextParts.push(`<prepared_meeting_context>\n${preparedMeetingContext.trim()}\n</prepared_meeting_context>`);
            }

            if (proactiveMode) {
                contextParts.push(`<proactive_live_coaching>
Live reflex mode. Write only what Steve can say out loud immediately.
Keep it to 1-3 compact sentences. No sections unless the transcript explicitly asks for a list.
Use concrete details from the live transcript, prepared meeting context, or visible screen context.
Do not use generic meeting advice, canned decision language, or reusable filler.
If the recent audio is only setup chatter, mic checks, wake-word tests, acknowledgements, or there is no answerable meeting signal, output exactly: NO_USEFUL_COACHING_SIGNAL
Do not narrate reasoning. Do not wait for perfect context, but stay grounded in what is actually present.
</proactive_live_coaching>`);
            }

            const extraContext = contextParts.join('\n\n');
            const fullMessage = extraContext
                ? `${extraContext}\n\nCONVERSATION:\n${cleanedTranscript}`
                : cleanedTranscript;

            // Use Universal Prompt
            // Note: WhatToAnswer has a very specific prompt. 
            // We should use UNIVERSAL_WHAT_TO_ANSWER_PROMPT as override

            yield* this.llmHelper.streamChat(
                fullMessage,
                imagePaths,
                undefined,
                UNIVERSAL_WHAT_TO_ANSWER_PROMPT,
                proactiveMode
                    ? {
                        ignoreKnowledgeMode: true,
                        skipRetrievedContext: true,
                        skipIPCorpSystemPrompt: true,
                        requestProfile: "realtime"
                    }
                    : false
            );

        } catch (error) {
            console.error("[WhatToAnswerLLM] Stream failed:", error);
            throw error;
        }
    }
}
