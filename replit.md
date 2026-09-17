# Discord Role Icon Bot

An administrator-only Discord bot command for setting server role icons from Unicode or custom emojis.

## Run & Operate

- `pnpm start` — start the Discord bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_TOKEN`

## Stack

- pnpm workspaces, Node.js 24, JavaScript
- Discord.js 14

## Where things live

- `index.js` — bot client and command handler

## Architecture decisions

- The bot uses a prefix command so it works without registering slash-command metadata.
- Custom emoji images are converted to PNG before being sent as role-icon data.
- The token is read only from `DISCORD_TOKEN`; it is never stored in source files.

## Product

Administrators can run `!roleicon @Role :emoji:` to set a role's icon. The bot
checks permissions, role hierarchy, managed-role restrictions, and Discord API
errors before confirming the change.

## User preferences

The user asked for a new bot project containing the role-icon command.

## Gotchas

- Discord's Message Content Intent must be enabled for prefix commands to work.
- The bot role must be above the target role.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
