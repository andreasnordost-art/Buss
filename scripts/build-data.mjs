// Bygger kartans data från Din Turs GTFS-fil.
//
//   TRAFIKLAB_STATIC_KEY=... node scripts/build-data.mjs
//   node scripts/build-data.mjs --zip path/till/dintur.zip
//   node scripts/build-data.mjs --dir test/fixture   (uppackad GTFS, för test)
//
// Skriver public/data/network.json (hållplatser och linjeformer) och
// public/data/days/ÅÅÅÅ-MM-DD.json (dagens turer med tider).

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import * as cfg from "../config.mjs";
import { eachRow, parseTime, inBox, simplify, dedupe } from "./lib/gtfs.mjs";

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const zipArg = arg("--zip");
const dirArg = arg("--dir");
const outDir = arg("--out") || "public/data";
const startArg = arg("--start"); // ÅÅÅÅ-MM-DD, annars i dag

const zip = dirArg
  ? Object.fromEntries(readdirSync(dirArg).map((f) => [f, new Uint8Array(readFileSync(`${dirArg}/${f}`))]))
  : unzipSync(await loadZip());
const file = (name) => (zip[name] ? strFromU8(zip[name]) : "");

// --- Hållplatser -----------------------------------------------------------
const stopById = new Map();
eachRow(file("stops.txt"), (r) => {
  const lat = Number(r.stop_lat), lon = Number(r.stop_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  stopById.set(r.stop_id, { id: r.stop_id, name: r.stop_name.trim(), lat, lon, parent: r.parent_station || "" });
});
const inMunicipality = (s) => inBox([s.lon, s.lat], cfg.MUNICIPALITY_BBOX);

// --- Linjer och turer ------------------------------------------------------
const routeById = new Map();
eachRow(file("routes.txt"), (r) => routeById.set(r.route_id, r));

const tripById = new Map();
eachRow(file("trips.txt"), (r) => tripById.set(r.trip_id, r));

// --- Stopptider: första varvet räknar hur stor del av varje tur som går i kommunen.
const stopTimesText = file("stop_times.txt");
const share = new Map(); // trip_id -> [i kommunen, totalt]
eachRow(stopTimesText, (r) => {
  const s = stopById.get(r.stop_id);
  if (!s) return;
  let c = share.get(r.trip_id);
  if (!c) share.set(r.trip_id, (c = [0, 0]));
  if (inMunicipality(s)) c[0]++;
  c[1]++;
});
const keptTrips = new Set();
for (const [id, [inside, total]] of share) {
  if (inside / total >= cfg.MIN_SHARE_IN_MUNICIPALITY && tripById.has(id)) keptTrips.add(id);
}

// Andra varvet sparar stopptiderna för turerna vi behåller.
const tripStops = new Map(); // trip_id -> [{seq, stop, time}]
eachRow(stopTimesText, (r) => {
  if (!keptTrips.has(r.trip_id)) return;
  let list = tripStops.get(r.trip_id);
  if (!list) tripStops.set(r.trip_id, (list = []));
  // Sortera på nummer, inte text: "10" ska komma efter "9".
  list.push({ seq: Number(r.stop_sequence), stop: r.stop_id, time: parseTime(r.departure_time || r.arrival_time) });
});
for (const list of tripStops.values()) list.sort((a, b) => a.seq - b.seq);
// Interpolera tider som saknas mellan tidpunkter.
for (const list of tripStops.values()) fillTimes(list);

// --- Linjeformer -----------------------------------------------------------
const neededShapes = new Set();
for (const id of keptTrips) if (tripById.get(id).shape_id) neededShapes.add(tripById.get(id).shape_id);
const shapePoints = new Map(); // shape_id -> [[seq, lon, lat]]
eachRow(file("shapes.txt"), (r) => {
  if (!neededShapes.has(r.shape_id)) return;
  let list = shapePoints.get(r.shape_id);
  if (!list) shapePoints.set(r.shape_id, (list = []));
  list.push([Number(r.shape_pt_sequence), Number(r.shape_pt_lon), Number(r.shape_pt_lat)]);
});

// Varje unik form per linje blir en "variant". Turer utan shape_id får en
// form av sina hållplatser i ordning.
const routes = new Map(); // route_id -> { route, variants: Map(key -> variant) }
const tripVariant = new Map(); // trip_id -> variant
for (const tripId of keptTrips) {
  const trip = tripById.get(tripId);
  const stops = tripStops.get(tripId);
  if (!stops || stops.length < 2) continue;
  const route = routeById.get(trip.route_id);
  if (!route) continue;
  let entry = routes.get(route.route_id);
  if (!entry) routes.set(route.route_id, (entry = { route, variants: new Map() }));
  // Saknas direction_id räknas riktningen ut i efterhand (se inferDirections).
  const dir = trip.direction_id === "1" ? 1 : trip.direction_id === "0" ? 0 : null;
  const hasShape = trip.shape_id && shapePoints.has(trip.shape_id);
  const key = hasShape ? `s:${trip.shape_id}` : `p:${dir}:${stops.map((s) => s.stop).join(">")}`;
  let v = entry.variants.get(key);
  if (!v) {
    v = { key, dir, headsign: trip.trip_headsign || "", trips: 0, fromShape: hasShape, stops: stops.map((s) => s.stop), shapeId: trip.shape_id };
    entry.variants.set(key, v);
  }
  v.trips++;
  tripVariant.set(tripId, v);
}

inferDirections();

// --- Index och utdata --------------------------------------------------------
const usedStops = new Set();
for (const list of tripStops.values()) for (const s of list) usedStops.add(s.stop);
const stopList = [...usedStops].map((id) => stopById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, "sv"));
const stopIndex = new Map(stopList.map((s, i) => [s.id, i]));

const routeList = [...routes.values()].sort((a, b) => routeSort(a.route, b.route));
const variantIndex = new Map(); // variant -> [routeIdx, variantIdx]
const networkRoutes = routeList.map(({ route, variants }, ri) => {
  const vs = [...variants.values()].sort((a, b) => b.trips - a.trips);
  // Huvudformen per riktning: den som täcker mest av linjen, vägd med antal turer,
  // så att en kort förstärkningstur inte blir linjens ansikte utåt.
  const mainByDir = new Map();
  for (const v of vs) {
    const best = mainByDir.get(v.dir);
    if (!best || v.trips * v.stops.length > best.trips * best.stops.length) mainByDir.set(v.dir, v);
  }
  const allStops = vs.flatMap((v) => v.stops.map((id) => stopById.get(id)));
  const kind = cfg.KIND_OVERRIDES[route.route_short_name] ??
    (allStops.every((s) => inBox([s.lon, s.lat], cfg.TOWN_BBOX)) ? "tatort" : "landsbygd");
  return {
    id: route.route_id,
    name: route.route_short_name || route.route_long_name,
    long: route.route_long_name || "",
    color: route.route_color ? `#${route.route_color}` : null,
    kind,
    variants: vs.map((v, vi) => {
      variantIndex.set(v, [ri, vi]);
      return {
        dir: v.dir,
        headsign: v.headsign,
        trips: v.trips,
        main: mainByDir.get(v.dir) === v,
        path: variantPath(v),
        stops: v.stops.map((id) => stopIndex.get(id)),
      };
    }),
  };
});

rmSync(outDir, { recursive: true, force: true });
mkdirSync(`${outDir}/days`, { recursive: true });
const network = {
  generated: new Date().toISOString(),
  stops: stopList.map((s) => [s.id, s.name, round(s.lat), round(s.lon)]),
  routes: networkRoutes,
};
writeFileSync(`${outDir}/network.json`, JSON.stringify(network));

// Turer per dag.
const services = serviceCalendar();
const dates = upcomingDates(cfg.DAYS_AHEAD);
for (const date of dates) {
  const trips = [];
  for (const [tripId, v] of tripVariant) {
    const trip = tripById.get(tripId);
    if (!services(trip.service_id, date)) continue;
    const [ri, vi] = variantIndex.get(v);
    const stops = tripStops.get(tripId);
    trips.push([tripId, ri, vi, trip.trip_headsign || v.headsign, stops.map((s) => stopIndex.get(s.stop)), stops.map((s) => s.time)]);
  }
  trips.sort((a, b) => a[5][0] - b[5][0]);
  writeFileSync(`${outDir}/days/${date}.json`, JSON.stringify({ date, trips }));
  console.log(`${date}: ${trips.length} turer`);
}
writeFileSync(`${outDir}/days/index.json`, JSON.stringify(dates));
console.log(`${networkRoutes.length} linjer, ${stopList.length} hållplatser`);

// ---------------------------------------------------------------------------

async function loadZip() {
  if (zipArg) return new Uint8Array(readFileSync(zipArg));
  const key = process.env.TRAFIKLAB_STATIC_KEY;
  if (!key) throw new Error("Ange --zip eller miljövariabeln TRAFIKLAB_STATIC_KEY.");
  const url = `https://opendata.samtrafiken.se/gtfs/${cfg.OPERATOR}/${cfg.OPERATOR}.zip?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`Kunde inte hämta GTFS (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function variantPath(v) {
  let pts;
  if (v.fromShape) {
    pts = shapePoints.get(v.shapeId).slice().sort((a, b) => a[0] - b[0]).map(([, lon, lat]) => [lon, lat]);
  } else {
    pts = v.stops.map((id) => stopById.get(id)).map((s) => [s.lon, s.lat]);
  }
  return simplify(dedupe(pts), cfg.SIMPLIFY_METERS).map(([lon, lat]) => [round(lon), round(lat)]);
}

// Vissa flöden (t.ex. GTFS Sverige 2) saknar direction_id. Då jämförs varje
// variants färdriktning (första till sista hållplatsen) med linjens vanligaste variant.
function inferDirections() {
  for (const { variants } of routes.values()) {
    const vs = [...variants.values()].filter((v) => v.dir == null).sort((a, b) => b.trips - a.trips);
    if (!vs.length) continue;
    const vec = (v) => {
      const a = stopById.get(v.stops[0]), b = stopById.get(v.stops[v.stops.length - 1]);
      return [b.lon - a.lon, b.lat - a.lat];
    };
    const ref = vec(vs[0]);
    for (const v of vs) {
      const d = vec(v);
      v.dir = d[0] * ref[0] + d[1] * ref[1] < 0 ? 1 : 0;
    }
  }
}

function fillTimes(list) {
  let last = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].time == null) continue;
    if (last >= 0 && i - last > 1) {
      const a = list[last].time, b = list[i].time;
      for (let j = last + 1; j < i; j++) list[j].time = Math.round(a + ((b - a) * (j - last)) / (i - last));
    }
    last = i;
  }
}

function serviceCalendar() {
  const weekly = new Map();
  eachRow(file("calendar.txt"), (r) => weekly.set(r.service_id, r));
  const exceptions = new Map(); // "service|date" -> 1 (läggs till) / 2 (tas bort)
  eachRow(file("calendar_dates.txt"), (r) => exceptions.set(`${r.service_id}|${r.date.replace(/-/g, "")}`, r.exception_type));
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return (serviceId, isoDate) => {
    const d = isoDate.replace(/-/g, "");
    const ex = exceptions.get(`${serviceId}|${d}`);
    if (ex === "1") return true;
    if (ex === "2") return false;
    const w = weekly.get(serviceId);
    if (!w || d < w.start_date || d > w.end_date) return false;
    const weekday = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
    return w[days[weekday]] === "1";
  };
}

function upcomingDates(n) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: cfg.TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  const out = [];
  // Börja med gårdagen så att turer efter midnatt (tider över 24:00) finns kvar.
  const base = startArg ? Date.parse(`${startArg}T12:00:00Z`) : Date.now();
  for (let i = -1; i < n; i++) out.push(fmt.format(new Date(base + i * 864e5)));
  return out;
}

function routeSort(a, b) {
  const na = parseInt(a.route_short_name, 10), nb = parseInt(b.route_short_name, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return (a.route_short_name || "").localeCompare(b.route_short_name || "", "sv");
}

function round(x) {
  return Math.round(x * 1e5) / 1e5;
}
