interface JoplinWebviewApi {
  postMessage(message: object): Promise<unknown>;
  onMessage(callback: (message: unknown) => void): void;
}

declare const webviewApi: JoplinWebviewApi;
