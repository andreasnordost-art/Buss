# Busskollen Övik

<p align="center">
  <a href="https://andreasnordost-art.github.io/Buss/">
    <img src="https://img.shields.io/badge/%F0%9F%9A%8C%20%C3%96ppna%20Busskollen-andreasnordost--art.github.io%2FBuss-2e7d32?style=for-the-badge" alt="Öppna Busskollen">
  </a>
</p>

<p align="center"><b>👉 <a href="https://andreasnordost-art.github.io/Buss/">Starta sidan här: andreasnordost-art.github.io/Buss</a></b></p>

Bussarna i Örnsköldsvik live på kartan, med avgångar, reseförslag och trafikstörningar.
Data från Din Tur via [Trafiklab](https://www.trafiklab.se/) (CC0).

## Så hänger det ihop

```
Trafiklab GTFS Regional Static --varje natt--> GitHub Action --> public/data/ --> GitHub Pages (sidan)
Trafiklab GTFS Regional Realtime <-- Cloudflare Worker (nyckel, cache, CORS) <-- sidan (bussar, förseningar, störningar)
```

- `scripts/build-data.mjs` läser Din Turs GTFS-fil och skriver
  - `public/data/network.json`: hållplatser och linjeformer längs vägarna (shapes.txt).
    Varje linje får en huvudform per riktning (flest turer gånger antal hållplatser);
    övriga varianter visas streckade som avvikande körvägar. Regionlinjer kortas vid kommungränsen.
  - `public/data/days/ÅÅÅÅ-MM-DD.json`: alla turer den dagen med hållplatser och tider.
- `public/live.js` räknar fram avgångar, bussens tur och reseförslag (direkt eller ett byte)
  ur dagfilerna, och lägger på förseningarna från realtidsproxyn.
- `worker/` hämtar Trafiklabs GTFS-RT (`/vehicles`, `/updates`, `/alerts`), avkodar till liten
  JSON och cachar svaret så att nyckeln inte syns i webbläsaren och kvoten räcker.
- **Reserv.** Går tidtabellen eller realtiden inte att få från Trafiklab använder sidan
  Busskollens API (originalsidan) via proxyns `/api/*`, och bygget `scripts/import-original.mjs`.
  Försvinner originalsidan fortsätter allt fungera på Trafiklab-datan.
- `public/` är själva sidan: MapLibre-karta med OpenFreeMap (Ljus, Detaljerad, Mörk), utan byggsteg.
  `public/schematic.js` ritar linjenätskartan i tunnelbanestil automatiskt ur samma data.

## Komma igång

1. **Trafiklab.** Skapa ett projekt på [trafiklab.se](https://www.trafiklab.se/) med nycklar för
   *GTFS Regional Static data* och *GTFS Regional Realtime*. Lägg in dem som
   `TRAFIKLAB_STATIC_KEY` och `TRAFIKLAB_RT_KEY` under Settings → Secrets and variables → Actions.
2. **Cloudflare.** Skapa ett gratis konto och en API-token med mallen *Edit Cloudflare Workers*.
   Lägg in `CLOUDFLARE_API_TOKEN` och `CLOUDFLARE_ACCOUNT_ID` på samma ställe.
3. **Publicera proxyn.** Kör *Realtidsproxy* under Actions. Den lägger också in
   `TRAFIKLAB_RT_KEY` i workern. Adressen blir `https://buss-rt.<ditt-konto>.workers.dev`.
4. **GitHub Pages.** Settings → Pages → Source: *GitHub Actions*.
5. **Koppla ihop.** Lägg proxyns adress som variabel `RT_API_URL` (fliken Variables) och kör
   *Data och sida*.

Sidan hamnar på `https://andreasnordost-art.github.io/Buss/`.

## Trafiklabs kvoter

- **Tidtabellen** (Static, Bronze: ett femtiotal hämtningar i månaden) hämtas högst en gång per dygn.
  Filen sparas i Actions-cachen, så fler körningar samma dag kostar inget. Misslyckas en
  hämtning byggs sidan från den senast hämtade filen.
- **Realtiden** (Realtime, Bronze: 30 000 anrop i månaden för alla flöden tillsammans) cachas
  i proxyn: bussar 60 s, förseningar 90 s, störningar 10 min (`TTL_*` i `worker/wrangler.toml`).
  Proxyn frågar bara Trafiklab när någon har sidan öppen. Svarar Trafiklab med fel, till
  exempel när kvoten är slut, väntar proxyn 5 minuter innan den försöker igen.
  Med Silver-nivå (ansök under *Upgrade quota* på Trafiklab) kan tiderna sänkas till 15 och 30 s.

## Utveckla lokalt

```sh
npm install
npm test                                        # databygget, avgångar/reseförslag, linjenätskartan och proxyn
TRAFIKLAB_STATIC_KEY=... npm run build          # hämtar tidtabellen till public/data
TRAFIKLAB_RT_KEY=... npm run dev                # http://localhost:8080 med realtidsproxyn lokalt
```
