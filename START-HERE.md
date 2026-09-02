# START HERE — real services on your Android phone, no domain

This is the current Rezerva v0.4 development source. You will install it privately, use real Google login/DB/email/SMS/push, and use your authorized developer license instead of purchasing a plan. Nothing here publishes the app to the public Play Store.

**Plans:** Small = €50/month, 1 calendar, no business reports or reminders. Complete = €150/month, 10 calendars with business reports and push reminders. Customer reminders remain available with either plan. Complete/half_complete licenses grant 10/5 calendars with Complete features. Apply all missing migrations through 025 in numeric order.

**Not included yet: reservation QR codes/check-in, a compiled APK, or production approval.** The existing app and tests are included. Do not treat this archive as a fully finished production release.

Use Windows **Command Prompt (CMD)** for the commands below. Run commands from the folder containing `package.json`. Stop if a checkpoint fails. The [full guide](docs/WINDOWS-SETUP.md) has detailed provider setup, troubleshooting, migration-history repair and optional Play billing tests.

## 1. Install the Windows tools

- [Node.js 24.x](https://nodejs.org/en/download), including npm.
- [Android Studio](https://developer.android.com/studio), version 2025.2.1 or newer.
- In Android Studio SDK Manager: Android SDK Platform **36**, Platform-Tools and Command-line Tools. Accept the exact Build-Tools package requested by Gradle.
- In Android Studio's Gradle settings: select **JDK 21** (download through Studio if necessary).
- Use a physical Android 7.0+ phone; a recent device with Google Play services is preferable.

No separate Gradle, local PostgreSQL, Docker, Firebase CLI or message broker installation is needed for this route. [Capacitor requirements](https://capacitorjs.com/docs/getting-started/environment-setup).

**Check:** a new CMD window runs `node --version` and `npm --version` successfully.

## 2. Extract and install dependencies

Extract the ZIP into a short path, for example `C:\dev\rezerva-app`. Do not overwrite a different local project. Then:

```bat
cd /d C:\dev\rezerva-app
npm ci
copy .env.live.example .env
```

If you already have a configured `.env`, keep it and edit its values instead of copying over it. Turn on filename extensions in Explorer so you do not accidentally create `.env.txt`.

**Check:** `npm ci` succeeds and `.env` is alongside `package.json`, with `VITE_APP_MODE=live`.

## 3. Create Supabase and apply the four migrations

Create a separate development project in [Supabase](https://supabase.com/dashboard). Save the database password privately. In the project's **SQL Editor**, open and run each entire file from the ZIP, in this exact order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_plans_licenses_invitations.sql`
3. `supabase/migrations/003_verified_enrollment.sql`
4. `supabase/migrations/004_team_features.sql`

Wait for success before moving to the next file. These instructions assume a NEW project. On an existing database, back up first and apply only missing migrations. Do not rerun old migrations, delete tables, or disable RLS to suppress an error.

Do not expose the `private` schema through the Data API. Check in SQL Editor:

```sql
select to_regclass('public.bookings'),
       to_regclass('private.license_keys'),
       to_regclass('private.enrollment_requests');
select owner_email from private.platform_settings;
```

**Check:** the three relations exist and owner email is `davidnicolaparaschiv@gmail.com`. There are no seeded sample businesses in a new live database.

## 4. Enable real Google login

In [Google Cloud](https://console.cloud.google.com/), configure the OAuth consent screen and add David and your customer test account as test users. Create an OAuth client of type **Web application**. Its authorized redirect URI must be the exact Supabase Google-provider callback, normally:

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
```

Put the Google client ID and secret into **Supabase → Authentication → Google provider** and enable it. Put these URLs in **Supabase → Authentication → URL Configuration → Redirect URLs**:

```text
ro.rezerva.app://auth/callback
http://localhost:5173/
```

Use `http://localhost:5173/` as your development Site URL. The Google secret belongs in Supabase, not the APK. The Google redirect and Android redirect are different on purpose. [Google OAuth guide](https://supabase.com/docs/guides/auth/social-login/auth-google).

**Check:** Google provider is enabled, its credentials are saved, and the Android redirect is allowed.

## 5. Set up real email and SMS without a domain

Create your [Resend](https://resend.com/) account using **davidnicolaparaschiv@gmail.com** and create a sending API key. Use `Rezerva <onboarding@resend.dev>` as the sender.

Resend's test sender delivers ONLY to the email address associated with your Resend account. Use that same address as your business contact email. This allows real verification and admin approval emails to David, but not invitations delivered to other people. Do not try to verify `gmail.com` or `github.io`. [Resend restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

Create a [Twilio Verify](https://www.twilio.com/docs/verify) service with SMS enabled. Save Account SID (`AC...`), Auth Token and Verify Service SID (`VA...`). Allow Romania in Verify Geo Permissions. On a trial account, verify your own destination phone if required. Use provider spending limits and fraud protection. Real SMS may cost money.

You do not need a website, GitHub Pages or purchased domain. Leave `INVITE_WEB_URL` and `ENROLLMENT_WEB_URL` unset for now. Emails contain a direct Android link and a manual fallback code.

**Check:** you have the Resend key, the Twilio credentials, and a Romanian mobile you control. No credentials are pasted into chat or your frontend source.

## 6. Set up Firebase for push

Create a development project in [Firebase](https://console.firebase.google.com/). Register Android application **`ro.rezerva.app`** and save its downloaded client configuration at:

```text
C:\dev\rezerva-app\android\app\google-services.json
```

Enable Firebase Cloud Messaging HTTP v1 API. Create a dedicated Google Cloud service account permitted to send FCM messages (Firebase Cloud Messaging API Admin is an applicable role) and obtain its JSON private key. Keep that private JSON outside the app source; it will go into a Supabase secret.

If your organization forbids private service-account keys, stop and use an approved authentication approach; do not weaken the organization policy. No Firebase Authentication or Firestore database is needed. The existing Capacitor plugin already provides Android messaging dependencies; do not add duplicate native setup code.

**Check:** the Android client file is in `android/app`; the DIFFERENT service-account JSON is stored privately. See full guide Step 10 for links and details.

## 7. Put server secrets in Supabase

Open **Supabase → Edge Functions → Secrets**. Add:

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | Your Resend sending key |
| `INVITE_FROM_EMAIL` | `Rezerva <onboarding@resend.dev>` |
| `TWILLIO_ACCOUNT_SID` | Your `AC...` SID |
| `TWILLIO_AUTH_TOKEN` | Your Twilio Auth Token |
| `TWILIO_VERIFY_SERVICE_SID` | Your `VA...` SID |
| `FIREBASE_PROJECT_ID` | The Firebase project ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Entire valid private service-account JSON, not a filename |
| `CRON_SECRET` | A new long random value generated below |
| `ALLOWED_ORIGINS` | `https://localhost,http://localhost,http://localhost:5173` |

Generate your cron secret locally:

```bat
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep this value private. Hosted Supabase functions already receive their Supabase URL and service credentials. Do not put server secrets into root `.env` or any variable beginning `VITE_`. Leave the optional web landing URLs unset.

**Check:** every row above is configured in Supabase. The Firebase JSON is a JSON object with its original escaped key newlines, not an extra JSON-quoted string.

## 8. Deploy backend functions and record migration history

From the app root in CMD:

```bat
npm install --save-dev supabase
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

Replace `YOUR_PROJECT_REF`. Do not run `supabase init --force`; the project already includes function configuration. Since Step 3 applied SQL manually, record those exact successful migrations:

```bat
npx supabase migration repair 001 --status applied
npx supabase migration repair 002 --status applied
npx supabase migration repair 003 --status applied
npx supabase migration repair 004 --status applied
npx supabase migration list
```

Repair only records history. Never mark a failed or unapplied migration as applied. If you used the full guide's CLI `db push` method instead of manual SQL, skip repair; CLI already recorded it.

Deploy:

```bat
npx supabase functions deploy enrollment --use-api
npx supabase functions deploy send-calendar-invite --use-api
npx supabase functions deploy send-reminders --use-api
```

The `--use-api` option avoids needing Docker for this deployment. Function-level authentication in the source must stay intact. RevenueCat's two functions can wait until you set up Play billing.

**Check:** the three functions appear in your intended Supabase development project, and migration history lists 001, 002, 003 and 004.

## 9. Configure the Android app and install it

Edit root `.env`, not the example file:

```env
VITE_APP_MODE=live
VITE_ENABLE_LICENSE_REDEMPTION=true
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_CLIENT_KEY
VITE_AUTH_REDIRECT_URL=ro.rezerva.app://auth/callback
```

Copy your project's client publishable key or legacy anon key into `VITE_SUPABASE_ANON_KEY`. NEVER use a service-role or secret key. RevenueCat may stay blank while using the license route.

```bat
npm run check
npm run typecheck
npm test
npm run android:sync
npm run android:open
```

Do not run `android:add`: the folder already exists. Let Android Studio finish Gradle sync, selecting JDK 21. On your phone enable Developer options and USB debugging, connect a data-capable USB cable and accept the authorization prompt. Select your phone and the `app` configuration in Android Studio; click **Run**.

If the phone is not listed, check its USB driver/cable and Android Studio's device troubleshooting. The phone needs internet for real services, but no running laptop Vite server. Rebuild/sync and Run again after changing frontend `.env` values.

**Check:** Rezerva opens on your phone. Google login opens a real account chooser and creates a Google identity in Supabase Auth. Instant login as `andrei@demo.ro` means you installed a demo build.

## 10. Enroll and approve your test business

1. Choose **Reprezint o afacere** and sign in with **davidnicolaparaschiv@gmail.com**.
2. Choose **Înregistrează propria afacere** → **Am o cheie de licență** → enter **`dev112233`** → activate and continue.
3. Enter your test-business name, category, address and unique CUI-format value. In this isolated development DB use test data, not another company's identity. Enter **David's same Gmail as the contact email** and your real Romanian mobile number.
4. Submit the form and open the actual verification email. Confirm it while signed into the account that submitted the request.
5. Request the SMS and enter the real code received. `123456` is only for offline demo and is not a live bypass.
6. Request approval; open the approval email in David's inbox and approve while signed into that Google account.
7. Refresh enrollment status and continue. Create a calendar, service, duration and opening hours.

If your email client refuses the app link, copy the fallback code from the email into **Confirmă un link de înscriere**. If you switch accounts, reopen the link or paste it again; sign-out clears pending links. Do not edit DB verification flags manually.

**Check:** before final approval there is only a private pending request. After approval, `public.businesses` contains the business. `dev112233` grants this authorized account ten calendars; it does not bypass enrollment.

## 11. Schedule and test real reminders

The reminder queue is already `public.notification_jobs`. No separate message broker is required.

In Supabase enable **pg_cron** and **pg_net**, and make sure Vault is available. In Vault create:

- `rezerva_project_url`: your Supabase project URL, without a trailing slash.
- `rezerva_cron_secret`: EXACTLY the same value as your Edge Function's `CRON_SECRET`.

In SQL Editor, check no schedule named `rezerva-reminders` already exists:

```sql
select jobid, jobname, active from cron.job
where jobname = 'rezerva-reminders';
```

If none exists, run:

```sql
select cron.schedule('rezerva-reminders', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'rezerva_project_url')
           || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                        where name = 'rezerva_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$job$);
```

Keep just one schedule. Enable app notifications, grant the Android permission, and confirm `public.device_tokens` has a row for the phone's signed-in user. Do not publish its token.

Use another phone or browser session as a customer (add that Google account as an OAuth test user). Customers do not require Resend emails or a business subscription. Search for your approved business and create a future booking. Choose the reminder interval before booking; ensure its send time is still in the future. Refresh the business calendar to see the booking. Background the app on the intended notification device without force-stopping it.

**Check:** the booking is visible on both sides after refresh and a real push reaches the phone. Check Supabase function logs if not. A cron success or `sent` job is not proof of phone delivery. Current worker limitations are documented in the full guide.

## 12. Later: invitations to others and Play billing

Your own-account email test works without a domain. Email invitations to OTHER staff addresses require a verified sending domain or a different email integration. Do not route other people's verification messages to David to simulate ownership.

For Play billing, follow full guide Steps 19–21: products `rezerva_small_monthly` and `rezerva_large_monthly`, RevenueCat entitlement `business_pro`, a current Offering, server credentials/webhook, and a private Play internal-testing release with license testers. You do not need a public Play release. Confirm the checkout displays test payment methods.

Use a business account without an active license to test the one-calendar purchase limit. A free license would otherwise hide the billing result. Keep sandbox payment acceptance enabled only in the development database.

**Check:** do not claim staff email delivery or Google Play payments are tested until those real integrations pass. You can finish Steps 1–11 using your authorized license without setting up billing.

## What was verified in this archive

Source checks, JS type checks, 34 automated tests, Vite build and Android asset/plugin sync. The automated tests use a simulated DOM and in-memory PostgreSQL. Android compilation, phone rendering and all provider integrations must still be tested on your machine. No real messages were sent and no services were deployed during packaging.

See [docs/VERIFICATION.md](docs/VERIFICATION.md) for details. Keep credentials and signing keys private. The included policy links are placeholders and must be replaced before release.
