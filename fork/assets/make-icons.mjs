#!/usr/bin/env node
// Regenerates the icon files in this directory from icon-source.png. Run it
// after replacing the source, then commit the results; the rebrand copies them
// over upstream's icons.
//
// Usage (from the repo root, after an install): node fork/assets/make-icons.mjs
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const here = import.meta.dirname;
const store = path.resolve(here, "../../node_modules/.pnpm");
const sharpDir = fs.readdirSync(store).find((name) => name.startsWith("sharp@"));
if (!sharpDir) throw new Error("sharp is not installed; run the install step of fork/build.sh first");
const sharp = createRequire(import.meta.url)(path.join(store, sharpDir, "node_modules/sharp"));

const source = path.join(here, "icon-source.png");

// macOS icons are a rounded square inset in the canvas with a soft shadow,
// matching the grid upstream's icon uses.
const SIZE = 1024;
const TILE = 824;
const INSET = (SIZE - TILE) / 2;
const RADIUS = 185;
const tileShape = (fill) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}"><rect width="${TILE}" height="${TILE}" rx="${RADIUS}" fill="${fill}"/></svg>`,
  );
const tile = await sharp(source)
  .resize(TILE, TILE)
  .composite([{ input: tileShape("#fff"), blend: "dest-in" }])
  .png()
  .toBuffer();
const shadow = await sharp({
  create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: tileShape("rgba(0,0,0,0.35)"), left: INSET, top: INSET + 10 }])
  .png()
  .toBuffer()
  .then((buffer) => sharp(buffer).blur(12).toBuffer());
await sharp(shadow)
  .composite([{ input: tile, left: INSET, top: INSET }])
  .png()
  .toFile(path.join(here, "macos-1024.png"));

// Web icons fill their square; the browser or OS rounds them.
for (const size of [16, 32, 180, 192, 512]) {
  await sharp(source).resize(size, size).png().toFile(path.join(here, `web-${size}.png`));
}

// An .ico holding the 32px PNG.
const png = fs.readFileSync(path.join(here, "web-32.png"));
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(32, 6);
header.writeUInt8(32, 7);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(here, "favicon.ico"), Buffer.concat([header, png]));
console.log("Icons written to", here);
