// Gemensamma inställningar för databygget och realtidsproxyn.

// Din Tur i Trafiklabs GTFS Regional.
export const OPERATOR = "dintur";

// Örnsköldsviks kommun, ungefärlig ruta [väst, syd, öst, norr]. Södra kanten går
// norr om Docksta så att Kramforslinjer som 221 inte räknas in.
export const MUNICIPALITY_BBOX = [17.9, 63.08, 19.5, 63.78];

// Centralorten. En linje vars hållplatser alla ligger här räknas som Tätort.
export const TOWN_BBOX = [18.57, 63.235, 18.85, 63.36];

// Antal hållplatser i kommunen som en tur måste ha för att tas med. Regionlinjer
// (40, 50) kommer med men ritas bara inom kommunen.
export const MIN_STOPS_IN_MUNICIPALITY = 2;

// Tvinga en linje till Tätort eller Landsbygd om geografin gissar fel,
// t.ex. { "12": "landsbygd" }. Nyckeln är linjenumret som resenärer ser.
export const KIND_OVERRIDES = {};

// Toleransen när linjeformer förenklas, i meter. Högre = färre punkter.
export const SIMPLIFY_METERS = 4;

// Vägnavigering (OSRM) för raka etapper i Din Turs former som ingen annan tur
// kör längs vägen. Några få frågor per bygge; tom sträng stänger av.
export const ROAD_ROUTER = "https://router.project-osrm.org";

// Hur många dagar framåt tidtabellen byggs.
export const DAYS_AHEAD = 8;

export const TIMEZONE = "Europe/Stockholm";

// Turer per dag som krävs för att en linje ska ritas som stomlinje (bara Tätort)
// respektive vanlig linje. Linjer med färre turer räknas som övriga turer.
export const TIER_TRIPS = { stom: 20, linje: 10 };

// Busskollens API (originalsidan). Reserv om Trafiklab-datan inte går att få:
// bygget använder det utan GTFS-fil och sidan via proxyns /api/*.
export const ORIGINAL_API = "https://ovik-live.andreasnordost.chatgpt.site";
