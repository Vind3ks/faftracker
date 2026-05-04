import base64
import io
import json
import math
import sys
import zlib
from collections import defaultdict

from fafreplay import Parser, commands, extract_scfa
import zstd
import zstandard


ACTION_COMMANDS = [
    commands.Advance,
    commands.SetCommandSource,
    commands.CommandSourceTerminated,
    commands.DestroyEntity,
    commands.EndGame,
    commands.IssueCommand,
    commands.IssueFactoryCommand,
]


def player_sources(header):
    teams = header.get("teams") if isinstance(header, dict) else {}
    rows = []
    if isinstance(teams, dict):
        for team_id in sorted(teams, key=lambda value: int(value) if str(value).isdigit() else 999):
            if str(team_id) == "1":
                continue
            players = teams.get(team_id) or []
            if isinstance(players, list):
                rows.extend(str(name) for name in players)
    return rows


def target_point(command):
    target = command.get("target")
    if isinstance(target, dict) and "x" in target and "z" in target:
        return {
            "x": float(target.get("x") or 0),
            "z": float(target.get("z") or 0),
        }
    return None


def action_signature(command):
    point = target_point(command)
    rounded_target = None
    if point:
        # Collapse template/queued command bursts while keeping spatial intent.
        rounded_target = {
            "x": round(point["x"] / 8) * 8,
            "z": round(point["z"] / 8) * 8,
        }
    return (
        command.get("name"),
        command.get("type"),
        command.get("blueprint") or "",
        json.dumps(rounded_target, sort_keys=True),
    )


def blueprint_tech(blueprint):
    value = str(blueprint or "").lower()
    if len(value) < 4:
        return None
    if value[3] == "2":
        return "t2"
    if value[3] == "3":
        return "t3"
    if value[3] == "4":
        return "experimental"
    return None


def blueprint_kind(blueprint):
    value = str(blueprint or "").lower()
    if len(value) < 3:
        return "unknown"
    if value[2] == "b":
        return "structure"
    if value[2] == "l":
        return "land"
    if value[2] == "a":
        return "air"
    if value[2] == "s":
        return "naval"
    return "unit"


def blueprint_label(blueprint):
    value = str(blueprint or "").lower()
    tech = blueprint_tech(value)
    kind = blueprint_kind(value)
    if not value:
        return "Unknown"
    if kind == "structure" and tech in ("t2", "t3"):
        return f"{tech.upper()} structure"
    if tech:
        return f"{tech.upper()} {kind}"
    return kind.title()


def blueprint_event(command, tick):
    blueprint = command.get("blueprint") or ""
    return {
        "tick": tick,
        "second": tick / 10,
        "blueprint": blueprint,
        "label": blueprint_label(blueprint),
        "kind": blueprint_kind(blueprint),
        "source": command.get("name"),
    }


def parse_faf_header(raw):
    first_newline = raw.find(b"\n")
    if not (0 < first_newline < 128 * 1024):
        return {}, 0
    try:
        first_line = raw[:first_newline].decode("utf8").strip()
        if first_line.startswith("{"):
            return json.loads(first_line), first_newline + 1
    except Exception:
        return {}, 0
    return {}, 0


def looks_like_scfa(raw):
    return raw.startswith(b"Supreme Commander")


def looks_like_zstd(raw):
    return raw.startswith(b"\x28\xb5\x2f\xfd")


def decompress_zstd(raw):
    try:
        return zstd.decompress(raw)
    except Exception as first_error:
        try:
            dctx = zstandard.ZstdDecompressor()
            with dctx.stream_reader(io.BytesIO(raw)) as reader:
                chunks = []
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                return b"".join(chunks)
        except Exception as stream_error:
            raise RuntimeError(f"one-shot failed: {first_error}; streaming failed: {stream_error}") from stream_error


def read_replay(raw, header, body_offset):
    if looks_like_scfa(raw):
        return raw

    if header and body_offset:
        try:
            return extract_scfa(io.BytesIO(raw))
        except Exception as error:
            compression = header.get("compression") or "unknown"
            body = raw[body_offset:]
            if compression == "zstd" or looks_like_zstd(body):
                try:
                    return decompress_zstd(body)
                except Exception as zstd_error:
                    raise RuntimeError(f"Unable to decompress FAF replay zstd body: {zstd_error}") from error
            if compression == "zlib":
                try:
                    return zlib.decompress(body)
                except Exception as zlib_error:
                    raise RuntimeError(f"Unable to decompress FAF replay zlib body: {zlib_error}") from error
            raise RuntimeError(f"Unable to extract FAF replay body ({compression}): {error}") from error

    if looks_like_zstd(raw):
        try:
            return decompress_zstd(raw)
        except Exception as error:
            raise RuntimeError(f"Replay looks like a raw zstd stream, but decompression failed: {error}") from error

    raise RuntimeError("Replay file is not a recognized .fafreplay or .scfareplay stream.")


def analyze(raw):
    header, body_offset = parse_faf_header(raw)

    scfa = read_replay(raw, header, body_offset)
    parser = Parser(
        commands=ACTION_COMMANDS,
        save_commands=True,
        limit=None,
        stop_on_desync=False,
    )
    replay = parser.parse(scfa)
    body = replay["body"]
    tick = 0
    current_source = 0
    source_players = player_sources(header)
    stats = defaultdict(lambda: {
        "rawCommands": 0,
        "effectiveActions": 0,
        "points": [],
        "bursts": set(),
        "tech": {},
        "firstUnits": {},
        "status": {},
    })
    command_counts = defaultdict(int)
    source_status = {}

    for command in body.get("commands", []):
        name = command.get("name")
        command_counts[name] += 1
        if name == "Advance":
            tick += int(command.get("ticks") or 0)
            continue
        if name == "SetCommandSource":
            current_source = int(command.get("id") or 0)
            continue
        if name == "CommandSourceTerminated":
            source_id = int(command.get("id") or current_source or 0)
            player_name = source_players[source_id] if source_id < len(source_players) else f"Source {source_id}"
            source_status[player_name] = {
                "type": "left",
                "tick": tick,
                "second": tick / 10,
                "detail": "Command source terminated",
            }
            continue
        if name == "EndGame":
            player_name = source_players[current_source] if current_source < len(source_players) else f"Source {current_source}"
            source_status[player_name] = {
                "type": "ended",
                "tick": tick,
                "second": tick / 10,
                "detail": command.get("result") or command.get("reason") or "Game ended",
            }
            continue
        if name == "DestroyEntity":
            continue
        if name not in ("IssueCommand", "IssueFactoryCommand"):
            continue

        player_name = source_players[current_source] if current_source < len(source_players) else f"Source {current_source}"
        player = stats[player_name]
        player["rawCommands"] += 1

        signature = (tick, current_source, action_signature(command))
        if signature not in player["bursts"]:
            player["bursts"].add(signature)
            player["effectiveActions"] += 1

        tech = blueprint_tech(command.get("blueprint"))
        if tech and command.get("type") == 7 and tech not in player["firstUnits"]:
            player["firstUnits"][tech] = blueprint_event(command, tick)
        elif tech and tech not in player["tech"]:
            player["tech"][tech] = blueprint_event(command, tick)

        point = target_point(command)
        if point:
            player["points"].append({
                "tick": tick,
                "second": tick / 10,
                "x": point["x"],
                "z": point["z"],
                "effective": signature in player["bursts"],
            })

    duration_ticks = int(body.get("sim", {}).get("tick") or tick)
    duration_seconds = max(1, duration_ticks / 10)
    bucket_count = max(1, min(180, math.ceil(duration_seconds / 20)))
    bucket_seconds = max(1, math.ceil(duration_seconds / bucket_count))

    players = []
    all_player_names = source_players[:]
    for name in stats:
        if name not in all_player_names:
            all_player_names.append(name)

    for index, name in enumerate(all_player_names):
        player = stats[name]
        if name in source_status:
            player["status"] = source_status[name]
        effective_actions = player["effectiveActions"]
        raw_commands = player["rawCommands"]
        apm = effective_actions / max(duration_seconds / 60, 1 / 60)
        buckets = [0 for _ in range(bucket_count)]
        for point in player["points"]:
            bucket_index = min(bucket_count - 1, int(point["second"] // bucket_seconds))
            buckets[bucket_index] += 1
        players.append({
            "name": name,
            "source": index,
            "apm": round(apm, 1),
            "effectiveActions": effective_actions,
            "rawCommands": raw_commands,
            "tech": player["tech"],
            "firstUnits": player["firstUnits"],
            "status": player["status"],
            "points": player["points"][:5000],
            "buckets": buckets,
        })

    max_bucket = max([value for player in players for value in player["buckets"]] or [0])
    timeline = []
    for bucket_index in range(bucket_count):
        timeline.append({
            "index": bucket_index,
            "start": bucket_index * bucket_seconds,
            "end": min(duration_seconds, (bucket_index + 1) * bucket_seconds),
            "players": [
                {
                    "name": player["name"],
                    "actions": player["buckets"][bucket_index],
                    "heat": player["buckets"][bucket_index] / max_bucket if max_bucket else 0,
                }
                for player in players
            ],
        })

    return {
        "available": True,
        "durationTicks": duration_ticks,
        "durationSeconds": duration_seconds,
        "players": players,
        "timeline": timeline,
        "bucketSeconds": bucket_seconds,
        "commandCounts": dict(command_counts),
        "note": "Effective APM collapses same-tick command bursts so templates and queued command chains do not count as separate user actions.",
    }


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    raw = base64.b64decode(payload.get("replayBase64") or "")
    print(json.dumps(analyze(raw), separators=(",", ":")))


if __name__ == "__main__":
    main()
