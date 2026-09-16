const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const PREFIX = "!";

if (!token) {
  throw new Error(
    "DISCORD_TOKEN is missing. Add it as a Replit Secret before starting the bot.",
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (command !== "roleicon") return;

  if (
    !message.member.permissions.has(
      PermissionsBitField.Flags.Administrator,
    )
  ) {
    await message.reply(
      "You need **Administrator** permission to use this command.",
    );
    return;
  }

  const role = message.mentions.roles.first();
  const icon = args[0];

  if (!role || !icon) {
    await message.reply("Usage: `!roleicon @Role :emoji:`");
    return;
  }

  if (role.managed) {
    await message.reply(
      "That role is managed by an integration and cannot be edited.",
    );
    return;
  }

  const botMember = message.guild.members.me;

  if (!botMember) {
    await message.reply("I couldn't find my bot member in this server.");
    return;
  }

  if (
    !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) ||
    role.position >= botMember.roles.highest.position
  ) {
    await message.reply(
      "My bot role must have **Manage Roles** permission and be **above** the role you're trying to edit.",
    );
    return;
  }

  try {
    // Custom emoji: use a static PNG because Discord role icons do not accept
    // every animated emoji format.
    const customEmoji = icon.match(/^<a?:[\w~]+:(\d+)>$/);

    if (customEmoji) {
      const emojiId = customEmoji[1];
      const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.png`;
      const response = await fetch(emojiUrl);

      if (!response.ok) {
        await message.reply("I couldn't download that Discord emoji.");
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await role.edit({ icon: buffer });
    } else {
      await role.edit({ unicodeEmoji: icon });
    }

    await message.reply(`✅ ${role} icon changed to ${icon}`);
  } catch (error) {
    console.error("Failed to change role icon:", error);
    await message.reply(
      "I couldn't change the role icon. Check the bot permissions, role order, and whether this server supports role icons.",
    );
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.on("shardError", (error) => {
  console.error("Discord connection error:", error);
});

client.login(token).catch((error) => {
  console.error("Discord login failed:", error);
  process.exitCode = 1;
});