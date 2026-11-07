# Icon sources

Every icon is rendered from these SVGs; edit them, not the PNGs. Run from `desktop/`:

```bash
# macOS app icon (.icns with 16–1024 px, .ico, PNGs). The generator also writes Windows Store,
# iOS and Android sets; keep only the files tauri.conf.json lists.
npx tauri icon icons-src/app-icon.svg -o /tmp/codekin-icons
cp /tmp/codekin-icons/{32x32,64x64,128x128,128x128@2x,icon}.png /tmp/codekin-icons/icon.{icns,ico} src-tauri/icons/

# Menu bar template image (black + alpha; macOS tints it), 22 pt @2x
npx tauri icon icons-src/tray.svg -o /tmp/codekin-tray -p 44 && cp /tmp/codekin-tray/44x44.png src-tauri/icons/tray@2x.png

# Web app home-screen / manifest icons
npx tauri icon icons-src/web-icon.svg -o /tmp/codekin-web -p 180 -p 192 -p 512
cp /tmp/codekin-web/180x180.png ../public/apple-touch-icon.png
cp /tmp/codekin-web/192x192.png ../public/icon-192.png
cp /tmp/codekin-web/512x512.png ../public/icon-512.png
```

- `app-icon.svg`: the mark (light rings, orange dots) on a dark ink plate, on Apple's 1024 grid
  (824 px plate, 100 px margin, soft shadow). Dark plate for contrast in light and dark Docks
  (rings ≈ 17:1, dots ≈ 6.6:1 against the plate); a hairline edge separates it from a dark Dock.
- `web-icon.svg`: the same mark full-bleed (iOS rounds home-screen icons itself; the mark sits
  inside the maskable safe zone).
- The favicon itself (`public/favicon.svg`) is the one from codekin-website, which follows the
  system light/dark scheme.
