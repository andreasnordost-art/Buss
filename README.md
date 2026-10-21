# Busskollen Övik

Bussarna i Örnsköldsvik live på kartan, med avgångar, reseförslag och trafikstörningar.
Data från Din Tur via [Trafiklab](https://www.trafiklab.se/) (CC0), hämtad genom Busskollens API.

## Så hänger det ihop

```
Busskollens API --varje natt--> GitHub Action --> public/data/network.json --> GitHub Pages (sidan)
Busskollens API <---- /api/* ---- Cloudflare Worker (CORS och cache) <---- sidan (avgångar, bussar, resor)
```

- **Data.** Tills egna Trafiklab-nycklar finns hämtas allt från Busskollens API
  (originalsidan, `ORIGINAL_API` i `config.mjs`). Det har färsk Din Tur-data och
  körvägar som är matchade mot vägarna sträcka för sträcka.
- `scripts/import-original.mjs` sparar hållplatser och linjeformer i `public/data/network.json`.
  Varje linje får en huvudform per riktning (flest turer gånger antal hållplatser bland
  översiktsvarianterna); övriga varianter visas streckade som avvikande körvägar.
- `worker/` skickar `/api/stops|vehicles|departures|journey|plan|alerts` vidare till
  Busskollens API med CORS och kort cache, eftersom API:et inte går att läsa direkt från en
  annan webbplats. Den kan också läsa Trafiklabs GTFS-RT direkt (`/vehicles`, `/updates`,
  `/alerts`) om `TRAFIKLAB_RT_KEY` finns.
- `public/` är själva sidan: MapLibre-karta med OpenFreeMap (Ljus, Detaljerad, Mörk), utan byggsteg.
  Hållplatspanel med avgångar, busspanel med nästa hållplats och körd/återstående sträcka,
  trafikinfo, reseförslag, Min resa, sparade hållplatser och hållplatser nära mig.
  Sidan går att installera som app (manifest och service worker).
- `public/schematic.js` ritar linjenätskartan i tunnelbanestil automatiskt ur samma data.
- `scripts/build-data.mjs` bygger samma linjenät från en GTFS-fil. Det används inte av sidan
  just nu, men finns kvar för när egna Trafiklab-nycklar är på plats.

## Komma igång

1. **Cloudflare.** Skapa ett gratis konto och en API-token med mallen *Edit Cloudflare Workers*.
   Lägg in `CLOUDFLARE_API_TOKEN` och `CLOUDFLARE_ACCOUNT_ID` under
   Settings → Secrets and variables → Actions.
2. **Publicera proxyn.** Kör *Realtidsproxy* under Actions. Adressen blir
   `https://buss-rt.<ditt-konto>.workers.dev`.
3. **GitHub Pages.** Settings → Pages → Source: *GitHub Actions*.
4. **Koppla ihop.** Lägg proxyns adress som variabel `RT_API_URL` (fliken Variables) och kör
   *Data och sida*.

Sidan hamnar på `https://andreasnordost-art.github.io/buss/`.

## Utveckla lokalt

```sh
npm install
npm test                 # databyggen, linjenätskartan och proxyn
npm run build            # hämtar linjenätet till public/data
npm run dev              # http://localhost:8080, /api/* skickas vidare som i proxyn
```

## Cache

Proxyn cachar svaren från Busskollens API (bussar 10 s, avgångar 20 s, reseförslag 60 s,
störningar 2 min, hållplatser 1 h, se `UPSTREAM` i `worker/src/index.js`) så att alla
besökare delar samma anrop. Trafiklab-flödena cachas enligt `TTL_*` i `worker/wrangler.toml`.
