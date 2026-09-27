# nelo — landing page

Two pages: the business landing page (`index.html`) and **nelo Pay** for customers
(`pay/index.html`), sharing one stylesheet and one script. Served from GitHub Pages by [`.github/workflows/site.yml`](../.github/workflows/site.yml) on every push
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

## Interaction

Buttons light up under the pointer, ripple from the point of touch, lift, press in, and pull
magnetically; the main calls to action wear a turning blue-to-orange ring. Cards tilt toward the
pointer, the hero stage leans with it and a glow follows it, the nav has a sliding hover pill,
and a hairline tracks reading progress ([`src/interactions.ts`](src/interactions.ts), no
library). The Solana Pay wallets scroll as a marquee and magnify like the macOS Dock under a
mouse ([`src/dock.ts`](src/dock.ts)). Ripples and button light run everywhere; tilt, parallax,
glow and the nav pill need a fine pointer, full motion and a tier above lite.

## The footage

The clips are the real apps, not mock-ups: `apps/merchant` and `apps/payer` rendered in a browser
through react-native-web, with the phone-only modules (camera, secure element, SQLite) stood in
for. The till in `merchant-sale` verifies a genuinely signed voucher; the code in `payer-pay` is a
real voucher, and `payer-receive` asks another person for money. The apps' greens are brightened
a little on the site (greens and cyans only). Sources are in `media-src/`; to re-encode:

```bash
FFMPEG=/path/to/ffmpeg site/scripts/encode-video.sh
```

## The waitlist

Sign-ups go straight into the `waitlist` table of the **nelo** Supabase project (London). The
page holds only the publishable key, and the table allows that key to insert a row and nothing
else: it cannot read, change or delete the list, cannot backdate a row, and the database itself
rejects a malformed email or an unknown role. The schema and its rules are in
[`supabase/waitlist.sql`](supabase/waitlist.sql).

- **Reading the list:** Supabase dashboard → Table Editor → `waitlist`, or export it as CSV.
- **Duplicates** are refused by the database; the page tells that person they are already on it.
- **Offline:** a sign-up made with no signal is kept on the device and sent when it reconnects.
- **No JavaScript:** the form cannot post without it, and says so.
- **Spam:** a hidden honeypot field catches simple bots. There is no rate limit; if the list
  fills with junk, put a CAPTCHA or an Edge Function in front of it.

The build needs one repository variable, `SUPABASE_PUBLISHABLE_KEY`. It is public by design,
but the repository keeps no keys, so it is not committed.

## Wallet logos

The Solana Pay strip shows only wallets whose exact logo we have from a sourced, licensed
package: Phantom, Solflare, Backpack and Glow, from [web3icons](https://github.com/0xa3k5/web3icons)
(MIT). Each is documented as supporting Solana Pay. Other wallets that do (Decaf, Espresso Cash,
Ultimate, Ottr, TipLink) are left off until we have their official brand assets, rather than
shown with a redrawn or guessed mark; the line under the strip covers them. Each logo belongs
to its owner and is shown only to say the wallet can pay a nelo till.
