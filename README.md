# Rezerva — versiunea 0.4

**Ghid ușor de citit:** deschide [SETUP.html](SETUP.html) în browser (funcționează offline; se poate imprima). Este la rădăcina proiectului, lângă acest README, și nu este ecran al aplicației Android.

**Pornește aici pentru testare cu servicii reale, fără publicare și fără domeniu:** [START-HERE.md](START-HERE.md). Ghid complet Windows, migrații, secrete și cron: [docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md). Copiază `.env.live.example` în `.env` pentru această variantă; nu folosi modul demo.

Arhiva este versiunea curentă de dezvoltare, nu un release de producție. **QR per rezervare și check-in nu sunt încă implementate.** Nu conține APK compilat sau credențiale reale.

Aplicație Android de programări, în română, alb/roșu. HTML, CSS, JavaScript simplu cu `// @ts-check`, fără fișiere TypeScript sau framework UI. Capacitor + Supabase/PostgreSQL + RevenueCat/Google Play + Firebase Cloud Messaging. TypeScript este folosit doar ca unealtă de verificare a JavaScript-ului; nu generează cod.

## Noutăți

- **Actualizare de la v0.3:** păstrează configurația locală, aplică numai `supabase/migrations/004_team_features.sql` după migrațiile deja instalate, apoi `npm run android:sync` și reinstalează din Android Studio. [Pași și verificări](docs/PLAN-UPDATE.md). Nu rerula 001–003. Identificatorii Google Play nu s-au schimbat.
- Înscriere cu CUI, e-mail de contact și telefon obligatorii; confirmare prin cod, SMS prin Twilio Verify și aprobare prin cod de către ownerul fixat în DB. Emailurile nu conțin linkuri. Afacerea este creată numai după aprobarea finală. [Ghidul înscrierii și al cheii dev112233](docs/ENROLLMENT.md).
- Comutatorul de test care sărea peste plată a fost eliminat. Bypass-ul de dezvoltare necesită introducerea cheii `dev112233`; cheia poate fi folosită de orice cont Google verificat.

- Small: **50 EUR/lună, 1 calendar, un singur utilizator, fără Team flow, rapoarte sau notificări pentru afacere**. Complete: **150 EUR/lună, 5 calendare partajate și maximum 15 membri acceptați, cu rapoarte și notificări pentru afacere**. Doar proprietarul plătește. Notificările personale ale clienților rămân disponibile la ambele planuri.
- Chei generate local prin CMD, înregistrate manual în DB cu hash, e-mail, început și luni de valabilitate. Orice cheie acordă 5 calendare, niciodată planul de 1 calendar.
- Activare și expirare verificate pe server; cheia nu este salvată în Preferences. La expirare accesul operațional este blocat până la un drept nou, fără ștergerea datelor.
- Invitații pe e-mail, selectarea calendarelor, vizualizare/gestionare, retrimitere, revocare și editarea accesului membrilor.
- Angajații invitați intră direct în spațiul afacerii, fără achiziție personală.
- Calendar zilnic la ambele planuri. Pe Complete, toate cele 5 calendare sunt partajate automat cu toți membrii acceptați; rapoartele pe zi/săptămână/lună rămân verificate pe server.
- Crearea/reactivarea calendarelor este limitată tranzacțional. Clienții aleg calendarul și orele calculate pe server, fără expunerea altor clienți.
- Remindere numai push; e-mail pentru invitații/verificări/aprobare; SMS pentru verificarea telefonului.

**Ghidul pentru generarea cheilor, SQL manual, invitații și securitate:** [docs/LICENSES-AND-TEAM.md](docs/LICENSES-AND-TEAM.md).

## Demo fără conturi

Instalează Node.js 22+ și rulează din folderul proiectului:

```bash
npm ci
npm run dev
```

Modul implicit este `demo`. Nu trebuie cont Supabase, Google Play, Firebase sau Resend pentru demo. Datele sunt mostre locale; o programare nouă afișează succes, dar nu este adăugată listei de mostre sau sincronizată între telefoane. Plățile nu sunt efectuate și butoanele de plată/restaurare nu acordă acces. Pentru demo, copiază `.env.example` în `.env` (`copy .env.example .env` în CMD, `cp .env.example .env` pe macOS/Linux).

```env
VITE_APP_MODE=demo
VITE_ENABLE_LICENSE_REDEMPTION=true
```

- Test licență: Reprezint o afacere → Google → Înregistrează propria afacere → Am o cheie → `dev112233`.
- Test invitat: Google → Am cod de invitație → `DEMO-INVITATIE`.
- Invitația demo este numai locală. Cheia `dev112233` este disponibilă oricărui cont Google verificat și în live. În demo nu se trimit emailuri/SMS-uri reale.
- Nu există un flag care să sară peste plată. Plata demo nu acordă abonament; numai cheia de dezvoltare activează accesul de test. În live rămân disponibile și licențele normale verificate pe server.

## Android

```bash
npm run android:sync
npm run android:open
```

Deschide proiectul în Android Studio și instalează SDK/JDK-urile cerute de versiunea Capacitor/Gradle inclusă. Arhiva conține sursele Android, nu un APK semnat. Nu modifica ecranele pentru a introduce credențiale.

## Configurare live

### 1. Supabase

1. Creează proiectul și rulează în ordine migrațiile din `supabase/migrations/`, inclusiv `008_owner_approval_codes.sql`–`014_drawn_screens_service_calendar.sql`. Migrarea `012_booking_rejected_status.sql` trebuie confirmată înainte de `013`, deoarece PostgreSQL nu permite folosirea unei valori enum noi în aceeași tranzacție în care a fost creată. Migrarea `014` adaugă serviciile legate de calendare și blochează atomic suprapunerile `pending`/`confirmed` pe același calendar.
2. Rulează numai migrațiile încă neaplicate; nu rerula 001 pe baza existentă. Fă backup înainte. Migrarea 002 presupune o afacere deținută per cont; dacă există duplicate, migrarea se oprește și trebuie rezolvate fără a șterge istoricul. Pentru un proiect v0.2, aplică 003 și 004; pentru v0.3, numai `004_team_features.sql`.
3. Activează providerul Google și configurează clientul OAuth. Adaugă `ro.rezerva.app://auth/callback` la URL-urile redirect autorizate. Pentru test web, adaugă originea locală exactă.
4. În `.env` completează `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, apoi `VITE_APP_MODE=live`.
5. Păstrează `private` în afara schemelor expuse de API. Nu pune `service_role` în aplicație. Migrarea revocă explicit drepturile de client asupra licențelor și operațiilor privilegiate.
6. Migrarea retrage drepturile globale ale vechilor membri `manager`: proprietarul trebuie să le aloce explicit calendare în noul ecran Echipă.

### 2. Invitații pe e-mail

Configurează domeniul expeditorului în Resend. Setează `RESEND_API_KEY` și `INVITE_FROM_EMAIL` ca secrete Supabase. Opțional `INVITE_WEB_URL`, pentru pagina statică inclusă în `public/`. Nu configura notificări de programare pe e-mail. Detalii în ghidul de administrare.

Pentru testare fără domeniu: creează contul Resend cu `davidnicolaparaschiv@gmail.com` și folosește `INVITE_FROM_EMAIL=Rezerva <onboarding@resend.dev>`. Emailul de contact al cererii trebuie să fie aceeași adresă. Expeditorul de test poate trimite numai la adresa contului Resend; invitațiile către alte adrese necesită ulterior un domeniu verificat. Nu modifica destinatarul administratorului din DB. `START-HERE.md` explică pașii.

### 3. Google Play / RevenueCat

1. Creează `rezerva_small_monthly` (50 EUR/lună) și `rezerva_large_monthly` (150 EUR/lună), fiecare cu plan de bază lunar auto-renewing.
2. Importă produsele în RevenueCat, atașează-le la `business_pro` și la un Offering curent. Configurează notificările server Google/RevenueCat.
3. Pune numai cheia **publică Android SDK** în `VITE_REVENUECAT_GOOGLE_API_KEY`. Schimbările din `.env` cer rebuild/sync Android.
4. Secretele backend: `REVENUECAT_SECRET_API_KEY`, `REVENUECAT_ENTITLEMENT_ID=business_pro`, `REVENUECAT_WEBHOOK_AUTH` (o valoare lungă, aleatoare).
5. Webhook-ul RevenueCat trimite exact valoarea configurată în headerul Authorization către funcția `revenuecat-webhook`.
6. Configurează restore behavior în RevenueCat pentru a păstra achizițiile asociate contului original, nu transfer liber între conturile aplicației. Identificatorul RevenueCat este UUID-ul Supabase, nu e-mailul.
7. Testează cumpărare, restaurare, anulare, refund, expirare și schimbarea contului pe Google Play Internal Testing. Upgrade-ul folosește înlocuirea produsului cu proratare imediată; downgrade-ul este amânat până la reînnoire. Validează pe produsele tale efective.

Prețurile `.env` sunt numai pentru prezentarea demo. Ecranul live preia prețul localizat din Google Play/RevenueCat înainte de a permite cumpărarea. Prețul real se configurează în Play Console.

Sandbox-ul nu acordă implicit acces live. **Numai într-un proiect Supabase separat de test**, administratorul poate executa:

```sql
update private.server_settings set allow_sandbox_payments = true where singleton;
```

În proiectul de producție, păstrează `false`. Alternativa simplă fără plăți este emiterea unei licențe gratuite limitate în timp.

### 4. Firebase / push

1. Adaugă aplicația Android `ro.rezerva.app` în Firebase și pune fișierul descărcat în `android/app/google-services.json`.
2. Setează în secretele Supabase: `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `CRON_SECRET`.
3. Programează `send-reminders` printr-un POST în fiecare minut, cu headerul `x-cron-secret` egal cu secretul tău. Nu trimite cheia în URL.
4. Testează permisiunile pe dispozitiv și push când aplicația este în fundal. Reminderele nu sunt emailuri și livrarea la secundă nu este garantată.

### 5. Publicarea funcțiilor

Toate funcțiile sunt JavaScript. `supabase/config.toml` setează explicit entrypoint-urile `.js`. După ce te autentifici cu CLI Supabase și legi proiectul:

```bash
supabase functions deploy sync-subscription
supabase functions deploy revenuecat-webhook
supabase functions deploy send-calendar-invite
supabase functions deploy send-reminders
supabase functions deploy enrollment
```

`verify_jwt=false` este intenționat: `sync-subscription`, `send-calendar-invite` și `enrollment` verifică manual tokenul cu `auth.getUser()`; webhook-ul și cron-ul au secrete independente obligatorii. Nu elimina verificările din cod. `ALLOWED_ORIGINS` permite implicit originile locale Capacitor; adaugă explicit originea de test web dacă este diferită.

Exemplele secretelor backend sunt în `supabase/.env.example`; nu le copia în `.env` din rădăcină și nu le prefixa cu `VITE_`.

## Teste și fișiere importante

**Nou: teste numai pentru backend și integrări reale**, cu instrucțiuni Git Bash în [BACKEND-TESTS.md](BACKEND-TESTS.md).

```bash
npm run test:backend:local
npm run test:backend:setup
# Completează .env.backend.local și confirmă proiectul de dezvoltare înainte de:
npm run test:backend
```

Testele live sunt opt-in. Emailurile, SMS-urile, notificările și scrierile persistente cer acord explicit prin opțiuni CLI. `npm test` rămâne offline. Pentru această actualizare aplică migrațiile noi `012`, `013` și `014`, apoi republică funcția `send-reminders`.

```bash
npm run check
npm run typecheck
npm test
npm run build
npm run android:sync
```

Testele pornesc PostgreSQL în memorie prin PGlite. Suita de regresie testează migrațiile 001–002, suita de înscriere 001–003, iar suita planurilor toate cele patru migrații, cu roluri și identități Auth de test. Testele UI folosesc un DOM simulat; nu sunt teste de randare pe telefon sau validări ale serviciilor externe.

- `tools/generate-license.mjs`: generator local, fără acces DB.
- `supabase/migrations/002_plans_licenses_invitations.sql`: drepturi, expirare, invitații, limite și disponibilitate.
- `src/config.js` / `.env.example`: configurarea clientului.
- `supabase/.env.example`: configurarea secretelor server.
- `src/screens/team.js`: licențe, invitații, calendare și membri.
- `src/screens/dashboard.js`: calendare și rapoarte.
- `docs/LICENSES-AND-TEAM.md`: procedura administratorului și limite de securitate.

## Înainte de producție

Acesta este un schelet funcțional extins, nu o garanție de securitate sau o lansare gata aprobată. Necesită testele end-to-end cu serviciile reale, audit al permisiunilor, configurarea politicilor de retenție și a ștergerii contului, pagini reale de suport/confidențialitate și verificarea regulilor Google Play. Linkurile `example.com` sunt placeholders, nu politici juridice.

Limite rămase: editor complet pentru ore/servicii după configurarea inițială, excepții de program și reprogramări complexe; preferințele de reminder se aplică programărilor create ulterior; recuperare automată pentru joburi push întrerupte în `processing`; monitorizare și reconciliere periodică a abonamentelor când un webhook este ratat. Demo-ul nu este o bază de date de producție. Rapoartele paginează toate înregistrările intervalului; la volume mari mută agregările în SQL și păstrează lista paginată în UI.

Folosește cheile pentru acces administrativ/gratuit/testare. Vânzarea externă de chei pentru funcții digitale poate intra sub [regulile de plată Google Play](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en); nu este un mecanism de evitare automată a acelor reguli.





DAVID run tests after npm install:
npm run test:backend:local
