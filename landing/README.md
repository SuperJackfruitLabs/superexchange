# SuperExchange landing page

The public page at `superexchange.dev`. Astro, one page and a 404, inside the suite frame
(`@superjackfruit/frontdoor`), with one small inline script for "How it works".

```sh
npm install
npm run dev     # http://localhost:4508
npm run build   # -> dist/, then checks the frame is in the HTML
```

## How it deploys

A Cloudflare Worker with static assets named `superexchange-site`, configured by
`landing/wrangler.jsonc`. From the repo root:

```sh
scripts/deploy-sites.sh   # builds, then wrangler deploy --config landing/wrangler.jsonc
```

The custom domains (the apex and `www`) are declared in the config, so a deploy also attaches
them. CI runs this on merge to main (`.github/workflows/sites.yml`, on the GitHub mirror) with the
organisation's Cloudflare token; by hand it uses your `wrangler login`.

`assets.not_found_handling: "404-page"` serves `dist/404.html` with a real 404 status for any path
that has no file, which is why `src/pages/404.astro` exists.

## Why npm, and why it sits outside the Bun workspace

The service is a Bun workspace over `apps/*`; this site has its own `package.json` and
`package-lock.json` so the two never share a dependency tree. The root's format, typecheck, lint
and tests do not look in here (`.prettierignore` lists `landing/`), and forge CI builds it in its
own job only when `landing/` changed.

## What is deliberate about the page

**The hero is a board room**, not a headline over a gradient: the one thing SuperExchange does is
carry a board's decision into chat and the answer back, so the page shows that exchange. Its
wording is treaty's (the gate.v2 prose, the card's title, the receipt line); the card title and the
names are made up, and the caption says so. The comment at the top of `src/pages/index.astro` maps
each string to its source.

**"How it works" is scrubbed by scroll.** One panel (`src/components/Path.astro`) is pinned beside
four steps; the step nearest the viewport's centre sets its beat. Nothing advances on a timer. On a
phone each step carries its own copy of the panel, fixed at its beat.

**"Where it is today" is the README's own limits**: what SuperPipeline must still do, and that no
production board has moved yet. When one of those changes, change the page.

**Azure is the product colour** (hue 230): the frame's `#00a0d7` in dark and vibekit's Daylight
azure `#007aa2` in light (the frame colour is 2.9:1 on a light ground), hard-coded in `:root`
until vibekit names SuperExchange.

**One mark.** The header, the favicon, the source line at the end of the page, the 404 and
`og.png` all show the suite frame's SuperExchange logo. `src/components/Mark.astro` reads it from
the frontdoor package at build time; `public/favicon.svg` is a byte-for-byte copy, and the build
(`scripts/check-frame.mjs`) fails when the two differ. After a frontdoor upgrade that changes the
logo, copy `node_modules/@superjackfruit/frontdoor/src/brand/superexchange.svg` to
`public/favicon.svg`.

**The link preview** (`public/og.png`, 1200×630) comes from the suite frame's shared template:
`node scripts/og/render.mjs` in the frontdoor repository writes `superexchange.png`; copy it here.

**The docs live at `docs.superexchange.dev`** (`docs-site/`). The page itself still links the
README; the frame's header and footer take their docs link from frontdoor.
