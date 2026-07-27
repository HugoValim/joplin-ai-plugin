export class RunCancellationRegistry {
  private readonly runs = new Map<
    string,
    { readonly runId: string; readonly controller: AbortController }
  >();

  public replace(
    chatId: string,
    runId: string,
    controller: AbortController,
  ): void {
    this.runs
      .get(chatId)
      ?.controller.abort(new Error("Superseded by a new run"));
    this.runs.set(chatId, { runId, controller });
  }

  public cancel(chatId: string, runId: string): void {
    const current = this.runs.get(chatId);
    if (current?.runId !== runId) return;
    current.controller.abort(new Error(`Cancelled run ${runId}`));
  }

  public cancelChat(chatId: string, reason: string): void {
    this.runs.get(chatId)?.controller.abort(new Error(reason));
  }

  public clearIfCurrent(chatId: string, expected: AbortController): void {
    if (this.runs.get(chatId)?.controller !== expected) return;
    this.runs.delete(chatId);
  }
}
