# Klänningslagret – installationsguide

En enkel lagerwebb för klänningar. Arbetare skannar QR-lappen på klänningen med mobilen och tar bort den från lagret. Admin ser statistik, lägger till klänningar och hanterar konton.

Varje **modell + färg + storlek** är en egen rad med en egen QR-kod. Exempel: "Maja midiklänning, Svart, M" och "Maja midiklänning, Svart, L" har olika QR-koder, så lagret vet exakt vilken storlek som tagits.

**Kostnad: 0 kr.** Allt körs på gratisnivåer:

| Del | Tjänst | Gratis ingår |
|---|---|---|
| Databas + inloggning + serverfunktion | [Supabase](https://supabase.com) Free | 500 MB databas, 50 000 användare, 500 000 funktionsanrop/mån |
| Hosting av sidan (med https) | [Cloudflare Pages](https://pages.cloudflare.com) | Obegränsad trafik |
| QR-skanning, QR-generering | Öppen källkod, ingår i projektet | – |

> ⚠️ Supabase gratisprojekt **pausas efter 7 dagar utan aktivitet**. Används appen varje vecka märks det inte. Om den pausas: logga in på supabase.com och klicka "Restore".

---

## Mappstruktur

```
lagerapp/
├── supabase/
│   ├── schema.sql                  ← databas + säkerhetsregler
│   └── functions/
│       ├── admin-users/            ← serverfunktion för att skapa/ta bort konton
│       └── shop-sync/              ← webbshop-koppling (AVSTÄNGD tills ni slår på den)
├── index.html, app.js, style.css   ← själva hemsidan (ligger i roten, visas av GitHub Pages)
├── config.js                       ← HÄR fyller du i dina nycklar
├── demo-mock.js                    ← demoläge, slås bara på om config.js inte är ifylld
├── _headers                        ← säkerhetsinställningar för hostingen (Cloudflare)
├── .nojekyll                       ← gör att GitHub Pages visar filerna som de är
└── vendor/                         ← bibliotek (Supabase, QR-läsare, QR-generator)
```

---

> **Uppdaterar du från en äldre version?** Kör hela `supabase/schema.sql` igen. Befintlig data ligger kvar.

## Steg 1 – Skapa Supabase-projekt (5 min)

1. Gå till **supabase.com** → skapa konto → **New project**.
2. Välj region **Europe (Stockholm eller Frankfurt)** och ett starkt databaslösenord (spara det).
3. När projektet är klart: **SQL Editor → New query**, klistra in hela `supabase/schema.sql` och klicka **Run**.

## Steg 2 – Viktiga säkerhetsinställningar i Supabase

1. **Authentication → Sign In / Providers → Email**: slå **AV** "Allow new users to sign up".
   *(Då kan ingen skapa konto själv – bara admin via appen.)*
2. Samma ställe: sätt **Minimum password length** till 10.
3. **Project Settings → API Keys**: kopiera **Publishable key** (`sb_publishable_...`; i äldre projekt heter den **anon public**). **Project URL** finns under knappen **Connect** högst upp.
   Klistra in dem i `config.js`.
   *Secret key (`sb_secret_...`) och service_role-nyckeln får ALDRIG läggas i config.js eller någon annanstans i projektet.*

## Steg 3 – Skapa första admin-kontot

1. **Authentication → Users → Add user → Create new user**. Fyll i din e-post och ett starkt lösenord, bocka i "Auto confirm".
2. **SQL Editor**, kör (byt e-post och namn):

```sql
insert into public.profiles (id, email, full_name, role)
select id, email, 'Ditt Namn', 'admin' from auth.users where email = 'din@epost.se';
```

## Steg 4 – Lägg upp serverfunktionen för konton

Enklast via webben (ingen installation):

1. **Edge Functions → Deploy a new function → Via Editor**.
2. Namn: `admin-users`. Klistra in innehållet i `supabase/functions/admin-users/index.ts`. Klicka **Deploy**.
3. **Edge Functions → Secrets → Add new secret**:
   `ALLOWED_ORIGIN` = adressen till din sajt, t.ex. `https://mittlager.pages.dev` (fyll i efter steg 5 om du inte vet den än).

*(Alternativ med terminal: `npx supabase functions deploy admin-users`)*

## Steg 5 – Publicera hemsidan på Cloudflare Pages

1. Skapa gratis konto på **dash.cloudflare.com**.
2. **Workers & Pages → Create → Pages → Upload assets**.
3. Döp projektet (t.ex. `mittlager`) och dra in **hemsidans filer från projektets rot** (index.html, app.js, style.css, config.js, demo-mock.js, _headers och mappen vendor/).
4. Klart! Sidan finns på `https://mittlager.pages.dev`.
5. Gå tillbaka till steg 4.3 och sätt `ALLOWED_ORIGIN` om du inte gjort det.

> Kameran fungerar bara över **https** – det får du automatiskt från Cloudflare.

## Steg 6 – Testa

1. Öppna sidan, logga in som admin.
2. **Klänningar** → lägg till en klänning (modell, färg, storlek) → klicka **QR** → skriv ut och fäst på lappen.
3. **Konton** → skapa en arbetare (klicka "Slumpa" för ett säkert lösenord).
4. Logga in som arbetaren på en mobil → **Starta kamera** → skanna → **Ta bort från lager**.
5. Som admin: **Översikt** visar vad som finns kvar, **Historik** vem som tog vad.

**Tips:** På mobilen, välj "Lägg till på hemskärmen" så fungerar den som en app.

---

## Hur det fungerar

**Arbetare** ser bara skannern: skanna → klänningen visas → **Ta bild** → **Spara** (klänningen skickas och fotot sparas i historiken).

**Ny kod?** En kod behöver inte finnas i systemet i förväg. Första gången den skannas läggs klänningen in automatiskt. Namnet tas från kodens första del: `BLA-RO-M` får namnet `BLA`, och alla koder som börjar likadant hamnar i samma grupp. Lagersaldot räknas inte förrän admin lägger in ett antal. Admin kan döpa om en grupp under Klänningar eller i skannern (**Byt namn**).

**Foto vid utskick:** `PHOTO_ON_SHIP` i `config.js` styr fotot: `"required"` (standard, man måste ta bild), `"optional"` (går bra utan) eller `"off"` (inget fotosteg). Bilder sparas privat i lagringsplatsen `utskick` och syns bara för admin.

**Skanna på tre sätt:**
- **Kameran** läser både appens egna **QR-koder** och vanliga **streckkoder** som redan sitter på lappen (EAN-13, EAN-8, UPC, Code 128, Code 39).
- **Skriv in koden** i fältet under kameraknappen.
- **Handskanner** (USB eller Bluetooth, från ca 200 kr): klicka i fältet och skanna. Den skriver in koden och trycker Enter.

### Ingen skrivare? Inga problem

Appen fungerar utan att man skriver ut eller köper något. Välj det som passar:

| Sätt | Så gör man | Bäst när |
|---|---|---|
| **Välj i listan** | Tryck **Välj i listan** överst i skannern → tryck på modell och storlek. Det finns en sökruta, och telefonen kommer ihåg valet. | Få modeller, eller lappar utan streckkod |
| **Leverantörens streckkod** | Admin skannar en okänd lapp en gång → **Lägg till som ny klänning**. Sedan kan alla skanna den. | Klänningar som kommer med streckkod (de flesta från grossist) |
| **Egen kod med penna** | Admin skriver en kort kod på klänningen, t.ex. `MAJ-SV-M` (knappen **Föreslå** hittar på en), och skriver samma kod på lappen med penna. Arbetaren skriver in koden i fältet. Stora och små bokstäver spelar ingen roll. | Egna eller sydda klänningar utan streckkod |
| **QR-kod från skärmen** | Admin öppnar **QR** på en klänning på datorn eller en surfplatta, och arbetaren skannar skärmen. | Inventering vid ett skrivbord |

Alla sätten kan blandas i samma lager.

Skannar man en **okänd kod** får arbetaren beskedet att be en admin lägga in klänningen. En admin får i stället knappen **Lägg till som ny klänning**, och då är streckkoden redan ifylld. Admin har också knappen **Lägg in i lager** efter en skanning, så att det går snabbt att fylla på när en leverans kommer.

**Admin** har dessutom:
- **Översikt** – nyckeltal (i lager, uttaget senaste 7 dagarna jämfört med veckan innan, modeller, konton) och grafer: uttag per dag (14 dagar), lagerstatus (finns/låg nivå/slut med namn), kvar per storlek, mest uttagna modeller och uttag per person (30 dagar). Håll musen över en stapel för exakta siffror, eller öppna **Visa siffror**. Längst ner finns en stapel per klänning.
- **Klänningar** – lägg till (modell, färg, storlek, valfri streckkod och artikelnummer), fyll på, koppla streckkod i efterhand, ta bort, skriv ut QR-etiketter (en eller alla, 3 per rad på A4). Klänningar som redan har en streckkod behöver ingen QR-etikett.
- **Konton** – skapa, byt lösenord, ta bort.
- **Historik** – de 100 senaste uttagen/påfyllningarna med namn och tid (webbshop-försäljning märks "Webbshop").
- **Webbshop** – status för kopplingen (avstängd) och vilka klänningar som har artikelnummer.

## Säkerhet – vad som skyddar vad

| Skydd | Vad det stoppar |
|---|---|
| Row Level Security på alla tabeller | Att någon läser eller ändrar data de inte ska, även om de manipulerar webbläsaren |
| Alla ändringar går via databasfunktioner som kollar rollen | Arbetare kan inte fylla på, skapa produkter, ändra saldon direkt eller göra sig själva till admin |
| Saldo kan aldrig bli negativt (kontrolleras atomärt i databasen) | Dubbelklick / två personer samtidigt som tar sista varan |
| Service-nyckeln finns bara på servern (Edge Function) | Att någon med sidans källkod kan skapa konton |
| Öppen registrering avstängd | Att främlingar skapar konton |
| Slumpad 32-teckens kod i QR | Att någon gissar produktkoder |
| Webbshop-kopplingen är av som standard och kräver hemlig nyckel | Att någon utifrån ändrar lagret |
| Strikt Content-Security-Policy, inga externa skript | Att skadlig kod laddas in (XSS) |
| All text visas som text, aldrig HTML | Att produkt- eller personnamn kör kod |
| Automatisk utloggning efter 30 min | Att någon använder en upplåst delad mobil |
| Supabase begränsar inloggningsförsök | Lösenordsgissning |

**Jag har testat** att arbetare, utloggade och inloggade utan profil blockeras från alla admin-funktioner, direkta tabelländringar och negativa saldon.

**Rekommendationer:**
- Aktivera tvåstegsverifiering på ditt Supabase- och Cloudflare-konto.
- Ha minst två admin-konton så att ni inte låses ute.
- Byt lösenord direkt i appen om någon slutar (Konton → Ta bort).

## Webbshop-koppling (förberedd, avstängd)

Allt är byggt men **ingenting är påslaget**. Så länge ni inte gör stegen nedan svarar kopplingen bara "inte aktiverad" och rör inte lagret.

**Förbered redan nu (valfritt):** fyll i *Artikelnr i webbshop* på varje klänning, exakt samma som i webbshoppen (t.ex. `MAJA-SV-M`). Fliken **Webbshop** visar vilka som saknar.

**När ni vill slå på den:**

1. **Edge Functions → Deploy a new function → Via Editor**, namn `shop-sync`, klistra in `supabase/functions/shop-sync/index.ts`, **Deploy**.
2. Öppna funktionen → **Settings** → stäng av **"Enforce JWT verification"** (webbshoppen loggar inte in som användare; den använder API-nyckeln i stället).
3. **Edge Functions → Secrets**, lägg till:
   - `SHOP_API_KEY` = en lång slumpad nyckel (minst 32 tecken). Skapa t.ex. med `openssl rand -hex 32`. Ge den bara till den som bygger webbshoppen.
   - `SHOP_SYNC_ENABLED` = `true`  ← det är denna som slår på kopplingen. Ta bort eller sätt `false` för att stänga av igen.

**Det webbshoppen (eller dess utvecklare) behöver:**

| Vad | Anrop |
|---|---|
| Hämta saldo | `GET https://DITT-PROJEKT.supabase.co/functions/v1/shop-sync/stock` |
| Dra såld order | `POST https://DITT-PROJEKT.supabase.co/functions/v1/shop-sync/order` |
| Header på båda | `x-api-key: <SHOP_API_KEY>` |

Order-anropets innehåll:

```json
{ "order_id": "1001", "items": [ { "sku": "MAJA-SV-M", "quantity": 1 } ] }
```

- Samma `order_id` kan skickas flera gånger utan att lagret dras två gånger.
- Saldot blir aldrig negativt.
- För Shopify eller WooCommerce behöver deras order-webhook översättas till formatet ovan, t.ex. med en liten mellanfunktion eller ett gratisverktyg som Make/Zapier (gratisnivå). Säg vilken plattform ni har, så kan den delen byggas.

## Anpassa

- **Appens namn:** `APP_NAME` i `config.js`.
- **Tid till utloggning:** `IDLE_LOGOUT_MINUTES` i `config.js`.
- **Färg:** `--accent` överst i `style.css`.
- **Egen domän:** Cloudflare Pages → Custom domains (gratis om du redan har en domän). Uppdatera då `ALLOWED_ORIGIN`.

## Felsökning

| Problem | Lösning |
|---|---|
| "Fyll i config.js…" | Du har inte lagt in URL och anon-nyckel i `config.js` |
| Inloggning funkar men "Kontot saknar behörighet" | Kontot saknar rad i `profiles` – kör SQL:en i steg 3 |
| Kameran startar inte | Sidan måste vara https; tillåt kamera i webbläsarens inställningar |
| "Något gick fel" när admin skapar konto | Kontrollera att `admin-users` är deployad och att `ALLOWED_ORIGIN` matchar sajtadressen exakt (utan / på slutet) |
| Allt slutade fungera efter semestern | Projektet har pausats – klicka "Restore" på supabase.com |
