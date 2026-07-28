import type {
  AiProvider,
  ProviderConfig,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import { ProviderConnector } from "../../src/plugin/providerConnector";
import type { SettingsPort } from "../../src/plugin/settings";

class FakeSettingsPort implements SettingsPort {
  public valueReads = 0;

  public async registerSection(): Promise<void> {
    return Promise.resolve();
  }

  public async registerSettings(): Promise<void> {
    return Promise.resolve();
  }

  public async values(keys: string[]): Promise<Record<string, unknown>> {
    this.valueReads += 1;
    return Object.fromEntries(
      keys.map((key) => [key, PROVIDER_VALUES[key] ?? null]),
    );
  }

  public async setValue(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSecurityDialog {
  public async showMessageBox(): Promise<number> {
    return 1;
  }
}

class FakeProvider implements AiProvider {
  public async *streamChat(
    _request: StreamChatRequest,
    _abortSignal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }
}

const PROVIDER_VALUES: Readonly<Record<string, unknown>> = {
  "joplinAiAgent.baseUrl": "https://provider.example/v1",
  "joplinAiAgent.apiKey": "secret-never-prompted",
  "joplinAiAgent.model": "glm-5.2:cloud",
  "joplinAiAgent.temperature": "0.2",
  "joplinAiAgent.maxOutputTokens": 2_000,
  "joplinAiAgent.timeoutMs": 120_000,
  "joplinAiAgent.allowInsecureRemote": false,
  "joplinAiAgent.allowedInsecureOrigin": "",
};

describe("ProviderConnector", () => {
  test("returns provider and validated config from one settings read", async () => {
    const settings = new FakeSettingsPort();
    const provider = new FakeProvider();
    let factoryConfig: ProviderConfig | null = null;
    const connector = new ProviderConnector(
      settings,
      new FakeSecurityDialog(),
      (config) => {
        factoryConfig = config;
        return provider;
      },
    );

    const session = await connector.connectWithConfirmation();

    expect(session.provider).toBe(provider);
    expect(session.config.model).toBe("glm-5.2:cloud");
    expect(factoryConfig).toBe(session.config);
    expect(settings.valueReads).toBe(1);
  });

  test("checks endpoint and reports model from the same settings read", async () => {
    const settings = new FakeSettingsPort();
    const connector = new ProviderConnector(
      settings,
      new FakeSecurityDialog(),
      () => new FakeProvider(),
    );

    await expect(connector.check()).resolves.toEqual({
      status: "online",
      modelName: "glm-5.2:cloud",
    });
    expect(settings.valueReads).toBe(1);
  });
});
