/**
 * Boot. The page is complete without any of this; each part enhances it, and
 * the heavy parts load only when the visitor's device and network can use them.
 */
import { reducedMotion, tier, watch } from "./adaptive";
import { initDock } from "./dock";
import { initGlass } from "./glass";
import { initHighlights } from "./highlights";
import { initInteractions } from "./interactions";
import { initTheme } from "./theme";
import { initVideos } from "./video";
import { initWaitlist } from "./waitlist";

const root = document.documentElement;
watch();
initTheme();
initWaitlist();
initGlass();
initVideos();
initDock();
initHighlights();
initInteractions();

if (tier() !== "lite" && !reducedMotion()) {
  // Hide the hero only for as long as the motion code takes to arrive, and
  // never longer than 2.5 s: a slow link gets the page, not a blank screen.
  root.classList.add("pre-motion");
  const reveal = () => root.classList.remove("pre-motion");
  const timeout = setTimeout(reveal, 2500);
  import("./motion")
    .then(({ initMotion }) => initMotion())
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timeout);
      reveal();
    });
} else {
  // No GSAP: the tile illustrations still run while their tile is visible.
  const live = new IntersectionObserver((entries) =>
    entries.forEach((e) => e.target.classList.toggle("is-live", e.isIntersecting)),
  );
  document.querySelectorAll(".tile").forEach((t) => live.observe(t));
  document.querySelector(".chip--airplane")?.classList.add("is-on");
}

// The hero's three promises, one after another, while the hero is on screen.
const items = [...document.querySelectorAll<HTMLElement>(".rotator__item")];
if (items.length > 1) {
  let i = 0;
  let timer = 0;
  const next = () => {
    items[i].classList.remove("is-on");
    i = (i + 1) % items.length;
    items[i].classList.add("is-on");
  };
  const start = () => (timer ||= window.setInterval(next, 2800));
  const stop = () => {
    clearInterval(timer);
    timer = 0;
  };
  new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(items[0].parentElement!);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
}
