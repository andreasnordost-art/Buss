// Bygger data från en liten påhittad GTFS och kontrollerar resultatet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const out = mkdtempSync(`${tmpdir()}/buss-`);
execFileSync("node", ["scripts/build-data.mjs", "--dir", "test/fixture", "--out", out, "--start", "2026-10-21"]);
const net = JSON.parse(readFileSync(`${out}/network.json`, "utf8"));

const names = net.routes.map((r) => r.name);
assert.deepEqual(names, ["1", "40", "99"], "linjer sorteras numeriskt");
const r1 = net.routes[0];
assert.equal(r1.kind, "tatort");
assert.equal(net.routes[1].kind, "landsbygd");
// Formen följer shape_pt_sequence numeriskt: första punkten ska vara Resecentrum.
assert.deepEqual(r1.variants[0].path[0], [18.7153, 63.2906]);
// Den raka delen förenklas bort men kurvorna behålls.
assert.equal(r1.variants[0].path.length, 6);
assert.equal(r1.variants.filter((v) => v.main).length, 2, "en huvudform per riktning");
// Linje 99 börjar i Umeå: den ritas bara inom kommunen och Umeå C kommer inte med.
assert.ok(!net.stops.some((s) => s[1] === "Umeå C"), "hållplatser utanför kommunen ritas inte");
assert.equal(net.routes[2].variants[0].stops.length, 2);
assert.equal(net.source, "gtfs");

const thursday = JSON.parse(readFileSync(`${out}/days/2026-10-22.json`, "utf8"));
assert.equal(thursday.trips.length, 2, "WK är inställd 22 okt via calendar_dates");
const wednesday = JSON.parse(readFileSync(`${out}/days/2026-10-21.json`, "utf8"));
const t1 = wednesday.trips.find((t) => t[0] === "T1");
assert.equal(t1[5][1], 25380, "tid utan värde interpoleras");
assert.equal(wednesday.trips.find((t) => t[0] === "T5")[4][0], -1, "hållplats utanför kommunen blir -1 i dagfilen");
assert.deepEqual(JSON.parse(readFileSync(`${out}/days/index.json`, "utf8"))[0], "2026-10-20", "gårdagen tas med");
console.log("build ok");
