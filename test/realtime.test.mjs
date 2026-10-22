// Kontrollerar protobuf-avkodaren i workern mot protobufjs med en egen testfil.
import assert from "node:assert/strict";
import protobuf from "protobufjs";
import { decodeFeed } from "../worker/src/index.js";

const root = protobuf.parse(`
syntax = "proto2";
message FeedMessage { required FeedHeader header = 1; repeated FeedEntity entity = 2; }
message FeedHeader { required string gtfs_realtime_version = 1; optional uint64 timestamp = 3; }
message FeedEntity { required string id = 1; optional TripUpdate trip_update = 3; optional VehiclePosition vehicle = 4; optional Alert alert = 5; }
message TripDescriptor { optional string trip_id = 1; optional string route_id = 5; optional uint32 direction_id = 6; optional int32 schedule_relationship = 4; }
message VehicleDescriptor { optional string id = 1; optional string label = 2; }
message Position { required float latitude = 1; required float longitude = 2; optional float bearing = 3; optional float speed = 5; }
message VehiclePosition { optional TripDescriptor trip = 1; optional Position position = 2; optional uint64 timestamp = 5; optional VehicleDescriptor vehicle = 8; }
message StopTimeEvent { optional int32 delay = 1; optional int64 time = 2; }
message StopTimeUpdate { optional uint32 stop_sequence = 1; optional StopTimeEvent arrival = 2; optional StopTimeEvent departure = 3; optional string stop_id = 4; optional int32 schedule_relationship = 5; }
message TripUpdate { required TripDescriptor trip = 1; repeated StopTimeUpdate stop_time_update = 2; optional uint64 timestamp = 4; optional int32 delay = 5; }
message TimeRange { optional uint64 start = 1; optional uint64 end = 2; }
message EntitySelector { optional string route_id = 2; optional string stop_id = 5; }
message Translation { required string text = 1; optional string language = 2; }
message TranslatedString { repeated Translation translation = 1; }
message Alert { repeated TimeRange active_period = 1; repeated EntitySelector informed_entity = 5; optional TranslatedString header_text = 10; optional TranslatedString description_text = 11; }
`).root;
const Feed = root.lookupType("FeedMessage");
const buf = Feed.encode(Feed.fromObject({
  header: { gtfsRealtimeVersion: "2.0", timestamp: 1761068400 },
  entity: [
    { id: "v1", vehicle: { trip: { tripId: "T1", routeId: "R1" }, position: { latitude: 63.29, longitude: 18.72, bearing: 90 }, timestamp: 1761068390, vehicle: { id: "bus-7" } } },
    { id: "u1", tripUpdate: { trip: { tripId: "T1" }, stopTimeUpdate: [
      { stopSequence: 2, stopId: "B", departure: { delay: -45 } },
      { stopSequence: 3, stopId: "C", arrival: { delay: 120 } },
    ] } },
    { id: "a1", alert: { informedEntity: [{ routeId: "R1" }], headerText: { translation: [{ text: "Hello", language: "en" }, { text: "Omledning", language: "sv" }] } } },
  ],
})).finish();

const msg = decodeFeed(buf);
assert.equal(msg.time, 1761068400);
assert.equal(msg.entities.length, 3);
const v = msg.entities[0].vehicle;
assert.equal(v.trip.tripId, "T1");
assert.equal(v.vehicle.id, "bus-7");
assert.ok(Math.abs(v.position.latitude - 63.29) < 1e-4);
const u = msg.entities[1].tripUpdate;
assert.equal(u.stopTimeUpdates[0].departure.delay, -45);
assert.equal(u.stopTimeUpdates[1].arrival.delay, 120);
assert.equal(msg.entities[2].alert.header[1].text, "Omledning");
console.log("decode ok");

// Hela workern med påhittad Trafiklab och cache.
import worker from "../worker/src/index.js";
const store = new Map();
globalThis.caches = { default: { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => store.set(r.url, res) } };
let calls = 0;
globalThis.fetch = async (url) => { calls++; assert.match(String(url), /VehiclePositions\.pb\?key=K$/); return new Response(buf); };
const env = { TRAFIKLAB_RT_KEY: "K", ALLOWED_ORIGINS: "https://example.github.io" };
const ctx = { waitUntil: (p) => p };
const req = () => new Request("https://w.dev/vehicles", { headers: { Origin: "https://example.github.io" } });
let res = await worker.fetch(req(), env, ctx);
const body = await res.json();
assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://example.github.io");
assert.deepEqual(body.data[0], { id: "bus-7", trip: "T1", route: "R1", lat: 63.29, lon: 18.72, bearing: 90, speed: null, ts: 1761068390 });
await new Promise((r) => setTimeout(r, 10));
await worker.fetch(req(), env, ctx);
assert.equal(calls, 1, "andra anropet ska komma från cachen");
console.log("worker ok");

// /api/* skickas vidare till Busskollens API med CORS och cache; okända adresser nekas.
calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  assert.equal(String(url), "https://busskollen.test/api/departures?stopId=S1");
  return new Response(JSON.stringify({ departures: [{ line: "401" }] }), { headers: { "Content-Type": "application/json" } });
};
const apiEnv = { ...env, ORIGINAL_API: "https://busskollen.test" };
const apiReq = (path) => new Request(`https://w.dev${path}`, { headers: { Origin: "https://example.github.io" } });
res = await worker.fetch(apiReq("/api/departures?stopId=S1"), apiEnv, ctx);
assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://example.github.io");
assert.equal((await res.json()).departures[0].line, "401");
await new Promise((r) => setTimeout(r, 10));
await worker.fetch(apiReq("/api/departures?stopId=S1"), apiEnv, ctx);
assert.equal(calls, 1, "avgångarna ska komma från cachen andra gången");
res = await worker.fetch(apiReq("/api/admin/import"), apiEnv, ctx);
assert.equal(res.status, 404, "bara kända adresser vidarebefordras");
assert.equal(calls, 1);
console.log("proxy ok");

// Förseningar per tur som [stop_sequence, försening], och felsvar från Trafiklab
// cachas så att en slut kvot inte ger ett nytt anrop för varje besökare.
calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  return String(url).includes("TripUpdates") ? new Response(buf) : new Response("Too many requests", { status: 429 });
};
res = await worker.fetch(apiReq("/updates"), env, ctx);
assert.deepEqual((await res.json()).data, { T1: { s: [[2, -45], [3, 120]] } });
res = await worker.fetch(apiReq("/alerts"), env, ctx);
assert.equal(res.status, 502);
await new Promise((r) => setTimeout(r, 10));
res = await worker.fetch(apiReq("/alerts"), env, ctx);
assert.equal(res.status, 502);
assert.equal(calls, 2, "felet ska komma från cachen andra gången");
res = await worker.fetch(apiReq("/updates"), { ...env, TRAFIKLAB_RT_KEY: "" }, ctx);
assert.equal(res.status, 503, "utan nyckel svarar proxyn direkt, så att sidan tar reserven");
console.log("updates ok");
