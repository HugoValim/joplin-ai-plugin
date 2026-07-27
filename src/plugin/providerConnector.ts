import type { AiProvider, ProviderConfig } from "../providers/types";
import { DomainError } from "../shared/errors";
import {
  allowConfirmedRemoteHttp,
  loadProviderConfig,
  type SettingsPort,
} from "./settings";

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
    const config = await loadProviderConfig(this.settings);
    try {
      return this.createSession(config);
    } catch (error: unknown) {
      if (!(error instanceof DomainError) || error.code !== "SECURITY")
        throw error;
      await this.confirmRemoteHttp(error);
      return this.createSession({ ...config, allowInsecureRemote: true });
    }
  }

  public async check(): Promise<EndpointCheck> {
    try {
      const config = await loadProviderConfig(this.settings);
      if (!config.model) return { status: "unconfigured", modelName: "" };
      const status = await this.testProvider(config);
      return { status, modelName: config.model };
    } catch {
      return { status: "offline", modelName: "" };
    }
  }

  private async confirmRemoteHttp(originalError: DomainError): Promise<void> {
    const choice = await this.dialogs.showMessageBox(
      "Security warning: A remote HTTP endpoint can expose note contents and the API key to network observers. Use HTTPS whenever possible. Continue with this endpoint?",
    );
    if (choice !== 0) throw originalError;
    await allowConfirmedRemoteHttp(this.settings);
  }

  private createSession(config: ProviderConfig): ProviderSession {
    return { provider: this.factory(config), config };
  }

  private async testProvider(config: ProviderConfig): Promise<EndpointStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      await this.factory(config).testConnection(controller.signal);
      return "online";
    } finally {
      clearTimeout(timer);
    }
  }
}
