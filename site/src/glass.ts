/**
 * The glass's specular highlight follows the pointer, and on Chromium the
 * nav and the airplane chip get the Liquid Glass lens (an SVG displacement
 * filter as a backdrop filter, which only Chromium draws).
 */
import { finePointer } from "./adaptive";

export function initGlass() {
  const chromium = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands.some(
    (b) => b.brand === "Chromium",
  );
  if (chromium) document.documentElement.classList.add("lens");

  if (!finePointer()) return;
  for (const el of document.querySelectorAll<HTMLElement>("[data-spot]")) {
    let frame = 0;
    el.addEventListener("pointermove", (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${e.clientX - r.left}px`);
        el.style.setProperty("--my", `${e.clientY - r.top}px`);
      });
    });
  }
}
