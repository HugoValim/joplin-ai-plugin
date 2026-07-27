export class DeltaBatcher {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly send: (delta: string) => void) {}

  public push(delta: string): void {
    this.buffer += delta;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 40);
  }

  public flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer) return;
    const delta = this.buffer;
    this.buffer = "";
    this.send(delta);
  }

  public dispose(): void {
    this.flush();
  }
}
