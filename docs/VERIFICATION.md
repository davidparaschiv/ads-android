# Verification — v0.4

Passed locally:

- `npm run check` — ESLint.
- `npm run typecheck` — JavaScript checked using `@ts-check` and `jsconfig.json`; no TypeScript application files.
- `npm test` — 34 passing tests, zero failures.
- `npm run build` — Vite production bundle.
- `npm run android:sync` — assets and five Capacitor plugins synchronized into Android source project.

Database integration tests use PGlite PostgreSQL with `pgcrypto` and `btree_gist`. The regression suite applies 001–002; the new enrollment suite applies all three complete migrations. Supabase Auth tables, `auth.uid()` and roles are mocked for deterministic local testing. Tests cover hashes/privacy, email binding, idempotent redemption, expiry, future starts, month-end arithmetic, unverified email, revocation, account transfer rejection, throttling, plan limits, calendar-scoped booking reads, manager/viewer distinctions, invitation acceptance, removing membership, queued notifications, availability without customer data, overlap rejection, downgrade/history and sandbox isolation.

The plan-feature suite applies the entitlement migrations, including migration of pre-existing jobs. It checks Small report rejection, Complete reports with calendar/date scope, cross-business/outsider rejection, pagination, customer-only reminders on Small, Complete owner/staff reminders, dual-role customers, downgrade/expiry revalidation, licenses and universal developer access, opt-out, private helpers and worker-only permissions. Ordinary calendar reads remain available under RLS; this is not a claim that authorized users cannot calculate their own statistics from calendar data.

New checks cover universal developer-key redemption for verified Google accounts, disabled developer grants, normal email-bound license compatibility and neutral invalid-license messages, plus CUI/phone/email requirements, private pending enrollment, blocking the old create API, email-link replay/account binding, service-only phone proof bound to a verification SID, superseded/expired links, admin-only approval, and absence of a public business before final approval. The edge adapter uses mocked Twilio/Resend responses to reject unapproved or wrong-destination OTPs and verify that a client cannot override the approval recipient.

The UI integration test bundles the real JavaScript modules and runs them in jsdom. It covers demo sign-in, prices, no automatic payment grant, developer-key redemption, clearing the key input, mandatory enrollment, email/SMS/admin confirmation, initial setup, adding five calendars, invitations/revocation, monthly reports, and a staff account entering without payment. This is not a screenshot or native-device test.

It also checks the Small/Complete labels and benefits, direct navigation to locked screens, absence of Small dashboard statistics, continued calendar/customer-notification access, Complete preference saving, downgrade while the form is open, and the expired-plan owner upgrade prompt. Fixture-only state changes used by tests do not add a payment bypass to the app.

Not verified in this environment:

- Compiled/signed APK or Google Play approval. Android sync is not an Android compile.
- Real Google OAuth redirects, Supabase deployment, RevenueCat purchase/refund/restore lifecycle, Resend delivery, Twilio SMS delivery/checks, FCM background delivery, or verified Android HTTPS links. Account credentials are intentionally absent. No messages were sent.
- Multi-connection race/load testing on hosted PostgreSQL or an independent security audit. Integration tests exercise transaction logic but PGlite serializes local requests.

Run the tests again after changing configuration, migrations, policies or billing products. Follow the pre-production limits in the README and administrator guide.
