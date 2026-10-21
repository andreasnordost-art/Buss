// Utvecklingsserver: visar public/ och skickar /api/* vidare till Busskollens API,
// precis som realtidsproxyn gör på riktigt.
//
//   node scripts/import-original.mjs && node scripts/dev.mjs   ->  http://localhost:8080

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import * as cfg from "../config.mjs";

const port = Number(process.env.PORT) || 8080;
const root = new URL("../public/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      const up = await fetch(`${process.env.ORIGINAL_API || cfg.ORIGINAL_API}${url.pathname}${url.search}`);
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
