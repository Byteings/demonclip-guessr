let apiPromise = null;

function loadApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const fail = (error) => { apiPromise = null; reject(error); };
    if (window.YT?.Player) return resolve(window.YT);

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve(window.YT);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => fail(new Error("Could not load the YouTube player"));
    document.head.appendChild(script);
    setTimeout(() => fail(new Error("YouTube player timed out")), 15_000);
  });
  return apiPromise;
}

/**
 * Plays a bounded slice of a YouTube video. The host element is preserved so
 * the player can be rebuilt for each round.
 */
export class ClipPlayer {
  constructor({ host, onPlaying, onEnded, onError, onProgress, onBlocked }) {
    this.host = typeof host === "string" ? document.getElementById(host) : host;
    this.callbacks = { onPlaying, onEnded, onError, onProgress, onBlocked };
    this.player = null;
    this.timer = null;
    this.blockTimer = null;
    this.start = 0;
    this.length = 15;
    this.duration = 0;
    this.running = false;
    this.stopped = false;
    this.muted = false;
  }

  async play(videoId, length, start = null, muted = true) {
    this.destroy();
    this.videoId = videoId;
    this.length = length;
    this.muted = muted;
    this.requestedStart = start;
    this.stopped = false;
    this.running = false;

    try {
      const YT = await loadApi();
      const mount = document.createElement("div");
      this.host.replaceChildren(mount);
      this.player = new YT.Player(mount, {
        width: "100%",
        height: "100%",
        videoId,
        playerVars: {
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          origin: location.protocol === "http:" || location.protocol === "https:" ? location.origin : undefined,
        },
        events: {
          onReady: () => this.handleReady(YT),
          onStateChange: (event) => this.handleState(event, YT),
          onError: (event) => this.handleError(event),
        },
      });
    } catch (error) {
      this.callbacks.onError?.(error.message);
    }
  }

  handleReady(YT) {
    if (!this.player || this.stopped) return;
    this.duration = Number(this.player.getDuration()) || 0;
    this.length = Math.min(this.length, Math.max(5, this.duration || this.length));
    const min = Math.min(12, Math.max(0, this.duration * 0.1));
    const max = Math.max(min, this.duration - this.length - 2);
    const requested = this.requestedStart;
    this.start = requested == null
      ? (this.duration > this.length + 4 ? min + Math.random() * (max - min) : 0)
      : Math.max(0, Math.min(this.duration, requested <= 1 ? requested * this.duration : requested));
    try {
      if (this.muted) this.player.mute?.();
      else this.player.unMute?.();
    } catch { /* audio may be blocked until the user interacts */ }
    this.player.seekTo(this.start, true);
    this.player.playVideo();
    this.watchAutoplay(YT);
  }

  watchAutoplay(YT, attempt = 0) {
    clearTimeout(this.blockTimer);
    this.blockTimer = setTimeout(() => {
      if (!this.player || this.stopped || this.running) return;
      const state = this.player.getPlayerState();
      if (state === YT.PlayerState.BUFFERING && attempt < 12) return this.watchAutoplay(YT, attempt + 1);
      if (state === YT.PlayerState.UNSTARTED || state === YT.PlayerState.PAUSED) this.callbacks.onBlocked?.();
    }, 2000);
  }

  handleState(event, YT) {
    if (!this.player || this.stopped) return;
    const state = event.data;

    if (state === YT.PlayerState.PLAYING && !this.running) {
      clearTimeout(this.blockTimer);
      this.running = true;
      this.callbacks.onPlaying?.();
      this.startTicker();
      return;
    }

    if (state === YT.PlayerState.ENDED && this.running) {
      this.finish();
      return;
    }

    if (state === YT.PlayerState.PAUSED && this.running && !this.intentionalPause) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.intentionalPause = false;
  }

  handleError(event) {
    if (this.stopped) return;
    const code = event?.data;
    const message = [2, 5, 100, 101, 150].includes(code)
      ? "This video is unavailable for embedding."
      : "The video could not be played.";
    this.callbacks.onError?.(message);
  }

  startTicker() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.running || !this.player) return;
      let elapsed = 0;
      try { elapsed = this.player.getCurrentTime() - this.start; } catch { return; }
      elapsed = Math.max(0, elapsed);
      const remaining = Math.max(0, this.length - elapsed);
      this.callbacks.onProgress?.(elapsed, remaining, Math.min(100, (elapsed / this.length) * 100));
      if (elapsed >= this.length) this.finish();
    }, 100);
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    this.intentionalPause = true;
    try { this.player?.pauseVideo(); } catch { /* noop */ }
    this.callbacks.onProgress?.(this.length, 0, 100);
    this.callbacks.onEnded?.();
  }

  replay() {
    if (!this.player || this.stopped) return false;
    this.running = false;
    this.intentionalPause = false;
    clearInterval(this.timer);
    try {
      this.player.unMute?.();
      this.muted = false;
      this.player.seekTo(this.start, true);
      this.player.playVideo();
      return true;
    } catch {
      return false;
    }
  }

  resume() {
    try { this.player?.playVideo(); } catch { /* noop */ }
  }

  pause() {
    this.intentionalPause = true;
    try { this.player?.pauseVideo(); } catch { /* noop */ }
  }

  setMuted(muted) {
    if (!this.player?.mute) return;
    if (muted) this.player.mute(); else this.player.unMute();
    this.muted = muted;
  }

  isMuted() {
    try { return Boolean(this.player?.isMuted?.()); } catch { return this.muted; }
  }

  destroy() {
    clearInterval(this.timer);
    clearTimeout(this.blockTimer);
    this.timer = null;
    this.blockTimer = null;
    this.running = false;
    this.stopped = true;
    if (this.player?.destroy) {
      try { this.player.destroy(); } catch { /* noop */ }
    }
    this.player = null;
    this.host.replaceChildren();
  }
}
