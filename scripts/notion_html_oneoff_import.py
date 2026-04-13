import csv
import hashlib
import html
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_DURATION_MS = 60 * 60 * 1000


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()


def cleanup_markdown(value: str) -> str:
    text = re.sub(r"\n{3,}", "\n\n", (value or "").strip())
    return text.strip()


def strip_html(value: str) -> str:
    text = value or ""
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|li|h1|h2|h3|h4|tr)>", "\n", text, flags=re.I)
    text = re.sub(r"</td>", " | ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def normalize_title_for_match(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"^@", "", re.sub(r"\s+—\s+\d{4}-\d{2}-\d{2}$", "", re.sub(r"\s+[0-9a-f]{32}$", "", value or "", flags=re.I)))).strip().lower()


def parse_loose_date(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    range_match = re.match(r"^(.*?)\s+→\s+.*$", raw)
    if range_match:
        raw = range_match.group(1).strip()
    raw = re.sub(r"\s+\(UTC\)\s*$", " UTC", raw, flags=re.I)
    for fmt in (
        "%B %d, %Y %I:%M %p UTC",
        "%B %d, %Y %I:%M %p",
        "%B %d, %Y",
        "@%B %d, %Y %I:%M %p",
    ):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.isoformat() + "Z"
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def stable_meeting_id(title: str, notion_page_id: str) -> str:
    if notion_page_id:
        return f"notion-{notion_page_id}"
    return "notion-" + hashlib.md5((title or "Imported Notion Meeting").encode("utf-8")).hexdigest()[:12]


def title_words(value: str) -> set[str]:
    return {
        word
        for word in re.split(r"[^a-z0-9]+", (value or "").lower())
        if len(word) > 2
    }


def same_utc_day(left_iso: str, right_iso: str) -> bool:
    try:
        return left_iso[:10] == right_iso[:10]
    except Exception:
        return False


def score_existing_meeting(existing: dict[str, Any], incoming_title: str, incoming_date: str) -> int:
    score = 0
    if same_utc_day(existing["date"], incoming_date):
        score += 50
    incoming_words = title_words(incoming_title)
    existing_words = title_words(existing["title"])
    overlap = len(incoming_words & existing_words)
    score += overlap * 10
    if overlap >= min(3, len(incoming_words) or 0):
        score += 15
    return score


def parse_transcript_lines(text: str) -> list[dict[str, Any]]:
    lines = [line.strip() for line in re.split(r"\r?\n", text or "") if line.strip()]
    segments: list[dict[str, Any]] = []
    current_speaker = "Transcript"
    current_text: list[str] = []
    current_timestamp = None
    explicit = False

    def flush() -> None:
        nonlocal current_speaker, current_text, current_timestamp, explicit
        if not current_text:
            return
        segments.append(
            {
                "speaker": current_speaker or "Transcript",
                "text": clean_text(" ".join(current_text)),
                "timestamp": current_timestamp if current_timestamp is not None else len(segments) * 60000,
                "explicitTimestamp": explicit,
            }
        )
        current_speaker = "Transcript"
        current_text = []
        current_timestamp = None
        explicit = False

    for line in lines:
        match = re.match(r"^(.+?)\s+\[\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\]:\s*(.*)$", line)
        if match:
            flush()
            current_speaker = clean_text(match.group(1))
            current_timestamp = timestamp_to_ms(match.group(2))
            explicit = True
            if match.group(3).strip():
                current_text.append(match.group(3).strip())
            continue
        current_text.append(line)

    flush()
    return [segment for segment in segments if segment["text"]]


def timestamp_to_ms(value: str) -> int:
    parts = [int(part) for part in value.split(":")]
    if len(parts) == 3:
        return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000
    if len(parts) == 2:
        return ((parts[0] * 60) + parts[1]) * 1000
    return 0


def estimate_duration_ms(transcript: list[dict[str, Any]]) -> int:
    timestamps = [segment["timestamp"] for segment in transcript if segment.get("explicitTimestamp")]
    if len(timestamps) >= 2:
        return max(60000, (max(timestamps) - min(timestamps)) + 60000)
    return DEFAULT_DURATION_MS


@dataclass
class ParsedMeeting:
    meeting_id: str
    notion_page_id: str
    title: str
    date: str
    duration_ms: int
    summary: str
    overview: str
    action_items: list[str]
    key_points: list[str]
    transcript: list[dict[str, Any]]
    usage_text: str
    related_artifacts: list[str]


def parse_export(export_dir: Path) -> list[ParsedMeeting]:
    csv_rows: list[dict[str, str]] = []
    for csv_path in export_dir.parent.glob("*.csv"):
      with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        csv_rows.extend(list(csv.DictReader(handle)))

    csv_by_title = {
        normalize_title_for_match((row.get("Meeting Name") or "")): row
        for row in csv_rows
        if clean_text(row.get("Meeting Name") or "")
    }

    parsed: list[ParsedMeeting] = []
    for html_path in sorted(export_dir.glob("*.html")):
        parsed_meeting = parse_html_meeting(html_path, csv_by_title)
        if parsed_meeting:
            parsed.append(parsed_meeting)
    return parsed


def parse_html_meeting(html_path: Path, csv_by_title: dict[str, dict[str, str]]) -> ParsedMeeting | None:
    source = html_path.read_text(encoding="utf-8")
    notion_page_id = re.search(r"([0-9a-f]{32})\.html$", html_path.name, re.I)
    notion_page_id = notion_page_id.group(1) if notion_page_id else ""
    title_tag = html.unescape(re.search(r"<title>([\s\S]*?)</title>", source, re.I).group(1)) if re.search(r"<title>([\s\S]*?)</title>", source, re.I) else ""
    page_title = strip_html(re.search(r'<h1[^>]*class="page-title"[^>]*>([\s\S]*?)</h1>', source, re.I).group(1)) if re.search(r'<h1[^>]*class="page-title"[^>]*>([\s\S]*?)</h1>', source, re.I) else ""
    header_title = clean_text(title_tag or page_title or html_path.stem)
    csv_row = csv_by_title.get(normalize_title_for_match(header_title), {})

    properties: dict[str, str] = {}
    for key_html, value_html in re.findall(r"<tr class=\"property-row[\s\S]*?<th[\s\S]*?>([\s\S]*?)</th><td[\s\S]*?>([\s\S]*?)</td></tr>", source, re.I):
        key = strip_html(key_html)
        if "checkbox-on" in value_html:
            value = "__YES__"
        elif "checkbox-off" in value_html:
            value = "__NO__"
        else:
            value = strip_html(value_html)
        if key:
            properties[key] = value

    body_match = re.search(r'<div class="page-body">([\s\S]*?)</article>', source, re.I)
    body_html = body_match.group(1) if body_match else ""
    sections: dict[str, str] = {}
    for label, content in re.findall(r"<div style=\"border-bottom:0\.05em solid[\s\S]*?>([^<]+)<br/></div>([\s\S]*?)(?=<div style=\"border-bottom:0\.05em solid|$)", body_html, re.I):
        sections[strip_html(label).lower()] = content

    summary_html = sections.get("summary", "")
    notes_html = sections.get("notes", "")
    transcript_html = sections.get("transcript", "")

    action_items: list[str] = []
    key_points: list[str] = []
    current_heading = ""
    for block in re.findall(r"(<h3[^>]*>[\s\S]*?</h3>|<li[^>]*>[\s\S]*?</li>|<p[^>]*>[\s\S]*?</p>)", summary_html, re.I):
        if block.lower().startswith("<h3"):
            current_heading = strip_html(block).lower()
            continue
        text = strip_html(block)
        if not text:
            continue
        if "action item" in current_heading:
            if text.lower() != "none identified":
                action_items.append(text)
        else:
            key_points.append(text)

    transcript_text = strip_html(transcript_html)
    transcript = parse_transcript_lines(transcript_text)
    overview = cleanup_markdown(strip_html(summary_html) or (csv_row.get("Agenda") or "") or header_title)
    date = (
        parse_loose_date(csv_row.get("Date"))
        or parse_loose_date(properties.get("Date"))
        or parse_loose_date(page_title)
        or parse_loose_date(header_title)
        or datetime.utcnow().isoformat() + "Z"
    )
    title = clean_text(csv_row.get("Meeting Name") or properties.get("Meeting Name") or header_title or html_path.stem)

    return ParsedMeeting(
        meeting_id=stable_meeting_id(title, notion_page_id),
        notion_page_id=notion_page_id,
        title=title,
        date=date,
        duration_ms=estimate_duration_ms(transcript),
        summary=(overview.splitlines()[0] if overview else title)[:600],
        overview=overview,
        action_items=list(dict.fromkeys(action_items)),
        key_points=list(dict.fromkeys(key_points)),
        transcript=transcript,
        usage_text=cleanup_markdown(strip_html(notes_html)),
        related_artifacts=[
            str(html_path),
            *( [f"notion:{notion_page_id}"] if notion_page_id else [] ),
        ],
    )


def load_existing_imported_meetings(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "select id, title, created_at, start_time, duration_ms, calendar_event_id, summary_json from meetings where source='imported'"
    ).fetchall()
    meetings = []
    for row in rows:
        summary = json.loads(row[6] or "{}")
        import_metadata = summary.get("importMetadata") or {}
        meetings.append(
            {
                "id": row[0],
                "title": row[1] or "",
                "date": row[2] or "",
                "start_time": row[3] or 0,
                "duration_ms": row[4] or 0,
                "calendar_event_id": row[5],
                "import_metadata": import_metadata,
            }
        )
    return meetings


def find_best_existing_match(existing_meetings: list[dict[str, Any]], incoming: ParsedMeeting) -> tuple[dict[str, Any] | None, int]:
    for meeting in existing_meetings:
        if meeting["id"] == incoming.meeting_id:
            return meeting, 100
        if incoming.notion_page_id and meeting["import_metadata"].get("sourceMeetingId") == incoming.notion_page_id:
            return meeting, 100

    scored = [
        (meeting, score_existing_meeting(meeting, incoming.title, incoming.date))
        for meeting in existing_meetings
    ]
    scored = [item for item in scored if item[1] >= 70]
    scored.sort(key=lambda item: item[1], reverse=True)
    return scored[0] if scored else (None, 0)


def save_meeting(conn: sqlite3.Connection, incoming: ParsedMeeting, matched_existing: dict[str, Any] | None) -> dict[str, Any]:
    meeting_id = matched_existing["id"] if matched_existing else incoming.meeting_id
    start_time_ms = int(datetime.fromisoformat(incoming.date.replace("Z", "+00:00")).timestamp() * 1000)
    duration_ms = incoming.duration_ms or (matched_existing["duration_ms"] if matched_existing and matched_existing["duration_ms"] > 0 else DEFAULT_DURATION_MS)
    import_metadata = {
        "sourceFormat": "generic",
        "importedAt": datetime.utcnow().isoformat() + "Z",
        "fidelity": "exact",
        "relatedArtifacts": list(dict.fromkeys(incoming.related_artifacts)),
        "sourceMeetingId": incoming.notion_page_id or None,
        "enrichmentSources": [],
    }
    summary_json = json.dumps(
        {
            "legacySummary": incoming.summary or incoming.title,
            "detailedSummary": {
                "overview": incoming.overview,
                "actionItems": incoming.action_items,
                "keyPoints": incoming.key_points,
            },
            "importMetadata": import_metadata,
        }
    )

    conn.execute(
        """
        INSERT INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, calendar_event_id, source, is_processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            start_time = excluded.start_time,
            duration_ms = excluded.duration_ms,
            summary_json = excluded.summary_json,
            created_at = excluded.created_at,
            calendar_event_id = excluded.calendar_event_id,
            source = excluded.source,
            is_processed = excluded.is_processed
        """,
        (
            meeting_id,
            incoming.title,
            start_time_ms,
            duration_ms,
            summary_json,
            incoming.date,
            matched_existing["calendar_event_id"] if matched_existing else None,
            "imported",
            1,
        ),
    )
    conn.execute("delete from transcripts where meeting_id = ?", (meeting_id,))
    conn.execute("delete from ai_interactions where meeting_id = ?", (meeting_id,))
    conn.execute("delete from chunks where meeting_id = ?", (meeting_id,))
    conn.execute("delete from chunk_summaries where meeting_id = ?", (meeting_id,))

    for segment in incoming.transcript:
        conn.execute(
            "insert into transcripts (meeting_id, speaker, content, timestamp_ms) values (?, ?, ?, ?)",
            (meeting_id, segment["speaker"], segment["text"], segment["timestamp"]),
        )

    if incoming.usage_text:
        conn.execute(
            "insert into ai_interactions (meeting_id, type, timestamp, user_query, ai_response, metadata_json) values (?, ?, ?, ?, ?, ?)",
            (meeting_id, "assist", start_time_ms, None, incoming.usage_text, None),
        )

    return {
        "id": meeting_id,
        "title": incoming.title,
        "date": incoming.date,
        "duration_ms": duration_ms,
        "matched_existing": bool(matched_existing),
        "transcript_segments": len(incoming.transcript),
    }


def main() -> None:
    export_dir = Path(r"c:\Users\snahrup\CascadeProjects\natively\notion_export\Notion_Meeting_Export\Meetings")
    db_path = Path(os.environ["APPDATA"]) / "natively" / "natively.db"
    parsed = parse_export(export_dir)
    if not parsed:
        raise RuntimeError("No exported meeting HTML files were parsed.")

    conn = sqlite3.connect(db_path)
    conn.execute("pragma foreign_keys = ON")
    existing = load_existing_imported_meetings(conn)

    updated = []
    with conn:
        for item in parsed:
            matched_existing, _score = find_best_existing_match(existing, item)
            result = save_meeting(conn, item, matched_existing)
            updated.append(result)
            if matched_existing:
                for idx, record in enumerate(existing):
                    if record["id"] == matched_existing["id"]:
                        existing[idx] = {
                            **record,
                            "title": item.title,
                            "date": item.date,
                            "duration_ms": result["duration_ms"],
                            "import_metadata": {
                                **record["import_metadata"],
                                "sourceMeetingId": item.notion_page_id or record["import_metadata"].get("sourceMeetingId"),
                            },
                        }
                        break
            else:
                existing.append(
                    {
                        "id": result["id"],
                        "title": item.title,
                        "date": item.date,
                        "start_time": int(datetime.fromisoformat(item.date.replace("Z", "+00:00")).timestamp() * 1000),
                        "duration_ms": result["duration_ms"],
                        "calendar_event_id": None,
                        "import_metadata": {"sourceMeetingId": item.notion_page_id or None},
                    }
                )

    print(
        json.dumps(
            {
                "db_path": str(db_path),
                "parsed_count": len(parsed),
                "updated_count": len(updated),
                "matched_existing_count": sum(1 for item in updated if item["matched_existing"]),
                "new_count": sum(1 for item in updated if not item["matched_existing"]),
                "sample": updated[:10],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
