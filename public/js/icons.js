// Inline-SVG-Icons (Strichstärke 1.75, currentColor)
const a = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

export const icons = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect x="6" y="5" width="21" height="24" rx="1.5" fill="#ece6d6"/>
    <rect x="4.5" y="3.5" width="21" height="24" rx="1.5" fill="#fffdf7" stroke="rgba(0,0,0,.18)"/>
    <rect x="4" y="3" width="22" height="5" rx="1.5" fill="#8e3c2f"/>
    <path d="M9.5 8v19.5" stroke="#eba3a0"/>
    <path d="M7 13h16M7 17h16M7 21h16M7 25h16" stroke="#c7d8ea"/>
    <path d="M12 16.6h8M12 20.6h5" stroke="#2b2924" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`,
  menu: `<svg ${a}><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  plus: `<svg ${a}><path d="M12 5v14M5 12h14"/></svg>`,
  trash: `<svg ${a}><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/></svg>`,
  restore: `<svg ${a}><path d="M4 10h11a5 5 0 0 1 0 10h-4"/><path d="M8 6l-4 4 4 4"/></svg>`,
  user: `<svg ${a}><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-3.5 4.4-5 8-5s6.5 1.5 8 5"/></svg>`,
  back: `<svg ${a}><path d="M19 12H5M11 6l-6 6 6 6"/></svg>`,
  close: `<svg ${a}><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  check: `<svg ${a}><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  device: `<svg ${a}><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M11 18h2"/></svg>`,
  key: `<svg ${a}><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M14 9l2 2"/></svg>`,
  chevronDown: `<svg ${a}><path d="M6 9l6 6 6-6"/></svg>`,
  logout: `<svg ${a}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/></svg>`,
  cloud: `<svg ${a}><path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z"/></svg>`,
  cloudOff: `<svg ${a}><path d="M3 3l18 18"/><path d="M8.5 6.4A6 6 0 0 1 17.5 10a4 4 0 0 1 2.4 6.9M16 18H7a4.25 4.25 0 0 1-.9-8.5"/></svg>`,
  copy: `<svg ${a}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>`,
  shield: `<svg ${a}><path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>`,
  mail: `<svg ${a}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
  userPlus: `<svg ${a}><circle cx="10" cy="8" r="4"/><path d="M3 20c1.4-3.4 4-5 7-5s5.6 1.6 7 5M19 8v6M16 11h6"/></svg>`,
  chevronRight: `<svg ${a}><path d="M9 6l6 6-6 6"/></svg>`,
  warning: `<svg ${a}><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>`,
};

/** Ersetzt alle [data-icon]-Platzhalter unterhalb von root durch das SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]:empty')) {
    const svg = icons[el.dataset.icon];
    if (svg) el.innerHTML = svg;
  }
}
