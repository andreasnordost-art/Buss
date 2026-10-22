// Realtidsproxy för Busskollen Övik (Cloudflare Worker).
//
// Hämtar Din Turs GTFS-RT-flöden från Trafiklab, avkodar dem till liten JSON
// och cachar svaret så att API-nyckeln inte syns i webbläsaren och kvoten räcker.
// Sidan räknar själv fram avgångar, turer och reseförslag ur tidtabellen plus dessa.
//
//   GET /vehicles  bussar inom kommunen
//   GET /updates   förseningar per tur
//   GET /alerts    trafikstörningar
//
//   GET /api/...   reserv: vidarebefordras till Busskollens API (originalsidan), som
//                  saknar CORS. Används bara om Trafiklab-datan inte går att få.
//
// Trafiklabs Bronze-nivå tillåter 30 000 anrop per månad för alla flöden tillsammans,
// så cachetiderna (TTL_* i wrangler.toml) är långa. Med Silver kan de sänkas till 10–15 s.

const BBOX = [17.9, 63.08, 19.5, 63.78]; // samma som MUNICIPALITY_BBOX i config.mjs

// Busskollens API: tillåtna adresser och cachetid i sekunder.
const UPSTREAM = {
  stops: 3600,
  vehicles: 10,
  departures: 20,
  journey: 10,
  plan: 60,
  alerts: 120,
  "network-geometry": 3600,
};

const FEEDS = {
  vehicles: { file: "VehiclePositions.pb", ttl: 60, transform: vehicles },
  updates: { file: "TripUpdates.pb", ttl: 90, transform: updates },
  alerts: { file: "ServiceAlerts.pb", ttl: 600, transform: alerts },
};
// Svarar Trafiklab med fel (t.ex. slut på kvoten) frågar vi inte igen på så här länge.
const ERROR_TTL = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const api = url.pathname.match(/^\/api\/([a-z-]+)\/?$/);
    if (api) return upstream(api[1], url, env, ctx, cors);
    const name = url.pathname.replace(/^\/+|\/+$/g, "");
    const feed = FEEDS[name];
    if (!feed) return json({ error: "Okänd adress" }, 404, cors);
    if (!env.TRAFIKLAB_RT_KEY) return json({ error: "TRAFIKLAB_RT_KEY saknas" }, 503, cors);

    const ttl = Number(env[`TTL_${name.toUpperCase()}`]) || feed.ttl;
    const cacheKey = new Request(`https://cache.local/${feed.file}`);
    const cache = globalThis.caches?.default;
    let res = await cache?.match(cacheKey);
    if (!res) {
      const feedRes = await fetch(
        `https://opendata.samtrafiken.se/gtfs-rt/${env.OPERATOR || "dintur"}/${feed.file}?key=${env.TRAFIKLAB_RT_KEY}`,
        { headers: { "Accept-Encoding": "gzip" } },
      );
      if (feedRes.ok) {
        const msg = decodeFeed(new Uint8Array(await feedRes.arrayBuffer()));
        const body = JSON.stringify({ time: msg.time, data: feed.transform(msg.entities) });
        res = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } });
      } else {
        res = json({ error: `Trafiklab svarade ${feedRes.status}` }, 502, { "Cache-Control": `public, max-age=${ERROR_TTL}` });
      }
      if (cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

async function upstream(name, url, env, ctx, cors) {
  const ttl = UPSTREAM[name];
  if (ttl == null) return json({ error: "Okänd adress" }, 404, cors);
  const target = `${env.ORIGINAL_API || "https://ovik-live.andreasnordost.chatgpt.site"}/api/${name}${url.search}`;
  const cacheKey = new Request(target);
  const cache = globalThis.caches?.default;
  let res = await cache?.match(cacheKey);
  if (!res) {
    const up = await fetch(target, { headers: { Accept: "application/json" } });
    res = new Response(up.body, { status: up.status, headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${up.ok ? ttl : 5}` } });
    if (up.ok && cache) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin" };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// --- Omvandling till det sidan behöver --------------------------------------

function vehicles(entities) {
  const out = [];
  for (const e of entities) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const { latitude: lat, longitude: lon } = v.position;
    if (lon < BBOX[0] || lon > BBOX[2] || lat < BBOX[1] || lat > BBOX[3]) continue;
    out.push({
      id: v.vehicle?.id || e.id,
      trip: v.trip?.tripId || null,
      route: v.trip?.routeId || null,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      bearing: v.position.bearing ?? null,
      speed: v.position.speed ?? null,
      ts: v.timestamp || null,
    });
  }
  return out;
}

function updates(entities) {
  // { tripId: { s: [[stop_sequence, försening i sekunder, 1 om hållplatsen hoppas över]], x: 1 om inställd } }
  // Förseningen gäller från sin hållplats och framåt tills nästa rad, så rader med
  // samma försening som föregående tas bort.
  const out = {};
  for (const e of entities) {
    const u = e.tripUpdate;
    if (!u?.trip?.tripId) continue;
    const entry = { s: [] };
    if (u.trip.scheduleRelationship === 3) entry.x = 1;
    let last = u.delay ?? null;
    if (last != null) entry.s.push([0, last]);
    for (const st of u.stopTimeUpdates.slice().sort((a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0))) {
      if (st.stopSequence == null) continue;
      const delay = st.departure?.delay ?? st.arrival?.delay ?? last;
      if (st.scheduleRelationship === 1) entry.s.push([st.stopSequence, delay, 1]);
      else if (delay != null && delay !== last) entry.s.push([st.stopSequence, delay]);
      last = delay;
    }
    out[u.trip.tripId] = entry;
  }
  return out;
}

function alerts(entities) {
  const now = Date.now() / 1000;
  const out = [];
  for (const e of entities) {
    const a = e.alert;
    if (!a) continue;
    const active = !a.periods.length || a.periods.some((p) => (!p.start || p.start <= now) && (!p.end || p.end >= now));
    if (!active) continue;
    out.push({
      id: e.id,
      header: pickText(a.header),
      text: pickText(a.description),
      routes: [...new Set(a.entities.map((x) => x.routeId).filter(Boolean))],
      stops: [...new Set(a.entities.map((x) => x.stopId).filter(Boolean))],
    });
  }
  return out;
}

function pickText(translations) {
  return (translations.find((t) => !t.language || t.language.startsWith("sv")) || translations[0])?.text || "";
}

// --- Minimal protobuf-avkodare för GTFS-RT ----------------------------------
// Läser bara de fält som används ovan. Fältnummer enligt gtfs-realtime.proto.

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  varint() {
    let result = 0, mul = 1, b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  }
  int32() {
    // Negativa int32 kodas som 10-byte varint; de låga 32 bitarna räcker.
    let result = 0, shift = 0, b;
    do {
      b = this.buf[this.pos++];
      if (shift < 32) result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return result | 0;
  }
  float() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }
  string() {
    const [s, e] = this.bytes();
    return new TextDecoder().decode(this.buf.subarray(s, e));
  }
  sub() {
    const [s, e] = this.bytes();
    return new Reader(this.buf, s, e);
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Okänd wire type ${wire}`);
  }
  // Anropar fn(fält, wire) för varje fält; fn returnerar false om fältet ska hoppas över.
  each(fn) {
    while (this.pos < this.end) {
      const tag = this.varint();
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (fn(field, wire) === false) this.skip(wire);
    }
  }
}

export function decodeFeed(buf) {
  return read(new Reader(buf), {
    1: (o, r) => (o.time = read(r.sub(), { 3: (h, r) => (h.time = r.varint()) }, {}).time ?? null),
    2: (o, r) => o.entities.push(entity(r.sub())),
  }, { time: null, entities: [] });
}

// Hjälpare så att varje meddelande kan läsas med en egen Reader.
function read(r, handlers, init) {
  const obj = init;
  r.each((f) => {
    const h = handlers[f];
    if (!h) return false;
    h(obj, r);
  });
  return obj;
}

function entity(r) {
  return read(r, {
    1: (o, r) => (o.id = r.string()),
    3: (o, r) => (o.tripUpdate = tripUpdate(r.sub())),
    4: (o, r) => (o.vehicle = vehicle(r.sub())),
    5: (o, r) => (o.alert = alert(r.sub())),
  }, {});
}

function tripDescriptor(r) {
  return read(r, {
    1: (o, r) => (o.tripId = r.string()),
    5: (o, r) => (o.routeId = r.string()),
    6: (o, r) => (o.directionId = r.varint()),
    4: (o, r) => (o.scheduleRelationship = r.varint()),
  }, {});
}

function vehicle(r) {
  return read(r, {
    1: (o, r) => (o.trip = tripDescriptor(r.sub())),
    2: (o, r) => (o.position = read(r.sub(), {
      1: (p, r) => (p.latitude = r.float()),
      2: (p, r) => (p.longitude = r.float()),
      3: (p, r) => (p.bearing = r.float()),
      5: (p, r) => (p.speed = r.float()),
    }, {})),
    5: (o, r) => (o.timestamp = r.varint()),
    8: (o, r) => (o.vehicle = read(r.sub(), { 1: (v, r) => (v.id = r.string()), 2: (v, r) => (v.label = r.string()) }, {})),
  }, {});
}

function stopTimeEvent(r) {
  return read(r, { 1: (o, r) => (o.delay = r.int32()), 2: (o, r) => (o.time = r.varint()) }, {});
}

function tripUpdate(r) {
  return read(r, {
    1: (o, r) => (o.trip = tripDescriptor(r.sub())),
    2: (o, r) => o.stopTimeUpdates.push(read(r.sub(), {
      1: (s, r) => (s.stopSequence = r.varint()),
      2: (s, r) => (s.arrival = stopTimeEvent(r.sub())),
      3: (s, r) => (s.departure = stopTimeEvent(r.sub())),
      4: (s, r) => (s.stopId = r.string()),
      5: (s, r) => (s.scheduleRelationship = r.varint()),
    }, {})),
    4: (o, r) => (o.timestamp = r.varint()),
    5: (o, r) => (o.delay = r.int32()),
  }, { stopTimeUpdates: [] });
}

function translated(r) {
  const list = [];
  r.each((f) => {
    if (f !== 1) return false;
    list.push(read(r.sub(), { 1: (t, r) => (t.text = r.string()), 2: (t, r) => (t.language = r.string()) }, {}));
  });
  return list;
}

function alert(r) {
  return read(r, {
    1: (o, r) => o.periods.push(read(r.sub(), { 1: (p, r) => (p.start = r.varint()), 2: (p, r) => (p.end = r.varint()) }, {})),
    5: (o, r) => o.entities.push(read(r.sub(), { 2: (e, r) => (e.routeId = r.string()), 5: (e, r) => (e.stopId = r.string()) }, {})),
    10: (o, r) => (o.header = translated(r.sub())),
    11: (o, r) => (o.description = translated(r.sub())),
  }, { periods: [], entities: [], header: [], description: [] });
}
