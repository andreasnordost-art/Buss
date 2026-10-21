# Busskollen Övik

Bussarna i Örnsköldsvik live på kartan, med avgångar, reseförslag och trafikstörningar.
Data från Din Tur via [Trafiklab GTFS Regional](https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/) (CC0).

## Så hänger det ihop

```
Trafiklab GTFS (zip) --varje natt--> GitHub Action --> public/data/*.json --> GitHub Pages (sidan)
Trafiklab GTFS-RT ------var 15 s---> Cloudflare Worker (döljer nyckeln, cachar) --> sidan
```

- `scripts/build-data.mjs` läser GTFS-filen och sparar bara det sidan behöver: hållplatser,
  linjer och dagens turer. Linjerna ritas från GTFS-filens egna vägformer (`shapes.txt`),
  sorterade på punktnummer och förenklade till ett par meters noggrannhet. Varje linje
  visar en huvudform per riktning, den som flest turer kör. Turer som går en annan väg
  visas streckade när man väljer linjen.
- `worker/` hämtar fordonspositioner, förseningar och störningar och gör om dem till liten JSON.
- `public/` är själva sidan: MapLibre-karta med OpenFreeMap, utan byggsteg.
- `config.mjs` styr vilket område som räknas som kommunen och centralorten (Tätort/Landsbygd).

## Komma igång

1. **Trafiklab.** Skapa ett projekt på [trafiklab.se](https://www.trafiklab.se/) och lägg till
   *GTFS Regional Static* och *GTFS Regional Realtime*. Du får en nyckel för varje.
2. **GitHub-hemligheter** (Settings → Secrets and variables → Actions):
   - `TRAFIKLAB_STATIC_KEY`: nyckeln för Static
   - `TRAFIKLAB_RT_KEY`: nyckeln för Realtime
   - `CLOUDFLARE_API_TOKEN` och `CLOUDFLARE_ACCOUNT_ID`: från ett gratis Cloudflare-konto
     (token med mallen *Edit Cloudflare Workers*)
3. **GitHub Pages.** Settings → Pages → Source: *GitHub Actions*.
4. **Publicera proxyn.** Kör *Realtidsproxy* under Actions. Adressen blir
   `https://buss-rt.<ditt-konto>.workers.dev`.
5. **Koppla ihop.** Lägg adressen som variabel `RT_API_URL` (fliken Variables) och kör *Data och sida*.

Sidan hamnar på `https://andreasnordost-art.github.io/buss/`.

## Utveckla lokalt

```sh
npm install
npm test                                   # bygger testdata och testar proxyn
node scripts/build-data.mjs --dir test/fixture  # påhittad data i public/data
npx serve public                           # öppna sidan
```

Med riktig data: `TRAFIKLAB_STATIC_KEY=... npm run build`.

## Kvoter

Trafiklab begränsar antalet anrop per nyckel. Proxyn cachar svaren (`TTL_*` i
`worker/wrangler.toml`) så att alla besökare delar samma anrop, och databygget laddar ner
GTFS-filen högst en gång per dag. Kontrollera kvoten för din nyckelnivå och höj cachetiden
om den inte räcker.
