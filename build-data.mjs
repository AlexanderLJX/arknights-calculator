// Regenerates the operator data embedded in index.html from the game's own data files.
//
//   node build-data.mjs        -> Global / EN server (default)
//   node build-data.mjs jp     -> other servers: en, jp, kr, tw, cn
//                                 (tw/cn tag names are Chinese; the OCR only reads English)
//
// Source: https://github.com/ArknightsAssets/ArknightsGamedata (updated with each game patch)
// Reads gacha_table.json (the in-game "Recruitment details" list + tag names) and
// character_table.json (class, position and affix tags of each operator), then rewrites
// the block between /*DATA_START*/ and /*DATA_END*/ in index.html.
// Exits with an error, without writing, if anything doesn't line up.
//
// Also downloads any missing operator avatars into avatars/<char id>.webp (96px), from
// https://github.com/yuanyan3060/ArknightsGameResource. Needs `npm install` once (sharp).
// A missing avatar only prints a warning; the page shows a placeholder until a later run.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";

const region = process.argv[2] || "en";
const base = `https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/master/${region}/gamedata/excel`;

async function get(name, json = true) {
  console.log(`Downloading ${region}/${name} ...`);
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

const [gacha, chars, versionTxt] = await Promise.all([
  get("gacha_table.json"),
  get("character_table.json"),
  get("data_version.txt", false).catch(() => ""),
]);
const version = (versionTxt.match(/VersionControl:(\S+)/) || [])[1] || "?";

const problems = [];

// Tag names exactly as the game shows them (ids 1-29; 1012/1013 are hidden gender tags).
const gTags = gacha.gachaTags.filter((t) => t.tagId < 1000).sort((a, b) => a.tagId - b.tagId);
gTags.forEach((t, i) => { if (t.tagId !== i + 1) problems.push(`tag ids not contiguous at ${t.tagId}`); });
const tags = gTags.map((t) => t.tagName);
const tagById = Object.fromEntries(gTags.map((t) => [t.tagId, t.tagName]));

// Fixed tag ids from gacha_table (the same on every server).
const PROFESSION_TAG = { WARRIOR: 1, SNIPER: 2, TANK: 3, MEDIC: 4, SUPPORT: 5, CASTER: 6, SPECIAL: 7, PIONEER: 8 };
const POSITION_TAG = { MELEE: 9, RANGED: 10 };
const TOP = 11, SENIOR = 14, STARTER = 17;

// recruitDetail is rich text: "★★★\n<@rc.eml>Adnachiel</> / Fang / ...". Green (rc.eml) = recruitment only.
const recruitable = [];
for (const block of gacha.recruitDetail.split(/-{5,}/)) {
  const m = block.match(/(★+)\s*\n([\s\S]*)$/);
  if (!m) continue;
  const rarity = m[1].length;
  for (const raw of m[2].split(/(?<!<)\/(?!>)/)) { // split on "/" but not on the "</>" markup
    const only = raw.includes("<@rc.eml>");
    const name = raw.replace(/<[^>]*>/g, "").trim();
    if (name) recruitable.push({ name, rarity, only });
  }
}

// character_table rarity is "TIER_5" in new data, 0-based 4 in old data.
const rarityOf = (c) => (typeof c.rarity === "number" ? c.rarity + 1 : +String(c.rarity).replace("TIER_", ""));
// Names can differ in punctuation ("'Justice Knight'"), so compare letters and digits only.
const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const byName = new Map();
for (const [id, c] of Object.entries(chars)) {
  if (!id.startsWith("char_")) continue;
  const k = key(c.name);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push({ id, ...c });
}

const operators = [];
for (const r of recruitable) {
  // Several characters can share a name (e.g. alternate versions); take the one with the listed rarity.
  const c = (byName.get(key(r.name)) || []).find((x) => rarityOf(x) === r.rarity && !x.isNotObtainable)
    || (byName.get(key(r.name)) || []).find((x) => rarityOf(x) === r.rarity);
  if (!c) { problems.push(`${r.name} (${r.rarity}★) not found in character_table`); continue; }
  if (!(c.profession in PROFESSION_TAG)) problems.push(`${r.name}: unknown class ${c.profession}`);
  if (!(c.position in POSITION_TAG)) problems.push(`${r.name}: unknown position ${c.position}`);
  const t = new Set([tagById[PROFESSION_TAG[c.profession]], tagById[POSITION_TAG[c.position]]]);
  for (const x of c.tagList || []) {
    if (!tags.includes(x)) problems.push(`${r.name}: tag "${x}" is not a recruitment tag`);
    t.add(x);
  }
  if (r.rarity === 6) t.add(tagById[TOP]);
  if (r.rarity === 5) t.add(tagById[SENIOR]);
  if (r.rarity === 2) t.add(tagById[STARTER]);
  const tagIdx = [...t].filter((x) => tags.includes(x)).map((x) => tags.indexOf(x));
  // compact row: [name, rarity, recruitmentOnly(0/1), [tag indexes], char id]
  operators.push([r.name, r.rarity, r.only ? 1 : 0, tagIdx, c.id]);
}

const names = operators.map((o) => o[0]);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length) problems.push(`duplicate operators: ${dupes.join(", ")}`);
if (operators.length < 100) problems.push(`only ${operators.length} operators parsed; recruitDetail format may have changed`);

if (problems.length) {
  console.error("Problems found, index.html NOT updated:\n  " + problems.join("\n  "));
  process.exit(1);
}

const file = new URL("./index.html", import.meta.url);
const html = await readFile(file, "utf8");
const block = html.match(/\/\*DATA_START\*\/([\s\S]*?)\/\*DATA_END\*\//);
if (!block) throw new Error("DATA markers not found in index.html");
let old = {};
try { old = JSON.parse(block[1]); } catch {}

// GitHub Actions: report the result to later workflow steps.
async function output(changed, summary) {
  if (!process.env.GITHUB_OUTPUT) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nsummary=${summary}\n`);
}

// Avatars: fetch only the ones not in avatars/ yet, shrink to 96px WebP (~3-6 KB each).
const AVATAR_SRC = "https://raw.githubusercontent.com/yuanyan3060/ArknightsGameResource/main/avatar";
const avatarDir = new URL("./avatars/", import.meta.url);
await mkdir(avatarDir, { recursive: true });
const exists = (u) => access(u).then(() => true, () => false);
const missingAvatars = [];
for (const o of operators) if (!(await exists(new URL(`${o[4]}.webp`, avatarDir)))) missingAvatars.push(o);
const addedAvatars = [], failedAvatars = [];
if (missingAvatars.length) {
  const { default: sharp } = await import("sharp");
  console.log(`Downloading ${missingAvatars.length} avatar(s) ...`);
  for (const o of missingAvatars) {
    try {
      const res = await fetch(`${AVATAR_SRC}/${o[4]}.png`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const img = await sharp(Buffer.from(await res.arrayBuffer())).resize(96, 96).webp({ quality: 82 }).toBuffer();
      await writeFile(new URL(`${o[4]}.webp`, avatarDir), img);
      addedAvatars.push(o[0]);
    } catch (e) {
      failedAvatars.push(o[0]);
      console.warn(`  ! avatar for ${o[0]} (${o[4]}) not available yet: ${e.message}`);
    }
  }
}

// Only rewrite when the recruitment data itself changed (not just the build date),
// so a scheduled run with no game update produces no commit.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (old.region === region && same(old.tags, tags) && same(old.operators, operators)) {
  if (addedAvatars.length) {
    console.log(`Data unchanged; added avatars: ${addedAvatars.join(", ")}`);
    await output(true, `avatars for ${addedAvatars.join(", ")}`);
  } else {
    console.log(`No changes: ${operators.length} operators, ${region} data ${version}. index.html left as is.`);
    await output(false, "");
  }
  process.exit(0);
}

const data = { region, version, updated: new Date().toISOString().slice(0, 10), tags, operators };
await writeFile(file, html.replace(block[0], () => `/*DATA_START*/${JSON.stringify(data)}/*DATA_END*/`));

const oldNames = new Set((old.operators || []).map((o) => o[0]));
const newNames = new Set(operators.map((o) => o[0]));
const added = [...newNames].filter((n) => !oldNames.has(n));
const removed = [...oldNames].filter((n) => !newNames.has(n));
const parts = [];
if (added.length) parts.push(`added ${added.join(", ")}`);
if (removed.length) parts.push(`removed ${removed.join(", ")}`);
if (!parts.length) parts.push("operator data changes");
const summary = `${region} data ${version}: ${parts.join("; ")}`;

const per = [1, 2, 3, 4, 5, 6].map((r) => `${r}★ ${operators.filter((o) => o[1] === r).length}`).join(", ");
console.log(`Wrote ${operators.length} operators (${per}), ${tags.length} tags, ${region} data ${version} into index.html`);
console.log(summary);
await output(true, summary);
