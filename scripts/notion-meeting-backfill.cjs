const path = require('path');
const fs = require('fs');
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

function requireElectronModule(relativePath) {
  const fullPath = path.join(process.cwd(), 'dist-electron', 'electron', relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Compiled Electron module not found: ${fullPath}. Run npm run build:electron first.`);
  }
  return require(fullPath);
}

function parseJsonBlock(source, tagName) {
  const match = source.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    console.warn(`[notion-backfill] Failed to parse <${tagName}> JSON block`, error.message);
    return null;
  }
}

function extractTagContent(source, tagName) {
  const match = source.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`));
  return match ? match[1].trim() : '';
}

function stripInlineArtifacts(text) {
  return text
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/<mention-user[^>]*><\/mention-user>/g, '')
    .replace(/<mention-page[^>]*>(.*?)<\/mention-page>/g, '$1')
    .replace(/<mention-date[^>]*\/>/g, '')
    .replace(/<empty-block\/>/g, '')
    .replace(/<ancestor-path>[\s\S]*?<\/ancestor-path>/g, '')
    .replace(/<properties>[\s\S]*?<\/properties>/g, '')
    .replace(/<page[^>]*>/g, '')
    .replace(/<\/page>/g, '')
    .replace(/<content>/g, '')
    .replace(/<\/content>/g, '')
    .replace(/<meeting-notes>/g, '')
    .replace(/<\/meeting-notes>/g, '')
    .replace(/<summary>/g, '')
    .replace(/<\/summary>/g, '')
    .replace(/<notes>/g, '')
    .replace(/<\/notes>/g, '')
    .replace(/<transcript>/g, '')
    .replace(/<\/transcript>/g, '')
    .replace(/<callout[^>]*>/g, '')
    .replace(/<\/callout>/g, '')
    .replace(/<details>/g, '')
    .replace(/<\/details>/g, '')
    .replace(/<summary>/g, '')
    .replace(/<\/summary>/g, '')
    .replace(/<summary>.*?<\/summary>/g, '')
    .replace(/<table[^>]*>/g, '')
    .replace(/<\/table>/g, '')
    .replace(/<tr[^>]*>/g, '')
    .replace(/<\/tr>/g, '')
    .replace(/<td[^>]*>/g, '')
    .replace(/<\/td>/g, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanupMarkdown(text) {
  return stripInlineArtifacts(text)
    .replace(/^Here is the result of "view".*?\n/, '')
    .replace(/\n---\n/g, '\n\n')
    .replace(/[ \t]+\|[ \t]+/g, ' | ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(html) {
  return cleanupMarkdown(
    decodeHtmlEntities(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h1|h2|h3|h4|tr)>/gi, '\n')
      .replace(/<\/td>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '))
  );
}

function extractSection(source, startLabel, endLabels = []) {
  const start = source.indexOf(startLabel);
  if (start === -1) return '';
  const bodyStart = start + startLabel.length;
  let end = source.length;
  for (const label of endLabels) {
    const candidate = source.indexOf(label, bodyStart);
    if (candidate !== -1 && candidate < end) end = candidate;
  }
  return source.slice(bodyStart, end).trim();
}

function extractRepeatedMatches(source, regex) {
  const matches = [];
  let match;
  while ((match = regex.exec(source)) !== null) {
    matches.push(match);
  }
  return matches;
}

function parseTimestampToMs(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/^~/, '');
  const parts = trimmed.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return null;
  let seconds = 0;
  if (parts.length === 3) {
    seconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  } else if (parts.length === 2) {
    seconds = (parts[0] * 60) + parts[1];
  } else if (parts.length === 1) {
    seconds = parts[0];
  } else {
    return null;
  }
  return seconds * 1000;
}

function expandInlineSpeakerTransitions(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/(\S)\s+([A-Z][A-Za-z0-9.'&/-]*(?:\s+[A-Z][A-Za-z0-9.'&/-]*){0,4})\s*(\[\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\]|\(\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\))\s*:/g, '$1\n$2 $3:')
    .replace(/(\S)\s+(\*\*[^*]+\*\*\s*\*\(\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\)\*)/g, '$1\n$2');
}

function parseSpeakerTranscript(transcriptText) {
  const lines = expandInlineSpeakerTransitions(transcriptText).split(/\r?\n/);
  const segments = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const markdownSpeakerMatch = line.match(/^\*\*(.+?)\*\*\s*\*\(([^)]+)\)\*$/);
    const inlineSpeakerMatch = line.match(/^(.+?)\s+\[\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\]:\s*(.*)$/);

    if (markdownSpeakerMatch || inlineSpeakerMatch) {
      if (current && current.text.trim()) {
        segments.push({
          speaker: current.speaker,
          text: current.text.trim(),
          timestamp: current.timestamp ?? (segments.length * 60000),
          explicitTimestamp: current.explicitTimestamp === true,
        });
      }
      const parsedTimestamp = parseTimestampToMs(markdownSpeakerMatch?.[2] || inlineSpeakerMatch?.[2]);
      current = {
        speaker: (markdownSpeakerMatch?.[1] || inlineSpeakerMatch?.[1] || 'Transcript').trim(),
        timestamp: parsedTimestamp,
        explicitTimestamp: Number.isFinite(parsedTimestamp),
        text: (inlineSpeakerMatch?.[3] || '').trim(),
      };
      continue;
    }

    if (!current) {
      current = {
        speaker: 'Transcript',
        timestamp: segments.length * 60000,
        explicitTimestamp: false,
        text: '',
      };
    }

    current.text += `${current.text ? ' ' : ''}${stripInlineArtifacts(line)}`;
  }

  if (current && current.text.trim()) {
    segments.push({
      speaker: current.speaker,
      text: current.text.trim(),
      timestamp: current.timestamp ?? (segments.length * 60000),
      explicitTimestamp: current.explicitTimestamp === true,
    });
  }

  return segments.filter((segment) => segment.text);
}

function isGenericTranscriptSpeaker(value) {
  return ['transcript', 'speaker', 'participant', 'unknown', 'meeting'].includes(String(value || '').trim().toLowerCase());
}

function isStructuredTranscript(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  if (segments.length >= 2) return true;
  return segments.some((segment) => !isGenericTranscriptSpeaker(segment.speaker) || segment.explicitTimestamp === true);
}

function parseParagraphTranscript(transcriptText) {
  const paragraphs = transcriptText
    .split(/\r?\n/)
    .map((line) => stripInlineArtifacts(line).trim())
    .filter(Boolean);

  return paragraphs.map((text, index) => ({
    speaker: 'Transcript',
    text,
    timestamp: index * 60000,
    explicitTimestamp: false,
  }));
}

function parseTranscript(content) {
  const explicitTranscript = extractTagContent(content, 'transcript');
  if (explicitTranscript) {
    const speakered = parseSpeakerTranscript(explicitTranscript);
    if (isStructuredTranscript(speakered)) return speakered;
    return parseParagraphTranscript(explicitTranscript);
  }

  const rawSection = extractSection(content, '## 📝 RAW TRANSCRIPT', ['## ', '---']);
  if (rawSection) {
    const cleaned = rawSection
      .replace(/^<details>\s*/m, '')
      .replace(/<\/details>\s*$/m, '')
      .replace(/^<summary>.*<\/summary>\s*/m, '');
    const speakered = parseSpeakerTranscript(cleaned);
    if (isStructuredTranscript(speakered)) return speakered;
    return parseParagraphTranscript(cleaned);
  }

  return [];
}

function collectChecklistLines(source) {
  return source
    .split(/\r?\n/)
    .map((line) => stripInlineArtifacts(line).trim())
    .filter((line) => /^- \[.\]/.test(line))
    .map((line) => line.replace(/^- \[[ xX]\]\s*/, '').trim())
    .filter(Boolean);
}

function collectBulletLines(source) {
  return source
    .split(/\r?\n/)
    .map((line) => stripInlineArtifacts(line).trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, '').trim())
    .filter(Boolean);
}

function dedupeStrings(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = item.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item.replace(/\s+/g, ' ').trim());
  }
  return result;
}

function buildOverview(content) {
  const structuredSummary = extractTagContent(content, 'summary');
  if (structuredSummary) {
    return cleanupMarkdown(structuredSummary);
  }

  const withoutTranscript = content
    .replace(/## 📝 RAW TRANSCRIPT[\s\S]*/m, '')
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .trim();

  return cleanupMarkdown(withoutTranscript);
}

function buildDetailedSummary(content, agenda) {
  const actionItems = dedupeStrings([
    ...collectChecklistLines(extractTagContent(content, 'summary')),
    ...collectChecklistLines(content),
    ...collectBulletLines(extractSection(content, '## 📋 NEXT STEPS', ['## ', '---'])),
  ]);

  const keyPoints = dedupeStrings([
    ...collectBulletLines(extractTagContent(content, 'summary')),
    ...collectBulletLines(extractSection(content, '## 🔝 TOP FACTS', ['## ', '---'])),
    ...collectBulletLines(extractSection(content, '## ✅ DECISIONS', ['## ', '---'])),
    ...collectBulletLines(extractSection(content, '## 🚨 RISKS', ['## ', '---'])),
  ]).slice(0, 18);

  const overview = buildOverview(content) || agenda || 'Imported from Notion meeting record.';

  return {
    overview,
    actionItems,
    keyPoints,
  };
}

function titleWords(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && word.length > 2);
}

function sameUtcDay(a, b) {
  try {
    const one = new Date(a);
    const two = new Date(b);
    return one.getUTCFullYear() === two.getUTCFullYear() &&
      one.getUTCMonth() === two.getUTCMonth() &&
      one.getUTCDate() === two.getUTCDate();
  } catch {
    return false;
  }
}

  function scoreExistingMeeting(existing, incomingTitle, incomingDate) {
    let score = 0;
    if (sameUtcDay(existing.date, incomingDate)) score += 50;
  const incomingWords = titleWords(incomingTitle);
  const existingWords = new Set(titleWords(existing.title));
  const overlap = incomingWords.filter((word) => existingWords.has(word)).length;
  score += overlap * 10;
    if (overlap >= Math.min(3, incomingWords.length)) score += 15;
    return score;
  }

  function findBestExistingMatch(existingMeetings, incoming) {
    const incomingSourceMeetingId = incoming.importMetadata?.sourceMeetingId || '';
    const incomingId = incoming.id;

    const exactIndex = existingMeetings.findIndex((meeting) => (
      meeting.id === incomingId
      || (incomingSourceMeetingId && meeting.importMetadata?.sourceMeetingId === incomingSourceMeetingId)
    ));

    if (exactIndex !== -1) {
      return {
        meeting: existingMeetings[exactIndex],
        index: exactIndex,
        score: 100,
      };
    }

    return existingMeetings
      .map((meeting, index) => ({ meeting, index, score: scoreExistingMeeting(meeting, incoming.title, incoming.date) }))
      .filter(({ meeting }) => {
        const existingSourceMeetingId = meeting.importMetadata?.sourceMeetingId || '';
        if (!incomingSourceMeetingId || !existingSourceMeetingId) {
          return true;
        }
        return existingSourceMeetingId === incomingSourceMeetingId;
      })
      .sort((left, right) => right.score - left.score)[0] || null;
  }

function mergeMeetings(existing, incoming) {
  const chooseLonger = (left, right) => {
    if (!left) return right;
    if (!right) return left;
    return right.length >= left.length ? right : left;
  };

  const mergedTranscript = (incoming.transcript?.length || 0) >= (existing.transcript?.length || 0)
    ? incoming.transcript
    : existing.transcript;
  const mergedDate = incoming.date || existing.date;
  const mergedEstimate = estimateDuration(mergedTranscript || [], mergedDate);

  const mergedUsage = dedupeUsage([...(existing.usage || []), ...(incoming.usage || [])]);

  return {
    id: existing.id,
    title: chooseLonger(existing.title, incoming.title),
    date: mergedDate,
    duration: mergedEstimate.duration,
    durationMs: mergedEstimate.durationMs,
    startTimeMs: mergedEstimate.startTimeMs,
    summary: chooseLonger(existing.summary, incoming.summary),
    detailedSummary: {
      overview: chooseLonger(existing.detailedSummary?.overview, incoming.detailedSummary?.overview),
      actionItems: dedupeStrings([
        ...(incoming.detailedSummary?.actionItems || []),
        ...(existing.detailedSummary?.actionItems || []),
      ]),
      keyPoints: dedupeStrings([
        ...(incoming.detailedSummary?.keyPoints || []),
        ...(existing.detailedSummary?.keyPoints || []),
      ]),
    },
    transcript: mergedTranscript,
    usage: mergedUsage,
    calendarEventId: existing.calendarEventId || incoming.calendarEventId,
    source: existing.source || incoming.source,
    importMetadata: {
      ...(existing.importMetadata || {}),
      ...(incoming.importMetadata || {}),
      relatedArtifacts: dedupeStrings([
        ...((existing.importMetadata && existing.importMetadata.relatedArtifacts) || []),
        ...((incoming.importMetadata && incoming.importMetadata.relatedArtifacts) || []),
      ]),
    },
    isProcessed: true,
    };
  }

  function replaceMeetingFromSource(existing, incoming) {
    const mergedTranscript = (incoming.transcript?.length || 0) >= (existing.transcript?.length || 0)
      ? incoming.transcript
      : existing.transcript;
    const mergedDate = incoming.date || existing.date;
    const mergedEstimate = estimateDuration(mergedTranscript || [], mergedDate);
    const incomingImportMetadata = incoming.importMetadata || {};

    return {
      ...existing,
      ...incoming,
      id: existing.id,
      date: mergedDate,
      duration: mergedEstimate.duration,
      durationMs: mergedEstimate.durationMs,
      startTimeMs: mergedEstimate.startTimeMs,
      calendarEventId: incoming.calendarEventId,
      transcript: mergedTranscript,
      usage: dedupeUsage([...(existing.usage || []), ...(incoming.usage || [])]),
      importMetadata: {
        ...incomingImportMetadata,
        // Exact source re-imports should reset artifacts to the authoritative
        // Notion-derived set so stale cross-meeting links do not persist.
        relatedArtifacts: dedupeStrings(
          (incomingImportMetadata.relatedArtifacts || []).filter(Boolean)
        ),
        enrichmentSources: dedupeStrings((incomingImportMetadata.enrichmentSources || []).filter(Boolean)),
      },
      isProcessed: true,
    };
  }

function dedupeUsage(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = JSON.stringify([entry.type, entry.timestamp, entry.question || '', entry.answer || '', entry.items || []]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function parseUsage(content) {
  const usageSection = extractSection(content, '## 💡 CLUELY USAGE LOG', ['## ', '---']);
  if (!usageSection) return [];
  const cleaned = cleanupMarkdown(usageSection);
  if (!cleaned) return [];
  return [{
    type: 'assist',
    timestamp: Date.now(),
    answer: cleaned,
  }];
}

function estimateDuration(transcript, explicitDate) {
  if (!transcript.length) {
    return {
      durationMs: DEFAULT_DURATION_MS,
      duration: '60:00',
      startTimeMs: new Date(explicitDate).getTime(),
    };
  }
  const timestamps = transcript
    .filter((segment) => segment.explicitTimestamp === true)
    .map((segment) => segment.timestamp)
    .filter((value) => Number.isFinite(value));
  if (timestamps.length < 2) {
    return {
      durationMs: DEFAULT_DURATION_MS,
      duration: '60:00',
      startTimeMs: new Date(explicitDate).getTime(),
    };
  }
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);
  const durationMs = Math.max(60000, (maxTimestamp - minTimestamp) + 60000);
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return {
    durationMs,
    duration: `${minutes}:${String(seconds).padStart(2, '0')}`,
    startTimeMs: new Date(explicitDate).getTime(),
  };
}

function normalizeBooleanFlag(value) {
  if (value === true || value === '__YES__' || value === 'true') return true;
  return false;
}

function parseLooseDate(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(/\s+\(UTC\)\s*$/i, 'Z');
  const direct = new Date(normalized);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const rangeMatch = normalized.match(/^(.*?)\s+→\s+(.*?)$/);
  if (rangeMatch) {
    const start = new Date(rangeMatch[1].trim().replace(/\s+\(UTC\)\s*$/i, 'Z'));
    if (!Number.isNaN(start.getTime())) return start.toISOString();
  }

  return null;
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => String(value || '').trim())) {
        rows.push(row);
      }
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length || row.length) {
    row.push(cell);
    if (row.some((value) => String(value || '').trim())) {
      rows.push(row);
    }
  }

  if (!rows.length) return [];
  const headers = rows.shift().map((value) => String(value || '').trim());
  return rows.map((values) => {
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = String(values[idx] || '').trim();
    });
    return record;
  });
}

function normalizeTitleForMatch(value) {
  return String(value || '')
    .replace(/\s+[0-9a-f]{32}$/i, '')
    .replace(/\s+—\s+\d{4}-\d{2}-\d{2}$/i, '')
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeTranscriptInput(rawTranscript) {
  if (!rawTranscript) return [];
  if (Array.isArray(rawTranscript)) {
    return rawTranscript
      .map((segment, index) => ({
        speaker: String(segment.speaker || 'Transcript').trim() || 'Transcript',
        text: stripInlineArtifacts(String(segment.text || '')).trim(),
        timestamp: Number.isFinite(segment.timestamp) ? segment.timestamp : index * 60000,
        explicitTimestamp: Number.isFinite(segment.timestamp),
      }))
      .filter((segment) => segment.text);
  }

  const transcriptText = String(rawTranscript).trim();
  if (!transcriptText) return [];
  const speakered = parseSpeakerTranscript(transcriptText);
  if (isStructuredTranscript(speakered)) return speakered;
  return parseParagraphTranscript(transcriptText);
}

function parseParsedMeeting(pageObject) {
  const title = pageObject.title || 'Imported Notion Meeting';
  const date = pageObject.date
    ? new Date(pageObject.date).toISOString()
    : new Date().toISOString();
  const transcript = normalizeTranscriptInput(pageObject.transcript || pageObject.transcriptMarkdown);
  const estimate = estimateDuration(transcript, date);
  const overview = cleanupMarkdown(pageObject.overview || pageObject.summary || pageObject.agenda || title);
  const actionItems = dedupeStrings((pageObject.actionItems || []).map((item) => cleanupMarkdown(String(item))));
  const keyPoints = dedupeStrings((pageObject.keyPoints || []).map((item) => cleanupMarkdown(String(item))));
  const notionPageId = pageObject.notionPageId || '';
  const notionUrl = pageObject.notionUrl || '';
  const flags = pageObject.flags || {};
  const usageText = cleanupMarkdown(pageObject.usageText || '');

  return {
    id: `notion-${notionPageId || Buffer.from(title).toString('hex').slice(0, 12)}`,
    title,
    date,
    duration: estimate.duration,
    durationMs: estimate.durationMs,
    startTimeMs: estimate.startTimeMs,
    summary: overview.split(/\n+/).slice(0, 3).join(' ').slice(0, 600) || title,
    detailedSummary: {
      overview,
      actionItems,
      keyPoints,
    },
    transcript,
    usage: usageText
      ? [{
          type: 'assist',
          timestamp: estimate.startTimeMs,
          answer: usageText,
        }]
      : [],
    source: pageObject.source || 'imported',
    importMetadata: {
      sourceFormat: pageObject.sourceFormat || 'generic',
      importedAt: new Date().toISOString(),
      fidelity: pageObject.fidelity || 'exact',
      relatedArtifacts: dedupeStrings([
        notionUrl,
        notionPageId ? `notion:${notionPageId}` : '',
        ...(pageObject.relatedArtifacts || []),
        normalizeBooleanFlag(flags.hasFinalTranscript) ? 'notion-final-transcript' : '',
        normalizeBooleanFlag(flags.hasCluelyTranscript) ? 'notion-cluely-merged' : '',
        normalizeBooleanFlag(flags.hasTeamsTranscript) ? 'notion-teams-merged' : '',
        normalizeBooleanFlag(flags.mergedToFeed) ? 'notion-feed-merged' : '',
      ].filter(Boolean)),
      sourceMeetingId: notionPageId || undefined,
    },
    isProcessed: true,
  };
}

function parseMeetingPage(pageObject) {
  if (pageObject && pageObject.parsedMeeting) {
    return parseParsedMeeting(pageObject);
  }

  const viewText = pageObject.text || '';
  const properties = parseJsonBlock(viewText, 'properties') || {};
  const content = extractTagContent(viewText, 'content');
  const title = properties['Meeting Name'] || pageObject.title || 'Imported Notion Meeting';
  const date = properties['date:Date:start']
    ? (properties['date:Date:is_datetime'] ? new Date(properties['date:Date:start']).toISOString() : new Date(`${properties['date:Date:start']}T12:00:00.000Z`).toISOString())
    : new Date().toISOString();
  const agenda = properties['Agenda'] || '';
  const transcript = parseTranscript(content);
  const detailedSummary = buildDetailedSummary(content, agenda);
  const usage = parseUsage(content);
  const notionUrl = properties.url || pageObject.url || '';
  const notionPageId = notionUrl.split('/').pop()?.replace(/-/g, '') || pageObject.url?.split('/').pop() || '';
  const estimate = estimateDuration(transcript, date);

  return {
    id: `notion-${notionPageId || Buffer.from(title).toString('hex').slice(0, 12)}`,
    title,
    date,
    duration: estimate.duration,
    durationMs: estimate.durationMs,
    startTimeMs: estimate.startTimeMs,
    summary: detailedSummary.overview.split(/\n+/).slice(0, 3).join(' ').slice(0, 600) || agenda || title,
    detailedSummary,
    transcript,
    usage,
    source: 'imported',
    importMetadata: {
      sourceFormat: 'generic',
      importedAt: new Date().toISOString(),
      fidelity: 'exact',
      relatedArtifacts: dedupeStrings([
        notionUrl,
        `notion:${notionPageId}`,
        properties['Has Final Transcript'] === '__YES__' ? 'notion-final-transcript' : '',
        properties['Has Cluely Transcript'] === '__YES__' ? 'notion-cluely-merged' : '',
        properties['Has Teams Transcript'] === '__YES__' ? 'notion-teams-merged' : '',
        properties['Merged to Feed'] === '__YES__' ? 'notion-feed-merged' : '',
      ].filter(Boolean)),
      sourceMeetingId: notionPageId || undefined,
    },
    isProcessed: true,
  };
}

function loadExportDirectory(inputDir) {
  const htmlFiles = fs.readdirSync(inputDir)
    .filter((entry) => entry.toLowerCase().endsWith('.html'))
    .map((entry) => path.join(inputDir, entry));

  const csvDir = path.dirname(inputDir);
  const csvRows = fs.readdirSync(csvDir)
    .filter((entry) => entry.toLowerCase().endsWith('.csv'))
    .flatMap((entry) => parseCsv(fs.readFileSync(path.join(csvDir, entry), 'utf8')));

  const csvByTitle = new Map();
  for (const row of csvRows) {
    const key = normalizeTitleForMatch(row['Meeting Name']);
    if (key && !csvByTitle.has(key)) csvByTitle.set(key, row);
  }

  return htmlFiles
    .map((filePath) => parseExportedHtmlMeeting(filePath, csvByTitle))
    .filter(Boolean);
}

function parseExportedHtmlMeeting(filePath, csvByTitle) {
  const html = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath);
  const notionPageId = fileName.match(/([0-9a-f]{32})\.html$/i)?.[1] || '';
  const titleTag = decodeHtmlEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
  const pageTitle = stripHtml(html.match(/<h1[^>]*class="page-title"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const headerTitle = (titleTag || pageTitle || fileName.replace(/\.html$/i, '')).trim();
  const csvRow = csvByTitle.get(normalizeTitleForMatch(headerTitle)) || null;

  const propertyMatches = extractRepeatedMatches(
    html,
    /<tr class="property-row[\s\S]*?<th[\s\S]*?>([\s\S]*?)<\/th><td[\s\S]*?>([\s\S]*?)<\/td><\/tr>/gi
  );
  const properties = {};
  for (const match of propertyMatches) {
    const key = stripHtml(match[1]);
    const rawValue = match[2] || '';
    const value = /checkbox-on/.test(rawValue)
      ? '__YES__'
      : /checkbox-off/.test(rawValue)
        ? '__NO__'
        : stripHtml(rawValue);
    if (key) properties[key] = value;
  }

  const bodyHtml = html.match(/<div class="page-body">([\s\S]*?)<\/article>/i)?.[1] || '';
  const sectionMatches = extractRepeatedMatches(
    bodyHtml,
    /<div style="border-bottom:0\.05em solid[\s\S]*?>([^<]+)<br\/?><\/div>([\s\S]*?)(?=<div style="border-bottom:0\.05em solid|$)/gi
  );
  const sections = {};
  for (const match of sectionMatches) {
    const label = stripHtml(match[1]).toLowerCase();
    sections[label] = match[2] || '';
  }

  const summaryHtml = sections.summary || '';
  const transcriptHtml = sections.transcript || '';
  const notesHtml = sections.notes || '';

  const actionItems = [];
  const keyPoints = [];
  let currentHeading = '';
  const blockRegex = /(<h3[^>]*>[\s\S]*?<\/h3>|<li[^>]*>[\s\S]*?<\/li>|<p[^>]*>[\s\S]*?<\/p>)/gi;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(summaryHtml)) !== null) {
    const block = blockMatch[1];
    if (/^<h3/i.test(block)) {
      currentHeading = stripHtml(block).toLowerCase();
      continue;
    }

    const text = stripHtml(block);
    if (!text) continue;

    if (currentHeading.includes('action item')) {
      if (!/^none identified$/i.test(text)) actionItems.push(text);
    } else {
      keyPoints.push(text);
    }
  }

  const transcriptText = stripHtml(transcriptHtml);
  const notesText = stripHtml(notesHtml);
  const overview = cleanupMarkdown(stripHtml(summaryHtml)) || csvRow?.Agenda || headerTitle;
  const transcript = normalizeTranscriptInput(transcriptText);
  const date = (
    parseLooseDate(csvRow?.Date)
    || parseLooseDate(properties.Date)
    || parseLooseDate(pageTitle)
    || parseLooseDate(headerTitle)
    || new Date().toISOString()
  );

  return {
    parsedMeeting: true,
    title: csvRow?.['Meeting Name'] || properties['Meeting Name'] || headerTitle,
    date,
    transcript,
    summary: overview,
    overview,
    agenda: csvRow?.Agenda || '',
    actionItems: dedupeStrings(actionItems),
    keyPoints: dedupeStrings(keyPoints),
    usageText: notesText,
    notionPageId,
    notionUrl: notionPageId ? `notion:${notionPageId}` : '',
    source: 'imported',
    sourceFormat: 'generic',
    fidelity: 'exact',
    flags: {
      hasFinalTranscript: normalizeBooleanFlag(properties['Has Final Transcript']) || normalizeBooleanFlag(csvRow?.['Has Final Transcript']),
      hasCluelyTranscript: normalizeBooleanFlag(properties['Has Cluely Transcript']) || normalizeBooleanFlag(csvRow?.['Has Cluely Transcript']),
      hasTeamsTranscript: normalizeBooleanFlag(properties['Has Teams Transcript']) || normalizeBooleanFlag(csvRow?.['Has Teams Transcript']),
      mergedToFeed: normalizeBooleanFlag(properties['Merged to Feed']) || normalizeBooleanFlag(csvRow?.['Merged to Feed']),
    },
    relatedArtifacts: [
      filePath,
      csvRow?.Date ? `notion-export-date:${csvRow.Date}` : '',
      csvRow?.Organizer ? `notion-export-organizer:${csvRow.Organizer}` : '',
      ...(splitNames(csvRow?.Attendees || '').map((name) => `attendee:${name}`)),
    ].filter(Boolean),
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: npx electron scripts/notion-meeting-backfill.cjs <input-json-or-cjs-or-export-dir>');
  }

  const { app } = require('electron');
  await app.whenReady();

  const { DatabaseManager } = requireElectronModule(path.join('db', 'DatabaseManager.js'));
  const { RAGManager } = requireElectronModule(path.join('rag', 'RAGManager.js'));
  const { MeetingRepairService } = requireElectronModule(path.join('services', 'MeetingRepairService.js'));
  const { MicrosoftLocalManager } = requireElectronModule(path.join('services', 'MicrosoftLocalManager.js'));

  const absoluteInputPath = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(process.cwd(), inputPath);

  let rawInput;
  if (fs.existsSync(absoluteInputPath) && fs.statSync(absoluteInputPath).isDirectory()) {
    rawInput = loadExportDirectory(absoluteInputPath);
  } else if (absoluteInputPath.endsWith('.cjs') || absoluteInputPath.endsWith('.js')) {
    rawInput = require(absoluteInputPath);
  } else {
    rawInput = JSON.parse(fs.readFileSync(absoluteInputPath, 'utf8'));
  }
  const pageObjects = Array.isArray(rawInput) ? rawInput : rawInput.pages;
  if (!Array.isArray(pageObjects) || pageObjects.length === 0) {
    throw new Error('Input JSON must be a non-empty array of fetched Notion page objects.');
  }

  const dbManager = DatabaseManager.getInstance();
  if (!dbManager.isReady()) {
    throw new Error(dbManager.getInitError() || 'DatabaseManager failed to initialize.');
  }

  const ragManager = new RAGManager({
    db: dbManager.getDb(),
    dbPath: dbManager.getDbPath(),
    extPath: dbManager.getExtPath(),
    ollamaUrl: 'http://localhost:11434',
  });

  await ragManager.getEmbeddingPipeline().waitForReady(30000).catch(() => {});

  const existingMeetings = dbManager.getRecentMeetings(500);
  const imported = [];

  for (const pageObject of pageObjects) {
      const incoming = parseMeetingPage(pageObject);
      const bestMatch = findBestExistingMatch(existingMeetings, incoming);
      const isExactMatch = !!(bestMatch && bestMatch.score === 100);
      const shouldMerge = !!(bestMatch && bestMatch.score >= 70);
      const existingMeeting = shouldMerge
        ? (dbManager.getMeetingDetails(bestMatch.meeting.id) || bestMatch.meeting)
        : null;

      const finalMeeting = isExactMatch
        ? replaceMeetingFromSource(existingMeeting, incoming)
        : shouldMerge
          ? mergeMeetings(existingMeeting, incoming)
        : incoming;

      dbManager.saveMeeting(finalMeeting, finalMeeting.startTimeMs, finalMeeting.durationMs);
      const cachedMeeting = {
        ...finalMeeting,
        transcript: [],
        usage: [],
      };
      if (shouldMerge) {
        existingMeetings[bestMatch.index] = cachedMeeting;
      } else {
        existingMeetings.unshift(cachedMeeting);
      }
      imported.push({
        id: finalMeeting.id,
        title: finalMeeting.title,
        date: finalMeeting.date,
        transcriptSegments: finalMeeting.transcript?.length || 0,
        matchedExisting: shouldMerge,
      });

    if ((finalMeeting.transcript?.length || 0) > 0) {
      try {
        await ragManager.reprocessMeeting(finalMeeting.id);
      } catch (error) {
        console.warn(`[notion-backfill] Failed to reprocess meeting ${finalMeeting.id}:`, error.message);
      }
    }
  }

  const repaired = await new MeetingRepairService().repairImportedMeetings({
    meetingIds: imported.map((entry) => entry.id),
    allowOutlook: true,
    allowTeams: true,
    ragManager,
  });

  MicrosoftLocalManager.getInstance().stop();

  console.log(JSON.stringify({
    importedCount: imported.length,
    imported,
    repaired,
    dbPath: dbManager.getDbPath(),
  }, null, 2));

  await app.quit();
}

main().catch((error) => {
  console.error('[notion-backfill] Fatal error:', error);
  process.exitCode = 1;
});
