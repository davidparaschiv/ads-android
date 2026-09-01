// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('Native app shell owns the viewport and only the screen scrolls vertically', async () => {
  const [css, html, layout] = await Promise.all([
    read('src/styles.css'), read('index.html'), read('src/ui/layout.js'),
  ]);
  assert.match(html, /maximum-scale=1\.0, user-scalable=no, viewport-fit=cover/);
  assert.match(css, /html, body, #app\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(css, /#app\s*\{[^}]*position:\s*fixed[^}]*height:\s*100dvh/s);
  assert.match(css, /\.app-shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)[^}]*height:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.screen\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto[^}]*touch-action:\s*pan-y/s);
  assert.match(css, /\.bottom-nav\s*\{[^}]*position:\s*fixed !important[^}]*height:\s*calc\(var\(--bottom-nav-height\)/s);
  assert.match(layout, /app-shell--with-nav/);
});

test('Safe areas, centered message layers and centered dialogs are global UI contracts', async () => {
  const [css, layout, dashboard, app] = await Promise.all([
    read('src/styles.css'), read('src/ui/layout.js'), read('src/screens/dashboard.js'), read('src/app.js'),
  ]);
  for (const inset of ['top', 'right', 'bottom', 'left']) assert(css.includes(`env(safe-area-inset-${inset})`));
  assert.match(css, /\.app-message-layer, \.popup-layer\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*place-items:\s*center/s);
  assert.match(css, /\.toast\s*\{[^}]*width:\s*min\(100%, 430px\)[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s);
  assert.match(css, /\.popup\s*\{[^}]*max-height:\s*calc\(100dvh[^}]*overflow:\s*hidden/s);
  assert.match(layout, /role', 'dialog'/);
  assert.match(layout, /aria-modal', 'true'/);
  assert.match(layout, /export async function alertDialog/);
  assert.match(app, /accountTypeNotice/);
  assert.match(app, /void alertDialog\(notice\)/);
  assert.doesNotMatch(dashboard, /window\.confirm/);
  assert.match(dashboard, /await confirmDialog/);

  const doc = new JSDOM('<div class="app-message-layer"><div class="toast">Un mesaj foarte lung</div></div>').window.document;
  assert.equal(doc.querySelector('.toast')?.parentElement?.className, 'app-message-layer');
});

test('Requested spacing and removed team screen stay explicit', async () => {
  const [css, app, dashboard, team] = await Promise.all([
    read('src/styles.css'), read('src/app.js'), read('src/screens/dashboard.js'), read('src/screens/team.js'),
  ]);
  assert.match(css, /\.draw-search\s*\{\s*margin-bottom:\s*54px/);
  assert.match(css, /#sign-out, \[id\$="-sign-out"\]\s*\{[^}]*margin:\s*clamp\(52px, 10vh, 96px\) auto 0/s);
  assert.match(css, /\.calendar-view-head \.weekday-tabs button\s*\{[^}]*padding:\s*8px 2px/s);
  assert.doesNotMatch(app, /\/business\/team|teamScreen/);
  assert.doesNotMatch(dashboard, /Vezi echipa|\/business\/team/);
  assert.doesNotMatch(team, /export async function teamScreen/);
});

test('Android is portrait-only, resizes for the keyboard and does not draw under cutouts', async () => {
  const [manifest, styles, activity] = await Promise.all([
    read('android/app/src/main/AndroidManifest.xml'),
    read('android/app/src/main/res/values/styles.xml'),
    read('android/app/src/main/java/ro/rezerva/app/MainActivity.java'),
  ]);
  const doc = new JSDOM(manifest, { contentType: 'text/xml' }).window.document;
  const main = doc.querySelector('activity');
  assert.equal(main?.getAttribute('android:screenOrientation'), 'portrait');
  assert.equal(main?.getAttribute('android:windowSoftInputMode'), 'adjustResize');
  assert.match(styles, /android:windowLayoutInDisplayCutoutMode">never/);
  assert.match(styles, /android:windowLightStatusBar">true/);
  assert.match(activity, /WindowCompat\.setDecorFitsSystemWindows\(getWindow\(\), true\)/);
});
