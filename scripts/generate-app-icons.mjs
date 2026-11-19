// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Maintenance tool: render the bundled Inter SemiBold glyph using Electron's own font renderer.
// No extra dependencies, system fonts or network access. Generated files are checked in, so normal
// builds do not need to run this tool. See build/README.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'build');

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true, timeout: 60_000 });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, nativeImage } = await import('electron');
// Keep this maintenance process apart from fat-g's own data and sessions.
app.setPath('userData', path.join(root, 'node_modules', '.cache', 'icon-generator'));
app.enableSandbox();
app.disableHardwareAcceleration();
// Electron waits for the entry module to finish before ready: register, rather than await it here.
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<meta charset="utf-8"><title>Icon generator</title>');
    const font = readFileSync(path.join(root, 'src/renderer/public/fonts/inter/Inter-SemiBold.woff2')).toString('base64');
    const sizes = [16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 96, 128, 256, 512, 1024];
    const images = await window.webContents.executeJavaScript(`(async () => {
      const face = new FontFace('IconInter', 'url(data:font/woff2;base64,${font})', { weight: '600' });
      document.fonts.add(await face.load());
      const layer = (paint) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        paint(canvas.getContext('2d'));
        return canvas;
      };
      const circle = (ctx, x, y, radius, colour) => {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      };
      const background = layer(ctx => circle(ctx, 512, 512, 464, '#000000'));
      const glyph = layer(ctx => {
        ctx.font = '600 760px IconInter';
        const box = ctx.measureText('f');
        const penX = 512 - (box.actualBoundingBoxRight - box.actualBoundingBoxLeft) / 2;
        const penY = 512 + (box.actualBoundingBoxAscent - box.actualBoundingBoxDescent) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillText('f', penX, penY);
      });
      const badge = layer(ctx => {
        // A 64/1024 rim remains one pixel wide at 16 px, rather than the old 0.375 px hairline.
        circle(ctx, 808, 216, 192, '#000000');
        circle(ctx, 808, 216, 128, '#ffd60a');
      });
      const render = (attention) => {
        // Keep fractional edge coverage instead of snapping the glyph to one taskbar's pixel grid.
        // Soften the silhouette separately so its edge survives the shell's further scaling without
        // blurring the letter more. Filter at master resolution: subpixel canvas blur rounds away at 1:1.
        const images = {};
        for (const size of ${JSON.stringify([...sizes.filter(size => size < 128), 1024])}) {
          const smooth = layer(ctx => {
            const draw = (image, radius) => {
              ctx.filter = size === 1024 ? 'none' : 'blur(' + (radius * 1024 / size) + 'px)';
              ctx.drawImage(image, 0, 0);
            };
            draw(background, 0.8);
            draw(glyph, 0.5);
            if (attention) draw(badge, 0.65);
          });
          images[size] = smooth.toDataURL('image/png').split(',')[1];
        }
        return images;
      };
      return { normal: render(false), attention: render(true) };
    })()`);
    // Skia's best-quality resize filters the large reduction before it reaches Windows. Canvas's
    // smoothing hint alone leaves the native PNG/HICON path to shrink a 1024px bitmap at runtime.
    const filtered = (images) => {
      const master = Buffer.from(images[1024], 'base64');
      const source = nativeImage.createFromBuffer(master);
      return new Map(sizes.map(size => [size, size === 1024 ? master
        : (images[size] ? nativeImage.createFromBuffer(Buffer.from(images[size], 'base64')) : source)
          .resize({ width: size, height: size, quality: 'best' }).toPNG()]));
    };
    const pngs = filtered(images.normal);
    const attentionPngs = filtered(images.attention);
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'icon.png'), pngs.get(1024));
    writeFileSync(path.join(output, 'icon-attention.png'), attentionPngs.get(1024));

    // ICO directory: PNG-compressed entries, including small Windows taskbar/title-bar sizes.
    const writeIco = (name, representations) => {
      const icoSizes = sizes.filter(size => size <= 256);
      const directory = Buffer.alloc(6 + icoSizes.length * 16);
      directory.writeUInt16LE(1, 2);
      directory.writeUInt16LE(icoSizes.length, 4);
      let offset = directory.length;
      for (const [index, size] of icoSizes.entries()) {
        const entry = 6 + index * 16;
        directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
        directory.writeUInt16LE(1, entry + 4);
        directory.writeUInt16LE(32, entry + 6);
        directory.writeUInt32LE(representations.get(size).length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += representations.get(size).length;
      }
      writeFileSync(path.join(output, name), Buffer.concat([directory, ...icoSizes.map(size => representations.get(size))]));
    };
    writeIco('icon.ico', pngs);
    writeIco('icon-attention.ico', attentionPngs);

    // ICNS uses PNG payloads in these modern element types (including Retina's 1024px image).
    const chunks = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
      const header = Buffer.alloc(8);
      header.write(type, 0, 'ascii');
      header.writeUInt32BE(8 + pngs.get(size).length, 4);
      return Buffer.concat([header, pngs.get(size)]);
    });
    const header = Buffer.alloc(8);
    header.write('icns', 0, 'ascii');
    header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    writeFileSync(path.join(output, 'icon.icns'), Buffer.concat([header, ...chunks]));
    window.destroy();
    console.log('Generated build/icon.png, icon-attention.png, icon.ico, icon-attention.ico and icon.icns.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode ?? 0);
  }
});
