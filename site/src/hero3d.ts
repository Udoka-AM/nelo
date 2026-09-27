/**
 * The 3D hero: two phones, built here in Three.js, with the real apps playing
 * on their screens. As the hero scrolls it stays pinned: the till turns from
 * its back to its face, the customer's phone swings in beside it, and the two
 * meet. Loaded only on the rich tier with full motion and WebGL; everywhere
 * else the flat hero it replaces stays.
 *
 * The casing is our own design, not any maker's: a machined titanium frame,
 * frosted glass back, a two-lens camera pill and a punch-hole display. The
 * apps are Android apps, and the phone does not pretend otherwise.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { finePointer } from "./adaptive";
import { streamInto } from "./video";

// Proportions of a modern 6.3" handset, in scene units.
const W = 0.76;
const H = 1.62;
const D = 0.082;
const R = 0.118;
const BEZEL = 0.028;

// Two finishes, one per theme: deep blue titanium on dark, natural on light.
const FINISHES = {
  dark: { frame: 0x56607a, back: 0x2c3548, island: 0x3a4459 },
  light: { frame: 0xa9adb4, back: 0xcfd2d7, island: 0x8a8f98 },
};
type Finish = (typeof FINISHES)["dark"];
const themeNow = (): keyof typeof FINISHES => {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** A flat rounded rectangle whose UVs run 0→1 across it, for the screen. */
function panel(w: number, h: number, r: number): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(roundedRect(w, h, r), 24);
  const pos = g.attributes.position!;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + w / 2) / w;
    uv[i * 2 + 1] = (pos.getY(i) + h / 2) / h;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

interface Phone {
  group: THREE.Group;
  screen: THREE.MeshBasicMaterial;
  paint(f: Finish): void;
}

function buildPhone(): Phone {
  const group = new THREE.Group();
  const bevel = 0.014;

  // Body: frosted glass faces, titanium sides and bevels (ExtrudeGeometry puts
  // the caps in group 0 and everything around the edge in group 1).
  const body = new THREE.ExtrudeGeometry(roundedRect(W - bevel * 2, H - bevel * 2, R - bevel), {
    depth: D - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 8,
    curveSegments: 24,
  });
  body.translate(0, 0, -(D - bevel * 2) / 2);
  const titanium = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 0.3, envMapIntensity: 1.3 });
  const frosted = new THREE.MeshPhysicalMaterial({
    metalness: 0.25,
    roughness: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.3,
  });
  group.add(new THREE.Mesh(body, [frosted, titanium]));

  // Front: black glass edge to edge, the display inset by a thin bezel.
  const glass = new THREE.Mesh(
    panel(W - 0.012, H - 0.012, R - 0.006),
    new THREE.MeshPhysicalMaterial({ color: 0x040405, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 }),
  );
  glass.position.z = D / 2 + 0.0006;
  group.add(glass);

  const screen = new THREE.MeshBasicMaterial({ color: 0x101113, toneMapped: false });
  const display = new THREE.Mesh(panel(W - BEZEL * 2, H - BEZEL * 2, R - BEZEL), screen);
  display.position.z = D / 2 + 0.0012;
  group.add(display);

  // A faint sheen across the display, so it reads as glass and not a picture.
  const sheen = new THREE.Mesh(
    panel(W - 0.012, H - 0.012, R - 0.006),
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.09,
      roughness: 0.04,
      clearcoat: 1,
      depthWrite: false,
    }),
  );
  sheen.position.z = D / 2 + 0.0018;
  group.add(sheen);

  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.017, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  hole.position.set(0, H / 2 - BEZEL - 0.04, D / 2 + 0.0019);
  group.add(hole);

  // Back: a raised camera pill with two coated lenses and a flash.
  const pillW = 0.2;
  const pillH = 0.38;
  const pill = new THREE.ExtrudeGeometry(roundedRect(pillW - 0.012, pillH - 0.012, pillW / 2 - 0.006), {
    depth: 0.01,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 5,
    curveSegments: 24,
  });
  const islandMat = new THREE.MeshPhysicalMaterial({ metalness: 0.6, roughness: 0.22, clearcoat: 1 });
  const island = new THREE.Mesh(pill, islandMat);
  const ix = -W / 2 + 0.07 + pillW / 2;
  const iy = H / 2 - 0.07 - pillH / 2;
  island.position.set(ix, iy, -D / 2 - 0.005);
  island.rotation.y = Math.PI; // extrusion now points out of the back
  group.add(island);

  const ringMat = new THREE.MeshPhysicalMaterial({ color: 0x2b2d31, metalness: 1, roughness: 0.18 });
  const lensMat = new THREE.MeshPhysicalMaterial({
    color: 0x05070b,
    roughness: 0.04,
    clearcoat: 1,
    iridescence: 1,
    iridescenceIOR: 1.8,
    iridescenceThicknessRange: [200, 600],
  });
  for (const dy of [0.085, -0.085]) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.068, 0.022, 48), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(ix, iy + dy, -D / 2 - 0.03);
    group.add(ring);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.024, 48), lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(ix, iy + dy, -D / 2 - 0.031);
    group.add(lens);
  }
  const flash = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.006, 32),
    new THREE.MeshPhysicalMaterial({ color: 0xfff4dc, roughness: 0.3, emissive: 0x332a1a }),
  );
  flash.rotation.x = Math.PI / 2;
  flash.position.set(ix + pillW / 2 + 0.05, iy + 0.12, -D / 2 - 0.004);
  group.add(flash);

  // Buttons: power on the right; volume up and down on the left.
  const buttonMat = titanium;
  const button = (h: number, x: number, y: number) => {
    const b = new THREE.Mesh(new RoundedBoxGeometry(0.014, h, 0.03, 3, 0.006), buttonMat);
    b.position.set(x, y, 0);
    group.add(b);
  };
  button(0.2, W / 2 + 0.004, 0.24);
  button(0.13, -W / 2 - 0.004, 0.36);
  button(0.13, -W / 2 - 0.004, 0.2);

  const paint = (f: Finish) => {
    titanium.color.set(f.frame);
    frosted.color.set(f.back);
    islandMat.color.set(f.island);
  };
  return { group, screen, paint };
}

/** Fit a 720×1558 recording into the display without stretching it. */
function coverFit(tex: THREE.Texture, width: number, height: number) {
  const screenAspect = (W - BEZEL * 2) / (H - BEZEL * 2);
  const texAspect = width / height;
  tex.repeat.set(1, 1);
  tex.offset.set(0, 0);
  if (texAspect > screenAspect) {
    tex.repeat.x = screenAspect / texAspect;
    tex.offset.x = (1 - tex.repeat.x) / 2;
  } else {
    tex.repeat.y = texAspect / screenAspect;
    tex.offset.y = (1 - tex.repeat.y) / 2;
  }
}

/** Paint a clip onto a phone: its poster at once, then the video once it plays. */
function wire(phone: Phone, clip: string, poster: string) {
  new THREE.TextureLoader().load(poster, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    coverFit(t, t.image.width, t.image.height);
    if (!phone.screen.map) {
      phone.screen.map = t;
      phone.screen.color.set(0xffffff);
      phone.screen.needsUpdate = true;
    }
  });
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.addEventListener(
    "playing",
    () => {
      const t = new THREE.VideoTexture(video);
      t.colorSpace = THREE.SRGBColorSpace;
      coverFit(t, video.videoWidth || 720, video.videoHeight || 1558);
      phone.screen.map = t;
      phone.screen.color.set(0xffffff);
      phone.screen.needsUpdate = true;
    },
    { once: true },
  );
  void streamInto(video, clip);
  return video;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * Build the scene into the hero. Resolves true once the first frame is on
 * screen, when the flat hero can be hidden; false if anything went wrong.
 */
export async function initHero3D(): Promise<boolean> {
  const hero = document.querySelector<HTMLElement>(".hero");
  const canvas = hero?.querySelector<HTMLCanvasElement>(".hero__canvas");
  const front = hero?.querySelector<HTMLVideoElement>(".phone--front video");
  const back = hero?.querySelector<HTMLVideoElement>(".phone--back video");
  if (!hero || !canvas || !front?.dataset.clip || !back?.dataset.clip) return false;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    return false;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Brand-coloured rim light: blue from the left, orange from the right.
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1.5, 2.5, 4);
  const blue = new THREE.DirectionalLight(0x6aa8ff, 3.2);
  blue.position.set(-4, 1, -2);
  const orange = new THREE.DirectionalLight(0xffa45c, 2.8);
  orange.position.set(4, -0.5, -2);
  scene.add(key, blue, orange);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0, 5.6);

  const till = buildPhone();
  const customer = buildPhone();
  scene.add(till.group, customer.group);
  const paintAll = () => [till, customer].forEach((p) => p.paint(FINISHES[themeNow()]));
  paintAll();
  new MutationObserver(paintAll).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintAll);

  const tillVideo = wire(till, front.dataset.clip, front.poster);
  const customerVideo = wire(customer, back.dataset.clip, back.poster);

  // Everything the scroll timeline moves, read by the render loop.
  const s = {
    aRotY: Math.PI * 0.86,
    aRotX: 0.32,
    aRotZ: -0.08,
    aX: 0,
    aY: -1.6,
    aScale: 1,
    bRotY: -Math.PI * 0.8,
    bRotX: 0.2,
    bX: -3.4,
    bY: -0.25,
    bScale: 0.86,
    spread: 0.55,
  };

  const size = () => {
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Pull back on narrow screens so both phones fit side by side.
    camera.position.z = camera.aspect < 0.75 ? 8.2 : camera.aspect < 1.1 ? 6.6 : 5.6;
    s.spread = camera.aspect < 0.75 ? 0.46 : 0.58;
    camera.updateProjectionMatrix();
  };
  size();
  addEventListener("resize", size);

  // Pointer: a gentle lean, eased.
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  if (finePointer()) {
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      pointer.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
      pointer.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
    });
  }

  // On screen or not, measured each frame: an observer does not follow the
  // hero reliably while it is pinned. Off screen, nothing is drawn or played.
  let visible = true;
  const setVisible = (v: boolean) => {
    if (v === visible) return;
    visible = v;
    for (const video of [tillVideo, customerVideo]) {
      if (v) video.play().catch(() => {});
      else video.pause();
    }
  };

  const t0 = performance.now();
  const loop = () => {
    requestAnimationFrame(loop);
    const r = hero.getBoundingClientRect();
    setVisible(r.bottom > 0 && r.top < innerHeight && !document.hidden);
    if (!visible) return;
    const t = (performance.now() - t0) / 1000;
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    const bob = Math.sin(t * 0.9) * 0.018;
    const sway = Math.sin(t * 0.55) * 0.03;

    till.group.position.set(s.aX, s.aY + bob, 0);
    till.group.rotation.set(s.aRotX + pointer.y * 0.08, s.aRotY + sway + pointer.x * 0.14, s.aRotZ);
    till.group.scale.setScalar(s.aScale);
    customer.group.position.set(s.bX, s.bY - bob * 0.8, -0.25);
    customer.group.rotation.set(s.bRotX + pointer.y * 0.06, s.bRotY - sway + pointer.x * 0.12, 0.04);
    customer.group.scale.setScalar(s.bScale);

    // The phones are never still (bob, sway, video), so draw every frame
    // while the hero is on screen, and none once it is not.
    renderer.render(scene, camera);
  };

  // The flat hero's overlays float over the scene instead.
  document.documentElement.classList.add("has-3d");
  hero.querySelectorAll(".hero__stage .chip").forEach((chip) => hero.appendChild(chip));

  // The entrance: the till rises into view, back first, catching the light.
  gsap.to(s, { aY: camera.aspect < 0.75 ? -0.3 : -0.46, duration: 2, ease: "expo.out", delay: 0.2 });

  // The scroll story, pinned: turn to face, then meet the customer.
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: hero,
      start: "top top",
      end: "+=220%",
      pin: true,
      scrub: 0.8,
      anticipatePin: 1,
      // Made after the sections below it; measure it first all the same.
      refreshPriority: 10,
    },
  });
  tl.to(s, { aRotY: 0, aRotX: 0.02, aRotZ: 0, aY: 0.02, duration: 1, ease: "power2.inOut" }, 0)

    .to(s, { aX: () => s.spread, aRotY: -0.26, duration: 1, ease: "power2.inOut" }, 1)
    .to(s, { bX: () => -s.spread, bRotY: 0.3, bRotX: 0.02, bY: 0.02, duration: 1, ease: "power2.inOut" }, 1)
    .fromTo(".hero .chip--airplane", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3 }, 1.5)
    .fromTo(".hero .chip--paid", { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.3 }, 1.75)
    .fromTo(".hero .rotator--below", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.3 }, 1.8)
    .to({}, { duration: 0.4 }); // a beat before the pin lets go

  // The headline lifts away as the till turns. Set straight from the playhead:
  // a scrubbed tween on it was left at its end state by the pin's re-measure.
  const copy = hero.querySelector<HTMLElement>(".hero__copy");
  const fadeCopy = () => {
    if (!copy) return;
    const k = Math.min(1, Math.max(0, (tl.time() - 0.35) / 0.5));
    copy.style.opacity = String(1 - k);
    copy.style.filter = k > 0 ? `blur(${(k * 10).toFixed(1)}px)` : "";
    copy.style.transform = `translateY(${(-70 * k).toFixed(1)}px)`;
  };
  tl.eventCallback("onUpdate", fadeCopy);
  fadeCopy();

  loop();
  // Wait for a real frame before swapping the flat hero out.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  ScrollTrigger.sort();
  ScrollTrigger.refresh();
  return true;
}
