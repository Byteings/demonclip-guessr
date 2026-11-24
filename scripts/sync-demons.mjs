/**
 * Sync the demon list from the public Pointercrate API.
 * Run: node scripts/sync-demons.mjs
 *
 * Endpoint: https://pointercrate.com/api/v2/demons/listed/
 * Docs: https://pointercrate.com/documentation/demons/
 */

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://pointercrate.com/api/v2/demons/listed/";
const PAGE_SIZE = 100;

/** Extract a YouTube video ID from the URLs Pointercrate stores. */
function youtubeId(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.slice(1) || null;
    if (host.endsWith("youtube.com")) {
      const v = parsed.searchParams.get("v");
      if (v) return v;
      const parts = parsed.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((p) => ["embed", "shorts", "v"].includes(p));
      if (marker !== -1 && parts[marker + 1]) return parts[marker + 1];
    }
  } catch {
    /* malformed URL */
  }
  return null;
}

function cleanPlayer(player) {
  if (!player) return null;
  return { id: player.id, name: player.name, banned: Boolean(player.banned) };
}

async function fetchPage(after) {
  const url = `${BASE}?limit=${PAGE_SIZE}${after ? `&after=${after}` : ""}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "DemonClipGuessr/1.0 (static data sync)" },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

const raw = [];
let after = 0;
let page = 0;

while (true) {
  const batch = await fetchPage(after);
  raw.push(...batch);
  page += 1;
  if (batch.length < PAGE_SIZE) break;
  after = batch[batch.length - 1].position;
  if (page > 30) throw new Error("Refusing to sync more than 30 pages");
}

// De-duplicate by position (API can contain legacy duplicate entries).
const seen = new Set();
const demons = [];

for (const d of raw) {
  if (!d || typeof d.position !== "number") continue;
  if (seen.has(d.position)) continue;
  seen.add(d.position);

  const videoId = youtubeId(d.video);
  // This file is server-only. The browser never receives this name/video map.
  demons.push({
    id: d.id,
    position: d.position,
    ratedPosition: d.rated_position ?? null,
    name: d.name,
    requirement: d.requirement ?? null,
    verifier: cleanPlayer(d.verifier),
    publisher: cleanPlayer(d.publisher),
    levelId: d.level_id ?? null,
    videoId,
    rated: Boolean(d.rated),
  });
}

demons.sort((a, b) => a.position - b.position);

const output = {
  source: "https://pointercrate.com/api/v2/demons/listed/",
  docs: "https://pointercrate.com/documentation/demons/",
  syncedAt: new Date().toISOString(),
  total: demons.length,
  playable: demons.filter((d) => d.videoId).length,
  demons,
};

const jsonTarget = resolve(ROOT, "data", "demons.json");
await mkdir(dirname(jsonTarget), { recursive: true });
await writeFile(jsonTarget, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Synced ${output.total} listed demons (${output.playable} with playable clips)`);
console.log(`  ${jsonTarget}`);
