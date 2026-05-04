import base64
import io
import json
import math
import sys
from collections import defaultdict

from fafreplay import Parser, commands, extract_scfa


ACTION_COMMANDS = [
    commands.Advance,
    commands.SetCommandSource,
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


def read_replay(raw):
    try:
        return extract_scfa(io.BytesIO(raw))
    except Exception:
        return raw


def analyze(raw):
    first_newline = raw.find(b"\n")
    header = {}
    if 0 < first_newline < 128 * 1024:
        try:
            first_line = raw[:first_newline].decode("utf8").strip()
            if first_line.startswith("{"):
                header = json.loads(first_line)
        except Exception:
            header = {}

    scfa = read_replay(raw)
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
    })
    command_counts = defaultdict(int)

    for command in body.get("commands", []):
        name = command.get("name")
        command_counts[name] += 1
        if name == "Advance":
            tick += int(command.get("ticks") or 0)
            continue
        if name == "SetCommandSource":
            current_source = int(command.get("id") or 0)
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
    for index, name in enumerate(source_players):
        player = stats[name]
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
