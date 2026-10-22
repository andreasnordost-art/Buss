// Rättar linjeformer som genar i raka streck mellan hållplatser.
//
// Din Turs former är för vissa turer bara raka linjer från hållplats till hållplats
// (eller saknas helt). Samma sträcka körs nästan alltid av någon annan tur vars form
// följer vägen. Varje form delas därför i etapper mellan hållplatserna, och en rak
// etapp ersätts med den kortaste kedjan av vägföljande etapper mellan samma två
// hållplatser, från vilken linje som helst. Expressturer som hoppar över hållplatser
// får på så vis vägen via de hållplatser de passerar. Etapper som ingen tur kör längs
// vägen kan till sist slås upp i en vägnavigering (route), om bygget har en.
//
// Etapper som följer vägen men ritats lite olika av olika turer (eller slarvigt, med
// ändar en bit från hållplatsen) byts mot den form som flest turer kör, så att samma
// sträcka ritas som ett streck i stället för flera nästan likadana.

const RAD = Math.PI / 180;
const KX = 111320 * Math.cos(63.3 * RAD); // meter per längdgrad kring Örnsköldsvik
const KY = 110540;

// En etapp räknas som rak när nästan hela längden är ett enda streck över så här lång sträcka.
// Korta raka etapper (under CHAIN_MIN_METERS) är ofta riktiga raka gator: de slås bara upp
// i vägnavigeringen, aldrig via andra hållplatser, så att de inte blir omvägar.
const STRAIGHT_MIN_METERS = 300;
const CHAIN_MIN_METERS = 600;
const STRAIGHT_SHARE = 0.8;
// En ersättning får vara högst så här mycket längre än fågelvägen.
const DETOUR_FACTOR = 1.6;
const DETOUR_EXTRA = 400;
// Vägnavigeringens väg får vara lite längre (den vet inte var bussen vänder), men inte
// en lång omväg via en motorvägsramp åt fel håll.
const ROUTED_FACTOR = 2;
const ROUTED_EXTRA = 500;
// Två former för samma etapp räknas som samma väg om de aldrig skiljer mer än så här.
const SAME_ROAD_METERS = 50;
// En etapp vars ände ligger längre än så här från hållplatsen är slarvigt ritad.
const LOOSE_END_METERS = 30;

// routes: [{ variants: [{ path: [[lon, lat]], stops: [stopIndex] }] }]
// coords: stopIndex -> [lon, lat]. route(a, b): [[lon, lat]] längs vägen eller null.
// Ändrar path på plats och returnerar { fixed, routed, left, aligned, legs: [[a, b, hur]] }.
export async function repairStraightLegs(routes, coords, route = null) {
  const variants = routes.flatMap((r) => r.variants).filter((v) => v.stops.length >= 2 && v.path.length >= 2);
  const split = variants.map((v) => splitLegs(v.path, v.stops.map((s) => coords[s])));

  // Vägföljande etapper från alla former, i båda riktningarna.
  const edges = new Map(); // från -> Map(till -> { len, pts })
  const addEdge = (a, b, pts, len) => {
    let m = edges.get(a);
    if (!m) edges.set(a, (m = new Map()));
    const old = m.get(b);
    if (!old || len < old.len) m.set(b, { len, pts });
  };
  // Den form flest turer kör för varje hållplatspar, oavsett riktning.
  const common = new Map(); // "a>b" -> { pts, trips, loose }
  variants.forEach((v, vi) => {
    split[vi].legs.forEach((leg, i) => {
      const a = v.stops[i], b = v.stops[i + 1];
      if (a === b || leg.straight || !plausible(leg, coords[a], coords[b])) return;
      addEdge(a, b, leg.pts, leg.len);
      addEdge(b, a, leg.pts.slice().reverse(), leg.len);
      const trips = v.trips || 1;
      const loose = looseEnds(leg, coords[a], coords[b]);
      for (const [k, pts] of [[`${a}>${b}`, leg.pts], [`${b}>${a}`, leg.pts.slice().reverse()]]) {
        const old = common.get(k);
        // Slarviga former tas bara när inget annat finns.
        if (!old || old.loose > loose || (old.loose === loose && trips > old.trips)) common.set(k, { pts, trips, loose });
      }
    });
  });

  const chain = (leg, a, b) => (leg.len >= CHAIN_MIN_METERS ? roadBetween(edges, a, b, dist(coords[a], coords[b])) : null);

  // Formen en vägföljande etapp ritas med: den vanligaste om den är samma väg, annars sin egen.
  const shape = (leg, a, b) => {
    const best = common.get(`${a}>${b}`);
    return best && best.pts !== leg.pts && !best.loose && sameRoad(leg.pts, best.pts) ? best.pts : leg.pts;
  };

  // Raka etapper utan vägföljande kedja slås upp en gång per hållplatspar.
  const routed = new Map();
  if (route) {
    for (const [vi, v] of variants.entries()) {
      for (const [i, leg] of split[vi].legs.entries()) {
        const a = v.stops[i], b = v.stops[i + 1];
        const key = `${a}>${b}`;
        if (!leg.straight || a === b || routed.has(key) || chain(leg, a, b)) continue;
        routed.set(key, null);
        const pts = await route(coords[a], coords[b]).catch(() => null);
        if (pts?.length >= 2 && dist(pts[0], coords[a]) < 150 && dist(pts[pts.length - 1], coords[b]) < 150 &&
            length(pts) <= ROUTED_FACTOR * dist(coords[a], coords[b]) + ROUTED_EXTRA) routed.set(key, pts);
      }
    }
  }

  const count = { fixed: 0, routed: 0, left: 0, aligned: 0, legs: [] };
  variants.forEach((v, vi) => {
    const { head, legs, tail } = split[vi];
    let changed = false;
    const out = [...head];
    legs.forEach((leg, i) => {
      const a = v.stops[i], b = v.stops[i + 1];
      let road = null;
      if (a === b) {
        // Samma hållplats två gånger i rad: inget att rätta.
      } else if (leg.straight) {
        road = chain(leg, a, b);
        const how = road ? "fixed" : (road = routed.get(`${a}>${b}`)) ? "routed" : "left";
        count[how]++;
        count.legs.push([a, b, how]);
      } else {
        const pts = shape(leg, a, b);
        if (pts !== leg.pts) {
          road = pts;
          count.aligned++;
        }
      }
      if (road) changed = true;
      append(out, road || leg.pts);
    });
    if (!changed) return;
    append(out, tail);
    v.path = out.map(([lon, lat]) => [round(lon), round(lat)]);
  });
  return count;
}

const looseEnds = (leg, a, b) => dist(leg.pts[0], a) > LOOSE_END_METERS || dist(leg.pts[leg.pts.length - 1], b) > LOOSE_END_METERS;

// Följer två former samma väg? Varje punkt (var 25:e meter) ska ligga nära den andra formen.
function sameRoad(p, q) {
  const near = (from, to) => densify(from).every((pt) => toLine(pt, to) <= SAME_ROAD_METERS);
  return near(p, q) && near(q, p);
}

function densify(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.ceil(dist(pts[i - 1], pts[i]) / 25);
    for (let k = 1; k <= n; k++) out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / n, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / n]);
  }
  return out;
}

function toLine(p, pts) {
  const xy = toXY(p);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, onSegment(xy, toXY(pts[i]), toXY(pts[i + 1]), 0)[1]);
  return pts.length === 1 ? dist(p, pts[0]) : best;
}

const length = (pts) => pts.reduce((sum, p, i) => sum + (i ? dist(pts[i - 1], p) : 0), 0);

// Delar formen vid de punkter som ligger närmast varje hållplats, i turordning.
export function splitLegs(path, stops) {
  const xy = path.map(toXY);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  // Läget på formen: [segment, andel, punkt, avstånd längs formen].
  let from = { seg: 0, t: 0 };
  const cuts = stops.map((s) => (from = project(xy, toXY(s), from)));
  const pts = (a, b) => {
    const out = [at(path, a)];
    for (let i = a.seg + 1; i <= b.seg; i++) out.push(path[i]);
    out.push(at(path, b));
    return dedupe(out);
  };
  const len = (c) => cum[c.seg] + c.t * (cum[c.seg + 1] - cum[c.seg] || 0);
  const legs = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const p = pts(cuts[i], cuts[i + 1]);
    const l = len(cuts[i + 1]) - len(cuts[i]);
    let longest = 0;
    for (let j = 1; j < p.length; j++) longest = Math.max(longest, dist(p[j - 1], p[j]));
    legs.push({ pts: p, len: l, straight: longest > STRAIGHT_MIN_METERS && longest >= STRAIGHT_SHARE * l });
  }
  const last = cuts[cuts.length - 1];
  return {
    head: pts({ seg: 0, t: 0 }, cuts[0]).slice(0, -1),
    legs,
    tail: pts(last, { seg: path.length - 2, t: 1 }).slice(1),
  };
}

// Närmaste läge på formen från och med "from". Ligger hållplatsen nära formen flera
// gånger (slingor) tas första passagen, så att senare hållplatser fortfarande hittas.
function project(xy, p, from) {
  let best = null;
  const hits = [];
  for (let i = from.seg; i < xy.length - 1; i++) {
    const t0 = i === from.seg ? from.t : 0;
    const [t, d] = onSegment(p, xy[i], xy[i + 1], t0);
    const c = { seg: i, t, d };
    if (!best || d < best.d) best = c;
    if (d < 40) hits.push(c);
  }
  if (!best) return { seg: Math.max(0, xy.length - 2), t: 1, d: Infinity };
  if (!hits.length) return best;
  // Första passagen inom 40 m, men dess närmaste punkt (inte första segmentet som nuddar).
  // Passagen tar slut där formen lämnar hållplatsen, t.ex. för en sväng ut och tillbaka.
  let first = hits[0];
  for (let k = 1; k < hits.length; k++) {
    const h = hits[k];
    if (h.seg !== hits[k - 1].seg + 1 || Math.hypot(xy[h.seg][0] - p[0], xy[h.seg][1] - p[1]) >= 40) break;
    if (h.d < first.d) first = h;
  }
  return first;
}

function onSegment(p, a, b, tMin) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(tMin, Math.min(1, t));
  return [t, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1])];
}

// En etapp som är mycket längre än fågelvägen är troligen fel klippt (slinga).
function plausible(leg, a, b) {
  const d = dist(a, b);
  return leg.len <= 2.5 * d + 500 && dist(leg.pts[0], a) < 150 && dist(leg.pts[leg.pts.length - 1], b) < 150;
}

// Kortaste vägen genom vägföljande etapper (Dijkstra), om den inte är en omväg.
function roadBetween(edges, a, b, direct) {
  const limit = direct * DETOUR_FACTOR + DETOUR_EXTRA;
  const best = new Map([[a, 0]]);
  const prev = new Map();
  const queue = [[0, a]];
  while (queue.length) {
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[k][0]) k = i;
    const [d, node] = queue.splice(k, 1)[0];
    if (d > best.get(node)) continue;
    if (node === b) break;
    for (const [next, e] of edges.get(node) || []) {
      const nd = d + e.len;
      if (nd > limit || nd >= (best.get(next) ?? Infinity)) continue;
      best.set(next, nd);
      prev.set(next, [node, e]);
      queue.push([nd, next]);
    }
  }
  if (!prev.has(b)) return null;
  const chain = [];
  for (let n = b; n !== a; n = prev.get(n)[0]) chain.unshift(prev.get(n)[1]);
  const out = [];
  for (const e of chain) append(out, e.pts);
  return out;
}

function append(out, pts) {
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
}

function at(path, { seg, t }) {
  const a = path[seg], b = path[seg + 1] || a;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function dedupe(pts) {
  const out = [];
  append(out, pts);
  return out;
}

const toXY = ([lon, lat]) => [lon * KX, lat * KY];
const dist = (a, b) => Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
const round = (x) => Math.round(x * 1e5) / 1e5;

// Vägnavigering via en OSRM-server (bil). En fråga i taget och högst en per sekund,
// så att den öppna demoservern inte belastas.
export function osrmRoute(base) {
  let last = 0;
  return async (a, b) => {
    const wait = last + 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const url = `${base}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    return json.routes?.[0]?.geometry?.coordinates || null;
  };
}
