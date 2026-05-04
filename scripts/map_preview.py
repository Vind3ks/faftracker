import base64
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import zipfile

from PIL import Image


def fetch_map_zip(map_name):
    quoted = urllib.parse.quote(map_name)
    url = f"https://content.faforever.com/maps/{quoted}.zip"
    request = urllib.request.Request(url, headers={"User-Agent": "faftracker-replay-tool/0.1"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read()


def parse_size(text):
    match = re.search(r"size\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}", text, re.IGNORECASE)
    if not match:
        return None
    return {
        "x": int(match.group(1)),
        "z": int(match.group(2)),
    }


def read_preview(map_name):
    data = fetch_map_zip(map_name)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        image_name = next((name for name in names if name.lower().endswith(".png")), None)
        scmap_name = next((name for name in names if name.lower().endswith(".scmap")), None)
        scenario_name = next((name for name in names if name.lower().endswith("_scenario.lua")), None)
        if not image_name:
            raise RuntimeError("Map zip does not contain a PNG preview.")

        image = archive.read(image_name)
        image_source = image_name
        scmap_note = None
        if scmap_name:
            try:
                scmap = archive.read(scmap_name)
                dds_offset = scmap.find(b"DDS ")
                if dds_offset >= 0:
                    dds_image = Image.open(io.BytesIO(scmap[dds_offset:])).convert("RGBA")
                    dds_image = dds_image.resize((1024, 1024), Image.Resampling.LANCZOS)
                    output = io.BytesIO()
                    dds_image.save(output, format="PNG")
                    image = output.getvalue()
                    image_source = f"{scmap_name} embedded DDS"
            except Exception as error:
                scmap_note = str(error)
        size = None
        if scenario_name:
            try:
                size = parse_size(archive.read(scenario_name).decode("utf8", errors="ignore"))
            except Exception:
                size = None

        return {
            "map": map_name,
            "imageName": image_source,
            "dataUrl": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
            "size": size,
            "note": scmap_note,
        }


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(read_preview(str(payload.get("map") or "").strip()), separators=(",", ":")))


if __name__ == "__main__":
    main()
