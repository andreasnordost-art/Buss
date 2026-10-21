// Gemensamma inställningar för databygget och realtidsproxyn.

// Din Tur i Trafiklabs GTFS Regional.
export const OPERATOR = "dintur";

// Örnsköldsviks kommun, ungefärlig ruta [väst, syd, öst, norr].
export const MUNICIPALITY_BBOX = [17.9, 62.95, 19.5, 63.78];

// Centralorten. En linje vars hållplatser alla ligger här räknas som Tätort.
export const TOWN_BBOX = [18.6, 63.24, 18.82, 63.34];

// Andel av en turs hållplatser som måste ligga i kommunen för att turen ska tas med.
export const MIN_SHARE_IN_MUNICIPALITY = 0.5;

// Tvinga en linje till Tätort eller Landsbygd om geografin gissar fel,
// t.ex. { "12": "landsbygd" }. Nyckeln är linjenumret som resenärer ser.
export const KIND_OVERRIDES = {};

// Toleransen när linjeformer förenklas, i meter. Högre = färre punkter.
export const SIMPLIFY_METERS = 4;

// Hur många dagar framåt tidtabellen byggs.
export const DAYS_AHEAD = 8;

export const TIMEZONE = "Europe/Stockholm";
