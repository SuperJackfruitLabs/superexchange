# SuperExchange docs site

The user-facing documentation published at `docs.superexchange.dev`. Astro + Starlight.

```sh
npm install
npm run dev     # http://localhost:4509
npm run build   # -> dist/
```

## Why npm, and why it sits outside the Bun workspace

The service is a Bun workspace over `apps/*`; this site has its own `package.json` and
`package-lock.json`, as `landing/` does, so the two never share a dependency tree. The root's
format, typecheck, lint and tests do not look in here (`.prettierignore` lists `docs-site/`), and
forge CI builds it in its own job only when the site changed.

## What is deliberate about it

**It wears the landing page's identity.** `src/styles/theme.css` maps the landing page's tokens
onto Starlight's gray ramp and accent: azure, `#00a0d7` in dark and `#007aa2` in light, with the
measured contrast of every accent pairing in a comment at the top. `src/components/SiteTitle.astro`
puts the mark beside the name. `public/favicon.svg` and `public/og.png` are
copies of `landing/public/favicon.svg` and `landing/public/og.png` (the suite frame's SuperExchange
logo and share image); change them there and copy them here.

**It says only what ships.** Every page was written from the code (`apps/exchange/src`), the
repository README and `deploy/`, and describes the current release. Where SuperExchange depends on
something another product added (SuperPipeline v0.0.30's reads and notices), the page names the
version. When the code changes, change the page.

**For agents**, `starlight-llms-txt` publishes `/llms.txt`, `/llms-full.txt` and `/llms-small.txt`.

## Publishing

A Cloudflare Worker with static assets (not Pages: wrangler 4.147 no longer creates Pages
projects), named `superexchange-docs`, configured by `docs-site/wrangler.jsonc`. From the repo
root:

```sh
scripts/deploy-sites.sh docs   # builds, then wrangler deploy --config docs-site/wrangler.jsonc
```

The custom domain is declared in the config, so a deploy also attaches it. CI runs this on merge to
main (`.github/workflows/sites.yml`, on the GitHub mirror) with the organisation's Cloudflare token;
by hand it uses your `wrangler login`.

The site is static and has no runtime, so the deploy either served the built tree or it did not.
`curl -sI https://docs.superexchange.dev/operate/run/` is the whole smoke test.
