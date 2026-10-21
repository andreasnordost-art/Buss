// Gör om svaren från Busskollens API (originalsidan) till samma network.json som
// GTFS-bygget skapar, så att kartan och linjenätskartan kan rita linjerna.
//
// Indata:
//   stops     /api/stops                          { stops, routes }
//   scopes    [{ kind, geometry }]                /api/network-geometry (+ ?scope=rural)
//
// Körvägarna i originalet är vägmatchade sträcka för sträcka mellan hållplatser.
// Varje variant (en representativ tur) blir en variant här, med hållplatsordning
// från sträckorna och form från hela variantens körväg.

import { simplify, dedupe } from "./gtfs.mjs";

export function networkFromOriginal({ stops, scopes }, cfg) {
  const stopById = new Map(stops.stops.map((s) => [s.id, s]));
  const routeIdByLine = new Map(stops.routes.map((r) => [r.line, r.id]));
  const tripsToday = new Map(stops.routes.map((r) => [r.line, r.tripsToday ?? 0]));

  const lines = new Map(); // linje -> { kind, variants: Map(variantId -> v) }
  for (const { kind, geometry } of scopes) {
    const shapeByVariant = new Map();
    for (const r of geometry.routes || []) {
      // Samma variant kan vara uppdelad i flera bitar; den längsta får representera den.
      const prev = shapeByVariant.get(r.variant);
      if (!prev || r.shape.length > prev.shape.length) shapeByVariant.set(r.variant, r);
    }
    const legsByVariant = new Map();
    for (const leg of geometry.legs || []) {
      const key = `${leg.line}|${leg.variant}`;
      if (!legsByVariant.has(key)) legsByVariant.set(key, []);
      legsByVariant.get(key).push(leg);
    }
    for (const [key, legs] of legsByVariant) {
      const [line, variant] = key.split("|");
      let entry = lines.get(line);
      if (!entry) lines.set(line, (entry = { kind, variants: new Map() }));
      if (entry.variants.has(variant)) continue; // samma variant i båda omfattningarna
      legs.sort((a, b) => a.from.seq - b.from.seq);
      const stopIds = [legs[0].from.id, ...legs.map((l) => l.to.id)];
      for (const l of legs) {
        for (const s of [l.from, l.to]) if (!stopById.has(s.id)) stopById.set(s.id, { id: s.id, name: s.name, lat: s.lat, lon: s.lon });
      }
      const whole = shapeByVariant.get(variant);
      const latlon = whole ? whole.shape : legs.flatMap((l) => l.shape);
      entry.variants.set(variant, {
        variant,
        trips: legs[0].trips ?? whole?.trips ?? 0,
        overview: legs.some((l) => l.overview) || !!whole?.overview,
        backbone: legs.some((l) => l.backbone) || !!whole?.backbone,
        stopIds,
        headsign: legs[legs.length - 1].to.name,
        path: simplify(dedupe(latlon.map(([lat, lon]) => [lon, lat])), cfg.SIMPLIFY_METERS).map(([lon, lat]) => [round(lon), round(lat)]),
      });
    }
  }

  // Hållplatser som används, sorterade på namn.
  const used = new Set();
  for (const { variants } of lines.values()) for (const v of variants.values()) v.stopIds.forEach((id) => used.add(id));
  const stopList = [...used].map((id) => stopById.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const stopIndex = new Map(stopList.map((s, i) => [s.id, i]));

  const routes = [...lines.entries()]
    .sort(([a], [b]) => lineSort(a, b))
    .map(([line, { kind, variants }]) => {
      const vs = [...variants.values()].filter((v) => v.stopIds.every((id) => stopIndex.has(id))).sort((a, b) => b.trips - a.trips);
      inferDirections(vs, stopById);
      // Huvudform per riktning bland översiktsvarianterna, vägd med antal turer och längd.
      const mainByDir = new Map();
      for (const v of vs) {
        if (!v.overview && vs.some((o) => o.overview && o.dir === v.dir)) continue;
        const best = mainByDir.get(v.dir);
        if (!best || v.trips * v.stopIds.length > best.trips * best.stopIds.length) mainByDir.set(v.dir, v);
      }
      // Turer per dag: dagens antal, eller veckans turer delat på fem vardagar om
      // det är fler (så att en linje inte byter nivå på helgen).
      const weekly = vs.reduce((sum, v) => sum + v.trips, 0);
      const daily = Math.max(tripsToday.get(line) ?? 0, Math.round(weekly / 5));
      const k = cfg.KIND_OVERRIDES[line] ?? kind;
      return {
        id: routeIdByLine.get(line) || line,
        name: line,
        long: "",
        color: null,
        kind: k,
        daily,
        tier: daily >= cfg.TIER_TRIPS.stom && k === "tatort" ? "stom" : daily >= cfg.TIER_TRIPS.linje ? "linje" : "extra",
        variants: vs.map((v) => ({
          dir: v.dir,
          headsign: v.headsign,
          trips: v.trips,
          main: mainByDir.get(v.dir) === v,
          path: v.path,
          stops: v.stopIds.map((id) => stopIndex.get(id)),
        })),
      };
    })
    .filter((r) => r.variants.length);

  return {
    generated: new Date().toISOString(),
    source: "busskollen",
    stops: stopList.map((s) => [s.id, s.name, round(s.lat), round(s.lon)]),
    routes,
  };
}

// Riktning: jämför varje variants färdriktning (första till sista hållplatsen)
// med linjens vanligaste variant.
function inferDirections(vs, stopById) {
  if (!vs.length) return;
  const vec = (v) => {
    const a = stopById.get(v.stopIds[0]), b = stopById.get(v.stopIds[v.stopIds.length - 1]);
    return [b.lon - a.lon, b.lat - a.lat];
  };
  const ref = vec(vs[0]);
  for (const v of vs) {
    const d = vec(v);
    v.dir = d[0] * ref[0] + d[1] * ref[1] < 0 ? 1 : 0;
  }
}

function lineSort(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, "sv");
}

function round(x) {
  return Math.round(x * 1e5) / 1e5;
}
