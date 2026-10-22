// Gemensam logik för linjenätet, används av både kartan och linjenätskartan.

export function distance(lat1, lon1, lat2, lon2) {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// Hållplatslägen med samma namn inom 400 m blir en grupp ("Resecentrum" läge A, B, C...).
// Returnerar { groups, stopGroup, labelToGroup }.
export function groupStops(net) {
  const groups = [];
  const stopGroup = new Array(net.stops.length);
  const byName = new Map();
  net.stops.forEach(([, name, lat, lon], i) => {
    const list = byName.get(name) || [];
    let g = list.find((g) => distance(g.lat, g.lon, lat, lon) < 400);
    if (!g) {
      g = { name, lat, lon, stops: [], routes: new Set() };
      list.push(g);
      groups.push(g);
      byName.set(name, list);
    }
    g.stops.push(i);
    stopGroup[i] = groups.indexOf(g);
  });
  net.routes.forEach((r, ri) => r.variants.forEach((v) => v.stops.forEach((s) => groups[stopGroup[s]].routes.add(ri))));
  // Unika namn i söklistan: lägg till linjenummer när samma namn finns på flera ställen.
  const labelToGroup = new Map();
  groups.forEach((g, gi) => {
    const dup = byName.get(g.name).length > 1;
    g.label = dup ? `${g.name} (linje ${[...g.routes].map((r) => net.routes[r].name).join(", ")})` : g.name;
    labelToGroup.set(g.label.toLowerCase(), gi);
  });
  return { groups, stopGroup, labelToGroup };
}

// Kortare namn för kartor: "Örnsköldsvik Örnparken" -> "Örnparken".
export function shortName(name) {
  return name.replace(/^Örnsköldsvik\s+/, "");
}

// Linjer som kör samma väg ritas bredvid varandra. Varje huvudform delas i etapper
// mellan hållplatserna; etapper mellan samma två hållplatser (åt något håll) delas av
// flera linjer, och varje linje får ett eget läge "o" i knippet, räknat från mitten.
// Läget räknas i en bestämd riktning (lägre hållplatsgrupp först), så att linjen ligger
// på samma sida oavsett åt vilket håll formen går.
// Returnerar [{ ri, v, pts, o }].
export function bundleLegs(net, stopGroup, routeIdx) {
  const legs = [];
  const share = new Map(); // "a|b" -> Set(ri)
  for (const ri of routeIdx) {
    for (const v of net.routes[ri].variants) {
      if (!v.main) continue;
      const groups = v.stops.map((s) => stopGroup[s]);
      const cut = cutAtStops(v.path, v.stops.map((s) => [net.stops[s][3], net.stops[s][2]]));
      for (let i = 1; i < groups.length; i++) {
        const [a, b] = [groups[i - 1], groups[i]];
        const pts = v.path.slice(cut[i - 1], cut[i] + 1);
        if (a === b || pts.length < 2) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        (share.get(key) || share.set(key, new Set()).get(key)).add(ri);
        legs.push({ ri, v, pts, key, flip: a > b });
      }
    }
  }
  for (const leg of legs) {
    const list = [...share.get(leg.key)].sort((x, y) => x - y);
    const o = list.indexOf(leg.ri) - (list.length - 1) / 2;
    leg.o = leg.flip ? -o : o;
  }
  return legs;
}

// Index i formen närmast varje hållplats, i turordning. Ligger en hållplats nära formen
// flera gånger (slingor) tas första passagen.
function cutAtStops(path, stops) {
  const out = [];
  let from = 0;
  for (const [lon, lat] of stops) {
    let best = from, bestD = Infinity, first = -1;
    for (let i = from; i < path.length; i++) {
      const d = distance(lat, lon, path[i][1], path[i][0]);
      if (d < bestD) { bestD = d; best = i; }
      if (first < 0 && d < 40) first = i;
      if (first >= 0 && d > 80) break;
    }
    from = best;
    out.push(from);
  }
  return out;
}

// Linjens färdvägar per riktning, för att förklara hur bussarna går när en linje kör
// på flera sätt. Hållplatser som bara vissa turer har (mellan 10 % och 75 % av
// riktningens turer) skiljer färdvägarna åt. Turer med nästan samma sådana hållplatser
// slås ihop, och varje färdväg beskrivs med de ovanligaste av sina hållplatser.
// Returnerar [{ dir, headsign, total, routes: [{ via: [g], from, to, trips, variants: [vi] }] }].
export function routePatterns(net, stopGroup, ri, { maxRoutes = 4 } = {}) {
  const r = net.routes[ri];
  const out = [];
  for (const dir of [...new Set(r.variants.map((v) => v.dir))]) {
    const vs = r.variants.map((v, vi) => ({ v, vi, seq: [...new Set(v.stops.map((s) => stopGroup[s]))] })).filter((x) => x.v.dir === dir && x.seq.length > 1);
    const total = vs.reduce((n, x) => n + x.v.trips, 0);
    const count = new Map();
    for (const x of vs) for (const g of x.seq) count.set(g, (count.get(g) || 0) + x.v.trips);
    const telling = (g) => count.get(g) >= total * 0.1 && count.get(g) <= total * 0.75;
    for (const x of vs) x.set = new Set(x.seq.filter(telling));
    const similar = (a, b) => {
      let both = 0;
      for (const g of a) if (b.has(g)) both++;
      const any = a.size + b.size - both;
      return any === 0 || both / any >= 0.6;
    };
    const clusters = [];
    for (const x of [...vs].sort((a, b) => b.v.trips - a.v.trips || b.seq.length - a.seq.length)) {
      const c = clusters.find((c) => similar(c.set, x.set));
      if (c) c.members.push(x);
      else clusters.push({ set: x.set, members: [x] });
    }
    const routes = clusters.map((c) => {
      const trips = c.members.reduce((n, x) => n + x.v.trips, 0);
      const seq = c.members[0].seq;
      // Hållplatser som de flesta turerna i färdvägen har men som är ovanliga för linjen.
      const own = seq.slice(1, -1).filter((g) => telling(g) && count.get(g) <= total * 0.5 &&
        c.members.filter((x) => x.set.has(g)).reduce((n, x) => n + x.v.trips, 0) >= trips / 2);
      const via = [...own].sort((a, b) => count.get(a) - count.get(b)).slice(0, 2).sort((a, b) => seq.indexOf(a) - seq.indexOf(b));
      return { via, from: seq[0], to: seq[seq.length - 1], trips, variants: c.members.map((x) => x.vi) };
    }).sort((a, b) => b.trips - a.trips);
    const main = r.variants.find((v) => v.main && v.dir === dir);
    out.push({ dir, headsign: main?.headsign || "", total, routes: routes.slice(0, maxRoutes), rest: routes.slice(maxRoutes).reduce((n, x) => n + x.trips, 0) });
  }
  return out;
}
