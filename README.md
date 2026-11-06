# Aman Yadav — Portfolio

Personal portfolio of **Aman Yadav**, Unity 3D | VR Developer (Mobile · VR/AR · Multiplayer) — currently building physics-driven VR titles at **Sloppy Studios**.

Built on the same one-page static site as Prashant Gupta's portfolio (Imroz template + custom layer: hero particles, typing role rotator, skills tabs, build pipeline, career highlights, reviews wall, portfolio grid, **10-game Mini Arcade**, **Neon Room** physics toy, **Plan Your Build** estimator, WhatsApp contact, print-ready CV page) with Aman's details, games and branding swapped in.

**No backend.** The arcade's Firebase leaderboard and the WebRTC/Firestore 1v1 mode were removed from this build: high scores are saved on the device only, and Packet Pong is single player vs the AI.

---

## Featured titles

| Title | Platform | Store |
| --- | --- | --- |
| Newton's Playground: Physics Sandbox | Meta Quest VR · ★4.9 · 15,000+ reviews | [Meta Horizon Store](https://www.meta.com/en-gb/experiences/newtons-playground-physics-sandbox/24802835455982621/) |
| Metaspace | Android / iOS · ★4.6 App Store | [Google Play](https://play.google.com/store/apps/details?id=com.MetaspaceTechnologiesPrivateLimited.Metaspace) · [App Store](https://apps.apple.com/in/app/metaspace-game/id6462402154) |
| Learn with Kidzee (AR) | iOS / Android · Zee Learn | [App Store](https://apps.apple.com/in/app/learnwithkidzee/id1602189314) · [Google Play](https://play.google.com/store/apps/details?id=com.zeelearn.LearnWithKidzee) |
| Car Parking Simulator | Android | _store link to be confirmed_ |

## ⚠️ To confirm with Aman

These were filled in from his CV and the WhatsApp chat; the rest is inferred and marked `TODO` in the source:

- **LinkedIn URL** — currently `https://www.linkedin.com/in/aman-yadav` (placeholder slug). Search `LINKEDIN` in `index.html`, `cv.html`.
- **Car Parking Simulator store link** — currently a Play Store search URL. Search `car%20parking` in `index.html`.
- **Experience dates / companies** — Sloppy Studios (Sep 2025 – present) and MetaSpace (2021 – 2025) mirror the studios behind the games he listed; the 2020–2021 role is labelled "AR & mobile projects". Fix in the Experience tab (`index.html`) and `cv.html`.
- **Cover art** — `assets/images/portfolio/game-kidzee.jpg` and `game-parking.jpg` are generated placeholders (1440×810). Replace with real store art.
- **Live URL** — the site is published on GitHub Pages at `https://prashant1998gupta.github.io/Aman_portfolio/`. If it ever moves (custom domain / Vercel), update `index.html` (canonical, `og:*`), `cv.html`, `neon.html`, `robots.txt`, `sitemap.xml`.
- **Availability line**, GitHub (none linked right now), photo — add if wanted.

## Key files

```
index.html                  main one-page site
cv.html                     CV page (Print / Save as PDF button)
neon.html                   the Neon Room physics toy
vercel.json                 clean URLs (/cv, /neon), caching + security headers
robots.txt / sitemap.xml    SEO
assets/css/custom.css       custom design layer (versioned ?v=N)
assets/js/custom.js         nav fix, typing roles, hero particles, estimator, Konami
assets/js/arcade.js         arcade engine + 10 games (leaderboard disabled: LB_ENABLED = false)
assets/js/neon.js           the Neon Room
assets/images/logo/logo-mark.svg   "A + play button" brand mark
assets/images/portfolio/game-*.jpg store art / placeholder covers
assets/images/og-cover.jpg  social share image (1200×630)
```

## Development

```bash
python -m http.server 8000
```

**Cache busting:** when editing `custom.css` / `custom.js` / `arcade.js`, bump the `?v=N` query in `index.html`.

## Deployment

**GitHub Pages** (current): the `master` branch root is published at https://prashant1998gupta.github.io/Aman_portfolio/ — every push to `master` redeploys. Links use `cv.html` / `neon.html` so no clean-URL rewrites are needed.

**Vercel** (optional): import the repo; `vercel.json` adds clean URLs (`/cv`, `/neon`), asset cache headers and security headers.
