// Kontrollerar att svaren från Busskollens API blir ett linjenät som kartan kan rita.
import assert from "node:assert/strict";
import * as cfg from "../config.mjs";
import { networkFromOriginal } from "../scripts/lib/original.mjs";

const stop = (id, name, lat, lon, seq) => ({ id, name, lat, lon, seq });
const A = stop("A", "Centrum", 63.29, 18.71, 1);
const B = stop("B", "Skolan", 63.30, 18.72, 2);
const C = stop("C", "Ändhållplatsen", 63.31, 18.73, 3);
const leg = (line, variant, from, to, trips, extra = {}) => ({
  line, variant, from, to, trips, overview: true, backbone: false, roadUnavailable: false,
  shape: [[from.lat, from.lon], [(from.lat + to.lat) / 2, from.lon + 0.004], [to.lat, to.lon]], ...extra,
});

const stops = {
  stops: [A, B, C].map(({ id, name, lat, lon }) => ({ id, name, lat, lon, memberIds: [id], lines: ["401"] })),
  routes: [{ id: "R401", line: "401", tripsToday: 30 }, { id: "R50", line: "50", tripsToday: 4 }],
};
const town = {
  routes: [],
  legs: [
    // Utåt: A -> B -> C, 100 turer i veckan.
    leg("401", "v1", { ...A, seq: 1 }, { ...B, seq: 2 }, 100),
    leg("401", "v1", { ...B, seq: 2 }, { ...C, seq: 3 }, 100),
    // Inåt: C -> A.
    leg("401", "v2", { ...C, seq: 1 }, { ...B, seq: 2 }, 90),
    leg("401", "v2", { ...B, seq: 2 }, { ...A, seq: 3 }, 90),
    // Förstärkning utåt som bara går A -> B.
    leg("401", "v3", { ...A, seq: 1 }, { ...B, seq: 2 }, 5, { overview: false }),
  ],
};
const rural = {
  routes: [{ variant: "v9", line: "50", trips: 20, shape: [[63.29, 18.71], [63.0, 18.5]] }],
  legs: [leg("50", "v9", { ...A, seq: 1 }, { id: "Z", name: "Härnösand", lat: 63.0, lon: 18.5, seq: 2 }, 20)],
};

const net = networkFromOriginal({ stops, scopes: [{ kind: "tatort", geometry: town }, { kind: "landsbygd", geometry: rural }] }, cfg);

assert.deepEqual(net.routes.map((r) => r.name), ["50", "401"], "linjer sorteras på nummer");
const r401 = net.routes.find((r) => r.name === "401");
assert.equal(r401.id, "R401");
assert.equal(r401.kind, "tatort");
assert.equal(r401.tier, "stom", "30 turer i dag i tätorten ger stomlinje");
assert.equal(r401.variants.length, 3);
const mains = r401.variants.filter((v) => v.main);
assert.equal(mains.length, 2, "en huvudform per riktning");
assert.notEqual(mains[0].dir, mains[1].dir);
assert.ok(!r401.variants.find((v) => v.trips === 5).main, "förstärkningsturen är inte huvudform");
const out = mains.find((v) => v.trips === 100);
assert.deepEqual(out.stops.map((i) => net.stops[i][1]), ["Centrum", "Skolan", "Ändhållplatsen"]);
assert.equal(out.headsign, "Ändhållplatsen");
assert.ok(out.path.length >= 3 && out.path.every(([lon, lat]) => lon > 18 && lat > 63), "formen är [lon, lat] längs vägen");

const r50 = net.routes.find((r) => r.name === "50");
assert.equal(r50.kind, "landsbygd");
assert.equal(r50.variants[0].path.length, 2, "hela variantens form används när den finns");
assert.ok(net.stops.some(([id, name]) => id === "Z" && name === "Härnösand"), "hållplatser som bara finns i sträckorna tas med");

console.log("original: ok");
