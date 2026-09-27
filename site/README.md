# nelo — landing page

Served from GitHub Pages by [`.github/workflows/site.yml`](../.github/workflows/site.yml) on every push
to `main` that touches `site/`.

```bash
pnpm --filter @nelo/site dev      # http://localhost:5173
pnpm --filter @nelo/site build    # → site/dist
```

## How it adapts to the visitor

The page is complete as HTML and CSS: with no JavaScript it shows every section, the phone
screens as still frames, and a waitlist form that posts normally. Everything else is layered on
according to a tier decided before first paint ([`index.html`](index.html)) and revised as the
connection changes ([`src/adaptive.ts`](src/adaptive.ts)):

| Tier | When | What loads |
|---|---|---|
| `lite` | Save-Data, reduced-data, 2G, ~1 GB phones | Posters and stills only, a Play button to opt in to video (held to the lowest rendition), system font, no blur, no GSAP |
| `standard` | 3G, high RTT, modest phones, or no Network Information API | Video from the lowest rendition up, GSAP motion |
| `rich` | 4G+ on a capable device | Everything, including Lenis smooth scroll and the Liquid Glass lens (Chromium) |

`prefers-reduced-motion` turns movement off whatever the tier. If the video player measures far
less bandwidth than the connection claimed, the page steps down for everything else too.

**Video** is adaptive bitrate: HLS in three renditions (360, 540, 720 wide) with two-second aligned
segments. Safari and iOS play it natively; Chromium and Firefox get `hls.js` (the light build),
loaded only when a video is about to be seen; anything else gets one progressive MP4. Videos
attach near the viewport, play only while on screen, and pause in a background tab.

## The footage

The clips are the real apps, not mock-ups: `apps/merchant` and `apps/payer` rendered in a browser
through react-native-web, with the phone-only modules (camera, secure element, SQLite) stood in
for. The till in `merchant-sale` verifies a genuinely signed voucher; the code in `payer-pay` is a
real voucher. Sources are in `media-src/`; to re-encode:

```bash
FFMPEG=/path/to/ffmpeg site/scripts/encode-video.sh
```

## The waitlist

Set the repository variable `WAITLIST_ENDPOINT` to a [Formspree](https://formspree.io) form URL
(or anything that accepts the same POST and answers JSON). Until then the form says the waitlist
opens soon and sends nothing.
