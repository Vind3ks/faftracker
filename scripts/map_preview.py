import base64
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import zipfile

from PIL import Image, ImageFilter


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


def upscale_preview(image):
    target_size = 2048
    resampling = Image.Resampling.LANCZOS
    upscaled = image.convert("RGBA").resize((target_size, target_size), resampling)
    return upscaled.filter(ImageFilter.UnsharpMask(radius=1.2, percent=80, threshold=3))


def png_bytes(image):
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def read_preview(map_name):
    data = fetch_map_zip(map_name)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        png_names = [name for name in names if name.lower().endswith(".png")]
        scmap_name = next((name for name in names if name.lower().endswith(".scmap")), None)
        scenario_name = next((name for name in names if name.lower().endswith("_scenario.lua")), None)
        candidates = []

        for name in png_names:
            try:
                image = Image.open(io.BytesIO(archive.read(name))).convert("RGBA")
                candidates.append((3, image.width * image.height, name, image))
            except Exception:
                pass

        for name in [name for name in names if name.lower().endswith(".dds")]:
            try:
                image = Image.open(io.BytesIO(archive.read(name))).convert("RGBA")
                candidates.append((2, image.width * image.height, name, image))
            except Exception:
                pass

        if not candidates and not scmap_name:
            raise RuntimeError("Map zip does not contain a supported visual preview.")

        image_source = None
        scmap_note = None
        if scmap_name:
            try:
                scmap = archive.read(scmap_name)
                start = 0
                index = 0
                while True:
                    dds_offset = scmap.find(b"DDS ", start)
                    if dds_offset < 0:
                        break
                    try:
                        dds_image = Image.open(io.BytesIO(scmap[dds_offset:])).convert("RGBA")
                        source_name = f"{scmap_name} embedded DDS {index}"
                        candidates.append((1, dds_image.width * dds_image.height, source_name, dds_image))
                    except Exception:
                        pass
                    index += 1
                    start = dds_offset + 1
            except Exception as error:
                scmap_note = str(error)

        if not candidates:
            raise RuntimeError(scmap_note or "Map zip does not contain a supported visual preview.")

        _, _, image_source, source_image = max(candidates, key=lambda row: (row[0], row[1], "large" in row[2].lower()))
        image = png_bytes(upscale_preview(source_image))
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
