// Linjenätskarta i tunnelbanestil, ritad automatiskt ur linjenätet.
//
// 1. Hållplatserna blir noder och linjernas huvudformer blir kanter.
// 2. Knutpunkter är ändhållplatser, förgreningar och ställen där linjeutbudet ändras.
//    Mellan två knutpunkter går en "sträcka" med de vanliga hållplatserna.
// 3. Knutpunkterna placeras ungefär geografiskt, men centrum förstoras och
//    ytterområden trycks ihop, och lägena låses till ett rutnät.
// 4. Varje sträcka ritas med raka linjer i 0°, 45° eller 90°, och linjer som delar
//    sträcka läggs bredvid varandra.
// 5. Hållplatser som ligger nästan på samma ställe men på olika linjer (t.ex. Gnistan och
//    Gullänget Centrum) hålls ihop och får en gångväg mellan sig.

import { shortName, distance } from "./network.js";

const SVG = "http://www.w3.org/2000/svg";

export function layoutSchematic(net, groups, stopGroup, routeIdx, opts = {}) {
  const spacing = opts.spacing ?? 24; // minsta avstånd mellan hållplatser, px
  const grid = opts.grid ?? 12;
  const power = opts.power ?? 0.5; // < 1 förstorar centrum

  // --- Graf --------------------------------------------------------------------
  // Alla turer räknas, och varje del av en linje vägs efter hur många turer om dagen som
  // kör den. Det som minst 30 % av linjens mest trafikerade del har är huvudfärdväg. Det
  // som bara några turer kör blir en alternativ färdväg (ritas tunt och streckat), och
  // enstaka turer som går en egen väg hoppas över. Skol- och specialturer visar bara sin
  // huvudfärdväg.
  const mainShare = opts.mainShare ?? 0.3;
  const altTrips = opts.altTrips ?? 2;
  const edges = new Map();
  const adj = new Map();
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  const dist = (a, b) => distance(groups[a].lat, groups[a].lon, groups[b].lat, groups[b].lon);
  const routeSeqs = new Map();
  for (const ri of routeIdx) {
    const seqs = net.routes[ri].variants
      .map((v, vi) => {
        const seq = [];
        for (const s of v.stops) {
          const g = stopGroup[s];
          if (seq[seq.length - 1] !== g) seq.push(g);
        }
        return { seq, trips: v.trips || 1, path: v.path, vi };
      })
      .filter((v) => v.seq.length > 1);
    if (seqs.length) routeSeqs.set(ri, seqs);
  }
  // Hållplatser som bussen kör förbi läggs in, även andra linjers, så att linjer som kör
  // samma väg ritas längs samma sträcka i stället för som slingor bredvid varandra.
  const allStops = [...new Set([...routeSeqs.values()].flat().flatMap((v) => v.seq))];
  for (const [ri, seqs] of routeSeqs) routeSeqs.set(ri, passedOnRoad(seqs, groups, allStops));
  const viaAll = viaPassedStops([...routeSeqs.values()].flat(), dist, ekey, 1.12);
  for (const [ri, seqs] of routeSeqs) routeSeqs.set(ri, viaAll(viaPassedStops(seqs, dist, ekey, 1.25)(seqs)));
  const oneway = new Map(); // ri -> Map("a>b" -> turer)
  for (const [ri, seqs] of routeSeqs) {
    const r = net.routes[ri];
    const w = new Map();
    const dw = new Map();
    oneway.set(ri, dw);
    for (const { seq, trips } of seqs) {
      const seen = new Set();
      for (let i = 1; i < seq.length; i++) {
        const k = ekey(seq[i - 1], seq[i]);
        if (seen.has(k)) continue;
        seen.add(k);
        w.set(k, (w.get(k) || 0) + trips);
        dw.set(`${seq[i - 1]}>${seq[i]}`, (dw.get(`${seq[i - 1]}>${seq[i]}`) || 0) + trips);
      }
    }
    const top = Math.max(...w.values());
    const extraRoute = r.tier === "extra";
    const kept = new Map(); // ekey -> alternativ färdväg?
    for (const [k, x] of w) {
      if (x >= top * mainShare) kept.set(k, false);
      else if (!extraRoute && x >= altTrips) kept.set(k, true);
    }
    // Bara den sammanhängande delen med den mest trafikerade sträckan, så att inga lösa
    // bitar blir kvar när enstaka turer tas bort. Huvudfärdvägen ska också hänga ihop:
    // fattas en bit emellan blir den alternativa vägen dit en del av huvudfärdvägen.
    const nbr = new Map();
    for (const k of kept.keys()) {
      const [a, b] = k.split("|").map(Number);
      (nbr.get(a) || nbr.set(a, []).get(a)).push(b);
      (nbr.get(b) || nbr.set(b, []).get(b)).push(a);
    }
    const reach = (from, ok) => {
      const prev = new Map(from.map((g) => [g, null]));
      const queue = [...from];
      while (queue.length) {
        const g = queue.shift();
        for (const o of nbr.get(g) || []) if (!prev.has(o) && ok(ekey(g, o))) (prev.set(o, g), queue.push(o));
      }
      return prev;
    };
    const start = Number([...w].sort((x, y) => y[1] - x[1])[0][0].split("|")[0]);
    const all = reach([start], () => true);
    for (let guard = 0; guard < 20; guard++) {
      const main = reach([start], (k) => kept.get(k) === false);
      const onMain = (g) => (nbr.get(g) || []).some((o) => kept.get(ekey(g, o)) === false);
      const prev = reach([...main.keys()], () => true);
      const goal = [...prev.keys()].find((g) => !main.has(g) && onMain(g));
      if (goal == null) break;
      for (let g = goal; prev.get(g) != null; g = prev.get(g)) kept.set(ekey(g, prev.get(g)), false);
    }
    for (const [k, alt] of kept) {
      const [a, b] = k.split("|").map(Number);
      if (!all.has(a)) continue;
      if (!edges.has(k)) edges.set(k, { a, b, routes: new Set(), alt: new Set() });
      edges.get(k).routes.add(ri);
      if (alt) edges.get(k).alt.add(ri);
      link(a, b);
      link(b, a);
    }
  }
  const routeSet = (a, b) => {
    const e = edges.get(ekey(a, b));
    return [...e.routes].sort((x, y) => x - y).map((ri) => (e.alt.has(ri) ? `${ri}a` : ri)).join(",");
  };

  // --- Knutpunkter och sträckor ---------------------------------------------------
  const key = new Set();
  for (const [n, nb] of adj) {
    if (nb.size !== 2) key.add(n);
    else {
      const [x, y] = [...nb];
      if (routeSet(n, x) !== routeSet(n, y)) key.add(n);
    }
  }
  // Gångvägar: hållplatser utan gemensam linje som ligger nära varandra. De blir knutpunkter
  // så att de placeras bredvid varandra.
  const linkDist = opts.linkDist ?? 120; // meter
  const links = [];
  const nodeList = [...adj.keys()];
  for (let i = 0; i < nodeList.length; i++) {
    for (let j = i + 1; j < nodeList.length; j++) {
      const [a, b] = [nodeList[i], nodeList[j]];
      // Bara hållplatser på olika linjer; samma linje har redan sin väg mellan dem.
      if (adj.get(a).has(b) || [...groups[a].routes].some((r) => groups[b].routes.has(r))) continue;
      if (distance(groups[a].lat, groups[a].lon, groups[b].lat, groups[b].lon) > linkDist) continue;
      links.push([a, b]);
      key.add(a);
      key.add(b);
    }
  }
  const linked = new Set(links.map(([a, b]) => ekey(a, b)));

  // Kör linjen sträckan bara åt ena hållet (en slinga eller vändning) får den pilar:
  // 1 = i nodernas ordning, -1 = motsatt. Åt andra hållet får högst var femte tur köra.
  const direction = (nodes, routes) => {
    const out = new Map();
    for (const ri of routes) {
      let fwd = 0, back = 0;
      for (let i = 1; i < nodes.length; i++) {
        fwd += oneway.get(ri).get(`${nodes[i - 1]}>${nodes[i]}`) || 0;
        back += oneway.get(ri).get(`${nodes[i]}>${nodes[i - 1]}`) || 0;
      }
      if (back <= fwd * 0.2) out.set(ri, 1);
      else if (fwd <= back * 0.2) out.set(ri, -1);
    }
    return out;
  };
  const chains = [];
  const used = new Set();
  const walkFrom = (k) => {
    for (const n of adj.get(k)) {
      if (used.has(ekey(k, n))) continue;
      const nodes = [k];
      let prev = k, cur = n;
      used.add(ekey(k, n));
      while (!key.has(cur)) {
        nodes.push(cur);
        const next = [...adj.get(cur)].find((x) => x !== prev && !used.has(ekey(cur, x)));
        if (next == null) break;
        used.add(ekey(cur, next));
        prev = cur;
        cur = next;
      }
      nodes.push(cur);
      const e = edges.get(ekey(nodes[0], nodes[1]));
      const routes = [...e.routes].sort((x, y) => x - y);
      chains.push({ nodes, routes, alt: new Set(e.alt), dir: direction(nodes, routes) });
    }
  };
  for (const k of key) walkFrom(k);
  // Rena ringar utan knutpunkt.
  for (const { a } of edges.values()) {
    if ([...adj.get(a)].every((b) => used.has(ekey(a, b)))) continue;
    key.add(a);
    walkFrom(a);
  }

  // --- Placering ------------------------------------------------------------------
  const nodesUsed = [...adj.keys()];
  const center = nodesUsed.reduce((best, g) => (groups[g].routes.size > groups[best].routes.size ? g : best), nodesUsed[0]);
  const lat0 = groups[center].lat, lon0 = groups[center].lon;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const distorted = (g) => {
    const x = (groups[g].lon - lon0) * cos0 * 111.32;
    const y = -(groups[g].lat - lat0) * 110.57;
    const r = Math.hypot(x, y);
    const f = r > 0 ? r ** power / r : 0;
    return [x * f, y * f];
  };
  const dpos = new Map(nodesUsed.map((g) => [g, distorted(g)]));
  // Alternativa färdvägar får inte påverka huvudnätets form: de läggs in efteråt där det
  // finns plats, eftersom de bara visas när linjen är vald.
  const isMain = (c) => c.routes.some((ri) => !c.alt.has(ri));
  const ratios = chains
    .filter(isMain)
    .map((c) => {
      const [a, b] = [dpos.get(c.nodes[0]), dpos.get(c.nodes[c.nodes.length - 1])];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      return d > 0 ? ((c.nodes.length - 1) * spacing) / d : null;
    })
    .filter((x) => x != null)
    .sort((a, b) => a - b);
  const scale = ratios.length ? ratios[Math.floor(ratios.length * 0.6)] : 100;
  const target = (g) => dpos.get(g).map((v) => v * scale);

  const pos = new Map();
  const taken = new Set();
  const cell = (p) => `${p[0]},${p[1]}`;
  const snap = (p) => p.map((v) => Math.round(v / grid) * grid);
  const place = (g, want) => {
    let best = snap(want);
    if (taken.has(cell(best))) {
      // Närmaste lediga ruta.
      let found = null;
      for (let ring = 1; !found && ring < 20; ring++) {
        const cands = [];
        for (let dx = -ring; dx <= ring; dx++)
          for (let dy = -ring; dy <= ring; dy++)
            if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) cands.push([best[0] + dx * grid, best[1] + dy * grid]);
        cands.sort((p, q) => Math.hypot(p[0] - want[0], p[1] - want[1]) - Math.hypot(q[0] - want[0], q[1] - want[1]));
        found = cands.find((p) => !taken.has(cell(p)));
      }
      best = found;
    }
    taken.add(cell(best));
    pos.set(g, best);
  };
  // Knuffa isär knutpunkter som ligger för tätt för sina hållplatser, men håll dem
  // nära sitt geografiska läge.
  const onMain = new Set(chains.filter(isMain).flatMap((c) => c.nodes));
  const keys = [...key].filter((g) => onMain.has(g));
  const altKeys = [...key].filter((g) => !onMain.has(g));
  const relaxed = new Map(keys.map((g) => [g, target(g)]));
  const springs = chains
    .filter((c) => isMain(c) && c.nodes[0] !== c.nodes[c.nodes.length - 1])
    .map((c) => [c.nodes[0], c.nodes[c.nodes.length - 1], (c.nodes.length - 1) * spacing]);
  const minGap = grid * 4;
  let near = [];
  for (let it = 0; it < 600; it++) {
    const force = new Map(keys.map((g) => [g, [0, 0]]));
    const push = (a, b, want, k) => {
      const pa = relaxed.get(a), pb = relaxed.get(b);
      let dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      let d = Math.hypot(dx, dy);
      if (d >= want) return;
      if (d < 0.01) { dx = 1; dy = 0; d = 1; }
      const f = ((want - d) / d) * k;
      force.get(a)[0] -= dx * f; force.get(a)[1] -= dy * f;
      force.get(b)[0] += dx * f; force.get(b)[1] += dy * f;
    };
    for (const [a, b, want] of springs) push(a, b, want, 0.25);
    // Par som ligger nära varandra; listan förnyas då och då eftersom lägena rör sig långsamt.
    if (it % 20 === 0) {
      near = [];
      for (let i = 0; i < keys.length; i++) {
        const pi = relaxed.get(keys[i]);
        for (let j = i + 1; j < keys.length; j++) {
          const pj = relaxed.get(keys[j]);
          if (Math.abs(pi[0] - pj[0]) < minGap * 3 && Math.abs(pi[1] - pj[1]) < minGap * 3) near.push([keys[i], keys[j], linked.has(ekey(keys[i], keys[j])) ? grid * 2 : minGap]);
        }
      }
    }
    for (const [a, b, want] of near) push(a, b, want, 0.25);
    // Gångvägarna drar ihop sina hållplatser.
    for (const [a, b] of links) {
      if (!onMain.has(a) || !onMain.has(b)) continue;
      const pa = relaxed.get(a), pb = relaxed.get(b);
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
      const d = Math.hypot(dx, dy);
      if (d <= grid * 2) continue;
      const f = ((d - grid * 2) / d) * 0.2;
      force.get(a)[0] += dx * f; force.get(a)[1] += dy * f;
      force.get(b)[0] -= dx * f; force.get(b)[1] -= dy * f;
    }
    for (const g of keys) {
      const p = relaxed.get(g), t = target(g), f = force.get(g);
      p[0] += f[0] + (t[0] - p[0]) * 0.008;
      p[1] += f[1] + (t[1] - p[1]) * 0.008;
    }
  }
  // Alternativa knutpunkter flyttas lika mycket som närmaste knutpunkt i huvudnätet.
  for (const g of altKeys) {
    const near = keys.reduce((best, o) => (best == null || dist(g, o) < dist(g, best) ? o : best), null);
    const t = target(g);
    const d = near == null ? [0, 0] : [relaxed.get(near)[0] - target(near)[0], relaxed.get(near)[1] - target(near)[1]];
    relaxed.set(g, [t[0] + d[0], t[1] + d[1]]);
  }
  const shift = (g) => {
    const p = relaxed.get(g), t = target(g);
    return [p[0] - t[0], p[1] - t[1]];
  };
  // Viktigaste knutpunkterna först så att de får sina bästa lägen.
  // En hållplats med gångväg läggs två rutor från sin redan placerade granne.
  const partners = new Map();
  for (const [a, b] of links) {
    if (!partners.has(a)) partners.set(a, []);
    if (!partners.has(b)) partners.set(b, []);
    partners.get(a).push(b);
    partners.get(b).push(a);
  }
  [...keys.sort((a, b) => groups[b].routes.size - groups[a].routes.size), ...altKeys].forEach((g) => {
    const near = (partners.get(g) || []).find((o) => pos.has(o));
    if (near == null) return place(g, relaxed.get(g));
    const [pp, rg, ro] = [pos.get(near), relaxed.get(g), relaxed.get(near)];
    const ang = Math.round(Math.atan2(rg[1] - ro[1], rg[0] - ro[0]) / (Math.PI / 4)) * (Math.PI / 4);
    place(g, [pp[0] + Math.cos(ang) * grid * 2, pp[1] + Math.sin(ang) * grid * 2]);
  });

  // --- Sträckornas form ---------------------------------------------------------------
  const drawn = [];
  for (const c of [...chains].sort((x, y) => isMain(y) - isMain(x))) {
    const n = c.nodes.length;
    const pins = [0];
    const loop = c.nodes[0] === c.nodes[n - 1];
    if (loop) pins.push(Math.round(n / 3), Math.round((2 * n) / 3));
    else if (n >= 10) pins.push(Math.round(n / 2));
    pins.push(n - 1);
    const pinPos = pins.map((i, j) => {
      if (j === 0 || j === pins.length - 1) return pos.get(c.nodes[i]);
      const g = c.nodes[i];
      const [sa, sb] = [shift(c.nodes[0]), shift(c.nodes[n - 1])];
      const t = target(g);
      place(g, [t[0] + (sa[0] + sb[0]) / 2, t[1] + (sa[1] + sb[1]) / 2]);
      return pos.get(g);
    });
    const line = [pinPos[0]];
    for (let j = 1; j < pins.length; j++) {
      const [ia, ib] = [pins[j - 1], pins[j]];
      const hint = target(c.nodes[Math.round((ia + ib) / 2)]);
      // Böjen läggs så att sträckan inte ritas ovanpå en annan sträcka, och inte genom en
      // hållplats som den inte stannar vid (då ser det ut som att linjen går dit).
      const ways = octilinear(pinPos[j - 1], pinPos[j], hint);
      if (ways.length === 1) ways.push(...jogs(pinPos[j - 1], pinPos[j], grid));
      const own = new Set(c.nodes);
      const foreign = [...pos].filter(([g]) => !own.has(g)).map(([, p]) => p);
      const cost = (w) => overlap(w, drawn) + crossings(w, foreign, grid * 0.6) * 1000 + (w.length > 3 ? grid : 0);
      const best = ways.reduce((x, y) => (cost(y) < cost(x) - 1 ? y : x));
      line.push(...best.slice(1));
    }
    c.line = dedupePts(line);
    for (let i = 1; i < c.line.length; i++) drawn.push([c.line[i - 1], c.line[i]]);
    // Hållplatserna fördelas jämnt längs hela sträckan; mellanpunkterna formar bara linjen.
    c.nodePos = c.nodes.map((_, i) => along(c.line, i / (n - 1)));
    for (let i = 1; i < n - 1; i++) if (!key.has(c.nodes[i])) pos.set(c.nodes[i], c.nodePos[i]);
  }

  // Varje turs väg genom linjenätet (med förbipasserade hållplatser), för att kunna visa
  // en enskild färdväg: ri -> vi -> [grupp].
  const variantSeqs = new Map([...routeSeqs].map(([ri, seqs]) => [ri, new Map(seqs.map((v) => [v.vi, v.seq]))]));
  return { chains, pos, key, center, routes: routeIdx, links, variantSeqs };
}

// Hållplatser på linjen som turen kör förbi utan att stanna, enligt bussens väg (formen i
// tidtabellen). De läggs in i turen, så att t.ex. Kilgatan och Cisternvägen, som ligger
// på samma gata men används åt var sitt håll, ritas efter varandra i stället för som en slinga.
function passedOnRoad(seqs, groups, cands) {
  const near = 25, clear = 60; // meter
  return seqs.map((v) => {
    const path = v.path;
    if (!path || path.length < 2) return v;
    const lat0 = groups[v.seq[0]].lat;
    const cx = Math.cos((lat0 * Math.PI) / 180) * 111320, cy = 110570;
    const pts = path.map(([lon, lat]) => [lon * cx, lat * cy]);
    const xy = (g) => [groups[g].lon * cx, groups[g].lat * cy];
    const segD = (p, i) => {
      const [a, b] = [pts[i - 1], pts[i]];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    };
    // Turens hållplatser längs vägen, i ordning.
    const at = [];
    let from = 1;
    for (const g of v.seq) {
      const p = xy(g);
      let best = [Infinity, from];
      for (let i = from; i < pts.length; i++) {
        const d = segD(p, i);
        if (d < best[0] - 1) best = [d, i];
        if (best[0] < 15 && i > best[1] + 40) break;
      }
      at.push(best[1]);
      from = best[1];
    }
    // Var vägen går nära linjens övriga hållplatser. Vägens delar sorteras i rutor så att
    // varje hållplats bara jämförs med delarna i sin närhet.
    const cell = 100;
    const cells = new Map();
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      for (let x = Math.floor((Math.min(a[0], b[0]) - near) / cell); x <= Math.floor((Math.max(a[0], b[0]) + near) / cell); x++)
        for (let y = Math.floor((Math.min(a[1], b[1]) - near) / cell); y <= Math.floor((Math.max(a[1], b[1]) + near) / cell); y++) {
          const k = `${x},${y}`;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push(i);
        }
    }
    const hits = cands.map((g) => {
      const p = xy(g);
      const list = (cells.get(`${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`) || []).filter((i) => segD(p, i) < near);
      return [g, p, list.sort((x, y) => x - y)];
    }).filter(([, , list]) => list.length);
    const out = [v.seq[0]];
    for (let j = 1; j < v.seq.length; j++) {
      const [a, b] = [xy(v.seq[j - 1]), xy(v.seq[j])];
      const lo = at[j - 1], hi = at[j];
      const win = v.seq.slice(Math.max(0, j - 2), j + 2);
      const passed = hi > lo
        ? hits
            .map(([g, p, list]) => [g, p, list.find((i) => i > lo && i < hi)])
            .filter(([g, p, i]) => i != null && !win.includes(g) && Math.hypot(p[0] - a[0], p[1] - a[1]) > clear && Math.hypot(p[0] - b[0], p[1] - b[1]) > clear)
            .sort((x, y) => x[2] - y[2])
        : [];
      for (const [g] of passed) if (out[out.length - 1] !== g) out.push(g);
      out.push(v.seq[j]);
    }
    return { ...v, seq: out };
  });
}

// En tur som kör förbi en hållplats utan att stanna där, men som linjen annars stannar
// vid, dras via den hållplatsen. Annars ser det ut som att turen genar, t.ex. linje 407
// som vänder vid Aspgatan och passerar Hörnettrondellen åt båda hållen.
// Ger en funktion som gör om turerna; grannarna tas från seqs. Omvägen via hållplatsen
// får vara högst factor gånger fågelvägen.
function viaPassedStops(seqs, dist, ekey, factor) {
  const nb = new Map();
  const add = (a, b) => (nb.has(a) ? nb.get(a) : nb.set(a, new Set()).get(a)).add(b);
  for (const { seq } of seqs) for (let i = 1; i < seq.length; i++) (add(seq[i - 1], seq[i]), add(seq[i], seq[i - 1]));
  const via = new Map();
  const viaOf = (a, b) => {
    const k = ekey(a, b);
    if (!via.has(k)) {
      const d = dist(a, b);
      let best = null;
      for (const z of nb.get(a)) {
        if (z === b || !nb.get(b).has(z)) continue;
        const dz = dist(a, z) + dist(z, b);
        if (dz <= d * factor && (!best || dz < best[1])) best = [z, dz];
      }
      via.set(k, best?.[0] ?? null);
    }
    return via.get(k);
  };
  return (list) => list.map((v) => {
    const { seq } = v;
    const out = [seq[0]];
    for (let i = 1; i < seq.length; i++) {
      const z = viaOf(seq[i - 1], seq[i]);
      if (z != null && !seq.slice(Math.max(0, i - 2), i + 2).includes(z)) out.push(z);
      out.push(seq[i]);
    }
    return { ...v, seq: out };
  });
}

// Två raka delar, en diagonal och en rak, mellan p och q. Ger båda sätten att lägga
// böjen, det som ligger närmast hållplatsernas verkliga läge först.
function octilinear(p, q, hint) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx === 0 || ady === 0 || adx === ady) return [[p, q]];
  const d = Math.min(adx, ady), sx = Math.sign(dx), sy = Math.sign(dy);
  const a = [p[0] + sx * d, p[1] + sy * d];
  const b = [q[0] - sx * d, q[1] - sy * d];
  const da = Math.hypot(a[0] - hint[0], a[1] - hint[1]);
  const db = Math.hypot(b[0] - hint[0], b[1] - hint[1]);
  return da <= db ? [[p, a, q], [p, b, q]] : [[p, b, q], [p, a, q]];
}

// Hur lång bit av linjen som ligger ovanpå redan ritade delar (samma riktning, samma läge).
// Raka sträckor kan vika undan en ruta åt sidan för att inte gå genom en hållplats.
function jogs(p, q, step) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const l = Math.hypot(dx, dy);
  if (l < step * 4) return [];
  const [ux, uy] = [dx / l, dy / l];
  // Lika långt framåt som åt sidan, så att vikningen också går i 0°, 45° eller 90°.
  return [1, -1].map((side) => {
    const [nx, ny] = [-uy * side * step, ux * side * step];
    const a = [p[0] + ux * step + nx, p[1] + uy * step + ny];
    const b = [q[0] - ux * step + nx, q[1] - uy * step + ny];
    return [p, a, b, q];
  });
}

// Hur många av punkterna linjen går igenom (inom r px), ändpunkterna oräknade.
function crossings(line, points, r) {
  let n = 0;
  for (const p of points) {
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
      if (t <= 0.02 || t >= 0.98) continue;
      if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < r) { n++; break; }
    }
  }
  return n;
}

function overlap(line, segs) {
  let sum = 0;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (!l) continue;
    const [ux, uy] = [dx / l, dy / l];
    for (const [c, d] of segs) {
      const off = (p) => Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
      if (off(c) > 2 || off(d) > 2) continue;
      const tc = (c[0] - a[0]) * ux + (c[1] - a[1]) * uy, td = (d[0] - a[0]) * ux + (d[1] - a[1]) * uy;
      sum += Math.max(0, Math.min(l, Math.max(tc, td)) - Math.max(0, Math.min(tc, td)));
    }
  }
  return sum;
}

// Små pilspetsar längs linjen i färdriktningen, en per "every" px och minst en.
function arrowPath(line, size, every) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  if (total < size * 4) return "";
  const n = Math.max(1, Math.floor(total / every));
  let d = "";
  for (let j = 0; j < n; j++) {
    const t = (j + 0.5) / n;
    const p = along(line, t);
    const q = along(line, Math.min(1, t + 0.01));
    const o = along(line, Math.max(0, t - 0.01));
    const l = Math.hypot(q[0] - o[0], q[1] - o[1]) || 1;
    const [ux, uy] = [(q[0] - o[0]) / l, (q[1] - o[1]) / l];
    const tip = [p[0] + ux * size, p[1] + uy * size];
    const back = [p[0] - ux * size, p[1] - uy * size];
    const pt = (x) => x.map((v) => v.toFixed(2)).join(" ");
    d += `M${pt(tip)}L${pt([back[0] - uy * size, back[1] + ux * size])}L${pt([p[0] - ux * size * 0.35, p[1] - uy * size * 0.35])}L${pt([back[0] + uy * size, back[1] - ux * size])}Z`;
  }
  return d;
}

function along(line, t) {
  const lens = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const l = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    lens.push(l);
    total += l;
  }
  let d = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) {
      const k = lens[i] ? d / lens[i] : 0;
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * k, line[i][1] + (line[i + 1][1] - line[i][1]) * k];
    }
    d -= lens[i];
  }
  return line[line.length - 1];
}

function dedupePts(pts) {
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}

// Parallellförskjuten linje med spetsiga hörn.
function offsetLine(line, o) {
  if (!o) return line;
  const normals = [];
  for (let i = 1; i < line.length; i++) {
    const dx = line[i][0] - line[i - 1][0], dy = line[i][1] - line[i - 1][1];
    const l = Math.hypot(dx, dy) || 1;
    normals.push([-dy / l, dx / l]);
  }
  return line.map((p, i) => {
    const n1 = normals[Math.max(0, i - 1)], n2 = normals[Math.min(normals.length - 1, i)];
    let nx = n1[0] + n2[0], ny = n1[1] + n2[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    const cos = nx * n2[0] + ny * n2[1] || 1;
    return [p[0] + (nx * o) / cos, p[1] + (ny * o) / cos];
  });
}

// --- Ritning -------------------------------------------------------------------
//
// Samma ritning visar både den geografiska kartan (t = 0) och tunnelbanekartan (t = 1).
// Varje sträcka har en lista med punkter som finns i båda lägena: hållplatserna och
// tunnelbanekartans hörn. Mellan lägena glider punkterna rakt mot sin plats, så att
// linjerna ser ut att sträckas ut och räta upp sig.

const LW = 3.5; // linjebredd
const GAP = 1;

// opts.geo(g) ger hållplatsgruppens geografiska läge i kartans enheter. Utan den
// projiceras longitud/latitud in i samma ruta som tunnelbanekartan.
export function renderSchematic(container, net, groups, layout, { onStop, onRoute, onBus, selectedRoute = null, extra = new Set(), geo = null, mode = 1, padding = null } = {}) {
  container.replaceChildren();
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "schematic");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Linjenätskarta");
  const view = el("g", { class: "viewport" });
  svg.append(view);
  container.append(svg);

  const extraG = el("g", { class: "routes extras" });
  const linesG = el("g", { class: "routes" });
  const arrowsG = el("g", { class: "arrow-layer" });
  const patternG = el("g", { class: "pattern-layer" });
  const stopsG = el("g", { class: "stations" });
  const labelsG = el("g", { class: "labels" });
  const busesG = el("g", { class: "buses" });
  view.append(extraG, linesG, arrowsG, patternG, stopsG, labelsG, busesG);

  const step = LW + GAP;
  // Tunna, streckade linjer: skol- och specialturer och alternativa färdvägar.
  const thin = (c, ri) => extra.has(ri) || c.alt?.has(ri);
  const mainsOf = (c) => c.routes.filter((ri) => !thin(c, ri));
  let geoOf = geo || defaultGeo(groups, layout);
  let t = mode;
  let k = 1;

  // Sträckornas punkter: arclängd längs tunnelbanelinjen och läget som andel av hållplatsindex.
  for (const c of layout.chains) {
    const n = c.nodes.length;
    const lens = [0];
    for (let i = 1; i < c.line.length; i++) lens.push(lens[i - 1] + Math.hypot(c.line[i][0] - c.line[i - 1][0], c.line[i][1] - c.line[i - 1][1]));
    const L = lens[lens.length - 1] || 1;
    const marks = new Set([...lens.map((l) => l / L), ...c.nodes.map((_, i) => i / (n - 1))]);
    c.verts = [...marks].sort((a, b) => a - b).map((f) => ({ f, schem: along(c.line, f), idx: f * (n - 1) }));
  }
  const geoVert = (c, v) => {
    const i = Math.min(Math.floor(v.idx), c.nodes.length - 2);
    const u = v.idx - i;
    const a = geoOf(c.nodes[i]), b = geoOf(c.nodes[i + 1]);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  };
  const lerp = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];

  const bundle = new Map();
  const solid = new Set(); // hållplatser på någon linjes huvudfärdväg
  const slots = new Map(); // sträcka -> linje -> läge i knippet
  const routePaths = [];
  for (const c of layout.chains) {
    const mains = mainsOf(c);
    const extras = c.routes.filter((ri) => thin(c, ri));
    const kk = mains.length;
    const add = (ri, slot, isExtra) => {
      const path = el("path", { class: isExtra ? `route extra${c.alt?.has(ri) ? " alt" : ""}` : "route", stroke: net.routes[ri].c, "data-route": ri });
      path.addEventListener("click", () => onRoute?.(ri));
      (isExtra ? extraG : linesG).append(path);
      // Sträckor som linjen bara kör åt ena hållet (slingor, vändningar) får pilar.
      let arrows = null;
      if (c.dir?.has(ri)) {
        arrows = el("path", { class: "arrows", style: `fill:${net.routes[ri].c}`, "data-route": ri });
        arrowsG.append(arrows);
      }
      routePaths.push({ el: path, c, ri, slot, isExtra, arrows });
      if (!slots.has(c)) slots.set(c, new Map());
      slots.get(c).set(ri, slot);
    };
    mains.forEach((ri, i) => add(ri, i - (kk - 1) / 2, false));
    // Övriga turer läggs utanför de vanliga linjerna, eller i mitten om de är ensamma.
    extras.forEach((ri, j) => add(ri, kk ? kk / 2 + 0.2 + j * 0.6 : (j - (extras.length - 1) / 2) * 0.6, true));
    for (const g of c.nodes) bundle.set(g, Math.max(bundle.get(g) || 0, Math.max(kk, 1)));
    if (c.routes.some((ri) => !c.alt?.has(ri))) c.nodes.forEach((g) => solid.add(g));
  }

  // Hållplatser: vanliga som smala markeringar tvärs över linjerna, knutpunkter som ringar.
  const stations = [];
  const placed = new Set();
  for (const c of layout.chains) {
    const w = Math.max(1, mainsOf(c).length) * step + 2.5;
    const minor = !c.routes.some((ri) => !c.alt?.has(ri));
    for (let i = 1; i < c.nodes.length - 1; i++) {
      const g = c.nodes[i];
      if (layout.key.has(g) || placed.has(g)) continue;
      placed.add(g);
      const mark = el("rect", { class: minor ? "station tick alt" : "station tick" });
      hook(mark, g);
      stopsG.append(mark);
      stations.push({ el: mark, g, c, i, w, minor });
    }
  }
  // Knutpunkter som syns även utzoomat: ändhållplatser, förgreningar, ställen med minst
  // tre linjer och byten till fots. Övriga namn visas först när man zoomar in.
  const endCount = new Map(), nodeRoutes = new Map();
  for (const c of layout.chains) {
    const mains = mainsOf(c);
    if (!mains.length) continue;
    for (const g of [c.nodes[0], c.nodes[c.nodes.length - 1]]) endCount.set(g, (endCount.get(g) || 0) + 1);
    for (const g of c.nodes) mains.forEach((ri) => (nodeRoutes.get(g) || nodeRoutes.set(g, new Set()).get(g)).add(ri));
  }
  const walkable = new Set((layout.links || []).flat());
  const isHub = (g) => endCount.get(g) === 1 || endCount.get(g) >= 3 || (nodeRoutes.get(g)?.size || 0) >= 3 || walkable.has(g);
  for (const g of layout.key) {
    const r = Math.min(6.5, Math.max(4.5, ((bundle.get(g) || 1) * step) / 2 + 1.5));
    // Knutpunkter som bara ligger på alternativa färdvägar ritas mindre.
    const minor = !solid.has(g);
    const mark = el("circle", { class: minor ? "station key alt" : "station key" });
    hook(mark, g);
    stopsG.append(mark);
    stations.push({ el: mark, g, r: minor ? 3.6 : r, minor, hub: !minor && isHub(g) });
  }
  // Gångvägar mellan närliggande hållplatser, under hållplatsringarna.
  const walks = (layout.links || []).map(([a, b]) => {
    const g = el("g", { class: "walk" });
    const outer = el("line", { class: "walk-o" }), inner = el("line", { class: "walk-i" });
    g.append(outer, inner);
    stopsG.prepend(g);
    return { a, b, g, lines: [outer, inner] };
  });
  const marker = el("circle", { class: "picked", visibility: "hidden" });
  stopsG.append(marker);
  let picked = null;

  function hook(node, g) {
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", groups[g].name);
    const title = el("title", {});
    title.textContent = groups[g].name;
    node.append(title);
    const pick = () => {
      picked = g;
      draw();
      onStop?.(g);
    };
    node.addEventListener("click", pick);
    node.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && pick());
  }

  // Aktuellt läge för en hållplatsgrupp vid blandningen t.
  const nodeAt = (g) => lerp(geoOf(g), layout.pos.get(g), t);

  let lastPts = new Map();
  let pz = null;
  // En vald färdväg (en eller flera turer på en linje) ritas tjock ovanpå, med pilar.
  let pattern = null; // { ri, seqs }
  function drawPattern(pts, f) {
    patternG.replaceChildren();
    svg.classList.toggle("has-pattern", !!pattern);
    if (!pattern) return;
    const color = net.routes[pattern.ri].c;
    for (const seq of pattern.seqs) {
      const line = [];
      for (let i = 1; i < seq.length; i++) {
        const [a, b] = [seq[i - 1], seq[i]];
        let part = null;
        for (const c of layout.chains) {
          const j = c.nodes.findIndex((g, n) => (g === a && c.nodes[n + 1] === b) || (g === b && c.nodes[n + 1] === a));
          if (j < 0) continue;
          const slot = slots.get(c)?.get(pattern.ri) ?? 0;
          const cp = pts.get(c);
          const sub = c.verts.map((v, n) => [v, cp[n]]).filter(([v]) => v.idx >= j - 1e-9 && v.idx <= j + 1 + 1e-9).map(([, p]) => p);
          part = offsetLine(dedupePts(sub), slot * step * f);
          if (c.nodes[j] !== a) part.reverse();
          break;
        }
        line.push(...(part || [nodeAt(a), nodeAt(b)]));
      }
      const d = dedupePts(line);
      if (d.length < 2) continue;
      const path = el("path", { class: "pattern", stroke: color, d: `M${d.map((p) => p.map((v) => v.toFixed(2)).join(" ")).join("L")}` });
      path.style.strokeWidth = `${LW * 1.7 * f}px`;
      const arrows = el("path", { class: "arrows", style: `fill:${color}`, d: arrowPath(d, 7.5 * f, 70 * f) });
      arrows.style.strokeWidth = `${1.2 * f}px`;
      patternG.append(path, arrows);
    }
  }

  function draw() {
    const f = sizeFactor(k);
    // Där fem eller fler linjer går tillsammans visas vanliga hållplatser först när man zoomat in.
    // Utzoomat: bara linjer och knutpunkter. Vanliga hållplatser när man zoomat in.
    const dense = !pz || k < pz.fitScale() * DETAIL;
    const pts = new Map(layout.chains.map((c) => [c, c.verts.map((v) => lerp(geoVert(c, v), v.schem, t))]));
    lastPts = pts;
    for (const { el: path, c, ri, slot, isExtra, arrows } of routePaths) {
      // Alternativa färdvägar visas bara för den valda linjen.
      const hidden = c.alt?.has(ri) && ri !== selRoute;
      path.style.display = hidden ? "none" : "";
      const line = offsetLine(dedupePts(pts.get(c)), slot * step * f);
      path.setAttribute("d", `M${line.map((p) => p.map((v) => v.toFixed(2)).join(" ")).join("L")}`);
      path.style.strokeWidth = `${(isExtra ? LW * 0.45 : LW) * f}px`;
      if (isExtra) path.style.strokeDasharray = `${5 * f} ${3.5 * f}`;
      if (arrows) {
        arrows.style.display = hidden ? "none" : "";
        arrows.style.strokeWidth = `${1.2 * f}px`;
        arrows.setAttribute("d", arrowPath(c.dir.get(ri) > 0 ? line : [...line].reverse(), (isExtra ? 5 : 7) * f, 80 * f));
      }
    }
    drawPattern(pts, f);
    for (const st of stations) {
      st.el.style.strokeWidth = `${(st.r ? 1.8 : 1.1) * f}px`;
      st.off = st.minor && !(st.c ? st.c.routes.includes(selRoute) : groups[st.g].routes.has(selRoute));
      if (st.r) {
        st.el.style.display = st.off ? "none" : "";
        const p = nodeAt(st.g);
        st.el.setAttribute("cx", p[0]);
        st.el.setAttribute("cy", p[1]);
        // Knutpunkter utan namn utzoomat ritas små, så att de inte ser ut som bytespunkter.
        st.el.setAttribute("r", (dense && !st.hub && !st.minor ? Math.min(st.r, 3.4) : st.r) * f);
        continue;
      }
      st.el.style.display = st.off || dense ? "none" : "";
      const line = pts.get(st.c);
      const p = line[st.c.verts.findIndex((v) => Math.abs(v.idx - st.i) < 1e-9)];
      const dir = segDir(line, p);
      const w = st.w * f, h = 4.2 * f;
      st.el.setAttribute("x", -h / 2);
      st.el.setAttribute("y", -w / 2);
      st.el.setAttribute("width", h);
      st.el.setAttribute("height", w);
      st.el.setAttribute("rx", h / 2);
      st.el.setAttribute("transform", `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)}) rotate(${(Math.atan2(dir[1], dir[0]) * 180) / Math.PI})`);
      st.p = p;
      st.dir = dir;
    }
    const off = new Set(stations.filter((st) => st.off).map((st) => st.g));
    for (const { a, b, g, lines } of walks) {
      g.style.display = off.has(a) || off.has(b) ? "none" : "";
      const [pa, pb] = [nodeAt(a), nodeAt(b)];
      lines.forEach((ln, i) => {
        ln.setAttribute("x1", pa[0]); ln.setAttribute("y1", pa[1]);
        ln.setAttribute("x2", pb[0]); ln.setAttribute("y2", pb[1]);
        ln.style.strokeWidth = `${(i ? 4 : 7.6) * f}px`;
      });
    }
    placeBuses();
    if (picked != null && layout.pos.has(picked)) {
      const p = nodeAt(picked);
      marker.setAttribute("cx", p[0]);
      marker.setAttribute("cy", p[1]);
      marker.setAttribute("r", 10 * f);
      marker.style.strokeWidth = `${3 * f}px`;
      marker.setAttribute("visibility", "visible");
    }
  }

  // Namnen placeras om för läget: i tunnelbanekartan vinkelrätt ut från linjen,
  // i den geografiska till höger om hållplatsen. Ändhållplatser får linjenummer.
  let names = null;
  function buildLabels() {
    labelsG.replaceChildren();
    const items = [];
    const schem = t > 0.5;
    if (schem) items.push(...terminusBadges());
    for (const st of stations) {
      if (st.off) continue;
      const g = st.g;
      const major = !!st.hub;
      const p = st.r ? nodeAt(g) : st.p;
      let dir = [0, 1];
      if (schem) {
        if (st.dir) dir = st.dir;
        else {
          const c = layout.chains.find((c) => c.nodes[0] === g || c.nodes[c.nodes.length - 1] === g);
          if (c) dir = segDir(c.line, layout.pos.get(g));
        }
      }
      let nx = -dir[1], ny = dir[0];
      if (nx < 0 || (nx === 0 && ny > 0)) [nx, ny] = [-nx, -ny];
      const pad = st.r || st.w / 2;
      items.push({ text: shortName(groups[g].name), p, nx, ny, pad: schem ? pad : Math.min(pad, 6), major, slant: schem && Math.abs(dir[1]) < 0.01 && !major, prio: groups[g].routes.size, minK: major ? 0 : pz.fitScale() * (st.r && !st.minor ? KEY_ZOOM : DETAIL) });
    }
    names = labelLayer(labelsG, items, obstacles);
    names.update(k);
  }

  // Linjenummer vid ändhållplatser där linjerna tar slut, utåt i linjens riktning.
  function terminusBadges() {
    const ends = new Map();
    for (const c of layout.chains) {
      if (!mainsOf(c).length) continue;
      for (const [g, atStart] of [[c.nodes[0], true], [c.nodes[c.nodes.length - 1], false]]) {
        if (!ends.has(g)) ends.set(g, []);
        ends.get(g).push({ c, atStart });
      }
    }
    const out = [];
    for (const [g, list] of ends) {
      if (list.length !== 1) continue;
      const { c, atStart } = list[0];
      const routes = mainsOf(c);
      if (!routes.length || c.line.length < 2) continue;
      const L = c.line;
      const [a, b] = atStart ? [L[1], L[0]] : [L[L.length - 2], L[L.length - 1]];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const st = stations.find((s) => s.g === g);
      out.push({ badges: routes.map((ri) => ({ text: net.routes[ri].name, c: net.routes[ri].c })), p: layout.pos.get(g), ox: (b[0] - a[0]) / d, oy: (b[1] - a[1]) / d, pad: st?.r || 6 });
    }
    return out;
  }

  // Det som namnen inte får täcka: linjerna och hållplatserna, i skärmens skala.
  function obstacles(add) {
    const f = sizeFactor(k);
    for (const c of layout.chains) {
      const line = lastPts.get(c);
      if (!line || !c.routes.some((ri) => !c.alt?.has(ri) || ri === selRoute)) continue;
      const kk = Math.max(1, mainsOf(c).length);
      const hw = ((kk * step) / 2) * f * k;
      sampleLine(line.map((p) => [p[0] * k, p[1] * k]), Math.max(3, hw), hw, add);
    }
    for (const st of stations) {
      const p = st.r ? nodeAt(st.g) : st.p;
      if (!p || st.el.style.display === "none") continue;
      add(p[0] * k, p[1] * k, (st.r || st.w / 2) * f * k);
    }
  }

  // --- Bussar ------------------------------------------------------------------------
  // Varje buss läggs på sin linje mellan de två hållplatser den är närmast, i samma
  // läge i knippet som linjen.
  const buses = new Map(); // id -> { el, v, at }
  let selRoute = selectedRoute;
  function locate(v) {
    const cos = Math.cos((v.lat * Math.PI) / 180);
    const px = v.lon * cos, py = v.lat;
    let best = null;
    for (const c of layout.chains) {
      const slot = slots.get(c)?.get(v.ri);
      if (slot == null || (c.alt?.has(v.ri) && v.ri !== selRoute)) continue;
      for (let i = 1; i < c.nodes.length; i++) {
        const A = groups[c.nodes[i - 1]], B = groups[c.nodes[i]];
        const ax = A.lon * cos, ay = A.lat, dx = B.lon * cos - ax, dy = B.lat - ay;
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1e-12)));
        const d = (ax + u * dx - px) ** 2 + (ay + u * dy - py) ** 2;
        if (!best || d < best.d) best = { d, c, f: (i - 1 + u) / (c.nodes.length - 1), slot };
      }
    }
    return best;
  }
  function placeBuses() {
    busesG.style.display = t < 0.999 ? "none" : "";
    if (t < 0.999) return;
    // Utzoomat är bussarna prickar i linjens färg; skylten med nummer visas inzoomat.
    busesG.classList.toggle("dots", !!pz && k < pz.fitScale() * DETAIL);
    const f = sizeFactor(k);
    for (const b of buses.values()) {
      if (!b.at) continue;
      const { c, f: along_, slot } = b.at;
      const p = along(c.line, along_);
      const dir = segDir(c.line, p);
      const o = slot * step * f;
      // Bussarna krymper lite när hela nätet visas, så att de inte täcker linjerna.
      const size = Math.max(0.7, Math.min(1, k));
      b.el.setAttribute("transform", `translate(${(p[0] - dir[1] * o).toFixed(2)} ${(p[1] + dir[0] * o).toFixed(2)}) scale(${size / k})`);
    }
  }
  function busNode(v) {
    const g = el("g", { class: "bus", role: "button", tabindex: "0" });
    // Avrundad skylt med en liten buss, så att den skiljer sig från linjenumren vid ändhållplatserna.
    const r = el("rect", { y: -10, height: 20, rx: 10 });
    const t = el("text", { y: 4.2, "text-anchor": "start" });
    const icon = el("path", { class: "icon", d: "M-3.5 -5h7a1.5 1.5 0 0 1 1.5 1.5v7h-10v-7a1.5 1.5 0 0 1 1.5-1.5ZM-5 0.5h10M-2.8 3.5v1.6M2.8 3.5v1.6" });
    const title = el("title", {});
    const dot = el("circle", { class: "dot", r: 6 });
    g.append(r, icon, t, title, dot);
    const open = (e) => { e.stopPropagation(); onBus?.(v.id); };
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && open(e));
    g.addEventListener("pointerdown", (e) => e.stopPropagation());
    return g;
  }
  // list: [{ id, ri, lat, lon, stale, sel, label }]
  function setVehicles(list) {
    const seen = new Set();
    for (const v of list) {
      if (!net.routes[v.ri]) continue;
      const at = locate(v);
      if (!at) continue;
      seen.add(v.id);
      let b = buses.get(v.id);
      if (!b) {
        b = { el: busNode(v) };
        buses.set(v.id, b);
        busesG.append(b.el);
      }
      Object.assign(b, { v, at });
      const name = net.routes[v.ri].name;
      const w = name.length * 7.4 + 30;
      const [rect, icon, text, title, dot] = b.el.children;
      rect.setAttribute("x", -w / 2);
      rect.setAttribute("width", w);
      icon.setAttribute("transform", `translate(${-w / 2 + 12} 0)`);
      text.setAttribute("x", -w / 2 + 20);
      rect.setAttribute("fill", v.stale ? "#8b9792" : net.routes[v.ri].c);
      dot.setAttribute("fill", v.stale ? "#8b9792" : net.routes[v.ri].c);
      text.textContent = name;
      title.textContent = v.label || `Linje ${name}`;
      b.el.dataset.route = v.ri;
      b.el.classList.toggle("sel", !!v.sel);
      b.el.classList.toggle("dim", selRoute != null && selRoute !== v.ri);
    }
    for (const [id, b] of buses) if (!seen.has(id)) { b.el.remove(); buses.delete(id); }
    placeBuses();
  }

  draw();
  const content = view.getBBox();
  pz = panZoom(svg, view, content, (nk) => {
    k = nk;
    draw();
    names?.update(k);
  }, padding);
  buildLabels();

  let anim = null;
  const api = {
    get mode() {
      return t;
    },
    setVehicles,
    select(ri) {
      const changed = selRoute !== ri;
      selRoute = ri;
      if (changed) {
        draw();
        buildLabels();
      }
      for (const b of buses.values()) b.el.classList.toggle("dim", ri != null && ri !== b.v.ri);
      svg.classList.toggle("has-sel", ri != null);
      for (const g of [extraG, linesG, arrowsG]) {
        for (const p of g.children) p.classList.toggle("sel", +p.dataset.route === ri);
        for (const p of [...g.children]) if (+p.dataset.route === ri) g.append(p);
      }
    },
    // Visa en färdväg: turerna vis på linjen ri (null tar bort).
    showPattern(ri, vis) {
      const seqs = ri == null ? [] : vis.map((vi) => layout.variantSeqs?.get(ri)?.get(vi)).filter(Boolean);
      pattern = seqs.length ? { ri, seqs } : null;
      draw();
    },
    fit: pz.fit,
    zoom: pz.zoom,
    transform: pz.transform,
    focus(g) {
      if (!layout.pos.has(g)) return;
      picked = g;
      draw();
      pz.center(nodeAt(g), 2.5);
    },
    // Byt läge direkt, utan animation.
    jump(to, { geo: g } = {}) {
      if (g) geoOf = g;
      cancelAnimationFrame(anim);
      t = to;
      draw();
      buildLabels();
    },
    // Glid till läget `to` (0 = geografiskt, 1 = tunnelbana). geo kan bytas samtidigt.
    morph(to, { ms = 900, geo: g } = {}) {
      if (g) geoOf = g;
      cancelAnimationFrame(anim);
      const from = t;
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      svg.classList.add("morphing");
      return new Promise((done) => {
        const start = performance.now();
        const frame = (now) => {
          const s = reduce ? 1 : Math.min(1, (now - start) / ms);
          const e = s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2;
          t = from + (to - from) * e;
          draw();
          if (s < 1) anim = requestAnimationFrame(frame);
          else {
            t = to;
            draw();
            svg.classList.remove("morphing");
            buildLabels();
            done();
          }
        };
        anim = requestAnimationFrame(frame);
      });
    },
  };
  api.select(selectedRoute);
  return api;
}

// Geografiska lägen inpassade i tunnelbanekartans ruta, med rätt proportioner.
function defaultGeo(groups, layout) {
  const nodes = [...layout.pos.keys()];
  const lat0 = nodes.reduce((s, g) => s + groups[g].lat, 0) / nodes.length;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const raw = new Map(nodes.map((g) => [g, [groups[g].lon * cos0, -groups[g].lat]]));
  const box = (pts) => {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const [ax, ay, bx, by] = box([...raw.values()]);
  const [sx, sy, ex, ey] = box([...layout.pos.values()]);
  const s = Math.min((ex - sx) / (bx - ax || 1), (ey - sy) / (by - ay || 1));
  const ox = (sx + ex) / 2 - ((ax + bx) / 2) * s, oy = (sy + ey) / 2 - ((ay + by) / 2) * s;
  return (g) => {
    const p = raw.get(g) || [groups[g].lon * cos0, -groups[g].lat];
    return [p[0] * s + ox, p[1] * s + oy];
  };
}

// Hur stora linjer och hållplatser ritas i kartans enheter vid zoom k. På skärmen
// växer de bara måttligt: mellan 0,5 och 1,3 gånger grundstorleken.
export function sizeFactor(k) {
  return Math.max(0.5, Math.min(1.3, k)) / k;
}

// Hållplatsnamn och linjenummer i konstant skärmstorlek. Varje namn prövar några lägen
// (på ena eller andra sidan om linjen, eller snett) och tar det första som inte täcker
// en linje, en hållplats eller ett annat namn. Vanliga hållplatser utan plats döljs;
// knutpunkter visas alltid.
//
// items: { text, p, nx, ny, pad, major, slant, prio, minK } (minK: dolt vid mindre zoom) eller { badges: [{ text, c }], p, ox, oy, pad }.
// p är i kartans enheter, pad hållplatsens radie i grundstorlek (skalas som i sizeFactor).
// obstacles(add) lägger till hinder som cirklar add(x, y, r) i skärmens skala (kartan * k).
const DETAIL = 1.6; // vanliga hållplatser och deras namn, gånger zoomen för hela kartan
const KEY_ZOOM = 1.25; // övriga knutpunkters namn
const BADGE_H = 17;

export function labelLayer(group, items, obstacles = () => {}) {
  const nodes = items.map((it) => {
    if (it.badges) {
      const g = el("g", { class: "tbadges" });
      let x = 0;
      it.widths = it.badges.map((b) => {
        const w = Math.max(26, b.text.length * 7.6 + 10);
        const r = el("rect", { x, y: -BADGE_H / 2, width: w, height: BADGE_H, rx: 5, fill: b.c });
        const t = el("text", { x: x + w / 2, y: 4, "text-anchor": "middle" });
        t.textContent = b.text;
        g.append(r, t);
        x += w + 3;
        return w;
      });
      it.total = x - 3;
      group.append(g);
      return g;
    }
    const t = el("text", { class: it.major ? "lbl major" : "lbl" });
    t.textContent = it.text;
    group.append(t);
    return t;
  });
  let timer, k = 1;

  // Storleken kommer från stilmallen (mindre på mobil).
  const fontSize = (it, i) => (it.fs ??= parseFloat(getComputedStyle(nodes[i]).fontSize) || 12.5);
  const width = (it, i) => {
    if (it.w) return it.w;
    const fs = fontSize(it, i);
    const w = nodes[i].getComputedTextLength?.() || 0;
    if (w > 0) it.w = w;
    return w || it.text.length * fs * 0.56;
  };

  // Lägen för ett namn: geometri i skärmpixlar relativt hållplatsen.
  function candidates(it, i) {
    const padS = it.pad * Math.max(0.5, Math.min(1.3, k));
    if (it.badges) {
      const horiz = Math.abs(it.ox) >= 0.38;
      const gap = padS + 4;
      let x0, y0;
      if (horiz) {
        x0 = it.ox > 0 ? it.ox * gap : it.ox * gap - it.total;
        y0 = it.oy * (gap + BADGE_H / 2);
      } else {
        x0 = -(it.badges.length > 1 ? it.total / 2 : it.widths[0] / 2);
        y0 = it.oy > 0 ? gap + BADGE_H / 2 : -gap - BADGE_H / 2;
      }
      return [{ badge: true, x: x0, y: y0 }];
    }
    const fs = fontSize(it, i);
    const w = width(it, i);
    const gap = padS + 5;
    const side = (nx, ny) => {
      const anchor = nx > 0.3 ? "start" : nx < -0.3 ? "end" : "middle";
      const x = nx * gap;
      const y = ny * gap + (ny > 0.3 ? fs * 0.8 : ny < -0.3 ? -fs * 0.15 : fs * 0.35);
      const left = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
      return { x, y, anchor, a: [left, y - fs * 0.35], u: [1, 0], w, fs };
    };
    const slant = (up) => {
      const s = up ? [3, -padS - 3] : [-3, padS + 3];
      const u = [Math.SQRT1_2, -Math.SQRT1_2], v = [-Math.SQRT1_2, -Math.SQRT1_2];
      const a = up ? [s[0] + v[0] * fs * 0.35, s[1] + v[1] * fs * 0.35] : [s[0] - u[0] * w + v[0] * fs * 0.35, s[1] - u[1] * w + v[1] * fs * 0.35];
      return { slant: true, s, anchor: up ? "start" : "end", a, u, w, fs };
    };
    if (it.slant) return [slant(true), slant(false)];
    const list = [side(it.nx, it.ny), side(-it.nx, -it.ny)];
    if (it.major) list.push(side(1, 0), side(-1, 0), side(0, -1), side(0, 1));
    return list;
  }

  // Namnets yta som en rad cirklar längs texten.
  function shape(c, it) {
    if (c.badge) {
      const r = BADGE_H / 2 + 1;
      const out = [];
      for (let x = c.x + r - 1; x <= c.x + it.total - r + 1; x += r) out.push([x, c.y, r]);
      out.push([c.x + it.total - r + 1, c.y, r]);
      return out;
    }
    const r = c.fs * 0.6;
    const out = [];
    const n = Math.max(1, Math.ceil((c.w - 2 * r) / (r * 0.9)));
    for (let j = 0; j <= n; j++) {
      const s = Math.min(c.w - r, r + j * r * 0.9);
      out.push([c.a[0] + c.u[0] * s, c.a[1] + c.u[1] * s, r]);
    }
    return out;
  }

  function apply(it, i, c) {
    const node = nodes[i];
    const [px, py] = it.p;
    const base = `translate(${px.toFixed(2)} ${py.toFixed(2)}) scale(${1 / k})`;
    if (c.badge) return node.setAttribute("transform", `${base} translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
    node.setAttribute("text-anchor", c.anchor);
    if (c.slant) {
      node.setAttribute("x", 0);
      node.setAttribute("y", 0);
      node.setAttribute("transform", `${base} translate(${c.s[0].toFixed(1)} ${c.s[1].toFixed(1)}) rotate(-45)`);
    } else {
      node.setAttribute("x", c.x.toFixed(1));
      node.setAttribute("y", c.y.toFixed(1));
      node.setAttribute("transform", base);
    }
  }

  function place() {
    items.forEach((it, i) => apply(it, i, candidates(it, i)[it.pick || 0]));
  }

  // Först ett läge som varken täcker linjer eller andra namn. Knutpunkter får i andra
  // hand ligga över en linje, men aldrig över ett annat namn.
  function declutter() {
    const lines = new Grid(24), labels = new Grid(24);
    obstacles((x, y, r) => lines.add(x, y, r));
    const order = items.map((_, i) => i).sort((a, b) => !!items[b].badges - !!items[a].badges || items[b].major - items[a].major || items[b].prio - items[a].prio);
    for (const i of order) {
      const it = items[i];
      const [px, py] = [it.p[0] * k, it.p[1] * k];
      const cands = candidates(it, i);
      const free = (j, grids) => shape(cands[j], it).every(([x, y, r]) => grids.every((g) => !g.hit(px + x, py + y, r)));
      let pick = k < (it.minK || 0) ? -1 : cands.findIndex((_, j) => free(j, [lines, labels]));
      if (pick < 0 && (it.major || it.badges)) pick = cands.findIndex((_, j) => free(j, [labels]));
      if (pick < 0 && it.badges) pick = 0;
      nodes[i].classList.toggle("hidden", pick < 0);
      if (pick < 0) continue;
      it.pick = pick;
      apply(it, i, cands[pick]);
      for (const [x, y, r] of shape(cands[pick], it)) labels.add(px + x, py + y, r);
    }
  }

  return {
    update(nk) {
      k = nk;
      place();
      clearTimeout(timer);
      timer = setTimeout(declutter, 60);
    },
  };
}

// Enkelt rutnät för att snabbt hitta överlappande cirklar.
class Grid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }
  *cells(x, y, r) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) yield `${i},${j}`;
  }
  add(x, y, r) {
    for (const key of this.cells(x, y, r)) {
      if (!this.map.has(key)) this.map.set(key, []);
      this.map.get(key).push([x, y, r]);
    }
  }
  hit(x, y, r) {
    for (const key of this.cells(x, y, r)) {
      for (const [ox, oy, or] of this.map.get(key) || []) if ((ox - x) ** 2 + (oy - y) ** 2 < (or + r) ** 2) return true;
    }
    return false;
  }
}

// Punkter med jämna mellanrum längs en linje.
function sampleLine(line, every, r, add) {
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(l / every));
    for (let j = 0; j <= n; j++) add(a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n, r);
  }
}

function segDir(line, p) {
  // Riktningen på den del av linjen som punkten ligger på.
  let best = [1, 0], bestD = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    if (d < bestD - 0.01) {
      bestD = d;
      const l = Math.sqrt(l2);
      best = [dx / l, dy / l];
    }
  }
  return best;
}

function el(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// padding() ger hur mycket av ytan som täcks av knappar och paneler: { top, right, bottom, left }.
export function panZoom(svg, view, box, onZoom, padding = null) {
  let k = 1, tx = 0, ty = 0, lastK = null, fitK = 1;
  const apply = () => {
    view.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
    if (k !== lastK) {
      lastK = k;
      onZoom?.(k);
    }
  };
  const fit = () => {
    const w = svg.clientWidth || 800, h = svg.clientHeight || 600;
    // Extra marginal på sidorna för namnen, som ritas i skärmstorlek utanför linjerna.
    const m = 24, side = Math.min(70, w * 0.16);
    const p = { top: 0, right: 0, bottom: 0, left: 0, ...(padding?.() || {}) };
    const [l, r, t, b] = [p.left + side, p.right + side, p.top + m, p.bottom + m];
    k = fitK = Math.max(0.1, Math.min((w - l - r) / box.width, (h - t - b) / box.height));
    tx = l + (w - l - r - box.width * k) / 2 - box.x * k;
    ty = t + (h - t - b - box.height * k) / 2 - box.y * k;
    apply();
  };
  // Mitten av den del av ytan som syns.
  const mid = () => {
    const p = { top: 0, right: 0, bottom: 0, left: 0, ...(padding?.() || {}) };
    return [(p.left + svg.clientWidth - p.right) / 2, (p.top + svg.clientHeight - p.bottom) / 2];
  };
  const zoomAt = (f, cx, cy) => {
    const nk = Math.max(0.1, Math.min(10, k * f));
    tx = cx - ((cx - tx) * nk) / k;
    ty = cy - ((cy - ty) * nk) / k;
    k = nk;
    apply();
  };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  const pts = new Map();
  let last = null;
  svg.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    last = null;
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) {
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      if (Math.abs(dx) + Math.abs(dy) > 0) svg.classList.add("dragging");
      tx += dx;
      ty += dy;
      apply();
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = svg.getBoundingClientRect();
      if (last) zoomAt(d / last, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
      last = d;
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    last = null;
    setTimeout(() => svg.classList.remove("dragging"), 0);
  };
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  // Passa in kartan igen bara när ytan faktiskt ändrar storlek.
  let size = `${svg.clientWidth}x${svg.clientHeight}`;
  new ResizeObserver(() => {
    const now = `${svg.clientWidth}x${svg.clientHeight}`;
    if (now !== size) {
      size = now;
      fit();
    }
  }).observe(svg);
  fit();
  return {
    fit,
    zoom: (f) => zoomAt(f, ...mid()),
    // Nuvarande vy: skärmpunkt = kartpunkt * k + [tx, ty].
    transform: () => ({ k, tx, ty }),
    // Skalan när hela kartan visas.
    fitScale: () => fitK,
    // Centrera på p, minst `zoom` gånger inzoomat jämfört med hela kartan.
    center(p, zoom) {
      const [cx, cy] = mid();
      k = Math.max(k, fitK * zoom);
      tx = cx - p[0] * k;
      ty = cy - p[1] * k;
      apply();
    },
  };
}
