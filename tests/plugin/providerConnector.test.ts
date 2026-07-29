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

  public async listModels(): Promise<readonly string[]> {
    return ["glm-5.2:cloud"];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
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
      availableModels: ["glm-5.2:cloud"],
      contextWindowMax: null,
    });
    expect(settings.valueReads).toBe(1);
  });

  test("keeps cached models when a later check goes offline", async () => {
    class OfflineProvider extends FakeProvider {
      public override async testConnection(): Promise<void> {
        throw new Error("unreachable");
      }

      public override async listModels(): Promise<readonly string[]> {
        throw new Error("unreachable");
      }
    }

    class ListingProvider extends FakeProvider {
      public override async listModels(): Promise<readonly string[]> {
        return ["glm-5.2:cloud", "kimi-k3:cloud"];
      }
    }

    let offline = false;
    const connector = new ProviderConnector(
      new FakeSettingsPort(),
      new FakeSecurityDialog(),
      () => (offline ? new OfflineProvider() : new ListingProvider()),
    );

    await expect(connector.check()).resolves.toMatchObject({
      status: "online",
      availableModels: ["glm-5.2:cloud", "kimi-k3:cloud"],
    });
    offline = true;
    await expect(connector.check()).resolves.toEqual({
      status: "offline",
      modelName: "glm-5.2:cloud",
      availableModels: ["glm-5.2:cloud", "kimi-k3:cloud"],
      contextWindowMax: null,
    });
  });

  test("includes the configured model even when listing fails on first check", async () => {
    class OfflineProvider extends FakeProvider {
      public override async testConnection(): Promise<void> {
        throw new Error("unreachable");
      }

      public override async listModels(): Promise<readonly string[]> {
        throw new Error("unreachable");
      }
    }

    const connector = new ProviderConnector(
      new FakeSettingsPort(),
      new FakeSecurityDialog(),
      () => new OfflineProvider(),
    );

    await expect(connector.check()).resolves.toEqual({
      status: "offline",
      modelName: "glm-5.2:cloud",
      availableModels: ["glm-5.2:cloud"],
      contextWindowMax: null,
    });
  });

  test("marks the endpoint offline when the selected model is unavailable", async () => {
    class UnavailableModelProvider extends FakeProvider {
      public override async modelAvailable(): Promise<boolean> {
        return false;
      }
    }

    const connector = new ProviderConnector(
      new FakeSettingsPort(),
      new FakeSecurityDialog(),
      () => new UnavailableModelProvider(),
    );

    await expect(connector.check()).resolves.toMatchObject({
      status: "offline",
      modelName: "glm-5.2:cloud",
      availableModels: ["glm-5.2:cloud"],
    });
  });
});
