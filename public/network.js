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
