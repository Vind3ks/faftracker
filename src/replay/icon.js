"use strict";

// Resolves a blueprint id to a small unit icon PNG.
//
// The ETFreeman unit DB names a `StrategicIconName` per unit; the matching image
// lives in the FA game repo as a tiny DXT5 .dds. Browsers can't render .dds, so
// we decode it to RGBA and encode a PNG (no native deps), caching per icon name.

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { ensureUnitDb, getUnit } = require("./unit-db");

const ICON_BASE = "https://raw.githubusercontent.com/FAForever/fa/deploy/fafdevelop/textures/ui/common/game/strategicicons/";
const CACHE_ROOT = process.env.FAF_TRACKER_CACHE_DIR
  ? path.dirname(process.env.FAF_TRACKER_CACHE_DIR)
  : path.join(process.env.APPDATA || os.homedir(), "FAF Tracker");
const ICON_DIR = path.join(CACHE_ROOT, "unit-icons");

const inflight = new Map(); // iconName -> Promise<Buffer|null>

// ---- DXT5 decode ----------------------------------------------------------

function rgb565(c, out) {
  const r = (c >> 11) & 0x1f;
  const g = (c >> 5) & 0x3f;
  const b = c & 0x1f;
  out[0] = (r << 3) | (r >> 2);
  out[1] = (g << 2) | (g >> 4);
  out[2] = (b << 3) | (b >> 2);
}

function ddsDxt5ToRgba(dds) {
  if (dds.toString("ascii", 0, 3) !== "DDS") throw new Error("Not a DDS file.");
  const height = dds.readUInt32LE(12);
  const width = dds.readUInt32LE(16);
  const fourcc = dds.toString("ascii", 84, 88);
  if (fourcc !== "DXT5") throw new Error(`Unsupported DDS format ${fourcc}.`);

  const rgba = Buffer.alloc(width * height * 4);
  const alpha = new Array(8);
  const c0 = [0, 0, 0];
  const c1 = [0, 0, 0];
  const colors = [c0, c1, [0, 0, 0], [0, 0, 0]];

  let p = 128; // DDS header is 128 bytes
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const a0 = dds[p];
      const a1 = dds[p + 1];
      alpha[0] = a0;
      alpha[1] = a1;
      if (a0 > a1) {
        for (let i = 1; i < 7; i++) alpha[i + 1] = Math.round(((7 - i) * a0 + i * a1) / 7);
      } else {
        for (let i = 1; i < 5; i++) alpha[i + 1] = Math.round(((5 - i) * a0 + i * a1) / 5);
        alpha[6] = 0;
        alpha[7] = 255;
      }
      const alphaBase = p + 2;

      const col0 = dds.readUInt16LE(p + 8);
      const col1 = dds.readUInt16LE(p + 10);
      rgb565(col0, c0);
      rgb565(col1, c1);
      for (let k = 0; k < 3; k++) {
        colors[2][k] = Math.round((2 * c0[k] + c1[k]) / 3);
        colors[3][k] = Math.round((c0[k] + 2 * c1[k]) / 3);
      }
      const colorBits = dds.readUInt32LE(p + 12);

      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i % 4);
        const py = by * 4 + (i >> 2);
        if (px >= width || py >= height) continue;
        const cIdx = (colorBits >> (2 * i)) & 3;
        const bit = i * 3;
        const aIdx = ((dds[alphaBase + (bit >> 3)] | (dds[alphaBase + (bit >> 3) + 1] << 8)) >> (bit & 7)) & 7;
        const o = (py * width + px) * 4;
        rgba[o] = colors[cIdx][0];
        rgba[o + 1] = colors[cIdx][1];
        rgba[o + 2] = colors[cIdx][2];
        rgba[o + 3] = alpha[aIdx];
      }
      p += 16;
    }
  }

  return { width, height, rgba };
}

// ---- PNG encode -----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression, filter, interlace = 0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- public ---------------------------------------------------------------

function cachePathFor(iconName) {
  const safe = iconName.replace(/[^a-z0-9_]+/gi, "_");
  return path.join(ICON_DIR, `${safe}.png`);
}

async function fetchAndConvert(iconName) {
  const response = await fetch(`${ICON_BASE}${iconName}_rest.dds`, { headers: { "User-Agent": "faf-scout/0.2" } });
  if (!response.ok) return null;
  const dds = Buffer.from(await response.arrayBuffer());
  const { width, height, rgba } = ddsDxt5ToRgba(dds);
  return encodePng(width, height, rgba);
}

// Returns a PNG Buffer for the given blueprint id, or null if unavailable.
async function getUnitIconPng(blueprintId) {
  const db = await ensureUnitDb();
  const unit = getUnit(db, blueprintId);
  const iconName = unit && unit.strategicIcon;
  if (!iconName) return null;

  const cachePath = cachePathFor(iconName);
  try {
    return fs.readFileSync(cachePath);
  } catch (error) {
    /* not cached yet */
  }

  if (inflight.has(iconName)) return inflight.get(iconName);

  const job = (async () => {
    const png = await fetchAndConvert(iconName);
    if (png) {
      try {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        fs.writeFileSync(cachePath, png);
      } catch (error) {
        /* best effort */
      }
    }
    return png;
  })().finally(() => inflight.delete(iconName));

  inflight.set(iconName, job);
  return job;
}

module.exports = { getUnitIconPng, ddsDxt5ToRgba, encodePng };
