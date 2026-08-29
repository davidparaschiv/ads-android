# Înscriere verificată — v0.3

## Flux

1. Solicitantul intră cu Google și completează denumirea, categoria, adresa, CUI, e-mailul de contact și telefonul mobil românesc.
2. Se creează doar o cerere temporară în schema **privată**. Nu există încă un rând în `public.businesses`, iar afacerea nu apare la căutare.
3. Solicitantul primește un link la e-mailul de contact. Deschide linkul în aplicație, conectat cu contul Google care a început cererea, și apasă explicit „Confirm adresa de e-mail”. Adresa de contact poate fi diferită de adresa Google.
4. Solicită un SMS, apoi introduce codul primit. Numărul verificat este cel din cererea din DB, nu unul furnizat separat de client la verificare.
5. Apasă „Solicită aprobarea”. Linkul de aprobare este trimis **exclusiv la `davidnicolaparaschiv@gmail.com`**, citit din `private.platform_settings`.
6. David deschide linkul, intră în aplicație cu acel cont Google verificat, inspectează CUI/datele și aprobă sau respinge. Numai aprobarea validă, după ambele verificări, creează afacerea. Linkul singur, fără contul lui David, nu permite aprobarea.
7. Solicitantul apasă „Actualizează starea”, apoi continuă la abonament/licență și configurarea calendarului. Nu îi cerem să cumpere înainte de aprobare.

Emailul administratorului este fixat prin constrângere în baza de date și nu există un câmp sau API de client pentru schimbarea sa. La prima activare a cheii de dezvoltare sau prima aprobare, contul administratorului este legat și de UUID-ul Auth. Un administrator al bazei de date poate modifica schema sau permisiunile; aplicația nu poate proteja datele împotriva cuiva care deține controlul complet asupra DB.

CUI se normalizează (prefixul opțional RO este eliminat), are validare de **format**, și este unic între afacerile înregistrate. Nu se verifică automat în registrul ANAF/ONRC și nu dovedește dreptul solicitantului de a reprezenta firma. Aceasta rămâne parte din evaluarea manuală a administratorului.

Telefonul acceptă `07xxxxxxxx` sau `+407xxxxxxxx`; este stocat în format E.164. Numerele fixe/internaționale nu sunt incluse în acest schelet.

## Configurare

Aplică migrarea `003_verified_enrollment.sql` după 001 și 002. Pentru proiectul existent deja migrat, rulează **doar 003**, după backup. Afacerile vechi sunt păstrate; nu primesc automat marcaje false de verificare.

Migrarea setează adresa administratorului. Nu pune un `OWNER_EMAIL` în client și nu trimite adresa destinatarului aprobării din aplicație. Endpointul vechi `create_business` este blocat, inclusiv pentru APK-uri mai vechi.

În Supabase → Edge Function Secrets configurează:

| Secret | Rol |
| --- | --- |
| `RESEND_API_KEY` | Trimitere e-mailuri prin Resend |
| `INVITE_FROM_EMAIL` | Expeditor pe un domeniu verificat în Resend, nu neapărat Gmail-ul administratorului |
| `TWILIO_ACCOUNT_SID` | Contul Twilio |
| `TWILIO_AUTH_TOKEN` | Secretul Twilio, niciodată în APK |
| `TWILIO_VERIFY_SERVICE_SID` | Serviciul Twilio Verify; începe cu VA |
| `ENROLLMENT_WEB_URL` | Opțional, URL HTTPS către `public/verify.html` |

Publică funcția:

```bash
supabase functions deploy enrollment
```

`verify_jwt=false` în config nu înseamnă acces anonim: funcția verifică explicit fiecare solicitare cu `auth.getUser()`. După orice modificare de configurare frontend rulează `npm run android:sync`.

Opțional găzduiește `verify.html`, `verify.js` și `invite.css` pe domeniul tău HTTPS. Linkurile păstrează tokenul în fragmentul URL și nu aprobă prin simplul GET, astfel încât scanarea automată a e-mailurilor nu consumă verificarea. Fără acest URL, mesajele folosesc direct deep linkul Android și un cod alternativ de copiat. Testează pe telefon și în aplicația de e-mail aleasă. Pentru Android App Links verificate sunt necesare domeniul și amprenta certificatului aplicației tale.

Configurează Twilio Verify cu protecție antifraudă, țările permise și limite de cheltuieli. SMS-urile reale pot costa bani, chiar dacă prezentarea locală este gratuită. Un cont Twilio trial are restricții privind destinatarii. [Documentație Twilio Verify](https://www.twilio.com/docs/verify/api/verification), [verificarea codului](https://www.twilio.com/docs/verify/api/verification-check).

## Cheia de dezvoltare și plata

Nu mai există un comutator de configurare care să sară peste plată. O configurație veche cu acel câmp este ignorată de codul nou. Nici butonul de cumpărare simulat și nici restaurarea în demo nu acordă abonament.

Introdu `dev112233` în ecranul de licență:

- În demo: acordă 5 calendare în simularea locală, pentru 30 de zile. Nu transmite mesaje sau plăți.
- În live: serverul acceptă cheia de dezvoltare pentru orice cont Google verificat. Aprobarea înscrierii rămâne separată și rezervată administratorului platformei.
- Acordă 5 calendare pentru 30 de zile de la introducere; reintroducerea poate reînnoi accesul dezvoltatorului.
- Nu confirmă emailuri, telefoane sau cereri și nu ocolește aprobarea înscrierii.
- Codul este cunoscut și scurt, deci **nu este tratat ca un secret de securitate**. Verificarea contului și regulile server sunt protecția reală.
- Licențele normale generate local continuă să funcționeze în live, cu adresa și perioada lor. Nu primesc regulile speciale ale dezvoltatorului.

Poți revoca accesul dezvoltatorului, ca administrator SQL:

```sql
update private.platform_settings set developer_bypass_enabled = false where singleton;
```

Acesta este un mecanism de revocare pe server, nu un flag al aplicației care acordă acces fără cheie.

## Demo complet

Introdu `dev112233`, completează datele, apoi folosește butoanele marcate clar **Simulează linkul de e-mail** și **Simulează linkul administratorului**. Codul SMS demo este `123456`. Aceste simulări există exclusiv în `VITE_APP_MODE=demo`; ele nu pot fi folosite de serverul live și nu creează dovezi de verificare reale.

## Protecții și limite

- Tokenuri de link aleatoare, hash în DB, expirare de 24 de ore, de unică folosință și legate de cont/rol. Cererea expiră în 7 zile.
- Retrimiterea invalidează linkul precedent. Corectarea datelor creează o cerere nouă și invalidează cererea precedentă; emailul/SMS-ul trebuie verificate din nou.
- Doar `service_role` poate marca dovada SMS sau emite linkuri de email/aprobare. Clientul nu poate schimba CUI/email/telefon după verificare. Telefonul unei afaceri înregistrate nu mai este editabil prin vechiul UPDATE direct.
- Limite: 3 cereri noi/15 minute/cont; 3 trimiteri SMS/15 minute/cont; 60 secunde între SMS-uri; 5 SMS-uri/zi/număr; maximum 100/zi global implicit; 8 verificări SMS/15 minute; 3 linkuri/oră/tip/cerere.
- Limita globală SMS se poate ajusta în `private.platform_settings.sms_daily_limit`. Nu înlocuiește limitele de cheltuieli și antifraudă ale furnizorului.
- Aplicația deține numai o cerere privată înainte de confirmare, nu o afacere publică. Nu este o promisiune că niciun byte nu este stocat în DB înainte de verificare: starea privată este necesară pentru tokenuri, retry și protecția împotriva abuzului.
- Reminderele de programare rămân push. Emailul este folosit acum și pentru verificarea înscrierii/aprobare, pe lângă invitații. SMS este folosit numai la verificarea telefonului.
- Testează livrarea reală, schimbarea contului, relansarea aplicației din link, expirarea, respingerea și erorile furnizorului înainte de producție. Nu s-au trimis emailuri sau SMS-uri reale în timpul generării acestei versiuni.
