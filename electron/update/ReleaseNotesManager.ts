import { net } from "electron";

export interface ReleaseNoteSection {
    title: string;
    items: string[];
}

export interface ParsedReleaseNotes {
    version: string;
    summary: string;
    sections: ReleaseNoteSection[];
    fullBody: string;
    url: string;
}

export class ReleaseNotesManager {
    private static instance: ReleaseNotesManager;
    private cachedNotes: ParsedReleaseNotes | null = null;
    private readonly releaseNotesBaseUrl = (process.env.NATIVELY_RELEASE_NOTES_BASE_URL || "https://natively.software/releases").replace(/\/+$/, "");

    private constructor() { }

    public static getInstance(): ReleaseNotesManager {
        if (!ReleaseNotesManager.instance) {
            ReleaseNotesManager.instance = new ReleaseNotesManager();
        }
        return ReleaseNotesManager.instance;
    }

    public async fetchReleaseNotes(version: string, forceRefresh = false): Promise<ParsedReleaseNotes | null> {
        if (!forceRefresh && this.cachedNotes && this.cachedNotes.version === version) {
            console.log("[ReleaseNotesManager] Returning cached release notes for", version);
            return this.cachedNotes;
        }

        console.log(`[ReleaseNotesManager] Fetching release notes for ${version}...`);

        try {
            const normalizedVersion = version === "latest" ? "latest" : version.replace(/^v/, "");
            const url = normalizedVersion === "latest"
                ? `${this.releaseNotesBaseUrl}/latest.json`
                : `${this.releaseNotesBaseUrl}/v${normalizedVersion}.json`;

            const response = await this.makeRequest(url);
            if (!response) {
                console.warn("[ReleaseNotesManager] Failed to fetch release notes from configured source.");
                return null;
            }

            const data = JSON.parse(response);

            if (typeof data.version === "string" && Array.isArray(data.sections)) {
                const parsed: ParsedReleaseNotes = {
                    version: data.version,
                    summary: data.summary || "",
                    sections: data.sections,
                    fullBody: data.fullBody || data.body || "",
                    url: data.url || url,
                };
                this.cachedNotes = parsed;
                return parsed;
            }

            const body = data.body || data.notes || "";
            const resolvedVersion = data.tag_name || data.version || version;
            const resolvedUrl = data.html_url || data.url || url;

            const parsed = this.parseReleaseNotes(body, resolvedVersion, resolvedUrl);
            this.cachedNotes = parsed;
            return parsed;
        } catch (error) {
            console.error("[ReleaseNotesManager] Error fetching release notes:", error);
            return null;
        }
    }

    private parseReleaseNotes(body: string, version: string, url: string): ParsedReleaseNotes {
        const allowedHeaders = ["Summary", "What's New", "Improvements", "Fixes", "Technical"];
        const bulletSections = ["What's New", "Improvements", "Fixes", "Technical"];

        const sections: ReleaseNoteSection[] = [];
        let summary = "";
        const normalizedBody = body.replace(/\r\n/g, "\n");
        const rawSections = normalizedBody.split(/^## /m);

        for (const raw of rawSections) {
            const sectionText = raw.trim();
            if (!sectionText) continue;

            const lines = sectionText.split("\n");
            const title = lines[0].trim();
            if (!allowedHeaders.includes(title)) continue;

            const contentLines = lines.slice(1);
            const content = contentLines.join("\n").trim();

            if (title === "Summary") {
                summary = content.replace(/\n/g, " ").trim();
                continue;
            }

            if (bulletSections.includes(title)) {
                const items = contentLines
                    .map((line) => line.trim())
                    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
                    .map((line) => line.substring(2).trim());

                if (items.length > 0) {
                    sections.push({ title, items });
                }
            }
        }

        return {
            version,
            summary,
            sections,
            fullBody: body,
            url,
        };
    }

    private makeRequest(url: string): Promise<string | null> {
        return new Promise((resolve) => {
            const request = net.request(url);

            request.on("response", (response) => {
                if (response.statusCode !== 200) {
                    console.warn(`[ReleaseNotesManager] HTTP ${response.statusCode} for ${url}`);
                    resolve(null);
                    return;
                }

                let data = "";
                response.on("data", (chunk) => {
                    data += chunk.toString();
                });

                response.on("end", () => {
                    resolve(data);
                });

                response.on("error", (err) => {
                    console.error("[ReleaseNotesManager] Stream error:", err);
                    resolve(null);
                });
            });

            request.on("error", (err) => {
                console.error("[ReleaseNotesManager] Request error:", err);
                resolve(null);
            });

            request.end();
        });
    }

    public getCachedNotes(): ParsedReleaseNotes | null {
        return this.cachedNotes;
    }
}
