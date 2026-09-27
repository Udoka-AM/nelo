/**
 * The wallet dock: a slow marquee of Solana Pay wallets that, under a mouse,
 * stops and magnifies the way the macOS Dock does. Each icon grows with its
 * closeness to the pointer, so neighbours swell a little and make room.
 */
import { finePointer, reducedMotion } from "./adaptive";

const MAX = 1.9; // the icon under the pointer, relative to rest
const REACH = 150; // px either side that feel the pull

export function initDock() {
  const dock = document.querySelector<HTMLElement>("[data-dock]");
  if (!dock) return;
  const track = dock.querySelector<HTMLElement>(".dock__track")!;

  // The marquee scrolls half its track and jumps back, so each half must be at
  // least as wide as the dock. Repeat the wallets until it is, then double it.
  // The copies are hidden from assistive tech: the originals say it once.
  if (!reducedMotion()) {
    const originals = [...track.children] as HTMLElement[];
    const copyOf = (li: HTMLElement) => {
      const c = li.cloneNode(true) as HTMLElement;
      c.setAttribute("aria-hidden", "true");
      return c;
    };
    let guard = 0;
    while (track.scrollWidth < dock.clientWidth && guard++ < 12) originals.forEach((li) => track.appendChild(copyOf(li)));
    const half = [...track.children] as HTMLElement[];
    half.forEach((li) => track.appendChild(copyOf(li)));
    // A constant speed, whatever the length: about 40 px a second.
    track.style.animationDuration = `${Math.max(12, track.scrollWidth / 2 / 40)}s`;
  }

  if (!finePointer() || reducedMotion()) return;
  const items = [...dock.querySelectorAll<HTMLElement>(".dock__item")];
  let frame = 0;

  dock.addEventListener("pointermove", (e) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      dock.classList.add("is-magnifying");
      let hot: HTMLElement | null = null;
      let nearest = Infinity;
      for (const item of items) {
        const r = item.getBoundingClientRect();
        const d = Math.abs(e.clientX - (r.left + r.width / 2));
        const pull = d < REACH ? Math.cos((d / REACH) * (Math.PI / 2)) : 0;
        item.style.setProperty("--s", (1 + (MAX - 1) * pull).toFixed(3));
        if (d < nearest) {
          nearest = d;
          hot = item;
        }
      }
      items.forEach((i) => i.classList.toggle("is-hot", i === hot));
    });
  });
  dock.addEventListener("pointerleave", () => {
    cancelAnimationFrame(frame);
    dock.classList.remove("is-magnifying");
    items.forEach((i) => {
      i.style.setProperty("--s", "1");
      i.classList.remove("is-hot");
    });
  });
}
