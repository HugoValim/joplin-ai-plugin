import type { AiProvider, ProviderConfig } from "../providers/types";

export interface DialogPort {
  showOpenDialog(options: {
    readonly title: string;
    readonly properties: readonly string[];
  }): Promise<readonly string[] | null>;
  showMessageBox(message: string): Promise<number>;
}

export interface CommandPort {
  execute(commandName: string, ...args: unknown[]): Promise<unknown>;
}

export type ProviderFactory = (config: ProviderConfig) => AiProvider;
