# Rezerva: live-service setup for an unpublished Android app on Windows

Start with [START-HERE.md](../START-HERE.md) for the shorter no-domain setup.

Applies to the current source ZIP. Instructions are in English; the app is Romanian. Each numbered step ends with a checkpoint. Small (€50, 1 calendar) excludes business reports/reminders; Complete (€150, 10 calendars) includes both. Complete/half_complete licenses grant 10/5 calendars. Customer reminders remain available. Apply every missing migration through 025 in numeric order.

Your target is **real cloud services with a privately installed Android app**, not simulated demo mode. Use `VITE_APP_MODE=live` and a separate development Supabase project. The word “live” in this code selects real integrations; it does not publish the app.

Google login, database, email, SMS and push can work with an APK installed from Android Studio. For Play Billing tests, this guide uses a private internal-testing release and license testers, not public distribution. If you want no Play upload yet, use your authorized license and stop before Step 19.

The requested reservation QR/check-in feature is **not implemented in this ZIP**. There is no QR migration or scanner setup yet.

## What you need

| Component | Role | Required for |
| --- | --- | --- |
| Node.js + Android Studio | Build/install the app on Windows | All testing |
| Supabase | PostgreSQL, authentication, server functions | Real accounts/bookings |
| Google OAuth client | Google sign-in through Supabase | Real login |
| Resend | Own-inbox enrollment/approval tests without a domain; verified domain for other recipients | Enrollment/team email |
| Twilio Verify | Phone verification SMS | Business enrollment |
| Firebase Cloud Messaging | App push notifications | Real reminders |
| Supabase Cron + pg_net + Vault | Run and authenticate the reminder worker | Scheduled reminders |
| RevenueCat + Play Console | Subscription verification and billing | Play payment tests only |

There is no RabbitMQ, Kafka, Redis, VPS, Express server or Kubernetes requirement. The booking reminder queue is `public.notification_jobs` in PostgreSQL. Google Play billing notifications later use managed Google Pub/Sub through RevenueCat; that is separate and requires no broker installed on Windows.

Provider calls are real and may cost money. Use your own test accounts/numbers and a dedicated development database. Do not disable authentication, verification or RLS to make a test pass.

## Set up in this order

### 1. Install the Windows tools

Install:

- **Node.js 24.x**, Windows installer, including npm and PATH integration. This source was checked with Node 24.19.0. [Official Node downloads](https://nodejs.org/en/download).
- **Android Studio 2025.2.1 or newer**. Use a stable release and keep the project's existing Gradle versions for your first build. [Android Studio](https://developer.android.com/studio).
- A text editor; VS Code is convenient but not required.
- Git for Windows is optional for version control; it is not required to open this ZIP.

Use **Command Prompt (CMD)** for commands below, not PowerShell, unless a block is explicitly labeled PowerShell. Open a new CMD after installing Node:

```bat
node --version
npm --version
```

Do not install Capacitor, Vite, TypeScript, Gradle, or Firebase CLI globally. The project supplies its JavaScript tools and Gradle wrapper. No Docker, local PostgreSQL, Python, or separate Deno installation is required for this route. Android Studio includes a JDK; this project's Java compile level is **21**. [Capacitor environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup).

**Checkpoint:** Node reports `v24...`, npm reports a version, and Android Studio opens.

### 2. Install Android SDK components

In Android Studio, open SDK Manager, either from the welcome screen's More Actions or Tools menu. Install:

- SDK Platform **Android 16 / API 36**, matching `android/variables.gradle`.
- Android SDK Platform-Tools, including ADB.
- Android SDK Build-Tools 35.0.0 if requested by the included Android Gradle Plugin; accept any additional exact component it requests.
- Android SDK Command-line Tools (latest).
- Your phone manufacturer's Windows ADB USB driver if Windows does not recognize the phone.

An emulator and system image are optional if you have a phone. The current project has `minSdkVersion=24`, so the phone must run Android 7.0 or newer; a recent Android phone with Google Play services is preferable for later notification/billing tests.

When the project is open, check Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK. Select **JDK 21**, downloading it there if the bundled JDK is a different major version. Do not accept an automatic AGP upgrade for the first run. The source specifies AGP 8.13.0 and Gradle 8.14.3. [Java configuration](https://developer.android.com/build/jdks), [Capacitor Android baseline](https://capacitorjs.com/docs/updating/8-0).

**Checkpoint:** API 36 and Platform-Tools are installed. JDK 21 is available for Gradle.

### 3. Extract the source and install project dependencies

Extract the ZIP so the folder containing `package.json` is:

```text
C:\dev\rezerva-app
```

Avoid a OneDrive-synced folder or a deeply nested path for this first build. In CMD:

```bat
cd /d C:\dev\rezerva-app
dir package.json
npm ci
```

Use `npm ci` to respect the included lockfile. Do not run `npm update` or `npm audit fix --force` as part of setup. If npm reports a dependency/download error, resolve that error before continuing.

**Checkpoint:** `npm ci` finishes successfully and the project has a `node_modules` folder.

### 4. Create Supabase and connect the CLI

Create a Supabase account and a development project, for example `rezerva-dev`, choosing an appropriate European region. Save the database password privately. Note the project reference, project URL, and client API key. Do not post passwords or service-role keys in chat.

In CMD, in the app root:

```bat
npm install --save-dev supabase
npx supabase --version
npx supabase login
npx supabase projects list
npx supabase link --project-ref YOUR_PROJECT_REF
```

Replace `YOUR_PROJECT_REF` with the actual reference. Supply the database password interactively if requested. Installing the CLI as a local dependency intentionally updates your package files; retain those changes. Do not run `supabase init --force`: this ZIP already has its function configuration. [Supabase CLI setup](https://supabase.com/docs/guides/local-development/cli/getting-started).

**Checkpoint:** The CLI is linked to your intended development project, not an unrelated or production database.

### 5. Apply database migrations in order

For a **new, empty development project**, use:

```bat
npx supabase migration list
npx supabase db push --dry-run
```

For a new database, the pending files must be these four, in this order:

| Migration | Purpose |
| --- | --- |
| `001_initial_schema.sql` | Core tables, booking logic, initial policies and extensions |
| `002_plans_licenses_invitations.sql` | Plans, private licenses, staff/calendar permissions and revised policies |
| `003_verified_enrollment.sql` | Email/SMS/admin enrollment and initial developer-key support |
| `004_team_features.sql` | Complete-only business reports and reminders; Small keeps calendar access |
| `005_reservation_qr.sql` | Signed reservation QR payloads and scoped check-in |
| `006_universal_developer_license.sql` | Universal developer key and neutral invalid-license responses |
| `007_approval_email_details.sql` | Complete business details in administrator approval emails |
| `008_owner_approval_codes.sql` | Code-only business confirmation/owner approval and 30-day superseding codes |
| `009_access_expiry_and_permanent_dev.sql` | Full business lock after expiry and permanent universal `dev112233` grants |
| `010_team_plan_and_member_limit.sql` | Small single-user enforcement; Complete-only Team flow and 15 accepted-member limit |
| `011_all_team_calendars_shared.sql` | Removes selective calendar assignments and shares all calendars with every accepted member |

If that matches the intended empty project:

```bat
npx supabase db push
npx supabase migration list
```

Do not expose the application after only migration 001; later migrations replace important permissions and operations. Do not edit these files to suppress errors or remove RLS.

For an existing database, back it up and inspect migration history first. If 001 and 002 are applied, apply 003 and 004. If 001–003 are applied, apply only 004. If all four are applied, do not rerun them. Migration 002 intentionally stops if more than one existing business is owned by the same account; resolve ownership deliberately without deleting history.

Alternative if you cannot use CLI database connectivity: paste each **entire** SQL file into Supabase SQL Editor and run 001, then 002, then 003, then 004, stopping on any error. Manual SQL does not automatically record CLI history. Only after independently confirming each complete migration succeeded, reconcile the history:

```bat
npx supabase migration repair 001 --status applied
npx supabase migration repair 002 --status applied
npx supabase migration repair 003 --status applied
npx supabase migration repair 004 --status applied
npx supabase migration list
```

Run repair only for versions actually applied manually. Repair records history; it does not execute missing SQL. Never use `db reset --linked` to fix a setup error. [Migration workflow](https://supabase.com/docs/guides/deployment/database-migrations), [CLI reference](https://supabase.com/docs/reference/cli/introduction).

In SQL Editor, as administrator, verify:

```sql
select to_regclass('public.bookings') as bookings,
       to_regclass('private.license_keys') as licenses,
       to_regclass('private.enrollment_requests') as enrollment;

select owner_email, owner_user_id, developer_bypass_enabled
from private.platform_settings;
```

The owner email must be `davidnicolaparaschiv@gmail.com`; a null owner UID before first valid developer redemption/approval is expected. Keep schema `private` out of the API's exposed schemas. It is deliberately not a public API.

**Checkpoint:** All three relations exist, migration history matches, and the fixed owner record exists. No sample businesses are seeded into your real database.

### 6. Configure Google login through Supabase

In Google Cloud / Google Auth Platform, create an OAuth consent configuration with app name and support contact. For testing, use an external testing audience and add David plus the Google accounts you will use for owner/customer/staff tests. Create an OAuth client of type **Web application**, because the current app uses browser-based Supabase OAuth, not native Google sign-in.

In Google, set the authorized redirect URI to the exact callback shown in Supabase's Google provider settings, normally:

```text
https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback
```

Paste Google's client ID and client secret into Supabase Authentication → Google provider and enable it. Do not put Google's client secret in Vite.

In Supabase Authentication → URL Configuration, add redirect URLs:

```text
ro.rezerva.app://auth/callback
http://localhost:5173/
```

For browser development, use `http://localhost:5173/` as the development Site URL. Use the exact browser origin if Vite uses another port. If Google's OAuth setup requests JavaScript origins, add the actual browser testing origin, without a path.

These are two different redirects: **Google → Supabase HTTPS callback**, then **Supabase → Android custom scheme or localhost**. Do not put the Android scheme into Google's Web-client redirect field. [Supabase Google OAuth guide](https://supabase.com/docs/guides/auth/social-login/auth-google).

**Checkpoint:** Google credentials are stored in Supabase, test users are allowed, and the Android redirect is allowlisted in Supabase.

### 7. Configure email delivery with Resend

**No domain for your first test:** create the Resend account with `davidnicolaparaschiv@gmail.com`, create an API key, and set `INVITE_FROM_EMAIL=Rezerva <onboarding@resend.dev>` in Supabase secrets. Use David's same Gmail as the business contact email, so both confirmation and administrator approval arrive in that permitted inbox. Leave the optional web landing URLs unset; direct Android links and fallback codes work without hosting. You do not need DNS setup for this test. Resend's test sender cannot deliver staff invitations to other addresses. [Resend test-domain restrictions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

The following domain procedure is **only for sending to other recipients later**:

Create a Resend account, add a sending domain or subdomain you control, and publish the exact DNS records Resend provides. Wait for verification, then create an API key with sending access. Use an address on that domain, for example `Rezerva <invitatii@your-domain.ro>`.

You cannot verify ownership of `gmail.com`; David's Gmail is the approval **recipient**, not the transactional sender. For the full multi-account enrollment/invitation test use a verified sending domain, not restricted provider test-sender behavior. No SMTP server or mail application needs installing on Windows. [Resend domain setup](https://resend.com/docs/dashboard/domains/introduction).

Keep for Step 9: `RESEND_API_KEY`, `INVITE_FROM_EMAIL`. Booking reminders remain push-only; this email setup is for enrollment, approval and invitations.

**Checkpoint:** you have the API key, and either the own-account test sender is selected or your own sending domain is verified. Other-recipient delivery is not tested by the single-inbox route.

### 8. Configure Twilio Verify for enrollment SMS

Create a Twilio account and a **Verify service**, with SMS enabled. Obtain the account SID (`AC...`), Auth Token and Verify Service SID (`VA...`). Enable Romania in Verify Geo Permissions, retain fraud protections, and configure usage alerts/limits. A Messaging Service SID is not a substitute for the Verify Service SID.

Trial accounts may restrict destinations; verify your own test phone in Twilio when required. Use a real phone you control, in the app's accepted `07xxxxxxxx` or `+407xxxxxxxx` format. The local demo OTP `123456` will not work against Twilio. [Twilio verification API](https://www.twilio.com/docs/verify/api/verification), [Verify geographic controls](https://www.twilio.com/docs/verify/preventing-toll-fraud/verify-geo-permissions).

This code uses Twilio Verify directly; do not also configure Supabase Phone Auth or invent an SMS broker. The database enforces additional request limits, but they do not replace provider spending controls.

**Checkpoint:** A Verify service exists, Romania is allowed, and your permitted test phone can receive SMS. Real SMS testing may cost money.

### 9. Store backend secrets and deploy enrollment/invitations

Use Supabase Dashboard → Edge Functions → Secrets. Add the values below there, not to the app's root `.env`:

| Secret | Value |
| --- | --- |
| `RESEND_API_KEY` | Resend sending API key |
| `INVITE_FROM_EMAIL` | `Rezerva <onboarding@resend.dev>` for your own Resend inbox, or a verified-domain sender |
| `TWILLIO_ACCOUNT_SID` | Twilio account SID — numele coincide exact cu secretul existent |
| `TWILLIO_AUTH_TOKEN` | Twilio Auth Token — numele coincide exact cu secretul existent |
| `TWILIO_VERIFY_SERVICE_SID` | Verify service SID — numele coincide exact cu secretul existent |
| `ALLOWED_ORIGINS` | `https://localhost,http://localhost,http://localhost:5173` |

If you use another browser port, add its exact origin with commas and no extra spaces. Optional `INVITE_WEB_URL` and `ENROLLMENT_WEB_URL` are explained in the optional HTTPS section. Leave unset until you have real hosted pages.

Hosted Supabase functions already receive their `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Do not copy the service-role key into the Android app.

Deploy from CMD:

```bat
npx supabase functions deploy enrollment --use-api
npx supabase functions deploy send-calendar-invite --use-api
npx supabase functions list
```

`--use-api` bundles on the server, so Docker is not needed for these deployments. `supabase/config.toml` supplies JavaScript entrypoints and `verify_jwt=false`. The code still checks the caller using `auth.getUser()`; do not remove that check. [Function deployment](https://supabase.com/docs/guides/functions/deploy).

Optional CLI secret upload: copy `supabase\.env.example` to `supabase\.env`, fill only configured values, and run `npx supabase secrets set --env-file supabase/.env`. Avoid uploading empty entries over existing secrets. Dashboard entry is simpler for multiline Firebase JSON later. Never prefix backend secrets with `VITE_`.

**Checkpoint:** Both functions appear in the development project's dashboard. Missing credentials, rejected email and SMS failures can be inspected in their logs without logging secret values.

### 10. Configure Firebase on Android and on the server

Create a Firebase development project (you may use the same underlying Google Cloud project as OAuth). Add an Android app with exact package **`ro.rezerva.app`**. Download its client configuration to:

```text
C:\dev\rezerva-app\android\app\google-services.json
```

The Capacitor push plugin and conditional Gradle setup are already included; do not duplicate Firebase dependencies by following a native tutorial literally. No Firebase Authentication or Firestore database is needed. [Firebase Android messaging setup](https://firebase.google.com/docs/cloud-messaging/android/get-started).

Enable Firebase Cloud Messaging API / HTTP v1. For the Supabase sender, create a dedicated Google Cloud service account with permission to send FCM messages in that Firebase project, such as **Firebase Cloud Messaging API Admin**, rather than project Owner. Generate its JSON private key and store it securely outside your source folder. If your organization blocks service-account keys, do not bypass the policy: this sender needs an approved authentication alternative before use. [FCM server authentication](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [Firebase IAM roles](https://firebase.google.com/docs/projects/iam/roles-predefined-product).

In Supabase function secrets set:

| Secret | Value |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Firebase project ID, not app ID or project number |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Entire valid service-account JSON object |
| `CRON_SECRET` | A new random secret, generated below |

Generate the cron secret locally in CMD:

```bat
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The service-account private JSON and Android `google-services.json` are different files. Only the Android client file belongs in `android/app`. Paste the service-account JSON directly into the Supabase secret field; preserve JSON escapes in `private_key`, without adding an extra quoted wrapper.

```bat
npx supabase functions deploy send-reminders --use-api
```

After the installation steps below, enable notifications in the app and grant Android notification permission. Use a physical device with Google Play services. [Capacitor push plugin](https://capacitorjs.com/docs/apis/push-notifications).

**Checkpoint:** Firebase client configuration is in the Android project, server secrets are set, and `send-reminders` is deployed. After phone installation and login, also verify a row for that user in `public.device_tokens`; do not publish its token.

### 11. Schedule the reminder worker — no separate broker

In Supabase's database integrations/extensions, enable **pg_cron** and **pg_net**; ensure Vault is available. Through the Vault UI, create two secrets:

- `rezerva_project_url`: your `https://YOUR_PROJECT_REF.supabase.co` URL, without a trailing slash.
- `rezerva_cron_secret`: exactly the same random value as the Edge Function's `CRON_SECRET`.

Check that you have not already scheduled this job:

```sql
select jobid, jobname, schedule, active
from cron.job where jobname = 'rezerva-reminders';
```

If there is no existing job, run in SQL Editor:

```sql
select cron.schedule(
  'rezerva-reminders',
  '* * * * *',
  $job$
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
  $job$
);
```

This endpoint uses its own `x-cron-secret` check, not a URL token or public API key as authentication. Keep one schedule, not several copies. The job uses the server clock and runs every minute while the project is running. [Supabase scheduling pattern](https://supabase.com/docs/guides/functions/schedule-functions).

For diagnosis, inspect both scheduling and HTTP results:

```sql
select jobid, status, return_message, start_time
from cron.job_run_details order by start_time desc limit 10;

select id, status_code, timed_out, error_msg
from net._http_response order by created desc limit 10;

select id, send_at, status, attempts, last_error
from public.notification_jobs order by created_at desc limit 20;
```

A successful cron SQL invocation does not by itself prove the HTTP request or phone delivery succeeded. Check function logs too. To pause this exact job later, use `select cron.unschedule('rezerva-reminders');`; this removes its schedule, not bookings or queued jobs.

**Checkpoint:** The schedule exists once, HTTP calls succeed, and due jobs are processed without authentication errors.

### 12. Switch the app to the connected development project

If root `.env` does not exist, run `copy .env.live.example .env` in CMD. Do not overwrite an existing configuration. Edit it to contain:

```env
VITE_APP_MODE=live
VITE_ENABLE_LICENSE_REDEMPTION=true
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_CLIENT_API_KEY
VITE_AUTH_REDIRECT_URL=ro.rezerva.app://auth/callback
```

Use a Supabase client publishable key (or the existing legacy anon key); this variable keeps its original name. Never use an `sb_secret_...` or service-role key. RevenueCat can remain unconfigured if you take the license path and do not test payment screens yet.

If you previously used demo, sign out before installing the live build. The following steps compile and install your configuration. `.env` changes are compiled into the APK; an already installed APK does not read your Windows `.env` at runtime. Restart Vite too when changing configuration for browser testing.

After installing in Step 16, sign in with a permitted real Google account. Check Supabase Authentication → Users. An empty customer search list is expected until you approve a business.

**Checkpoint:** Root `.env` says `live`, points to the correct development Supabase project, and contains only client-safe keys. You will verify actual login after installation.

### 13. Validate the source before building

Run from the project root:

```bat
npm run check
npm run typecheck
npm test
```

The TypeScript package checks JavaScript only; you are not writing TypeScript application files. Database tests use in-memory PostgreSQL via PGlite, so no local database is needed.

**Checkpoint:** All commands succeed; the current suite reports 34 passing tests. These are local checks, not proof of external service integration.

### 14. Generate the web bundle and open Android Studio

From the project root:

```bat
npm run android:sync
npm run android:open
```

The first command runs the web build and copies it into Android. The second opens the included `android` project. If automatic opening fails, use Android Studio → Open → `C:\dev\rezerva-app\android`.

Do **not** run `npm run android:add`: the Android project already exists. Wait for Gradle sync and dependency downloads. For your live push test, confirm that the real Firebase `google-services.json` from the earlier step is present. Do not create a fake file.

**Checkpoint:** Android Studio finishes Gradle sync without errors and shows the `app` run configuration. `android:sync` alone is not proof that Android compilation succeeded.

### 15. Connect your Android phone

On the phone, enable Developer options (usually tap Build number seven times), then enable USB debugging. Connect using a data-capable USB cable, unlock the phone, and accept its debugging authorization prompt. Only authorize your own trusted computer.

In Android Studio select the phone in the device selector. If it is missing, check the cable, USB mode, and OEM driver. Use Tools → Troubleshoot Device Connections. [Official hardware-device setup](https://developer.android.com/studio/run/device).

Optional CMD check, if the SDK is at its usual Windows location:

```bat
"%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" devices
```

If your SDK is elsewhere, use the actual SDK Manager path. `unauthorized` means you still need to accept the phone prompt.

**Checkpoint:** Android Studio lists your phone as an available device, or ADB lists its serial with status `device`.

### 16. Install and launch the live-service app

Select run configuration `app`, select your phone, and click the green Run button. Let Android Studio build, install, and open Rezerva.

Once installed, the bundled app does not need the laptop's Vite server or a same-Wi-Fi connection. The phone does need internet access to reach your real services. No Play Console account is required for this USB-installed debug build.

If you want a transferable debug APK, use Android Studio's Build APK(s) action; menu wording varies by version. The usual result is `android\app\build\outputs\apk\debug\app-debug.apk`. This is not a production-signed release or a Play-upload artifact.

**Checkpoint:** Rezerva opens on the physical phone and still opens after disconnecting USB.

Sign in through the real Google account chooser. Check Supabase Authentication → Users for the corresponding Google identity. If the app instantly logs in as `andrei@demo.ro`, you installed a demo build: check `.env` and rebuild before continuing.

### 17. Complete real enrollment, then create a real booking

For your simplest developer test, sign in with an authorized verified Google account, choose the license route and enter `dev112233`. The live server grants Complete access with ten calendars. The key does not bypass enrollment or create a business by itself; administrator approval remains restricted separately.

Complete the business form with test business details, a unique CUI-format value in this isolated development project, your real contact email and a mobile number you control. Do not impersonate a real business. The app checks CUI format, not ANAF ownership.

1. Open the contact-email link on the phone, signed into the account that submitted the request; explicitly confirm it.
2. Request SMS and submit the actual Twilio code.
3. Request administrator approval.
4. Open the approval email addressed to David and approve while signed into David's Google account.
5. Return to the applicant account if different, refresh the status, and proceed to subscription/license and initial calendar setup.

If the email app will not open a custom-scheme link, copy the fallback token from the email into **Confirmă un link de înscriere**. After switching accounts, reopen the original link or paste its code; sign-out clears in-memory pending links.

Before final approval, only a private pending application should exist. After approval, inspect `public.businesses` in Supabase. Use the app to create service/availability rather than manually inserting booking data.

For another business owner's free development access, generate a normal email-bound license in CMD:

```bat
node tools\generate-license.mjs --email owner@example.com --start "2026-09-01T00:00:00+03:00" --months 1 --type Complete
```

Replace the email and start with your actual tester and intended date. A future start grants no early access. Paste only the generator's SQL block into Supabase SQL Editor; it stores the hash, email and period, not the plaintext key. Give the tester the key privately. Enrollment verification still applies.

On another device or browser session, sign in as a customer, find the approved business, and book a slot. Refresh the business calendar on the first device. Once you have a verified sending domain, invite a separate staff Google account and verify that all existing calendars are visible automatically. Add another calendar and verify it also appears without another assignment step. Resend's single-inbox test sender does not support delivery to that other address.

**Checkpoint:** A booking created by a real customer appears in `public.bookings` and in the authorized business calendar after refresh. This is the first genuine multi-user demonstration.

### 18. Test a booking reminder on your phone

First confirm a `public.device_tokens` row exists for the signed-in phone. Enable push and choose the reminder preference **before creating a new booking**. Choose a future appointment whose reminder time is still in the future. Confirm the associated job's `send_at`, then leave the app in the background and keep the phone connected to the internet. Do not force-stop it through Android Settings.

Check receipt on the intended customer and authorized staff phones. No booking email should be sent. Do not expect exact-second delivery.

Known limits in this source: reminder preference changes do not reschedule existing jobs; there is no automatic recovery of jobs stuck in `processing`; a job can be marked `sent` when the user has no device tokens, and provider acceptance is not proof of visible delivery. Register tokens before testing, and use logs plus the actual phone as evidence. These require hardening before production.

**Checkpoint:** A real reminder appears in Android notifications, not merely as a successful UI toggle or a `sent` row.

### 19. Configure Google Play and RevenueCat

Skip this stage if a license-based development test is enough. Play account registration/verification and real provider usage can incur costs; this guide does not promise an entirely free connected environment.

1. Create a Play Console developer account, complete its required verification, and create the app for package `ro.rezerva.app`.
2. In Android Studio, generate a signed Android App Bundle for internal testing. Save the upload keystore/password outside the repo and back them up securely. Increment `versionCode` in `android/app/build.gradle` on subsequent Play uploads. Never upload a demo-mode build as a production release.
3. Upload the bundle to the app's internal test track and complete the console's required setup. Add testers and share its opt-in link.
4. Create and activate the two subscription products below, each with a monthly auto-renewing base plan. Configure country availability and actual store prices. The APK's demo price constants do not set Play prices.

| Product ID (must match code) | Example base plan ID | Access |
| --- | --- | --- |
| `rezerva_small_monthly` | `monthly` | 1 calendar, intended €50/month |
| `rezerva_large_monthly` | `monthly` | 10 calendars, intended €150/month |

5. Create a RevenueCat project and its Google Play app for the same package. Follow its Google service-account setup: enable the required Google APIs, grant that service account the documented Play permissions for your app, and provide its JSON credential to RevenueCat. This is a separate credential from your FCM sender. Wait for RevenueCat's credential validation. [Play service credentials](https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials).
6. Import both base-plan products into RevenueCat (they may appear as `subscription_id:base_plan_id`). Attach both to entitlement **`business_pro`**. Create a current/default Offering with two distinct packages, e.g. custom package identifiers `small_monthly` and `large_monthly`, each containing its matching product. [Product configuration](https://www.revenuecat.com/docs/getting-started/entitlements/android-products).
7. Set RevenueCat restore behavior to keep purchases with the original app account, not freely transfer between users. The app identifies RevenueCat customers by Supabase UUID.
8. Configure Google's Real-Time Developer Notifications using RevenueCat's server-notification setup. Use its generated/selected Google Pub/Sub topic and configure that topic in Play Console, then send a test notification. Do not point raw Google Pub/Sub payloads at this app's `revenuecat-webhook`: it expects RevenueCat events. No local message broker is needed. [RevenueCat RTDN setup](https://www.revenuecat.com/docs/platform-resources/server-notifications/google-server-notifications).

**Checkpoint:** RevenueCat validates Play credentials, the Offering contains both products, and the Google server-notification test is received.

### 20. Connect RevenueCat to the app and Supabase

Root `.env`:

```env
VITE_REVENUECAT_GOOGLE_API_KEY=YOUR_PUBLIC_ANDROID_SDK_KEY
VITE_REVENUECAT_ENTITLEMENT_ID=business_pro
```

Supabase Edge Function secrets:

```text
REVENUECAT_SECRET_API_KEY = server API key usable with the v1 subscriber endpoint
REVENUECAT_ENTITLEMENT_ID = business_pro
REVENUECAT_WEBHOOK_AUTH = a new long random authorization value
```

Generate a separate webhook secret, not the cron secret. In RevenueCat configure a webhook to:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/revenuecat-webhook
```

Its Authorization header must exactly equal `REVENUECAT_WEBHOOK_AUTH`. If you choose a `Bearer ` prefix, include it identically on both sides.

Deploy:

```bat
npx supabase functions deploy sync-subscription --use-api
npx supabase functions deploy revenuecat-webhook --use-api
```

In the **development Supabase project only**, allow sandbox purchases to grant access:

```sql
update private.server_settings
set allow_sandbox_payments = true where singleton;
```

This is not an app payment-skip flag: an actual verified sandbox purchase is still required. Keep this setting false in production. Rebuild/sync, generate the updated signed bundle and upload a new internal-test version.

**Checkpoint:** RevenueCat's test webhook receives success. Both functions exist and the installed test APK contains your public Android SDK key, never the server secret.

### 21. Test purchases without confusing them with licenses

Add your purchase tester as both an internal-track tester and a **license tester** in Play Console. Install through the Play opt-in link using that account. Being an internal tester alone is not proof a purchase is free; confirm the purchase sheet explicitly shows a test payment method before proceeding. [Google Play sandbox testing](https://www.revenuecat.com/docs/test-and-launch/sandbox/google-play-store).

Use an approved business owner account without an active free license/developer grant, or those grants may mask the result. The account installing from Play and the intended billing tester must be configured correctly; the in-app Google account is separately the Supabase owner.

Test the 1-calendar purchase, rejection of a second active calendar, upgrade to 10, restore on the same owner account, cancellation, accelerated test renewal/expiry, and downgrade. If several calendars exist after downgrade, archive extras rather than deleting history. Test another account cannot take over the subscription.

**Checkpoint:** RevenueCat, `public.subscriptions`, and the app agree on the product, sandbox environment, expiration and access. A Play success dialog alone is not sufficient.

## Optional HTTPS email-link pages

The app includes `public/invite.html`, `invite.js`, `verify.html`, `verify.js` and `invite.css`. Host these together on a domain you control over HTTPS, then set server secrets `INVITE_WEB_URL=https://your-domain.ro/invite.html` and `ENROLLMENT_WEB_URL=https://your-domain.ro/verify.html`. These are fallback pages for opening the installed app; hosting them does not deploy the backend.

The current app handles Android custom-scheme links. Verified HTTPS Android App Links additionally require matching manifest intent filters and the domain's `.well-known/assetlinks.json` with your signing certificate. A domain/config value alone does not add that feature. Reservation QR links are still pending implementation. [Android link verification](https://developer.android.com/training/app-links/verify-applinks).

## Daily development workflow

For JS/CSS changes: edit → `npm run check` → `npm run typecheck` → `npm test` → `npm run android:sync` → Run in Android Studio. Browser-only iteration can use `npm run dev`.

| Change | Required action |
| --- | --- |
| Root `.env`, frontend JS/CSS | Restart Vite; rebuild/sync and reinstall Android |
| `google-services.json`, native Android files | Build/reinstall Android; sync if needed |
| Supabase function source | Deploy that function again |
| Supabase secret | Update server secret; verify the next function invocation |
| Database schema | Add a new migration; inspect dry run, apply once, verify |
| Play product/RevenueCat Offering | Update dashboards, allow propagation, test real store response |

Keep `.env`, backend secrets, private JSON credentials and signing keys out of source control. The project ignores its known secret paths, but arbitrary downloaded credential filenames are not automatically protected. Never paste them into chat or place them in `public/`.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| `npm` not recognized | Reopen CMD; check Node installation/PATH |
| PowerShell says `npm.ps1` is blocked | Use CMD or `npm.cmd`; do not weaken system policy unnecessarily |
| `package.json` missing | You are not in the extracted project root |
| Java `invalid source release: 21` | Set Android Studio's Gradle JDK to 21 |
| SDK location/API 36 missing | SDK Manager; open the `android` folder, not a new project |
| Gradle cannot download | Check network/proxy access to Google Maven, Maven Central and Gradle; do not disable TLS verification |
| Phone missing/unauthorized | Unlock, accept prompt, check data cable and OEM driver |
| App still shows demo after changing `.env` | Rebuild/sync and run the newly built app; restart Vite |
| Blank screen | Android Studio Logcat; browser WebView inspection via Chrome `chrome://inspect`; verify build output |
| Google `redirect_uri_mismatch` | Google callback must be Supabase's HTTPS callback, not Android scheme |
| Login works but enrollment fails | All four migrations, deployed `enrollment`, Resend/Twilio secrets and function logs |
| Business not in search | Pending approval or inactive; check `public.businesses` after final approval |
| `dev112233` rejected | Verified Google account, developer grant enabled, migration 006 applied, and rate limit not exceeded |
| Permission denied / RLS error | Check identity, migrations and membership; do not disable RLS to make it pass |
| License inactive | Correct Google email, start already reached, not expired/revoked |
| Invitation opens wrong account | Sign in with exact invited Google email and reopen/paste original token |
| No push token | Live native build, correct Firebase client file/project, Android permission, Google Play services |
| Jobs remain pending | Scheduler active, due `send_at`, endpoint response, matching cron secret |
| Jobs processing/failed | Function logs, valid FCM credentials; current worker has no automatic stuck-job recovery |
| No store products | Active base plans, availability, correct package/key/current Offering and Play-installed tester build |

## Verification status and remaining work

Rechecked on 27 August 2026: ESLint, JavaScript type-checking, all 34 automated tests, and the Vite build pass. Tests use PGlite and a simulated DOM. They are not native-device or live-provider tests.

The APK has not been compiled/run on a phone in this environment. No Supabase project has been deployed and no real email, SMS, push or purchase has been sent during this setup-guide task. You must complete the checkpoints on your own machine/accounts.

This is a development skeleton, not a production-ready audited service. Remaining work includes the QR/check-in feature; full availability/service editing and complex rescheduling; notification recovery/monitoring; subscription reconciliation; real support/privacy/account-deletion workflows; and end-to-end permission/security/load testing. The placeholder `example.com` policy links must not be presented as real policies.

For the requested unpublished live-service test: **install Windows tools; configure the real development services; build in live mode; verify enrollment and a shared booking; verify push; then privately test Play payments if required.** Do not switch to demo to claim an external integration works.
