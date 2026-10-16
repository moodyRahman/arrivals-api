// Shared drawing canvas: anyone can paint on it, everyone sees the same picture.
//
//   GET  /api/canvas  -> row-major RRGGBB hex (same format as /api/pixels)
//   POST /api/canvas  -> { pixels: [{ x, y, color: "#rrggbb" }, ...] }
//   GET  /drawer      -> the drawing page
//
// The canvas lives in memory only, so it resets when the server restarts.
import express from "express";

export const DRAW_WIDTH = 32;
export const DRAW_HEIGHT = 16;

const MAX_PIXELS_PER_POST = 2048;
const COLOR_RE = /^#?([0-9a-f]{6})$/i;

// RGB bytes, row-major; starts black
const pixels = Buffer.alloc(DRAW_WIDTH * DRAW_HEIGHT * 3);

export const drawRouter = express.Router();

drawRouter.get("/api/canvas", (req, res) => {
  res
    .set({ "X-Width": DRAW_WIDTH, "X-Height": DRAW_HEIGHT, "Access-Control-Expose-Headers": "X-Width, X-Height" })
    .type("text/plain")
    .send(pixels.toString("hex"));
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
