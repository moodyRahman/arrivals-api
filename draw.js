// Shared drawing canvas: anyone can paint on it, everyone sees the same picture.
//
//   GET  /api/canvas  -> row-major RRGGBB hex (same format as /api/pixels)
//   POST /api/canvas  -> { pixels: [{ x, y, color: "#rrggbb" }, ...] }
//   GET  /drawer      -> the drawing page
//
// The canvas lives in memory only, so it resets when the server restarts.
import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

export const DRAW_WIDTH = 32;
export const DRAW_HEIGHT = 16;

const MAX_PIXELS_PER_POST = 2048;
const COLOR_RE = /^#?([0-9a-f]{6})$/i;

// Snapshots: every SNAPSHOT_INTERVAL_MS the canvas is saved as a PNG if it changed
const SNAPSHOT_DIR = process.env.CANVAS_OUT_DIR ?? "/usr/share/out";
const SNAPSHOT_INTERVAL_MS = 0.5 * 60 * 1000;

// RGB bytes, row-major; starts black
const pixels = Buffer.alloc(DRAW_WIDTH * DRAW_HEIGHT * 3);

// ---- PNG snapshots ----

// Minimal 8-bit RGB PNG encoder (avoids pulling the native canvas library into this module)
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}

function encodePng(rgb, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB

  // each scanline is prefixed with a filter-type byte (0 = none)
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let lastSaved = Buffer.from(pixels); // the blank canvas counts as already saved

// Write the current canvas to SNAPSHOT_DIR as a timestamped PNG.
// Returns { file, png } (the path written and the PNG bytes).
async function writeSnapshot() {
  const snapshot = Buffer.from(pixels); // copy: POSTs can land while the write is in flight
  const png = encodePng(snapshot, DRAW_WIDTH, DRAW_HEIGHT);
  const file = path.join(SNAPSHOT_DIR, `canvas-${new Date().toISOString().replace(/:/g, "-")}.png`);
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(file, png);
  lastSaved = snapshot; // only after a successful write, so a failure retries next time
  return { file, png };
}

// Save the canvas as a PNG if it differs from the last saved one.
// Returns the file path, or null if nothing changed.
export async function saveIfChanged() {
  if (pixels.equals(lastSaved)) return null;
  return (await writeSnapshot()).file;
}

setInterval(async () => {
  try {
    const file = await saveIfChanged();
    if (file) console.log("Saved canvas snapshot", file);
  } catch (err) {
    console.error("Canvas snapshot failed:", err.message);
  }
}, SNAPSHOT_INTERVAL_MS);

export const drawRouter = express.Router();

drawRouter.get("/api/canvas", (req, res) => {
  res
    .set({ "X-Width": DRAW_WIDTH, "X-Height": DRAW_HEIGHT, "Access-Control-Expose-Headers": "X-Width, X-Height" })
    .type("text/plain")
    .send(pixels.toString("hex"));
});

// Render the current canvas to a PNG, store it in SNAPSHOT_DIR, and return it
drawRouter.get("/api/canvas.png", async (req, res) => {
  try {
    const { file, png } = await writeSnapshot();
    console.log("Saved canvas snapshot", file);
    res.set("X-Saved-As", path.basename(file)).type("image/png").send(png);
  } catch (err) {
    console.error("Canvas snapshot failed:", err.message);
    res.status(500).json({ error: `could not save snapshot: ${err.message}` });
  }
});

drawRouter.post("/api/canvas", express.json({ limit: "128kb" }), (req, res) => {
  const updates = req.body?.pixels;
  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: "body must be { pixels: [{ x, y, color }] }" });
  }
  if (updates.length > MAX_PIXELS_PER_POST) {
    return res.status(413).json({ error: `at most ${MAX_PIXELS_PER_POST} pixels per request` });
  }

  // Validate everything first so a bad request changes nothing
  const parsed = [];
  for (const p of updates) {
    const color = typeof p?.color === "string" ? COLOR_RE.exec(p.color) : null;
    if (
      !Number.isInteger(p?.x) || p.x < 0 || p.x >= DRAW_WIDTH ||
      !Number.isInteger(p?.y) || p.y < 0 || p.y >= DRAW_HEIGHT ||
      !color
    ) {
      return res.status(400).json({ error: `invalid pixel: ${JSON.stringify(p)}` });
    }
    parsed.push({ offset: (p.y * DRAW_WIDTH + p.x) * 3, rgb: Buffer.from(color[1], "hex") });
  }

  for (const { offset, rgb } of parsed) rgb.copy(pixels, offset);
  res.json({ updated: parsed.length });
});

drawRouter.get("/drawer", (req, res) => {
  res.sendFile("drawer.html", { root: import.meta.dirname });
});
