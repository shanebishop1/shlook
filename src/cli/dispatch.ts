import { connect } from "./connection.ts";
import { authCheck } from "./commands/auth.ts";
import { assetCommand, allowsAssetSecrets } from "./commands/assets.ts";
import { publish } from "./commands/publish.ts";
import { setup } from "./commands/setup.ts";
import { withConnectionProfile, usesConnectionProfile } from "./origins.ts";
import { CliError } from "./errors.ts";
import type { CliCommandResult, CliDependencies, CliOptions } from "./types.ts";

export async function dispatch(
  positionals: string[],
  options: CliOptions,
  dependencies: CliDependencies,
): Promise<CliCommandResult> {
  const [command, ...args] = positionals;
  if (command === undefined) throw new CliError("usage_error", "a command is required");
  if (command === "connect") return { command, data: await connect(dependencies, args) };
  if (usesConnectionProfile(positionals)) dependencies = await withConnectionProfile(dependencies);
  if (command === "auth" && args[0] === "check")
    return { command, data: await authCheck(dependencies) };
  if (
    [
      "status",
      "list",
      "show",
      "visibility",
      "secret",
      "share",
      "hard",
      "delete",
      "verify",
    ].includes(command)
  ) {
    return {
      command,
      data: await assetCommand(command, args, { offset: options.offset }, dependencies),
      ...(allowsAssetSecrets(command, args) ? { allowSecrets: true } : {}),
    };
  }
  if (command === "setup") return { command, ...(await setup(dependencies, args, options)) };
  if (command === "publish") {
    return {
      command,
      data: await publish(
        dependencies,
        args[0],
        options.name,
        options.description,
        options.entrypoint,
      ),
    };
  }
  throw new CliError("usage_error", `unknown command: ${command}`);
}
