// Busskollen Övik: karta, avgångar och reseförslag.
//
// Data:
//   data/network.json        hållplatser och förenklade linjeformer (byggs varje natt)
//   data/days/ÅÅÅÅ-MM-DD.json dagens turer med tider
//   CONFIG.api/vehicles|updates|alerts  realtid via vår Cloudflare Worker

import { groupStops, distance } from "./network.js";
import { layoutSchematic, renderSchematic } from "./schematic.js";

const CONFIG = { api: "", vehicleSeconds: 20, updateSeconds: 30, ...(window.BUSS_CONFIG || {}) };
const TZ = "Europe/Stockholm";
const STALE_SECONDS = 120;
const TRANSFER_SECONDS = 5 * 60;
const PALETTE = ["#0b6e8a", "#c2410c", "#15803d", "#7c3aed", "#be185d", "#0369a1", "#a16207", "#047857", "#b91c1c", "#4338ca", "#0f766e", "#9333ea", "#ca8a04", "#1d4ed8"];

const $ = (s) => document.querySelector(s);
const state = {
  kind: "all",
  view: "map", // "map" eller "schem" (linjenätskarta)
  schem: null,
  route: null, // vald linje (index)
  group: null, // vald hållplatsgrupp
  vehicles: new Map(), // id -> { marker, data, from, to }
  updates: {},
  alerts: [],
};
let net, groups, stopGroup, trips, groupTrips, labelToGroup, map;

boot().catch((err) => {
  console.error(err);
  setStatus("Kunde inte ladda bussdata. Ladda om sidan.", "warn");
});

async function boot() {
  net = await getJSON("data/network.json");
  net.routes.forEach((r, i) => (r.c = r.color || PALETTE[i % PALETTE.length]));
  ({ groups, stopGroup, labelToGroup } = groupStops(net));
  await loadTrips();
  buildUi();
  initMap();
  restoreStop();
  if (CONFIG.api) {
    pollVehicles();
    pollUpdates();
    pollAlerts();
  } else {
    setStatus("Tidtabell (realtid ej ansluten)", "warn");
  }
  setInterval(() => state.group != null && renderDepartures(), 30_000);
}

// --- Tid ---------------------------------------------------------------------

const clockFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function stockholm(date = new Date()) {
  const p = Object.fromEntries(clockFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, secs: +p.hour * 3600 + +p.minute * 60 + +p.second };
}
const nowSecs = () => stockholm().secs;
function hhmm(secs) {
  const s = ((secs % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

// --- Data --------------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadTrips() {
  const { date } = stockholm();
  const yesterday = stockholm(new Date(Date.now() - 864e5)).date;
  trips = [];
  for (const [d, off] of [[yesterday, -86400], [date, 0]]) {
    let day;
    try { day = await getJSON(`data/days/${d}.json`); } catch { continue; }
    for (const [id, r, v, head, stops, times] of day.trips) {
      // Från gårdagen behövs bara turer som pågår efter midnatt.
      if (off < 0 && times[times.length - 1] < 86400) continue;
      trips.push({ id, r, v, head, stops, times: times.map((t) => t + off) });
    }
  }
  groupTrips = groups.map(() => []);
  trips.forEach((t, ti) => t.stops.forEach((s, p) => groupTrips[stopGroup[s]].push([ti, p])));
  state.tripById = new Map(trips.map((t) => [t.id, t]));
}

// Försening i sekunder för en tur vid ett visst läge, eller null om realtid saknas.
function delayAt(trip, stopIdx) {
  const u = state.updates[trip.id];
  if (!u) return null;
  const v = u.s[net.stops[stopIdx][0]];
  if (v === "skip") return "skip";
  return v ?? u.d ?? null;
}

// --- Gränssnitt ----------------------------------------------------------------

function buildUi() {
  $("#stop-names").append(...groups.map((g) => Object.assign(document.createElement("option"), { value: g.label })));

  for (const b of document.querySelectorAll("[data-kind]")) {
    b.addEventListener("click", () => setKind(b.dataset.kind));
  }
  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => setView(b.dataset.view));
  }
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener("click", () => showTab(tab.id));
  }

  $("#stop-input").addEventListener("change", (e) => {
    const gi = labelToGroup.get(e.target.value.trim().toLowerCase());
    if (gi != null) selectGroup(gi, { fly: true });
  });
  $("#locate").addEventListener("click", locate);

  const now = stockholm().secs;
  $("#trip-time").value = hhmm(now);
  $("#swap").addEventListener("click", () => {
    const a = $("#trip-from").value;
    $("#trip-from").value = $("#trip-to").value;
    $("#trip-to").value = a;
  });
  $("#trip-form").addEventListener("submit", (e) => {
    e.preventDefault();
    planTrip();
  });

  renderLineList();
}

function showTab(id) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.id === id;
    tab.setAttribute("aria-selected", on);
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !on;
  }
}

function setKind(kind) {
  state.kind = kind;
  for (const b of document.querySelectorAll("[data-kind]")) b.setAttribute("aria-checked", b.dataset.kind === kind);
  if (state.route != null && !kindMatches(net.routes[state.route])) selectRoute(null);
  applyMapFilters();
  if (state.view === "schem") drawSchematic();
  renderLineList();
  for (const v of state.vehicles.values()) styleMarker(v);
}
const kindMatches = (r) => state.kind === "all" || r.kind === state.kind;

// Växla mellan den geografiska kartan och linjenätskartan.
function setView(view) {
  state.view = view;
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-checked", b.dataset.view === view);
  $("#schematic").hidden = view !== "schem";
  $("#map").style.visibility = view === "schem" ? "hidden" : "";
  if (view === "schem") drawSchematic();
  else map?.resize();
}

function drawSchematic() {
  const idx = net.routes.map((r, i) => i).filter((i) => kindMatches(net.routes[i]));
  const layout = layoutSchematic(net, groups, stopGroup, idx, state.kind === "all" ? { power: 0.35 } : {});
  state.schem = renderSchematic($("#schematic"), net, groups, layout, {
    onStop: (g) => selectGroup(g),
    onRoute: (ri) => selectRoute(ri),
    selectedRoute: state.route,
  });
}

function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = `status ${cls}`;
}

function badge(ri) {
  const r = net.routes[ri];
  const el = document.createElement("span");
  el.className = "badge";
  el.style.setProperty("--c", r?.c || "#8a979d");
  el.textContent = r?.name ?? "?";
  return el;
}

function renderLineList() {
  const ul = $("#lines");
  ul.replaceChildren();
  for (const [kind, title] of [["tatort", "Tätort"], ["landsbygd", "Landsbygd"]]) {
    if (state.kind !== "all" && state.kind !== kind) continue;
    const list = net.routes.map((r, i) => [r, i]).filter(([r]) => r.kind === kind);
    if (!list.length) continue;
    ul.append(Object.assign(document.createElement("li"), { className: "group", textContent: title }));
    for (const [r, i] of list) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const txt = document.createElement("span");
      txt.textContent = r.long || mainHeadsigns(r).join(" – ");
      btn.append(badge(i), txt);
      btn.addEventListener("click", () => selectRoute(i, { fit: true }));
      li.append(btn);
      ul.append(li);
    }
  }
}

const mainHeadsigns = (r) => r.variants.filter((v) => v.main).map((v) => v.headsign).filter(Boolean);

// --- Karta -------------------------------------------------------------------

function initMap() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  map = new maplibregl.Map({
    container: "map",
    style: `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`,
    center: [18.716, 63.29],
    zoom: 12,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("load", () => {
    map.addSource("routes", { type: "geojson", data: routeGeoJSON() });
    map.addSource("stops", { type: "geojson", data: stopGeoJSON() });
    map.addLayer({ id: "route-casing", type: "line", source: "routes", filter: ["get", "main"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dark ? "#0f171b" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 15, 8] } });
    map.addLayer({ id: "route-line", type: "line", source: "routes", filter: ["get", "main"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 15, 4] } });
    map.addLayer({ id: "route-alt", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": 3, "line-dasharray": [1.5, 1.5] } });
    map.addLayer({ id: "route-selected", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "c"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 8] } });
    map.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 12.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 2.5, 16, 6],
        "circle-color": dark ? "#172227" : "#ffffff",
        "circle-stroke-color": dark ? "#93a4ab" : "#142229",
        "circle-stroke-width": 1.5,
      } });
    map.addLayer({ id: "stop-selected", type: "circle", source: "stops", filter: ["==", ["get", "g"], -1],
      paint: { "circle-radius": 8, "circle-color": dark ? "#4fb3d1" : "#0b6e8a", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });

    map.on("click", "stops", (e) => selectGroup(e.features[0].properties.g));
    map.on("click", "route-line", (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["stops"] }).length) return;
      selectRoute(e.features[0].properties.r);
    });
    for (const l of ["stops", "route-line"]) {
      map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
    }
    applyMapFilters();
    if (state.group != null) highlightGroup();
  });
  map.on("error", (e) => {
    // Om den mörka stilen saknas, byt till den ljusa.
    if (dark && String(e?.error?.message || "").includes("styles/dark")) map.setStyle("https://tiles.openfreemap.org/styles/positron");
  });
}

function routeGeoJSON() {
  const features = [];
  net.routes.forEach((r, ri) =>
    r.variants.forEach((v) =>
      features.push({ type: "Feature", properties: { r: ri, c: r.c, kind: r.kind, main: v.main }, geometry: { type: "LineString", coordinates: v.path } }),
    ),
  );
  // Huvudlinjer sist så att de ritas överst i samma lager.
  features.sort((a, b) => a.properties.main - b.properties.main);
  return { type: "FeatureCollection", features };
}

function stopGeoJSON() {
  return {
    type: "FeatureCollection",
    features: groups.map((g, gi) => ({ type: "Feature", properties: { g: gi, kinds: [...g.routes].map((r) => net.routes[r].kind).join(",") }, geometry: { type: "Point", coordinates: [g.lon, g.lat] } })),
  };
}

function applyMapFilters() {
  if (!map?.getLayer("route-line")) return;
  const kindFilter = state.kind === "all" ? true : ["==", ["get", "kind"], state.kind];
  const base = ["all", ["get", "main"], kindFilter];
  map.setFilter("route-casing", base);
  map.setFilter("route-line", base);
  map.setFilter("stops", state.kind === "all" ? null : ["in", state.kind, ["get", "kinds"]]);
  const sel = state.route ?? -1;
  map.setPaintProperty("route-line", "line-opacity", state.route == null ? 0.9 : 0.25);
  map.setFilter("route-selected", ["all", ["==", ["get", "r"], sel], ["get", "main"]]);
  map.setFilter("route-alt", ["all", ["==", ["get", "r"], sel], ["!", ["get", "main"]]]);
}

function selectRoute(ri, { fit = false } = {}) {
  state.route = ri;
  applyMapFilters();
  state.schem?.select(ri);
  for (const v of state.vehicles.values()) styleMarker(v);
  const box = $("#lineinfo");
  if (ri == null) {
    box.hidden = true;
    return;
  }
  const r = net.routes[ri];
  const txt = document.createElement("div");
  txt.className = "txt";
  const title = document.createElement("strong");
  title.textContent = r.long || `Linje ${r.name}`;
  const dirs = document.createElement("div");
  dirs.className = "small muted";
  dirs.textContent = mainHeadsigns(r).map((h) => `mot ${h}`).join(" · ");
  txt.append(title, dirs);
  if (r.variants.some((v) => !v.main)) {
    const alt = document.createElement("div");
    alt.className = "small muted";
    alt.textContent = "Streckat: turer som går en annan väg.";
    txt.append(alt);
  }
  const close = Object.assign(document.createElement("button"), { type: "button", className: "close", textContent: "×" });
  close.setAttribute("aria-label", "Stäng linjen");
  close.addEventListener("click", () => selectRoute(null));
  box.replaceChildren(badge(ri), txt, close);
  box.hidden = false;
  if (fit && map) {
    const b = new maplibregl.LngLatBounds();
    r.variants.filter((v) => v.main).forEach((v) => v.path.forEach((p) => b.extend(p)));
    map.fitBounds(b, { padding: 60, maxZoom: 15 });
  }
}

// --- Hållplatser och avgångar ---------------------------------------------------

function selectGroup(gi, { fly = false } = {}) {
  state.group = gi;
  try { localStorage.setItem("busskollen.stop", groups[gi].label); } catch {}
  $("#stop-input").value = groups[gi].label;
  showTab("tab-dep");
  renderDepartures();
  highlightGroup();
  if (fly && state.view === "schem") state.schem?.focus(gi);
  else if (fly && map) map.flyTo({ center: [groups[gi].lon, groups[gi].lat], zoom: Math.max(map.getZoom(), 15) });
}

function highlightGroup() {
  if (map?.getLayer("stop-selected")) map.setFilter("stop-selected", ["==", ["get", "g"], state.group ?? -1]);
}

function restoreStop() {
  let label = null;
  try { label = localStorage.getItem("busskollen.stop"); } catch {}
  const gi = label ? labelToGroup.get(label.toLowerCase()) : null;
  if (gi != null) selectGroup(gi);
}

function departuresFor(gi, fromSecs, horizon = 3 * 3600, limit = 25) {
  const out = [];
  for (const [ti, p] of groupTrips[gi]) {
    const t = trips[ti];
    if (p === t.stops.length - 1) continue; // sista hållplatsen: ingen avgång
    const planned = t.times[p];
    if (planned < fromSecs - 600 || planned > fromSecs + horizon) continue;
    const d = delayAt(t, t.stops[p]);
    const cancelled = d === "skip" || state.updates[t.id]?.x;
    const expected = planned + (typeof d === "number" ? d : 0);
    if (expected < fromSecs - 30) continue;
    out.push({ t, p, planned, expected, delay: typeof d === "number" ? d : null, cancelled });
  }
  return out.sort((a, b) => a.expected - b.expected).slice(0, limit);
}

function renderDepartures() {
  const gi = state.group;
  const g = groups[gi];
  $("#dep-title").hidden = false;
  $("#dep-title").textContent = g.label;
  const now = nowSecs();
  const list = departuresFor(gi, now);
  $("#dep-empty").hidden = list.length > 0;
  $("#dep-empty").textContent = "Inga avgångar de närmaste tre timmarna.";
  $("#departures").replaceChildren(...list.map((d) => departureRow(d, now)));
}

function departureRow({ t, planned, expected, delay, cancelled }, now) {
  const li = document.createElement("li");
  const dest = document.createElement("span");
  dest.className = "dest";
  dest.textContent = t.head || net.routes[t.r].long;
  const time = document.createElement("span");
  time.className = "time";
  const main = document.createElement("b");
  const sub = document.createElement("small");
  const mins = Math.round((expected - now) / 60);
  if (cancelled) {
    main.className = "cancel";
    main.textContent = hhmm(planned);
    sub.textContent = "Inställd";
  } else {
    main.textContent = mins <= 0 ? "Nu" : mins < 30 ? `${mins} min` : hhmm(expected);
    if (delay == null) sub.textContent = `${hhmm(planned)} · Tidtabell`;
    else if (Math.abs(delay) >= 60) {
      sub.className = "late";
      sub.textContent = `${hhmm(expected)} (${delay > 0 ? "+" : "−"}${Math.round(Math.abs(delay) / 60)} min)`;
    } else sub.textContent = `${hhmm(expected)} · I tid`;
  }
  time.append(main, sub);
  li.append(badge(t.r), dest, time);
  return li;
}

function locate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const near = groups
        .map((g, gi) => [gi, distance(coords.latitude, coords.longitude, g.lat, g.lon)])
        .sort((a, b) => a[1] - b[1])
        .slice(0, 5);
      const chips = near.map(([gi, m]) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "chip", textContent: `${groups[gi].name} · ${m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`}` });
        b.addEventListener("click", () => selectGroup(gi, { fly: true }));
        return b;
      });
      $("#nearby").replaceChildren(...chips);
      if (map) {
        state.me?.remove();
        const el = document.createElement("div");
        el.style.cssText = "width:14px;height:14px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px rgb(37 99 235 / .25)";
        state.me = new maplibregl.Marker({ element: el }).setLngLat([coords.longitude, coords.latitude]).addTo(map);
        map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 15 });
      }
      showTab("tab-dep");
    },
    () => setStatus("Positionen är inte tillgänglig", "warn"),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
}

// --- Realtid -----------------------------------------------------------------

function poll(fn, seconds) {
  let timer;
  const run = async () => {
    clearTimeout(timer);
    try { await fn(); } catch (e) { console.warn(e); }
    timer = setTimeout(run, seconds * 1000);
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && run());
  run();
}

function pollVehicles() {
  poll(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const { data } = await getJSON(`${CONFIG.api}/vehicles`);
      renderVehicles(data);
      setStatus(`Live · ${data.length} bussar`, "live");
    } catch {
      setStatus("Realtid saknas just nu", "warn");
    }
  }, CONFIG.vehicleSeconds);
}

function pollUpdates() {
  poll(async () => {
    if (document.visibilityState !== "visible") return;
    state.updates = (await getJSON(`${CONFIG.api}/updates`)).data;
    if (state.group != null) renderDepartures();
  }, CONFIG.updateSeconds);
}

function pollAlerts() {
  poll(async () => {
    const { data } = await getJSON(`${CONFIG.api}/alerts`);
    const ids = new Set(net.routes.map((r) => r.id));
    const relevant = data.filter((a) => !a.routes.length || a.routes.some((r) => ids.has(r)));
    const box = $("#alerts");
    box.hidden = !relevant.length;
    box.replaceChildren(...relevant.map((a) => {
      const d = document.createElement("details");
      const s = document.createElement("summary");
      s.textContent = a.header || "Trafikstörning";
      const p = Object.assign(document.createElement("p"), { className: "small", textContent: a.text });
      d.append(s, p);
      return d;
    }));
  }, 300);
}

function routeForVehicle(v) {
  const trip = v.trip && state.tripById.get(v.trip);
  if (trip) return { trip, ri: trip.r };
  const ri = net.routes.findIndex((r) => r.id === v.route);
  return { trip: null, ri: ri < 0 ? null : ri };
}

function renderVehicles(list) {
  const seen = new Set();
  const nowEpoch = Date.now() / 1000;
  for (const v of list) {
    const { trip, ri } = routeForVehicle(v);
    if (ri == null) continue; // buss på en linje utanför Övik
    seen.add(v.id);
    let entry = state.vehicles.get(v.id);
    if (!entry) {
      const el = document.createElement("div");
      el.className = "bus";
      el.innerHTML = '<span class="arrow"></span><span class="dot"></span>';
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openVehicle(v.id);
      });
      entry = { el, marker: new maplibregl.Marker({ element: el }).setLngLat([v.lon, v.lat]).addTo(map) };
      state.vehicles.set(v.id, entry);
    } else {
      glide(entry.marker, [v.lon, v.lat]);
    }
    Object.assign(entry, { data: v, trip, ri, stale: v.ts && nowEpoch - v.ts > STALE_SECONDS });
    styleMarker(entry);
    if (entry.popup?.isOpen()) entry.popup.setDOMContent(vehicleCard(entry));
  }
  for (const [id, entry] of state.vehicles) {
    if (seen.has(id)) continue;
    entry.marker.remove();
    state.vehicles.delete(id);
  }
}

function styleMarker(entry) {
  const r = net.routes[entry.ri];
  const { el } = entry;
  el.style.setProperty("--c", r.c);
  el.querySelector(".dot").textContent = r.name;
  el.classList.toggle("stale", !!entry.stale);
  el.hidden = !kindMatches(r);
  el.classList.toggle("dim", state.route != null && state.route !== entry.ri);
  if (entry.data.bearing != null) el.style.setProperty("--b", `${entry.data.bearing}deg`);
  el.setAttribute("aria-label", `Linje ${r.name}${entry.trip?.head ? ` mot ${entry.trip.head}` : ""}`);
}

// Flytta markören mjukt till nästa GPS-läge.
function glide(marker, to) {
  const from = marker.getLngLat().toArray();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return marker.setLngLat(to);
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 1200);
    marker.setLngLat([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function openVehicle(id) {
  const entry = state.vehicles.get(id);
  if (!entry) return;
  entry.popup?.remove();
  entry.popup = new maplibregl.Popup({ offset: 18, maxWidth: "280px" }).setDOMContent(vehicleCard(entry));
  entry.marker.setPopup(entry.popup).togglePopup();
}

function vehicleCard(entry) {
  const { trip, ri, data } = entry;
  const r = net.routes[ri];
  const div = document.createElement("div");
  div.className = "pop";
  const h = document.createElement("h3");
  h.append(badge(ri), document.createTextNode(trip?.head ? `mot ${trip.head}` : r.long || `Linje ${r.name}`));
  div.append(h);
  const info = document.createElement("div");
  info.className = "small muted";
  const age = data.ts ? Math.max(0, Math.round(Date.now() / 1000 - data.ts)) : null;
  const delay = trip ? state.updates[trip.id]?.d : null;
  info.textContent = [
    delay != null ? (Math.abs(delay) < 60 ? "I tid" : `${delay > 0 ? "+" : "−"}${Math.round(Math.abs(delay) / 60)} min`) : null,
    age != null ? `GPS för ${age < 60 ? `${age} s` : `${Math.round(age / 60)} min`} sedan` : null,
  ].filter(Boolean).join(" · ");
  div.append(info);
  if (trip) {
    const now = nowSecs();
    const ul = document.createElement("ul");
    const next = trip.stops
      .map((s, p) => {
        const d = delayAt(trip, s);
        return [s, trip.times[p] + (typeof d === "number" ? d : 0)];
      })
      .filter(([, t]) => t >= now - 30)
      .slice(0, 4);
    for (const [s, t] of next) {
      const li = document.createElement("li");
      li.textContent = `${hhmm(t)}  ${net.stops[s][1]}`;
      ul.append(li);
    }
    if (next.length) div.append(ul);
  }
  const show = Object.assign(document.createElement("button"), { type: "button", className: "linkbtn", textContent: "Visa linjen" });
  show.addEventListener("click", () => selectRoute(ri, { fit: true }));
  div.append(show);
  return div;
}

// --- Reseplanerare -------------------------------------------------------------

function planTrip() {
  const from = labelToGroup.get($("#trip-from").value.trim().toLowerCase());
  const to = labelToGroup.get($("#trip-to").value.trim().toLowerCase());
  const out = $("#trip-results");
  if (from == null || to == null || from === to) {
    out.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "Välj två olika hållplatser från listan." }));
    return;
  }
  const [h, m] = $("#trip-time").value.split(":").map(Number);
  let start = h * 3600 + m * 60;
  // Ett klockslag långt bakåt betyder sannolikt efter midnatt.
  if (start < nowSecs() - 6 * 3600) start += 86400;
  const results = findJourneys(from, to, start);
  if (!results.length) {
    out.replaceChildren(Object.assign(document.createElement("li"), { className: "muted", textContent: "Hittade ingen resa med högst ett byte de närmaste fyra timmarna." }));
    return;
  }
  out.replaceChildren(...results.map(journeyRow));
}

function findJourneys(from, to, start, horizon = 4 * 3600) {
  const end = start + horizon;
  const journeys = [];
  // Direktresor.
  const legsFrom = groupTrips[from].filter(([ti, p]) => trips[ti].times[p] >= start && trips[ti].times[p] <= end);
  for (const [ti, p] of legsFrom) {
    const t = trips[ti];
    const q = t.stops.findIndex((s, i) => i > p && stopGroup[s] === to);
    if (q > 0) journeys.push({ dep: t.times[p], arr: t.times[q], legs: [{ t, p, q }] });
  }
  // Ett byte: tidigaste ankomst till varje bytespunkt.
  const reach = new Map(); // grupp -> { arr, leg }
  for (const [ti, p] of legsFrom) {
    const t = trips[ti];
    for (let i = p + 1; i < t.stops.length; i++) {
      const g = stopGroup[t.stops[i]];
      if (g === to || g === from) continue;
      const best = reach.get(g);
      // Spara tidigaste ankomsten, och vid lika ankomst den senaste avgången.
      if (!best || t.times[i] < best.arr || (t.times[i] === best.arr && t.times[p] > best.leg.t.times[best.leg.p])) {
        reach.set(g, { arr: t.times[i], leg: { t, p, q: i } });
      }
    }
  }
  for (const [g, { arr, leg }] of reach) {
    for (const [ti, p] of groupTrips[g]) {
      const t = trips[ti];
      if (t === leg.t || t.times[p] < arr + TRANSFER_SECONDS || t.times[p] > end) continue;
      const q = t.stops.findIndex((s, i) => i > p && stopGroup[s] === to);
      if (q > 0) journeys.push({ dep: leg.t.times[leg.p], arr: t.times[q], legs: [leg, { t, p, q }] });
    }
  }
  // Behåll bara resor som inte är sämre än någon annan (senare avgång eller tidigare ankomst).
  journeys.sort((a, b) => a.arr - b.arr || b.dep - a.dep || a.legs.length - b.legs.length);
  const kept = [];
  for (const j of journeys) {
    if (kept.some((k) => k.dep >= j.dep && k.arr <= j.arr)) continue;
    kept.push(j);
    if (kept.length >= 6) break;
  }
  return kept.sort((a, b) => a.dep - b.dep);
}

function journeyRow(j) {
  const li = document.createElement("li");
  const head = document.createElement("div");
  head.className = "head";
  const mins = Math.round((j.arr - j.dep) / 60);
  head.append(
    Object.assign(document.createElement("span"), { textContent: `${hhmm(j.dep)} → ${hhmm(j.arr)}` }),
    Object.assign(document.createElement("span"), { className: "tag", textContent: `${mins} min · ${j.legs.length === 1 ? "direkt" : "1 byte"}` }),
  );
  li.append(head);
  for (const { t, p, q } of j.legs) {
    const leg = document.createElement("div");
    leg.className = "leg";
    const txt = document.createElement("span");
    txt.textContent = `${hhmm(t.times[p])} ${net.stops[t.stops[p]][1]} → ${hhmm(t.times[q])} ${net.stops[t.stops[q]][1]}`;
    leg.append(badge(t.r), txt);
    li.append(leg);
  }
  return li;
}
