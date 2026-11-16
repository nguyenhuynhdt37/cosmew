export type DirtyRegion =
  'composer' | 'transcript' | 'status' | 'header' | 'overlay' | 'sidebar' | 'animation' | 'resize';

/** At most one pending frame. Input shortens a provider coalescing deadline. */
export class FrameScheduler {
  private dirty = new Set<DirtyRegion>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private urgent = false;
  private blocked = false;
  private disposed = false;
  constructor(private readonly paint: (regions: ReadonlySet<DirtyRegion>) => void) {}
  request(region: DirtyRegion, input = false): void {
    if (this.disposed) return;
    this.dirty.add(region);
    if (input && !this.urgent && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.urgent ||= input;
    this.schedule();
  }
  private schedule(): void {
    if (this.timer || this.blocked || this.disposed || !this.dirty.size) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const dirty = this.dirty;
        this.dirty = new Set();
        this.urgent = false;
        this.paint(dirty);
        this.schedule();
      },
      this.urgent ? 0 : 16,
    );
  }
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!blocked) this.schedule();
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
  }
}
