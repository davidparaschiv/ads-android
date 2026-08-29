# Licențe și invitații — ghid administrator

Actualizare: înscrierea afacerii necesită email confirmat, telefon verificat prin SMS și aprobarea administratorului. Vezi [ENROLLMENT.md](ENROLLMENT.md). Bypass-ul de dezvoltare este numai prin `dev112233` și poate fi activat de orice cont Google verificat. Nu mai există comutator frontend pentru sărit plata.

## Reguli implementate

| Acces | Calendare active | Cine plătește |
| --- | ---: | --- |
| Small · 50 EUR/lună | 1 | Proprietarul |
| Complete · 150 EUR/lună | 5 | Proprietarul |
| Cheie de licență | 5 | Fără plată pe durata licenței |
| Membru invitat | Numai calendarele alocate | Nu plătește separat |

Din v0.4, numai Complete include rapoarte și notificări pentru afacere. Licențele active de 5 calendare includ aceste beneficii. Small păstrează gestionarea rezervărilor și invitațiile. Notificările personale ale clienților nu depind de plan. Aplică migrarea 004: [PLAN-UPDATE.md](PLAN-UPDATE.md).

Un calendar este o resursă care acceptă o singură programare simultană: un angajat, un post de lucru sau o barcă. Cinci calendare nu înseamnă cinci conturi: mai mulți membri pot colabora pe același calendar. Modelul nu acoperă automat zece angajați cu zece programări simultane. O afacere deținută per cont Google; același cont poate fi invitat în alte afaceri.

## 1. Generează cheia local, în CMD

Ai nevoie doar de Node.js pentru generator; acesta nu folosește Supabase, internetul sau chei de administrator.

Din folderul proiectului, în Windows CMD:

```bat
node tools\generate-license.mjs --email owner@gmail.com --start "2026-09-01T00:00:00+03:00" --months 3
```

Alternativ, pe orice platformă:

```bash
npm run license:generate -- --email owner@gmail.com --start "2026-09-01T00:00:00+03:00" --months 3
```

Există și wrapperul `tools\generate-license.cmd`, care acceptă aceiași parametri. Generatorul afișează:

1. Cheia privată `RZL-…`, generată din 32 octeți aleatori criptografic.
2. Adresa normalizată, data UTC și numărul de luni.
3. O comandă SQL care conține **numai hash-ul**, adresa, începutul și durata.

Nu execută SQL și nu încarcă nimic automat. Cheia apare în ieșirea terminalului; nu partaja capturi/înregistrări ale terminalului și nu o pune în Git sau fișiere publice. Păstreaz-o într-un manager de parole până o transmiți proprietarului. Dacă o pierzi, hash-ul nu permite recuperarea: revocă înregistrarea și emite alta.

## 2. Înregistrează manual în Supabase

Aplică întâi migrațiile `001_initial_schema.sql`, apoi `002_plans_licenses_invitations.sql`. În SQL Editor, conectat ca administrator, copiază **numai blocul SQL** afișat de generator.

Înregistrarea este în `private.license_keys`, nu într-un tabel accesibil prin API-ul aplicației. Poți vedea datele administrative astfel:

```sql
select id, bound_email, starts_at, duration_months, expires_at,
       redeemed_by, redeemed_at, revoked_at, note
from private.license_keys
order by created_at desc;
```

`expires_at` se calculează automat. Nu îl edita direct. Durata este în **luni calendaristice UTC**, nu în blocuri de 30 de zile și nu de la prima activare. Exemplu: 31 ianuarie + 1 lună = ultima zi din februarie. Ora este stocată UTC și afișată în `Europe/Bucharest`; schimbarea orei de vară poate modifica ora locală afișată.

Trimite proprietarului numai cheia și perioada, nu acces la baza de date. El intră cu Google → Înregistrează propria afacere/Alege planul → Am o cheie de licență. Serverul compară adresa Google verificată cu `bound_email`, fără diferență între litere mari/mici. Nu elimină puncte sau sufixe `+` din adrese: folosește exact adresa din cont.

O cheie obișnuită poate fi legată de un singur cont. Reintroducerea ei în același cont este sigură și nu prelungește termenul. Poate fi înregistrată înainte de început, dar nu acordă acces anticipat. Cheile pentru alt cont, expirate, revocate sau inexistente răspund identic cu „Licență invalidă”. `dev112233` este excepția universală.

### Revocare sau schimbare de perioadă

Înlocuiește UUID-ul de exemplu cu `id`-ul exact din interogarea de mai sus:

```sql
-- Revocare imediată la următoarea verificare/operație server.
update private.license_keys
set revoked_at = now()
where id = '00000000-0000-0000-0000-000000000000';

-- Modificare explicită a perioadei; expirarea se recalculează automat.
update private.license_keys
set starts_at = '2026-09-01T00:00:00+03:00', duration_months = 3
where id = '00000000-0000-0000-0000-000000000000';
```

Pentru alt e-mail/alt proprietar, revocă și generează o cheie nouă. Nu reseta manual `redeemed_by` pentru a refolosi o cheie deja distribuită.

## 3. Ce se întâmplă la expirare

Serverul compară timpul bazei de date, nu ceasul telefonului. Nu este necesar un cron ca să expire licența.

- Un abonament Google Play valid poate menține accesul după expirarea cheii.
- Fără alt drept activ, programările noi și crearea/reactivarea calendarelor sunt refuzate.
- Istoricul rămâne vizibil utilizatorilor care au încă permisiune. Anularea programărilor și eliminarea accesului rămân posibile.
- Proprietarul alege explicit un abonament Google Play. Cheia nu configurează o plată și nu produce debitare automată.
- Dacă are deja un abonament Play, cheia nu îl anulează și nu suspendă facturarea acestuia. Abonamentul se gestionează din Google Play.
- Dacă scade de la 5 la 1 calendar, proprietarul arhivează calendarele în plus. Datele și programările existente nu sunt șterse; programările noi se reiau când numărul de calendare active respectă planul.
- Când există mai multe drepturi active, se alege limita cea mai mare, apoi expirarea cea mai târzie. Licențele nu se adună automat ca durată.

## 4. Invitații pe e-mail

Configurează în **secretele funcțiilor Supabase**, nu în `.env` Vite:

```env
RESEND_API_KEY=...
INVITE_FROM_EMAIL=Rezerva <invitatii@domeniul-tau.ro>
```

Verifică domeniul expeditorului în Resend. Publică `send-calendar-invite`. Configurația completă este în `supabase/.env.example`. Pentru o pagină HTTPS intermediară opțională, găzduiește `public/invite.html`, `invite.js`, `invite.css` împreună și setează `INVITE_WEB_URL=https://domeniul-tau.ro/invite.html`. Altfel, e-mailul conține direct linkul Android și un cod de copiat.

Proprietarul deschide Acasă → Calendare și echipă, introduce adresa Google, selectează calendarele și permisiunea:

- **Vizualizare:** programări, nume/e-mailuri ale clienților și rapoarte numai pentru calendarele alocate.
- **Gestionare:** aceleași date, plus anulare/finalizare/marcare absent. Nu poate modifica abonamentul, invita alte persoane sau administra membrii.

Invitația expiră în 48 de ore și este de unică folosință. Retrimiterea creează un cod nou și invalidează linkul anterior. Revocarea unei invitații neacceptate blochează acceptarea; pentru un membru deja acceptat folosește „Elimină accesul”. Modificarea permisiunilor și eliminarea membrilor sunt verificate pe server. Eliminarea blochează citirile viitoare, nu poate retrage date deja văzute/copiate.

Destinatarul deschide aplicația → Reprezint o afacere → Google → Am o invitație. Folosește exact adresa destinatară, apoi vede numai calendarele alocate. Nu trece prin plata abonamentului. Linkul poate deschide aplicația instalată; codul manual rămâne disponibil dacă aplicația de e-mail blochează linkuri personalizate. Linkurile HTTPS Android verificate necesită domeniul și semnătura aplicației reale înainte de publicare.

E-mailurile sunt folosite pentru invitații și, în v0.3, pentru verificarea înscrierii/aprobare. Reminderele pentru programări sunt push. La livrare se verifică din nou apartenența și preferința destinatarului; retragerea accesului anulează reminderele încă în așteptare. Un push deja trimis nu poate fi retras.

## 5. Securitate și operare

- Cheile și invitațiile sunt verificate de funcții PostgreSQL cu permisiuni controlate și `search_path` fix; nici interfața, nici datele din Preferences nu acordă acces.
- Chei: 256 biți aleatori, SHA-256 în DB, 5 încercări per cont per fereastră de 15 minute, blocare tranzacțională la activare. Hashing-ul fără parolă secretă este potrivit aici deoarece cheia are entropie mare; nu folosi parole scurte drept chei.
- Invitații: token aleator, numai hash în DB, adresă verificată, expirare, revocare și 5 încercări de acceptare/15 minute. Creare: 10 invitații/15 minute per proprietar.
- Acordarea licențelor, schimbarea limitei și activarea plăților nu sunt permise rolurilor `anon`/`authenticated`.
- Nu se includ chei private în APK, loguri de funcții sau Preferences. Secretele Resend/RevenueCat/FCM/service-role există numai pe server.
- Politicile RLS se testează în baza PostgreSQL locală prin `npm test`; acestea nu înlocuiesc un audit independent și teste pe proiectul Supabase real.
- Protejează conturile de administrator cu MFA, limitează accesul SQL și păstrează backupuri. Compromiterea contului Google al destinatarului, a dispozitivului sau a administratorului DB nu este prevenită doar de o cheie de licență.
- Curăță periodic ca administrator numai contoarele vechi: `delete from private.request_limits where window_start < now() - interval '7 days';`. Nu șterge licențe/istoric fără o politică de retenție.
- Rulează un singur cron de remindere/minut. Există claim atomic și maximum 3 încercări; înainte de producție adaugă recuperarea joburilor blocate în `processing`, monitorizare și politici de retry pe dispozitiv. Livrarea FCM nu este garantată la secundă.

### Google Play

Acest mecanism este pentru licențe acordate administrativ, inclusiv acces gratuit/testare. Nu presupune că poți vinde chei în afara Google Play pentru a evita comisioanele. Abonamentul software este acces digital, distinct de plata fizică a unei manichiuri. Verifică eligibilitatea și regulile înainte de distribuire/vânzare externă: [politica Google Play Payments](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en). Nu există linkuri către checkout extern în aplicație.
