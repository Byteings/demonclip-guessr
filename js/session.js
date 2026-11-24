import { request, loadJSON, saveJSON } from "./core.js";

const SESSION_KEY = "dcg.session.v3";

/**
 * One authenticated connection to a server-authoritative room. Solo, local
 * pass-and-play and online rooms all use this same protocol; the browser only
 * ever receives a YouTube ID, hints and (after the reveal) the answer.
 */
export class GameSession {
  constructor({ onState, onError }) {
    this.onState = onState;
    this.onError = onError;
    this.session = loadJSON(SESSION_KEY, null);
    this.state = null;
    this.timer = null;
  }

  get headers() {
    if (!this.session) return {};
    return { "x-player-id": this.session.playerId, "x-player-token": this.session.token };
  }

  get code() {
    return this.session?.code ?? null;
  }

  apply(result) {
    if (result.playerId) {
      this.session = {
        code: result.code,
        playerId: result.playerId,
        token: result.token,
        mode: result.state?.mode,
        seats: result.seats ?? this.session?.seats ?? null,
      };
      saveJSON(SESSION_KEY, this.session);
    }
    if (result.state) {
      this.state = result.state;
      this.onState(result.state);
    }
    return result;
  }

  /** Switches the credentials used for pass-and-play turns. */
  useSeat(playerId) {
    const seat = this.session?.seats?.find((entry) => entry.playerId === playerId);
    if (!seat || seat.playerId === this.session.playerId) return;
    this.session.playerId = seat.playerId;
    this.session.token = seat.token;
    saveJSON(SESSION_KEY, this.session);
  }

  async create(mode, name, seats = []) {
    const result = await request("/api/session", {
      method: "POST",
      body: JSON.stringify({ mode, name, seats }),
    });
    this.apply(result);
    this.startPolling();
    return result;
  }

  async join(code, name) {
    const result = await request(`/api/rooms/${String(code).trim().toUpperCase()}/join`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    this.apply(result);
    this.startPolling();
    return result;
  }

  async resume() {
    if (!this.session) return false;
    try {
      await this.refresh();
      return true;
    } catch {
      this.clear();
      return false;
    }
  }

  async refresh() {
    if (!this.session) return;
    try {
      const state = await request(`/api/rooms/${this.session.code}`, { headers: this.headers });
      this.state = state;
      this.onState(state);
    } catch (error) {
      this.onError(error.message);
    }
  }

  startPolling() {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1200);
  }

  async action(name, body = {}) {
    return this.apply(await request(`/api/rooms/${this.session.code}/${name}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    }));
  }

  start(settings) {
    return this.action("start", settings);
  }

  guess(guess, skip = false) {
    return this.action("guess", { guess, skip });
  }

  next() {
    return this.action("next", {});
  }

  settings(settings) {
    return this.action("settings", settings);
  }

  async collection(ids) {
    if (!this.session || !ids.length) return [];
    const result = await request("/api/collection", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ code: this.session.code, ids }),
    });
    return result.demons;
  }

  async leave() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.session) {
      try {
        await request(`/api/rooms/${this.session.code}`, { method: "DELETE", headers: this.headers });
      } catch {
        /* leaving is best-effort */
      }
    }
    this.clear();
  }

  clear() {
    clearInterval(this.timer);
    this.timer = null;
    this.session = null;
    this.state = null;
    saveJSON(SESSION_KEY, null);
  }
}
