/**
 * Boot. The page is complete without any of this; each part enhances it, and
 * the heavy parts load only when the visitor's device and network can use them.
 */
import { reducedMotion, tier, watch } from "./adaptive";
import { initGlass } from "./glass";
import { initTheme } from "./theme";
import { initVideos } from "./video";
import { initWaitlist } from "./waitlist";

const root = document.documentElement;
watch();
initTheme();
initWaitlist();
initGlass();
initVideos();

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
