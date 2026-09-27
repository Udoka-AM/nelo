/**
 * The highlights: one box, three clips taking turns in it, played a little
 * faster than life. One plays at a time; the active dot stretches into a pill that fills as its clip plays, and
 * when the clip ends the next one moves in, and after the last, the first.
 * Nothing scrolls sideways: a swipe, the dots, or the arrow keys change the
 * clip by hand, and the button pauses it.
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
  const n = slides.length;
  // The clips run at this speed here, so the box moves on every four to five
  // seconds instead of ten to thirteen, and each still plays to its end.
  const SPEED = 2.5;
  for (const v of videos) {
    v.defaultPlaybackRate = SPEED;
    v.playbackRate = SPEED;
    // Some players reset the rate when a stream attaches.
    v.addEventListener("loadedmetadata", () => (v.playbackRate = SPEED));
  }

  // On a lite connection nothing plays unless asked, so there is nothing to run.
  const auto = tier() !== "lite";
  let playing = auto && !reducedMotion();
  let active = 0;
  let inView = false;
  let leaving: number | undefined;

  const setToggle = () => {
    section.classList.toggle("is-paused", !playing);
    toggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  };
  setToggle();
  if (!auto) toggle.hidden = true;

  const run = () => {
    const v = videos[active]!;
    if (!auto) return;
    if (playing && inView && !document.hidden) {
      void prepare(v).then(() => {
        // It may no longer be the one on show by the time the stream is ready.
        if (videos[active] === v) v.play().catch(() => {});
      });
    } else v.pause();
  };

  const go = (i: number, dir = i >= active ? 1 : -1) => {
    i = (i + n) % n;
    const from = active;
    active = i;
    track.style.setProperty("--dir", String(dir));

    slides.forEach((s, j) => {
      s.classList.toggle("is-active", j === i);
      s.classList.toggle("is-leaving", j === from && j !== i);
      // Only the clip on show can be reached or read.
      s.inert = j !== i;
      s.setAttribute("aria-hidden", j === i ? "false" : "true");
    });
    dots.forEach((d, j) => {
      d.classList.toggle("is-active", j === i);
      d.setAttribute("aria-current", j === i ? "true" : "false");
      if (j !== i) d.style.setProperty("--p", "0");
    });

    // The outgoing clip keeps its frame while it drifts off, then rewinds.
    clearTimeout(leaving);
    leaving = window.setTimeout(() => {
      slides[from]?.classList.remove("is-leaving");
      videos.forEach((v, j) => {
        if (j !== active) v.currentTime = 0;
      });
    }, 900);
    videos.forEach((v, j) => j !== i && v.pause());
    run();
  };

  videos.forEach((v, i) => {
    v.addEventListener("timeupdate", () => {
      if (i === active && v.duration) dots[i]!.style.setProperty("--p", (v.currentTime / v.duration).toFixed(3));
    });
    v.addEventListener("ended", () => {
      if (i === active && playing) go(i + 1, 1);
    });
  });

  new IntersectionObserver(
    ([e]) => {
      inView = !!e?.isIntersecting;
      run();
    },
    { threshold: 0.3 },
  ).observe(section);
  document.addEventListener("visibilitychange", run);

  dots.forEach((d, i) => d.addEventListener("click", () => i !== active && go(i)));
  toggle.addEventListener("click", () => {
    playing = !playing;
    setToggle();
    run();
  });
  track.tabIndex = 0;
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") go(active + 1, 1);
    else if (e.key === "ArrowLeft") go(active - 1, -1);
    else return;
    e.preventDefault();
  });

  // A sideways swipe changes the clip; an up-and-down one still scrolls the page.
  let x0 = 0,
    y0 = 0,
    down = false;
  track.addEventListener("pointerdown", (e) => {
    down = true;
    x0 = e.clientX;
    y0 = e.clientY;
  });
  track.addEventListener("pointerup", (e) => {
    if (!down) return;
    down = false;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) go(active + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  });
  track.addEventListener("pointercancel", () => (down = false));

  go(0);
}
