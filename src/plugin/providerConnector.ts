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

export class ProviderConnector {
  public constructor(
    private readonly settings: SettingsPort,
    private readonly dialogs: SecurityDialogPort,
    private readonly factory: ProviderFactory,
  ) {}

  public async createWithConfirmation(): Promise<AiProvider> {
    const config = await loadProviderConfig(this.settings);
    try {
      return this.factory(config);
    } catch (error: unknown) {
      if (!(error instanceof DomainError) || error.code !== "SECURITY")
        throw error;
      await this.confirmRemoteHttp(error);
      return this.factory({ ...config, allowInsecureRemote: true });
    }
  }

  public async check(): Promise<EndpointStatus> {
    try {
      const config = await loadProviderConfig(this.settings);
      if (!config.model) return "unconfigured";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        await this.factory(config).testConnection(controller.signal);
        return "online";
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return "offline";
    }
  }

  private async confirmRemoteHttp(originalError: DomainError): Promise<void> {
    const choice = await this.dialogs.showMessageBox(
      "Security warning: A remote HTTP endpoint can expose note contents and the API key to network observers. Use HTTPS whenever possible. Continue with this endpoint?",
    );
    if (choice !== 0) throw originalError;
    await allowConfirmedRemoteHttp(this.settings);
  }
}
