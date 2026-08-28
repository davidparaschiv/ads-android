// @ts-check
// Local-only asset pipeline. Keeps the supplied PNG byte-for-byte; no AI redraw.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'assets/icon-only.png');
const inputs = join(root, 'assets/generated');
const res = join(root, 'android/app/src/main/res');
const white = { r: 255, g: 255, b: 255, alpha: 1 };
const clear = { r: 255, g: 255, b: 255, alpha: 0 };
await mkdir(inputs, { recursive: true });
await mkdir(join(res, 'drawable-nodpi'), { recursive: true });
const meta = await sharp(source).metadata();
if (!meta.width || !meta.height || meta.width !== meta.height || meta.width < 1024) {
  throw new Error('assets/icon-only.png must be a square PNG of at least 1024 pixels.');
}
await sharp(source).resize(1024, 1024).png().toFile(join(inputs, 'icon-only.png'));
await sharp(source).resize(1024, 1024).png().toFile(join(inputs, 'icon-foreground.png'));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: white } }).png().toFile(join(inputs, 'icon-background.png'));

// Wordless, white launch screen in both device themes. The source already has padding.
const splashMark = await sharp(source).resize(640, 640).png().toBuffer();
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: white } })
    .composite([{ input: splashMark, gravity: 'centre' }]).png().toFile(join(inputs, name));
}
// AndroidX/Android 12 launch icon: logo stays within the central 2/3 safe area.
await sharp({ create: { width: 960, height: 960, channels: 4, background: clear } })
  .composite([{ input: splashMark, gravity: 'centre' }]).png().toFile(join(res, 'drawable-nodpi/splash_logo.png'));

// Extract the white R from the supplied logo, excluding its outer white frame/dashes.
// These source-relative crop bounds belong to this artwork, not a generic logo crop.
const crop = { left: Math.round(meta.width * .29), top: Math.round(meta.height * .28),
  width: Math.round(meta.width * .51), height: Math.round(meta.height * .46) };
const { data, info } = await sharp(source).extract(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let minX = info.width, minY = info.height, maxX = 0, maxY = 0, count = 0;
for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
  const i = (y * info.width + x) * 4;
  const visible = data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240 && data[i + 3] > 240;
  data[i] = data[i + 1] = data[i + 2] = 255; data[i + 3] = visible ? 255 : 0;
  if (visible) { count++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
}
if (count < info.width * info.height * .1) throw new Error('Notification R mask is empty; check the artwork crop.');
const glyph = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }).png().toBuffer();
for (const [density, size] of [['mdpi', 24], ['hdpi', 36], ['xhdpi', 48], ['xxhdpi', 72], ['xxxhdpi', 96]]) {
  const folder = join(res, `drawable-${density}`);
  await mkdir(folder, { recursive: true });
  const resized = await sharp(glyph).resize(Number(size), Number(size), { fit: 'contain', background: clear })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Resampling can round RGB to 254 at alpha edges. Android needs only the alpha
  // silhouette, so explicitly keep every RGB channel pure white after resizing.
  for (let i = 0; i < resized.data.length; i += 4) resized.data[i] = resized.data[i + 1] = resized.data[i + 2] = 255;
  await sharp(resized.data, { raw: { width: Number(size), height: Number(size), channels: 4 } })
    .png().toFile(join(folder, 'ic_stat_rezerva.png'));
}
console.log('Prepared logo, adaptive inputs, white splash screens and transparent notification icons locally.');
