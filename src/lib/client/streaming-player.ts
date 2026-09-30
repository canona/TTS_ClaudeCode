/**
 * Plays an MP3 stream that is still being generated, on one <audio> element.
 *
 * Primary mode – Media Source Extensions (MSE):
 *   fragments from the NDJSON stream are appended to a SourceBuffer in
 *   "sequence" mode, so the browser treats them as one continuous timeline.
 *   Playback starts after the first few KB, and `audio.currentTime` maps
 *   directly onto the server's cue timeline (captions stay in sync).
 *
 *   Long texts (novels) would exceed the SourceBuffer quota, so we
 *     - keep at most MAX_BUFFER_AHEAD seconds queued ahead of the playhead
 *       (the rest waits in a JS queue and is appended on `timeupdate`),
 *     - evict already-played audio when the browser reports QuotaExceeded.
 *   Once the stream is complete, the element is switched to the full MP3 blob
 *   (at the next pause/end) so the whole audio becomes seekable.
 *
 * Fallback mode – for browsers without MSE (older iOS):
 *   when playback reaches the end of what has been loaded, the element is
 *   reloaded with a Blob of everything received so far and resumes at the
 *   same position ("growing blob").
 */

type MediaSourceConstructor = typeof MediaSource;

const MAX_BUFFER_AHEAD_S = 180;
const KEEP_BEHIND_S = 20;

function findMediaSource(): { Ctor: MediaSourceConstructor; managed: boolean } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { MediaSource?: MediaSourceConstructor; ManagedMediaSource?: MediaSourceConstructor };
  if (w.MediaSource?.isTypeSupported('audio/mpeg')) return { Ctor: w.MediaSource, managed: false };
  // iOS Safari 17.1+ exposes ManagedMediaSource instead of MediaSource.
  if (w.ManagedMediaSource?.isTypeSupported('audio/mpeg')) return { Ctor: w.ManagedMediaSource, managed: true };
  return null;
}

export interface StreamingPlayerEvents {
  /** play() was rejected by the autoplay policy – the user must press play. */
  onAutoplayBlocked?: () => void;
}

export class StreamingAudioPlayer {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private streamEnded = false;
  private objectUrl: string | null = null;
  private pendingFinalBlob: Blob | null = null;

  private fallback = false;
  private fallbackParts: Uint8Array<ArrayBuffer>[] = [];
  private fallbackLoaded = 0; // number of parts in the currently loaded blob

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly events: StreamingPlayerEvents = {},
  ) {
    audio.addEventListener('timeupdate', this.handleTimeUpdate);
    audio.addEventListener('pause', this.handlePauseOrEnd);
    audio.addEventListener('ended', this.handlePauseOrEnd);
  }

  /** True while playing from an incomplete stream (seeking is limited to buffered audio). */
  get isLive(): boolean {
    return this.mediaSource !== null || (this.fallback && !this.streamEnded);
  }

  /**
   * Prepares a new stream. Call synchronously inside the click handler:
   * calling play() within the user gesture satisfies autoplay policies
   * (notably Safari); the promise simply resolves once data arrives.
   */
  begin(): void {
    this.reset();
    const found = findMediaSource();
    if (!found) {
      this.fallback = true;
      this.fallbackParts = [];
      this.fallbackLoaded = 0;
      return;
    }
    const mediaSource = new found.Ctor();
    this.mediaSource = mediaSource;
    if (found.managed) this.audio.disableRemotePlayback = true; // required by ManagedMediaSource
    this.objectUrl = URL.createObjectURL(mediaSource);
    this.audio.src = this.objectUrl;
    mediaSource.addEventListener(
      'sourceopen',
      () => {
        if (this.mediaSource !== mediaSource) return;
        const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        // "sequence": each append is placed right after the previous one,
        // regardless of timestamps inside the MP3 fragments.
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', this.pump);
        this.sourceBuffer = sourceBuffer;
        this.pump();
      },
      { once: true },
    );
    this.play();
  }

  /** Appends an MP3 fragment received from the server. */
  append(bytes: Uint8Array<ArrayBuffer>): void {
    if (bytes.length === 0) return;
    if (this.fallback) {
      this.fallbackParts.push(bytes);
      this.refreshFallback();
      return;
    }
    this.queue.push(bytes);
    this.pump();
  }

  /** No more fragments will come. */
  end(): void {
    this.streamEnded = true;
    if (this.fallback) this.refreshFallback();
    else this.pump();
  }

  /**
   * Hands over the complete MP3. Switches to it as soon as that won't
   * interrupt the listener (now if paused, otherwise at the next pause/end).
   */
  finalize(blob: Blob): void {
    // In fallback mode the growing blob already converges to the full file.
    if (this.fallback) return;
    this.pendingFinalBlob = blob;
    if (this.audio.paused || this.audio.ended) this.swapToFinalBlob();
  }

  /** Plays a complete file (e.g. from cache). */
  loadBlob(blob: Blob, autoplay: boolean, startAt = 0): void {
    this.reset();
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    if (startAt > 0) {
      this.audio.addEventListener('loadedmetadata', () => (this.audio.currentTime = startAt), { once: true });
    }
    if (autoplay) this.play();
  }

  play(): void {
    this.audio.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'NotAllowedError') this.events.onAutoplayBlocked?.();
    });
  }

  /** Seeks if the target is playable; while live, only buffered audio is seekable. */
  seek(time: number): boolean {
    const t = Math.max(0, time);
    if (this.isLive) {
      const ranges = this.audio.buffered;
      let ok = false;
      for (let i = 0; i < ranges.length; i++) {
        if (t >= ranges.start(i) && t <= ranges.end(i)) ok = true;
      }
      if (!ok) return false;
    }
    this.audio.currentTime = t;
    return true;
  }

  /** Stops playback and releases every resource of the current stream. */
  reset(): void {
    this.queue = [];
    this.streamEnded = false;
    this.pendingFinalBlob = null;
    this.fallback = false;
    this.fallbackParts = [];
    this.fallbackLoaded = 0;
    this.sourceBuffer?.removeEventListener('updateend', this.pump);
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  destroy(): void {
    this.reset();
    this.audio.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.audio.removeEventListener('pause', this.handlePauseOrEnd);
    this.audio.removeEventListener('ended', this.handlePauseOrEnd);
  }

  // ───────────────────────── MSE internals ─────────────────────────

  private bufferedEnd(): number {
    const ranges = this.sourceBuffer?.buffered;
    return ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
  }

  /** Moves queued fragments into the SourceBuffer, one append at a time. */
  private readonly pump = (): void => {
    const mediaSource = this.mediaSource;
    const sourceBuffer = this.sourceBuffer;
    if (!mediaSource || !sourceBuffer || mediaSource.readyState !== 'open' || sourceBuffer.updating) return;

    if (this.queue.length === 0) {
      if (this.streamEnded) {
        try {
          mediaSource.endOfStream(); // lets the element fire `ended` and know the duration
        } catch {
          /* already ended */
        }
      }
      return;
    }
    // Throttle: don't buffer more than MAX_BUFFER_AHEAD_S ahead (resumed by timeupdate).
    if (this.bufferedEnd() - this.audio.currentTime > MAX_BUFFER_AHEAD_S) return;

    // Merge all queued fragments into one append – far fewer updateend round trips.
    const total = this.queue.reduce((sum, b) => sum + b.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const b of this.queue) {
      merged.set(b, offset);
      offset += b.length;
    }
    try {
      sourceBuffer.appendBuffer(merged);
      this.queue = [];
    } catch (err) {
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        this.queue = [merged];
        this.evictPlayed();
      } else {
        console.error('[player] appendBuffer failed', err);
      }
    }
  };

  /** Frees already-played audio; `updateend` then triggers another pump. */
  private evictPlayed(): void {
    const sourceBuffer = this.sourceBuffer;
    if (!sourceBuffer || sourceBuffer.updating || sourceBuffer.buffered.length === 0) return;
    const start = sourceBuffer.buffered.start(0);
    const end = this.audio.currentTime - KEEP_BEHIND_S;
    if (end > start) sourceBuffer.remove(start, end);
    // else: nothing to free yet – retried on the next timeupdate
  }

  private readonly handleTimeUpdate = (): void => {
    if (this.mediaSource) this.pump();
  };

  private readonly handlePauseOrEnd = (): void => {
    if (this.pendingFinalBlob) this.swapToFinalBlob();
    else if (this.fallback) this.refreshFallback();
  };

  private swapToFinalBlob(): void {
    const blob = this.pendingFinalBlob;
    if (!blob) return;
    const position = this.audio.ended ? 0 : this.audio.currentTime;
    const rate = this.audio.playbackRate;
    this.loadBlob(blob, false, position);
    this.audio.playbackRate = rate;
  }

  // ─────────────────────── fallback internals ───────────────────────

  private refreshFallback(): void {
    if (this.fallbackParts.length === this.fallbackLoaded) return;
    const hasSource = this.fallbackLoaded > 0;
    const atEnd = !hasSource || this.audio.ended;
    if (!atEnd && !this.streamEnded) return; // still playing loaded audio – reload later
    if (!atEnd && !this.audio.paused) return;
    const position = hasSource ? this.audio.currentTime : 0;
    const wasPlaying = !hasSource || this.audio.ended;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.fallbackLoaded = this.fallbackParts.length;
    this.objectUrl = URL.createObjectURL(new Blob(this.fallbackParts, { type: 'audio/mpeg' }));
    this.audio.src = this.objectUrl;
    this.audio.addEventListener('loadedmetadata', () => (this.audio.currentTime = position), { once: true });
    if (wasPlaying) this.play();
  }
}
