# Discord Role Icon Bot

This bot adds an administrator-only prefix command for changing a server
role's icon.

## Command

```text
!roleicon @Role :emoji:
```

The emoji can be a Unicode emoji such as `⭐` or a custom Discord emoji such as
`<:star:123456789012345678>`.

## Required Discord setup

1. Add the bot to the server with the `Manage Roles` permission.
2. Put the bot's role above the role it needs to edit.
3. Enable the **Message Content Intent** in the Discord Developer Portal.
4. Keep the bot token in the `DISCORD_TOKEN` Replit Secret.

## Railway deployment

1. Create a new Railway project from this repository.
2. Add the variable `DISCORD_TOKEN` in the Railway service's **Variables** tab.
3. Railway will use the root `railway.json` configuration and run the bot
   continuously with automatic restarts.