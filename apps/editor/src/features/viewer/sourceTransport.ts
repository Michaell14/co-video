/**
 * Transport for the source monitor: what Space, J K L and the arrow keys do to the programme, done
 * to an `<audio>` or `<video>` element instead.
 */

/** Fastest shuttle speed in either direction, as a multiple of normal speed. */
const MAX_SHUTTLE = 8;
/** Longest stretch one step of winding back may account for, in seconds. */
const MAX_STEP = 0.1;

export class SourceTransport {
  private el: HTMLMediaElement | null = null;
  /** Speed the source is being wound back at, as a multiple of normal speed; 0 when it is not. */
  private rewinding = 0;
  /** Where winding back has got to, in seconds. The element follows as fast as it can seek. */
  private target = 0;
  private last = 0;
  private raf = 0;

  /** The element to drive, or null when there is none (a still image, or not loaded yet). */
  attach(el: HTMLMediaElement | null): void {
    if (el === this.el) return;
    this.stopRewind();
    this.el = el;
  }

  get element(): HTMLMediaElement | null {
    return this.el;
  }

  /** Current position in seconds. */
  get time(): number {
    return this.rewinding ? this.target : (this.el?.currentTime ?? 0);
  }

  get moving(): boolean {
    return this.rewinding > 0 || (!!this.el && !this.el.paused);
  }

  toggle(): void {
    if (this.moving) this.pause();
    else this.play(1);
  }

  pause(): void {
    this.stopRewind();
    if (!this.el) return;
    this.el.pause();
    this.el.playbackRate = 1;
  }

  /** L plays forwards and J backwards; pressing the same one again doubles the speed. */
  shuttle(dir: -1 | 1): void {
    const el = this.el;
    if (!el) return;
    if (dir > 0) {
      const faster = !el.paused && !this.rewinding;
      this.play(faster ? Math.min(MAX_SHUTTLE, el.playbackRate * 2) : 1);
      return;
    }
    const rate = this.rewinding ? Math.min(MAX_SHUTTLE, this.rewinding * 2) : 1;
    if (!this.rewinding) {
      el.pause();
      el.playbackRate = 1;
      this.target = el.currentTime;
      this.last = performance.now();
    }
    this.rewinding = rate;
    if (!this.raf) this.raf = requestAnimationFrame(this.wind);
  }

  /** Stop and move by `seconds` (negative is back). */
  step(seconds: number): void {
    this.seek(this.time + seconds);
  }

  /** Stop and go to `time` seconds, kept within the source. */
  seek(time: number): void {
    const at = this.clampTime(time);
    this.pause();
    if (this.el) this.el.currentTime = at;
  }

  dispose(): void {
    this.stopRewind();
    this.el = null;
  }

  private play(rate: number): void {
    this.stopRewind();
    if (!this.el) return;
    this.el.playbackRate = rate;
    // Rejected when the element is torn down or paused again first; neither needs an answer.
    void this.el.play().catch(() => {});
  }

  private clampTime(time: number): number {
    const length = this.el && Number.isFinite(this.el.duration) ? this.el.duration : 0;
    return Math.max(0, Math.min(time, length));
  }

  private stopRewind(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.rewinding && this.el) this.el.currentTime = this.target;
    this.rewinding = 0;
  }

  /**
   * Media elements only play forwards, so winding back is a run of seeks. The position is kept
   * here and handed to the element whenever it has finished the previous seek; that way a slow
   * decoder shows fewer frames but does not fall behind the clock.
   */
  private readonly wind = (now: number): void => {
    this.raf = 0;
    const el = this.el;
    if (!el || !this.rewinding) return;
    const dt = Math.min(MAX_STEP, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.target = Math.max(0, this.target - dt * this.rewinding);
    if (!el.seeking) el.currentTime = this.target;
    if (this.target <= 0) {
      this.stopRewind();
      return;
    }
    this.raf = requestAnimationFrame(this.wind);
  };
}
