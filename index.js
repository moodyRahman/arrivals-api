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

// Red horizontal line that moves down one row every 500ms and wraps to the top
// let lineY = 0;
// function draw() {
//   ctx.fillStyle = "black";
//   ctx.fillRect(0, 0, WIDTH, HEIGHT);
//   ctx.fillStyle = "red";
//   ctx.fillRect(0, lineY, WIDTH, 1);
//   lineY = (lineY + 1) % HEIGHT;
// }
// draw();
// setInterval(draw, 500);

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
animate();
setInterval(animate, 500);

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

app.get("/api/505/westbound/church", async (req, res) => {
  try {
    const stop = await getWestboundChurchStop();
    const data = await feed({ command: "predictions", r: ROUTE, s: stop.tag });

    const predictions = asArray(data.predictions)
      .flatMap((p) => asArray(p.direction))
      .flatMap((d) => asArray(d.prediction))
      .map((p) => ({
        minutes: Number(p.minutes),
        seconds: Number(p.seconds),
        arrivalTime: new Date(Number(p.epochTime)).toISOString(),
        vehicle: p.vehicle,
      }))
      .sort((a, b) => a.seconds - b.seconds);

    res.json({
      route: ROUTE,
      direction: "westbound",
      stop: stop.title,
      generatedAt: new Date().toISOString(),
      arrivals: predictions.slice(0, 5),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Row-major RRGGBB per pixel, read from the canvas (RGBA bytes, alpha dropped)
app.get("/api/pixels", (req, res) => {
  const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  let hex = "";
  for (let i = 0; i < data.length; i += 4) {
    hex += [data[i], data[i + 1], data[i + 2]]
      .map((c) => c.toString(16).padStart(2, "0"))
      .join("");
  }
  res.type("text/plain").send(hex);
});

app.listen(3000, "0.0.0.0", () => console.log("Listening to all ips http://localhost:3000"));

