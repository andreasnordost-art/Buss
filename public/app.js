// Busskollen Övik: karta, linjenät, avgångar, bussar och reseförslag.
//
// Data:
//   data/network.json   hållplatser och linjeformer från Trafiklab (byggs varje natt)
//   data/days/          tidtabellen per dag; live.js räknar fram avgångar, bussarnas
//                       turer och reseförslag ur den och realtiden från proxyn
//   CONFIG.api + /api/  reserv: Busskollens API via proxyn, om den egna datan saknas

import { groupStops, distance, shortName, bundleLegs, routePatterns } from "./network.js";
import { createLive } from "./live.js";
import { layoutSchematic, renderSchematic } from "./schematic.js";

const CONFIG = { api: "", vehicleSeconds: 15, ...(window.BUSS_CONFIG || {}) };
const TZ = "Europe/Stockholm";
const STALE_SECONDS = 120;
const PALETTE = ["#7c3aed", "#d1343f", "#2f6fd6", "#0f8a6a", "#c2410c", "#0e7490", "#b45309", "#be185d", "#4d7c0f", "#6d28d9", "#0369a1", "#a16207", "#047857", "#9f1239"];
// Fasta färger för stadslinjerna så att de känns igen från dag till dag.
const LINE_COLORS = { 401: "#7c3aed", 402: "#d1343f", 403: "#2f6fd6", 404: "#0f8a6a", 405: "#c2410c", 406: "#0e7490", 407: "#a16207", 408: "#be185d", 409: "#4d7c0f", 410: "#9333ea", 411: "#475569" };
const STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  detail: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const COMMON = ["Örnparken", "Örnsköldsvik ReseC", "Gullänget Centrum", "Sund Centrum", "Sjukhuset Övik"];

const $ = (s) => document.querySelector(s);
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(`busskollen.${k}`)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(`busskollen.${k}`, JSON.stringify(v)); } catch {} },
};

const state = {
  kind: store.get("kind", "tatort"),
  view: "map",
  extra: store.get("extra", false), // alla linjer, även skol- och specialturer
  alt: store.get("alt", false), // avvikande körvägar
  style: store.get("style", "light"),
  schemOff: store.get("schemOff", []), // släckta lager i linjenätet
  schem: null,
  route: null, // vald linje (index)
  group: null, // vald hållplatsgrupp
  bus: null, // vald buss (fordons-id)
  follow: false,
  vehicles: new Map(), // id -> { el, marker, data, ri }
  alerts: [],
  favs: store.get("favs", []), // hållplats-id:n
  mytrips: store.get("mytrips", []), // [{ name, from, to }] med hållplats-id:n
};
let net, groups, stopGroup, labelToGroup, groupById, map, live;

boot().catch((err) => {
  console.error(err);
  setStatus("Kunde inte ladda linjenätet. Ladda om sidan.", "warn");
});

async function boot() {
  net = await getJSON("data/network.json");
  let n = 0;
  net.routes.forEach((r) => (r.c = r.color || LINE_COLORS[r.name] || PALETTE[n++ % PALETTE.length]));
  ({ groups, stopGroup, labelToGroup } = groupStops(net));
  groups.forEach((g) => (g.id = net.stops[g.stops[0]][0]));
  groupById = new Map();
  groups.forEach((g, gi) => g.stops.forEach((s) => groupById.set(net.stops[s][0], gi)));
  if (net.source === "gtfs") {
    live = createLive(net, { groups, stopGroup }, CONFIG.api, getJSON);
    await live.ready.catch((err) => { console.warn("Egen tidtabell saknas, använder reserven", err); live = null; });
  }
  buildUi();
  initMap();
  restoreFromUrl();
  pollVehicles();
  pollAlerts();
  setInterval(() => {
    if (state.group != null && !$("#stop").hidden) renderStop(false);
  }, 30_000);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

// --- Hjälpfunktioner ------------------------------------------------------------

async function getJSON(url, opts) {
  const res = await fetch(url, { cache: "no-cache", ...opts });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
const api = (path, params) => getJSON(`${CONFIG.api}/api/${path}${params ? `?${new URLSearchParams(params)}` : ""}`);
// Egen data från Trafiklab först, Busskollens API som reserv.
async function fetchLive(own, fallback) {
  if (live) {
    try { return await own(live); } catch (err) { console.warn(err); }
  }
  return fallback();
}

const timeFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const hhmm = (epoch) => timeFmt.format(new Date(epoch * 1000));
const nowEpoch = () => Date.now() / 1000;
function dayLabel(epoch) {
  const d = dayFmt.format(new Date(epoch * 1000));
  if (d === dayFmt.format(new Date())) return "I dag";
  if (d === dayFmt.format(new Date(Date.now() + 864e5))) return "I morgon";
  const s = weekdayFmt.format(new Date(epoch * 1000));
  return s[0].toUpperCase() + s.slice(1);
}
function until(epoch) {
  const m = Math.round((epoch - nowEpoch()) / 60);
  if (m <= 0) return "Nu";
  if (m < 60) return `om ${m} min`;
  const h = Math.floor(m / 60);
  return `om ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
function ago(epoch) {
  const s = Math.max(0, Math.round(nowEpoch() - epoch));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}
function meters(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
}
// Som replaceChildren, men hoppar över tomma delar (null/false).
function put(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}
const routeByLine = (line) => {
  const list = net.routes.map((r, i) => [r, i]).filter(([r]) => r.name === String(line));
  return list.length ? list[0][1] : null;
};
function badge(ri, line) {
  const r = ri != null ? net.routes[ri] : null;
  return h("span", { class: "badge", style: `--c:${r?.c || "#7a8a84"}` }, r?.name ?? line ?? "?");
}
const kindMatches = (r) => state.kind === "all" || r.kind === state.kind;
// Linjer som visas just nu: rätt område, och övriga turer bara när de är påslagna.
const routeShown = (r) => kindMatches(r) && (state.extra || r.tier !== "extra");
const mainHeadsigns = (r) => r.variants.filter((v) => v.main).map((v) => v.headsign).filter(Boolean);

function setStatus(text, cls = "") {
  const el = $("#status");
  el.textContent = text;
  el.className = `status ${cls}`;
}

// --- Gränssnitt ------------------------------------------------------------------

function buildUi() {
  $("#stop-names").append(...groups.map((g) => h("option", { value: g.label })));

  for (const b of document.querySelectorAll("[data-kind]")) b.addEventListener("click", () => setKind(b.dataset.kind));
  for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => setView(b.dataset.view));
  for (const tab of document.querySelectorAll('[role="tab"]')) tab.addEventListener("click", () => showTab(tab.id));
  markKind();

  // Lager: linjer, avvikande körvägar och kartstil.
  const pop = $("#layers"), btn = $("#layers-btn");
  const openPop = (open) => { pop.hidden = !open; btn.setAttribute("aria-expanded", open); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); openPop(pop.hidden); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) openPop(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { openPop(false); btn.focus(); } });
  for (const r of document.querySelectorAll('input[name="lines"]')) {
    r.checked = r.value === (state.extra ? "all" : "main");
    r.addEventListener("change", () => setExtra(r.value === "all"));
  }
  $("#alt-toggle").checked = state.alt;
  $("#alt-toggle").addEventListener("change", (e) => { state.alt = e.target.checked; store.set("alt", state.alt); applyMapFilters(); });
  // Lager i linjenätet: varje släckt lager blir en klass på linjenätets ruta.
  for (const c of document.querySelectorAll("[data-schem-layer]")) {
    c.checked = !state.schemOff.includes(c.dataset.schemLayer);
    c.addEventListener("change", () => {
      state.schemOff = [...document.querySelectorAll("[data-schem-layer]")].filter((x) => !x.checked).map((x) => x.dataset.schemLayer);
      store.set("schemOff", state.schemOff);
      markSchemLayers();
    });
  }
  markSchemLayers();
  for (const r of document.querySelectorAll('input[name="style"]')) {
    r.checked = r.value === state.style;
    r.addEventListener("change", () => setStyle(r.value));
  }

  $("#locate").addEventListener("click", () => { showHome(); showNearby(); });
  $("#nearby-btn").addEventListener("click", showNearby);
  $("#alert-card").addEventListener("click", () => showTab("tab-info"));
  $("#follow").addEventListener("click", () => setFollow(!state.follow));

  for (const b of document.querySelectorAll("[data-zoom]")) {
    b.addEventListener("click", () => {
      if (!state.schem) return;
      if (b.dataset.zoom === "fit") state.schem.fit();
      else state.schem.zoom(b.dataset.zoom === "in" ? 1.5 : 1 / 1.5);
    });
  }
  renderLegend();
  initSearch();
  initPlanner();
  initSheet();
  const topHeight = () => document.documentElement.style.setProperty("--top-h", `${$(".top").offsetHeight}px`);
  topHeight();
  addEventListener("resize", topHeight);
  renderCommon();
  renderFavs();
  renderMyTrips();
}

function markSchemLayers() {
  for (const c of document.querySelectorAll("[data-schem-layer]")) $("#schematic").classList.toggle(`no-${c.dataset.schemLayer}`, !c.checked);
}

function showTab(id) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const on = tab.id === id;
    tab.setAttribute("aria-selected", on);
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !on;
  }
  if (id === "tab-info") renderAlerts();
  sheet("half");
}

// Vilken del av avgångsfliken som visas: start, hållplats, buss eller linje.
function showPart(part) {
  for (const p of ["home", "stop", "bus", "line"]) $(`#${p}`).hidden = p !== part;
  showTab("tab-dep");
}
function showHome() {
  closeBus();
  state.group = null;
  highlightGroup();
  selectRoute(null);
  showPart("home");
  updateUrl();
}

function updateUrl() {
  const p = new URLSearchParams();
  if (state.bus) p.set("bus", state.bus);
  else if (state.group != null) p.set("stop", groups[state.group].id);
  else if (state.route != null) p.set("line", net.routes[state.route].name);
  const q = p.toString();
  history.replaceState(null, "", q ? `?${q}` : location.pathname);
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get("stop") && groupById.has(p.get("stop"))) selectGroup(groupById.get(p.get("stop")), { fly: true });
  else if (p.get("line") && routeByLine(p.get("line")) != null) openLine(routeByLine(p.get("line")));
  else if (p.get("bus")) state.pendingBus = p.get("bus");
}

function setKind(kind) {
  state.kind = kind;
  store.set("kind", kind);
  markKind();
  if (state.route != null && !kindMatches(net.routes[state.route])) selectRoute(null);
  applyMapFilters();
  renderLegend();
  if (state.view === "schem") drawSchematic();
  for (const v of state.vehicles.values()) styleMarker(v);
  syncSchemBuses();
  if (map) fitKind();
}
function markKind() {
  for (const b of document.querySelectorAll("[data-kind]")) b.setAttribute("aria-checked", b.dataset.kind === state.kind);
}
function fitKind() {
  if (state.group != null || state.bus) return;
  const b = new maplibregl.LngLatBounds();
  net.routes.filter(routeShown).forEach((r) => r.variants.filter((v) => v.main).forEach((v) => v.path.forEach((p) => b.extend(p))));
  if (!b.isEmpty()) map.fitBounds(b, { padding: fitPadding(), maxZoom: 13.5, duration: 600 });
}

function setExtra(on) {
  state.extra = on;
  store.set("extra", on);
  if (!on && state.route != null && net.routes[state.route].tier === "extra") selectRoute(null);
  applyMapFilters();
  renderLegend();
  if (state.view === "schem") drawSchematic();
}

// --- Sök ---------------------------------------------------------------------------

function initSearch() {
  const input = $("#q"), list = $("#q-results");
  let items = [], active = -1;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
  const pick = (it) => {
    close();
    input.value = "";
    input.blur();
    if (it.gi != null) selectGroup(it.gi, { fly: true });
    else openLine(it.ri, { fit: true });
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return close();
    const lines = net.routes.map((r, ri) => ({ r, ri })).filter(({ r }) => r.name.toLowerCase().startsWith(q)).slice(0, 4)
      .map(({ r, ri }) => ({ ri, label: `Linje ${r.name}`, sub: mainHeadsigns(r).join(" – ") }));
    const stops = groups.map((g, gi) => ({ g, gi, i: g.label.toLowerCase().indexOf(q) })).filter((x) => x.i >= 0)
      .sort((a, b) => (a.i === 0) - (b.i === 0) ? (b.i === 0) - (a.i === 0) : a.g.label.localeCompare(b.g.label, "sv"))
      .slice(0, 8).map(({ g, gi }) => ({ gi, label: g.label, sub: [...g.routes].map((r) => net.routes[r].name).join(" · ") }));
    items = [...lines, ...stops];
    list.replaceChildren(...items.map((it, i) => h("li", { role: "option", id: `q-${i}`, "aria-selected": i === active, onmousedown: (e) => { e.preventDefault(); pick(it); } },
      it.ri != null ? badge(it.ri) : h("span", { class: "ico stopico" }, "●"), h("span", {}, h("b", {}, it.label), h("small", {}, it.sub)))));
    if (!items.length) list.replaceChildren(h("li", { class: "none" }, "Inga träffar"));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  input.addEventListener("input", () => { active = -1; render(); });
  input.addEventListener("focus", () => { sheet("full"); render(); });
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
      render();
      input.setAttribute("aria-activedescendant", `q-${active}`);
    } else if (e.key === "Enter" && items.length) {
      e.preventDefault();
      pick(items[Math.max(0, active)]);
    } else if (e.key === "Escape") close();
  });
}

// --- Mobil: dragbart ark ------------------------------------------------------------

const mobile = () => matchMedia("(max-width: 760px)").matches;
function sheet(pos) {
  if (!mobile()) return;
  const panel = $("#panel");
  if (pos === "half" && panel.dataset.sheet === "full") return; // krymp inte när man läser
  panel.dataset.sheet = pos;
}
function initSheet() {
  const panel = $("#panel"), handle = panel.querySelector(".handle");
  const order = ["peek", "half", "full"];
  handle.addEventListener("click", () => {
    const i = order.indexOf(panel.dataset.sheet);
    panel.dataset.sheet = order[(i + 1) % order.length];
  });
  let startY = null, startH = 0, moved = false;
  handle.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    moved = false;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (startY == null) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 6) moved = true;
    if (moved) { panel.style.height = `${Math.max(120, startH + dy)}px`; panel.classList.add("dragging"); }
  });
  handle.addEventListener("pointerup", (e) => {
    if (startY == null) return;
    startY = null;
    panel.classList.remove("dragging");
    if (!moved) return;
    const vh = innerHeight, hNow = panel.getBoundingClientRect().height;
    panel.style.height = "";
    panel.dataset.sheet = hNow > vh * 0.7 ? "full" : hNow > vh * 0.32 ? "half" : "peek";
    e.preventDefault();
    handle.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { once: true, capture: true });
  });
}

// --- Karta -------------------------------------------------------------------------

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: STYLES[state.style] || STYLES.light,
    center: [18.716, 63.29],
    zoom: 12,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("style.load", addLayers);
  map.once("load", () => fitKind());
  map.on("dragstart", () => state.follow && setFollow(false));
  // Utzoomat blir bussarna små skyltar med bara linjenumret.
  const far = () => map.getContainer().classList.toggle("far", map.getZoom() < 13);
  map.on("zoom", far);
  far();
  map.on("error", (e) => {
    // Saknas en stil faller vi tillbaka på den ljusa.
    if (String(e?.error?.message || "").includes("styles/") && state.style !== "light") setStyle("light");
  });
  const STOP_LAYERS = ["stops", "stop-hubs", "route-stops", "stop-names", "big-names", "hub-names", "route-stop-names"];
  for (const l of [...STOP_LAYERS, "route-line", "route-extra", "route-badges", "route-badges-minor"]) {
    map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
  }
  // Hållplatser går att träffa även lite vid sidan om, så att de är lätta att trycka på.
  map.on("click", (e) => {
    const near = (d, layers) => map.queryRenderedFeatures([[e.point.x - d, e.point.y - d], [e.point.x + d, e.point.y + d]], { layers: layers.filter((l) => map.getLayer(l)) });
    const stop = near(mobile() ? 12 : 8, STOP_LAYERS)[0];
    if (stop) return selectGroup(stop.properties.g);
    const hit = near(mobile() ? 10 : 6, ["route-badges", "route-badges-minor", "route-selected", "route-line", "route-extra"]);
    if (hit.length) openLine(hit[0].properties.r);
  });
  // Den hopfällda källhänvisningen tar mindre plats på mobilen.
  map.once("load", () => map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
}

// På mobil täcker arket kartans nederdel: flytta målet upp till den synliga delen.
// Arkets höjd räknas från läget (inte från elementet, som kan vara mitt i en animation).
function sheetHeight() {
  if (!mobile()) return 0;
  return innerHeight * ({ peek: 0.34, half: 0.58 }[$("#panel").dataset.sheet] ?? 0.58);
}
function offset() {
  return [0, -sheetHeight() / 2];
}

function fitPadding() {
  const p = viewPadding();
  return { top: p.top + 16, bottom: p.bottom + 20, left: p.left + 30, right: p.right + 30 };
}

// Hur mycket av kartytan som täcks av knapparna, linjeraden och (på mobil) arket.
function viewPadding() {
  const wrap = $(".mapwrap").getBoundingClientRect();
  let top = 0, bottom = mobile() ? sheetHeight() - (innerHeight - wrap.bottom) : 0;
  for (const el of [$(".mapbar"), $("#legend")]) {
    if (!el || el.hidden || !el.offsetHeight) continue;
    const r = el.getBoundingClientRect();
    if (r.top - wrap.top < wrap.height / 2) top = Math.max(top, r.bottom - wrap.top);
    else bottom = Math.max(bottom, wrap.bottom - r.top);
  }
  return { top, bottom: Math.max(0, bottom), left: 0, right: 52 };
}

function setStyle(name) {
  state.style = name;
  store.set("style", name);
  for (const r of document.querySelectorAll('input[name="style"]')) r.checked = r.value === name;
  map?.setStyle(STYLES[name], { diff: false });
}

function addLayers() {
  if (map.getSource("routes")) return;
  const dark = state.style === "dark";
  const casing = dark ? "#10171a" : "#ffffff";
  const ink = dark ? "#e8f0ec" : "#163f30";
  addLineBadges();
  map.addSource("routes", { type: "geojson", data: routeGeoJSON() });
  map.addSource("bundles", { type: "geojson", data: bundleGeoJSON() });
  map.addSource("stops", { type: "geojson", data: stopGeoJSON() });
  map.addSource("journey", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  // Linjerna läggs under kartans egna namn, så att ortnamn och gatunamn syns ovanpå.
  const below = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  const zoomed = (stops) => ["interpolate", ["linear"], ["zoom"], ...stops.flat()];
  const width = (a, b) => zoomed([[8, a * 0.8], [12, a], [16, b]]);
  const round = { "line-cap": "round", "line-join": "round" };
  // Övriga turer: tunna och streckade, under de vanliga linjerna.
  map.addLayer({ id: "route-alt", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: { "line-join": "round" }, paint: { "line-color": ["get", "c"], "line-width": width(1.8, 3.5), "line-dasharray": [1.5, 1.5], "line-opacity": 0.8 } }, below);
  map.addLayer({ id: "route-extra", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: { "line-join": "round" }, paint: { "line-color": ["get", "c"], "line-width": width(1.6, 3), "line-dasharray": [2, 1.5] } }, below);
  // Linjer som kör samma väg läggs bredvid varandra när man zoomat in (se bundleLegs).
  const offset = zoomed([[10.5, 0], [12, ["*", ["get", "o"], 3.2]], [16, ["*", ["get", "o"], 6.5]]]);
  map.addLayer({ id: "route-casing", type: "line", source: "bundles", filter: ["get", "main"],
    layout: round, paint: { "line-color": casing, "line-width": width(6, 12), "line-opacity": 0.95, "line-offset": offset } }, below);
  map.addLayer({ id: "route-line", type: "line", source: "bundles", filter: ["get", "main"],
    layout: round, paint: { "line-color": ["get", "c"], "line-width": width(3.2, 6.5), "line-offset": offset } }, below);
  map.addLayer({ id: "route-selected-casing", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: round, paint: { "line-color": casing, "line-width": width(9, 15) } }, below);
  map.addLayer({ id: "route-selected", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: round, paint: { "line-color": ["get", "c"], "line-width": width(5, 9) } }, below);
  // En vald färdväg på linjen, tjock och med pilar i färdriktningen.
  map.addLayer({ id: "route-pattern-casing", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: round, paint: { "line-color": casing, "line-width": width(10, 16) } }, below);
  map.addLayer({ id: "route-pattern", type: "line", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: round, paint: { "line-color": ["get", "c"], "line-width": width(6, 10) } }, below);
  map.addLayer({ id: "journey-done", type: "line", source: "journey", filter: ["==", ["get", "part"], "done"],
    layout: round, paint: { "line-color": ["get", "c"], "line-width": width(3.5, 7), "line-opacity": 0.3 } }, below);
  map.addLayer({ id: "journey-left", type: "line", source: "journey", filter: ["==", ["get", "part"], "left"],
    layout: round, paint: { "line-color": ["get", "c"], "line-width": width(5, 9) } }, below);
  // Linjenummer längs linjerna, som små skyltar i linjens färg.
  // Linjenummer längs linjerna först när man zoomat in; utzoomat räcker linjeraden.
  const badgeLayout = { "symbol-placement": "line", "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 12.5, 520, 16, 900], "icon-image": ["concat", "line-", ["get", "name"]], "icon-rotation-alignment": "viewport", "icon-padding": 6, "symbol-sort-key": ["get", "rank"] };
  // Streckade linjer (övriga turer och turer som går en annan väg) får lika bleka skyltar.
  // Lagret ligger under de vanliga skyltarna, som därför vinner där de krockar.
  map.addLayer({ id: "route-badges-minor", type: "symbol", source: "routes", minzoom: 12.5, filter: ["==", ["get", "r"], -1],
    layout: { ...badgeLayout, "icon-size": 0.85 }, paint: { "icon-opacity": 0.55 } });
  map.addLayer({ id: "route-badges", type: "symbol", source: "routes", minzoom: 12.5, filter: ["==", ["get", "r"], -1], layout: badgeLayout });
  map.addLayer({ id: "route-pattern-arrows", type: "symbol", source: "routes", filter: ["==", ["get", "r"], -1],
    layout: { "symbol-placement": "line", "symbol-spacing": 80, "icon-image": "pattern-arrow", "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-size": zoomed([[10, 0.8], [16, 1.3]]) } });
  map.addLayer({ id: "journey-stops", type: "circle", source: "journey", filter: ["==", ["get", "part"], "stop"],
    paint: { "circle-radius": zoomed([[11, 3.5], [16, 6]]), "circle-color": casing, "circle-stroke-color": ["get", "c"], "circle-stroke-width": 2.5 } });
  // Hållplatser: knutpunkter syns tidigt och större, övriga när man zoomat in.
  const stopPaint = (r) => ({ "circle-radius": r, "circle-color": casing, "circle-stroke-color": ink, "circle-stroke-width": zoomed([[11, 1.4], [16, 2.2]]) });
  map.addLayer({ id: "stop-hubs", type: "circle", source: "stops", minzoom: 11.5, maxzoom: 13.5, filter: ["get", "hub"], paint: stopPaint(zoomed([[10, 3], [13.5, 5.5]])) });
  map.addLayer({ id: "stops", type: "circle", source: "stops", minzoom: 13.5, paint: stopPaint(zoomed([[13.5, ["case", ["get", "hub"], 5.5, 3.5]], [16, ["case", ["get", "hub"], 8, 6.5]], [18, 9]])) });
  // Hållplatserna på vald linje, i linjens färg.
  map.addLayer({ id: "route-stops", type: "circle", source: "stops", filter: ["==", ["get", "g"], -1],
    paint: { "circle-radius": zoomed([[10, 3.5], [14, 5.5], [16, 8]]), "circle-color": casing, "circle-stroke-color": "#000", "circle-stroke-width": zoomed([[10, 2], [16, 3]]) } });
  map.addLayer({ id: "stop-selected", type: "circle", source: "stops", filter: ["==", ["get", "g"], -1],
    paint: { "circle-radius": zoomed([[10, 7], [16, 11]]), "circle-color": "#1d5c45", "circle-stroke-color": "#fff", "circle-stroke-width": 3.5 } });
  const label = (font, size) => ({
    "text-field": ["get", "name"], "text-font": [font], "text-size": size, "text-max-width": 9,
    "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": 0.9, "text-justify": "auto",
    "symbol-sort-key": ["-", 0, ["get", "n"]],
  });
  const labelPaint = { "text-color": ink, "text-halo-color": casing, "text-halo-width": 1.8, "text-halo-blur": 0.3 };
  map.addLayer({ id: "stop-names", type: "symbol", source: "stops", minzoom: 14.5, filter: ["!", ["get", "hub"]], layout: label("Noto Sans Regular", zoomed([[14.5, 11.5], [17, 13.5]])), paint: labelPaint });
  // Utzoomat visas bara de största knutpunkternas namn.
  map.addLayer({ id: "big-names", type: "symbol", source: "stops", minzoom: 11, maxzoom: 13, filter: ["get", "big"], layout: label("Noto Sans Bold", zoomed([[11, 11.5], [13, 12.5]])), paint: labelPaint });
  map.addLayer({ id: "hub-names", type: "symbol", source: "stops", minzoom: 13, filter: ["get", "hub"], layout: label("Noto Sans Bold", zoomed([[13, 12.5], [16, 14.5]])), paint: labelPaint });
  map.addLayer({ id: "route-stop-names", type: "symbol", source: "stops", minzoom: 12, filter: ["==", ["get", "g"], -1], layout: label("Noto Sans Bold", zoomed([[12, 11.5], [16, 13.5]])), paint: labelPaint });
  map.addLayer({ id: "stop-label", type: "symbol", source: "stops", filter: ["==", ["get", "g"], -1],
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 15, "text-offset": [0, 1.4], "text-anchor": "top", "text-allow-overlap": true },
    paint: { "text-color": ink, "text-halo-color": casing, "text-halo-width": 2.2 } });
  applyMapFilters();
  highlightGroup();
  if (state.journey) drawJourney(state.journey);
}

// Små skyltar med linjenumret i linjens färg, som bilder i kartan.
function addLineBadges() {
  const ratio = Math.min(3, Math.ceil(devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  // Vit pil åt höger (längs linjen) för en vald färdväg.
  if (!map.hasImage("pattern-arrow")) {
    canvas.width = canvas.height = 14 * ratio;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(12 * ratio, 7 * ratio);
    ctx.lineTo(3 * ratio, 2 * ratio);
    ctx.lineTo(5.5 * ratio, 7 * ratio);
    ctx.lineTo(3 * ratio, 12 * ratio);
    ctx.closePath();
    ctx.fill();
    map.addImage("pattern-arrow", ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: ratio });
  }
  const font = `700 ${12 * ratio}px "Atkinson Hyperlegible", system-ui, sans-serif`;
  for (const r of net.routes) {
    const id = `line-${r.name}`;
    if (map.hasImage(id)) continue;
    ctx.font = font;
    const w = Math.ceil(Math.max(26 * ratio, ctx.measureText(r.name).width + 12 * ratio)), hgt = 18 * ratio;
    const bw = 2 * ratio;
    canvas.width = w + bw * 2;
    canvas.height = hgt + bw * 2;
    ctx.font = font;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 7 * ratio);
    ctx.fill();
    ctx.fillStyle = r.c;
    ctx.beginPath();
    ctx.roundRect(bw, bw, w, hgt, 5 * ratio);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(r.name, canvas.width / 2, canvas.height / 2 + ratio);
    map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: ratio });
  }
}

function routeGeoJSON() {
  const features = [];
  net.routes.forEach((r, ri) =>
    r.variants.forEach((v, vi) =>
      features.push({ type: "Feature", properties: { r: ri, vi, c: r.c, name: r.name, kind: r.kind, main: v.main, extra: r.tier === "extra", rank: r.tier === "stom" ? 0 : 1 }, geometry: { type: "LineString", coordinates: v.path } }),
    ),
  );
  // Huvudlinjer sist så att de ritas överst i samma lager; stomlinjer överst.
  const rank = (f) => (f.properties.main ? 1 : 0) + (net.routes[f.properties.r].tier === "stom" ? 1 : 0);
  features.sort((a, b) => rank(a) - rank(b));
  return { type: "FeatureCollection", features };
}

// Huvudlinjerna i etapper med läge i knippet. Byggs om när urvalet av linjer ändras,
// så att bara de linjer som syns delar på vägen.
let bundleKey = null;
function bundleGeoJSON() {
  const idx = net.routes.map((_, i) => i).filter((i) => kindMatches(net.routes[i]) && net.routes[i].tier !== "extra");
  bundleKey = idx.join(",");
  const features = bundleLegs(net, stopGroup, idx).map(({ ri, pts, o }) => {
    const r = net.routes[ri];
    return { type: "Feature", properties: { r: ri, c: r.c, name: r.name, kind: r.kind, main: true, extra: false, o }, geometry: { type: "LineString", coordinates: pts } };
  });
  // Stomlinjer överst.
  features.sort((a, b) => (net.routes[a.properties.r].tier === "stom") - (net.routes[b.properties.r].tier === "stom"));
  return { type: "FeatureCollection", features };
}

function stopGeoJSON() {
  return {
    type: "FeatureCollection",
    features: groups.map((g, gi) => {
      const routes = [...g.routes];
      const n = routes.filter((r) => net.routes[r].tier !== "extra").length;
      return {
        type: "Feature",
        properties: {
          g: gi, name: shortName(g.name), n, hub: n >= 3, big: n >= 5,
          rs: `,${routes.join(",")},`,
          kinds: [...new Set(routes.map((r) => net.routes[r].kind))].join(","),
          extraOnly: routes.every((r) => net.routes[r].tier === "extra"),
        },
        geometry: { type: "Point", coordinates: [g.lon, g.lat] },
      };
    }),
  };
}

function applyMapFilters() {
  if (!map?.getLayer("route-line")) return;
  const shown = net.routes.map((_, i) => i).filter((i) => kindMatches(net.routes[i]) && net.routes[i].tier !== "extra").join(",");
  if (shown !== bundleKey) map.getSource("bundles").setData(bundleGeoJSON());
  const kindFilter = state.kind === "all" ? true : ["==", ["get", "kind"], state.kind];
  const sel = state.route ?? -1;
  const dim = state.route != null || state.bus != null;
  map.setFilter("route-casing", ["all", ["get", "main"], kindFilter, ["!", ["get", "extra"]]]);
  map.setFilter("route-line", ["all", ["get", "main"], kindFilter, ["!", ["get", "extra"]]]);
  map.setFilter("route-extra", state.extra ? ["all", ["get", "main"], kindFilter, ["get", "extra"]] : ["==", ["get", "r"], -1]);
  map.setFilter("route-alt", state.alt
    ? ["all", ["!", ["get", "main"]], kindFilter, state.extra ? true : ["!", ["get", "extra"]]]
    : ["all", ["==", ["get", "r"], sel], ["!", ["get", "main"]]]);
  for (const l of ["route-line", "route-extra"]) map.setPaintProperty(l, "line-opacity", dim ? 0.2 : 0.95);
  map.setPaintProperty("route-casing", "line-opacity", dim ? 0.5 : 0.95);
  map.setPaintProperty("route-alt", "line-opacity", dim && state.route == null ? 0.2 : 0.8);
  const pat = state.pattern && state.pattern.ri === state.route ? ["all", ["==", ["get", "r"], sel], ["in", ["get", "vi"], ["literal", state.pattern.variants]]] : ["==", ["get", "r"], -1];
  for (const l of ["route-pattern-casing", "route-pattern", "route-pattern-arrows"]) map.setFilter(l, pat);
  map.setPaintProperty("route-selected", "line-opacity", state.pattern ? 0.3 : 1);
  map.setFilter("route-selected", ["all", ["==", ["get", "r"], sel], ["get", "main"]]);
  map.setFilter("route-selected-casing", ["all", ["==", ["get", "r"], sel], ["get", "main"]]);
  // Linjenummer: alla visade linjer, eller bara den valda. Streckade linjer får bleka skyltar.
  const none = ["==", ["get", "r"], -1];
  map.setFilter("route-badges", state.bus != null ? none
    : state.route != null ? ["all", ["==", ["get", "r"], sel], ["get", "main"]]
    : ["all", ["get", "main"], kindFilter, ["!", ["get", "extra"]]]);
  map.setFilter("route-badges-minor", state.bus != null ? none
    : state.route != null ? ["all", ["==", ["get", "r"], sel], ["!", ["get", "main"]]]
    : ["any",
      state.extra ? ["all", ["get", "main"], kindFilter, ["get", "extra"]] : false,
      state.alt ? ["all", ["!", ["get", "main"]], kindFilter, state.extra ? true : ["!", ["get", "extra"]]] : false]);
  const stopFilter = ["all", state.kind === "all" ? true : ["in", state.kind, ["get", "kinds"]], state.extra ? true : ["!", ["get", "extraOnly"]]];
  map.setFilter("stops", stopFilter);
  map.setFilter("stop-hubs", ["all", stopFilter, ["get", "hub"]]);
  map.setFilter("stop-names", ["all", stopFilter, ["!", ["get", "hub"]]]);
  map.setFilter("hub-names", ["all", stopFilter, ["get", "hub"]]);
  map.setFilter("big-names", ["all", stopFilter, ["get", "big"]]);
  const onRoute = state.route != null ? ["in", `,${state.route},`, ["get", "rs"]] : false;
  map.setFilter("route-stops", onRoute || ["==", ["get", "g"], -1]);
  map.setFilter("route-stop-names", onRoute || ["==", ["get", "g"], -1]);
  if (state.route != null) map.setPaintProperty("route-stops", "circle-stroke-color", net.routes[state.route].c);
  // När en linje är vald tonas övriga hållplatser ner.
  for (const l of ["stops", "stop-hubs"]) {
    map.setPaintProperty(l, "circle-opacity", dim ? 0.45 : 1);
    map.setPaintProperty(l, "circle-stroke-opacity", dim ? 0.35 : 1);
  }
  for (const l of ["stop-names", "big-names", "hub-names"]) map.setPaintProperty(l, "text-opacity", dim ? 0.5 : 1);
}

function highlightGroup() {
  if (!map?.getLayer("stop-selected")) return;
  map.setFilter("stop-selected", ["==", ["get", "g"], state.group ?? -1]);
  map.setFilter("stop-label", ["==", ["get", "g"], state.group ?? -1]);
}

// --- Linjenätskarta ------------------------------------------------------------------

// Växla mellan den geografiska kartan och linjenätskartan. Linjerna glider mellan
// sina lägen på kartan och i tunnelbanekartan medan kartan tonas ut eller in.
let viewSwitch = 0;
async function setView(view) {
  if (view === state.view) return;
  state.view = view;
  const run = ++viewSwitch;
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-checked", b.dataset.view === view);
  document.body.classList.toggle("schem-view", view === "schem");
  const wrap = $("#schematic"), mapEl = $("#map");
  if (view === "schem") {
    wrap.hidden = false;
    drawSchematic();
    if (map) {
      wrap.classList.add("over-map");
      state.schem.jump(0, { geo: mapGeo() });
      mapEl.classList.add("faded");
      await state.schem.morph(1);
    }
    if (run !== viewSwitch) return;
    wrap.classList.remove("over-map");
    mapEl.style.visibility = "hidden";
  } else {
    mapEl.style.visibility = "";
    map?.resize();
    if (map && state.schem && !wrap.hidden) {
      wrap.classList.add("over-map");
      mapEl.classList.remove("faded");
      await state.schem.morph(0, { geo: mapGeo() });
    }
    if (run !== viewSwitch) return;
    mapEl.classList.remove("faded");
    wrap.classList.remove("over-map");
    wrap.hidden = true;
  }
}

// Hållplatsgruppernas lägen på kartan, i linjenätskartans koordinater.
function mapGeo() {
  const { k, tx, ty } = state.schem.transform();
  return (g) => {
    const p = map.project([groups[g].lon, groups[g].lat]);
    return [(p.x - tx) / k, (p.y - ty) / k];
  };
}

function drawSchematic() {
  const idx = net.routes.map((r, i) => i).filter((i) => routeShown(net.routes[i]));
  const layout = layoutSchematic(net, groups, stopGroup, idx, state.kind === "all" ? { power: 0.35 } : {});
  state.schem = renderSchematic($("#schematic"), net, groups, layout, {
    onStop: (g) => selectGroup(g),
    onRoute: (ri) => openLine(ri),
    onBus: (id) => openBus(id),
    selectedRoute: state.route,
    padding: viewPadding,
    extra: new Set(idx.filter((i) => net.routes[i].tier === "extra")),
  });
  syncSchemBuses();
}

// Bussarna i linjenätet, med samma urval som på kartan.
function syncSchemBuses() {
  if (!state.schem) return;
  state.schem.setVehicles([...state.vehicles.values()].filter((e) => !e.el.hidden).map((e) => ({
    id: e.data.id, ri: e.ri, lat: e.data.lat, lon: e.data.lon, stale: e.stale, sel: state.bus === e.data.id,
    label: `Linje ${net.routes[e.ri].name} mot ${e.data.destination || ""}`,
  })));
}

// Linjeraden: en färgad skylt per linje som visas, för att snabbt välja en linje.
function renderLegend() {
  const box = $("#legend");
  const list = net.routes.map((r, ri) => [r, ri]).filter(([r]) => routeShown(r))
    .sort(([a], [b]) => (a.tier === "extra") - (b.tier === "extra") || a.name.localeCompare(b.name, "sv", { numeric: true }));
  box.classList.toggle("has-sel", state.route != null);
  put(box, list.map(([r, ri]) => h("button", {
    type: "button", class: `badge${r.tier === "extra" ? " extra" : ""}${state.route === ri ? " sel" : ""}`, style: `--c:${r.c}`,
    "aria-pressed": state.route === ri, "aria-label": `Linje ${r.name}`, title: mainHeadsigns(r).map(shortName).join(" – "),
    onclick: () => (state.route === ri ? showHome() : openLine(ri)),
  }, r.name)));
}

// --- Linje -------------------------------------------------------------------------

function selectRoute(ri, { fit = false } = {}) {
  if (state.route !== ri) state.pattern = null;
  state.route = ri;
  renderLegend();
  applyMapFilters();
  state.schem?.select(ri);
  state.schem?.showPattern(state.pattern?.ri ?? null, state.pattern?.variants || []);
  for (const v of state.vehicles.values()) styleMarker(v);
  syncSchemBuses();
  if (ri != null && fit && map && state.view === "map") {
    if (!map.loaded()) return map.once("load", () => selectRoute(ri, { fit }));
    const b = new maplibregl.LngLatBounds();
    net.routes[ri].variants.filter((v) => v.main).forEach((v) => v.path.forEach((p) => b.extend(p)));
    map.fitBounds(b, { padding: fitPadding(), maxZoom: 15 });
  }
}

function openLine(ri, { fit = true } = {}) {
  if (ri == null) return;
  closeBus();
  state.group = null;
  highlightGroup();
  const r = net.routes[ri];
  if (!kindMatches(r)) setKind(r.kind);
  if (r.tier === "extra" && !state.extra) setExtra(true);
  sheet("half"); // före inpassningen, så att linjen hamnar ovanför arket på mobil
  selectRoute(ri, { fit });
  const main = r.variants.filter((v) => v.main).sort((a, b) => b.stops.length - a.stops.length)[0];
  const seen = new Set();
  const stops = (main?.stops || []).map((s) => stopGroup[s]).filter((g) => !seen.has(g) && seen.add(g));
  const buses = [...state.vehicles.values()].filter((v) => v.ri === ri).length;
  put($("#line"), 
    h("div", { class: "phead" }, badge(ri), h("div", { class: "grow" }, h("h2", {}, `Linje ${r.name}`), h("p", { class: "small muted" }, mainHeadsigns(r).map((x) => `mot ${shortName(x)}`).join(" · "))), closeBtn("Stäng linjen", showHome)),
    h("p", { class: "small muted" }, [
      r.tier === "stom" ? "Stomlinje" : r.tier === "linje" ? "Regelbunden trafik" : "Skol- eller specialturer",
      `ungefär ${r.daily} turer om dagen`,
      buses ? `${buses} ${buses === 1 ? "buss" : "bussar"} ute nu` : null,
    ].filter(Boolean).join(" · ")),
    r.variants.some((v) => !v.main) ? h("p", { class: "small muted" }, "Streckat på kartan: turer som går en annan väg.") : null,
    lineAlerts(r),
    linePatterns(ri),
    h("h3", { class: "label" }, `Hållplatser mot ${shortName(main?.headsign || "")}`),
    h("ol", { class: "stoplist" }, stops.map((gi) => h("li", {}, h("button", { type: "button", onclick: () => selectGroup(gi, { fly: true }) }, groups[gi].name)))),
  );
  showPart("line");
  updateUrl();
}

// Så går bussarna: linjens olika färdvägar per riktning. Ett tryck visar färdvägen på
// kartan och i linjenätet, med pilar i färdriktningen.
function linePatterns(ri) {
  const dirs = routePatterns(net, stopGroup, ri).filter((d) => d.routes.length);
  if (!dirs.some((d) => d.routes.length > 1)) return null;
  const name = (g) => shortName(groups[g].name);
  const box = h("div", { class: "patterns" });
  const render = () => put(box,
    h("h3", { class: "label" }, "Så går bussarna"),
    h("p", { class: "small muted" }, "Linjen kör på flera sätt. Tryck på en färdväg för att se den."),
    ...dirs.map((d) => h("div", {},
      h("p", { class: "small" }, h("b", {}, `Mot ${shortName(d.headsign)}`)),
      h("ul", { class: "plist" }, d.routes.map((p) => {
        const on = state.pattern?.ri === ri && state.pattern.key === `${d.dir}:${p.variants.join(",")}`;
        return h("li", {}, h("button", {
          type: "button", class: on ? "on" : "", "aria-pressed": on,
          onclick: () => {
            state.pattern = on ? null : { ri, key: `${d.dir}:${p.variants.join(",")}`, variants: p.variants };
            applyMapFilters();
            state.schem?.showPattern(state.pattern ? ri : null, state.pattern?.variants || []);
            if (state.pattern && map && state.view === "map") {
              const b = new maplibregl.LngLatBounds();
              p.variants.forEach((vi) => net.routes[ri].variants[vi].path.forEach((pt) => b.extend(pt)));
              map.fitBounds(b, { padding: fitPadding(), maxZoom: 14 });
            }
            render();
          },
        }, h("span", {}, `${name(p.from)} → ${name(p.to)}`, p.via.length ? h("small", {}, ` via ${p.via.map(name).join(", ")}`) : null),
        h("small", { class: "muted" }, `${p.trips} av ${d.total} turer`)));
      })),
      d.rest ? h("p", { class: "small muted" }, `och ${d.rest} ${d.rest === 1 ? "tur" : "turer"} på andra vägar`) : null)));
  render();
  return box;
}

function lineAlerts(r) {
  const list = state.alerts.filter((a) => a.routeIds?.includes(r.id));
  if (!list.length) return null;
  return h("button", { type: "button", class: "card warn", onclick: () => showTab("tab-info") }, h("span", { class: "ico" }, "!"),
    h("span", { class: "grow" }, h("b", {}, list[0].title), list.length > 1 ? h("small", {}, `${list.length} trafikmeddelanden`) : null), h("span", { class: "chev" }, "›"));
}

function closeBtn(label, fn) {
  return h("button", { type: "button", class: "close", "aria-label": label, onclick: fn }, "×");
}

// --- Hållplats ------------------------------------------------------------------------

function selectGroup(gi, { fly = false } = {}) {
  closeBus();
  selectRoute(null);
  state.group = gi;
  state.depLimit = 8;
  highlightGroup();
  showPart("stop");
  renderStop(true);
  updateUrl();
  sheet("half");
  const g = groups[gi];
  if (fly && state.view === "schem") state.schem?.focus(gi);
  else if (map && (fly || !map.getBounds().contains([g.lon, g.lat]))) map.flyTo({ center: [g.lon, g.lat], zoom: Math.max(map.getZoom(), 15), offset: offset() });
}

async function renderStop(fresh) {
  const gi = state.group;
  const g = groups[gi];
  const box = $("#stop");
  const fav = state.favs.includes(g.id);
  if (fresh) {
    put(box, 
      h("div", { class: "phead" }, h("span", { class: "ico stopico big" }, "H"), h("div", { class: "grow" }, h("h2", {}, g.name), h("p", { class: "small muted" }, stopLines(g))), closeBtn("Stäng hållplatsen", showHome)),
      h("div", { class: "row" },
        h("button", { type: "button", class: `secondary${fav ? " on" : ""}`, "aria-pressed": fav, onclick: () => toggleFav(g.id) }, fav ? "★ Sparad" : "☆ Spara"),
        h("button", { type: "button", class: "secondary", onclick: () => share(g) }, "Dela")),
      stopAlerts(g),
      h("div", { class: "deps-head" }, h("h3", { class: "label" }, "Kommande avgångar"), h("span", { class: "small muted" }, "Linje · mot · tid")),
      h("div", { id: "deps" }, h("p", { class: "muted" }, "Hämtar avgångar…")),
    );
  }
  let data;
  try {
    data = await fetchLive((l) => l.departures(g.stops), () => api("departures", { stopId: g.id }));
  } catch {
    if (state.group === gi) put($("#deps"), h("p", { class: "muted" }, "Avgångarna kunde inte hämtas just nu. Försök igen om en stund."));
    return;
  }
  if (state.group !== gi) return;
  const now = nowEpoch();
  const list = data.departures.filter((d) => (d.expected ?? d.scheduled) > now - 60);
  if (!list.length) return put($("#deps"), h("p", { class: "muted" }, "Inga avgångar närmaste dygnet."));
  const shown = list.slice(0, state.depLimit);
  const out = [];
  let day = null;
  shown.forEach((d, i) => {
    const t = d.expected ?? d.scheduled;
    const label = dayLabel(t);
    if (label !== day && (i > 0 || label !== "I dag")) out.push(h("li", { class: "day" }, label));
    day = label;
    out.push(departureRow(d, i === 0));
  });
  put($("#deps"), 
    h("ol", { class: "deps" }, out),
    list.length > shown.length ? h("button", { type: "button", class: "secondary wide", onclick: () => { state.depLimit += 12; renderStop(false); } }, "Visa fler avgångar") : null,
    list.some((d) => !d.realtime) ? h("p", { class: "small muted" }, "Tidtabell: ingen realtidsprognos än.") : null,
  );
}

// Linjerna vid en hållplats: de som visas på kartan, och hur många fler som stannar där.
function stopLines(g) {
  const all = [...g.routes].map((r) => net.routes[r]);
  const shown = all.filter(routeShown);
  const rest = all.length - shown.length;
  return [`Linje ${shown.map((r) => r.name).join(", ") || "–"}`, rest ? `+ ${rest} ${rest === 1 ? "linje" : "linjer"} till` : null].filter(Boolean).join(" ");
}

function departureRow(d, first) {
  const ri = routeByLine(d.line);
  const t = d.expected ?? d.scheduled;
  const delay = d.realtime ? Math.round((d.expected - d.scheduled) / 60) : 0;
  const cancelled = d.cancelled || d.skipped;
  const soon = t - nowEpoch() < 3600;
  const tag = cancelled ? h("span", { class: "tag cancel" }, "Inställd")
    : d.realtime ? h("span", { class: "tag rt" }, delay >= 1 ? `Realtid · ${delay} min sen` : "Realtid")
    : h("span", { class: "tag" }, "Tidtabell");
  const bus = [...state.vehicles.values()].find((v) => v.data.tripId === d.tripId);
  return h("li", { class: `dep${first ? " first" : ""}${cancelled ? " cancelled" : ""}` },
    h(bus ? "button" : "div", { class: "dep-in", type: bus ? "button" : null, onclick: bus ? () => openBus(bus.data.id) : null, "aria-label": bus ? `Visa bussen, linje ${d.line} mot ${d.destination}` : null },
      badge(ri, d.line),
      h("span", { class: "dest" }, first ? h("small", { class: "kicker" }, "Nästa avgång") : null, h("b", {}, d.destination || shortName(net.routes[ri]?.variants[0]?.headsign || "")), tag),
      h("span", { class: "time" }, cancelled ? h("b", { class: "cancel" }, hhmm(d.scheduled)) : h("b", {}, soon ? until(t) : hhmm(t)), h("small", {}, soon && !cancelled ? hhmm(t) : cancelled ? "" : until(t)))));
}

function stopAlerts(g) {
  const ids = new Set([...g.routes].map((r) => net.routes[r].id));
  const list = state.alerts.filter((a) => a.stopIds?.includes(g.id) || a.routeIds?.some((id) => ids.has(id)));
  if (!list.length) return null;
  return h("button", { type: "button", class: "card warn", onclick: () => showTab("tab-info") }, h("span", { class: "ico" }, "!"),
    h("span", { class: "grow" }, h("b", {}, list[0].title), h("small", {}, list.length > 1 ? `${list.length} trafikmeddelanden för den här hållplatsen` : "Trafikmeddelande")), h("span", { class: "chev" }, "›"));
}

function toggleFav(id) {
  state.favs = state.favs.includes(id) ? state.favs.filter((x) => x !== id) : [...state.favs, id];
  store.set("favs", state.favs);
  renderFavs();
  if (state.group != null) renderStop(true);
}

async function share(g) {
  const url = `${location.origin}${location.pathname}?stop=${g.id}`;
  try {
    if (navigator.share) await navigator.share({ title: `${g.name} · Busskollen Övik`, url });
    else { await navigator.clipboard.writeText(url); setStatus("Länken är kopierad", "live"); }
  } catch {}
}

// --- Startsidan -------------------------------------------------------------------------

function renderCommon() {
  const list = COMMON.map((n) => labelToGroup.get(n.toLowerCase())).filter((gi) => gi != null);
  $("#common").replaceChildren(...list.map((gi) => h("li", {}, h("button", { type: "button", onclick: () => selectGroup(gi, { fly: true }) }, h("span", { class: "ico stopico" }, "H"), h("span", { class: "grow" }, groups[gi].name), h("span", { class: "chev" }, "›")))));
}

function renderFavs() {
  const list = state.favs.map((id) => groupById.get(id)).filter((gi) => gi != null);
  put($("#favs"), ...(list.length ? [h("h3", { class: "label" }, "Sparade hållplatser"),
    h("ul", { class: "list" }, list.map((gi) => h("li", {}, h("button", { type: "button", onclick: () => selectGroup(gi, { fly: true }) }, h("span", { class: "ico star" }, "★"), h("span", { class: "grow" }, groups[gi].name), h("span", { class: "chev" }, "›")))))] : []));
}

function showNearby() {
  const box = $("#nearby");
  box.hidden = false;
  put(box, h("li", { class: "muted small" }, "Letar efter din position…"));
  showPart("home");
  if (!navigator.geolocation) return put(box, h("li", { class: "muted small" }, "Din webbläsare kan inte visa position."));
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const near = groups.map((g, gi) => [gi, distance(coords.latitude, coords.longitude, g.lat, g.lon)])
        .filter(([gi]) => [...groups[gi].routes].some((r) => routeShown(net.routes[r]) || state.kind === "all"))
        .sort((a, b) => a[1] - b[1]).slice(0, 5);
      put(box, h("li", { class: "label" }, "Närmast dig"), ...near.map(([gi, m]) => h("li", {}, h("button", { type: "button", onclick: () => selectGroup(gi, { fly: true }) },
        h("span", { class: "ico stopico" }, "H"), h("span", { class: "grow" }, groups[gi].name, h("small", {}, `≈ ${Math.max(1, Math.round((m * 1.3) / 80))} min · ${meters(m)} fågelvägen`)), h("span", { class: "chev" }, "›")))));
      if (map) {
        state.me?.remove();
        state.me = new maplibregl.Marker({ element: h("div", { class: "me" }) }).setLngLat([coords.longitude, coords.latitude]).addTo(map);
        if (state.view === "map") map.flyTo({ center: [coords.longitude, coords.latitude], zoom: 15, offset: offset() });
      }
      sheet("half");
    },
    () => put(box, h("li", { class: "muted small" }, "Positionen är inte tillgänglig. Tillåt plats i webbläsaren och försök igen.")),
    { enableHighAccuracy: true, timeout: 10_000 },
  );
}

// --- Reseplanerare och Min resa ------------------------------------------------------------

function initPlanner() {
  $("#swap").addEventListener("click", () => {
    const a = $("#trip-from").value;
    $("#trip-from").value = $("#trip-to").value;
    $("#trip-to").value = a;
  });
  $("#trip-form").addEventListener("submit", (e) => {
    e.preventDefault();
    planTrip();
  });
  $("#save-trip").addEventListener("click", () => {
    const from = labelToGroup.get($("#trip-from").value.trim().toLowerCase());
    const to = labelToGroup.get($("#trip-to").value.trim().toLowerCase());
    if (from == null || to == null) return ($("#trip-status").textContent = "Välj både Från och Till i listan först.");
    state.mytrips = [...state.mytrips.filter((t) => !(t.from === groups[from].id && t.to === groups[to].id)), { from: groups[from].id, to: groups[to].id }];
    store.set("mytrips", state.mytrips);
    $("#trip-status").textContent = "Sparad som Min resa på startsidan.";
    renderMyTrips();
  });
}

// Hämtar reseförslag. Varje svar täcker ett tidsfönster; sök vidare framåt tills
// det finns några resor att välja mellan.
async function fetchPlans(from, to, at = "", want = 4, onUpdate = null) {
  const seen = new Set();
  let plans = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetchLive((l) => l.plan(groupById.get(from), groupById.get(to), at), () => api("plan", { from, to, at }));
    plans = bestPlans([...plans, ...res.plans]);
    if (plans.length) onUpdate?.(plans, plans.length < want);
    if (plans.length >= want || !res.nextSearch || seen.has(res.nextSearch)) break;
    seen.add(res.nextSearch);
    at = res.nextSearch;
  }
  return plans;
}

// Släng resor som en annan resa slår (går samtidigt eller senare men är framme
// tidigare), och sortera efter avgång och sedan ankomst.
function bestPlans(plans) {
  const keep = plans.filter((p) => !plans.some((o) => o !== p && o.departure >= p.departure && o.arrival < p.arrival));
  return keep.sort((a, b) => a.departure - b.departure || a.arrival - b.arrival || a.legs.length - b.legs.length);
}

let planRun = 0;
async function planTrip() {
  const run = ++planRun;
  const from = labelToGroup.get($("#trip-from").value.trim().toLowerCase());
  const to = labelToGroup.get($("#trip-to").value.trim().toLowerCase());
  const status = $("#trip-status");
  const out = $("#trip-results");
  out.replaceChildren();
  if (from == null || to == null) return (status.textContent = "Välj hållplatser i listan.");
  if (from === to) return (status.textContent = "Välj två olika hållplatser.");
  const t = $("#trip-time").value;
  status.textContent = "Söker resor…";
  try {
    const show = (plans, more) => {
      if (run !== planRun) return;
      status.textContent = `${plans.length === 1 ? "1 resa" : `${plans.length} resor`} från ${groups[from].name}${more ? ", söker fler…" : ""}`;
      out.replaceChildren(...plans.slice(0, 8).map(planRow));
    };
    const plans = await fetchPlans(groups[from].id, groups[to].id, t ? new Date(t).toISOString() : "", 4, show);
    if (run !== planRun) return;
    if (plans.length) show(plans, false);
    else status.textContent = "Hittade ingen resa med högst ett byte. Prova Din Turs reseplanerare.";
  } catch {
    status.textContent = "Reseförslagen kunde inte hämtas just nu.";
  }
}

function planRow(p) {
  const mins = Math.round((p.arrival - p.departure) / 60);
  const day = dayLabel(p.departure);
  return h("li", {},
    h("div", { class: "head" }, h("span", {}, `${day === "I dag" ? "" : `${day} `}${hhmm(p.departure)} – ${hhmm(p.arrival)}`), h("span", { class: "muted" }, `${mins} min`)),
    ...p.legs.map((l, i) => h("div", { class: "leg" }, badge(routeByLine(l.line), l.line),
      h("span", {}, `${hhmm(l.from.time)} ${shortName(l.from.name)} → ${hhmm(l.to.time)} ${shortName(l.to.name)}`),
      i > 0 ? h("small", { class: "muted" }, `byte ${Math.round((l.from.time - p.legs[i - 1].to.time) / 60)} min`) : null)),
  );
}

function renderMyTrips() {
  const box = $("#mytrips");
  const trips = state.mytrips.filter((t) => groupById.has(t.from) && groupById.has(t.to));
  if (!trips.length) {
    return put(box, h("button", { type: "button", class: "card", onclick: () => { $("#planner").open = true; $("#trip-from").focus(); } },
      h("span", { class: "ico" }, "☆"), h("span", { class: "grow" }, h("b", {}, "Min resa"), h("small", {}, "Spara en sträcka du åker ofta")), h("span", { class: "chev" }, "›")));
  }
  put(box, h("h3", { class: "label" }, "Min resa"), ...trips.map((t) => {
    const a = groups[groupById.get(t.from)], b = groups[groupById.get(t.to)];
    const next = h("small", {}, "Hämtar nästa resa…");
    const card = h("div", { class: "card trip" },
      h("button", { type: "button", class: "grow", onclick: () => { $("#trip-from").value = a.label; $("#trip-to").value = b.label; $("#trip-time").value = ""; $("#planner").open = true; planTrip(); } },
        h("b", {}, `${a.name} → ${b.name}`), next),
      h("button", { type: "button", class: "close", "aria-label": "Ta bort Min resa", onclick: () => { state.mytrips = state.mytrips.filter((x) => x !== t); store.set("mytrips", state.mytrips); renderMyTrips(); } }, "×"));
    fetchPlans(t.from, t.to, "", 1).then((plans) => {
      const p = plans[0];
      next.textContent = p ? `Nästa: ${hhmm(p.departure)} (${until(p.departure)}) med ${[...new Set(p.legs.map((l) => l.line))].join(" + ")}, framme ${hhmm(p.arrival)}` : "Ingen resa hittades just nu.";
    }).catch(() => (next.textContent = "Kunde inte hämta nästa resa."));
    return card;
  }));
}

// --- Trafikinfo ------------------------------------------------------------------------------

function pollAlerts() {
  poll(async () => {
    const { alerts } = await fetchLive((l) => l.alerts(), () => api("alerts"));
    // Samma meddelande kommer ofta två gånger (Påverkan och Information): slå ihop.
    const byKey = new Map();
    for (const a of alerts) {
      const key = `${(a.title || "").trim()}|${[...(a.routeIds || [])].sort()}`;
      const prev = byKey.get(key);
      if (!prev || (a.description || "").length > (prev.description || "").length) byKey.set(key, a);
    }
    const ids = new Set(net.routes.map((r) => r.id));
    state.alerts = [...byKey.values()].filter((a) => !a.routeIds?.length || a.routeIds.some((r) => ids.has(r)));
    renderAlertSummary();
    if (!$("#view-info").hidden) renderAlerts();
  }, 300);
}

function relevantAlerts() {
  if (state.group != null) {
    const g = groups[state.group];
    const ids = new Set([...g.routes].map((r) => net.routes[r].id));
    return { scope: g.name, list: state.alerts.filter((a) => a.stopIds?.includes(g.id) || a.routeIds?.some((id) => ids.has(id))) };
  }
  if (state.route != null) {
    const r = net.routes[state.route];
    return { scope: `linje ${r.name}`, list: state.alerts.filter((a) => a.routeIds?.includes(r.id)) };
  }
  const ids = new Set(net.routes.filter(kindMatches).map((r) => r.id));
  return { scope: null, list: state.alerts.filter((a) => !a.routeIds?.length || a.routeIds.some((id) => ids.has(id))) };
}

function renderAlertSummary() {
  const { list } = relevantAlerts();
  const count = $("#info-count");
  count.hidden = !list.length;
  count.textContent = list.length;
  const card = $("#alert-card");
  card.hidden = !list.length;
  if (list.length) card.replaceChildren(h("span", { class: "ico" }, "!"), h("span", { class: "grow" }, h("b", {}, list.length === 1 ? "1 trafikmeddelande" : `${list.length} trafikmeddelanden`), h("small", {}, list[0].title)), h("span", { class: "chev" }, "›"));
}

function renderAlerts() {
  const { scope, list } = relevantAlerts();
  $("#info-scope").textContent = scope ? `Meddelanden som berör ${scope}.` : "Aktuella meddelanden från Din Tur.";
  const lineNames = (a) => (a.routeIds || []).map((id) => net.routes.findIndex((r) => r.id === id)).filter((ri) => ri >= 0);
  put($("#alerts"), ...(list.length ? list.map((a) => h("article", { class: `alert ${a.severity || ""}` },
    h("div", { class: "row" }, ...lineNames(a).map((ri) => badge(ri)), h("h3", {}, a.title)),
    h("p", { class: "small" }, (a.description || "").trim()))) : [h("p", { class: "muted" }, "Inga trafikmeddelanden just nu.")]));
}

// --- Bussar ------------------------------------------------------------------------------------

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
      const { vehicles } = await fetchLive((l) => l.vehicles(), () => api("vehicles"));
      renderVehicles(vehicles);
      setStatus(`Live · ${timeFmt.format(new Date())}`, "live");
      if (state.pendingBus) { const id = state.pendingBus; state.pendingBus = null; if (state.vehicles.has(id)) openBus(id); }
      if (state.bus) refreshBus();
    } catch {
      setStatus("Realtid saknas just nu", "warn");
    }
  }, CONFIG.vehicleSeconds);
}

function renderVehicles(list) {
  const seen = new Set();
  for (const v of list) {
    const ri = routeByLine(v.line);
    if (ri == null) continue; // buss på en linje utanför Övik
    seen.add(v.id);
    let entry = state.vehicles.get(v.id);
    if (!entry) {
      const el = h("button", { type: "button", class: "bus", onclick: (e) => { e.stopPropagation(); openBus(v.id); } },
        h("span", { class: "arrow" }), h("span", { class: "pill" }, h("svg", { "aria-hidden": "true" }), h("span", { class: "num" })));
      el.querySelector("svg").outerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="13" rx="2.5"/><path d="M6 11h12M9 20v-3M15 20v-3"/></svg>';
      entry = { el, marker: new maplibregl.Marker({ element: el }).setLngLat([v.lon, v.lat]).addTo(map) };
      state.vehicles.set(v.id, entry);
    } else {
      glide(entry.marker, [v.lon, v.lat]);
    }
    Object.assign(entry, { data: v, ri, stale: v.stale || nowEpoch() - v.timestamp > STALE_SECONDS });
    styleMarker(entry);
  }
  for (const [id, entry] of state.vehicles) {
    if (seen.has(id)) continue;
    entry.marker.remove();
    state.vehicles.delete(id);
  }
  syncSchemBuses();
}

function styleMarker(entry) {
  const r = net.routes[entry.ri];
  const { el, data } = entry;
  el.style.setProperty("--c", r.c);
  el.querySelector(".num").textContent = r.name;
  el.classList.toggle("stale", !!entry.stale);
  el.hidden = !kindMatches(r) || (!state.extra && r.tier === "extra" && state.route !== entry.ri);
  el.classList.toggle("dim", (state.route != null && state.route !== entry.ri) || (state.bus != null && state.bus !== data.id));
  el.classList.toggle("sel", state.bus === data.id);
  if (data.bearing && !entry.stale) el.style.setProperty("--b", `${data.bearing}deg`);
  el.classList.toggle("nobearing", !data.bearing || entry.stale);
  el.setAttribute("aria-label", `Linje ${r.name} mot ${data.destination || ""}${entry.stale ? ", gammal position" : ""}`);
}

// Flytta markören mjukt till nästa GPS-läge.
function glide(marker, to) {
  const from = marker.getLngLat().toArray();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return marker.setLngLat(to);
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 1500);
    marker.setLngLat([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]);
    if (state.follow && state.bus && marker === state.vehicles.get(state.bus)?.marker) map.easeTo({ center: marker.getLngLat(), offset: offset(), duration: 0 });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function openBus(id) {
  const entry = state.vehicles.get(id);
  if (!entry) return;
  state.group = null;
  highlightGroup();
  state.route = null;
  state.bus = id;
  state.journey = null;
  applyMapFilters();
  state.schem?.select(null);
  for (const v of state.vehicles.values()) styleMarker(v);
  syncSchemBuses();
  $("#follow").hidden = false;
  showPart("bus");
  sheet("half");
  updateUrl();
  renderBus(entry, null);
  if (state.view === "map") map.easeTo({ center: entry.marker.getLngLat(), zoom: Math.max(map.getZoom(), 14), offset: offset() });
  await refreshBus();
}

async function refreshBus() {
  const id = state.bus;
  const entry = state.vehicles.get(id);
  if (!entry) return renderBus(null, null);
  let journey = null;
  try { journey = (await fetchLive((l) => l.journey(id), () => api("journey", { vehicleId: id }))).journey; } catch {}
  if (state.bus !== id) return;
  state.journey = journey;
  renderBus(entry, journey);
  if (journey && map?.getSource("journey")) drawJourney(journey);
}

function closeBus() {
  if (!state.bus) return;
  state.bus = null;
  state.journey = null;
  setFollow(false);
  $("#follow").hidden = true;
  map?.getSource("journey")?.setData({ type: "FeatureCollection", features: [] });
  applyMapFilters();
  for (const v of state.vehicles.values()) styleMarker(v);
  syncSchemBuses();
}

function setFollow(on) {
  state.follow = on;
  $("#follow").setAttribute("aria-pressed", on);
  const entry = state.vehicles.get(state.bus);
  if (on && entry && map) map.easeTo({ center: entry.marker.getLngLat(), zoom: Math.max(map.getZoom(), 15), offset: offset() });
}

function renderBus(entry, journey) {
  const box = $("#bus");
  if (!entry) {
    return put(box, h("div", { class: "phead" }, h("div", { class: "grow" }, h("h2", {}, "Bussen syns inte längre"), h("p", { class: "small muted" }, "Den har troligen kört klart sin tur.")), closeBtn("Stäng", showHome)));
  }
  const { data, ri } = entry;
  const r = net.routes[ri];
  const stops = journey?.stops || [];
  const next = stops.find((s) => !s.passed && !s.skipped);
  const after = next ? stops.slice(stops.indexOf(next) + 1).filter((s) => !s.skipped) : [];
  const dist = next ? distance(data.lat, data.lon, next.lat, next.lon) : null;
  const dir = compass(data.bearing);
  put(box, 
    h("div", { class: "phead" }, badge(ri), h("div", { class: "grow" }, h("h2", {}, `Mot ${shortName(data.destination || mainHeadsigns(r)[0] || "")}`),
      h("p", { class: "small muted" }, [`Position ${ago(data.timestamp)} sedan`, entry.stale ? "gammal position" : dir ? `färdas åt ${dir}` : null].filter(Boolean).join(" · "))), closeBtn("Stäng bussen", showHome)),
    journey?.cancelled ? h("p", { class: "card warn" }, "Turen är inställd.") : null,
    next ? h("button", { type: "button", class: "card nextstop", onclick: () => selectGroup(groupById.get(next.id) ?? null, { fly: true }) },
      h("span", { class: "grow" }, h("small", { class: "kicker" }, "Nästa hållplats"), h("b", { class: "big" }, next.name),
        h("span", { class: "small" }, `${hhmm(next.expected ?? next.scheduled)}${dist != null ? ` · cirka ${meters(dist)} bort` : ""}`)),
      h("span", { class: "chev" }, "›")) : h("p", { class: "muted" }, journey ? "Bussen har nått sin sista hållplats." : "Hämtar turen…"),
    after.length ? h("div", { class: "deps-head" }, h("h3", { class: "label" }, "Därefter"), h("span", { class: "small muted" }, `${after.length} stopp`)) : null,
    after.length ? h("ol", { class: "timeline" }, after.map((s) => h("li", {}, h("button", { type: "button", onclick: () => groupById.has(s.id) && selectGroup(groupById.get(s.id), { fly: true }) },
      h("span", { class: "grow" }, s.name, h("small", {}, s.realtime ? "Realtid" : "Tidtabell")), h("span", { class: "time" }, hhmm(s.expected ?? s.scheduled)))))) : null,
    h("button", { type: "button", class: "secondary wide", onclick: () => openLine(ri) }, `Visa hela linje ${r.name}`),
  );
}

function compass(b) {
  if (b == null || b === 0) return null;
  return ["norr", "nordost", "öster", "sydost", "söder", "sydväst", "väster", "nordväst"][Math.round(((b % 360) + 360) % 360 / 45) % 8];
}

// Ritar turens körväg: körd del blek, återstående del stark.
function drawJourney(journey) {
  const entry = state.vehicles.get(state.bus);
  if (!entry || !journey.shape?.length) return;
  const c = net.routes[entry.ri].c;
  const line = journey.shape.map(([lat, lon]) => [lon, lat]);
  const pos = [entry.data.lon, entry.data.lat];
  let best = 0, bestD = Infinity;
  line.forEach((p, i) => {
    const d = (p[0] - pos[0]) ** 2 * 0.2 + (p[1] - pos[1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  const features = [];
  if (best > 0) features.push({ type: "Feature", properties: { part: "done", c }, geometry: { type: "LineString", coordinates: [...line.slice(0, best + 1), pos] } });
  features.push({ type: "Feature", properties: { part: "left", c }, geometry: { type: "LineString", coordinates: [pos, ...line.slice(best + 1)] } });
  for (const s of journey.stops || []) if (!s.passed && !s.skipped) features.push({ type: "Feature", properties: { part: "stop", c }, geometry: { type: "Point", coordinates: [s.lon, s.lat] } });
  map.getSource("journey")?.setData({ type: "FeatureCollection", features });
}
