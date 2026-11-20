# Arknights Recruitment Calculator

An Arknights recruitment tag calculator in a single `index.html`. Paste a screenshot of the
Recruitment screen and it reads the 5 tags locally in your browser (Tesseract OCR compiled to
WebAssembly, CPU only, no uploads), then lists every tag combination that guarantees 4★+,
5★, 6★ or a 1★ Robot.

## Setup (once)
Settings → Pages → Build and deployment → Source: **GitHub Actions**.

The workflow in `.github/workflows/update-and-deploy.yml` then deploys the site on every
push to `main`.

## Automatic data updates
Every hour the workflow reads the game data's version number (a tiny file). If it's the
same version the site already has, it stops there. When a game patch lands in the data
repo, it downloads the full Global (EN) game data and rebuilds the operator list. If
operators or tags changed, it commits the new `index.html` (the commit message lists what
changed) and redeploys. A full rebuild also runs once a day as a safety net. You can run it
by hand from the Actions tab ("Run workflow").

If the game data format ever changes, `build-data.mjs` refuses to write, the run fails and
GitHub emails you; the live site keeps the last good data.

Note: GitHub pauses scheduled workflows in repos with no activity for 60 days. Data-update
commits count as activity, but if it ever gets paused, re-enable it in the Actions tab.

## Operator avatars
`avatars/<char id>.webp` (96px, about 5 KB each) are downloaded by `build-data.mjs` from
https://github.com/yuanyan3060/ArknightsGameResource and shrunk with `sharp`. Only missing
ones are fetched, so a new operator's avatar is added automatically on the next update; if it
isn't available yet, the page shows the operator's initial until a later run picks it up.
Operator images © Hypergryph / Yostar.

## Update data by hand
Requires Node 18+ and `npm install` once:

    node build-data.mjs          # Global (EN) server
    node build-data.mjs jp       # or kr

Data source: https://github.com/ArknightsAssets/ArknightsGamedata (updated each game patch).
The script refuses to write if any operator or tag fails to match.

## How tag recognition works
1. Find dark, button-shaped rectangles on a light panel (connected components on a luminance mask).
2. Crop each, binarize with Otsu (text = minority colour), upscale, OCR as a single line.
3. Fuzzy-match the text (Levenshtein) against the 29 known tag names.
4. If fewer than 5 matched, infer the rest of the 3×2 tag grid from the found buttons and read those cells.
