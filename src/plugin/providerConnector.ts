import type { AiProvider, ProviderConfig } from "../providers/types";
import { DomainError } from "../shared/errors";
import {
  allowConfirmedRemoteHttp,
  loadProviderConfig,
  type SettingsPort,
} from "./settings";
import { reconcileInsecureOrigin } from "../providers/endpoint";

interface SecurityDialogPort {
  showMessageBox(message: string): Promise<number>;
}

type ProviderFactory = (config: ProviderConfig) => AiProvider;

export type EndpointStatus = "unconfigured" | "checking" | "online" | "offline";
export interface ProviderSession {
  readonly provider: AiProvider;
  readonly config: ProviderConfig;
}
export interface EndpointCheck {
  readonly status: EndpointStatus;
  readonly modelName: string;
  readonly availableModels: readonly string[];
}

export class ProviderConnector {
  public constructor(
    private readonly settings: SettingsPort,
    private readonly dialogs: SecurityDialogPort,
    private readonly factory: ProviderFactory,
  ) {}

  /**
   * Creates one provider from the validated config returned with the session.
   *
   * @example const { provider, config } = await connector.connectWithConfirmation()
   */
  public async connectWithConfirmation(): Promise<ProviderSession> {
    const loaded = await loadProviderConfig(this.settings);
    const config = await reconcileInsecureOrigin(this.settings, loaded);
    try {
      return this.createSession(config);
    } catch (error: unknown) {
      if (!(error instanceof DomainError) || error.code !== "SECURITY")
        throw error;
      await this.confirmRemoteHttp(error, config);
      return this.createSession({
        ...config,
        allowInsecureRemote: true,
        allowedInsecureOrigin: new URL(config.baseUrl).origin,
      });
    }
  }

  public async check(): Promise<EndpointCheck> {
    try {
      const config = await loadProviderConfig(this.settings);
      if (!config.model) {
        return { status: "unconfigured", modelName: "", availableModels: [] };
      }
      const { status, models } = await this.testProvider(config);
      return { status, modelName: config.model, availableModels: models };
    } catch {
      return { status: "offline", modelName: "", availableModels: [] };
    }
  }

  /**
   * Lists models from the configured provider without mutating settings.
   *
   * @example await connector.listModels()
   */
  public async listModels(): Promise<readonly string[]> {
    try {
      const session = await this.connectWithConfirmation();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), session.config.timeoutMs);
      try {
        return await session.provider.listModels(controller.signal);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return [];
    }
  }

  /**
   * Persists a new model selection in plugin settings.
   *
   * @example await connector.selectModel('llama3')
   */
  public async selectModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) {
      throw new DomainError(
        "VALIDATION",
        `Invalid model ${JSON.stringify(model)}; expected a non-empty model name`,
      );
    }
    await this.settings.setValue("joplinAiAgent.model", trimmed);
  }

  private async confirmRemoteHttp(
    originalError: DomainError,
    config: ProviderConfig,
  ): Promise<void> {
    const choice = await this.dialogs.showMessageBox(
      "Security warning: A remote HTTP endpoint can expose note contents and the API key to network observers. Use HTTPS whenever possible. Continue with this endpoint?",
    );
    if (choice !== 0) throw originalError;
    await allowConfirmedRemoteHttp(
      this.settings,
      new URL(config.baseUrl).origin,
    );
  }

  private createSession(config: ProviderConfig): ProviderSession {
    return { provider: this.factory(config), config };
  }

  private async testProvider(
    config: ProviderConfig,
  ): Promise<{ readonly status: EndpointStatus; readonly models: readonly string[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const provider = this.factory(config);
      await provider.testConnection(controller.signal);
      const models = await provider.listModels(controller.signal);
      return { status: "online", models };
    } catch {
      return { status: "offline", models: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}
