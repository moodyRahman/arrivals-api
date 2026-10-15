// npm install express   (Node 18+ for built-in fetch)
import express from "express";
import { createCanvas } from "@napi-rs/canvas";

const app = express();
const FEED = "https://retro.umoiq.com/service/publicJSONFeed";
const AGENCY = "ttc";
const ROUTE = "505";

const WIDTH = 32;
const HEIGHT = 16;

const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext("2d");

/*
// Smiley face (16x16, centred on the canvas) that blinks and grins in a loop.
// Everything is drawn with 1px fillRects so there is no antialiasing.
const FACE = 16;
const FACE_X = (WIDTH - FACE) / 2;

function px(x, y, w = 1, h = 1) {
  ctx.fillRect(FACE_X + x, y, w, h);
}

function drawSmiley(frame) {
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // head: filled circle
  ctx.fillStyle = "yellow";
  const c = (FACE - 1) / 2;
  for (let y = 0; y < FACE; y++) {
    for (let x = 0; x < FACE; x++) {
      if (Math.hypot(x - c, y - c) <= FACE / 2 - 0.25) px(x, y);
    }
  }

  ctx.fillStyle = "black";

  // eyes
  if (frame === "blink") {
    px(4, 6, 2, 1);
    px(10, 6, 2, 1);
  } else {
    px(4, 4, 2, 3);
    px(10, 4, 2, 3);
  }

  // mouth
  if (frame === "grin") {
    px(4, 10, 8, 1);
    px(5, 11, 6, 2);
    px(6, 13, 4, 1);
  } else {
    px(3, 10, 1, 1);
    px(12, 10, 1, 1);
    px(4, 11, 1, 1);
    px(11, 11, 1, 1);
    px(5, 12, 6, 1);
  }
}

const FRAMES = ["open", "open", "open", "blink", "open", "grin", "grin", "open"];
let frameIndex = 0;
function animate() {
  drawSmiley(FRAMES[frameIndex]);
  frameIndex = (frameIndex + 1) % FRAMES.length;
}
// animate();
setInterval(animate, 500);
*/

// Tiny 3x5 digit font; each glyph is 5 rows of 3 bits.
const DIGITS = {
  0: [7, 5, 5, 5, 7],
  1: [2, 6, 2, 2, 7],
  2: [7, 1, 7, 4, 7],
  3: [7, 1, 7, 1, 7],
  4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7],
  6: [7, 4, 7, 5, 7],
  7: [7, 1, 1, 1, 1],
  8: [7, 5, 7, 5, 7],
  9: [7, 5, 7, 1, 7],
  W: [5, 5, 5, 7, 5],
  " ": [0, 0, 0, 0, 0],
};

function drawText(text, x, y) {
  for (const ch of text) {
    DIGITS[ch].forEach((bits, row) => {
      for (let col = 0; col < 3; col++) {
        if (bits & (4 >> col)) ctx.fillRect(x + col, y + row, 1, 1);
      }
    });
    x += 4;
  }
}

// "505 W" in white across the top
function drawLogo() {
  ctx.fillStyle = "white";

  const text = "505 W";
  drawText(text, Math.floor((WIDTH - (text.length * 4 - 1)) / 2), 2);
}

const SECOND_SHIFT = 9;

// Draw the logo up top and up to 4 arrival times (minutes) in a single row along the bottom, one per 8px cell.
function drawArrivals(arrivals) {
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  drawLogo();
  ctx.fillStyle = "yellow";

  const cellW = WIDTH / 4;
  arrivals.slice(0, 4).forEach((a, i) => {
    const text = String(Math.min(a.minutes, 99));    const textW = text.length * 4 - 1;
    const centred = i * cellW + Math.floor((cellW - textW) / 2);
    // second arrival is right-justified to its cell, nudged SECOND_SHIFT px further right
    const x = i === 1 ? (i + 1) * cellW - textW + SECOND_SHIFT : centred;
    drawText(text, x, HEIGHT - 5);
  });
}

let cachedStop = null; // { tag, title }

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

async function feed(params) {
  const url = `${FEED}?${new URLSearchParams({ a: AGENCY, ...params })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Feed responded ${res.status}`);
  const data = await res.json();
  if (data.Error) throw new Error(data.Error.content || "Feed error");
  return data;
}

// Find the westbound stop at Church St from the route config (cached after first lookup)
async function getWestboundChurchStop() {
  if (cachedStop) return cachedStop;

  const { route } = await feed({ command: "routeConfig", r: ROUTE });

  const westDirs = asArray(route.direction).filter(
    (d) => /west/i.test(d.name) || /^west/i.test(d.title)
  );
  const westStopTags = new Set(
    westDirs.flatMap((d) => asArray(d.stop).map((s) => s.tag))
  );

  const stop = asArray(route.stop).find(
    (s) => westStopTags.has(s.tag) && /church/i.test(s.title)
  );
  if (!stop) throw new Error("Could not find westbound Church St stop");

  cachedStop = { tag: stop.tag, title: stop.title };
  return cachedStop;
}

async function getArrivals() {
  const stop = await getWestboundChurchStop();
  const data = await feed({ command: "predictions", r: ROUTE, s: stop.tag });

  const arrivals = asArray(data.predictions)
    .flatMap((p) => asArray(p.direction))
    .flatMap((d) => asArray(d.prediction))
    .map((p) => ({
      minutes: Number(p.minutes),
      seconds: Number(p.seconds),
      arrivalTime: new Date(Number(p.epochTime)).toISOString(),
      vehicle: p.vehicle,
    }))
    .sort((a, b) => a.seconds - b.seconds);

  return { stop, arrivals: arrivals.slice(0, 5) };
}

// Latest good fetch: { stop, arrivals, fetchedAt }. Refreshed once a minute;
// on failure the previous value is kept.
let cache = null;

async function refreshCache() {
  console.log("refreshing")
  try {
    const { stop, arrivals } = await getArrivals();
    cache = { stop, arrivals, fetchedAt: new Date() };
  } catch (err) {
    console.error("Cache refresh failed:", err.message);
  }
}
const cacheReady = refreshCache();
setInterval(refreshCache, 60 * 1000);

// Whole minutes until arrival, counted down live from the predicted arrival time
const minutesUntil = (a) => Math.max(0, Math.floor((Date.parse(a.arrivalTime) - Date.now()) / 60000));

app.get("/api/505/westbound/church", async (req, res) => {
  await cacheReady;
  if (!cache) return res.status(502).json({ error: "No arrival data available yet" });

  res.json({
    route: ROUTE,
    direction: "westbound",
    stop: cache.stop.title,
    generatedAt: cache.fetchedAt.toISOString(),
    arrivals: cache.arrivals,
  });
});

// Row-major RRGGBB per pixel, drawn from the cached arrivals on each request
// (RGBA bytes read from the canvas, alpha dropped)
app.get("/api/pixels", async (req, res) => {
  await cacheReady;
  if (!cache) return res.status(502).type("text/plain").send("No arrival data available yet");

  const upcoming = cache.arrivals
    .filter((a) => Date.parse(a.arrivalTime) > Date.now())
    .map((a) => ({ ...a, minutes: minutesUntil(a) }));
  drawArrivals(upcoming.slice(0, 2));

  const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  let hex = "";
  for (let i = 0; i < data.length; i += 4) {
    hex += [data[i], data[i + 1], data[i + 2]]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("");
  }
  res.type("text/plain").send(hex);
});

// Browser view of the pixel panel
app.get("/draw", (req, res) => {
  console.log("serving html")
  res.sendFile("draw.html", { root: import.meta.dirname });
});

app.listen(3000, "0.0.0.0", () => console.log("Listening to all ips http://localhost:3000"));

