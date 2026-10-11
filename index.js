// npm install express   (Node 18+ for built-in fetch)
import express from "express";

const app = express();
const FEED = "https://retro.umoiq.com/service/publicJSONFeed";
const AGENCY = "ttc";
const ROUTE = "505";

const WIDTH = 32;
const HEIGHT = 16;

// juiszArray[y][x] = [r, g, b], initialised to black
const juiszArray = Array.from({ length: HEIGHT }, () =>
  Array.from({ length: WIDTH }, () => [0, 0, 0])
);

// Red horizontal line that moves down one row every 2s and wraps to the top
let lineY = 0;
function drawLine() {
  for (let x = 0; x < WIDTH; x++) {
    juiszArray[lineY][x] = [0, 0, 0];
  }
  lineY = (lineY + 1) % HEIGHT;
  for (let x = 0; x < WIDTH; x++) {
    juiszArray[lineY][x] = [255, 0, 0];
  }
}
for (let x = 0; x < WIDTH; x++) juiszArray[lineY][x] = [255, 0, 0];
setInterval(drawLine, 2000);

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

// Row-major flatten of juiszArray into RRGGBB per pixel
app.get("/api/pixels", (req, res) => {
  const hex = juiszArray
    .flat()
    .map((px) => px.map((c) => c.toString(16).padStart(2, "0")).join(""))
    .join("");
  res.type("text/plain").send(hex);
});

app.listen(3000, "0.0.0.0", () => console.log("Listening to all ips http://localhost:3000"));

