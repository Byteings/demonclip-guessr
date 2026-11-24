import { $, loadJSON, saveJSON, normalise, countdown, toast } from "./js/core.js";
import { ClipPlayer } from "./js/player.js";

/* GitHub Pages build: no Node server, so the level snapshot ships with the
   page and the game logic runs in the browser. Pass & play is fully local;
   online rooms use a public MQTT broker as a lightweight relay. */

const STORE = { names: "dcg.pages.names.v1" };
const CLIP_LENGTHS = [10, 15, 20, 30];
const HINT_INTERVAL_MS = 30_000;
const ROUND_DEADLINE_MS = 120_000;
const MAX_PLAYERS = 6;
const MQTT_URL = "wss://broker.emqx.io:8084/mqtt";
const MQTT_LIB = "https://unpkg.com/mqtt@5.10.3/dist/mqtt.min.js";
const TOPIC_PREFIX = "clickersim/demonclip/v1/room/";

const ui = {
  screens: [...document.querySelectorAll(".screen")],
  nav: [...document.querySelectorAll(".nav-btn")],
  roundLabel: $("roundLabel"),
  playSub: $("playSub"),
  score: $("scoreValue"),
  streak: $("streakValue"),
  accuracy: $("accuracyValue"),
  stage: $("stage"),
  clipProgress: $("clipProgress"),
  clipTimer: $("clipTimer"),
  clipBar: $("clipProgressBar"),
  hintPanel: $("hintPanel"),
  hintNumber: $("hintNumber"),
  hintText: $("hintText"),
  nextHint: $("nextHint"),
  status: $("stageStatus"),
  roundMeta: $("roundMeta"),
  guessForm: $("guessForm"),
  guessInput: $("guessInput"),
  submit: $("submitGuessBtn"),
  feedback: $("feedback"),
  feedbackHead: $("feedbackHead"),
  answerCard: $("answerCard"),
  onlineResults: $("onlineResults"),
  playersList: $("playersList"),
  playerMeta: $("playerMeta"),
  roomStatus: $("roomStatus"),
  addLocalPlayer: $("addLocalPlayerBtn"),
  newGame: $("newGameBtn"),
  sessionMeta: $("sessionMeta"),
  progressBar: $("progressBar"),
  foundCount: $("foundCount"),
  totalCount: $("totalCount"),
  viewCollection: $("viewCollectionBtn"),
  navCount: $("navCollectionCount"),
  collectionSearch: $("collectionSearch"),
  collectionGrid: $("collectionGrid"),
  collectionEmpty: $("collectionEmpty"),
  collectionFound: $("collectionFound"),
  collectionTotal: $("collectionTotal"),
  collectionResultCount: $("collectionResultCount"),
  chips: [...document.querySelectorAll(".chip")],
  mpTabs: [...document.querySelectorAll(".mp-tab")],
  mpLocal: $("mp-local"),
  mpOnline: $("mp-online"),
  localInputs: $("localPlayerInputs"),
  startLocal: $("startLocalBtn"),
  createName: $("createName"),
  createRoom: $("createRoomBtn"),
  joinName: $("joinName"),
  joinCode: $("joinCode"),
  joinRoom: $("joinRoomBtn"),
  roomInfo: $("roomInfo"),
  roomCode: $("roomCode"),
  roomNotice: $("roomNotice"),
  inviteNotice: $("inviteNotice"),
  inviteLink: $("inviteLink"),
  copyInvite: $("copyInviteBtn"),
  leaveRoom: $("leaveRoomBtn"),
  mpError: $("mpError"),
  syncDate: $("syncDate"),
  syncCount: $("syncCount"),
  syncPlayable: $("syncPlayable"),
  syncBtn: $("syncBtn"),
  syncStatus: $("syncStatus"),
  resetBtn: $("resetBtn"),
};

const knownNames = loadJSON(STORE.names, {});
const localSetup = [1, 2].map((n) => ({ name: `Player ${n}` }));

let demons = [];
let byId = new Map();
let byVideo = new Map();
let meta = { syncedAt: null, total: 0, playable: 0 };
let state = null;
let myId = randomId();
let isHost = false;
let collectionFilter = "all";
let renderedRound = 0;
let revealedRound = 0;
let submittedRound = 0;
let hintClock = null;
let autoNextTimer = null;
let joinWaitTimer = null;
let mqttClient = null;
let mqttTopic = null;

const clip = new ClipPlayer({
  host: "playerHost",
  onPlaying: () => onClipPlaying(),
  onEnded: () => onClipEnded(),
  onProgress: (elapsed, remaining, ratio) => onClipProgress(elapsed, remaining, ratio),
  onError: (message) => onClipError(message),
  onBlocked: () => setStatus("Click the clip to start it"),
});

/* ─────────── Helpers ─────────── */
function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...Array(5)].map(() => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function makeHints(demon) {
  if (!demon) return [];
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

function tier(position) {
  if (position <= 25) return 2;
  if (position <= 100) return 1.6;
  if (position <= 250) return 1.3;
  return 1;
}

function mode() {
  return state?.mode ?? "local";
}

function me() {
  return state?.players.find((player) => player.id === myId) ?? null;
}

function activePlayer() {
  return state?.players.find((player) => player.id === state.activePlayerId) ?? me();
}

function foundIds() {
  if (!state) return [];
  const players = mode() === "local" ? state.players : [me()].filter(Boolean);
  return [...new Set(players.flatMap((player) => player.found ?? []))];
}

function setStatus(text, live = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("live", live);
}

function showClipPanels(show) {
  ui.clipProgress.hidden = !show;
}

function setGuessEnabled(enabled) {
  ui.guessInput.disabled = !enabled;
  ui.submit.disabled = !enabled;
  if (enabled) ui.guessInput.focus();
}

function showScreen(name) {
  ui.screens.forEach((screen) => screen.classList.toggle("active", screen.id === `screen-${name}`));
  ui.nav.forEach((button) => button.classList.toggle("active", button.dataset.screen === name));
  if (name !== "play") clip.pause();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* Only the host builds this projection; guests receive it over MQTT. */
function publicState(full) {
  const demon = byId.get(full.demonId) ?? byVideo.get(full.videoId);
  const revealed = full.phase === "reveal";
  const elapsed = full.phase === "playing"
    ? Date.now() - full.roundStart
    : (full.revealAt || Date.now()) - full.roundStart;
  const safeElapsed = Math.max(0, elapsed);
  const count = demon && full.phase !== "lobby" ? Math.min(7, Math.floor(safeElapsed / HINT_INTERVAL_MS)) : 0;
  const submissions = full.submissions ?? {};
  return {
    ...full,
    demonId: undefined,
    submissions: undefined,
    submissionCount: Object.keys(submissions).length,
    videoId: demon && full.phase !== "lobby" ? demon.videoId : null,
    hints: makeHints(demon).slice(0, count).map((text, index) => ({ number: index + 1, text })),
    nextHintIn: full.phase === "playing" ? Math.max(0, HINT_INTERVAL_MS - (safeElapsed % HINT_INTERVAL_MS)) : null,
    answer: revealed ? demon?.name ?? null : null,
    answerInfo: revealed && demon ? {
      position: demon.position,
      requirement: demon.requirement,
      verifier: demon.verifier?.name ?? null,
    } : null,
    results: revealed ? Object.entries(submissions).map(([id, result]) => ({ id, ...result })) : null,
    players: full.players.map((player) => ({ ...player, found: [...player.found], guessed: Boolean(submissions[player.id]) })),
  };
}

/* ─────────── Round logic (host/local only) ─────────── */
function startRound() {
  clearInterval(hintClock);
  clearTimeout(autoNextTimer);
  if (!state || (mode() === "online" && !isHost)) return;
  const previous = byId.get(state.demonId);
  const candidates = demons.filter((demon) => demon !== previous);
  const chosen = randomChoice(candidates.length ? candidates : demons);

  state.demonId = chosen.id;
  state.videoId = chosen.videoId;
  state.round += 1;
  state.phase = "playing";
  state.clipLength = randomChoice(CLIP_LENGTHS);
  state.start = Math.random() * 0.8 + 0.05;
  state.roundStart = Date.now();
  state.revealAt = state.roundStart;
  state.submissions = {};
  state.submissionCount = 0;
  state.hints = [];
  state.nextHintIn = HINT_INTERVAL_MS;
  state.answer = null;
  state.answerInfo = null;
  state.results = null;

  applyState(state);
  if (isHost && mode() === "online") publishState();
}

function applyGuess(id, guess, skip) {
  if (!state || state.phase !== "playing" || state.submissions[id]) return;
  const demon = byId.get(state.demonId);
  const player = state.players.find((entry) => entry.id === id);
  if (!demon || !player) return;

  const seconds = (Date.now() - state.roundStart) / 1000;
  const correct = !skip && normalise(guess) === normalise(demon.name);
  let points = 0;
  player.rounds += 1;
  if (correct) {
    const speed = Math.max(0, Math.round(50 - seconds * 2));
    const streakBonus = Math.min(100, player.streak * 10);
    points = Math.round((100 + speed + streakBonus) * tier(demon.position));
    player.score += points;
    player.streak += 1;
    player.correct += 1;
    if (!player.found.includes(demon.id)) player.found.push(demon.id);
  } else {
    if (!skip) player.score = Math.max(0, player.score - 20);
    player.streak = 0;
  }
  state.submissions[id] = {
    name: player.name,
    guess: skip ? null : String(guess).slice(0, 120),
    skipped: Boolean(skip),
    correct,
    points,
  };
  state.submissionCount = Object.keys(state.submissions).length;
  renderRoom();
  renderPlayers();

  const allDone = mode() === "local"
    ? Boolean(state.submissions[state.activePlayerId])
    : state.players.length > 0 && state.players.every((entry) => state.submissions[entry.id]);
  if (allDone || Date.now() > state.roundStart + ROUND_DEADLINE_MS) revealRound();
  else if (isHost && mode() === "online") publishState();
}

function revealRound() {
  if (!state || state.phase !== "playing") return;
  const demon = byId.get(state.demonId);
  state.phase = "reveal";
  state.revealAt = Date.now();
  state.answer = demon?.name ?? null;
  state.answerInfo = demon ? {
    position: demon.position,
    requirement: demon.requirement,
    verifier: demon.verifier?.name ?? null,
  } : null;
  state.results = Object.entries(state.submissions).map(([id, result]) => ({ id, ...result }));
  applyState(state);
  if (isHost && mode() === "online") publishState();

  if (isHost) autoNextTimer = setTimeout(() => {
    if (mode() === "local") {
      const ids = state.players.map((player) => player.id);
      state.activePlayerId = ids[(ids.indexOf(state.activePlayerId) + 1) % ids.length];
      myId = state.activePlayerId;
    }
    startRound();
  }, 5000);
}

/* ─────────── State rendering ─────────── */
function applyState(next) {
  state = next;
  ui.mpError.textContent = "";

  if (state.phase === "lobby") {
    clearInterval(hintClock);
    clearTimeout(autoNextTimer);
    clip.destroy();
    renderedRound = 0;
    revealedRound = 0;
    setStatus("Starting a random clip…");
    showClipPanels(false);
    ui.hintPanel.hidden = true;
    ui.feedback.hidden = true;
    setGuessEnabled(false);
  }

  if (state.phase === "playing" && state.round !== renderedRound) {
    clearTimeout(autoNextTimer);
    renderedRound = state.round;
    revealedRound = 0;
    submittedRound = 0;
    showScreen("play");
    beginRound();
  } else if (state.phase === "playing") {
    refreshHints();
  }

  if (state.phase === "reveal") {
    clearInterval(hintClock);
    if (state.round !== renderedRound) {
      renderedRound = state.round;
      resetRoundUI();
    }
    if (revealedRound !== state.round) {
      revealedRound = state.round;
      showReveal();
    }
    ui.hintPanel.hidden = true;
  }

  renderHud();
  renderPlayers();
  renderSessionPanel();
  renderRoom();
  renderCollection();
  ensureNames(foundIds());
}

function resetRoundUI() {
  clearInterval(hintClock);
  clip.destroy();
  ui.feedback.hidden = true;
  ui.onlineResults.hidden = true;
  ui.submit.textContent = "Guess";
  ui.guessInput.value = "";
  setGuessEnabled(false);
  showClipPanels(false);
  ui.hintPanel.hidden = true;
  ui.clipBar.style.width = "0%";
  ui.clipTimer.textContent = `0:${String(state.clipLength || 15).padStart(2, "0")}`;
  ui.roundMeta.textContent = `RANDOM ${state.clipLength || 15}s`;
}

function beginRound() {
  resetRoundUI();
  setStatus("Loading clip");
  showClipPanels(false);
  refreshHints();
  startHintClock();
  renderHud();
  if (state.videoId) clip.play(state.videoId, state.clipLength, state.start);
}

function refreshHints() {
  if (!state || state.phase !== "playing") return;
  const demon = byId.get(state.demonId) ?? byVideo.get(state.videoId);
  const elapsed = Math.max(0, Date.now() - (state.roundStart || Date.now()));
  const count = Math.min(7, Math.floor(elapsed / HINT_INTERVAL_MS));
  state.hints = makeHints(demon).slice(0, count).map((text, index) => ({ number: index + 1, text }));
  state.nextHintIn = Math.max(0, HINT_INTERVAL_MS - (elapsed % HINT_INTERVAL_MS));
  updateHints();
}

function updateHints() {
  const hints = state?.hints ?? [];
  ui.hintNumber.textContent = hints.length ? `HINT ${hints.length}` : "FIRST HINT";
  ui.hintText.textContent = hints.length
    ? hints[hints.length - 1].text
    : "The first hint arrives after 30 seconds.";
  ui.nextHint.textContent = `Next in ${countdown(state?.nextHintIn ?? HINT_INTERVAL_MS)}`;
  if (state?.phase === "playing") ui.hintPanel.hidden = false;
}

function startHintClock() {
  clearInterval(hintClock);
  hintClock = setInterval(() => {
    if (state?.phase !== "playing" || !state.roundStart) return;
    const elapsed = Math.max(0, Date.now() - state.roundStart);
    const expected = Math.min(7, Math.floor(elapsed / HINT_INTERVAL_MS));
    const current = state.hints?.length ?? 0;
    ui.nextHint.textContent = `Next in ${countdown(Math.max(0, HINT_INTERVAL_MS - (elapsed % HINT_INTERVAL_MS)))}`;
    if (expected > current) {
      refreshHints();
      if (isHost && mode() === "online") publishState();
    }
  }, 250);
}

/* ─────────── Clip ─────────── */
function onClipPlaying() {
  setStatus("Clip running", true);
  showClipPanels(true);
}

function onClipProgress(elapsed, remaining, ratio) {
  ui.clipBar.style.width = `${ratio}%`;
  ui.clipTimer.textContent = `0:${String(Math.ceil(remaining)).padStart(2, "0")}`;
}

function onClipEnded() {
  if (!state || state.phase !== "playing") return;
  setGuessEnabled(true);
  setStatus("Clip ended — guess now", true);
}

function onClipError(message) {
  if (!state || state.phase !== "playing") return;
  setStatus("Clip unavailable — click the clip to retry");
  toast(message || "Clip unavailable");
  setGuessEnabled(true);
}

/* ─────────── Answers ─────────── */
async function submitGuess(guess, skip) {
  if (!state || state.phase !== "playing" || submittedRound === state.round) return;
  if (state.submissions?.[myId]) return;

  if (mode() === "online") {
    if (isHost) {
      // The broker does not echo a client's own messages back to it.
      applyGuess(myId, guess, skip);
      if (state?.phase === "reveal") return;
    } else {
      if (!mqttClient) return toast("Not connected to the room.");
      publish({ type: "guess", guess, skip });
    }
    submittedRound = state.round;
    ui.submit.textContent = "Sent";
    setGuessEnabled(false);
    ui.feedbackHead.className = "feedback-head skipped";
    ui.feedbackHead.textContent = "Guess sent — waiting for the other players.";
    ui.answerCard.textContent = skip ? "You skipped this round." : `Your guess: ${guess}`;
    ui.feedback.hidden = false;
    return;
  }

  applyGuess(myId, guess, skip);
  submittedRound = state.round;
}

function showReveal() {
  clearTimeout(autoNextTimer);
  clip.pause();
  setGuessEnabled(false);
  setStatus("Round revealed");

  const mine = state.results?.find((result) => result.id === myId);
  ui.feedbackHead.className = `feedback-head ${mine?.correct ? "correct" : mine?.skipped ? "skipped" : "wrong"}`;
  ui.feedbackHead.textContent = mine?.correct
    ? `Correct — +${mine.points} points`
    : mine?.skipped ? "You skipped this round" : mine ? "Incorrect" : "Round revealed";

  ui.answerCard.replaceChildren();
  const label = document.createElement("div");
  label.className = "answer-score";
  label.textContent = "ANSWER";
  const name = document.createElement("div");
  name.className = "answer-name";
  name.textContent = state.answer ?? "?";
  const info = document.createElement("div");
  info.className = "answer-score";
  info.textContent = state.answerInfo
    ? `#${state.answerInfo.position} · ${state.answerInfo.requirement ?? "?"}% · verified by ${state.answerInfo.verifier ?? "unknown"}`
    : "";
  ui.answerCard.append(label, name, info);

  ui.onlineResults.replaceChildren();
  ui.onlineResults.hidden = state.players.length < 2;
  for (const result of [...(state.results ?? [])].sort((a, b) => b.points - a.points)) {
    const row = document.createElement("div");
    row.className = `results-row${result.id === myId ? " you" : ""}`;
    const who = document.createElement("span");
    who.textContent = result.name;
    const guess = document.createElement("span");
    guess.textContent = result.skipped ? "skipped" : result.guess || "—";
    const points = document.createElement("span");
    points.textContent = result.correct ? `+${result.points}` : "0";
    row.append(who, guess, points);
    ui.onlineResults.appendChild(row);
  }
  ui.feedback.hidden = false;
  showClipPanels(false);
}

/* ─────────── Rendering ─────────── */
function renderHud() {
  const player = mode() === "local" ? activePlayer() : me();
  const suffix = mode() === "online" ? ` · ROOM ${state?.code ?? "—"}` : "";
  ui.roundLabel.textContent = `ROUND ${state?.round || 1}${suffix}`;
  ui.score.textContent = String(player?.score ?? 0);
  ui.streak.innerHTML = `${player?.streak ?? 0}<small>×</small>`;
  ui.accuracy.textContent = player?.rounds ? `${Math.round((player.correct / player.rounds) * 100)}%` : "—";
  ui.playSub.textContent = mode() === "online"
    ? "The same random clip plays for everyone. Guess when it ends."
    : "The clip starts on its own. Guess when it ends.";
}

function renderPlayers() {
  const players = state?.players ?? localSetup.map((entry, index) => ({
    id: String(index), name: entry.name, score: 0, streak: 0, correct: 0, rounds: 0,
  }));
  ui.playerMeta.textContent = `${players.length} player${players.length === 1 ? "" : "s"}`;
  ui.playersList.replaceChildren();
  players.forEach((player, index) => {
    const row = document.createElement("div");
    row.className = `player-row${player.id === state?.activePlayerId ? " active" : ""}`;
    const rank = document.createElement("span");
    rank.className = "player-rank";
    rank.textContent = String(index + 1).padStart(2, "0");
    const detail = document.createElement("span");
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name || `Player ${index + 1}`;
    const sub = document.createElement("small");
    sub.className = "player-detail";
    const guessed = player.guessed ?? Boolean(state?.submissions?.[player.id]);
    sub.textContent = [
      player.id === state?.activePlayerId ? "current turn" : null,
      `${player.correct ?? 0}/${player.rounds ?? 0} correct`,
      guessed ? "guessed" : null,
    ].filter(Boolean).join(" · ");
    detail.append(name, sub);
    const score = document.createElement("span");
    score.className = "player-score";
    score.textContent = String(player.score ?? 0);
    row.append(rank, detail, score);
    ui.playersList.appendChild(row);
  });
  ui.addLocalPlayer.hidden = mode() !== "local" || players.length >= MAX_PLAYERS;
}

function renderSessionPanel() {
  const found = foundIds().length;
  const total = meta.playable || 1;
  ui.sessionMeta.textContent = `${Math.min(100, Math.round((found / total) * 100))}%`;
  ui.progressBar.style.width = `${Math.min(100, (found / total) * 100)}%`;
  ui.foundCount.textContent = String(found);
  ui.totalCount.textContent = String(meta.playable);
  ui.navCount.textContent = String(found);
  ui.collectionFound.textContent = String(found);
  ui.collectionTotal.textContent = String(meta.playable);
  ui.roomStatus.hidden = !state;
  if (state) {
    ui.roomStatus.textContent = mode() === "online"
      ? `Room ${state.code} · round ${state.round || 0}`
      : `Pass & play · round ${state.round || 0}`;
  }
}

function renderRoom() {
  if (mode() !== "online" || !state) {
    ui.roomInfo.hidden = true;
    return;
  }
  ui.roomInfo.hidden = false;
  ui.roomCode.textContent = state.code;
  ui.inviteLink.value = `${location.href.split("?")[0]}?room=${state.code}`;
  const guesses = state.submissionCount ?? Object.keys(state.submissions ?? {}).length;
  ui.roomNotice.textContent = state.players.length < 2
    ? "Share the invite link. The first round starts when a second player joins."
    : state.phase === "lobby" ? "Starting the first round…"
      : state.phase === "playing" ? `Round ${state.round}: ${guesses}/${state.players.length} guessed.`
        : `Round ${state.round} revealed.`;
}

function renderCollection() {
  const ids = foundIds();
  const query = ui.collectionSearch.value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  for (const id of ids) {
    const entry = knownNames[id];
    if (!entry || collectionFilter === "missing") continue;
    if (query && !String(entry.name).toLowerCase().includes(query)) continue;
    const tile = document.createElement("div");
    tile.className = "demon-tile found";
    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = `IDENTIFIED · #${entry.position}`;
    const name = document.createElement("strong");
    name.className = "tile-name";
    name.textContent = entry.name;
    tile.append(label, name);
    fragment.appendChild(tile);
  }
  if (collectionFilter !== "found" && !query) {
    const missing = Math.max(0, meta.playable - ids.length);
    for (let index = 0; index < missing; index += 1) {
      const tile = document.createElement("div");
      tile.className = "demon-tile locked";
      const label = document.createElement("span");
      label.className = "tile-label";
      label.textContent = "UNIDENTIFIED";
      const name = document.createElement("strong");
      name.className = "tile-name";
      name.textContent = "CLASSIFIED";
      tile.append(label, name);
      fragment.appendChild(tile);
    }
  }
  ui.collectionGrid.replaceChildren(fragment);
  const shown = ui.collectionGrid.children.length;
  ui.collectionEmpty.hidden = shown > 0;
  ui.collectionResultCount.textContent = `${shown} ENTRIES`;
  renderSessionPanel();
}

function ensureNames(ids) {
  const missing = ids.filter((id) => knownNames[id] && !knownNames[id].position);
  if (!missing.length) return;
  missing.forEach((id) => {
    const demon = demons.find((entry) => entry.id === id);
    if (demon) knownNames[id] = { name: demon.name, position: demon.position };
  });
  saveJSON(STORE.names, knownNames);
}

function renderMeta() {
  const date = new Date(meta.syncedAt);
  ui.syncDate.textContent = Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
  ui.syncCount.textContent = String(meta.total);
  ui.syncPlayable.textContent = String(meta.playable);
}

function renderLocalInputs() {
  ui.localInputs.replaceChildren();
  localSetup.forEach((player, index) => {
    const row = document.createElement("div");
    row.className = "local-row";
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 24;
    input.value = player.name;
    input.setAttribute("aria-label", `Player ${index + 1} name`);
    input.addEventListener("input", () => { player.name = input.value.trim(); });
    row.append(number, input);
    ui.localInputs.appendChild(row);
  });
  document.getElementById("addLocalPlayerBtnSetup").hidden = localSetup.length >= MAX_PLAYERS;
}

/* ─────────── MQTT rooms ─────────── */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load the room connection"));
    document.head.appendChild(script);
  });
}

async function connectMqtt() {
  if (mqttClient?.connected) return mqttClient;
  if (!window.mqtt) await loadScript(MQTT_LIB);
  mqttClient = window.mqtt.connect(MQTT_URL, {
    clientId: `dcg_${myId}`,
    keepalive: 30,
    clean: true,
    reconnectPeriod: 2000,
  });
  mqttClient.on("message", (topic, payload) => {
    if (topic !== mqttTopic) return;
    let message;
    try { message = JSON.parse(String(payload)); } catch { return; }
    if (message.from === myId) return;
    handleMessage(message);
  });
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      mqttClient.off("connect", done);
      mqttClient.off("error", fail);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new Error("Room connection timed out")), 10_000);
    mqttClient.on("connect", done);
    mqttClient.on("error", fail);
  });
  return mqttClient;
}

function publish(message) {
  if (!mqttClient || !mqttTopic) return;
  mqttClient.publish(mqttTopic, JSON.stringify({ ...message, from: myId, id: myId }));
}

function publishState() {
  if (!state) return;
  publish({ type: "state", state: publicState(state) });
}

function subscribe(code) {
  mqttTopic = `${TOPIC_PREFIX}${code}`;
  mqttClient.subscribe(mqttTopic);
}

function handleMessage(message) {
  if (message.type === "state" && message.state) {
    clearTimeout(joinWaitTimer);
    applyState(message.state);
    return;
  }
  if (!isHost) return;
  if (message.type === "join") {
    if (state.phase !== "lobby" || state.players.length >= MAX_PLAYERS) return;
    if (!state.players.some((player) => player.id === message.id)) {
      state.players.push({
        id: message.id,
        name: String(message.name || "Player").slice(0, 24),
        score: 0, streak: 0, rounds: 0, correct: 0, found: [],
      });
    }
    renderPlayers();
    renderRoom();
    publishState();
    if (state.players.length >= 2) setTimeout(() => {
      if (state?.phase === "lobby" && state.players.length >= 2) startRound();
    }, 1200);
    return;
  }
  if (message.type === "guess") {
    applyGuess(message.id, message.guess, message.skip);
    return;
  }
  if (message.type === "leave") {
    state.players = state.players.filter((player) => player.id !== message.id);
    renderPlayers();
    renderRoom();
    publishState();
  }
}

async function createOnlineRoom(name) {
  await connectMqtt();
  clearTimeout(joinWaitTimer);
  isHost = true;
  myId = randomId();
  state = {
    mode: "online", code: roomCode(), phase: "lobby", round: 0,
    demonId: null, videoId: null, clipLength: 15, start: 0.1,
    roundStart: 0, revealAt: 0, activePlayerId: myId,
    players: [{ id: myId, name, score: 0, streak: 0, rounds: 0, correct: 0, found: [] }],
    submissions: {}, submissionCount: 0, hints: [], nextHintIn: HINT_INTERVAL_MS,
    results: null, answer: null, answerInfo: null,
  };
  subscribe(state.code);
  renderRoom();
  renderPlayers();
  renderSessionPanel();
  publishState();
  showScreen("multiplayer");
}

async function joinOnlineRoom(code, name) {
  await connectMqtt();
  clearTimeout(joinWaitTimer);
  isHost = false;
  myId = randomId();
  subscribe(code);
  publish({ type: "join", name });
  ui.roomNotice.textContent = "Waiting for the host to add you…";
  joinWaitTimer = setTimeout(() => {
    if (!state) ui.mpError.textContent = "Room not found. Check the code and try again.";
  }, 9000);
}

function leaveRoom() {
  clearTimeout(joinWaitTimer);
  clearTimeout(autoNextTimer);
  clearInterval(hintClock);
  if (mqttClient && mqttTopic) {
    publish({ type: "leave" });
    mqttClient.unsubscribe(mqttTopic);
  }
  mqttTopic = null;
  isHost = false;
  state = null;
  renderedRound = 0;
  revealedRound = 0;
  submittedRound = 0;
  clip.destroy();
  ui.feedback.hidden = true;
  ui.roomInfo.hidden = true;
  ui.inviteNotice.hidden = true;
  renderPlayers();
  renderSessionPanel();
  showScreen("multiplayer");
}

/* ─────────── Events ─────────── */
function bindEvents() {
  document.querySelectorAll("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.screen === "play" && !state) return showScreen("multiplayer");
      showScreen(button.dataset.screen);
    });
  });

  ui.stage.addEventListener("click", () => {
    if (!state || !["playing", "reveal"].includes(state.phase)) return;
    if (clip.player) clip.replay();
    else if (state.phase === "playing") clip.play(state.videoId, state.clipLength, state.start);
  });

  ui.guessForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = ui.guessInput.value.trim();
    if (value) submitGuess(value, false);
  });

  ui.collectionSearch.addEventListener("input", renderCollection);
  ui.chips.forEach((chip) => chip.addEventListener("click", () => {
    collectionFilter = chip.dataset.filter;
    ui.chips.forEach((candidate) => candidate.classList.toggle("active", candidate === chip));
    renderCollection();
  }));

  ui.mpTabs.forEach((tab) => tab.addEventListener("click", () => {
    ui.mpTabs.forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
    const online = tab.dataset.mptab === "online";
    ui.mpLocal.hidden = online;
    ui.mpOnline.hidden = !online;
    ui.mpError.textContent = "";
  }));

  const addLocal = () => {
    if (localSetup.length >= MAX_PLAYERS) return;
    localSetup.push({ name: `Player ${localSetup.length + 1}` });
    renderLocalInputs();
  };
  document.getElementById("addLocalPlayerBtn").addEventListener("click", addLocal);
  document.getElementById("addLocalPlayerBtnSetup").addEventListener("click", addLocal);

  ui.startLocal.addEventListener("click", () => {
    const names = [...ui.localInputs.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
    if (names.length < 2) return toast("Add at least two players.");
    leaveRoom();
    isHost = true;
    myId = "local-0";
    state = {
      mode: "local", code: null, phase: "lobby", round: 0,
      demonId: null, videoId: null, clipLength: 15, start: 0.1,
      roundStart: 0, revealAt: 0, activePlayerId: "local-0",
      players: names.map((name, index) => ({
        id: `local-${index}`, name, score: 0, streak: 0, rounds: 0, correct: 0, found: [],
      })),
      submissions: {}, submissionCount: 0, hints: [], nextHintIn: HINT_INTERVAL_MS,
      results: null, answer: null, answerInfo: null,
    };
    showScreen("play");
    startRound();
  });

  ui.createRoom.addEventListener("click", async () => {
    const name = ui.createName.value.trim();
    if (!name) return toast("Enter your name first.");
    ui.createRoom.disabled = true;
    try {
      leaveRoom();
      await createOnlineRoom(name);
    } catch (error) {
      ui.mpError.textContent = error.message;
    } finally {
      ui.createRoom.disabled = false;
    }
  });

  ui.joinRoom.addEventListener("click", async () => {
    const name = ui.joinName.value.trim();
    const code = ui.joinCode.value.trim().toUpperCase();
    if (!name || !code) return toast("Enter your name and the room code.");
    ui.joinRoom.disabled = true;
    try {
      leaveRoom();
      await joinOnlineRoom(code, name);
    } catch (error) {
      ui.mpError.textContent = error.message;
    } finally {
      ui.joinRoom.disabled = false;
    }
  });

  [ui.createName, ui.joinName, ui.joinCode].forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      (input === ui.createName ? ui.createRoom : ui.joinRoom).click();
    });
  });

  ui.copyInvite.addEventListener("click", async () => {
    const link = ui.inviteLink.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied.");
    } catch {
      ui.inviteLink.select();
      document.execCommand("copy");
      toast("Invite link copied.");
    }
  });

  ui.newGame.addEventListener("click", leaveRoom);
  ui.leaveRoom.addEventListener("click", leaveRoom);
  ui.viewCollection.addEventListener("click", () => showScreen("collection"));

  ui.syncBtn.addEventListener("click", () => {
    ui.syncStatus.textContent = "Pages uses the bundled snapshot. Run node scripts/sync-demons.mjs to update it.";
  });

  ui.resetBtn.addEventListener("click", () => {
    if (!window.confirm("Reset every player's score and all identified levels?")) return;
    Object.values(STORE).forEach((key) => localStorage.removeItem(key));
    Object.keys(knownNames).forEach((key) => delete knownNames[key]);
    leaveRoom();
    renderCollection();
    toast("Progress reset.");
  });

  document.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === "r" && clip.player && ["playing", "reveal"].includes(state?.phase)) {
      event.preventDefault();
      clip.replay();
    }
  });
}

function applyInvite() {
  const requested = new URLSearchParams(location.search).get("room");
  if (!requested) return;
  const code = String(requested).trim().toUpperCase().slice(0, 8);
  ui.mpTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.mptab === "online"));
  ui.mpLocal.hidden = true;
  ui.mpOnline.hidden = false;
  ui.joinCode.value = code;
  ui.inviteNotice.textContent = `You were invited to room ${code}. Add your name to join.`;
  ui.inviteNotice.hidden = false;
  showScreen("multiplayer");
  ui.joinName.focus();
}

async function init() {
  const response = await fetch("data/demons.json");
  if (!response.ok) throw new Error("Could not load the level data");
  const loaded = await response.json();
  demons = (loaded.demons ?? []).filter((demon) => demon.videoId);
  byId = new Map(demons.map((demon) => [demon.id, demon]));
  byVideo = new Map(demons.map((demon) => [demon.videoId, demon]));
  meta = {
    syncedAt: loaded.syncedAt,
    total: loaded.total ?? loaded.demons?.length ?? 0,
    playable: demons.length,
  };
  demons.forEach((demon) => {
    if (!knownNames[demon.id]) knownNames[demon.id] = { name: demon.name, position: demon.position };
  });
  saveJSON(STORE.names, knownNames);

  renderLocalInputs();
  renderMeta();
  renderCollection();
  renderPlayers();
  renderHud();
  bindEvents();
  applyInvite();
}

init().catch((error) => toast(error.message));
