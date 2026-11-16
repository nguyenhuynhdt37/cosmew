import type {FynState} from './types';

export class FynCompanion {
  private state: FynState = 'idle';
  private elapsed = 0;
  private quiet = 0;
  private motion = 0;

  transition(state: FynState): void {
    if (this.state === state) return;
    this.state = state;
    this.elapsed = 0;
    this.quiet = 0;
    this.motion = 0;
  }

  activity(): void {
    this.quiet = 0;
    if (this.state === 'sleep') this.transition('idle');
  }

  tick(delta: number, animate: boolean, speed = 1): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.elapsed += delta;
    this.quiet += delta;
    if (animate) this.motion += delta * speed;
    if ((this.state === 'done' || this.state === 'cancelled') && this.elapsed >= 1.8) {
      this.transition('idle');
    } else if (this.state === 'idle' && this.quiet >= 60) {
      this.transition('sleep');
    }
  }

  view(pendingApproval: boolean, reactive: boolean, reducedMotion: boolean): {state: FynState; time: number} {
    return {
      state: reactive ? (pendingApproval ? 'waiting' : this.state) : 'idle',
      time: reducedMotion ? 0 : this.motion,
    };
  }
}

/** Original 28×24 block art, packed two logical pixels into each terminal row. */
