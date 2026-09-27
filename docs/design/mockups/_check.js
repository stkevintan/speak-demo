/* Layout self-check for the mockups.
 *
 * Every snapshot is a fixed 1440x900 frame with overflow:hidden, so content that
 * spills is clipped silently. This walks the frame and reports anything outside
 * the canvas plus the overall content extent, so `--dump-dom` can assert the
 * layout instead of relying on a human eyeball.
 *
 * Elements that are *meant* to sit outside the frame (ambient blobs, the mascot
 * that overlaps a card edge) opt out with data-bleed.
 */
window.addEventListener("load", () => {
  const s = document.querySelector(".screen");
  const sr = s.getBoundingClientRect();
  const bad = [];
  let maxBottom = 0;
  let maxRight = 0;

  s.querySelectorAll("*").forEach((el) => {
    if (el.hasAttribute("data-bleed")) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    maxBottom = Math.max(maxBottom, r.bottom - sr.top);
    maxRight = Math.max(maxRight, r.right - sr.left);
    if (r.bottom > sr.bottom + 1 || r.right > sr.right + 1) {
      const cls = typeof el.className === "string" ? el.className : "";
      bad.push(
        `${el.tagName.toLowerCase()}.${cls.split(" ")[0]} b${Math.round(r.bottom - sr.top)} r${Math.round(r.right - sr.left)}`,
      );
    }
  });

  // Cards clip their own content (overflow:hidden), so text that outgrows its
  // box disappears without ever leaving the 1440x900 frame. Compare scroll vs
  // client extent on every clipping box to catch that silently-truncated case.
  const clipped = [];
  s.querySelectorAll("*").forEach((el) => {
    if (el.hasAttribute("data-bleed") || el.classList.contains("screen")) return;
    const cs = getComputedStyle(el);
    if (cs.overflowY !== "hidden" && cs.overflowX !== "hidden") return;
    if (cs.position === "absolute") return; // ambient decoration
    const overY = el.scrollHeight - el.clientHeight;
    const overX = el.scrollWidth - el.clientWidth;
    if (overY > 2 || overX > 2) {
      const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
      clipped.push(`${el.tagName.toLowerCase()}.${cls} +${overY}y +${overX}x`);
    }
  });

  // SVG defs are referenced by id, so a repeated id silently makes later
  // instances render with the first one's gradient.
  const ids = {};
  const dupes = [];
  document.querySelectorAll("[id]").forEach((el) => {
    if (el.id === "__diag") return;
    ids[el.id] = (ids[el.id] || 0) + 1;
  });
  Object.keys(ids).forEach((id) => {
    if (ids[id] > 1) dupes.push(`${id} x${ids[id]}`);
  });

  // Colour contrast. Text over a gradient can't be measured from computed
  // styles, so those containers declare their lightest stop via data-contrast-bg.
  const toRgb = (c) => {
    if (!c) return null;
    if (c[0] === "#") {
      const h = c.slice(1);
      const f = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
      return {
        r: parseInt(f.slice(0, 2), 16),
        g: parseInt(f.slice(2, 4), 16),
        b: parseInt(f.slice(4, 6), 16),
        a: 1,
      };
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const chan = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const contrast = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  // A gradient has no single background, so return both extremes and score the
  // text against whichever one it does worse on.
  const bgCandidates = (el) => {
    const layers = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const bc = toRgb(cs.backgroundColor);
      const img = cs.backgroundImage;
      if (img && img.includes("gradient")) {
        const own = bc && bc.a === 1 ? bc : { r: 255, g: 255, b: 255, a: 1 };
        const stops = [];
        const re = /rgba?\([^)]*\)/g;
        let m;
        while ((m = re.exec(img))) {
          const c = toRgb(m[0]);
          if (c) stops.push(c.a === 0 ? own : over(c, own));
        }
        if (!stops.length) return null;
        let lo = stops[0];
        let hi = stops[0];
        stops.forEach((c) => {
          if (lum(c) < lum(lo)) lo = c;
          if (lum(c) > lum(hi)) hi = c;
        });
        layers.push(lo, hi);
        break;
      }
      if (bc && bc.a > 0) {
        layers.push(bc);
        if (bc.a === 1) break;
      }
    }
    if (!layers.length) return null;
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return [base];
  };

  const lowContrast = [];
  let unchecked = 0;
  s.querySelectorAll("*").forEach((el) => {
    if (el.id === "__diag" || el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    if (!el.hasAttribute("data-contrast-bg") && el.closest("[data-contrast-bg]")) return;
    const own = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 1,
    );
    if (!own) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return;
    let op = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      op *= parseFloat(getComputedStyle(n).opacity);
    }
    const fg = toRgb(cs.color);
    if (fg) fg.a *= op;
    const cands = bgCandidates(el);
    if (!fg || !cands) {
      unchecked++;
      return;
    }
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    const worst = cands
      .map((c) => contrast(over(fg, c), c))
      .reduce((a, b) => Math.min(a, b));
    const bg = cands.reduce((a, b) => (lum(a) < lum(b) ? a : b));
    const r = worst;
    if (r < need - 0.01) {
      const hex = (c) =>
        "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
      const cls = typeof el.className === "string" ? el.className.split(" ")[0] : "";
      lowContrast.push(
        `${el.tagName.toLowerCase()}.${cls} ${r.toFixed(2)}<${need} ${hex(over(fg, bg))}/${hex(bg)} "${el.textContent.trim().slice(0, 22)}"`,
      );
    }
  });

  const errs = [];
  if (bad.length) errs.push("OVERFLOW: " + bad.slice(0, 8).join(" ; "));
  if (dupes.length) errs.push("DUPLICATE ID: " + dupes.slice(0, 6).join(" ; "));
  if (clipped.length) errs.push("CLIPPED: " + clipped.slice(0, 8).join(" ; "));
  if (maxBottom > 900) errs.push(`maxBottom=${Math.round(maxBottom)}`);
  if (maxRight > 1440) errs.push(`maxRight=${Math.round(maxRight)}`);
  if (lowContrast.length) errs.push("LOW CONTRAST: " + lowContrast.slice(0, 8).join(" ; "));

  const diag = document.createElement("div");
  diag.id = "__diag";
  diag.textContent = errs.length
    ? errs.join(" || ")
    : `OK bottom=${Math.round(maxBottom)} right=${Math.round(maxRight)}` +
      (unchecked ? ` unverified=${unchecked}` : "");
  document.body.appendChild(diag);
});
