// Linjenätskartan: alla delsträckor ska gå i 0°, 45° eller 90°, och varje hållplats ska få ett läge.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { groupStops } from "../public/network.js";
import { layoutSchematic } from "../public/schematic.js";

const out = mkdtempSync(`${tmpdir()}/buss-`);
execFileSync("node", ["scripts/build-data.mjs", "--dir", "test/fixture", "--out", out, "--start", "2026-10-21"]);
const net = JSON.parse(readFileSync(`${out}/network.json`, "utf8"));
const { groups, stopGroup } = groupStops(net);
const layout = layoutSchematic(net, groups, stopGroup, net.routes.map((_, i) => i));

for (const c of layout.chains) {
  for (let i = 1; i < c.line.length; i++) {
    const dx = Math.abs(c.line[i][0] - c.line[i - 1][0]), dy = Math.abs(c.line[i][1] - c.line[i - 1][1]);
    assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, `sned sträcka ${JSON.stringify(c.line)}`);
  }
}
const drawn = new Set(layout.chains.flatMap((c) => c.nodes));
for (const g of drawn) assert.ok(layout.pos.get(g), `${groups[g].name} saknar läge`);
assert.equal(drawn.size, groups.length, "alla hållplatser ritas");
console.log("schematic ok");
