// Linjenätskarta i tunnelbanestil, ritad automatiskt ur linjenätet.
//
// 1. Hållplatserna blir noder och linjernas huvudformer blir kanter.
// 2. Knutpunkter är ändhållplatser, förgreningar och ställen där linjeutbudet ändras.
//    Mellan två knutpunkter går en "sträcka" med de vanliga hållplatserna.
// 3. Knutpunkterna placeras ungefär geografiskt, men centrum förstoras och
//    ytterområden trycks ihop, och lägena låses till ett rutnät.
// 4. Varje sträcka ritas med raka linjer i 0°, 45° eller 90°, och linjer som delar
//    sträcka läggs bredvid varandra.

import { shortName } from "./network.js";

const SVG = "http://www.w3.org/2000/svg";

export function layoutSchematic(net, groups, stopGroup, routeIdx, opts = {}) {
  const spacing = opts.spacing ?? 24; // minsta avstånd mellan hållplatser, px
  const grid = opts.grid ?? 12;
  const power = opts.power ?? 0.5; // < 1 förstorar centrum

  // --- Graf --------------------------------------------------------------------
  // Varje linje ritas som en väg: huvudformen med flest hållplatser, plus de delar av
  // motsatt riktning som går via andra hållplatser (t.ex. enkelriktade slingor).
  const paths = [];
  for (const ri of routeIdx) {
    const seqs = net.routes[ri].variants
      .filter((v) => v.main)
      .map((v) => {
        const seq = [];
        for (const s of v.stops) {
          const g = stopGroup[s];
          if (seq[seq.length - 1] !== g) seq.push(g);
        }
        return seq;
      })
      .filter((seq) => seq.length > 1)
      .sort((a, b) => b.length - a.length);
    if (!seqs.length) continue;
    const seen = new Set(seqs[0]);
    paths.push({ ri, seq: seqs[0] });
    for (const seq of seqs.slice(1)) {
      // Behåll bara bitar som rör nya hållplatser, med en känd hållplats i varje ände.
      let part = [];
      for (let i = 0; i < seq.length; i++) {
        const fresh = !seen.has(seq[i]);
        if (fresh) {
          if (!part.length && i > 0) part.push(seq[i - 1]);
          part.push(seq[i]);
        } else if (part.length) {
          part.push(seq[i]);
          paths.push({ ri, seq: part });
          part = [];
        }
      }
      if (part.length > 1) paths.push({ ri, seq: part });
      seq.forEach((g) => seen.add(g));
    }
  }
  const edges = new Map();
  const adj = new Map();
  const ekey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const { ri, seq } of paths) {
    for (let i = 1; i < seq.length; i++) {
      const [a, b] = [seq[i - 1], seq[i]];
      if (a === b) continue;
      const k = ekey(a, b);
      if (!edges.has(k)) edges.set(k, { a, b, routes: new Set() });
      edges.get(k).routes.add(ri);
      link(a, b);
      link(b, a);
    }
  }
  const routeSet = (a, b) => [...edges.get(ekey(a, b)).routes].sort((x, y) => x - y).join(",");

  // --- Knutpunkter och sträckor ---------------------------------------------------
  const key = new Set();
  for (const { seq } of paths) {
    key.add(seq[0]);
    key.add(seq[seq.length - 1]);
  }
  for (const [n, nb] of adj) {
    if (nb.size !== 2) key.add(n);
    else {
      const [x, y] = [...nb];
      if (routeSet(n, x) !== routeSet(n, y)) key.add(n);
    }
  }
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
      chains.push({ nodes, routes: [...edges.get(ekey(nodes[0], nodes[1])).routes].sort((x, y) => x - y) });
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
  const ratios = chains
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
  const keys = [...key];
  const relaxed = new Map(keys.map((g) => [g, target(g)]));
  const springs = chains
    .filter((c) => c.nodes[0] !== c.nodes[c.nodes.length - 1])
    .map((c) => [c.nodes[0], c.nodes[c.nodes.length - 1], (c.nodes.length - 1) * spacing]);
  const minGap = grid * 4;
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
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) push(keys[i], keys[j], minGap, 0.25);
    for (const g of keys) {
      const p = relaxed.get(g), t = target(g), f = force.get(g);
      p[0] += f[0] + (t[0] - p[0]) * 0.008;
      p[1] += f[1] + (t[1] - p[1]) * 0.008;
    }
  }
  const shift = (g) => {
    const p = relaxed.get(g), t = target(g);
    return [p[0] - t[0], p[1] - t[1]];
  };
  // Viktigaste knutpunkterna först så att de får sina bästa lägen.
  keys.sort((a, b) => groups[b].routes.size - groups[a].routes.size).forEach((g) => place(g, relaxed.get(g)));

  // --- Sträckornas form ---------------------------------------------------------------
  for (const c of chains) {
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
      line.push(...octilinear(pinPos[j - 1], pinPos[j], hint).slice(1));
    }
    c.line = dedupePts(line);
    // Hållplatserna fördelas jämnt längs hela sträckan; mellanpunkterna formar bara linjen.
    c.nodePos = c.nodes.map((_, i) => along(c.line, i / (n - 1)));
    for (let i = 1; i < n - 1; i++) if (!key.has(c.nodes[i])) pos.set(c.nodes[i], c.nodePos[i]);
  }

  return { chains, pos, key, center, routes: routeIdx };
}

// Två raka delar, en diagonal och en rak, mellan p och q. Böjen läggs på den sida
// som ligger närmast hållplatsernas verkliga läge.
function octilinear(p, q, hint) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx === 0 || ady === 0 || adx === ady) return [p, q];
  const d = Math.min(adx, ady), sx = Math.sign(dx), sy = Math.sign(dy);
  const a = [p[0] + sx * d, p[1] + sy * d];
  const b = [q[0] - sx * d, q[1] - sy * d];
  const da = Math.hypot(a[0] - hint[0], a[1] - hint[1]);
  const db = Math.hypot(b[0] - hint[0], b[1] - hint[1]);
  return [p, da <= db ? a : b, q];
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

const LW = 5; // linjebredd
const GAP = 1.5;

// opts.geo(g) ger hållplatsgruppens geografiska läge i kartans enheter. Utan den
// projiceras longitud/latitud in i samma ruta som tunnelbanekartan.
export function renderSchematic(container, net, groups, layout, { onStop, onRoute, selectedRoute = null, extra = new Set(), geo = null, mode = 1 } = {}) {
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
  const stopsG = el("g", { class: "stations" });
  const labelsG = el("g", { class: "labels" });
  view.append(extraG, linesG, stopsG, labelsG);

  const step = LW + GAP;
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
  const routePaths = [];
  for (const c of layout.chains) {
    const mains = c.routes.filter((ri) => !extra.has(ri));
    const extras = c.routes.filter((ri) => extra.has(ri));
    const kk = mains.length;
    const add = (ri, slot, isExtra) => {
      const path = el("path", { class: isExtra ? "route extra" : "route", stroke: net.routes[ri].c, "data-route": ri });
      path.addEventListener("click", () => onRoute?.(ri));
      (isExtra ? extraG : linesG).append(path);
      routePaths.push({ el: path, c, slot, isExtra });
    };
    mains.forEach((ri, i) => add(ri, i - (kk - 1) / 2, false));
    // Övriga turer läggs utanför de vanliga linjerna, eller i mitten om de är ensamma.
    extras.forEach((ri, j) => add(ri, kk ? kk / 2 + 0.2 + j * 0.6 : (j - (extras.length - 1) / 2) * 0.6, true));
    for (const g of c.nodes) bundle.set(g, Math.max(bundle.get(g) || 0, Math.max(kk, 1)));
  }

  // Hållplatser: vanliga som avlånga markeringar tvärs över linjerna, knutpunkter som ringar.
  const stations = [];
  const placed = new Set();
  for (const c of layout.chains) {
    const w = Math.max(1, c.routes.filter((ri) => !extra.has(ri)).length) * step + 2;
    for (let i = 1; i < c.nodes.length - 1; i++) {
      const g = c.nodes[i];
      if (layout.key.has(g) || placed.has(g)) continue;
      placed.add(g);
      const mark = el("rect", { class: "station" });
      hook(mark, g);
      stopsG.append(mark);
      stations.push({ el: mark, g, c, i, w });
    }
  }
  for (const g of layout.key) {
    const r = Math.min(9, Math.max(6, ((bundle.get(g) || 1) * step) / 2 + 2));
    const mark = el("circle", { class: "station key" });
    hook(mark, g);
    stopsG.append(mark);
    stations.push({ el: mark, g, r });
  }
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

  function draw() {
    const f = sizeFactor(k);
    const pts = new Map(layout.chains.map((c) => [c, c.verts.map((v) => lerp(geoVert(c, v), v.schem, t))]));
    for (const { el: path, c, slot, isExtra } of routePaths) {
      const line = offsetLine(dedupePts(pts.get(c)), slot * step * f);
      path.setAttribute("d", `M${line.map((p) => p.map((v) => v.toFixed(2)).join(" ")).join("L")}`);
      path.style.strokeWidth = `${(isExtra ? LW * 0.45 : LW) * f}px`;
      if (isExtra) path.style.strokeDasharray = `${5 * f} ${3.5 * f}`;
    }
    for (const st of stations) {
      st.el.style.strokeWidth = `${1.5 * f}px`;
      if (st.r) {
        const p = nodeAt(st.g);
        st.el.setAttribute("cx", p[0]);
        st.el.setAttribute("cy", p[1]);
        st.el.setAttribute("r", st.r * f);
        continue;
      }
      const line = pts.get(st.c);
      const p = line[st.c.verts.findIndex((v) => Math.abs(v.idx - st.i) < 1e-9)];
      const dir = segDir(line, p);
      const w = st.w * f, h = 7 * f;
      st.el.setAttribute("x", -h / 2);
      st.el.setAttribute("y", -w / 2);
      st.el.setAttribute("width", h);
      st.el.setAttribute("height", w);
      st.el.setAttribute("rx", h / 2);
      st.el.setAttribute("transform", `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)}) rotate(${(Math.atan2(dir[1], dir[0]) * 180) / Math.PI})`);
      st.p = p;
      st.dir = dir;
    }
    if (picked != null && layout.pos.has(picked)) {
      const p = nodeAt(picked);
      marker.setAttribute("cx", p[0]);
      marker.setAttribute("cy", p[1]);
      marker.setAttribute("r", 13 * f);
      marker.style.strokeWidth = `${3 * f}px`;
      marker.setAttribute("visibility", "visible");
    }
  }

  // Namnen placeras om för läget: i tunnelbanekartan vinkelrätt ut från linjen,
  // i den geografiska till höger om hållplatsen.
  let names = null;
  function buildLabels() {
    labelsG.replaceChildren();
    const items = [];
    const schem = t > 0.5;
    for (const st of stations) {
      const g = st.g;
      const major = !!st.r;
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
      items.push({ text: shortName(groups[g].name), p, nx, ny, pad: schem ? pad : Math.min(pad, 6), major, rotate: schem && Math.abs(dir[1]) < 0.01 && !major, prio: groups[g].routes.size });
    }
    names = labelLayer(labelsG, items);
    names.update(k);
  }

  draw();
  const content = view.getBBox();
  const pz = panZoom(svg, view, content, (nk) => {
    k = nk;
    draw();
    names?.update(k);
  });
  buildLabels();

  let anim = null;
  const api = {
    get mode() {
      return t;
    },
    select(ri) {
      svg.classList.toggle("has-sel", ri != null);
      for (const g of [extraG, linesG]) {
        for (const p of g.children) p.classList.toggle("sel", +p.dataset.route === ri);
        for (const p of [...g.children]) if (+p.dataset.route === ri) g.append(p);
      }
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
// växer de bara måttligt: mellan 0,6 och 1,6 gånger grundstorleken.
export function sizeFactor(k) {
  return Math.max(0.6, Math.min(1.6, k)) / k;
}

// Hållplatsnamn i konstant skärmstorlek. items: { text, p, nx, ny, pad, major, rotate, prio }.
// pad är hållplatsens radie i grundstorlek och skalas som hållplatsen (se sizeFactor).
export function labelLayer(group, items) {
  const nodes = items.map((it) => {
    const t = el("text", { class: it.major ? "lbl major" : "lbl" });
    t.textContent = it.text;
    group.append(t);
    return t;
  });
  let timer;
  function place(k) {
    items.forEach((it, i) => {
      const t = nodes[i];
      t.style.fontSize = `${(it.major ? 13 : 11.5) / k}px`;
      t.style.strokeWidth = `${3.5 / k}px`;
      const [x, y] = it.p;
      const pad = it.pad * sizeFactor(k);
      if (it.rotate) {
        t.setAttribute("transform", `translate(${x + 3 / k} ${y - pad - 3 / k}) rotate(-45)`);
      } else {
        const gap = pad + 5 / k;
        t.setAttribute("x", x + it.nx * gap);
        t.setAttribute("y", y + it.ny * gap + 4 / k);
        t.setAttribute("text-anchor", it.nx > 0.3 ? "start" : it.nx < -0.3 ? "end" : "middle");
      }
    });
  }
  function declutter() {
    for (const t of nodes) t.classList.remove("hidden");
    const order = items.map((it, i) => i).sort((a, b) => items[b].major - items[a].major || items[b].prio - items[a].prio);
    const boxes = [];
    for (const i of order) {
      const r = nodes[i].getBoundingClientRect();
      const b = { left: r.left - 2, right: r.right + 2, top: r.top - 1, bottom: r.bottom + 1 };
      if (boxes.some((o) => b.left < o.right && b.right > o.left && b.top < o.bottom && b.bottom > o.top)) nodes[i].classList.add("hidden");
      else boxes.push(b);
    }
  }
  return {
    update(k) {
      place(k);
      clearTimeout(timer);
      timer = setTimeout(declutter, 60);
    },
  };
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

export function panZoom(svg, view, box, onZoom) {
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
    const m = 40;
    k = fitK = Math.min((w - 2 * m) / box.width, (h - 2 * m) / box.height);
    tx = (w - box.width * k) / 2 - box.x * k;
    ty = (h - box.height * k) / 2 - box.y * k;
    apply();
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
    zoom: (f) => zoomAt(f, svg.clientWidth / 2, svg.clientHeight / 2),
    // Nuvarande vy: skärmpunkt = kartpunkt * k + [tx, ty].
    transform: () => ({ k, tx, ty }),
    // Centrera på p, minst `zoom` gånger inzoomat jämfört med hela kartan.
    center(p, zoom) {
      const w = svg.clientWidth, h = svg.clientHeight;
      k = Math.max(k, fitK * zoom);
      tx = w / 2 - p[0] * k;
      ty = h / 2 - p[1] * k;
      apply();
    },
  };
}
