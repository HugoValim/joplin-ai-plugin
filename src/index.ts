import joplin from "api";
import { startPlugin } from "./plugin/startup";

void joplin.plugins.register({
  onStart: async (): Promise<void> => startPlugin(joplin),
});
