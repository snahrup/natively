import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Bot, Clock3, Image as ImageIcon, MessageSquare, Monitor, RefreshCw, Sparkles, X } from "lucide-react";
import { useResolvedTheme } from "../hooks/useResolvedTheme";

type ChatDebugEntry = {
  id: number;
  meetingId?: string | null;
  type: string;
  timestamp: number;
  userQuery: string;
  aiResponse: string;
  metadata?: {
    surface?: string;
    status?: "completed" | "error" | "proposal" | "superseded" | string;
    provider?: string | null;
    modelId?: string | null;
    reasoningEffort?: string | null;
    imagePaths?: string[];
    hadImages?: boolean;
    screenReadRequest?: boolean;
    firstTokenLatencyMs?: number | null;
    totalLatencyMs?: number | null;
    error?: string | null;
    ocrObservationCount?: number;
    latestOcrAgeMs?: number | null;
    latestOcrExcerpt?: string | null;
    latestOcrDisplayCount?: number | null;
  };
};

type MeetingSummary = {
  id: string;
  title: string;
  date: string;
  source?: "manual" | "calendar" | "teams" | "cluely" | "imported";
};

type DisplayLayoutEntry = {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
};

const formatLatency = (ms?: number | null) => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
};

const formatAge = (ms?: number | null) => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "n/a";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
};

const formatTime = (timestamp?: number | null) =>
  typeof timestamp === "number" && Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "Unknown";

const formatTimestamp = (timestamp?: number | null) =>
  typeof timestamp === "number" && Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "No captured timestamp";

const surfaceLabelById: Record<string, string> = {
  widget: "Widget Chat",
  meeting_overlay: "Meeting Overlay",
  global_overlay: "Global Overlay",
  widget_live_rag: "Widget Live RAG",
  meeting_rag: "Meeting Recall RAG",
  global_rag: "Global Recall RAG",
};

const getDisplayAlias = (index: number, total: number) => {
  if (total <= 1) return "main display";
  if (total === 2) return index === 0 ? "left display" : "right display";
  if (total === 3) return ["left display", "middle display", "right display"][index] || `display ${index + 1}`;
  if (index === 0) return "leftmost display";
  if (index === total - 1) return "rightmost display";
  return `center display ${index}`;
};

const getStatusTone = (status?: string) => {
  switch (status || "completed") {
    case "completed":
      return { label: "Completed", pill: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20", accent: "bg-emerald-400" };
    case "proposal":
      return { label: "Proposal", pill: "bg-sky-500/15 text-sky-400 border-sky-500/20", accent: "bg-sky-400" };
    case "superseded":
      return { label: "Superseded", pill: "bg-amber-500/15 text-amber-400 border-amber-500/20", accent: "bg-amber-400" };
    default:
      return { label: "Issue", pill: "bg-red-500/15 text-red-400 border-red-500/20", accent: "bg-red-400" };
  }
};

const ChatLogViewerWindow: React.FC = () => {
  const isLightTheme = useResolvedTheme() === "light";
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<ChatDebugEntry[]>([]);
  const [previewByPath, setPreviewByPath] = useState<Record<string, string>>({});
  const [meetingsById, setMeetingsById] = useState<Record<string, MeetingSummary>>({});
  const [displayLayout, setDisplayLayout] = useState<DisplayLayoutEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);

  const refresh = async () => {
    try {
      setLoading(true);
      const [logs, meetings, displays] = await Promise.all([
        window.electronAPI?.getChatDebugEntries?.(120),
        window.electronAPI?.getRecentMeetings?.(),
        window.electronAPI?.getDisplayLayout?.(),
      ]);
      const normalizedEntries = Array.isArray(logs) ? [...logs].sort((a, b) => b.timestamp - a.timestamp) : [];
      setEntries(normalizedEntries);
      setSelectedEntryId((current) => (current && normalizedEntries.some((entry) => entry.id === current) ? current : normalizedEntries[0]?.id ?? null));
      const byId: Record<string, MeetingSummary> = {};
      (Array.isArray(meetings) ? meetings : []).forEach((meeting) => {
        byId[meeting.id] = { id: meeting.id, title: meeting.title, date: meeting.date, source: meeting.source };
      });
      setMeetingsById(byId);
      setDisplayLayout(Array.isArray(displays) ? displays : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch((error) => {
      console.error("[ChatLogViewerWindow] Failed to load logs:", error);
      setLoading(false);
    });
  }, []);

  const previewPaths = useMemo(() => Array.from(new Set(entries.flatMap((entry) => entry.metadata?.imagePaths || []).filter(Boolean))).slice(0, 24), [entries]);

  useEffect(() => {
    let cancelled = false;
    const loadPreviews = async () => {
      for (const imagePath of previewPaths) {
        if (cancelled || previewByPath[imagePath]) continue;
        try {
          const preview = await window.electronAPI?.getImagePreview?.(imagePath);
          if (!cancelled && preview) setPreviewByPath((current) => ({ ...current, [imagePath]: preview }));
        } catch (error) {
          console.warn("[ChatLogViewerWindow] Failed to load preview:", imagePath, error);
        }
      }
    };
    loadPreviews().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [previewByPath, previewPaths]);

  const selectedEntry = useMemo(() => entries.find((entry) => entry.id === selectedEntryId) ?? null, [entries, selectedEntryId]);
  const selectedMeeting = selectedEntry?.meetingId ? meetingsById[selectedEntry.meetingId] ?? null : null;
  const gallery = useMemo(() => {
    const imagePaths = selectedEntry?.metadata?.imagePaths || [];
    return imagePaths.map((imagePath, index) => ({
      imagePath,
      preview: previewByPath[imagePath],
      display: displayLayout[index] || null,
      alias: getDisplayAlias(index, Math.max(imagePaths.length, displayLayout.length || imagePaths.length)),
      index,
    }));
  }, [displayLayout, previewByPath, selectedEntry]);

  const heroClass = isLightTheme
    ? "bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(246,248,252,0.92))] border-black/8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]"
    : "bg-[linear-gradient(180deg,rgba(16,23,35,0.92),rgba(10,14,24,0.88))] border-white/10 shadow-[0_30px_90px_rgba(0,0,0,0.45)]";
  const panelClass = isLightTheme ? "bg-white/70 border-black/8" : "bg-white/5 border-white/10";
  const softPanelClass = isLightTheme ? "bg-black/[0.025] border-black/8" : "bg-black/10 border-white/8";
  const railInactive = isLightTheme ? "bg-black/[0.025] border-black/8 hover:bg-black/[0.04]" : "bg-black/10 border-white/8 hover:bg-white/6";
  const railActive = isLightTheme ? "bg-white border-black/10 shadow-[0_14px_40px_rgba(15,23,42,0.08)]" : "bg-white/10 border-white/14 shadow-[0_18px_48px_rgba(0,0,0,0.35)]";

  const latest = entries[0];
  const completedCount = entries.filter((entry) => (entry.metadata?.status || "completed") === "completed").length;
  const flaggedCount = entries.filter((entry) => (entry.metadata?.status || "completed") !== "completed").length;
  const surfaceCount = new Set(entries.map((entry) => entry.metadata?.surface).filter(Boolean)).size;

  return (
    <div className="h-full w-full overflow-hidden bg-bg-primary text-text-primary gs-page-enter">
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-[1480px] px-6 py-6">
          <section className={`relative overflow-hidden rounded-[28px] border ${heroClass} p-5 md:p-6`}>
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute -top-16 left-1/3 h-40 w-40 rounded-full bg-sky-500/15 blur-3xl" />
              <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-emerald-500/10 blur-3xl" />
              <div className="absolute bottom-0 left-0 h-36 w-36 rounded-full bg-violet-500/10 blur-3xl" />
            </div>
            <div className="relative z-10 space-y-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-2xl">
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-400">
                    <Sparkles size={12} />
                    Operator Trace
                  </div>
                  <h1 className="mt-3 text-2xl font-semibold tracking-tight text-text-primary md:text-3xl">Chat viewer logs tuned to the launcher experience</h1>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">Same job, quieter framing: a lightweight trace rail on the left and a focused dossier for the selected turn on the right.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3 self-start">
                  <div className={`rounded-2xl border px-4 py-3 ${isLightTheme ? "bg-white/75 border-black/8" : "bg-white/5 border-white/10"}`}>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Latest Signal</div>
                    <div className="mt-1 text-sm font-semibold text-text-primary">{latest ? formatAge(Math.max(0, Date.now() - latest.timestamp)) : "No turns yet"}</div>
                    <div className="text-[11px] text-text-secondary">{latest ? formatTimestamp(latest.timestamp) : "Waiting for captured turns"}</div>
                  </div>
                  <button onClick={() => refresh()} className={`inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition-all ${isLightTheme ? "bg-white/75 border-black/8 text-text-primary hover:bg-white" : "bg-white/5 border-white/10 text-text-primary hover:bg-white/10"}`}>
                    <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                    Refresh
                  </button>
                  <button onClick={() => window.electronAPI?.closeChatLogViewer?.()} className={`inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition-all ${isLightTheme ? "bg-white/75 border-black/8 text-text-primary hover:bg-white" : "bg-white/5 border-white/10 text-text-primary hover:bg-white/10"}`}>
                    <X size={14} />
                    Close
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {[
                  { label: "Turns", value: String(entries.length), meta: "Captured exchanges" },
                  { label: "Completed", value: String(completedCount), meta: "Responses landed cleanly" },
                  { label: "Flagged", value: String(flaggedCount), meta: "Errors, proposals, superseded" },
                  { label: "Surfaces", value: String(surfaceCount), meta: `${entries.filter((entry) => entry.metadata?.screenReadRequest).length} screen-read requests` },
                ].map((metric, index) => (
                  <motion.div key={metric.label} className={`rounded-[22px] border px-4 py-4 ${panelClass} gs-hero-enter`} style={{ "--i": Math.min(index, 15) } as React.CSSProperties}>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">{metric.label}</div>
                    <div className="mt-4 text-3xl font-semibold tracking-tight text-text-primary">{metric.value}</div>
                    <div className="mt-2 text-[11px] leading-relaxed text-text-secondary">{metric.meta}</div>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            <div className={`min-h-[720px] rounded-[24px] border ${panelClass} flex flex-col`}>
              <div className="border-b border-border-subtle px-5 pb-4 pt-5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Trace Rail</div>
                <div className="mt-1 text-lg font-semibold text-text-primary">Latest operator turns</div>
                <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">Select a turn to inspect prompt, answer, OCR evidence, and captured displays.</div>
              </div>
              <div className="flex-1 overflow-auto p-3 space-y-3">
                {entries.map((entry, index) => {
                  const tone = getStatusTone(entry.metadata?.status);
                  const surface = entry.metadata?.surface ? surfaceLabelById[entry.metadata.surface] || entry.metadata.surface : "Unknown surface";
                  const active = entry.id === selectedEntry?.id;
                  return (
                    <motion.button key={entry.id} onClick={() => setSelectedEntryId(entry.id)} className={`group relative w-full overflow-hidden rounded-[20px] border px-4 py-4 text-left transition-all gs-stagger-row ${active ? railActive : railInactive}`} style={{ "--i": Math.min(index, 15) } as React.CSSProperties}>
                      <div className={`absolute bottom-4 left-0 top-4 w-[3px] rounded-full ${tone.accent}`} />
                      <div className="relative pl-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${tone.pill}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${tone.accent}`} />
                            {tone.label}
                          </span>
                          <span className="shrink-0 text-[10px] text-text-tertiary">{formatTime(entry.timestamp)}</span>
                        </div>
                        <div className="mt-3 text-sm font-medium leading-relaxed text-text-primary line-clamp-3">{entry.userQuery || "No prompt captured."}</div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                          <span>{surface}</span>
                          <span>•</span>
                          <span>{entry.metadata?.provider || "unknown provider"}</span>
                          <span>•</span>
                          <span className="truncate max-w-[160px]">{entry.metadata?.modelId || "unknown model"}</span>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-text-tertiary">
                          <span>First {formatLatency(entry.metadata?.firstTokenLatencyMs)}</span>
                          <span>Total {formatLatency(entry.metadata?.totalLatencyMs)}</span>
                        </div>
                      </div>
                    </motion.button>
                  );
                })}
                {loading && entries.length === 0 && <div className="grid min-h-[220px] place-items-center text-sm text-text-secondary">Refreshing trace capture…</div>}
                {!loading && entries.length === 0 && <div className={`grid min-h-[220px] place-items-center rounded-[20px] border ${softPanelClass} px-6 text-center text-sm text-text-secondary`}>Ask something inside Natively and the viewer will start collecting turns.</div>}
              </div>
            </div>

            {selectedEntry ? (
              <div className={`min-h-[720px] rounded-[24px] border ${panelClass} overflow-hidden`}>
                <AnimatePresence mode="wait">
                  <motion.div key={selectedEntry.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22, ease: "easeOut" }} className="flex h-full min-h-[720px] flex-col">
                    <div className="border-b border-border-subtle px-5 py-5">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0">
                          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-400">
                            <MessageSquare size={12} />
                            Turn #{selectedEntry.id}
                          </div>
                          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-text-primary">{selectedEntry.metadata?.surface ? surfaceLabelById[selectedEntry.metadata.surface] || selectedEntry.metadata.surface : "Unknown surface"}</h2>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${getStatusTone(selectedEntry.metadata?.status).pill}`}>{getStatusTone(selectedEntry.metadata?.status).label}</span>
                            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] ${softPanelClass}`}>{selectedEntry.metadata?.provider || "unknown provider"}</span>
                            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] ${softPanelClass}`}>{selectedEntry.metadata?.modelId || "unknown model"}</span>
                          </div>
                        </div>
                        <div className={`min-w-[240px] rounded-[20px] border px-4 py-3 ${softPanelClass}`}>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Captured</div>
                          <div className="mt-1 text-sm font-semibold text-text-primary">{formatTimestamp(selectedEntry.timestamp)}</div>
                          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-text-secondary">
                            <span>First token {formatLatency(selectedEntry.metadata?.firstTokenLatencyMs)}</span>
                            <span>Total {formatLatency(selectedEntry.metadata?.totalLatencyMs)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 overflow-auto p-5 space-y-4">
                      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                        {[
                          { label: "Provider", value: selectedEntry.metadata?.provider || "unknown" },
                          { label: "Reasoning", value: selectedEntry.metadata?.reasoningEffort || "n/a" },
                          { label: "OCR Obs", value: String(selectedEntry.metadata?.ocrObservationCount || 0) },
                          { label: "Images", value: String(selectedEntry.metadata?.imagePaths?.length || 0) },
                        ].map((card) => (
                          <div key={card.label} className={`rounded-[20px] border px-4 py-3 ${softPanelClass}`}>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">{card.label}</div>
                            <div className="mt-2 text-sm font-semibold text-text-primary break-words">{card.value}</div>
                          </div>
                        ))}
                      </div>
                      {selectedMeeting && <div className={`rounded-[24px] border px-4 py-4 ${panelClass}`}><div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Meeting Context</div><div className="mt-2 text-base font-semibold text-text-primary">{selectedMeeting.title}</div><div className="mt-1 text-[12px] text-text-secondary">{new Date(selectedMeeting.date).toLocaleString()} • {selectedMeeting.source || "manual"}</div></div>}
                      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[0.9fr_1.1fr]">
                        <div className={`rounded-[24px] border px-4 py-4 ${panelClass}`}><div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Prompt</div><div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{selectedEntry.userQuery || "No prompt captured."}</div></div>
                        <div className={`rounded-[24px] border px-4 py-4 ${panelClass}`}><div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Response</div><div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-text-primary">{selectedEntry.aiResponse || selectedEntry.metadata?.error || "No response body captured."}</div></div>
                      </div>
                      {gallery.length > 0 && <div className={`rounded-[24px] border px-4 py-4 ${panelClass}`}><div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between"><div><div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-tertiary"><ImageIcon size={12} />Screen Gallery</div><div className="mt-2 text-sm text-text-secondary">Ordered by physical display position from left to right.</div></div><div className="text-[11px] text-text-secondary">{displayLayout.length > 0 ? displayLayout.map((display) => display.label).join(" • ") : `${gallery.length} capture${gallery.length === 1 ? "" : "s"}`}</div></div><div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">{gallery.map((item) => <div key={item.imagePath} className={`overflow-hidden rounded-[20px] border ${softPanelClass}`}><div className="border-b border-border-subtle px-4 py-3"><div className="text-[10px] uppercase tracking-[0.16em] text-text-tertiary">{item.alias}</div><div className="mt-1 text-xs text-text-secondary truncate">{item.display ? `Display ${item.display.label}` : `Capture ${item.index + 1}`}</div></div><div className="aspect-[16/10] bg-black/15">{item.preview ? <img src={item.preview} alt={item.display ? `${item.alias} on display ${item.display.label}` : item.alias} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center px-4 text-center text-xs text-text-secondary">Preview unavailable for this capture.</div>}</div></div>)}</div></div>}
                      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                        <div className={`rounded-[24px] border px-4 py-4 ${panelClass}`}><div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-tertiary"><Monitor size={12} />OCR Snapshot</div><div className="mt-4 space-y-2 text-[12px] text-text-secondary"><div>Observations: {selectedEntry.metadata?.ocrObservationCount || 0}</div><div>Displays: {selectedEntry.metadata?.latestOcrDisplayCount || 0}</div><div>Age: {formatAge(selectedEntry.metadata?.latestOcrAgeMs)}</div></div>{selectedEntry.metadata?.latestOcrExcerpt && <div className={`mt-4 rounded-[18px] border px-4 py-3 text-xs leading-6 ${softPanelClass}`}>{selectedEntry.metadata.latestOcrExcerpt}</div>}</div>
                        <div className={`rounded-[24px] border px-4 py-4 ${panelClass}`}><div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-text-tertiary"><Clock3 size={12} />Inference Flags</div><div className="mt-4 space-y-2 text-[12px] text-text-secondary"><div>Had images: {selectedEntry.metadata?.hadImages ? "yes" : "no"}</div><div>Screen read request: {selectedEntry.metadata?.screenReadRequest ? "yes" : "no"}</div><div>Reasoning effort: {selectedEntry.metadata?.reasoningEffort || "n/a"}</div></div>{selectedEntry.metadata?.error && <div className="mt-4 rounded-[18px] border border-red-500/25 bg-red-500/10 px-4 py-3 text-xs leading-6 text-red-200"><div className="mb-2 inline-flex items-center gap-2 font-medium"><AlertTriangle size={13} />Error</div><div>{selectedEntry.metadata.error}</div></div>}</div>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>
            ) : (
              <div className={`grid min-h-[720px] place-items-center rounded-[24px] border ${panelClass}`}>
                <div className="px-6 text-center">
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-400"><Bot size={12} />No selection</div>
                  <div className="mt-3 text-lg font-semibold text-text-primary">Select a log entry to inspect</div>
                  <div className="mt-1 text-sm leading-relaxed text-text-secondary">The rail on the left keeps the latest turns accessible without burying the details.</div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default ChatLogViewerWindow;
