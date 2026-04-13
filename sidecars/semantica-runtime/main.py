from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn


def _resolve_semantica_root() -> Path:
    env_path = os.environ.get("SEMANTICA_UPSTREAM_PATH", "").strip()
    if env_path:
        return Path(env_path).expanduser().resolve()
    current = Path(__file__).resolve()
    candidates = [
        current.parents[2] / "semantica-upstream",
        current.parents[2] / "semantica",
        current.parents[2].parent / "semantica",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return candidates[-1].resolve()


SEMANTICA_ROOT = _resolve_semantica_root()
if str(SEMANTICA_ROOT) not in sys.path:
    sys.path.insert(0, str(SEMANTICA_ROOT))

from semantica.context.context_graph import ContextGraph  # type: ignore  # noqa: E402


DEFAULT_PORT = int(os.environ.get("SEMANTICA_SIDECAR_PORT", "8765"))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def compact_whitespace(value: str) -> str:
    return " ".join((value or "").split()).strip()


def safe_json_loads(value: Optional[str], fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def tokenize(value: str) -> List[str]:
    return [part for part in "".join(ch.lower() if ch.isalnum() or ch in "@._-" else " " for ch in value).split() if len(part) >= 3]


def overlap_ratio(left: Iterable[str], right: Iterable[str]) -> float:
    left_list = list(left)
    right_set = set(right)
    if not left_list or not right_set:
        return 0.0
    matches = sum(1 for item in left_list if item in right_set)
    return matches / max(1, len(left_list))


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def excerpt(value: str, max_chars: int = 240) -> str:
    compact = compact_whitespace(value)
    if len(compact) <= max_chars:
        return compact
    return f"{compact[: max_chars - 1]}…"


def parse_iso_ms(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return None


def participant_node_id(name: str) -> str:
    return f"participant:{compact_whitespace(name).lower()}"


def artifact_node_id(meeting_id: str, label: str, index: int) -> str:
    return f"artifact:{meeting_id}:{index}:{compact_whitespace(label).lower()}"


def action_node_id(meeting_id: str, text: str, index: int) -> str:
    return f"action:{meeting_id}:{index}:{abs(hash(compact_whitespace(text))) % 100000000}"


def keypoint_node_id(meeting_id: str, text: str, index: int) -> str:
    return f"keypoint:{meeting_id}:{index}:{abs(hash(compact_whitespace(text))) % 100000000}"


def entity_node_id(text: str) -> str:
    return f"entity:{compact_whitespace(text).lower()}"


def meeting_node_id(meeting_id: str) -> str:
    return f"meeting:{meeting_id}"


class MeetingArtifactModel(BaseModel):
    label: str
    kind: Optional[str] = None
    content: Optional[str] = None


class MeetingPayload(BaseModel):
    id: str
    title: str
    date: str
    duration: str
    source: Optional[str] = "manual"
    summary: Optional[str] = ""
    detailedSummary: Optional[Dict[str, Any]] = None
    transcript: List[Dict[str, Any]] = Field(default_factory=list)
    usage: List[Dict[str, Any]] = Field(default_factory=list)
    importMetadata: Optional[Dict[str, Any]] = None
    calendarEventId: Optional[str] = None


class BulkMeetingPayload(BaseModel):
    meetings: List[MeetingPayload]


class QueryRequest(BaseModel):
    query: str
    activeMeetingId: Optional[str] = None
    participantHints: List[str] = Field(default_factory=list)
    limit: int = 8
    surface: str = "reactive"


class DeleteRequest(BaseModel):
    meetingId: str


@dataclass
class SourceRecord:
    source_type: str
    source_id: str
    title: str
    content: str
    created_at: str
    updated_at: str
    participants: List[str]
    metadata: Dict[str, Any]


class SemanticaState:
    def __init__(self) -> None:
        app_data_root = Path(os.environ.get("NATIVELY_SEMANTICA_STATE_DIR", "") or (Path(os.environ["APPDATA"]) / "natively" / "semantica"))
        app_data_root.mkdir(parents=True, exist_ok=True)
        self.state_dir = app_data_root
        self.db_path = self.state_dir / "semantica-bridge.db"
        self.graph_path = self.state_dir / "graph.json"
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._ensure_schema()
        self.graph = ContextGraph(
            advanced_analytics=False,
            centrality_analysis=False,
            community_detection=False,
            node_embeddings=False,
        )
        self._rebuild_graph()

    def _ensure_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS source_records (
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                participants_json TEXT,
                metadata_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (source_type, source_id)
            );

            CREATE TABLE IF NOT EXISTS sidecar_state (
                state_key TEXT PRIMARY KEY,
                state_value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        self.conn.commit()

    def upsert_meeting(self, meeting: MeetingPayload) -> None:
        with self.lock:
            record = self._meeting_to_record(meeting)
            self.conn.execute(
                """
                INSERT INTO source_records (
                    source_type, source_id, title, content, participants_json, metadata_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_type, source_id) DO UPDATE SET
                    title = excluded.title,
                    content = excluded.content,
                    participants_json = excluded.participants_json,
                    metadata_json = excluded.metadata_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                (
                    record.source_type,
                    record.source_id,
                    record.title,
                    record.content,
                    json.dumps(record.participants),
                    json.dumps(record.metadata),
                    record.created_at,
                    record.updated_at,
                ),
            )
            self.conn.commit()
            self._rebuild_graph()

    def bulk_upsert_meetings(self, meetings: List[MeetingPayload]) -> int:
        with self.lock:
            rows = [self._meeting_to_record(meeting) for meeting in meetings]
            self.conn.executemany(
                """
                INSERT INTO source_records (
                    source_type, source_id, title, content, participants_json, metadata_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_type, source_id) DO UPDATE SET
                    title = excluded.title,
                    content = excluded.content,
                    participants_json = excluded.participants_json,
                    metadata_json = excluded.metadata_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at
                """,
                [
                    (
                        row.source_type,
                        row.source_id,
                        row.title,
                        row.content,
                        json.dumps(row.participants),
                        json.dumps(row.metadata),
                        row.created_at,
                        row.updated_at,
                    )
                    for row in rows
                ],
            )
            self.conn.commit()
            self._rebuild_graph()
            return len(rows)

    def delete_meeting(self, meeting_id: str) -> bool:
        with self.lock:
            result = self.conn.execute(
                "DELETE FROM source_records WHERE source_type = 'meeting' AND source_id = ?",
                (meeting_id,),
            )
            self.conn.commit()
            if result.rowcount:
                self._rebuild_graph()
                return True
            return False

    def get_status(self) -> Dict[str, Any]:
        with self.lock:
            total_records = self.conn.execute("SELECT COUNT(*) FROM source_records").fetchone()[0]
            total_meetings = self.conn.execute("SELECT COUNT(*) FROM source_records WHERE source_type = 'meeting'").fetchone()[0]
            return {
                "status": "healthy",
                "semanticaRoot": str(SEMANTICA_ROOT),
                "stateDir": str(self.state_dir),
                "dbPath": str(self.db_path),
                "graphPath": str(self.graph_path),
                "recordCount": total_records,
                "meetingCount": total_meetings,
                "nodeCount": len(self.graph.nodes),
                "edgeCount": len(self.graph.edges),
                "generatedAt": utc_now_iso(),
            }

    def get_network(self) -> Dict[str, Any]:
        with self.lock:
            return self.graph.to_dict()

    def query_meetings(self, request: QueryRequest) -> Dict[str, Any]:
        query = request.query.strip()
        if not query:
            return {"query": query, "results": [], "generatedAt": utc_now_iso()}

        with self.lock:
            records = self._load_records()
            record_map = {record.source_id: record for record in records if record.source_type == "meeting"}
            aggregated: Dict[str, Dict[str, Any]] = {}
            base_hits = self.graph.query(query, limit=120)
            active_related_ids = set()
            if request.activeMeetingId:
                for neighbor in self.graph.get_neighbors(meeting_node_id(request.activeMeetingId), hops=2, min_weight=0.2):
                    if neighbor["id"].startswith("meeting:"):
                        active_related_ids.add(neighbor["id"].split(":", 1)[1])

            for hit in base_hits:
                node = hit.get("node") or {}
                score = float(hit.get("score") or 0.0)
                for linked_id, reason in self._expand_hit_to_meetings(node.get("id", ""), node.get("type", ""), node.get("content", "")):
                    self._accumulate_hit(
                        aggregated,
                        linked_id,
                        score,
                        reason,
                        node.get("type", "entity"),
                    )

            query_terms = tokenize(query)
            participant_terms = tokenize(" ".join(request.participantHints))
            for meeting_id, bucket in list(aggregated.items()):
                record = record_map.get(meeting_id)
                if not record:
                    aggregated.pop(meeting_id, None)
                    continue
                record_terms = tokenize(" ".join([record.title, record.content, " ".join(record.participants)]))
                lexical_boost = overlap_ratio(query_terms, record_terms)
                participant_boost = overlap_ratio(participant_terms, tokenize(" ".join(record.participants)))
                recency_boost = self._recency_boost(record.created_at)
                related_boost = 0.18 if meeting_id in active_related_ids else 0.0
                total = bucket["score"] + (0.45 * lexical_boost) + (0.2 * participant_boost) + (0.12 * recency_boost) + related_boost
                bucket["score"] = clamp(total, 0.0, 2.5)
                bucket["lexicalBoost"] = lexical_boost
                bucket["participantBoost"] = participant_boost
                bucket["recencyBoost"] = recency_boost
                bucket["activeMeetingBoost"] = related_boost

            ranked = sorted(aggregated.values(), key=lambda item: item["score"], reverse=True)[: max(1, request.limit)]
            results: List[Dict[str, Any]] = []
            for item in ranked:
                record = record_map.get(item["meetingId"])
                if not record:
                    continue
                metadata = record.metadata
                detailed = metadata.get("detailedSummary") if isinstance(metadata, dict) else None
                source_type = "meeting_summary" if compact_whitespace(record.content) else "manual_import"
                results.append(
                    {
                        "id": f"semantica:meeting:{record.source_id}",
                        "meetingId": record.source_id,
                        "sourceType": source_type,
                        "sourceSystem": f"semantica:{metadata.get('source', 'meeting')}",
                        "title": record.title,
                        "body": record.content,
                        "excerpt": excerpt(record.content),
                        "createdAt": record.created_at,
                        "updatedAt": record.updated_at,
                        "participants": record.participants,
                        "relatedMeetingIds": [record.source_id],
                        "freshnessClass": self._freshness_class(record.created_at),
                        "trustTier": "durable",
                        "visibility": "private",
                        "sourceScore": clamp(item["score"], 0.0, 1.0),
                        "lexicalTerms": tokenize(" ".join([record.title, record.content])),
                        "entities": metadata.get("entities", []) if isinstance(metadata, dict) else [],
                        "metadata": {
                            "source": metadata.get("source"),
                            "duration": metadata.get("duration"),
                            "date": metadata.get("date"),
                            "importMetadata": metadata.get("importMetadata"),
                            "detailedSummary": detailed,
                            "semanticaReasons": item["reasons"][:8],
                            "semanticaNodeMatches": item["matchTypes"][:8],
                        },
                        "scoreBreakdown": {
                            "graph": item["graphScore"],
                            "lexicalBoost": item["lexicalBoost"],
                            "participantBoost": item["participantBoost"],
                            "recencyBoost": item["recencyBoost"],
                            "activeMeetingBoost": item["activeMeetingBoost"],
                        },
                    }
                )

            return {
                "query": query,
                "generatedAt": utc_now_iso(),
                "results": results,
            }

    def _meeting_to_record(self, meeting: MeetingPayload) -> SourceRecord:
        detailed = meeting.detailedSummary or {}
        key_points = [compact_whitespace(str(item)) for item in (detailed.get("keyPoints") or []) if compact_whitespace(str(item))]
        action_items = [compact_whitespace(str(item)) for item in (detailed.get("actionItems") or []) if compact_whitespace(str(item))]
        transcript = meeting.transcript or []
        transcript_text = " ".join(
            compact_whitespace(f"{segment.get('speaker') or 'Speaker'} {segment.get('text') or ''}")
            for segment in transcript[:40]
            if compact_whitespace(segment.get("text") or "")
        )
        participants = sorted(
            {
                compact_whitespace(str(segment.get("speaker") or ""))
                for segment in transcript
                if compact_whitespace(str(segment.get("speaker") or ""))
                and compact_whitespace(str(segment.get("speaker") or "")).lower() not in {"speaker", "unknown", "participant", "user", "assistant"}
            }
        )
        artifacts = self._extract_artifacts(meeting)
        entities = self._extract_entities_from_text(
            " ".join([meeting.title, meeting.summary or "", " ".join(key_points), " ".join(action_items)])
        )
        content_parts = [
            meeting.title,
            meeting.summary or "",
            compact_whitespace(str(detailed.get("overview") or "")),
            " | ".join(key_points),
            " | ".join(action_items),
            transcript_text[:8000],
        ]
        content = "\n".join(part for part in content_parts if compact_whitespace(part))
        metadata = {
            "date": meeting.date,
            "duration": meeting.duration,
            "source": meeting.source or "manual",
            "summary": meeting.summary or "",
            "detailedSummary": meeting.detailedSummary or {},
            "importMetadata": meeting.importMetadata or {},
            "calendarEventId": meeting.calendarEventId,
            "artifactLabels": [artifact["label"] for artifact in artifacts],
            "artifacts": artifacts,
            "actionItems": action_items,
            "keyPoints": key_points,
            "entities": entities,
        }
        now = utc_now_iso()
        return SourceRecord(
            source_type="meeting",
            source_id=meeting.id,
            title=meeting.title,
            content=content,
            created_at=meeting.date or now,
            updated_at=now,
            participants=participants,
            metadata=metadata,
        )

    def _extract_artifacts(self, meeting: MeetingPayload) -> List[Dict[str, Any]]:
        import_meta = meeting.importMetadata or {}
        raw_artifacts = import_meta.get("artifacts") if isinstance(import_meta, dict) else None
        artifacts: List[Dict[str, Any]] = []
        if isinstance(raw_artifacts, list):
            for item in raw_artifacts:
                if not isinstance(item, dict):
                    continue
                label = compact_whitespace(str(item.get("label") or item.get("name") or item.get("type") or "artifact"))
                if not label:
                    continue
                artifacts.append(
                    {
                        "label": label,
                        "kind": compact_whitespace(str(item.get("kind") or item.get("type") or "")) or None,
                        "content": excerpt(str(item.get("content") or "")) if item.get("content") else None,
                    }
                )
        return artifacts

    def _extract_entities_from_text(self, text: str) -> List[str]:
        entities: List[str] = []
        seen: set[str] = set()
        for token in compact_whitespace(text).split():
            cleaned = token.strip(".,:;!?()[]{}<>\"'")
            if len(cleaned) < 4:
                continue
            if not any(ch.isupper() for ch in cleaned):
                continue
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            entities.append(cleaned)
            if len(entities) >= 12:
                break
        return entities

    def _load_records(self) -> List[SourceRecord]:
        rows = self.conn.execute(
            """
            SELECT source_type, source_id, title, content, participants_json, metadata_json, created_at, updated_at
            FROM source_records
            ORDER BY updated_at DESC
            """
        ).fetchall()
        return [
            SourceRecord(
                source_type=row["source_type"],
                source_id=row["source_id"],
                title=row["title"],
                content=row["content"],
                participants=safe_json_loads(row["participants_json"], []),
                metadata=safe_json_loads(row["metadata_json"], {}),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    def _rebuild_graph(self) -> None:
        records = self._load_records()
        graph = ContextGraph(
            advanced_analytics=False,
            centrality_analysis=False,
            community_detection=False,
            node_embeddings=False,
        )

        meeting_relationship_candidates: List[Dict[str, Any]] = []

        for record in records:
            if record.source_type != "meeting":
                continue
            meeting_id = record.source_id
            meeting_node = meeting_node_id(meeting_id)
            graph.add_node(
                meeting_node,
                "meeting",
                record.content or record.title,
                title=record.title,
                source_record_id=meeting_id,
                source_type=record.source_type,
                created_at=record.created_at,
                updated_at=record.updated_at,
                participants=record.participants,
                **record.metadata,
            )

            for participant in record.participants:
                participant_id = participant_node_id(participant)
                graph.add_node(participant_id, "participant", participant, name=participant)
                graph.add_edge(meeting_node, participant_id, "has_participant", weight=0.92)
                graph.add_edge(participant_id, meeting_node, "participated_in", weight=0.92)

            for index, artifact in enumerate(record.metadata.get("artifacts", []) or []):
                label = compact_whitespace(str(artifact.get("label") or "artifact"))
                if not label:
                    continue
                artifact_id = artifact_node_id(meeting_id, label, index)
                graph.add_node(
                    artifact_id,
                    "artifact",
                    label,
                    label=label,
                    kind=artifact.get("kind"),
                    source_record_id=meeting_id,
                )
                graph.add_edge(meeting_node, artifact_id, "has_artifact", weight=0.76)
                graph.add_edge(artifact_id, meeting_node, "artifact_for", weight=0.76)

            for index, action in enumerate(record.metadata.get("actionItems", []) or []):
                text = compact_whitespace(str(action))
                if not text:
                    continue
                action_id = action_node_id(meeting_id, text, index)
                graph.add_node(action_id, "action_item", text, source_record_id=meeting_id)
                graph.add_edge(meeting_node, action_id, "has_action_item", weight=0.88)
                graph.add_edge(action_id, meeting_node, "action_from", weight=0.88)

            for index, key_point in enumerate(record.metadata.get("keyPoints", []) or []):
                text = compact_whitespace(str(key_point))
                if not text:
                    continue
                point_id = keypoint_node_id(meeting_id, text, index)
                graph.add_node(point_id, "key_point", text, source_record_id=meeting_id)
                graph.add_edge(meeting_node, point_id, "has_key_point", weight=0.8)
                graph.add_edge(point_id, meeting_node, "key_point_from", weight=0.8)

            for entity in record.metadata.get("entities", []) or []:
                text = compact_whitespace(str(entity))
                if not text:
                    continue
                entity_id = entity_node_id(text)
                graph.add_node(entity_id, "entity", text, name=text)
                graph.add_edge(meeting_node, entity_id, "mentions_entity", weight=0.64)
                graph.add_edge(entity_id, meeting_node, "mentioned_in", weight=0.64)

            meeting_relationship_candidates.append(
                {
                    "meetingId": meeting_id,
                    "nodeId": meeting_node,
                    "titleTokens": tokenize(record.title),
                    "participants": {participant.lower() for participant in record.participants},
                    "createdAtMs": parse_iso_ms(record.created_at),
                }
            )

        for index, left in enumerate(meeting_relationship_candidates):
            for right in meeting_relationship_candidates[index + 1 :]:
                participant_overlap = overlap_ratio(left["participants"], right["participants"])
                title_overlap = overlap_ratio(left["titleTokens"], right["titleTokens"])
                time_score = self._time_proximity_score(left["createdAtMs"], right["createdAtMs"])
                score = (0.5 * participant_overlap) + (0.3 * title_overlap) + (0.2 * time_score)
                if score < 0.22:
                    continue
                relationship = "continues_with" if participant_overlap >= 0.34 else "related_meeting"
                graph.add_edge(left["nodeId"], right["nodeId"], relationship, weight=clamp(score, 0.22, 0.95))
                graph.add_edge(right["nodeId"], left["nodeId"], relationship, weight=clamp(score, 0.22, 0.95))

        self.graph = graph
        self.graph_path.write_text(json.dumps(graph.to_dict(), indent=2), encoding="utf-8")

    def _expand_hit_to_meetings(self, node_id: str, node_type: str, content: str) -> List[tuple[str, str]]:
        if not node_id:
            return []
        if node_id.startswith("meeting:"):
            return [(node_id.split(":", 1)[1], f"Direct {node_type} match: {excerpt(content, 120)}")]
        results: List[tuple[str, str]] = []
        for neighbor in self.graph.get_neighbors(node_id, hops=2, min_weight=0.2):
            if neighbor["id"].startswith("meeting:"):
                results.append(
                    (
                        neighbor["id"].split(":", 1)[1],
                        f"{node_type} -> {neighbor['relationship']}: {excerpt(content or neighbor.get('content', ''), 120)}",
                    )
                )
        return results

    def _accumulate_hit(
        self,
        aggregated: Dict[str, Dict[str, Any]],
        meeting_id: str,
        base_score: float,
        reason: str,
        match_type: str,
    ) -> None:
        bucket = aggregated.setdefault(
            meeting_id,
            {
                "meetingId": meeting_id,
                "score": 0.0,
                "graphScore": 0.0,
                "reasons": [],
                "matchTypes": [],
                "lexicalBoost": 0.0,
                "participantBoost": 0.0,
                "recencyBoost": 0.0,
                "activeMeetingBoost": 0.0,
            },
        )
        bucket["score"] += base_score
        bucket["graphScore"] += base_score
        if reason not in bucket["reasons"]:
            bucket["reasons"].append(reason)
        if match_type not in bucket["matchTypes"]:
            bucket["matchTypes"].append(match_type)

    def _time_proximity_score(self, left_ms: Optional[int], right_ms: Optional[int]) -> float:
        if not left_ms or not right_ms:
            return 0.0
        delta_days = abs(left_ms - right_ms) / (24 * 60 * 60 * 1000)
        if delta_days <= 7:
            return 1.0
        if delta_days <= 30:
            return 0.55
        if delta_days <= 90:
            return 0.25
        return 0.0

    def _recency_boost(self, created_at: str) -> float:
        created_at_ms = parse_iso_ms(created_at)
        if not created_at_ms:
            return 0.0
        age_days = max(0.0, (datetime.now(timezone.utc).timestamp() * 1000 - created_at_ms) / (24 * 60 * 60 * 1000))
        if age_days <= 7:
            return 1.0
        if age_days <= 30:
            return 0.7
        if age_days <= 90:
            return 0.4
        if age_days <= 365:
            return 0.18
        return 0.05

    def _freshness_class(self, created_at: str) -> str:
        created_at_ms = parse_iso_ms(created_at)
        if not created_at_ms:
            return "historical"
        age_days = max(0.0, (datetime.now(timezone.utc).timestamp() * 1000 - created_at_ms) / (24 * 60 * 60 * 1000))
        if age_days <= 3:
            return "live"
        if age_days <= 45:
            return "recent"
        return "historical"


state = SemanticaState()
app = FastAPI(title="Natively Semantica Bridge", version="0.1.0")


@app.get("/health")
def health() -> Dict[str, Any]:
    return state.get_status()


@app.get("/api/status")
def status() -> Dict[str, Any]:
    return state.get_status()


@app.post("/api/meetings/upsert")
def upsert_meeting(payload: MeetingPayload) -> Dict[str, Any]:
    state.upsert_meeting(payload)
    return {"ok": True, "meetingId": payload.id, "generatedAt": utc_now_iso()}


@app.post("/api/meetings/bulk-upsert")
def bulk_upsert_meetings(payload: BulkMeetingPayload) -> Dict[str, Any]:
    count = state.bulk_upsert_meetings(payload.meetings)
    return {"ok": True, "count": count, "generatedAt": utc_now_iso()}


@app.post("/api/meetings/delete")
def delete_meeting(payload: DeleteRequest) -> Dict[str, Any]:
    deleted = state.delete_meeting(payload.meetingId)
    if not deleted:
        raise HTTPException(status_code=404, detail="Meeting not found in Semantica sidecar")
    return {"ok": True, "meetingId": payload.meetingId, "generatedAt": utc_now_iso()}


@app.post("/api/query/meetings")
def query_meetings(payload: QueryRequest) -> Dict[str, Any]:
    return state.query_meetings(payload)


@app.get("/api/network")
def network() -> Dict[str, Any]:
    return state.get_network()


def main() -> None:
    host = os.environ.get("SEMANTICA_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("SEMANTICA_SIDECAR_PORT", str(DEFAULT_PORT)))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
