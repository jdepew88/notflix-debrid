/**
 * Notflix built-in avatar artwork, v2: original illustrated portraits drawn as layered SVG
 * (lighting, rim light, soft shadows, texture) and rasterised to WebP by generate-avatars.mjs.
 * Every avatar is a function returning a 256×256 SVG document.
 */

// ---------------------------------------------------------------------------------------------
// Colour and SVG helpers

const hex = (c) => c.replace("#", "");
const toRgb = (c) => [0, 2, 4].map((i) => parseInt(hex(c).slice(i, i + 2), 16));
const toHex = (rgb) => "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
export const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t));
const light = (c, t) => mix(c, "#ffffff", t);
const dark = (c, t) => mix(c, "#000000", t);

let seq = 0;
const id = (p) => `${p}${++seq}`;
const stopList = (stops) => stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join("");
const lin = (gid, stops, [x1, y1, x2, y2] = [0, 0, 0, 1]) => `<linearGradient id="${gid}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopList(stops)}</linearGradient>`;
const rad = (gid, stops, cx = 0.5, cy = 0.5, r = 0.5, fx = cx, fy = cy) =>
  `<radialGradient id="${gid}" cx="${cx}" cy="${cy}" r="${r}" fx="${fx}" fy="${fy}">${stopList(stops)}</radialGradient>`;
const blurF = (fid, sd) => `<filter id="${fid}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;

function doc(defs, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><defs>${defs}</defs>${body}</svg>`;
}

/**
 * The common "stage": lit backdrop, glow behind the subject, vignette and fine grain.
 * `glow` is the rim/back light colour.
 */
function stage(top, bottom, glow, { glowX = 128, glowY = 110, glowR = 92 } = {}) {
  const g = id("bg");
  const v = id("vg");
  const gl = id("gl");
  const b = id("bl");
  const n = id("nz");
  const defs =
    rad(g, [[0, light(top, 0.08)], [0.55, top], [1, bottom]], 0.42, 0.32, 0.85) +
    rad(v, [[0.55, "#000", 0], [1, "#000", 0.55]], 0.5, 0.45, 0.75) +
    rad(gl, [[0, glow, 0.85], [0.5, glow, 0.35], [1, glow, 0]]) +
    blurF(b, 10) +
    `<filter id="${n}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0"/></filter>`;
  const back = `<rect width="256" height="256" fill="url(#${g})"/><circle cx="${glowX}" cy="${glowY}" r="${glowR}" fill="url(#${gl})"/>`;
  const front = `<rect width="256" height="256" fill="url(#${v})"/><rect width="256" height="256" filter="url(#${n})" opacity="0.9"/>`;
  return { defs, back, front, blur: b };
}

/** Soft contact shadow under a subject. */
const groundShadow = (blurId, cx = 128, cy = 238, rx = 84, ry = 16, o = 0.55) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#000" opacity="${o}" filter="url(#${blurId})"/>`;

/** A lit, glossy eye. */
function eye(cx, cy, rx, ry, iris, { pupil = 0.42, lookX = 0, lookY = 0, lid = 0.25, slit = false } = {}) {
  const s = id("sc");
  const ir = id("ir");
  const defs = lin(s, [[0, "#f6f7fb"], [1, "#cfd4de"]]) + rad(ir, [[0, light(iris, 0.45)], [0.55, iris], [1, dark(iris, 0.55)]], 0.45, 0.4, 0.6);
  const r = Math.min(rx, ry) * 0.86;
  const ix = cx + lookX * rx * 0.25;
  const iy = cy + lookY * ry * 0.25;
  const pupilShape = slit
    ? `<ellipse cx="${ix}" cy="${iy}" rx="${r * 0.2}" ry="${r * 0.8}" fill="#08080c"/>`
    : `<circle cx="${ix}" cy="${iy}" r="${r * pupil}" fill="#08080c"/>`;
  const body =
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${s})"/>` +
    `<circle cx="${ix}" cy="${iy}" r="${r}" fill="url(#${ir})"/>` +
    pupilShape +
    `<circle cx="${ix - r * 0.35}" cy="${iy - r * 0.38}" r="${r * 0.26}" fill="#fff"/>` +
    `<circle cx="${ix + r * 0.3}" cy="${iy + r * 0.32}" r="${r * 0.11}" fill="#fff" opacity="0.75"/>` +
    (lid ? `<path d="M${cx - rx} ${cy} A${rx} ${ry} 0 0 1 ${cx + rx} ${cy} A${rx} ${ry * 0.7} 0 0 0 ${cx - rx} ${cy}Z" fill="#000" opacity="${lid}"/>` : "");
  return { defs, body };
}

/** Two eyes sharing a style. */
function eyes(cx, cy, gap, rx, ry, iris, opts) {
  const a = eye(cx - gap, cy, rx, ry, iris, opts);
  const b = eye(cx + gap, cy, rx, ry, iris, opts);
  return { defs: a.defs + b.defs, body: a.body + b.body };
}

/** A shaded fill: lighter top-left, darker bottom-right. Returns [defs, url]. */
function shade(base, { amount = 0.28, dir = [0.2, 0, 0.8, 1] } = {}) {
  const g = id("sh");
  return [lin(g, [[0, light(base, amount * 0.7)], [0.55, base], [1, dark(base, amount)]], dir), `url(#${g})`];
}

/**
 * Rim light: a soft crescent on the upper-right edge of a shape — the shape minus a copy shifted
 * down-left, so light only appears where the edge faces the back light.
 */
function rimClip(shapePath, color, offset = 5, opacity = 0.7) {
  const m = id("rm");
  const f = id("rf");
  return {
    defs:
      `<mask id="${m}" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256"><rect width="256" height="256" fill="#fff"/><path d="${shapePath}" fill="#000" transform="translate(${-offset * 1.2} ${offset * 0.7})"/></mask>` +
      blurF(f, 1.2),
    body: `<path d="${shapePath}" fill="${color}" mask="url(#${m})" opacity="${opacity}" filter="url(#${f})"/>`,
  };
}

/** Build a finished avatar: stage background, subject (may reference st.blur), stage overlay. */
function avatar(stageArgs, build, stageOpts) {
  const st = stage(...stageArgs, stageOpts);
  const parts = build(st);
  const defs = st.defs + parts.map((p) => (typeof p === "string" ? "" : p.defs ?? "")).join("");
  const body = parts.map((p) => (typeof p === "string" ? p : p.body ?? "")).join("");
  return doc(defs, st.back + body + st.front);
}

const P = (body, defs = "") => ({ body, defs });

/** Shoulders/bust silhouette at the bottom of the frame. */
const bustPath = (w = 100, top = 196) => `M${128 - w} 262 C${128 - w} ${top + 30} ${128 - w * 0.55} ${top} 128 ${top} C${128 + w * 0.55} ${top} ${128 + w} ${top + 30} ${128 + w} 262Z`;

// ---------------------------------------------------------------------------------------------
// Animals

function fox() {
  return avatar(["#123b46", "#06161b", "#3fd2c7"], (st) => {
    const [fd, fur] = shade("#e8732b", { amount: 0.35 });
    const [md, muzzle] = shade("#fff3e6", { amount: 0.12 });
    const head = "M128 62 C170 62 198 92 204 128 C210 160 184 192 154 204 L128 214 L102 204 C72 192 46 160 52 128 C58 92 86 62 128 62Z";
    const e = eyes(128, 132, 30, 15, 12, "#f0a429", { lookX: 0.2 });
    return [
      groundShadow(st.blur, 128, 236, 70, 12),
      P(`<path d="${bustPath(84, 196)}" fill="#c55a1d"/><path d="M128 196 C150 196 168 206 176 226 L128 262 L80 226 C88 206 106 196 128 196Z" fill="#fbeee2"/>`),
      P(`<path d="M60 112 L52 34 L106 78Z" fill="${fur}"/><path d="M196 112 L204 34 L150 78Z" fill="${fur}"/><path d="M66 100 L62 52 L98 82Z" fill="#3a1a10"/><path d="M190 100 L194 52 L158 82Z" fill="#3a1a10"/>`, fd),
      P(`<path d="${head}" fill="${fur}"/>`),
      P(`<path d="M128 136 C150 140 176 158 186 176 C170 196 148 210 128 214 C108 210 86 196 70 176 C80 158 106 140 128 136Z" fill="${muzzle}"/>`, md),
      P(`<path d="M60 150 C52 168 62 186 78 194 C70 180 70 166 76 154Z M196 150 C204 168 194 186 178 194 C186 180 186 166 180 154Z" fill="#fbeee2" opacity="0.9"/>`),
      e,
      P(`<path d="M116 170 Q128 162 140 170 Q136 184 128 186 Q120 184 116 170Z" fill="#1c1012"/><ellipse cx="124" cy="171" rx="5" ry="2.5" fill="#fff" opacity="0.55"/><path d="M128 186 L128 194 M118 198 Q128 204 138 198" stroke="#5a3324" stroke-width="2.5" fill="none" stroke-linecap="round"/>`),
      rimClip(head, "#7ff0e6", 4, 0.75),
      P(`<path d="M92 92 Q110 84 126 92 M130 92 Q146 84 164 92" stroke="#ffd2a3" stroke-width="3" fill="none" opacity="0.45" stroke-linecap="round"/>`),
    ];
  });
}

function owl() {
  return avatar(["#2d1b4f", "#0c0717", "#ffd27a"], (st) => {
    const [bd, body] = shade("#7a5a3c", { amount: 0.4 });
    const head = "M128 56 C178 56 210 94 210 140 C210 196 174 236 128 236 C82 236 46 196 46 140 C46 94 78 56 128 56Z";
    const e = eyes(128, 128, 36, 24, 24, "#ffb400", { pupil: 0.5, lid: 0.15 });
    let feathers = "";
    for (let row = 0; row < 4; row++)
      for (let i = -3; i <= 3; i++) {
        const x = 128 + i * 16 + (row % 2) * 8;
        const y = 178 + row * 14;
        if (Math.abs(x - 128) < 70 - row * 8) feathers += `<path d="M${x - 8} ${y} Q${x} ${y + 12} ${x + 8} ${y}" stroke="#f5e6cf" stroke-width="2.2" fill="none" opacity="${0.55 - row * 0.08}"/>`;
      }
    return [
      P(`<circle cx="196" cy="56" r="26" fill="#fff4d4" opacity="0.9" filter="url(#${st.blur})"/><circle cx="196" cy="56" r="20" fill="#fff8e6"/>`),
      groundShadow(st.blur, 128, 242, 76, 10),
      P(`<path d="M58 84 L70 40 L96 72Z M198 84 L186 40 L160 72Z" fill="${body}"/>`, bd),
      P(`<path d="${head}" fill="${body}"/>`),
      P(`<path d="M128 150 C160 150 186 170 192 204 C176 226 152 236 128 236 C104 236 80 226 64 204 C70 170 96 150 128 150Z" fill="#e9d6b8"/>`),
      P(feathers),
      P(`<circle cx="92" cy="128" r="34" fill="#f2e5cf"/><circle cx="164" cy="128" r="34" fill="#f2e5cf"/><circle cx="92" cy="128" r="34" fill="none" stroke="#5b3f27" stroke-width="3" opacity="0.5"/><circle cx="164" cy="128" r="34" fill="none" stroke="#5b3f27" stroke-width="3" opacity="0.5"/>`),
      e,
      P(`<path d="M118 152 L138 152 L128 172Z" fill="#f0a429"/><path d="M122 154 L132 154 L128 162Z" fill="#ffe0a0" opacity="0.7"/>`),
      P(`<path d="M74 92 Q92 82 112 94 M144 94 Q164 82 182 92" stroke="#3a2614" stroke-width="5" fill="none" stroke-linecap="round"/>`),
      rimClip(head, "#ffd27a", 4, 0.6),
    ];
  });
}

function panda() {
  return avatar(["#1f5135", "#071a10", "#b8f28a"], (st) => {
    const [hd, headFill] = shade("#f7f7f2", { amount: 0.2 });
    const head = "M128 66 C178 66 208 100 208 146 C208 192 172 222 128 222 C84 222 48 192 48 146 C48 100 78 66 128 66Z";
    const e = eyes(128, 140, 32, 11, 11, "#6b4a2b", { lookX: -0.2 });
    return [
      P(`<path d="M28 220 Q46 150 70 120" stroke="#5fae5a" stroke-width="7" fill="none"/><path d="M60 140 L36 128 L58 124Z M54 168 L28 170 L48 156Z" fill="#7fd06f"/><path d="M226 210 Q214 160 196 136" stroke="#5fae5a" stroke-width="6" fill="none"/><path d="M206 160 L232 150 L214 146Z" fill="#7fd06f"/>`),
      groundShadow(st.blur, 128, 238, 80, 12),
      P(`<path d="${bustPath(86, 206)}" fill="#1b1b20"/>`),
      P(`<circle cx="66" cy="84" r="24" fill="#16161b"/><circle cx="190" cy="84" r="24" fill="#16161b"/><circle cx="62" cy="80" r="9" fill="#33333a"/><circle cx="194" cy="80" r="9" fill="#33333a"/>`),
      P(`<path d="${head}" fill="${headFill}"/>`, hd),
      P(`<ellipse cx="96" cy="140" rx="24" ry="30" transform="rotate(-22 96 140)" fill="#1a1a1f"/><ellipse cx="160" cy="140" rx="24" ry="30" transform="rotate(22 160 140)" fill="#1a1a1f"/>`),
      e,
      P(`<ellipse cx="128" cy="176" rx="14" ry="9" fill="#1a1a1f"/><ellipse cx="124" cy="173" rx="5" ry="2.4" fill="#fff" opacity="0.5"/><path d="M128 185 L128 192 M116 196 Q128 204 140 196" stroke="#1a1a1f" stroke-width="3" fill="none" stroke-linecap="round"/>`),
      P(`<circle cx="84" cy="184" r="10" fill="#ff9aa8" opacity="0.35" filter="url(#${st.blur})"/><circle cx="172" cy="184" r="10" fill="#ff9aa8" opacity="0.35" filter="url(#${st.blur})"/>`),
      rimClip(head, "#d9ffb8", 4, 0.6),
    ];
  });
}

function lion() {
  return avatar(["#4a2408", "#140802", "#ffb347"], (st) => {
    let mane = "";
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      const x = 128 + Math.cos(a) * 82;
      const y = 136 + Math.sin(a) * 86;
      const c = i % 2 ? "#a8521a" : "#c9681f";
      mane += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="30" ry="46" transform="rotate(${((a * 180) / Math.PI + 90).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${c}"/>`;
    }
    const [fd, face] = shade("#f0b25a", { amount: 0.3 });
    const head = "M128 74 C168 74 190 104 192 138 C194 176 166 206 128 210 C90 206 62 176 64 138 C66 104 88 74 128 74Z";
    const e = eyes(128, 128, 28, 13, 10, "#e8a317", { lid: 0.35 });
    return [
      groundShadow(st.blur, 128, 242, 90, 12),
      P(mane),
      P(`<circle cx="128" cy="136" r="70" fill="#7a3a10" opacity="0.6" filter="url(#${st.blur})"/>`),
      P(`<circle cx="76" cy="92" r="16" fill="#d4913f"/><circle cx="180" cy="92" r="16" fill="#d4913f"/><circle cx="76" cy="92" r="8" fill="#6b3410"/><circle cx="180" cy="92" r="8" fill="#6b3410"/>`),
      P(`<path d="${head}" fill="${face}"/>`, fd),
      P(`<path d="M128 140 C146 140 164 156 166 176 C156 194 142 204 128 204 C114 204 100 194 90 176 C92 156 110 140 128 140Z" fill="#fbe2b8"/>`),
      e,
      P(`<path d="M112 160 Q128 150 144 160 Q140 176 128 178 Q116 176 112 160Z" fill="#5a2a14"/><ellipse cx="122" cy="161" rx="5" ry="2.5" fill="#fff" opacity="0.4"/><path d="M128 178 L128 186 M114 190 Q128 198 142 190" stroke="#5a2a14" stroke-width="3" fill="none" stroke-linecap="round"/>`),
      P(`<path d="M96 106 Q110 98 120 108 M136 108 Q146 98 160 106" stroke="#7a3a10" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.7"/>`),
      rimClip(head, "#ffd89a", 4, 0.55),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Fantasy characters

function wizard() {
  return avatar(["#1b2a6b", "#060a1f", "#6ab8ff"], (st) => {
    const [hd, hat] = shade("#4b2ca0", { amount: 0.4 });
    const [sd, skin] = shade("#f0c09a", { amount: 0.25 });
    let stars = "";
    [[40, 40, 2], [214, 34, 2.5], [222, 96, 1.6], [30, 110, 1.6], [190, 20, 1.4]].forEach(([x, y, r]) => (stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`));
    const e = eyes(128, 134, 20, 7, 6, "#3d7bd9", { lid: 0.45 });
    return [
      P(stars),
      P(`<circle cx="206" cy="160" r="22" fill="#8fd3ff" opacity="0.9" filter="url(#${st.blur})"/><circle cx="206" cy="160" r="12" fill="#e6f7ff"/><path d="M206 172 L206 256" stroke="#6b4423" stroke-width="7"/>`),
      groundShadow(st.blur, 128, 244, 90, 12),
      P(`<path d="${bustPath(98, 190)}" fill="#3b2386"/><path d="M128 190 L150 262 L106 262Z" fill="#2a1866"/>`),
      P(`<path d="M86 132 C86 102 104 90 128 90 C152 90 170 102 170 132 C170 162 152 176 128 176 C104 176 86 162 86 132Z" fill="${skin}"/>`, sd),
      e,
      P(`<path d="M100 120 Q114 112 122 122 M134 122 Q142 112 156 120" stroke="#e8e8f0" stroke-width="6" fill="none" stroke-linecap="round"/>`),
      P(`<path d="M128 140 Q132 150 128 156" stroke="#c8906a" stroke-width="3" fill="none"/>`),
      P(`<path d="M84 150 C88 200 108 236 128 246 C148 236 168 200 172 150 C160 166 146 160 128 162 C110 160 96 166 84 150Z" fill="#eef0f6"/><path d="M110 168 Q128 176 146 168" stroke="#c9ccd8" stroke-width="3" fill="none"/><path d="M114 196 Q128 214 142 196" stroke="#c9ccd8" stroke-width="2.5" fill="none"/>`),
      P(`<path d="M128 14 C140 40 168 72 190 98 L66 98 C90 72 116 40 128 14Z" fill="${hat}"/><path d="M48 102 Q128 76 208 102 Q128 120 48 102Z" fill="#331c80"/>`, hd),
      P(`<path d="M120 54 l4 9 10 1 -8 6 3 10 -9 -6 -9 6 3 -10 -8 -6 10 -1z" fill="#ffd86b"/><circle cx="148" cy="80" r="3" fill="#ffd86b"/><circle cx="104" cy="84" r="2.4" fill="#ffd86b"/>`),
      P(`<path d="M150 112 C162 120 170 134 170 148" stroke="#8fd3ff" stroke-width="5" fill="none" opacity="0.55" filter="url(#${st.blur})"/>`),
    ];
  });
}

function elf() {
  return avatar(["#1d4d3a", "#06150f", "#c9ff9e"], (st) => {
    const [sd, skin] = shade("#f3cfb3", { amount: 0.22 });
    const [hd, hair] = shade("#f2d48a", { amount: 0.35 });
    const face = "M128 74 C160 74 178 100 176 134 C174 170 152 196 128 198 C104 196 82 170 80 134 C78 100 96 74 128 74Z";
    const e = eyes(128, 134, 22, 10, 8, "#2fae7a", { lookX: 0.15 });
    return [
      groundShadow(st.blur, 128, 244, 88, 12),
      P(`<path d="M50 262 C52 170 70 70 128 60 C186 70 204 170 206 262Z" fill="${hair}"/>`, hd),
      P(`<path d="${bustPath(80, 210)}" fill="#2f6b4b"/><path d="M96 214 L128 238 L160 214" stroke="#d8b860" stroke-width="3" fill="none"/>`),
      P(`<path d="M82 128 L42 96 L84 150Z M174 128 L214 96 L172 150Z" fill="${skin}"/><path d="M80 132 L54 108 L80 144Z M176 132 L202 108 L176 144Z" fill="#e2a98c" opacity="0.6"/>`, sd),
      P(`<path d="M116 196 L116 214 L140 214 L140 196Z" fill="#e6b896"/>`),
      P(`<path d="${face}" fill="${skin}"/>`),
      P(`<path d="M80 128 C80 90 100 66 128 66 C156 66 176 90 176 128 C164 98 150 90 128 92 C106 90 92 98 80 128Z" fill="${hair}"/>`),
      P(`<path d="M86 96 Q128 70 170 96" stroke="#7bbf5f" stroke-width="5" fill="none"/><path d="M100 86 l-8 -10 12 2Z M128 78 l0 -12 6 10Z M156 86 l8 -10 -12 2Z" fill="#9ee07e"/>`),
      e,
      P(`<path d="M106 120 Q114 116 122 120 M134 120 Q142 116 150 120" stroke="#b08a4a" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M128 140 Q131 152 126 156" stroke="#d29c7c" stroke-width="2.5" fill="none"/><path d="M116 170 Q128 178 140 170" stroke="#c0605a" stroke-width="3.5" fill="none" stroke-linecap="round"/>`),
      P(`<circle cx="100" cy="158" r="9" fill="#ff8f8f" opacity="0.28" filter="url(#${st.blur})"/><circle cx="156" cy="158" r="9" fill="#ff8f8f" opacity="0.28" filter="url(#${st.blur})"/>`),
      rimClip(face, "#d6ffb4", 3, 0.6),
    ];
  });
}

function knight() {
  return avatar(["#5a0c12", "#16030a", "#ff7a59"], (st) => {
    const metal = id("mt");
    const defs = lin(metal, [[0, "#f4f6fa"], [0.35, "#aeb5c2"], [0.6, "#6a7180"], [1, "#2f333c"]], [0.1, 0, 0.9, 1]);
    const helm = "M128 46 C176 46 196 86 196 136 L196 200 C186 214 160 222 128 222 C96 222 70 214 60 200 L60 136 C60 86 80 46 128 46Z";
    return [
      groundShadow(st.blur, 128, 244, 92, 12),
      P(`<path d="M128 46 C120 26 136 12 150 18 C140 26 150 36 140 46" fill="#d7263d"/><path d="M128 46 C112 20 118 2 134 0 C126 14 140 30 128 46" fill="#ff4d5e"/>`),
      P(`<path d="${bustPath(104, 200)}" fill="url(#${metal})"/><path d="M60 230 Q128 210 196 230" stroke="#2f333c" stroke-width="4" fill="none" opacity="0.6"/>`, defs),
      P(`<path d="${helm}" fill="url(#${metal})"/>`),
      P(`<path d="M128 50 L128 222" stroke="#3a3f4a" stroke-width="4" opacity="0.6"/><path d="M76 128 L180 128 L172 142 L84 142Z" fill="#0b0c10"/><path d="M84 132 L172 132" stroke="#ff6a3d" stroke-width="3" opacity="0.8" filter="url(#${st.blur})"/>`),
      P(`<g fill="#0b0c10">${[0, 1, 2, 3, 4].map((i) => `<rect x="${104 + i * 11}" y="160" width="5" height="22" rx="2"/>`).join("")}</g>`),
      P(`<path d="M78 92 Q128 60 178 92" stroke="#ffffff" stroke-width="5" fill="none" opacity="0.5" stroke-linecap="round"/><path d="M90 100 L90 120" stroke="#fff" stroke-width="3" opacity="0.4"/>`),
      rimClip(helm, "#ff9a7a", 5, 0.7),
      P(`<circle cx="92" cy="200" r="4" fill="#c9ccd6"/><circle cx="164" cy="200" r="4" fill="#c9ccd6"/>`),
    ];
  });
}

function rogue() {
  return avatar(["#2a2f3a", "#08090c", "#7cf3ff"], (st) => {
    const [cd, cloak] = shade("#2d3b33", { amount: 0.45 });
    const hood = "M128 34 C186 34 214 88 214 150 C214 196 196 230 180 262 L76 262 C60 230 42 196 42 150 C42 88 70 34 128 34Z";
    return [
      groundShadow(st.blur, 128, 248, 96, 12),
      P(`<path d="${hood}" fill="${cloak}"/>`, cd),
      P(`<path d="M128 70 C166 70 182 104 182 146 C182 186 160 214 128 218 C96 214 74 186 74 146 C74 104 90 70 128 70Z" fill="#07090b"/>`),
      P(`<path d="M86 196 C100 212 114 220 128 222 C142 220 156 212 170 196 L170 228 L86 228Z" fill="#141a17"/>`),
      P(`<ellipse cx="106" cy="146" rx="12" ry="5" fill="#8ff7ff" filter="url(#${st.blur})"/><ellipse cx="150" cy="146" rx="12" ry="5" fill="#8ff7ff" filter="url(#${st.blur})"/><ellipse cx="106" cy="146" rx="9" ry="3" fill="#e9fdff"/><ellipse cx="150" cy="146" rx="9" ry="3" fill="#e9fdff"/>`),
      P(`<path d="M128 34 C150 70 158 118 156 160" stroke="#465c50" stroke-width="3" fill="none" opacity="0.6"/><path d="M78 230 L104 262 M178 230 L152 262" stroke="#1a231e" stroke-width="5"/>`),
      P(`<circle cx="128" cy="236" r="9" fill="#c9a34a"/><circle cx="128" cy="236" r="4" fill="#7a5a1c"/>`),
      rimClip(hood, "#7cf3ff", 5, 0.55),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Science fiction

function android() {
  return avatar(["#0d2b3f", "#030b12", "#2ee6ff"], (st) => {
    const chrome = id("ch");
    const defs = lin(chrome, [[0, "#ffffff"], [0.3, "#c9d3df"], [0.65, "#6f7c8c"], [1, "#2a313b"]], [0.15, 0, 0.85, 1]);
    const head = "M128 52 C170 52 190 84 190 128 C190 176 166 210 128 214 C90 210 66 176 66 128 C66 84 86 52 128 52Z";
    return [
      groundShadow(st.blur, 128, 242, 86, 12),
      P(`<path d="${bustPath(86, 208)}" fill="#1b2430"/><path d="M110 206 L110 226 L146 226 L146 206Z" fill="url(#${chrome})"/><path d="M60 236 L196 236" stroke="#2ee6ff" stroke-width="2" opacity="0.6"/>`, defs),
      P(`<path d="${head}" fill="url(#${chrome})"/>`),
      P(`<path d="M80 118 C96 108 160 108 176 118 L172 146 C156 154 100 154 84 146Z" fill="#06121b"/><path d="M90 126 L166 126" stroke="#2ee6ff" stroke-width="6" stroke-linecap="round" filter="url(#${st.blur})"/><path d="M92 126 L164 126" stroke="#bff8ff" stroke-width="3" stroke-linecap="round"/>`),
      P(`<path d="M128 56 L128 104 M86 92 L104 104 M170 92 L152 104 M100 178 L156 178 M110 190 L146 190" stroke="#46525f" stroke-width="2.5" fill="none"/>`),
      P(`<circle cx="76" cy="132" r="7" fill="#2ee6ff" opacity="0.8"/><circle cx="180" cy="132" r="7" fill="#2ee6ff" opacity="0.8"/>`),
      P(`<path d="M92 70 Q128 50 164 70" stroke="#fff" stroke-width="6" fill="none" opacity="0.7" stroke-linecap="round"/>`),
      rimClip(head, "#2ee6ff", 4, 0.8),
    ];
  });
}

function alien() {
  return avatar(["#2b0f4a", "#0a0314", "#76ff9e"], (st) => {
    const [sd, skin] = shade("#8a6ae0", { amount: 0.35 });
    const head = "M128 34 C186 34 210 82 206 124 C202 172 162 210 128 216 C94 210 54 172 50 124 C46 82 70 34 128 34Z";
    const eyeL = "M72 116 C84 96 116 104 118 128 C110 146 82 144 72 116Z";
    const eyeR = "M184 116 C172 96 140 104 138 128 C146 146 174 144 184 116Z";
    const ev = id("ev");
    return [
      P(`<circle cx="44" cy="52" r="2" fill="#fff"/><circle cx="214" cy="40" r="2.4" fill="#fff"/><circle cx="226" cy="120" r="1.6" fill="#fff"/>`),
      groundShadow(st.blur, 128, 242, 80, 12),
      P(`<path d="${bustPath(78, 214)}" fill="#1e1440"/><path d="M110 206 L110 226 L146 226 L146 206Z" fill="${skin}"/>`, sd),
      P(`<path d="${head}" fill="${skin}"/>`),
      P(`<path d="${eyeL}" fill="url(#${ev})"/><path d="${eyeR}" fill="url(#${ev})"/><ellipse cx="92" cy="116" rx="8" ry="5" fill="#fff" opacity="0.85" transform="rotate(-25 92 116)"/><ellipse cx="164" cy="116" rx="8" ry="5" fill="#fff" opacity="0.85" transform="rotate(25 164 116)"/>`, lin(ev, [[0, "#3df0a0"], [0.5, "#0b3b2c"], [1, "#020a07"]])),
      P(`<path d="M120 172 Q128 176 136 172" stroke="#3d2a6e" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="122" cy="156" r="2" fill="#3d2a6e"/><circle cx="134" cy="156" r="2" fill="#3d2a6e"/>`),
      P(`<path d="M86 60 Q128 40 170 60" stroke="#fff" stroke-width="5" fill="none" opacity="0.35" stroke-linecap="round"/>`),
      rimClip(head, "#76ff9e", 4, 0.7),
    ];
  });
}

function pilot() {
  return avatar(["#3d1d0a", "#0e0603", "#ff9c3a"], (st) => {
    const shell = id("sl");
    const visor = id("vs");
    const defs =
      lin(shell, [[0, "#fdfdfd"], [0.6, "#c9cdd6"], [1, "#6b7280"]], [0.2, 0, 0.8, 1]) +
      lin(visor, [[0, "#1d0b2e"], [0.45, "#9b2d6b"], [0.7, "#ff8a3d"], [0.82, "#ffd27a"], [1, "#2a1206"]]);
    const helmet = "M128 34 C186 34 214 80 214 132 C214 184 184 222 128 222 C72 222 42 184 42 132 C42 80 70 34 128 34Z";
    return [
      groundShadow(st.blur, 128, 244, 92, 12),
      P(`<path d="${bustPath(100, 206)}" fill="#e3e6ec"/><rect x="90" y="222" width="34" height="18" rx="3" fill="#ff6a00"/><rect x="132" y="222" width="34" height="18" rx="3" fill="#2a2e38"/>`),
      P(`<path d="${helmet}" fill="url(#${shell})"/>`, defs),
      P(`<path d="M62 120 C62 84 92 72 128 72 C164 72 194 84 194 120 C194 160 170 182 128 182 C86 182 62 160 62 120Z" fill="url(#${visor})"/>`),
      P(`<path d="M70 132 L102 116 L120 126 L144 110 L186 132 L186 150 L70 150Z" fill="#1a0a14" opacity="0.65"/>`),
      P(`<path d="M76 98 Q100 80 132 82" stroke="#fff" stroke-width="7" fill="none" opacity="0.7" stroke-linecap="round"/><path d="M168 96 Q176 104 178 116" stroke="#fff" stroke-width="4" fill="none" opacity="0.5" stroke-linecap="round"/>`),
      P(`<rect x="44" y="118" width="14" height="34" rx="5" fill="#6b7280"/><rect x="198" y="118" width="14" height="34" rx="5" fill="#6b7280"/><circle cx="205" cy="128" r="3" fill="#ff6a00"/>`),
      rimClip(helmet, "#ffb070", 5, 0.6),
    ];
  });
}

function mech() {
  return avatar(["#2b2f10", "#0b0c04", "#d7ff3a"], (st) => {
    const [ad, armor] = shade("#e0b52e", { amount: 0.45 });
    const head = "M78 72 L178 72 L196 112 L188 186 L160 212 L96 212 L68 186 L60 112Z";
    return [
      P(`<path d="M128 72 L128 30" stroke="#5a5d4a" stroke-width="5"/><circle cx="128" cy="26" r="7" fill="#ff4d3a"/><circle cx="128" cy="26" r="12" fill="#ff4d3a" opacity="0.5" filter="url(#${st.blur})"/>`),
      groundShadow(st.blur, 128, 242, 92, 12),
      P(`<path d="${bustPath(104, 202)}" fill="#3a3c2c"/><path d="M40 230 L84 214 L84 262 L40 262Z M216 230 L172 214 L172 262 L216 262Z" fill="${armor}"/>`, ad),
      P(`<path d="${head}" fill="${armor}"/>`),
      P(`<path d="M76 116 L180 116 L172 148 L84 148Z" fill="#101208"/><path d="M90 132 L166 132" stroke="#d7ff3a" stroke-width="8" stroke-linecap="round" filter="url(#${st.blur})"/><path d="M92 132 L164 132" stroke="#f4ffd0" stroke-width="3.5" stroke-linecap="round"/>`),
      P(`<path d="M96 168 L160 168 L152 190 L104 190Z" fill="#2c2e20"/><g stroke="#8a8d70" stroke-width="2">${[0, 1, 2, 3].map((i) => `<line x1="${110 + i * 12}" y1="172" x2="${110 + i * 12}" y2="186"/>`).join("")}</g>`),
      P(`<path d="M84 82 L172 82" stroke="#fff6c9" stroke-width="5" opacity="0.6" stroke-linecap="round"/><circle cx="72" cy="104" r="5" fill="#3a3c2c"/><circle cx="184" cy="104" r="5" fill="#3a3c2c"/>`),
      rimClip(head, "#efff9a", 4, 0.6),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Retro arcade: pixel portraits on a glowing CRT

function pixelPortrait(rows, palette, glowColor, top = "#14102b", bottom = "#05040c") {
  return avatar([top, bottom, glowColor], (st) => {
    const size = Math.floor(176 / Math.max(rows.length, rows[0].length));
    const ox = (256 - rows[0].length * size) / 2;
    const oy = (256 - rows.length * size) / 2 - 4;
    let px = "";
    rows.forEach((row, y) =>
      [...row].forEach((ch, x) => {
        if (palette[ch]) px += `<rect x="${ox + x * size}" y="${oy + y * size}" width="${size}" height="${size}" fill="${palette[ch]}"/>`;
      })
    );
    const scan = id("sn");
    const scanDefs = `<pattern id="${scan}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="2" fill="#000" opacity="0.28"/></pattern>`;
    return [
      P(`<rect x="22" y="22" width="212" height="212" rx="26" fill="#0a0912" stroke="${glowColor}" stroke-opacity="0.35" stroke-width="2"/>`),
      P(`<g filter="url(#${st.blur})" opacity="0.65">${px}</g>`),
      P(`<g shape-rendering="crispEdges">${px}</g>`),
      P(`<rect x="22" y="22" width="212" height="212" rx="26" fill="url(#${scan})"/><path d="M40 40 Q128 26 216 40" stroke="#fff" stroke-width="3" opacity="0.18" fill="none"/>`, scanDefs),
    ];
  });
}

const pixelKnight = () =>
  pixelPortrait(
    [
      "....SSSSSS....",
      "...SSSSSSSS...",
      "..SSHHHHHHSS..",
      "..SHHHHHHHHS..",
      "..SHkkHHkkHS..",
      "..SHHHHHHHHS..",
      "..SSHHHHHHSS..",
      "...SSSSSSSS...",
      "....RRRRRR....",
      "..RRRRGGRRRR..",
      ".RRRRRGGRRRRR.",
      ".RRRRRRRRRRRR.",
    ],
    { S: "#c7cbd6", H: "#8a90a0", k: "#101018", R: "#d7263d", G: "#ffd23f" },
    "#ff5f6d"
  );

const pixelCat = () =>
  pixelPortrait(
    [
      ".O..........O.",
      ".OO........OO.",
      ".OOOOOOOOOOOO.",
      "OOOOOOOOOOOOOO",
      "OOgGOOOOOOgGOO",
      "OOGGOOOOOOGGOO",
      "OOOOOOppOOOOOO",
      "wOOOOOOOOOOOOw",
      ".OOOwOOOOwOOO.",
      "..OOOOOOOOOO..",
      "...OOOOOOOO...",
    ],
    { O: "#ff9f43", g: "#eaffd0", G: "#2ecc71", p: "#ff6b9a", w: "#fff1d6" },
    "#ffb35c",
    "#1d1030"
  );

const pixelRobot = () =>
  pixelPortrait(
    [
      "......YY......",
      "......YY......",
      "..BBBBBBBBBB..",
      ".BBBBBBBBBBBB.",
      ".BBWWBBBBWWBB.",
      ".BBWkBBBBWkBB.",
      ".BBBBBBBBBBBB.",
      ".BBBPPPPPPBBB.",
      ".BBBBBBBBBBBB.",
      "..BBBBBBBBBB..",
      "...B......B...",
    ],
    { B: "#3ec5ff", Y: "#ffe14d", W: "#ffffff", k: "#0b1730", P: "#ff5fa2" },
    "#3ec5ff",
    "#08162e"
  );

const pixelFrog = () =>
  pixelPortrait(
    [
      "..WWW....WWW..",
      ".WWkW....WkWW.",
      ".WWWWGGGGWWWW.",
      ".GGGGGGGGGGGG.",
      "GGGGGGGGGGGGGG",
      "GGLLGGGGGGLLGG",
      "GGGGGGGGGGGGGG",
      "GGrrrrrrrrrrGG",
      ".GGGrrrrrrGGG.",
      "..GGGGGGGGGG..",
      "...YY....YY...",
    ],
    { W: "#ffffff", k: "#10220f", G: "#5fd35a", L: "#ff9fb4", r: "#c2304a", Y: "#ffd23f" },
    "#7dff6a",
    "#0b2410"
  );

// ---------------------------------------------------------------------------------------------
// Space exploration

function astronaut() {
  return avatar(["#0f1c4d", "#03050f", "#7aa2ff"], (st) => {
    const shell = id("as");
    const visor = id("av");
    const defs =
      lin(shell, [[0, "#ffffff"], [0.55, "#d6dae3"], [1, "#7d8494"]], [0.2, 0, 0.8, 1]) +
      rad(visor, [[0, "#3b2a7a"], [0.6, "#140c33"], [1, "#05030f"]], 0.4, 0.35, 0.75);
    const helmet = "M128 30 C188 30 216 78 216 130 C216 186 180 220 128 220 C76 220 40 186 40 130 C40 78 68 30 128 30Z";
    let stars = "";
    [[30, 40, 1.6], [226, 30, 2], [222, 200, 1.4], [20, 170, 1.2], [60, 16, 1.2]].forEach(([x, y, r]) => (stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/>`));
    return [
      P(stars),
      groundShadow(st.blur, 128, 246, 96, 12),
      P(`<path d="${bustPath(104, 204)}" fill="url(#${shell})"/><rect x="104" y="222" width="48" height="22" rx="5" fill="#2b3550"/><circle cx="116" cy="233" r="4" fill="#ff5a5a"/><circle cx="130" cy="233" r="4" fill="#ffd23f"/><circle cx="144" cy="233" r="4" fill="#4ade80"/>`, defs),
      P(`<path d="${helmet}" fill="url(#${shell})"/>`),
      P(`<path d="M62 124 C62 88 92 70 128 70 C164 70 194 88 194 124 C194 164 166 186 128 186 C90 186 62 164 62 124Z" fill="url(#${visor})"/>`),
      P(`<circle cx="156" cy="142" r="22" fill="#4c8dff"/><path d="M140 136 Q150 128 160 136 Q168 146 176 140" stroke="#7ee08a" stroke-width="6" fill="none"/><circle cx="156" cy="142" r="22" fill="none" stroke="#bcd6ff" stroke-width="1.5" opacity="0.7"/>`),
      P(`<path d="M80 100 Q102 80 136 80" stroke="#fff" stroke-width="8" fill="none" opacity="0.75" stroke-linecap="round"/><circle cx="90" cy="150" r="4" fill="#fff" opacity="0.6"/>`),
      rimClip(helmet, "#9db8ff", 5, 0.6),
    ];
  });
}

function planetfall() {
  return avatar(["#1b0f3a", "#05030d", "#ff7ab6"], (st) => {
    const planet = id("pl");
    const ground = id("gr");
    const defs = rad(planet, [[0, "#ffd3a6"], [0.6, "#ff8a5c"], [1, "#7a1f3d"]], 0.35, 0.3, 0.75) + lin(ground, [[0, "#3a1f5a"], [1, "#0e0718"]]);
    return [
      P(`<circle cx="40" cy="40" r="1.6" fill="#fff"/><circle cx="210" cy="28" r="2" fill="#fff"/><circle cx="120" cy="20" r="1.2" fill="#fff"/><circle cx="230" cy="96" r="1.4" fill="#fff"/>`),
      P(`<circle cx="150" cy="96" r="58" fill="url(#${planet})"/><ellipse cx="150" cy="100" rx="100" ry="18" transform="rotate(-14 150 100)" fill="none" stroke="#ffd3e8" stroke-width="5" opacity="0.75"/><path d="M92 92 A58 58 0 0 1 208 92" fill="none" stroke="#fff" stroke-width="2" opacity="0.3"/>`, defs),
      P(`<path d="M0 196 Q60 168 120 186 Q190 206 256 178 L256 256 L0 256Z" fill="url(#${ground})"/><path d="M0 214 Q80 196 150 214 T256 206 L256 256 L0 256Z" fill="#0b0614"/>`),
      P(`<g transform="translate(60 176)"><rect x="0" y="10" width="44" height="16" rx="4" fill="#e6e9f2"/><rect x="10" y="0" width="20" height="12" rx="3" fill="#cfd5e2"/><circle cx="8" cy="30" r="7" fill="#2a2e38"/><circle cx="36" cy="30" r="7" fill="#2a2e38"/><path d="M30 2 L42 -12" stroke="#cfd5e2" stroke-width="3"/><circle cx="43" cy="-13" r="3" fill="#ff7ab6"/></g>`),
      P(`<ellipse cx="82" cy="214" rx="34" ry="5" fill="#000" opacity="0.5" filter="url(#${st.blur})"/>`),
    ];
  });
}

function launch() {
  return avatar(["#0d2a5c", "#02060f", "#ffb347"], (st) => {
    const body = id("rb");
    const flame = id("fl");
    const defs = lin(body, [[0, "#ffffff"], [0.6, "#d8dde8"], [1, "#8a92a5"]], [0, 0, 1, 0]) + lin(flame, [[0, "#fff4c2"], [0.4, "#ffb347"], [1, "#ff4d2e", 0]]);
    let smoke = "";
    [[80, 214, 34], [118, 226, 40], [160, 220, 36], [196, 230, 30], [50, 236, 28], [128, 246, 44]].forEach(([x, y, r]) => (smoke += `<circle cx="${x}" cy="${y}" r="${r}" fill="#e9ecf3"/>`));
    return [
      P(`<circle cx="40" cy="44" r="1.8" fill="#fff"/><circle cx="214" cy="60" r="2" fill="#fff"/><circle cx="190" cy="24" r="1.4" fill="#fff"/>`),
      P(`<path d="M114 168 Q128 250 142 168Z" fill="url(#${flame})" filter="url(#${st.blur})"/><path d="M118 168 Q128 226 138 168Z" fill="url(#${flame})"/>`, defs),
      P(`<path d="M128 26 C150 46 156 90 154 168 L102 168 C100 90 106 46 128 26Z" fill="url(#${body})"/><path d="M102 128 L78 172 L102 166Z M154 128 L178 172 L154 166Z" fill="#e5383b"/><circle cx="128" cy="92" r="13" fill="#1f3b73" stroke="#c4cad6" stroke-width="4"/><circle cx="124" cy="88" r="4" fill="#fff" opacity="0.7"/><path d="M118 40 Q128 32 138 40" stroke="#e5383b" stroke-width="7" fill="none"/>`),
      P(`<g opacity="0.95">${smoke}</g><g opacity="0.35" fill="#9aa3b5">${smoke}</g>`),
      P(`<path d="M154 60 Q156 110 154 160" stroke="#fff" stroke-width="3" opacity="0.5" fill="none"/>`),
    ];
  });
}

function earthrise() {
  return avatar(["#0a0a1f", "#020205", "#5aa9ff"], (st) => {
    const earth = id("ea");
    const moon = id("mo");
    const defs = rad(earth, [[0, "#9fd0ff"], [0.5, "#2f7dd1"], [1, "#0b2a5c"]], 0.35, 0.3, 0.75) + lin(moon, [[0, "#d9dbe2"], [1, "#6b6f7c"]]);
    return [
      P(`<circle cx="30" cy="30" r="1.4" fill="#fff"/><circle cx="220" cy="40" r="1.8" fill="#fff"/><circle cx="60" cy="96" r="1.2" fill="#fff"/><circle cx="200" cy="120" r="1.2" fill="#fff"/>`),
      P(`<circle cx="138" cy="112" r="64" fill="#5aa9ff" opacity="0.35" filter="url(#${st.blur})"/><circle cx="138" cy="112" r="56" fill="url(#${earth})"/><path d="M104 96 Q118 80 136 92 Q150 104 142 120 Q128 132 112 124Z M150 70 Q170 74 172 92 Q160 98 150 88Z" fill="#5fbf6a" opacity="0.9"/><path d="M92 120 Q128 100 186 116" stroke="#fff" stroke-width="5" opacity="0.5" fill="none"/>`, defs),
      P(`<path d="M0 188 Q128 150 256 188 L256 256 L0 256Z" fill="url(#${moon})"/><ellipse cx="60" cy="214" rx="18" ry="6" fill="#565a66"/><ellipse cx="180" cy="230" rx="26" ry="7" fill="#565a66"/><ellipse cx="130" cy="200" rx="10" ry="3" fill="#565a66"/>`),
      P(`<g transform="translate(150 162)"><path d="M0 26 L0 0" stroke="#d9dbe2" stroke-width="2"/><path d="M0 0 L18 4 L0 10Z" fill="#e5383b"/></g>`),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Friendly monsters

function cyclops() {
  return avatar(["#123d24", "#04120a", "#c8ff5a"], (st) => {
    const [bd, fur] = shade("#5ccf4a", { amount: 0.35 });
    const body = "M128 46 C182 46 210 92 210 150 C210 206 180 240 128 240 C76 240 46 206 46 150 C46 92 74 46 128 46Z";
    let tufts = "";
    for (let i = 0; i < 9; i++) tufts += `<path d="M${68 + i * 15} ${62 - Math.sin(i) * 6} l6 -16 6 16" fill="${i % 2 ? "#4cb83c" : "#6fe05a"}"/>`;
    const e = eye(128, 120, 34, 34, "#3a8dff", { pupil: 0.45, lid: 0.18 });
    return [
      groundShadow(st.blur, 128, 244, 80, 10),
      P(tufts),
      P(`<path d="${body}" fill="${fur}"/>`, bd),
      e,
      P(`<path d="M84 176 Q128 214 172 176 Q128 194 84 176Z" fill="#2a0f14"/><path d="M100 180 L106 192 L112 182Z M144 182 L150 192 L156 180Z" fill="#fff"/><path d="M112 198 Q128 206 144 198" stroke="#ff6b8a" stroke-width="5" fill="none" stroke-linecap="round"/>`),
      P(`<circle cx="74" cy="170" r="10" fill="#ff9aa8" opacity="0.4" filter="url(#${st.blur})"/><circle cx="182" cy="170" r="10" fill="#ff9aa8" opacity="0.4" filter="url(#${st.blur})"/>`),
      rimClip(body, "#e8ff9a", 4, 0.6),
    ];
  });
}

function hornbeast() {
  return avatar(["#14295e", "#040817", "#7fd1ff"], (st) => {
    const [bd, fur] = shade("#4a7df0", { amount: 0.35 });
    const body = "M128 64 C178 64 206 102 206 152 C206 204 176 236 128 236 C80 236 50 204 50 152 C50 102 78 64 128 64Z";
    const e = eyes(128, 136, 30, 14, 15, "#ffb400", { pupil: 0.45 });
    return [
      groundShadow(st.blur, 128, 244, 84, 10),
      P(`<path d="M72 96 C52 74 50 46 64 30 C68 56 82 70 98 78Z M184 96 C204 74 206 46 192 30 C188 56 174 70 158 78Z" fill="#f2e6c9"/><path d="M64 30 C68 56 82 70 98 78 L92 86 C76 76 66 58 64 30Z" fill="#c9b994"/>`),
      P(`<path d="${body}" fill="${fur}"/>`, bd),
      P(`<path d="M80 110 Q90 96 110 104 M146 104 Q166 96 176 110" stroke="#1f3f9a" stroke-width="6" fill="none" stroke-linecap="round"/>`),
      e,
      P(`<path d="M96 184 Q128 210 160 184" stroke="#1a2350" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M110 190 L114 200 L118 192Z M138 192 L142 200 L146 190Z" fill="#fff"/>`),
      P(`<ellipse cx="128" cy="166" rx="10" ry="7" fill="#24347a"/>`),
      rimClip(body, "#a8e4ff", 4, 0.6),
    ];
  });
}

function blobby() {
  return avatar(["#5c1340", "#170410", "#ffb3e0"], (st) => {
    const [bd, goo] = shade("#ff7cc4", { amount: 0.3 });
    const body = "M128 52 C176 52 206 92 208 140 C210 182 196 214 176 226 C164 234 150 222 140 232 C130 242 118 232 108 236 C92 242 86 226 74 226 C56 214 46 184 48 140 C50 92 80 52 128 52Z";
    const e1 = eye(96, 122, 16, 18, "#5b2bd6", { pupil: 0.5 });
    const e2 = eye(160, 122, 16, 18, "#5b2bd6", { pupil: 0.5 });
    const e3 = eye(128, 92, 12, 13, "#5b2bd6", { pupil: 0.5 });
    return [
      groundShadow(st.blur, 128, 244, 76, 10),
      P(`<path d="${body}" fill="${goo}"/>`, bd),
      P(`<ellipse cx="90" cy="80" rx="22" ry="12" fill="#fff" opacity="0.45" transform="rotate(-30 90 80)"/><circle cx="72" cy="104" r="5" fill="#fff" opacity="0.5"/>`),
      e1, e2, e3,
      P(`<path d="M104 168 Q128 192 152 168" stroke="#7a0f4a" stroke-width="7" fill="none" stroke-linecap="round"/>`),
      P(`<circle cx="72" cy="160" r="9" fill="#ff3d7f" opacity="0.4" filter="url(#${st.blur})"/><circle cx="184" cy="160" r="9" fill="#ff3d7f" opacity="0.4" filter="url(#${st.blur})"/>`),
      rimClip(body, "#ffd6ef", 4, 0.6),
    ];
  });
}

function wisp() {
  return avatar(["#16233f", "#050812", "#a8c8ff"], (st) => {
    const sheet = id("ws");
    const defs = lin(sheet, [[0, "#ffffff"], [0.7, "#e4ebf7"], [1, "#a9b6cf"]]);
    const body = "M128 42 C174 42 198 80 198 128 L198 214 Q186 202 174 214 Q162 226 150 214 Q140 204 128 216 Q116 228 104 214 Q92 202 82 214 Q70 226 58 214 L58 128 C58 80 82 42 128 42Z";
    return [
      P(`<circle cx="128" cy="130" r="90" fill="#a8c8ff" opacity="0.35" filter="url(#${st.blur})"/>`),
      groundShadow(st.blur, 128, 246, 64, 8, 0.35),
      P(`<path d="${body}" fill="url(#${sheet})"/>`, defs),
      P(`<ellipse cx="104" cy="122" rx="11" ry="15" fill="#1d2235"/><ellipse cx="152" cy="122" rx="11" ry="15" fill="#1d2235"/><circle cx="100" cy="116" r="4" fill="#fff"/><circle cx="148" cy="116" r="4" fill="#fff"/>`),
      P(`<path d="M116 156 Q128 166 140 156" stroke="#1d2235" stroke-width="4.5" fill="none" stroke-linecap="round"/><circle cx="88" cy="146" r="9" fill="#ff9ab0" opacity="0.5" filter="url(#${st.blur})"/><circle cx="168" cy="146" r="9" fill="#ff9ab0" opacity="0.5" filter="url(#${st.blur})"/>`),
      P(`<path d="M84 70 Q104 54 128 56" stroke="#fff" stroke-width="6" fill="none" opacity="0.8" stroke-linecap="round"/>`),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Mythical creatures

function dragon() {
  return avatar(["#3a0a0a", "#100202", "#ff6a2b"], (st) => {
    const [sd, scale] = shade("#c0392b", { amount: 0.45 });
    const head = "M128 60 C170 60 196 92 198 132 C200 168 186 196 168 212 L150 226 L106 226 L88 212 C70 196 56 168 58 132 C60 92 86 60 128 60Z";
    let scales = "";
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) scales += `<path d="M${88 + c * 20 + (r % 2) * 10} ${78 + r * 14} q10 10 20 0" stroke="#7a1a12" stroke-width="2" fill="none" opacity="0.55"/>`;
    const e = eyes(128, 134, 34, 14, 9, "#ffcc00", { slit: true, lid: 0.4 });
    return [
      groundShadow(st.blur, 128, 246, 90, 12),
      P(`<path d="M78 90 C58 62 52 30 60 12 C70 40 88 60 104 70Z M178 90 C198 62 204 30 196 12 C186 40 168 60 152 70Z" fill="#e8d6b0"/><path d="M60 12 C70 40 88 60 104 70 L96 80 C80 68 64 44 60 12Z" fill="#b39c74"/>`),
      P(`<path d="M58 140 L22 118 L54 160Z M198 140 L234 118 L202 160Z" fill="${scale}"/>`, sd),
      P(`<path d="${head}" fill="${scale}"/>`),
      P(scales),
      P(`<path d="M96 172 C110 164 146 164 160 172 C158 196 146 214 128 216 C110 214 98 196 96 172Z" fill="#e66a3c"/><path d="M110 186 L116 194 M146 186 L140 194" stroke="#5a0f0a" stroke-width="4" stroke-linecap="round"/>`),
      e,
      P(`<path d="M84 118 Q104 104 118 120 M138 120 Q152 104 172 118" stroke="#3a0805" stroke-width="5" fill="none" stroke-linecap="round"/>`),
      P(`<path d="M108 228 L102 250 L116 236Z M148 228 L154 250 L140 236Z" fill="#f4ead6"/>`),
      rimClip(head, "#ffae6b", 4, 0.65),
    ];
  });
}

function phoenix() {
  return avatar(["#4a1204", "#120401", "#ffd36b"], (st) => {
    const fl = id("pf");
    const defs = lin(fl, [[0, "#fff1b8"], [0.35, "#ffb02e"], [0.75, "#ff4d1f"], [1, "#a3120a"]]);
    let flames = "";
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (i - 4) * 0.32;
      const x = 128 + Math.cos(a) * 30;
      const y = 120 + Math.sin(a) * 30;
      const ex = 128 + Math.cos(a) * 112;
      const ey = 120 + Math.sin(a) * 104;
      flames += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} Q${(ex - 14).toFixed(1)} ${(ey + 20).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)} Q${(ex + 8).toFixed(1)} ${(ey + 30).toFixed(1)} ${(x + 8).toFixed(1)} ${(y + 6).toFixed(1)}Z" fill="url(#${fl})" opacity="0.9"/>`;
    }
    const head = "M128 86 C154 86 170 106 170 132 C170 168 150 196 128 210 C106 196 86 168 86 132 C86 106 102 86 128 86Z";
    const e = eyes(128, 128, 18, 8, 7, "#ff7a00", { lid: 0.35 });
    return [
      P(`<circle cx="128" cy="130" r="96" fill="#ff9a2e" opacity="0.45" filter="url(#${st.blur})"/>`),
      P(flames, defs),
      P(`<path d="M60 200 Q100 168 128 200 Q156 168 196 200 Q170 236 128 248 Q86 236 60 200Z" fill="url(#${fl})"/>`),
      P(`<path d="${head}" fill="url(#${fl})"/>`),
      e,
      P(`<path d="M120 144 L136 144 L128 166Z" fill="#ffe08a"/><path d="M122 146 L130 146 L127 154Z" fill="#fff" opacity="0.6"/>`),
      rimClip(head, "#fff1b8", 3, 0.7),
    ];
  });
}

function unicorn() {
  return avatar(["#3b2366", "#0e0719", "#ffc3f0"], (st) => {
    const [hd, coat] = shade("#fdfbff", { amount: 0.18 });
    const mane = id("um");
    const horn = id("uh");
    const defs = lin(mane, [[0, "#ff7ac6"], [0.35, "#b98cff"], [0.7, "#6ad6ff"], [1, "#7affc4"]], [0, 0, 1, 1]) + lin(horn, [[0, "#fff8d6"], [1, "#e8b84a"]]);
    const head = "M140 66 C178 74 196 112 192 150 C188 186 168 214 144 222 L106 226 C92 224 84 210 86 194 C88 178 98 168 100 152 C102 128 92 104 104 84 C112 70 126 64 140 66Z";
    return [
      groundShadow(st.blur, 132, 246, 82, 12),
      P(`<path d="M128 70 L150 10 L156 74Z" fill="url(#${horn})"/><path d="M134 54 L152 46 M138 38 L154 30" stroke="#d9a63a" stroke-width="3"/>`, defs),
      P(`<path d="M104 84 C70 96 52 140 60 200 C66 232 84 250 100 256 L118 250 C100 220 96 170 112 130Z" fill="url(#${mane})"/>`),
      P(`<path d="M150 70 L168 40 L172 80Z" fill="${coat}"/>`, hd),
      P(`<path d="${head}" fill="${coat}"/>`),
      P(`<path d="M110 84 C96 104 92 140 104 176 C80 150 78 108 110 84Z" fill="url(#${mane})" opacity="0.9"/>`),
      P(`<ellipse cx="160" cy="132" rx="12" ry="14" fill="#2d1b4f"/><circle cx="156" cy="127" r="4.5" fill="#fff"/><circle cx="164" cy="138" r="2" fill="#fff" opacity="0.7"/><path d="M146 116 Q160 108 174 118" stroke="#2d1b4f" stroke-width="3" fill="none"/>`),
      P(`<ellipse cx="128" cy="204" rx="22" ry="14" fill="#ffd3ec"/><circle cx="120" cy="204" r="3" fill="#b8608e"/><circle cx="136" cy="204" r="3" fill="#b8608e"/>`),
      P(`<circle cx="174" cy="166" r="9" fill="#ff8fc8" opacity="0.4" filter="url(#${st.blur})"/>`),
      rimClip(head, "#ffd6f5", 4, 0.6),
    ];
  });
}

function serpent() {
  return avatar(["#06303a", "#010d10", "#4ff0d0"], (st) => {
    const [sd, skin] = shade("#1fa38a", { amount: 0.45 });
    const head = "M128 54 C168 54 196 80 198 116 C200 150 176 172 150 182 L106 182 C80 172 56 150 58 116 C60 80 88 54 128 54Z";
    const e = eyes(128, 112, 38, 12, 10, "#ffe14d", { slit: true, lid: 0.35 });
    return [
      P(`<path d="M0 214 Q32 196 64 214 T128 214 T192 214 T256 214 L256 256 L0 256Z" fill="#0a5a63"/><path d="M0 230 Q32 214 64 230 T128 230 T192 230 T256 230 L256 256 L0 256Z" fill="#06363d"/><path d="M10 214 Q32 204 54 214" stroke="#9ff7ea" stroke-width="2" fill="none" opacity="0.6"/>`),
      P(`<path d="M150 180 C190 196 196 236 170 256 L110 256 C130 236 130 206 106 182Z" fill="${skin}"/>`, sd),
      P(`<path d="M64 92 C42 70 40 48 52 34 C58 58 70 70 84 76Z M192 92 C214 70 216 48 204 34 C198 58 186 70 172 76Z" fill="#0f6b5a"/>`),
      P(`<path d="${head}" fill="${skin}"/>`),
      P(`<g fill="none" stroke="#0d6a58" stroke-width="2" opacity="0.6">${[0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4].map((c) => `<path d="M${82 + c * 20 + (r % 2) * 10} ${70 + r * 12} q10 9 20 0"/>`).join("")).join("")}</g>`),
      e,
      P(`<path d="M96 156 Q128 172 160 156" stroke="#073d33" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M128 166 L128 186 M128 186 L120 196 M128 186 L136 196" stroke="#ff5a7a" stroke-width="3" fill="none" stroke-linecap="round"/>`),
      rimClip(head, "#8ff7e0", 4, 0.6),
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Stylised portraits

function portrait({ bg, skin, hair, hairShape, shirt, extra = "", eyesColor = "#3b2416", glasses = false, beard = null, rim = "#ffd2a3" }) {
  return avatar(bg, (st) => {
    const [sd, skinFill] = shade(skin, { amount: 0.25 });
    const [hd, hairFill] = shade(hair, { amount: 0.35 });
    const face = "M128 70 C158 70 176 94 176 128 C176 166 154 192 128 194 C102 192 80 166 80 128 C80 94 98 70 128 70Z";
    const e = eyes(128, 132, 21, 7, 6, eyesColor, { lid: 0.3 });
    return [
      groundShadow(st.blur, 128, 248, 92, 12),
      P(hairShape.back ? `<path d="${hairShape.back}" fill="${hairFill}"/>` : "", hd),
      P(`<path d="${bustPath(92, 206)}" fill="${shirt}"/><path d="M108 184 L108 214 Q128 226 148 214 L148 184Z" fill="${skinFill}"/>`, sd),
      P(`<path d="M108 206 Q128 222 148 206" fill="none" stroke="${dark(shirt, 0.3)}" stroke-width="4"/>`),
      P(`<path d="${face}" fill="${skinFill}"/><ellipse cx="80" cy="134" rx="7" ry="11" fill="${skinFill}"/><ellipse cx="176" cy="134" rx="7" ry="11" fill="${skinFill}"/>`),
      P(beard ? `<path d="${beard}" fill="${hairFill}"/>` : ""),
      P(`<path d="${hairShape.front}" fill="${hairFill}"/>`),
      e,
      P(`<path d="M100 118 Q108 113 118 117 M138 117 Q148 113 156 118" stroke="${dark(hair, 0.2)}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`),
      P(`<path d="M128 136 Q132 150 124 154" stroke="${dark(skin, 0.22)}" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="M114 168 Q128 178 142 168" stroke="${dark(skin, 0.45)}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`),
      P(`<circle cx="100" cy="156" r="9" fill="#ff7f7f" opacity="0.2" filter="url(#${st.blur})"/><circle cx="156" cy="156" r="9" fill="#ff7f7f" opacity="0.2" filter="url(#${st.blur})"/>`),
      P(glasses ? `<g fill="none" stroke="#1a1a1f" stroke-width="4"><rect x="92" y="120" width="30" height="24" rx="8"/><rect x="134" y="120" width="30" height="24" rx="8"/><path d="M122 130 L134 130"/></g><path d="M96 124 L104 124" stroke="#fff" stroke-width="2" opacity="0.6"/>` : ""),
      P(extra),
      rimClip(face, rim, 3, 0.55),
    ];
  });
}

const portraitCurls = () =>
  portrait({
    bg: ["#5a1e3a", "#14050d", "#ffb36b"],
    skin: "#8d5a3b",
    hair: "#1d1210",
    shirt: "#e0a43a",
    eyesColor: "#2a170d",
    rim: "#ffc48a",
    hairShape: {
      back: "M60 140 C40 96 70 46 128 44 C186 46 216 96 196 140 C210 170 196 200 176 206 L80 206 C60 200 46 170 60 140Z",
      front: "M80 120 C80 82 102 62 128 62 C154 62 176 82 176 120 C160 96 140 88 128 90 C114 88 96 96 80 120Z",
    },
    extra: `<circle cx="78" cy="152" r="5" fill="#ffd23f"/><circle cx="178" cy="152" r="5" fill="#ffd23f"/>`,
  });

const portraitBeard = () =>
  portrait({
    bg: ["#1d3b52", "#06111a", "#7fd3ff"],
    skin: "#f1c6a5",
    hair: "#6b4226",
    shirt: "#2f4a6b",
    eyesColor: "#3d6b8a",
    glasses: true,
    rim: "#a8e0ff",
    hairShape: {
      front: "M80 118 C78 82 100 60 130 60 C160 60 178 84 176 118 C170 100 150 88 128 88 C108 88 90 98 80 118Z",
    },
    beard: "M82 140 C84 178 104 202 128 204 C152 202 172 178 174 140 C164 160 150 164 128 164 C106 164 92 160 82 140Z",
  });

const portraitHeadphones = () =>
  portrait({
    bg: ["#2d1458", "#0b0418", "#ff5fd2"],
    skin: "#c98b62",
    hair: "#2b1a12",
    shirt: "#1f1f2b",
    rim: "#ff8fe0",
    hairShape: {
      back: "M78 130 C70 96 92 58 128 58 C164 58 186 96 178 130 L176 108 C160 92 96 92 80 108Z",
      front: "M82 112 C88 78 110 62 132 62 C156 64 174 84 174 112 C150 96 116 92 82 112Z",
    },
    extra:
      `<path d="M70 132 C70 74 186 74 186 132" stroke="#ff3dbb" stroke-width="9" fill="none"/>` +
      `<rect x="58" y="118" width="24" height="40" rx="10" fill="#ff3dbb"/><rect x="174" y="118" width="24" height="40" rx="10" fill="#ff3dbb"/>` +
      `<rect x="62" y="124" width="10" height="28" rx="5" fill="#ffd1f2" opacity="0.6"/><path d="M96 222 L160 222" stroke="#ff3dbb" stroke-width="3" opacity="0.6"/>`,
  });

const portraitCap = () =>
  portrait({
    bg: ["#0f4a3a", "#03130e", "#7affc4"],
    skin: "#f5d1b0",
    hair: "#c4672a",
    shirt: "#ffd23f",
    eyesColor: "#2f6b3a",
    rim: "#b8ffe0",
    hairShape: {
      front: "M82 116 C80 104 84 96 92 92 L164 92 C172 96 176 104 174 116 C160 108 96 108 82 116Z",
    },
    extra:
      `<path d="M76 104 C78 64 104 50 130 50 C158 50 180 66 182 104Z" fill="#e5383b"/><path d="M120 100 L210 104 Q214 114 200 116 L120 112Z" fill="#c22a2d"/>` +
      `<circle cx="130" cy="52" r="5" fill="#c22a2d"/><path d="M96 74 Q128 58 160 74" stroke="#fff" stroke-width="4" opacity="0.35" fill="none"/>` +
      `<g fill="#d98f6b" opacity="0.6"><circle cx="104" cy="148" r="1.8"/><circle cx="110" cy="152" r="1.8"/><circle cx="146" cy="148" r="1.8"/><circle cx="152" cy="152" r="1.8"/></g>`,
  });

// ---------------------------------------------------------------------------------------------
// Abstract

function aurora() {
  return avatar(["#04122a", "#01040c", "#2ef2b0"], (st) => {
    const a = id("au");
    const b = id("au");
    const defs = lin(a, [[0, "#2ef2b0", 0], [0.5, "#2ef2b0", 0.9], [1, "#8a5cff", 0]], [0, 0, 1, 0]) + lin(b, [[0, "#5cc8ff", 0], [0.5, "#ff6ad5", 0.7], [1, "#5cc8ff", 0]], [0, 0, 1, 0]);
    return [
      P(`<path d="M-10 120 C40 60 90 160 140 96 S220 70 266 120 L266 150 C220 110 180 130 140 140 S40 120 -10 160Z" fill="url(#${a})" filter="url(#${st.blur})"/>`, defs),
      P(`<path d="M-10 150 C50 110 100 190 160 140 S230 120 266 160 L266 176 C230 150 190 170 150 176 S50 150 -10 186Z" fill="url(#${b})" filter="url(#${st.blur})"/>`),
      P(`<path d="M0 214 L40 180 L72 204 L110 168 L150 200 L190 174 L226 196 L256 182 L256 256 L0 256Z" fill="#020812"/>`),
      P(`<circle cx="40" cy="40" r="1.6" fill="#fff"/><circle cx="200" cy="30" r="1.4" fill="#fff"/><circle cx="120" cy="24" r="1.2" fill="#fff"/>`),
    ];
  });
}

function liquid() {
  return avatar(["#1a0b3d", "#06020f", "#ff6a3d"], (st) => {
    const g1 = id("lq");
    const g2 = id("lq");
    const g3 = id("lq");
    const defs =
      rad(g1, [[0, "#ffb36b"], [1, "#ff3d6e"]], 0.35, 0.35, 0.7) + rad(g2, [[0, "#7a8cff"], [1, "#3a1fa8"]], 0.35, 0.35, 0.7) + rad(g3, [[0, "#6affd7"], [1, "#1a8f9a"]], 0.35, 0.35, 0.7);
    return [
      P(`<path d="M70 60 C120 30 170 70 160 116 C150 160 96 168 70 140 C44 112 38 78 70 60Z" fill="url(#${g1})"/>`, defs),
      P(`<path d="M140 120 C186 96 230 130 218 178 C206 222 150 230 128 196 C110 166 112 134 140 120Z" fill="url(#${g2})"/>`),
      P(`<path d="M40 170 C70 150 108 168 104 200 C100 230 64 238 46 216 C30 198 26 180 40 170Z" fill="url(#${g3})"/>`),
      P(`<ellipse cx="86" cy="72" rx="20" ry="9" fill="#fff" opacity="0.5" transform="rotate(-25 86 72)"/><ellipse cx="166" cy="130" rx="16" ry="7" fill="#fff" opacity="0.4" transform="rotate(-25 166 130)"/><ellipse cx="56" cy="180" rx="10" ry="5" fill="#fff" opacity="0.5" transform="rotate(-25 56 180)"/>`),
    ];
  });
}

function bauhaus() {
  return avatar(["#f1e7d6", "#d9c8ac", "#ffffff"], () => [
    P(`<rect x="0" y="150" width="256" height="106" fill="#1d3557"/>`),
    P(`<circle cx="92" cy="110" r="62" fill="#e63946"/>`),
    P(`<path d="M128 40 L228 210 L28 210Z" fill="#f4a261" opacity="0.95"/>`),
    P(`<rect x="150" y="60" width="64" height="64" fill="#2a9d8f"/>`),
    P(`<path d="M0 230 L256 196" stroke="#f1e7d6" stroke-width="6"/><circle cx="196" cy="196" r="14" fill="#f1e7d6"/>`),
  ]);
}

function synthsun() {
  return avatar(["#2a0845", "#0c0216", "#ff4fd8"], (st) => {
    const sun = id("ss");
    const defs = lin(sun, [[0, "#ffe66b"], [0.5, "#ff8a3d"], [1, "#ff2d8a"]]);
    let lines = "";
    for (let i = 0; i < 6; i++) lines += `<rect x="40" y="${118 + i * 11}" width="176" height="${2 + i}" fill="#2a0845"/>`;
    let grid = "";
    for (let i = 0; i < 7; i++) grid += `<path d="M0 ${168 + i * i * 2.6} L256 ${168 + i * i * 2.6}" stroke="#ff4fd8" stroke-width="1.6" opacity="0.8"/>`;
    for (let i = -6; i <= 6; i++) grid += `<path d="M128 168 L${128 + i * 44} 256" stroke="#ff4fd8" stroke-width="1.4" opacity="0.7"/>`;
    return [
      P(`<circle cx="128" cy="118" r="70" fill="#ff4fd8" opacity="0.4" filter="url(#${st.blur})"/><circle cx="128" cy="118" r="62" fill="url(#${sun})"/>${lines}`, defs),
      P(`<path d="M0 168 L256 168 L256 256 L0 256Z" fill="#12021f"/>${grid}`),
      P(`<path d="M0 168 L30 140 L56 156 L86 132 L110 168Z M146 168 L176 138 L204 154 L230 130 L256 150 L256 168Z" fill="#1a0530"/>`),
    ];
  });
}

// ---------------------------------------------------------------------------------------------

export const COLLECTIONS = [
  { id: "animals", label: "Animals" },
  { id: "fantasy", label: "Fantasy characters" },
  { id: "sci-fi", label: "Science fiction" },
  { id: "arcade", label: "Retro arcade" },
  { id: "space", label: "Space exploration" },
  { id: "monsters", label: "Friendly monsters" },
  { id: "mythical", label: "Mythical creatures" },
  { id: "portraits", label: "Portraits" },
  { id: "abstract", label: "Abstract art" },
];

/** [collection, name, label, draw] */
export const ART = [
  ["animals", "fox", "Fox", fox],
  ["animals", "owl", "Owl", owl],
  ["animals", "panda", "Panda", panda],
  ["animals", "lion", "Lion", lion],
  ["fantasy", "wizard", "Wizard", wizard],
  ["fantasy", "elf", "Elf ranger", elf],
  ["fantasy", "knight", "Knight", knight],
  ["fantasy", "rogue", "Hooded rogue", rogue],
  ["sci-fi", "android", "Android", android],
  ["sci-fi", "alien", "Alien envoy", alien],
  ["sci-fi", "pilot", "Star pilot", pilot],
  ["sci-fi", "mech", "Mech", mech],
  ["arcade", "knight", "Pixel knight", pixelKnight],
  ["arcade", "cat", "Pixel cat", pixelCat],
  ["arcade", "robot", "Pixel robot", pixelRobot],
  ["arcade", "frog", "Pixel frog", pixelFrog],
  ["space", "astronaut", "Astronaut", astronaut],
  ["space", "planetfall", "Planetfall", planetfall],
  ["space", "launch", "Lift-off", launch],
  ["space", "earthrise", "Earthrise", earthrise],
  ["monsters", "cyclops", "Cyclops", cyclops],
  ["monsters", "hornbeast", "Horn beast", hornbeast],
  ["monsters", "blobby", "Blobby", blobby],
  ["monsters", "wisp", "Wisp", wisp],
  ["mythical", "dragon", "Dragon", dragon],
  ["mythical", "phoenix", "Phoenix", phoenix],
  ["mythical", "unicorn", "Unicorn", unicorn],
  ["mythical", "serpent", "Sea serpent", serpent],
  ["portraits", "curls", "Golden hour", portraitCurls],
  ["portraits", "beard", "The professor", portraitBeard],
  ["portraits", "headphones", "Night owl", portraitHeadphones],
  ["portraits", "cap", "Sunny", portraitCap],
  ["abstract", "aurora", "Aurora", aurora],
  ["abstract", "liquid", "Liquid", liquid],
  ["abstract", "bauhaus", "Bauhaus", bauhaus],
  ["abstract", "synthsun", "Synth sun", synthsun],
];
