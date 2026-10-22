// Egen data från Trafiklab: avgångar, bussarnas turer och reseförslag räknas fram här
// ur tidtabellen (data/days/ÅÅÅÅ-MM-DD.json, byggs varje natt) och realtiden som
// proxyn hämtar från Trafiklab (/vehicles, /updates, /alerts).
//
// Svaren har samma form som Busskollens API, så att sidan kan falla tillbaka på det
// om något här inte går att hämta.

const TZ = "Europe/Stockholm";
const UPDATES_SECONDS = 30; // hur ofta förseningarna hämtas om från proxyn
const MIN_TRANSFER = 300; // minsta bytestid i sekunder
const MAX_WAIT = 90 * 60; // längsta väntan vid byte
const PLAN_WINDOW = 4 * 3600; // varje sökning efter reseförslag täcker så här lång tid

const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const isoDate = (epoch) => dayFmt.format(new Date(epoch * 1000));

// GTFS-tider räknas från "tolv timmar före klockan 12" på trafikdagen, vilket blir
// midnatt utom de dagar sommartiden börjar eller slutar.
export function serviceDayStart(date) {
  const noon = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12) / 1000;
  return noon - tzOffset(noon) - 12 * 3600;
}
function tzOffset(epoch) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(epoch * 1000)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - epoch;
}

export function createLive(net, { groups, stopGroup }, apiBase, getJSON = defaultGetJSON) {
  const days = new Map(); // datum -> Promise
  const trips = []; // { id, ri, vi, sign, signs, stops, times }
  const byStop = new Map(); // hållplatsindex -> [{ trip, pos }]
  const byId = new Map(); // trip_id -> [tur per trafikdag]
  let updates = {};
  let updatesAt = 0;
  let updatesRun = null;
  const vehicles = new Map();
  const now = () => Date.now() / 1000;

  function loadDay(date) {
    if (!days.has(date)) {
      days.set(date, getJSON(`data/days/${date}.json`).then((day) => {
        const base = serviceDayStart(date);
        for (const [id, ri, vi, sign, stops, times, signs] of day.trips) {
          const trip = { id, ri, vi, sign, signs, stops, times: times.map((t) => base + t) };
          trips.push(trip);
          if (!byId.has(id)) byId.set(id, []);
          byId.get(id).push(trip);
          stops.forEach((s, pos) => {
            if (s < 0) return;
            if (!byStop.has(s)) byStop.set(s, []);
            byStop.get(s).push({ trip, pos });
          });
        }
      }).catch((err) => {
        days.delete(date);
        throw err;
      }));
    }
    return days.get(date);
  }

  // Trafikdagarna som kan ha turer mellan from och to (gårdagens turer går efter midnatt).
  async function ensure(from, to) {
    const dates = new Set();
    for (let t = from - 86400; t <= to + 3600; t += 6 * 3600) dates.add(isoDate(t));
    dates.add(isoDate(to));
    const results = await Promise.allSettled([...dates].map(loadDay));
    // Någon dag med turer måste finnas; saknas fler blir det bara färre turer.
    if (results.every((r) => r.status === "rejected") || !trips.length) throw new Error("Tidtabellen saknas");
  }

  async function refreshUpdates() {
    if (now() - updatesAt < UPDATES_SECONDS) return;
    updatesRun ??= getJSON(`${apiBase}/updates`)
      .then((res) => { updates = res.data || {}; })
      .catch(() => { updates = {}; })
      .finally(() => { updatesAt = now(); updatesRun = null; });
    await updatesRun;
  }

  // Samma trip_id finns varje dag; realtiden gäller turen som går närmast nu.
  function current(id) {
    const list = byId.get(id);
    if (!list) return null;
    const t = now();
    const gap = (trip) => Math.max(0, trip.times[0] - t, t - trip.times[trip.times.length - 1]);
    return list.reduce((best, trip) => (gap(trip) < gap(best) ? trip : best));
  }

  // { delay, skipped, realtime } för turen vid hållplats nummer pos (stop_sequence pos + 1).
  function rt(trip, pos) {
    const u = updates[trip.id];
    if (!u || current(trip.id) !== trip) return { delay: 0, skipped: false, realtime: false, cancelled: false };
    let delay = null, skipped = false;
    for (const [seq, d, skip] of u.s) {
      if (seq > pos + 1) break;
      if (skip) { if (seq === pos + 1) skipped = true; continue; }
      delay = d;
    }
    // Hållplatser före första uppgiften är redan passerade: ta första förseningen.
    if (delay == null) delay = u.s.find((x) => !x[2])?.[1] ?? 0;
    return { delay, skipped, realtime: true, cancelled: !!u.x };
  }

  const expected = (trip, pos) => trip.times[pos] + rt(trip, pos).delay;
  const signAt = (trip, pos) => {
    let sign = trip.sign;
    for (const [from, text] of trip.signs || []) if (from <= pos) sign = text;
    return sign;
  };
  const stopInfo = (s) => ({ id: net.stops[s][0], name: net.stops[s][1], lat: net.stops[s][2], lon: net.stops[s][3] });
  const lineOf = (trip) => net.routes[trip.ri].name;

  async function departures(stopIdxs) {
    const t = now();
    await Promise.all([ensure(t, t + 86400), refreshUpdates()]);
    const out = [];
    for (const s of stopIdxs) {
      for (const { trip, pos } of byStop.get(s) || []) {
        if (pos === trip.stops.length - 1) continue; // turen slutar här
        const scheduled = trip.times[pos];
        if (scheduled < t - 3 * 3600 || scheduled > t + 86400) continue;
        const r = rt(trip, pos);
        const exp = scheduled + r.delay;
        if (exp < t - 60) continue;
        out.push({ tripId: trip.id, routeId: net.routes[trip.ri].id, line: lineOf(trip), destination: signAt(trip, pos), scheduled, expected: exp, realtime: r.realtime, cancelled: r.cancelled, skipped: r.skipped });
      }
    }
    out.sort((a, b) => a.expected - b.expected);
    return { departures: out };
  }

  async function getVehicles() {
    const t = now();
    const [res] = await Promise.all([getJSON(`${apiBase}/vehicles`), ensure(t, t)]);
    vehicles.clear();
    const list = [];
    for (const v of res.data || []) {
      const trip = v.trip && current(v.trip);
      if (!trip) continue; // ingen tur, eller en tur utanför Övik
      const out = { id: v.id, tripId: trip.id, line: lineOf(trip), destination: trip.sign, lat: v.lat, lon: v.lon, bearing: v.bearing, timestamp: v.ts || res.time };
      vehicles.set(v.id, { v: out, trip });
      list.push(out);
    }
    return { vehicles: list };
  }

  async function journey(vehicleId) {
    const entry = vehicles.get(vehicleId);
    if (!entry) throw new Error("Okänd buss");
    await refreshUpdates();
    const { v, trip } = entry;
    const t = now();
    const stops = [];
    trip.stops.forEach((s, pos) => {
      if (s < 0) return;
      const r = rt(trip, pos);
      stops.push({ ...stopInfo(s), pos, scheduled: trip.times[pos], expected: trip.times[pos] + r.delay, realtime: r.realtime, skipped: r.skipped });
    });
    // Bussen är vid den hållplats den ligger närmast bland dem den borde vara nära i tid.
    const near = stops.filter((s) => Math.abs(s.expected - t) < 1200);
    const d2 = (s) => (s.lon - v.lon) ** 2 * 0.2 + (s.lat - v.lat) ** 2;
    const at = near.length ? near.reduce((a, b) => (d2(b) < d2(a) ? b : a)) : null;
    for (const s of stops) s.passed = at ? s.pos < at.pos || (s.pos === at.pos && s.expected < t) : s.expected < t - 30;
    const path = net.routes[trip.ri].variants[trip.vi]?.path || [];
    return { journey: { tripId: trip.id, line: lineOf(trip), cancelled: !!updates[trip.id]?.x, stops, shape: path.map(([lon, lat]) => [lat, lon]) } };
  }

  // Reseförslag direkt eller med ett byte inom samma hållplats, inom ett fönster från at.
  async function plan(fromGi, toGi, at) {
    const start = at ? Date.parse(at) / 1000 : now();
    const end = start + PLAN_WINDOW;
    await Promise.all([ensure(start, end + MAX_WAIT + 4 * 3600), refreshUpdates()]);
    const dest = new Set(groups[toGi].stops);
    const leg = (trip, i, j) => ({ tripId: trip.id, line: lineOf(trip), destination: signAt(trip, i),
      from: { ...stopInfo(trip.stops[i]), time: expected(trip, i) }, to: { ...stopInfo(trip.stops[j]), time: expected(trip, j) } });
    const firstDest = (trip, from) => {
      for (let j = from + 1; j < trip.stops.length; j++) if (dest.has(trip.stops[j])) return j;
      return -1;
    };
    const plans = [];
    for (const s of groups[fromGi].stops) {
      for (const { trip, pos: i } of byStop.get(s) || []) {
        const dep = expected(trip, i);
        if (dep < start || dep > end || rt(trip, i).cancelled) continue;
        let best = null;
        const j = firstDest(trip, i);
        if (j >= 0) best = { departure: dep, arrival: expected(trip, j), legs: [leg(trip, i, j)] };
        // Byte: kliv av vid en senare hållplats och ta en annan tur därifrån.
        const stopAt = j >= 0 ? j : trip.stops.length;
        for (let k = i + 1; k < stopAt; k++) {
          const sk = trip.stops[k];
          if (sk < 0 || stopGroup[sk] === fromGi) continue;
          const arrK = expected(trip, k);
          if (best && arrK >= best.arrival) break;
          for (const s2 of groups[stopGroup[sk]].stops) {
            for (const { trip: b, pos: m } of byStop.get(s2) || []) {
              if (b === trip || (b.ri === trip.ri && b.vi === trip.vi)) continue;
              const depB = expected(b, m);
              if (depB < arrK + MIN_TRANSFER || depB > arrK + MAX_WAIT) continue;
              const n = firstDest(b, m);
              if (n < 0) continue;
              const arr = expected(b, n);
              if (!best || arr < best.arrival) best = { departure: dep, arrival: arr, legs: [leg(trip, i, k), leg(b, m, n)] };
            }
          }
        }
        if (best) plans.push(best);
      }
    }
    return { plans, nextSearch: new Date(end * 1000).toISOString() };
  }

  async function alerts() {
    const res = await getJSON(`${apiBase}/alerts`);
    return {
      alerts: (res.data || []).map((a) => ({
        id: a.id,
        title: a.header,
        description: a.text,
        routeIds: a.routes,
        stopIds: (a.stops || []).map((id) => (net.quays?.[id] != null ? net.stops[net.quays[id]][0] : id)),
      })),
    };
  }

  const t = now();
  return { ready: ensure(t, t), departures, vehicles: getVehicles, journey, plan, alerts };
}

async function defaultGetJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
