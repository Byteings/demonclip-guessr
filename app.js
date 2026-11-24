import { $, loadJSON, saveJSON, request, countdown, toast } from "./js/core.js";
import { ClipPlayer } from "./js/player.js";
import { GameSession } from "./js/session.js";

const STORE = { prefs: "dcg.prefs.v3", names: "dcg.names.v3" };
const CLIP_LENGTHS = [10, 15, 20, 30];

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
  addLocalPlayerSetup: $("addLocalPlayerBtnSetup"),
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
const requestedNames = new Set();
const MAX_PLAYERS = 6;

let session = null;
let state = null;
let meta = { syncedAt: null, total: 0, playable: 0 };
let collectionFilter = "all";
let renderedRound = 0;
let revealedRound = 0;
let submittedRound = 0;
let hintRemaining = 0;
let hintClock = null;
let autoNextTimer = null;
let starting = false;
const localSetup = [1, 2].map((n) => ({ name: `Player ${n}` }));

const clip = new ClipPlayer({
  host: "playerHost",
  onPlaying: () => onClipPlaying(),
  onEnded: () => onClipEnded(),
  onProgress: (elapsed, remaining, ratio) => onClipProgress(elapsed, remaining, ratio),
  onError: (message) => onClipError(message),
  onBlocked: () => setStatus("Click the clip to start it"),
});

/* ─────────── Helpers ─────────── */
function mode() {
  return state?.mode ?? "local";
}

function me() {
  return state?.players.find((player) => player.id === session?.session?.playerId) ?? null;
}

function activePlayer() {
  return state?.players.find((player) => player.id === state.activePlayerId) ?? me();
}

function foundIds() {
  if (!state) return Object.keys(knownNames).map(Number);
  const players = mode() === "local" ? state.players : [me()].filter(Boolean);
  return [...new Set(players.flatMap((player) => player.found ?? []))];
}

function randomLength() {
  return CLIP_LENGTHS[Math.floor(Math.random() * CLIP_LENGTHS.length)];
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

/* ─────────── Server state ─────────── */
function onState(next) {
  state = next;
  ui.mpError.textContent = "";
  if (next.mode === "local") session.useSeat(next.activePlayerId);

  if (next.phase === "lobby") {
    clearInterval(hintClock);
    clearTimeout(autoNextTimer);
    starting = false;
    clip.destroy();
    renderedRound = 0;
    revealedRound = 0;
    setStatus("Starting a random clip…");
    showClipPanels(false);
    ui.hintPanel.hidden = true;
    ui.feedback.hidden = true;
    setGuessEnabled(false);
    maybeAutoStart();
  }

  if (next.phase === "playing" && next.round !== renderedRound) {
    clearTimeout(autoNextTimer);
    renderedRound = next.round;
    revealedRound = 0;
    submittedRound = 0;
    showScreen("play");
    beginRound(next);
  } else if (next.phase === "playing") {
    updateHints(next);
  }

  if (next.phase === "reveal") {
    clearInterval(hintClock);
    if (next.round !== renderedRound) {
      renderedRound = next.round;
      resetRoundUI(next);
    }
    if (revealedRound !== next.round) {
      revealedRound = next.round;
      showReveal(next);
    }
    ui.hintPanel.hidden = true;
  }

  renderHud();
  renderPlayers();
  renderSessionPanel();
  renderRoom();
  ensureNames(foundIds());
}

async function maybeAutoStart() {
  if (starting || !state || state.phase !== "lobby") return;
  const connected = state.players.filter((player) => player.connected).length;
  const isHost = mode() !== "online" || me()?.isHost;
  if (!isHost || connected < 2) return;
  starting = true;
  try {
    await session.start({ clipLength: randomLength(), pool: "all" });
  } catch (error) {
    starting = false;
    toast(error.message);
  }
}

function resetRoundUI(next) {
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
  ui.clipTimer.textContent = `0:${String(next.clipLength || 15).padStart(2, "0")}`;
  ui.roundMeta.textContent = `RANDOM ${next.clipLength || 15}s`;
}

function beginRound(next) {
  resetRoundUI(next);
  setStatus("Loading clip");
  showClipPanels(false);
  updateHints(next);
  startHintClock();
  renderHud();
  if (next.videoId) clip.play(next.videoId, next.clipLength);
}

function updateHints(next) {
  hintRemaining = next.nextHintIn ?? 30_000;
  const hints = next.hints ?? [];
  ui.hintNumber.textContent = hints.length ? `HINT ${hints.length}` : "FIRST HINT";
  ui.hintText.textContent = hints.length
    ? hints[hints.length - 1].text
    : "The first hint arrives after 30 seconds.";
  if (next.phase === "playing") ui.hintPanel.hidden = false;
}

function startHintClock() {
  clearInterval(hintClock);
  hintClock = setInterval(() => {
    if (state?.phase !== "playing") return;
    hintRemaining = Math.max(0, hintRemaining - 250);
    ui.nextHint.textContent = `Next in ${countdown(hintRemaining)}`;
    if (hintRemaining === 0) {
      hintRemaining = 30_000;
      session?.refresh();
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
  try {
    await session.guess(guess, skip);
    if (state?.phase === "reveal") return;
    submittedRound = state?.round ?? 0;
    ui.submit.textContent = "Sent";
    setGuessEnabled(false);
    ui.feedbackHead.className = "feedback-head skipped";
    ui.feedbackHead.textContent = "Guess sent — waiting for the other players.";
    ui.answerCard.textContent = skip ? "You skipped this round." : `Your guess: ${guess}`;
    ui.feedback.hidden = false;
  } catch (error) {
    toast(error.message);
  }
}

function showReveal(next) {
  clearTimeout(autoNextTimer);
  clip.pause();
  setGuessEnabled(false);
  setStatus("Round revealed");

  const mine = next.results?.find((result) => result.id === session?.session?.playerId);
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
  name.textContent = next.answer;
  const info = document.createElement("div");
  info.className = "answer-score";
  info.textContent = next.answerInfo
    ? `#${next.answerInfo.position} · ${next.answerInfo.requirement ?? "?"}% · verified by ${next.answerInfo.verifier ?? "unknown"}`
    : "";
  ui.answerCard.append(label, name, info);

  ui.onlineResults.replaceChildren();
  ui.onlineResults.hidden = next.players.length < 2;
  for (const result of [...(next.results ?? [])].sort((a, b) => b.points - a.points)) {
    const row = document.createElement("div");
    row.className = `results-row${result.id === session?.session?.playerId ? " you" : ""}`;
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

  const isHost = mode() !== "online" || me()?.isHost;
  if (isHost) autoNextTimer = setTimeout(() => session?.next().catch(() => {}), 5000);
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
    connected: true, isHost: index === 0, submitted: false,
  }));
  ui.playerMeta.textContent = `${players.length} player${players.length === 1 ? "" : "s"}`;
  ui.playersList.replaceChildren();

  players.forEach((player, index) => {
    const row = document.createElement("div");
    row.className = `player-row${player.id === state?.activePlayerId ? " active" : ""}${player.connected === false ? " offline" : ""}`;
    const rank = document.createElement("span");
    rank.className = "player-rank";
    rank.textContent = String(index + 1).padStart(2, "0");
    const detail = document.createElement("span");
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.name || `Player ${index + 1}`;
    const sub = document.createElement("small");
    sub.className = "player-detail";
    sub.textContent = [
      player.id === state?.activePlayerId ? "current turn" : null,
      `${player.correct ?? 0}/${player.rounds ?? 0} correct`,
      player.submitted ? "guessed" : null,
      player.connected === false ? "offline" : null,
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
  ui.inviteLink.value = `${location.origin}${location.pathname}?invite=${state.code}`;
  ui.roomNotice.textContent = state.players.length < 2
    ? "Share the code. The first round starts when a second player joins."
    : state.phase === "lobby" ? "Starting the first round…"
      : state.phase === "playing" ? `Round ${state.round}: ${state.submissionCount}/${state.players.length} guessed.`
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

async function ensureNames(ids) {
  const missing = ids.filter((id) => !knownNames[id] && !requestedNames.has(id));
  if (!missing.length || !session) return;
  missing.forEach((id) => requestedNames.add(id));
  try {
    for (const demon of await session.collection(missing)) {
      knownNames[demon.id] = { name: demon.name, position: demon.position };
    }
    saveJSON(STORE.names, knownNames);
    renderCollection();
  } catch {
    missing.forEach((id) => requestedNames.delete(id));
  }
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
  ui.addLocalPlayerSetup.hidden = localSetup.length >= MAX_PLAYERS;
}

/* ─────────── Session ─────────── */
function createSession() {
  clearTimeout(autoNextTimer);
  session = new GameSession({ onState, onError: (error) => { ui.mpError.textContent = error; } });
}

async function leaveSession() {
  clearTimeout(autoNextTimer);
  clearInterval(hintClock);
  await session?.leave();
  state = null;
  renderedRound = 0;
  revealedRound = 0;
  submittedRound = 0;
  ui.feedback.hidden = true;
  ui.roomInfo.hidden = true;
  clip.destroy();
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
    if (!state || !["playing", "ended", "error"].includes(state.phase)) return;
    if (clip.player) clip.replay();
    else if (state.phase === "playing") clip.play(state.videoId, state.clipLength);
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
    const onlineTab = tab.dataset.mptab === "online";
    ui.mpLocal.hidden = onlineTab;
    ui.mpOnline.hidden = !onlineTab;
    ui.mpError.textContent = "";
  }));

  const addLocal = () => {
    if (localSetup.length >= MAX_PLAYERS) return;
    localSetup.push({ name: `Player ${localSetup.length + 1}` });
    renderLocalInputs();
  };
  ui.addLocalPlayer.addEventListener("click", addLocal);
  ui.addLocalPlayerSetup.addEventListener("click", addLocal);

  ui.startLocal.addEventListener("click", async () => {
    const names = [...ui.localInputs.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
    if (names.length < 2) return toast("Add at least two players.");
    try {
      await leaveSession();
      createSession();
      await session.create("local", names[0], names.slice(1));
      showScreen("play");
    } catch (error) {
      ui.mpError.textContent = error.message;
    }
  });

  ui.createRoom.addEventListener("click", async () => {
    const name = ui.createName.value.trim();
    if (!name) return toast("Enter your name first.");
    try {
      await leaveSession();
      createSession();
      await session.create("online", name);
      renderRoom();
    } catch (error) {
      ui.mpError.textContent = error.message;
    }
  });

  ui.joinRoom.addEventListener("click", async () => {
    const name = ui.joinName.value.trim();
    const code = ui.joinCode.value.trim();
    if (!name || !code) return toast("Enter your name and the room code.");
    try {
      await leaveSession();
      createSession();
      await session.join(code, name);
      ui.inviteNotice.hidden = true;
      renderRoom();
    } catch (error) {
      ui.mpError.textContent = error.message;
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

  ui.newGame.addEventListener("click", async () => {
    await leaveSession();
    createSession();
    renderPlayers();
    renderSessionPanel();
    showScreen("multiplayer");
  });
  ui.leaveRoom.addEventListener("click", () => ui.newGame.click());

  ui.viewCollection.addEventListener("click", () => showScreen("collection"));

  ui.syncBtn.addEventListener("click", async () => {
    ui.syncBtn.disabled = true;
    ui.syncStatus.textContent = "Fetching Pointercrate…";
    try {
      await request("/api/sync", { method: "POST", body: "{}" });
      meta = await request("/api/meta");
      renderMeta();
      renderSessionPanel();
      ui.syncStatus.textContent = `Synced ${meta.total} levels (${meta.playable} playable).`;
    } catch (error) {
      ui.syncStatus.textContent = `Sync failed: ${error.message}`;
    } finally {
      ui.syncBtn.disabled = false;
    }
  });

  ui.resetBtn.addEventListener("click", async () => {
    if (!window.confirm("Reset every player's score and all identified levels?")) return;
    Object.values(STORE).forEach((key) => localStorage.removeItem(key));
    Object.keys(knownNames).forEach((key) => delete knownNames[key]);
    requestedNames.clear();
    await ui.newGame.click();
    renderCollection();
    toast("Progress reset.");
  });

  document.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === "r" && clip.player && ["playing", "ended", "error"].includes(state?.phase)) {
      event.preventDefault();
      clip.replay();
    }
  });
}

async function init() {
  renderLocalInputs();
  renderMeta();
  renderCollection();
  renderPlayers();
  renderHud();
  bindEvents();
  createSession();
  const resumed = await session.resume();
  meta = await request("/api/meta");
  renderMeta();
  renderSessionPanel();
  renderCollection();

  if (!resumed || session.session?.mode === "solo") {
    if (resumed) await leaveSession();
    createSession();
    renderPlayers();
    showScreen("multiplayer");
  } else if (state?.phase === "lobby") {
    maybeAutoStart();
  }
  applyInvite();
}

function applyInvite() {
  const requested = new URLSearchParams(location.search).get("invite");
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
  const url = new URL(location.href);
  url.searchParams.delete("invite");
  history.replaceState(null, "", url);
}

init().catch((error) => toast(error.message));
