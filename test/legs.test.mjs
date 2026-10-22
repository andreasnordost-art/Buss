// Raka etapper i formerna ersätts med vägen från andra turer.
import assert from "node:assert/strict";
import { repairStraightLegs, splitLegs } from "../scripts/lib/legs.mjs";

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
assert.deepEqual([count.fixed, count.routed, count.left], [1, 0, 1]);
assert.deepEqual(routes[1].variants[0].path, road, "expressturen följer vägen via B");
assert.deepEqual(routes[0].variants[0].path, road, "vägföljande former lämnas orörda");
assert.equal(routes[2].variants[0].path.length, 2, "utan väg att låna blir strecket kvar");

// Med vägnavigering slås det sista strecket upp.
const routed = await repairStraightLegs(routes, coords, async (a, b) => [a, [18.49, 63.405], b]);
assert.equal(routed.routed, 1);
assert.equal(routes[2].variants[0].path.length, 3);
console.log("legs ok");

// En tur som svänger ut till en hållplats och tillbaka förbi samma hållplats: etappen
// fram till hållplatsen ska klippas vid första passagen, inte vid vägen tillbaka.
{
  const c = [[18.40, 63.40], [18.41, 63.40], [18.4103, 63.405]];
  const legs = splitLegs([c[0], [18.4097, 63.3999], c[2], c[1], [18.42, 63.40]], [c[0], c[1], c[2], c[1]]).legs;
  assert.ok(legs[0].len < 700, "första passagen");
  assert.ok(legs[1].len > 500, "ut till vändhållplatsen");
}

// Två turer ritar samma sträcka nästan likadant: båda får den vanligaste formen.
{
  const c = [[18.40, 63.40], [18.42, 63.40]];
  const many = [c[0], [18.41, 63.4003], c[1]];
  const few = [c[0], [18.405, 63.4002], [18.415, 63.4001], c[1]];
  const r = [{ variants: [{ stops: [0, 1], trips: 20, path: many.map((p) => [...p]) }, { stops: [1, 0], trips: 2, path: few.slice().reverse() }] }];
  const count = await repairStraightLegs(r, c);
  assert.equal(count.aligned, 1);
  assert.deepEqual(r[0].variants[1].path, many.slice().reverse());
}
console.log("legs alignment ok");
