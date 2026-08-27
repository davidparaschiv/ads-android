# Actualizare v0.4 — Small și Complete

| Funcție pentru afacere | Small · 50 €/lună | Complete · 150 €/lună |
| --- | --- | --- |
| Calendare active | 1 | 5 |
| Rezervări și calendar zilnic | Da | Da |
| Colegi invitați prin e-mail | Da, pe calendarul alocat | Da, pe calendarele alocate |
| Rapoarte zi/săptămână/lună | Nu | Da |
| Notificări push înaintea rezervărilor afacerii | Nu | Da |

Notificările personale ale clienților sunt disponibile indiferent de planul afacerii. E-mailurile de înscriere, aprobare și invitație, precum și SMS-ul de verificare, nu sunt beneficii premium și nu au fost dezactivate.

Cheile normale și cheia de dezvoltare autorizată `dev112233` acordă Complete (5 calendare plus rapoarte/notificări), doar în perioada lor de valabilitate. Un coleg primește beneficiile planului afacerii, fără să plătească separat. Drepturile rămân limitate la calendarele alocate.

## Dacă ai aplicat deja migrațiile 001–003

1. Păstrează o copie de siguranță a proiectului și bazei înaintea actualizării. Extrage noul ZIP separat. Păstrează `.env`, `android/app/google-services.json` și configurația/cheile locale Android; nu le publica și nu le înlocui cu exemplele.
2. În Supabase → SQL Editor, rulează întregul fișier `supabase/migrations/004_team_features.sql` o singură dată. Nu rerula 001–003 și nu șterge tabele. Migrarea rulează într-o tranzacție; dacă apare o eroare, oprește-te și investighează.
3. Dacă folosești CLI și ai aplicat 004 manual, înregistrează numai această migrare, după confirmarea succesului:

   ```bat
   npx supabase migration repair 004 --status applied
   npx supabase migration list
   ```

   Dacă istoricul 001–003 nu este încă înregistrat, urmează pașii din START-HERE pentru acele migrații deja aplicate. Alternativ, cu istoricul corect, `npx supabase db push --dry-run` și `npx supabase db push` aplică și înregistrează 004; în acest caz nu folosi repair pentru 004.
4. În noul folder, copiază configurația ta locală, apoi rulează:

   ```bat
   npm ci
   npm run check
   npm run typecheck
   npm test
   npm run android:sync
   npm run android:open
   ```

5. În Android Studio, rulează aplicația pe telefon. Pentru actualizare peste instalarea existentă folosește aceeași identitate de semnare debug. Verifică versiunea instalată; nu folosi APK-ul vechi.

Pentru o bază nouă, aplică toate migrațiile: 001 → 002 → 003 → 004. Nu sunt necesare conturi noi sau secrete noi. Workerul existent `send-reminders` verifică deja permisiunea prin RPC înaintea livrării; noua migrare actualizează acea regulă, fără redeploy obligatoriu pentru această schimbare.

## Verificări pe servicii reale

- Small: calendarul și rezervările funcționează. Rapoarte/Notificări afișează mesajul de acces Complete, fără formular sau date de raport.
- Complete: rapoartele și setările de notificare funcționează inclusiv pentru colegii invitați, numai pe calendarele alocate.
- La o rezervare nouă pe Small se programează doar notificarea clientului. Complete include proprietarul și colegii alocați care acceptă notificări.
- Expirarea sau downgrade-ul blochează livrarea notificărilor afacerii deja programate, la următoarea verificare a workerului. Mesajele deja trimise nu pot fi retrase. Upgrade-ul nu recreează automat notificările rezervărilor vechi.
- Licența activă de 5 calendare acordă Complete chiar dacă există și o plată Small. Pentru verificarea Small folosește un cont fără licență/grant activ; nu modifica verificările sau politicile de securitate.

## Compatibilitate și limite

Denumirile vizibile sunt Small și Complete. ID-urile interne rămân `small`/`large`; produsele rămân `rezerva_small_monthly`/`rezerva_large_monthly`, iar entitlement-ul RevenueCat rămâne `business_pro`. Poți actualiza separat denumirile afișate în Play Console; prețurile efective vin din Google Play, nu din textul aplicației.

Rapoartele aplicației folosesc noul RPC `get_business_report`, cu verificare server la fiecare pagină. Calendarul păstrează accesul RLS la rezervările autorizate pe Small: aceste date nu pot fi ascunse și simultan disponibile pentru gestionare. Un client vechi sau modificat poate calcula propriile statistici din datele la care are acces legitim; migrarea nu pretinde că poate împiedica acest lucru. Instalează aplicația actualizată pentru noua separare a ecranelor.

Preferința push rămâne per cont, ca anterior: un cont care este și client își poate gestiona notificările personale fără abonament. Acest lucru nu îi acordă notificări pentru afacerea Small; destinatarii se verifică pe server după rolul lor în rezervare.
