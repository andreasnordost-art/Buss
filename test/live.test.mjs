// Avgångar, bussens tur och reseförslag ur den egna tidtabellen och realtiden.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { groupStops } from "../public/network.js";
import { createLive, serviceDayStart } from "../public/live.js";

const out = mkdtempSync(`${tmpdir()}/buss-`);
execFileSync("node", ["scripts/build-data.mjs", "--dir", "test/fixture", "--out", out, "--start", "2026-10-21"]);
const net = JSON.parse(readFileSync(`${out}/network.json`, "utf8"));
const { groups, stopGroup } = groupStops(net);
const gi = (name) => groups.findIndex((g) => g.name === name);

// Onsdag 21 oktober 2026 kl. 06:55 svensk sommartid.
const base = serviceDayStart("2026-10-21");
assert.equal(new Date(base * 1000).toISOString(), "2026-10-20T22:00:00.000Z", "trafikdagen börjar vid midnatt svensk tid");
assert.equal(serviceDayStart("2026-10-25"), Date.parse("2026-10-24T23:00:00Z") / 1000, "dagen sommartiden slutar räknas från klockan 12 minus 12 timmar");
let now = base + 6 * 3600 + 55 * 60;
Date.now = () => now * 1000;

let feeds = {
  updates: { data: { T1: { s: [[1, 0], [2, 120]] } } },
  vehicles: { time: now, data: [{ id: "bus-1", trip: "T1", lat: 63.2905, lon: 18.721, bearing: 90, ts: now - 5 }, { id: "bus-2", trip: "OKÄND", lat: 63.29, lon: 18.72, ts: now }] },
  alerts: { data: [{ id: "a", header: "Omledning", text: "Text", routes: ["R1"], stops: [] }] },
};
const getJSON = async (url) => {
  const m = url.match(/^https:\/\/rt\.test\/(\w+)$/);
  if (m) {
    if (!feeds[m[1]]) throw new Error("ingen realtid");
    return structuredClone(feeds[m[1]]);
  }
  return JSON.parse(readFileSync(`${out}/${url.replace(/^data\//, "")}`, "utf8"));
};
const live = createLive(net, { groups, stopGroup }, "https://rt.test", getJSON);
await live.ready;

// Avgångar från Resecentrum: T1 07:00 i tid (förseningen gäller från hållplats 2), T4 09:00.
let { departures } = await live.departures(groups[gi("Örnsköldsvik Resecentrum")].stops);
assert.deepEqual(departures.slice(0, 2).map((d) => [d.tripId, d.line, d.destination]), [["T1", "1", "Gullänget"], ["T4", "40", "Bjästa"]]);
assert.equal(departures[0].expected, base + 7 * 3600);
assert.equal(departures[0].realtime, true);
assert.equal(departures[1].realtime, false);
// Vid Torget är T1 två minuter sen.
({ departures } = await live.departures(groups[gi("Torget, Övik")].stops));
const t1 = departures.find((d) => d.tripId === "T1");
assert.equal(t1.expected - t1.scheduled, 120);
// Sista hållplatsen är ingen avgång.
({ departures } = await live.departures(groups[gi("Gullänget")].stops));
assert.ok(!departures.some((d) => d.tripId === "T1"));

// Bussar: bara de som kör en känd tur, och deras tur med passerade hållplatser.
const { vehicles } = await live.vehicles();
assert.deepEqual(vehicles.map((v) => [v.id, v.line, v.tripId]), [["bus-1", "1", "T1"]]);
const { journey } = await live.journey("bus-1");
assert.deepEqual(journey.stops.map((s) => s.name), ["Örnsköldsvik Resecentrum", "Torget, Övik", "Sjukhuset", "Gullänget"]);
assert.deepEqual(journey.stops.map((s) => s.passed), [true, false, false, false]);
assert.ok(journey.shape.length > 2 && journey.shape[0][0] > 60, "formen är [lat, lon]");
await assert.rejects(live.journey("bus-2"));

// Reseförslag: direkt Resecentrum -> Bjästa, och Gullänget -> Bjästa med byte på Resecentrum.
let res = await live.plan(gi("Örnsköldsvik Resecentrum"), gi("Bjästa"), "");
assert.equal(res.plans[0].legs.length, 1);
assert.equal(res.plans[0].arrival, base + 9.5 * 3600);
now = base + 7.5 * 3600;
res = await live.plan(gi("Gullänget"), gi("Bjästa"), "");
const p = res.plans[0];
assert.deepEqual(p.legs.map((l) => [l.line, l.from.name, l.to.name]), [["1", "Gullänget", "Örnsköldsvik Resecentrum"], ["40", "Örnsköldsvik Resecentrum", "Bjästa"]]);
assert.equal(p.departure, base + 8 * 3600);
assert.ok(Date.parse(res.nextSearch) > now * 1000);

// Störningar får sidans form.
const { alerts } = await live.alerts();
assert.deepEqual(alerts[0], { id: "a", title: "Omledning", description: "Text", routeIds: ["R1"], stopIds: [] });

// Utan realtid visas tidtabellen.
feeds.updates = { data: { T3: { s: [[1, 60]] } } };
now += 60;
({ departures } = await live.departures(groups[gi("Sjukhuset")].stops));
assert.equal(departures.find((d) => d.tripId === "T3").realtime, true);
feeds = {};
now += 60;
({ departures } = await live.departures(groups[gi("Sjukhuset")].stops));
assert.equal(departures.find((d) => d.tripId === "T3").realtime, false);
await assert.rejects(live.vehicles(), "sidan faller tillbaka på reserven när bussarna inte går att hämta");
console.log("live ok");
