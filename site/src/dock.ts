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

  // One copy for the eye to loop into; hidden from assistive tech and from the tab order.
  if (!reducedMotion()) {
    const copy = track.cloneNode(true) as HTMLElement;
    [...copy.children].forEach((li) => {
      li.setAttribute("aria-hidden", "true");
      track.appendChild(li);
    });
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
