import { readFile } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";

const DATA_PATH = new URL("../data/demons.json", import.meta.url);
const HINT_INTERVAL_MS = 30_000;
const ROUND_DEADLINE_MS = 120_000;
const PLAYER_TIMEOUT_MS = 12_000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const VALID_POOLS = new Set(["top25", "top100", "top250", "all", "unidentified"]);

export function normalise(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b2\b/g, "ii")
    .replace(/\b3\b/g, "iii")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tier(position) {
  if (position <= 25) return 2;
  if (position <= 100) return 1.6;
  if (position <= 250) return 1.3;
  return 1;
}

// Lower Pointercrate position = more popular. Weighting by inverse rank makes
// the most popular demons appear more often while still letting every level
// show up occasionally.
function demonWeight(demon) {
  return 1 / Math.max(1, Number(demon?.position) || 1);
}

function pickWeighted(list) {
  if (!list || !list.length) return null;
  const weights = list.map(demonWeight);
  let total = 0;
  for (const weight of weights) total += weight;
  let roll = Math.random() * total;
  for (let i = 0; i < list.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return list[i];
  }
  return list[list.length - 1];
}

function makeHints(demon) {
  const letters = [...demon.name].filter((char) => /[a-z]/i.test(char));
  const words = demon.name.trim().split(/\s+/).length;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

  return [
    `The name starts with “${demon.name[0].toUpperCase()}”.`,
    `${plural(words, "word")}, ${plural(letters.length, "letter")}.`,
    `Verified by ${demon.verifier?.name ?? "an unknown player"}.`,
    `Listed at #${demon.position}${demon.ratedPosition ? ` (rated #${demon.ratedPosition})` : ""}.`,
    `Requires ${demon.requirement ?? "?"}% for records.`,
    `Published by ${demon.publisher?.name ?? "an unknown player"}.`,
    `Level ID ${demon.levelId ?? "unknown"}.`,
  ];
}

function roomCode() {
  const bytes = randomBytes(5);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function cleanName(value, fallback) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  return name || fallback;
}

export async function loadDemons() {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const seen = new Set();
  const playable = [];
  for (const demon of raw.demons) {
    if (!demon.videoId || seen.has(demon.position)) continue;
    seen.add(demon.position);
    playable.push(demon);
  }
  if (!playable.length) throw new Error("No playable demons in data/demons.json");
  return {
    demons: playable,
    meta: {
      syncedAt: raw.syncedAt ?? null,
      total: raw.total ?? raw.demons.length,
      playable: playable.length,
    },
  };
}

function newPlayer(name) {
  const id = randomUUID();
  return {
    id,
    name: cleanName(name, "Player"),
    token: randomUUID(),
    score: 0,
    streak: 0,
    rounds: 0,
    correct: 0,
    found: new Set(),
    connected: true,
    lastSeen: Date.now(),
  };
}

export class RoomRegistry {
  constructor(demons, meta) {
    this.demons = demons;
    this.meta = meta;
    this.rooms = new Map();
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref?.();
  }

  async reloadDemons() {
    const loaded = await loadDemons();
    this.demons = loaded.demons;
    this.meta = loaded.meta;
    return this.meta;
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (now - room.updatedAt > ROOM_TTL_MS) this.rooms.delete(code);
    }
  }

  lookup(code, playerId, token) {
    const room = this.rooms.get(String(code || "").toUpperCase());
    if (!room) throw Object.assign(new Error("Room not found"), { status: 404 });
    const player = room.players.get(playerId);
    if (!player || player.token !== token) throw Object.assign(new Error("Not a member of this room"), { status: 403 });
    player.lastSeen = Date.now();
    room.updatedAt = Date.now();
    return { room, player };
  }

  create(name, mode = "online", seats = []) {
    const code = roomCode();
    const host = newPlayer(name);
    const players = [host];
    const extraSeats = mode === "local" && Array.isArray(seats) ? seats.slice(0, 5) : [];
    for (const seat of extraSeats) {
      const seatName = typeof seat === "string" ? seat : seat?.name;
      players.push(newPlayer(seatName ?? `Player ${players.length + 1}`));
    }

    const room = {
      code,
      mode: ["solo", "local", "online"].includes(mode) ? mode : "online",
      hostId: host.id,
      activePlayerId: host.id,
      phase: "lobby",
      round: 0,
      demon: null,
      clipLength: 15,
      pool: "top100",
      players: new Map(players.map((player) => [player.id, player])),
      submissions: new Map(),
      lastDemonId: null,
      roundStart: 0,
      revealAt: 0,
      deadline: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.rooms.set(code, room);

    const result = { code, playerId: host.id, token: host.token, state: this.publicState(room) };
    if (mode === "local") {
      result.seats = players.map((player) => ({ playerId: player.id, token: player.token, name: player.name }));
    }
    return result;
  }

  join(code, name) {
    const room = this.rooms.get(String(code || "").toUpperCase());
    if (!room) throw Object.assign(new Error("Room not found"), { status: 404 });
    if (room.mode !== "online") throw Object.assign(new Error("This room is not joinable"), { status: 409 });
    if (room.players.size >= 6) throw Object.assign(new Error("Room is full (6 players max)"), { status: 409 });
    if (room.phase !== "lobby") throw Object.assign(new Error("This round is already in progress"), { status: 409 });

    const player = newPlayer(name, `Player ${room.players.size + 1}`);
    room.players.set(player.id, player);
    room.updatedAt = Date.now();
    return { code: room.code, playerId: player.id, token: player.token, state: this.publicState(room) };
  }

  connectedPlayers(room) {
    const now = Date.now();
    const players = [...room.players.values()];
    if (room.mode !== "online") {
      for (const player of players) player.connected = true;
      return players;
    }
    for (const player of players) player.connected = now - player.lastSeen < PLAYER_TIMEOUT_MS;
    return players.filter((player) => player.connected);
  }

  maybeReveal(room) {
    if (room.phase !== "playing") return;
    const expired = Date.now() > room.deadline;
    // Refresh connection flags, but do not reveal just because someone's
    // polling paused: every member of the room must submit first.
    this.connectedPlayers(room);
    const participants = [...room.players.values()];
    const targetId = room.mode === "online" ? null : room.activePlayerId;
    const done = targetId
      ? room.submissions.has(targetId)
      : participants.length > 0 && participants.every((player) => room.submissions.has(player.id));
    if (!expired && !done) return;

    room.phase = "reveal";
    room.revealAt = Date.now();
    room.updatedAt = Date.now();
  }

  publicState(room) {
    this.maybeReveal(room);
    const playing = room.phase === "playing";
    const revealed = room.phase === "reveal";
    const elapsed = playing
      ? Date.now() - room.roundStart
      : revealed
        ? (room.revealAt || Date.now()) - room.roundStart
        : 0;
    const hintCount = room.demon && room.phase !== "lobby"
      ? Math.min(7, Math.max(0, Math.floor(Math.max(0, elapsed) / HINT_INTERVAL_MS)))
      : 0;
    const hints = room.demon
      ? makeHints(room.demon).slice(0, hintCount).map((text, index) => ({ number: index + 1, text }))
      : [];

    return {
      code: room.code,
      mode: room.mode,
      hostId: room.hostId,
      activePlayerId: room.activePlayerId,
      phase: room.phase,
      round: room.round,
      clipLength: room.clipLength,
      pool: room.pool,
      videoId: room.demon && room.phase !== "lobby" ? room.demon.videoId : null,
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score,
        streak: player.streak,
        rounds: player.rounds,
        correct: player.correct,
        connected: player.connected,
        isHost: player.id === room.hostId,
        submitted: room.submissions.has(player.id),
        found: [...player.found],
      })),
      submissionCount: room.submissions.size,
      hints,
      nextHintIn: playing ? Math.max(0, HINT_INTERVAL_MS - (elapsed % HINT_INTERVAL_MS)) : null,
      deadlineIn: playing ? Math.max(0, room.deadline - Date.now()) : null,
      answer: revealed ? room.demon.name : null,
      answerInfo: revealed
        ? {
            position: room.demon.position,
            requirement: room.demon.requirement,
            verifier: room.demon.verifier?.name ?? null,
          }
        : null,
      results: revealed
        ? [...room.submissions.entries()].map(([id, result]) => ({ id, ...result }))
        : null,
    };
  }

  state(code, playerId, token) {
    const { room } = this.lookup(code, playerId, token);
    return this.publicState(room);
  }

  settings(code, playerId, token, settings) {
    const { room } = this.lookup(code, playerId, token);
    if ([10, 15, 20, 30].includes(Number(settings?.clipLength))) room.clipLength = Number(settings.clipLength);
    if (VALID_POOLS.has(settings?.pool)) room.pool = settings.pool;
    room.updatedAt = Date.now();
    return this.publicState(room);
  }

  eligibleDemons(room, player) {
    let list = this.demons;
    if (room.pool === "top25") list = list.filter((demon) => demon.position <= 25);
    if (room.pool === "top100") list = list.filter((demon) => demon.position <= 100);
    if (room.pool === "top250") list = list.filter((demon) => demon.position <= 250);
    if (room.pool === "unidentified") {
      const missing = list.filter((demon) => !player.found.has(demon.id));
      if (missing.length) list = missing;
    }
    return list.length ? list : this.demons;
  }

  start(code, playerId, token, settings = {}) {
    const { room, player } = this.lookup(code, playerId, token);
    const connected = this.connectedPlayers(room);
    if (room.mode === "online" && connected.length < 2) {
      throw Object.assign(new Error("Need at least 2 connected players"), { status: 409 });
    }
    if (!connected.length) throw Object.assign(new Error("No connected players"), { status: 409 });

    const lengths = [10, 15, 20, 30];
    room.clipLength = lengths.includes(Number(settings.clipLength))
      ? Number(settings.clipLength)
      : lengths[Math.floor(Math.random() * lengths.length)];
    if (VALID_POOLS.has(settings.pool)) room.pool = settings.pool;

    const pool = this.eligibleDemons(room, player);
    const candidates = pool.filter((demon) => demon.id !== room.lastDemonId);
    const list = candidates.length ? candidates : pool;
    const chosen = pickWeighted(list);

    room.demon = chosen;
    room.lastDemonId = chosen.id;
    room.round += 1;
    room.phase = "playing";
    room.submissions = new Map();
    room.roundStart = Date.now();
    room.revealAt = room.roundStart;
    room.deadline = room.roundStart + ROUND_DEADLINE_MS;
    room.updatedAt = Date.now();
    return this.publicState(room);
  }

  guess(code, playerId, token, guess, skip) {
    const { room, player } = this.lookup(code, playerId, token);
    if (room.phase !== "playing") throw Object.assign(new Error("No round is active"), { status: 409 });
    if (room.submissions.has(player.id)) throw Object.assign(new Error("Already submitted"), { status: 409 });

    const seconds = (Date.now() - room.roundStart) / 1000;
    const correct = !skip && normalise(guess) === normalise(room.demon.name);
    let points = 0;

    player.rounds += 1;
    if (correct) {
      const speed = Math.max(0, Math.round(50 - seconds * 2));
      const streakBonus = Math.min(100, player.streak * 10);
      points = Math.round((100 + speed + streakBonus) * tier(room.demon.position));
      player.score += points;
      player.streak += 1;
      player.correct += 1;
      player.found.add(room.demon.id);
    } else {
      if (!skip) player.score = Math.max(0, player.score - 20);
      player.streak = 0;
    }

    room.submissions.set(player.id, {
      name: player.name,
      guess: skip ? null : String(guess).slice(0, 120),
      correct,
      skipped: Boolean(skip),
      points,
      timeMs: Math.round(seconds * 1000),
    });
    this.maybeReveal(room);
    return { accepted: true, state: this.publicState(room) };
  }

  next(code, playerId, token) {
    const { room } = this.lookup(code, playerId, token);
    if (room.phase !== "reveal") throw Object.assign(new Error("Finish the current round first"), { status: 409 });
    if (room.mode === "local") {
      const ids = [...room.players.keys()];
      const index = ids.indexOf(room.activePlayerId);
      room.activePlayerId = ids[(index + 1) % ids.length];
    }
    return this.start(code, playerId, token, {});
  }

  collection(code, playerId, token, ids) {
    const { room, player } = this.lookup(code, playerId, token);
    if (!Array.isArray(ids)) return { demons: [] };
    const wanted = new Set(ids.slice(0, 2000).map(Number));
    const allowed = room.mode === "local"
      ? new Set([...room.players.values()].flatMap((member) => [...member.found]))
      : player.found;
    const demons = this.demons
      .filter((demon) => allowed.has(demon.id) && wanted.has(demon.id))
      .map((demon) => ({ id: demon.id, position: demon.position, name: demon.name }));
    demons.sort((a, b) => a.position - b.position);
    return { demons, mode: room.mode };
  }

  leave(code, playerId, token) {
    const { room } = this.lookup(code, playerId, token);
    room.players.delete(playerId);
    room.submissions.delete(playerId);
    if (room.hostId === playerId) room.hostId = room.players.keys().next().value ?? null;
    if (room.activePlayerId === playerId) room.activePlayerId = room.players.keys().next().value ?? null;
    if (!room.players.size) this.rooms.delete(room.code);
    return { ok: true };
  }
}
