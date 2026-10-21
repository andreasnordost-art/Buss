// Hämtar linjenätet från Busskollens API (originalsidan) och sparar det som
// public/data/network.json. Körs varje natt av GitHub Action i stället för
// GTFS-bygget tills egna Trafiklab-nycklar finns.
//
//   node scripts/import-original.mjs
//   node scripts/import-original.mjs --from mapp/med/sparade/svar   (för test)
//
// Avgångar, reseförslag och bussar hämtas live av sidan via realtidsproxyn.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as cfg from "../config.mjs";
import { networkFromOriginal } from "./lib/original.mjs";

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const fromDir = arg("--from");
const outDir = arg("--out") || "public/data";
const base = process.env.ORIGINAL_API || cfg.ORIGINAL_API;

async function get(path, file) {
  if (fromDir) return JSON.parse(readFileSync(`${fromDir}/${file}`, "utf8"));
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const [stops, town, rural] = await Promise.all([
  get("/api/stops", "stops.json"),
  get("/api/network-geometry", "geometry.json"),
  get("/api/network-geometry?scope=rural", "geometry-rural.json"),
]);

const network = networkFromOriginal({ stops, scopes: [{ kind: "tatort", geometry: town }, { kind: "landsbygd", geometry: rural }] }, cfg);
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/network.json`, JSON.stringify(network));
console.log(`${network.routes.length} linjer, ${network.stops.length} hållplatser`);
