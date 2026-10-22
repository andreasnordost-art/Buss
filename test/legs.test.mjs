// Raka etapper i formerna ersätts med vägen från andra turer.
import assert from "node:assert/strict";
import { repairStraightLegs } from "../scripts/lib/legs.mjs";

// Tre hållplatser längs en böjd väg: A (väst), B (norrut i kurvan), C (öst).
const coords = [[18.40, 63.40], [18.43, 63.41], [18.46, 63.40]];
const road = [[18.40, 63.40], [18.415, 63.407], [18.43, 63.41], [18.445, 63.407], [18.46, 63.40]];
const routes = [
  { variants: [{ stops: [0, 1, 2], path: road.map((p) => [...p]) }] },
  // Expressturen hoppar över B och dess form är ett rakt streck A–C.
  { variants: [{ stops: [0, 2], path: [coords[0], coords[2]] }] },
  // Rakt streck utan någon annan tur längs vägen.
  { variants: [{ stops: [2, 3], path: [coords[2], [18.52, 63.40]] }] },
];
coords.push([18.52, 63.40]);

const count = await repairStraightLegs(routes, coords);
assert.deepEqual(count, { fixed: 1, routed: 0, left: 1 });
assert.deepEqual(routes[1].variants[0].path, road, "expressturen följer vägen via B");
assert.deepEqual(routes[0].variants[0].path, road, "vägföljande former lämnas orörda");
assert.equal(routes[2].variants[0].path.length, 2, "utan väg att låna blir strecket kvar");

// Med vägnavigering slås det sista strecket upp.
const routed = await repairStraightLegs(routes, coords, async (a, b) => [a, [18.49, 63.405], b]);
assert.equal(routed.routed, 1);
assert.equal(routes[2].variants[0].path.length, 3);
console.log("legs ok");
