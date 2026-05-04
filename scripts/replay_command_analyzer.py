import base64
import io
import json
import math
import re
import sys
import urllib.request
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
    commands.LuaSimCallback,
]

ICON_CACHE = {}
BLUEPRINT_CACHE = {}


def fetch_text(url):
    request = urllib.request.Request(url, headers={"User-Agent": "faftracker-replay-tool/0.1"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return response.read().decode("utf8", errors="ignore")


def fetch_bytes(url):
    request = urllib.request.Request(url, headers={"User-Agent": "faftracker-replay-tool/0.1"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return response.read()


def strategic_icon_data_url(blueprint):
    metadata = blueprint_metadata(blueprint)
    icon_name = metadata.get("strategicIcon")
    if not icon_name:
        return None
    value = str(blueprint or "").lower()
    if value in ICON_CACHE:
        return ICON_CACHE[value]

    ICON_CACHE[value] = None
    try:
        icon_url = (
            "https://raw.githubusercontent.com/FAForever/fa/deploy/fafdevelop/"
            f"textures/ui/common/game/strategicicons/{icon_name}_rest.dds"
        )
        from PIL import Image

        icon_bytes = fetch_bytes(icon_url)
        image = Image.open(io.BytesIO(icon_bytes)).convert("RGBA")
        image = image.resize((32, 32), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="PNG")
        ICON_CACHE[value] = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")
        return ICON_CACHE[value]
    except Exception:
        return None


def clean_loc(value):
    text = str(value or "")
    return re.sub(r"^<LOC [^>]+>", "", text).strip() or text


def blueprint_metadata(blueprint):
    value = str(blueprint or "").lower()
    if not value:
        return {}
    if value in BLUEPRINT_CACHE:
        return BLUEPRINT_CACHE[value]

    metadata = {
        "unitName": value.upper(),
        "strategicIcon": None,
        "categories": [],
    }
    BLUEPRINT_CACHE[value] = metadata
    unit_id = value.upper()
    try:
        bp_url = f"https://raw.githubusercontent.com/FAForever/fa/deploy/fafdevelop/units/{unit_id}/{unit_id}_unit.bp"
        bp_text = fetch_text(bp_url)
        icon_match = re.search(r"StrategicIconName\s*=\s*['\"]([^'\"]+)['\"]", bp_text)
        if icon_match:
            metadata["strategicIcon"] = icon_match.group(1)

        name_match = re.search(r"UnitName\s*=\s*['\"]([^'\"]+)['\"]", bp_text)
        if name_match:
            metadata["unitName"] = clean_loc(name_match.group(1))

        categories_match = re.search(r"Categories\s*=\s*\{(?P<body>.*?)\}", bp_text, flags=re.S)
        if categories_match:
            metadata["categories"] = [
                item.upper()
                for item in re.findall(r"['\"]([^'\"]+)['\"]", categories_match.group("body"))
            ]
    except Exception:
        pass
    return metadata


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
    tech_index = 3 if blueprint_kind(value) == "structure" else 4
    if len(value) <= tech_index:
        return None
    if value[tech_index] == "2":
        return "t2"
    if value[tech_index] == "3":
        return "t3"
    if value[tech_index] == "4":
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
    metadata = blueprint_metadata(value)
    tech = blueprint_tech(value)
    kind = blueprint_kind(value)
    if not value:
        return "Unknown"
    unit_name = metadata.get("unitName")
    if unit_name and unit_name.lower() != value:
        return unit_name
    if kind == "structure" and tech in ("t2", "t3"):
        return f"{tech.upper()} structure"
    if tech:
        return f"{tech.upper()} {kind}"
    return kind.title()


def blueprint_event(command, tick):
    blueprint = command.get("blueprint") or ""
    metadata = blueprint_metadata(blueprint)
    return {
        "tick": tick,
        "second": tick / 10,
        "blueprint": blueprint,
        "label": blueprint_label(blueprint),
        "kind": blueprint_kind(blueprint),
        "categories": metadata.get("categories", []),
        "iconDataUrl": strategic_icon_data_url(blueprint),
        "source": command.get("name"),
    }


def decode_bytes(value):
    if isinstance(value, bytes):
        return value.decode("utf8", errors="ignore")
    if isinstance(value, dict):
        return {decode_bytes(key): decode_bytes(item) for key, item in value.items()}
    if isinstance(value, list):
        return [decode_bytes(item) for item in value]
    return value


def tech_source_label(source):
    value = str(source or "").lower()
    tech_match = re.search(r"tech([234])", value)
    tech = f"T{tech_match.group(1)}" if tech_match else "Tech"
    if "land" in value:
        branch = "Land"
    elif "air" in value:
        branch = "Air"
    elif "naval" in value or "sea" in value:
        branch = "Navy"
    elif "structure" in value:
        branch = "Structure"
    else:
        branch = "HQ"
    return f"{tech} {branch} HQ completed"


def tech_source_key(source):
    value = str(source or "").lower()
    tech_match = re.search(r"tech([234])", value)
    branch = "unknown"
    for candidate in ("land", "air", "naval", "structure"):
        if candidate in value:
            branch = candidate
            break
    return f"{tech_match.group(1) if tech_match else 'x'}:{branch}"


def callback_milestone(command, tick):
    args = decode_bytes(command.get("args") or {})
    msg = args.get("Msg") if isinstance(args, dict) else {}
    data = msg.get("data") if isinstance(msg, dict) else {}
    sender = args.get("Sender") if isinstance(args, dict) else None
    trigger = str(data.get("trigger") or "").lower() if isinstance(data, dict) else ""
    category = str(data.get("category") or "").lower() if isinstance(data, dict) else ""
    source = str(data.get("source") or "").lower() if isinstance(data, dict) else ""
    text = str(msg.get("text") or "") if isinstance(msg, dict) else ""

    if category == "tech" and trigger == "completed":
        return {
            "playerName": sender,
            "key": tech_source_key(source),
            "type": "tech",
            "tick": tick,
            "second": tick / 10,
            "label": tech_source_label(source),
            "detail": text or tech_source_label(source),
            "iconText": "HQ",
        }

    if trigger == "completed" and ("enhancement" in source or "upgrade" in source or "upgrade" in text.lower()):
        return {
            "playerName": sender,
            "key": f"acu:{source or text.lower()}",
            "type": "acu",
            "tick": tick,
            "second": tick / 10,
            "label": "ACU upgrade completed",
            "detail": text or source,
            "iconText": "ACU",
        }
    return None


def is_major_blueprint(event):
    categories = set(event.get("categories") or [])
    label = str(event.get("label") or "").lower()
    blueprint = str(event.get("blueprint") or "").lower()
    return (
        "EXPERIMENTAL" in categories
        or blueprint_tech(blueprint) == "experimental"
        or "NUKE" in categories
        or "SILO" in categories
        or "STRATEGIC" in categories
        or "experimental" in label
        or "nuke" in label
    )


def major_order_event(command, tick):
    event = blueprint_event(command, tick)
    if not event.get("blueprint") or not is_major_blueprint(event):
        return None
    event.update({
        "key": f"major:{event['blueprint'].lower()}",
        "type": "major-order",
        "detail": "Major build order seen",
    })
    return event


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
        "milestones": [],
        "milestoneKeys": set(),
        "details": [],
        "detailKeys": set(),
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
            if source_id < len(source_players):
                player_name = source_players[source_id]
                source_status[player_name] = {
                    "type": "left",
                    "tick": tick,
                    "second": tick / 10,
                    "detail": "Player connection ended",
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
        if name == "LuaSimCallback":
            milestone = callback_milestone(command, tick)
            if milestone and milestone.get("playerName") in source_players:
                player = stats[milestone["playerName"]]
                key = milestone.get("key")
                if key not in player["milestoneKeys"]:
                    player["milestoneKeys"].add(key)
                    player["milestones"].append(milestone)
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

        blueprint = command.get("blueprint")
        tech = blueprint_tech(blueprint)
        kind = blueprint_kind(blueprint)
        blueprint_key = str(blueprint or "").lower()
        if blueprint_key and blueprint_key not in player["detailKeys"]:
            detail = blueprint_event(command, tick)
            detail.update({
                "key": f"detail:{blueprint_key}",
                "type": "first-order",
                "detail": "First build order seen",
            })
            player["detailKeys"].add(blueprint_key)
            player["details"].append(detail)

        major_order = major_order_event(command, tick) if blueprint_key else None
        if major_order and major_order["key"] not in player["milestoneKeys"]:
            player["milestoneKeys"].add(major_order["key"])
            player["milestones"].append(major_order)

        if tech and command.get("type") == 7 and kind != "structure" and tech not in player["firstUnits"]:
            player["firstUnits"][tech] = blueprint_event(command, tick)
        elif tech and (kind == "structure" or tech == "experimental") and tech not in player["tech"]:
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
            "milestones": sorted(player["milestones"], key=lambda event: event.get("second") or 0),
            "details": sorted(player["details"], key=lambda event: event.get("second") or 0)[:80],
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
