// Små hjälpfunktioner för att läsa GTFS och förenkla linjeformer.

// Går igenom en GTFS-tabell rad för rad och anropar onRow med ett objekt per rad.
// Klarar citattecken, kommatecken i fält och BOM.
export function eachRow(text, onRow) {
  if (!text) return;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let header = null;
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (; pos < n; pos++) {
      const c = text[pos];
      if (quoted) {
        if (c === '"') {
          if (text[pos + 1] === '"') { field += '"'; pos++; }
          else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { fields.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[pos + 1] === "\n") pos++;
        pos++;
        break;
      } else field += c;
    }
    fields.push(field);
    if (fields.length === 1 && fields[0] === "") continue;
    if (!header) { header = fields.map((f) => f.trim()); continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = fields[i] ?? "";
    onRow(row);
  }
}

// "25:13:00" -> sekunder efter midnatt (kan vara över 24 h enligt GTFS).
export function parseTime(t) {
  if (!t) return null;
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

export function inBox([lon, lat], [w, s, e, n]) {
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

// Douglas–Peucker i meter. Punkter är [lon, lat].
export function simplify(points, toleranceMeters) {
  if (points.length < 3) return points;
  const lat0 = (points[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const xy = points.map(([lon, lat]) => [lon * kx, lat * ky]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tol2 = toleranceMeters * toleranceMeters;
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(xy[i], xy[a], xy[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function segDist2(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t = dx || dy ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy) : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

// Tar bort punkter som ligger på exakt samma plats som föregående.
export function dedupe(points) {
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}
