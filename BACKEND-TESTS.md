# Backend integration tests — Git Bash guide

This guide belongs to the current Rezerva project. The Android project, app configuration and Firebase client file remain unchanged by backend test execution.

All new code is JavaScript (`.mjs`, `// @ts-check`), without a UI framework or TypeScript source. The existing `typecheck` command checks `src/`; the new test runner is validated by ESLint and executable tests, not by that frontend typecheck.

## 1. What you can test

| Area | Automated coverage | What still needs you |
| --- | --- | --- |
| Supabase | Auth configuration, REST, deployed-function authorization, RLS, RPCs, migrations through 025, logger retention configuration and cron jobs | Configure your development project and apply only missing migrations |
| Google login | Verify real Google-backed Supabase sessions and role/email matching | Sign in once per test account; renew expired sessions |
| Plans and licenses | Small: 1 calendar; Complete: 10 calendars; Complete/half_complete licenses: 10/5 calendars with Complete features; expiry, binding, revocation and limits | These DB fixtures are rolled back; they do not prove Google Play checkout |
| Booking | Real hosted RPCs, **two concurrent requests for one slot**, customer identity, visibility, report gate, cancellation | Existing test business/calendar/service with availability |
| Business enrollment | Real email link, real SMS code, fixed administrator approval, business appears only after approval | Read the email/SMS; approval requires the fixed administrator account |
| Invitations | Real email through deployed backend, account-bound acceptance, single use, calendar scope | Read the invitation email and use a separate Google test account |
| Resend | Domain status, real email acceptance and provider-reported delivery | Inbox placement; completing domain setup if still unfinished |
| Twilio Verify | Read service, request a real Romanian verification SMS, check its real code | Receive and enter the code; trial/region restrictions may apply |
| Firebase / FCM | Private credential, validate-only request, real push, worker processing and scheduled job | Register your phone token and check actual phone receipt |
| RevenueCat | Real sandbox subscriber sync, persisted plan, replayed webhook using authoritative provider state | First make a real Play test purchase; checkout is not backend-only |
| Failure paths | Offline tests of actual adapters: denied access, email failure, wrong SMS proof, FCM retries, billing outage, unsupported store, expiry, forged/replayed payloads | Mocks verify code behavior, not your deployed credentials |

There is **no separate message broker to install**. This archive uses PostgreSQL `notification_jobs`, Supabase Cron/pg_net/Vault, an Edge Function, and FCM. Tests do not add Redis, RabbitMQ, Docker or another backend service.

The uploaded archive has no implemented QR validation backend endpoint. This suite does not invent one or claim to test QR check-in. Camera scanning, Android deep links, notification display and Google Play checkout remain device tests.

## 2. Install and run the offline backend tests first

On Windows, install **Node.js 24 LTS** and **Git for Windows**. Restart Git Bash after installing. Docker, Deno, Android Studio and Supabase CLI login are **not required to run this test suite**. Android Studio is still needed to build/install your phone app.

Extract the ZIP. Open Git Bash in the innermost folder containing `package.json` (the original ZIP has two `rezerva-app` folders):

```bash
cd /c/Users/YOUR_NAME/Downloads/rezerva-app/rezerva-app
node --version
npm --version
npm ci
npm run test:backend:local
```

Use your actual extraction path. `node --version` should show `v24...` or a compatible newer version. `npm ci` downloads the locked dependencies; subsequent offline tests need no network.

`test:backend:local` runs **only backend** tests, including PostgreSQL-in-memory migration/permission tests and mocked provider adapters. It sends nothing and loads no live credentials. Existing `npm test` remains offline, but also includes the original UI tests.

## 3. Create the separate live-test configuration

```bash
npm run test:backend:setup
notepad.exe .env.backend.local
```

The setup command creates the file once, without overwriting it. It copies only the public Supabase URL/client key from your existing app `.env`, if present. It does not enable live tests or copy backend secrets.

Review/set:

```dotenv
BACKEND_TEST_ENABLED=true
BACKEND_TEST_ENVIRONMENT=development
SUPABASE_URL=https://YOUR_20_CHARACTER_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY
BACKEND_TEST_PROJECT_REF=YOUR_20_CHARACTER_PROJECT_REF
```

Replace placeholders. The URL and project reference must match exactly. Use your **unpublished development Supabase project with only test data**. The `development` label is a safety acknowledgement, not automatic proof that a project contains no real users. Never point this suite at a production project.

Use the Supabase API URL here, **not** `https://rezervari-ai.com`. Your custom domain is still used for the sender/link configuration in your application. It does not replace Supabase's API host.

Use a publishable key or legacy **anon** key, not a service-role/secret key. Supabase Dashboard → project → Connect/API settings contains the URL and client keys. No `npx supabase login` is needed by these tests.

**Do not `source .env.backend.local` in Bash.** Node reads it as data. Never put private values in `VITE_...`, the APK, Git, chat messages or command-line arguments. Quotes are helpful for paths, passwords containing `#`, and sender names.

## 4. First live check — no messages or application-record writes

```bash
npm run test:backend
```

This checks hosted Supabase Auth/REST and function authorization. Optional providers are checked only when configured. Firebase authentication can issue a temporary OAuth token; FCM validation does not deliver a notification. Google-login helpers may create test Auth users on their first login and are a separate command.

Output uses **PASS / FAIL / SKIP**. A skipped integration is **not tested**, not successful. The sanitized report is saved to `.backend-test-results/latest.json` and replaced on the next run. Exit codes: `0` no failures (possibly skips); `1` failure; `2` skips with `--strict`.

```bash
npm run test:backend -- check --strict
```

The broad check deliberately reports billing as skipped because it requires a separate opted-in sandbox workflow. Therefore its strict mode reports incomplete coverage even if all read-only checks pass. Strict mode is especially useful on a targeted command that should be fully configured.

The suite does not apply migrations, deploy functions, change service settings or modify DNS. A missing service should produce a failure/skip, not be silently provisioned.

## 5. Test the real database with automatic rollback

In Supabase **Connect**, choose the **Session pooler**, port **5432**, which is normally easier from an IPv4 Windows connection than the direct host. Copy its PostgreSQL URI into this setting:

```dotenv
BACKEND_TEST_DATABASE_URL="postgresql://postgres.YOUR_PROJECT_REF:ENCODED_PASSWORD@YOUR_SESSION_POOLER_HOST:5432/postgres"
```

Use the actual host shown by Supabase. Replace the database password and URL-encode special password characters. This is the database password, not a Supabase access token or anon key. Direct `db.YOUR_PROJECT_REF.supabase.co:5432` with user `postgres` is also supported. Port `6543` transaction pooling is intentionally refused.

TLS certificate validation stays enabled. If your project requires its CA certificate, download the certificate from its database connection/SSL settings and set:

```dotenv
BACKEND_TEST_DB_CA_FILE="C:/Users/YOUR_NAME/private/supabase-ca.crt"
```

Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable SSL verification. The runner removes URL options that could weaken TLS.

Then:

```bash
npm run test:backend:db -- --allow-db-writes
```

This uses your **real development PostgreSQL database**, inserts uniquely named synthetic Auth/Google identities, businesses, licenses, calendars and bookings in **one uncommitted transaction**, switches to actual database roles to check permissions, then **rolls everything back**, including on assertion failure. Fixtures never become visible to the reminder worker. It does not create real Google accounts, send messages or create purchases. Existing user/business records are not selected as mutation targets.

These tests exercise schema functions and RLS, not a real OAuth exchange. The separate authenticated HTTP workflows below check deployed API integration.

To run read-only service checks plus the rollback DB suite together:

```bash
npm run test:backend:all -- --allow-db-writes
```

`all` means these two safe categories, **not** sending every message or testing Play purchases. Sending costs and human verification steps cannot safely be bundled into an unattended default.

### Migration history

The current schema ends with migration `025_complete_calendars_and_license_types.sql`. The read-only check expects successfully applied versions 001–025, verifies RLS on the logging tables, requires `config_purge.retention_days = 13` and checks both scheduled jobs.

If you ran SQL manually earlier, missing history does not necessarily mean the tables are missing. Confirm each complete SQL file really succeeded before using the existing guide's `migration repair --status applied` procedure for that version. Do not rerun every SQL file blindly. The tests will not repair history for you.

## 6. Configure providers you want to test

Fill only the relevant fields in `.env.backend.local`:

| Settings | Where to get them / purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend sending key; same sending configuration as the development backend |
| `INVITE_FROM_EMAIL` | `"Rezervari.ai <support@rezervari-ai.com>"`; domain must be verified in Resend |
| `RESEND_READ_API_KEY`, `RESEND_DOMAIN_ID` | Optional local inspection key with read access, and domain ID; a sending-only key cannot inspect domains/emails |
| `TWILLIO_ACCOUNT_SID`, `TWILLIO_AUTH_TOKEN` | Your Twilio development account credentials; names match Supabase exactly |
| `TWILIO_VERIFY_SERVICE_SID` | Twilio Verify service SID beginning `VA`; name matches Supabase exactly |
| `FIREBASE_PROJECT_ID` | Firebase project ID, matching your backend and Android app |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | Path to the private service-account JSON, e.g. `"C:/Users/YOUR_NAME/private/firebase.json"` |
| `TEST_FCM_TOKEN` | Actual registration token from your installed Android app; see below |
| `CRON_SECRET` | Same value as the deployed worker and Vault `rezerva_cron_secret` |

**Firebase's private service-account JSON is not `android/app/google-services.json`.** Keep the private file outside the repository. Google must allow its service account to send FCM messages. If your organization blocks service-account keys, do not bypass that restriction; leave this check unconfigured until an approved credential method is added.

The optional Resend inspection key stays local. Do not expand the deployed sender key's permissions just to make an inspection test pass. Missing/insufficient permissions are reported honestly.

To obtain an FCM token: install your debug app, sign in as the test customer, grant notification permission, and let the app register its token. In Supabase Table Editor → `device_tokens`, find that customer's UUID and copy the token privately into `TEST_FCM_TOKEN`. Tokens can change after reinstalling or clearing app data. Do not copy a real customer's token.

Run `npm run test:backend` again. Direct provider checks validate **local** credentials; deployed workflows validate what the Edge Functions actually use. A local provider PASS does not prove that you configured identical server secrets.

## 7. Optional: send one real email, SMS or push

Use only inboxes, numbers and devices you control. Sends/checks may incur provider charges. No sends run by default, and send failures are not automatically retried.

```dotenv
TEST_EMAIL_TO=YOUR_CONTROLLED_INBOX
TEST_PHONE_TO=+407XXXXXXXX
TEST_DEVICE_OWNED=true
```

The SMS test accepts one Romanian mobile number in `+407...` format. With a trial Twilio account, verify the destination in Twilio and ensure Romania is allowed for Verify. Do not disable fraud protections to force a test through.

Email:

```bash
npm run test:backend -- email --allow-messages
npm run test:backend -- email-status
```

The second command needs `RESEND_READ_API_KEY`. If it runs before delivery is recorded, it fails; wait and rerun only `email-status`. The first command reuses a saved idempotency key on retries. Do not change its sender/recipient between retries. Resend acceptance is not inbox delivery; provider-reported delivery is still not proof of inbox placement.

SMS:

```bash
npm run test:backend -- sms-send --allow-messages
notepad.exe .env.backend.local
```

Set `TEST_SMS_CODE` to the real code you just received, save, then:

```bash
npm run test:backend -- sms-check --allow-messages
```

These direct provider commands **do not enroll a business**. They test Twilio independently. Avoid sending another SMS while expecting to use an earlier code.

Push:

```bash
npm run test:backend -- push --allow-messages
```

This asks FCM to send one test notification. Check your phone, including background/permission behavior. FCM acceptance alone cannot prove the phone displayed it. No email reminders are added to the application.

## 8. Real Google test accounts for authenticated backend workflows

Use separate accounts you control for owner, customer and staff. The platform approval account remains `davidnicolaparaschiv@gmail.com`; this update does not change it in the database.

```dotenv
TEST_OWNER_EMAIL=YOUR_OWNER_GOOGLE_EMAIL
TEST_CUSTOMER_EMAIL=YOUR_CUSTOMER_GOOGLE_EMAIL
TEST_STAFF_EMAIL=YOUR_STAFF_GOOGLE_EMAIL
TEST_ADMIN_EMAIL=davidnicolaparaschiv@gmail.com
```

For enrollment testing, the owner account must not already own a business or have another pending application. Do not delete an existing business to satisfy this test; use a fresh account, or skip enrollment and test your existing test business.

Two choices:

1. **Optional login helper:** In Supabase Authentication → URL Configuration → Redirect URLs, add exactly `http://127.0.0.1:43821/auth/callback`. Keep your existing Android redirects. Google OAuth must already work for these accounts; if Google is in testing mode, allowlist them there too. Run:

   ```bash
   npm run test:backend:login -- owner
   npm run test:backend:login -- customer
   npm run test:backend:login -- staff
   npm run test:backend:login -- admin
   ```

   Run each separately, opening the printed URL and completing login before the next command. This opens only Google's login flow plus a local callback, **not your app in a browser**. The CLI verifies the returned Google identity against the configured email. First login can create that test Auth user. Only short-lived Supabase access tokens are saved in `.backend-test-sessions.json`; refresh tokens are not persisted.

2. **No browser helper:** Privately supply each account's current **Supabase access token** from your installed app/debug session in `TEST_OWNER_ACCESS_TOKEN`, `TEST_CUSTOMER_ACCESS_TOKEN`, etc. These are not Google ID tokens, anon keys or service-role tokens. Do not add public token logging to the app. Leave unused roles blank.

Tokens expire. If a command says the session is expired, log in again. Explicit access-token fields take precedence over saved sessions; clear a stale field if you want the helper's new session used.

## 9. Full enrollment through deployed services

Requires deployed `enrollment`, working Resend/Twilio server secrets, the owner session and the administrator session for final approval. Configure `TEST_EMAIL_TO`, `TEST_PHONE_TO` and `TEST_ENROLLMENT_CUI` (a unique valid-format test identifier, not another company's real CUI). No CUI registry verification is claimed.

1. Create the private test application and request its email:

   ```bash
   npm run test:backend -- enrollment-start --allow-writes --allow-messages
   ```

2. Read the actual email. Copy its fallback code beginning `RZE-` into `TEST_EMAIL_LINK_TOKEN`. Do not consume the link in the app first. Then:

   ```bash
   npm run test:backend -- enrollment-confirm-email --allow-writes
   ```

3. Send the actual enrollment SMS:

   ```bash
   npm run test:backend -- enrollment-sms-send --allow-writes --allow-messages
   ```

4. Set `TEST_SMS_CODE` to this new SMS code, then:

   ```bash
   npm run test:backend -- enrollment-sms-check --allow-writes
   ```

   Twilio verification can be billable even though this check does not request a second SMS.

5. Request the approval email, which goes only to the fixed platform owner:

   ```bash
   npm run test:backend -- enrollment-approval-send --allow-writes --allow-messages
   ```

6. Read that email as the administrator. Put the `RZA-...` fallback code into `TEST_APPROVAL_LINK_TOKEN` and run:

   ```bash
   npm run test:backend -- enrollment-approve --allow-writes
   ```

The tests use the real received codes; they do not retrieve tokens from private tables or fabricate SMS proof. They check that the business is absent before approval, and email tokens cannot be reused. The approved **test business remains** for your later tests. Enrollment itself does not activate a paid plan.

If email sending fails after the private request was saved, its ID is retained locally. Fix the provider and resend from the app rather than repeatedly creating applications. Auth users, applications, memberships and test businesses are never automatically deleted.

## 10. Invitations, calendars, bookings and reports

Activate a valid test license/subscription for your test business and configure at least one calendar and event type using the app. No global payment-skip flag is introduced. Your existing developer-key restrictions remain unchanged.

Find the test business ID in `businesses`, calendar ID in `resources`, and service ID in `event_types`. Set:

```dotenv
TEST_BUSINESS_OWNED=true
TEST_BUSINESS_ID=YOUR_TEST_BUSINESS_UUID
TEST_CALENDAR_ID=YOUR_TEST_CALENDAR_UUID
TEST_EVENT_TYPE_ID=YOUR_TEST_EVENT_TYPE_UUID
```

An enrolled business ID can also be read automatically from local test state if `TEST_BUSINESS_ID` is empty. Configure availability for **two days from now in Europe/Bucharest**. Use only test records; the runner checks that the authenticated owner owns the business.

Invitation (separate Google staff account with no existing membership or pending invitation):

```bash
npm run test:backend -- invite-send --allow-writes --allow-messages
```

Read the invitation email in the staff inbox, set `TEST_INVITE_TOKEN` to its `RZI-...` code, then:

```bash
npm run test:backend -- invite-accept --allow-writes
```

The test creates viewer access to exactly one calendar, verifies scope and rejects token reuse. That membership remains for inspection; remove it from the test business manually when finished.

Booking:

```bash
npm run test:backend -- booking --allow-writes
```

This uses the real customer session to request the same slot twice concurrently. Exactly one must succeed. It then checks owner/customer visibility, server-derived customer identity and the active plan's report gate. The created booking is cancelled even if an assertion fails; its audit history remains. Future reminder jobs should be cancelled by the existing backend's cancellation logic.

If the process is interrupted, reauthenticate if needed and run:

```bash
npm run test:backend -- cancel-bookings --allow-writes
```

Only IDs tracked by this suite are cancelled. A network timeout can leave a server-created booking whose ID was never returned: inspect the **test** calendar for `Backend Test ...` records before retrying. There is no bulk delete, database reset or automatic removal of existing data.

## 11. Full push-worker and scheduler integration

This goes beyond sending directly to Firebase: booking → notification job → deployed worker → FCM → DB log. Both commands can send a real push.

Requirements: Step 10, DB connection, `CRON_SECRET`, a customer with push preferences enabled, and a real `TEST_FCM_TOKEN` already registered to that customer. Set `TEST_DEVICE_OWNED=true`. All devices registered to these test accounts must be under your control.

The worker processes a **global queue**. Use an isolated development project with no real users or unrelated reminders. The runner refuses to start when another due/in-flight job exists, but cannot prevent another client from creating one concurrently.

Direct deployed worker:

```bash
npm run test:backend -- reminders --allow-writes --allow-messages --allow-worker
```

Actual existing every-minute scheduler:

```bash
npm run test:backend -- scheduler --allow-writes --allow-messages --allow-worker
```

Both create a future test booking, move only its customer reminder to be due now, and check its final state plus exactly one notification log. `reminders` invokes the deployed function; `scheduler` **does not invoke it** and waits up to 90 seconds for the configured scheduler. Both cancel the tracked booking afterward.

For the scheduler, follow your existing `SETUP.html` / `docs/WINDOWS-SETUP.md`: enable `pg_cron`, `pg_net`, Vault; create `rezerva_project_url` and `rezerva_cron_secret`; schedule one active `rezerva-reminders` job every minute. Do not create duplicates. The read-only check verifies this configuration but does not create or edit it.

**Existing worker limitations:** FCM acceptance/logging is not device delivery. The supplied worker can mark a job sent when no device tokens exist; the live test therefore requires a registered token. Interrupted `processing` jobs do not yet have automatic recovery. These are not fixed by adding tests. Do not run the global worker against real customer data to investigate failures.

## 12. Optional RevenueCat / Google Play sandbox test

You may skip this until you configure Play test purchases. A sideloaded debug APK alone does not create a Play purchase or prove the billing integration. Follow the existing guide's internal-testing/license-tester setup and complete one real sandbox purchase manually. Public release is not required.

Use a separate test owner with **no production subscription**, and set:

```dotenv
REVENUECAT_SECRET_API_KEY=YOUR_PRIVATE_REVENUECAT_KEY
REVENUECAT_WEBHOOK_AUTH="THE_EXACT_CONFIGURED_AUTHORIZATION_VALUE"
REVENUECAT_ENTITLEMENT_ID=business_pro
TEST_REVENUECAT_USER_ID=THE_SAME_SUPABASE_OWNER_UUID
TEST_EXPECTED_PLAN=small
```

Use `small` for **Small (€50, one calendar)** or `large` for **Complete (€150, ten calendars)**. `large` is the existing internal plan/product identifier; the display name remains Complete. Expected product IDs are `rezerva_small_monthly` / `rezerva_large_monthly`, with any provider base-plan suffix handled by the backend.

```bash
npm run test:backend -- billing --allow-writes --allow-billing
```

This queries the actual RevenueCat subscriber, requires an active **Play sandbox** purchase, calls deployed `sync-subscription`, checks the persisted plan, and sends the same synthetic webhook event twice to verify the handler fetches authoritative current state. It never generates a fake purchase or changes store configuration. RevenueCat's subscriber endpoint can create a customer if an unknown ID is queried, so the command is separately opted in and must use an **existing** subscriber.

This tests your webhook **handler**, not RevenueCat delivering a real webhook. Check that separately with an actual sandbox renewal/cancellation and the RevenueCat event dashboard. Purchase/restore/cancellation timing, upgrades/downgrades, refunds, and Android checkout remain device/provider tests; offline cases cover the backend's expiry and payload handling.

The synchronization writes the real sandbox subscription record and leaves it for inspection. It does not set `allow_sandbox_payments`. Use your existing guide if you deliberately want sandbox entitlements to unlock features in the isolated test project; never enable that in production.

## 13. Troubleshooting and safety

| Result | Next action |
| --- | --- |
| `SKIP` | Configure that optional integration, or accept that it remains untested; do not count it as PASS |
| `401` on a real workflow | Refresh the correct Supabase Google session; check deployed function configuration |
| `404` for a function | Deploy the matching existing Edge Function; tests do not deploy it |
| DB connection/SSL error | Recheck project, session-pooler host, port 5432, encoded password, approved CA and network restrictions |
| Missing migration history | Verify actual SQL success and repair history deliberately; do not blindly rerun migrations |
| Email accepted, no inbox message | Inspect Resend domain/delivery/bounce logs privately and check spam |
| Twilio error | Check account/service, balance/trial recipient restrictions, Romania permissions and code expiry |
| FCM validation succeeds, phone silent | Check token freshness, correct customer, Android permission/background state and Firebase project |
| Booking has no slots | Configure the selected calendar/service for two days ahead, in Bucharest time |
| Scheduler fails | Inspect cron run details, pg_net responses, worker logs, Vault values and stuck jobs |
| `.backend-test.lock` exists | Ensure no suite/login process is running; only then remove that exact stale lock file |
| HTTP timeout during a write | Do not blindly retry; inspect tracked state and the test provider/calendar for partial success |

Secrets and raw provider/SQL errors are intentionally not printed. Inspect service dashboards privately. Reports contain only test names, status, sanitized messages and timings; runtime state contains test IDs/contact details and is private.

The following are Git-ignored: `.env`, `.env.backend.local`, `.backend-test-sessions.json`, `.backend-test-state.json`, `.backend-test-results/`, `.backend-test.lock`. Keep them private; Windows file permissions still depend on your account and filesystem. Do not upload the entire working folder as a public repository. Your returned ZIP preserves your original local configuration; keep that ZIP private too.

Retain the state file until you finish cleanup. Before switching projects/accounts, cancel tracked bookings and inspect remaining test applications/invitations/businesses, then deliberately move state/sessions aside. Do not silently overwrite state or run broad deletion commands.

## 14. Useful commands at a glance

```bash
# Backend only; fully local; free of provider calls
npm run test:backend:local

# Hosted configuration/auth checks; no messages
npm run test:backend

# Hosted configuration plus real PostgreSQL tests with rollback
npm run test:backend:all -- --allow-db-writes

# Show every supported command
npm run test:backend -- --help

# Existing project validation (npm test also includes original UI tests)
npm run check
npm run typecheck
npm test
npm run build
```

There is no new migration or server deployment required **for the test code**. Existing migrations, deployed functions, API credentials, DNS, phone registration and billing setup must be configured for the integration being tested. This suite improves repeatability; it is not a security audit, load test or guarantee of production readiness.

## Provider references

### Verification of this update

- `npm run check`: passed.
- `npm run typecheck`: passed (existing frontend JavaScript scope).
- `npm run test:backend:local`: **57 tests passed**, zero failed/skipped; local PostgreSQL and mocked providers only.
- `npm test`: **58 tests passed**, including the original UI regression test.
- `npm run build`: passed.
- Live service calls, SMS/email/push sends, hosted SQL writes and billing calls: **not executed while preparing this update**. Configure your development services and run the opted-in commands yourself.

### Official documentation

- [Resend: send email](https://resend.com/docs/api-reference/emails/send-email), [retrieve delivery status](https://resend.com/docs/api-reference/emails/retrieve-email), [domain status](https://resend.com/docs/api-reference/domains/get-domain).
- [Twilio Verify: verification](https://www.twilio.com/docs/verify/api/verification) and [verification check](https://www.twilio.com/docs/verify/api/verification-check).
- [FCM HTTP v1 send / validate_only](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send).
- [RevenueCat v1 API](https://www.revenuecat.com/docs/api-v1).
- [node-postgres TLS](https://node-postgres.com/features/ssl).
