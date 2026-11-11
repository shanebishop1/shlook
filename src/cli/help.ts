export const CLI_HELP = `shlook - Private-by-default artifact hosting for agents

Usage: shlook <command> [options]

Commands:
  instance add <name> --url <origin>  Add a named instance
  instance list                     List configured instances
  instance default <name>            Set the default instance
  instance remove <name>             Remove an instance
  connect [--from-env]               Save and verify a connection
  setup (--plan | --apply)           Set up Cloudflare hosting
  auth check                        Check authentication
  status                            Check instance health
  publish <path> --name <name>       Publish a file or static directory
  list [--offset <n>]                List artifacts
  show <asset-id>                    Show artifact metadata
  verify <asset-id>                  Verify an artifact is accessible
  visibility <asset-id> <mode>       Set private, secret_link, or public visibility
  secret create|rotate|revoke <id>    Manage a secret link
  share expiry <id> <ISO-date|none>   Set secret-link expiry
  hard expiry <id> <ISO-date|none>    Set artifact expiry
  delete <asset-id>                  Delete an artifact

Options:
  -h, --help                        Show this help without running a command
  --json                            Emit machine-readable JSON
  --instance <name>                 Select a configured instance

Examples:
  shlook connect
  shlook publish ./artifact --name "My artifact" --json

Install the agent skill:
  npx skills add shanebishop1/shlook

Skill and setup guide:
  https://github.com/shanebishop1/shlook/blob/main/skills/shlook/SKILL.md
Full command reference:
  https://github.com/shanebishop1/shlook/blob/main/skills/shlook/references/commands.md
`;
