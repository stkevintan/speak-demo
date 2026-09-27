/* Minimal stroke icon set so the mockups don't depend on an icon font. */

const ICON_PATHS = {
  target:
    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.4" fill="CUR"/>',
  check: '<path d="M4.5 12.6 l5 5 L19.5 6.8"/>',
  warn: '<path d="M12 4.2 L21 19.5 H3 Z"/><path d="M12 10 v4"/><circle cx="12" cy="16.8" r=".9" fill="CUR"/>',
  sparkle:
    '<path d="M12 3.5 l2.2 5.6 5.6 2.2 -5.6 2.2 -2.2 5.6 -2.2 -5.6 -5.6 -2.2 5.6 -2.2 z"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0"/><path d="M12 18 v3"/>',
  micOff:
    '<path d="M15 5.5 a3 3 0 0 0 -6 0 V11"/><path d="M5.5 11.5 a6.5 6.5 0 0 0 10.2 5.4"/><path d="M12 18 v3"/><path d="M4 4 L20 20"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M7 10 h.01 M11 10 h.01 M15 10 h.01 M7 14 h10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5 V12 l3 2"/>',
  settings:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5 v2 M12 18.5 v2 M3.5 12 h2 M18.5 12 h2 M6 6 l1.4 1.4 M16.6 16.6 L18 18 M18 6 l-1.4 1.4 M7.4 16.6 L6 18"/>',
  chevron: '<path d="M9.5 5.5 L16 12 l-6.5 6.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="3"/><path d="M8 10.5 V8 a4 4 0 0 1 8 0 v2.5"/>',
  bolt: '<path d="M13.5 3 L5.5 13.5 H11 L10 21 L18.5 10.5 H13 Z"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.6" ry="8.5"/><path d="M4 9.5 h16 M4 14.5 h16"/>',
  heart:
    '<path d="M12 20 C5 15.5 3.5 11.5 5.5 8.6 7.2 6.2 10.6 6.4 12 9 c1.4 -2.6 4.8 -2.8 6.5 -.4 2 2.9 .5 6.9 -6.5 11.4 z"/>',
  arrowRight: '<path d="M4.5 12 h14"/><path d="M13 6.5 l5.5 5.5 -5.5 5.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  speaker:
    '<path d="M4 9.5 h3.5 L12 5.5 v13 L7.5 14.5 H4 z"/><path d="M15.5 9.5 a3.5 3.5 0 0 1 0 5"/><path d="M18 7 a7 7 0 0 1 0 10"/>',
  type: '<path d="M4 6.5 h16"/><path d="M12 6.5 V19"/><path d="M8 19 h8"/>',
  refresh:
    '<path d="M20 12 a8 8 0 1 1 -2.6 -5.9"/><path d="M20 4.5 V9 h-4.5"/>',
  eye: '<path d="M2.5 12 C6 6.5 18 6.5 21.5 12 C18 17.5 6 17.5 2.5 12 z"/><circle cx="12" cy="12" r="3"/>',
  users:
    '<circle cx="9" cy="9" r="3.4"/><path d="M3.5 19 c0 -3.3 2.5 -5.4 5.5 -5.4 s5.5 2.1 5.5 5.4"/><path d="M16 6.2 a3.4 3.4 0 0 1 0 6.6"/><path d="M17 13.9 c2.2 .6 3.5 2.4 3.5 5.1"/>',
};

function icon(name, size = 20, color = "currentColor", sw = 2) {
  const body = (ICON_PATHS[name] || "").replace(/CUR/g, color);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="${color}" stroke-width="${sw}" stroke-linecap="round"
    stroke-linejoin="round" style="flex:none">${body}</svg>`;
}
