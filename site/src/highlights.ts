/**
 * The highlights gallery: one clip plays at a time. The active dot stretches
 * into a pill that fills as its clip plays; when the clip ends the gallery
 * moves to the next, and after the last, back to the first. Swipe, the dots,
 * or the keyboard move it by hand; the button pauses it.
 */
import { reducedMotion, tier } from "./adaptive";
import { prepare } from "./video";

export function initHighlights() {
  const root = document.querySelector<HTMLElement>("[data-highlights]");
  const section = root?.closest<HTMLElement>(".highlights");
  if (!root || !section) return;
  const track = root.querySelector<HTMLElement>(".hl__track")!;
  const slides = [...root.querySelectorAll<HTMLElement>(".hl__slide")];
  const videos = slides.map((s) => s.querySelector<HTMLVideoElement>("video")!);
  const dots = [...section.querySelectorAll<HTMLButtonElement>(".hl__dot")];
  const toggle = section.querySelector<HTMLButtonElement>(".hl__play")!;

  // On a lite connection nothing plays unless asked, so there is nothing to run.
  const auto = tier() !== "lite";
  let playing = auto && !reducedMotion();
  let active = 0;
  let inView = false;

  const setToggle = () => {
    section.classList.toggle("is-paused", !playing);
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  };
  setToggle();
  if (!auto) toggle.hidden = true;

  const show = (i: number, smooth = true) => {
    const slide = slides[i]!;
    track.scrollTo({ left: slide.offsetLeft - (track.clientWidth - slide.clientWidth) / 2, behavior: smooth ? "smooth" : "instant" });
  };

  const activate = (i: number) => {
    active = i;
    dots.forEach((d, j) => {
      d.classList.toggle("is-active", j === i);
      d.setAttribute("aria-current", j === i ? "true" : "false");
      if (j !== i) d.style.setProperty("--p", "0");
    });
    slides.forEach((s, j) => s.classList.toggle("is-active", j === i));
    videos.forEach((v, j) => {
      if (j !== i) {
        v.pause();
        v.currentTime = 0;
      }
    });
    run();
  };

  const run = () => {
    const v = videos[active]!;
    if (!auto) return;
    if (playing && inView && !document.hidden) {
      void prepare(v).then(() => v.play().catch(() => {}));
    } else v.pause();
  };

  videos.forEach((v, i) => {
    v.addEventListener("timeupdate", () => {
      if (i === active && v.duration) dots[i]!.style.setProperty("--p", (v.currentTime / v.duration).toFixed(3));
    });
    v.addEventListener("ended", () => {
      if (i === active && playing) show((i + 1) % slides.length);
    });
  });

  // Which slide is centred decides which one is active.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) activate(slides.indexOf(e.target as HTMLElement));
    },
    { root: track, threshold: 0.6 },
  );
  slides.forEach((s) => io.observe(s));

  new IntersectionObserver(([e]) => {
    inView = !!e?.isIntersecting;
    run();
  }, { threshold: 0.3 }).observe(section);
  document.addEventListener("visibilitychange", run);

  dots.forEach((d, i) => d.addEventListener("click", () => show(i)));
  toggle.addEventListener("click", () => {
    playing = !playing;
    setToggle();
    run();
  });
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") show(Math.min(active + 1, slides.length - 1));
    if (e.key === "ArrowLeft") show(Math.max(active - 1, 0));
  });
  track.tabIndex = 0;
  activate(0);
}
