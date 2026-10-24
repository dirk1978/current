// A stylised side view of a compact electric hatchback (drawn for Current, loosely after a CUPRA Born), as an SVG
// string. paint: body colour; accent: rim/trim colour; charging: draws the cable glow.
'use strict';
window.carSvg = function carSvg({ paint = '#6b7785', accent = '#c8875a', charging = false, plugged = false } = {}) {
  return `<svg viewBox="0 0 640 250" class="car-art" role="img" aria-label="The car">
  <defs>
    <linearGradient id="cBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="color-mix(in oklab, ${paint} 70%, white)"/>
      <stop offset=".45" stop-color="${paint}"/>
      <stop offset="1" stop-color="color-mix(in oklab, ${paint} 55%, black)"/>
    </linearGradient>
    <linearGradient id="cGlass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a3550"/><stop offset=".55" stop-color="#0d1322"/><stop offset="1" stop-color="#1b2540"/>
    </linearGradient>
    <linearGradient id="cShine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="cShadow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".7"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
    <radialGradient id="cRim" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#1a1d24"/><stop offset=".62" stop-color="#2c313b"/><stop offset=".63" stop-color="${accent}"/><stop offset=".7" stop-color="color-mix(in oklab, ${accent} 60%, black)"/><stop offset=".71" stop-color="#15181e"/>
    </radialGradient>
    <filter id="cGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
  </defs>
  <ellipse cx="320" cy="214" rx="290" ry="18" fill="url(#cShadow)"/>
  ${charging ? `<path class="cable" d="M556 130 C600 140 610 190 636 200" fill="none" stroke="var(--car)" stroke-width="6" stroke-linecap="round" filter="url(#cGlow)" opacity=".9"/>` : ''}
  ${plugged || charging ? `<path d="M556 130 C600 140 610 190 636 200" fill="none" stroke="#222833" stroke-width="5" stroke-linecap="round"/>
    ${charging ? `<path class="cable-flow" d="M636 200 C610 190 600 140 556 130" fill="none" stroke="var(--car)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="6 14"/>` : ''}` : ''}
  <!-- body: compact hatchback, short overhangs, high roof, steep tailgate -->
  <path d="M54 166 C48 146 56 130 80 124 L178 106 C206 78 238 56 292 48 L462 44 C506 46 534 58 554 82 L574 112 C590 120 596 136 594 156 L594 168 C594 176 588 182 578 182 L534 182 A50 50 0 0 0 434 182 L202 182 A50 50 0 0 0 102 182 L66 182 C58 182 55 176 54 166 Z" fill="url(#cBody)"/>
  <!-- roof shine, shoulder and sill lines -->
  <path d="M214 86 C246 64 300 54 360 52 L460 50 C500 52 524 62 542 80" fill="none" stroke="url(#cShine)" stroke-width="3"/>
  <path d="M74 138 C210 124 430 118 590 126" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="2"/>
  <path d="M100 160 L560 160" stroke="#000" stroke-opacity=".2" stroke-width="2"/>
  <!-- glass, with the thick C-pillar -->
  <path d="M190 106 C216 80 248 60 296 54 L456 50 C492 52 516 62 532 80 L530 98 L200 110 Z" fill="url(#cGlass)"/>
  <path d="M356 52 L360 106" stroke="#0a0e18" stroke-width="7"/>
  <path d="M452 50 L486 102 L532 99 L532 80 C516 62 492 52 456 50 Z" fill="url(#cBody)"/>
  <path d="M470 60 L500 98" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" opacity=".8"/>
  <path d="M212 104 C238 82 270 66 312 60 L344 59" fill="none" stroke="#fff" stroke-opacity=".12" stroke-width="2"/>
  <!-- tailgate spoiler -->
  <path d="M544 76 L566 84" stroke="#111622" stroke-width="5" stroke-linecap="round"/>
  <!-- lights -->
  <path d="M60 136 L104 128" stroke="#e8f0ff" stroke-width="4" stroke-linecap="round" filter="url(#cGlow)" opacity=".8"/>
  <path d="M60 136 L104 128" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M566 118 L594 128" stroke="${accent}" stroke-width="4" stroke-linecap="round" filter="url(#cGlow)" opacity=".9"/>
  <path d="M566 118 L594 128" stroke="#ff9a6a" stroke-width="2.5" stroke-linecap="round"/>
  <!-- door handles, mirror, charge flap -->
  <rect x="286" y="126" width="26" height="4" rx="2" fill="#000" opacity=".35"/>
  <rect x="404" y="124" width="26" height="4" rx="2" fill="#000" opacity=".35"/>
  <path d="M196 112 L212 106 L218 116 L200 120 Z" fill="color-mix(in oklab, ${paint} 50%, black)"/>
  <rect x="548" y="124" width="14" height="10" rx="2" fill="none" stroke="#000" stroke-opacity=".3"/>
  <!-- wheels -->
  ${[152, 484].map((x) => `
  <circle cx="${x}" cy="182" r="46" fill="#0b0d12"/>
  <circle cx="${x}" cy="182" r="40" fill="#14171d"/>
  <circle cx="${x}" cy="182" r="31" fill="url(#cRim)"/>
  <g stroke="${accent}" stroke-width="3" stroke-linecap="round" opacity=".85">
    ${[0, 72, 144, 216, 288].map((a) => `<line x1="${x}" y1="182" x2="${x + 27 * Math.cos((a * Math.PI) / 180)}" y2="${182 + 27 * Math.sin((a * Math.PI) / 180)}"/>`).join('')}
  </g>
  <circle cx="${x}" cy="182" r="7" fill="#20242c" stroke="${accent}" stroke-width="1.5"/>`).join('')}
</svg>`;
};
