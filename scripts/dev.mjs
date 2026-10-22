// Utvecklingsserver: visar public/ och kör realtidsproxyn lokalt, så att
// /vehicles, /updates och /alerts hämtas från Trafiklab och /api/* från Busskollens API.
//
//   TRAFIKLAB_STATIC_KEY=... npm run build && TRAFIKLAB_RT_KEY=... npm run dev   ->  http://localhost:8080

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import * as cfg from "../config.mjs";
import worker from "../worker/src/index.js";

// Enkel cache i minnet i stället för Cloudflares, så att Trafiklab-kvoten räcker även här.
const memory = new Map();
globalThis.caches ??= {
  default: {
    async match(req) {
      const hit = memory.get(req.url);
      return hit && hit.until > Date.now() ? hit.res.clone() : undefined;
    },
    async put(req, res) {
      const age = Number(res.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] || 0);
      memory.set(req.url, { res, until: Date.now() + age * 1000 });
    },
  },
};

const port = Number(process.env.PORT) || 8080;
const root = new URL("../public/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (/^\/(api\/|vehicles|updates|alerts)/.test(url.pathname)) {
      const env = { TRAFIKLAB_RT_KEY: process.env.TRAFIKLAB_RT_KEY, ORIGINAL_API: process.env.ORIGINAL_API || cfg.ORIGINAL_API };
      const up = await worker.fetch(new Request(`http://localhost${url.pathname}${url.search}`), env, { waitUntil() {} });
      res.writeHead(up.status, { "Content-Type": "application/json" });
      return res.end(Buffer.from(await up.arrayBuffer()));
    }
    const path = normalize(join(root, url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname));
    if (!path.startsWith(root)) throw new Error("utanför");
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Hittades inte");
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
