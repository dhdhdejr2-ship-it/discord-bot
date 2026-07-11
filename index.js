const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, TextChannel } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ─── Storage ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, "[]");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

const warnings = {
  add(w) { const d = loadJSON("warnings.json"); d.push(w); saveJSON("warnings.json", d); },
  forUser(guildId, userId) { return loadJSON("warnings.json").filter(w => w.guildId === guildId && w.userId === userId); },
  clear(guildId, userId) {
    const d = loadJSON("warnings.json");
    const kept = d.filter(w => !(w.guildId === guildId && w.userId === userId));
    saveJSON("warnings.json", kept);
    return d.length - kept.length;
  },
};

const giveaways = {
  add(g) { const d = loadJSON("giveaways.json"); d.push(g); saveJSON("giveaways.json", d); },
  get(messageId) { return loadJSON("giveaways.json").find(g => g.messageId === messageId); },
  update(messageId, changes) {
    const d = loadJSON("giveaways.json");
    const i = d.findIndex(g => g.messageId === messageId);
    if (i !== -1) { d[i] = { ...d[i], ...changes }; saveJSON("giveaways.json", d); }
  },
  all() { return loadJSON("giveaways.json"); },
};

const PREFIX = "!";
const GIVEAWAY_BTN = "giveaway_enter";
const TICKET_OPEN_BTN = "ticket_open";
const TICKET_CLOSE_BTN = "ticket_close";
const NUMBER_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣"];

function parseDuration(s) {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return u === "s" ? n*1000 : u === "m" ? n*60000 : u === "h" ? n*3600000 : n*86400000;
}

function requirePerm(msg, perm) {
  if (!msg.member?.permissions.has(perm)) {
    msg.reply("You don't have permission to use that command.").catch(()=>{});
    return false;
  }
  return true;
}

async function endGiveaway(client, messageId) {
  const g = giveaways.get(messageId);
  if (!g || g.ended) return;
  giveaways.update(messageId, { ended: true });
  try {
    const channel = await client.channels.fetch(g.channelId);
    const message = await channel.messages.fetch(messageId);
    const { participants, winnerCount, prize } = g;
    if (!participants.length) { await channel.send(`🎉 Giveaway for **${prize}** ended — no one entered!`); return; }
    const winners = [...participants].sort(() => Math.random() - 0.5).slice(0, Math.min(winnerCount, participants.length));
    const mentions = winners.map(id => `<@${id}>`).join(", ");
    const embed = EmbedBuilder.from(message.embeds[0]).setTitle("🎉 Giveaway Ended!").setDescription(`**Prize:** ${prize}\n**Winner(s):** ${mentions}`).setColor(0xffd700);
    await message.edit({ embeds: [embed], components: [] });
    await channel.send(`🎊 Congrats ${mentions}! You won **${prize}**!`);
  } catch (e) { console.error("Giveaway end error:", e); }
}

function scheduleGiveaway(client, messageId, ms) { setTimeout(() => endGiveaway(client, messageId), ms); }

function resumeGiveaways(client) {
  for (const g of giveaways.all()) {
    if (g.ended) continue;
    const remaining = new Date(g.endsAt).getTime() - Date.now();
    if (remaining <= 0) endGiveaway(client, g.messageId);
    else scheduleGiveaway(client, g.messageId, remaining);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once("ready", () => { console.log(`Logged in as ${client.user.tag}`); resumeGiveaways(client); });

client.on("guildMemberAdd", async member => {
  const chId = process.env.WELCOME_CHANNEL_ID; if (!chId) return;
  try {
    const ch = await client.channels.fetch(chId);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Welcome!").setDescription(`Welcome to **${member.guild.name}**, ${member}! You are member #${member.guild.memberCount}.`).setColor(0x57f287).setThumbnail(member.user.displayAvatarURL())] });
  } catch {}
});

client.on("guildMemberRemove", async member => {
  const chId = process.env.LEAVE_CHANNEL_ID; if (!chId) return;
  try {
    const ch = await client.channels.fetch(chId);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Goodbye!").setDescription(`**${member.user.tag}** has left the server.`).setColor(0xed4245)] });
  } catch {}
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;
  const { customId, user, guild } = interaction;

  if (customId === GIVEAWAY_BTN) {
    const g = giveaways.get(interaction.message.id);
    if (!g || g.ended) return interaction.reply({ content: "This giveaway has ended.", ephemeral: true });
    if (g.participants.includes(user.id)) return interaction.reply({ content: "You're already entered!", ephemeral: true });
    giveaways.update(g.messageId, { participants: [...g.participants, user.id] });
    return interaction.reply({ content: "🎉 You're entered in the giveaway!", ephemeral: true });
  }

  if (customId === TICKET_OPEN_BTN) {
    if (!guild) return;
    const existing = guild.channels.cache.find(c => c.name === `ticket-${user.username.toLowerCase()}`);
    if (existing) return interaction.reply({ content: `You already have a ticket: ${existing}`, ephemeral: true });
    const ch = await guild.channels.create({
      name: `ticket-${user.username.toLowerCase()}`,
      parent: process.env.TICKET_CATEGORY_ID || undefined,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: ["ViewChannel"] },
        { id: user.id, allow: ["ViewChannel","SendMessages","ReadMessageHistory"] },
        { id: client.user.id, allow: ["ViewChannel","SendMessages","ReadMessageHistory"] },
      ],
    });
    await ch.send({ content: `${user} Welcome! Staff will be with you shortly.`, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(TICKET_CLOSE_BTN).setLabel("🔒 Close Ticket").setStyle(ButtonStyle.Danger))] });
    return interaction.reply({ content: `Ticket opened: ${ch}`, ephemeral: true });
  }

  if (customId === TICKET_CLOSE_BTN) {
    if (!interaction.member?.permissions.has(PermissionFlagsBits.ManageChannels) && !interaction.channel.name.endsWith(user.username.toLowerCase()))
      return interaction.reply({ content: "You can't close this ticket.", ephemeral: true });
    await interaction.reply("🔒 Closing ticket in 5 seconds...");
    setTimeout(() => interaction.channel.delete().catch(()=>{}), 5000);
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  if (!cmd) return;
  const targetUser = message.mentions.users.first();
  const targetMember = message.mentions.members?.first();

  try {
    switch (cmd) {
      case "ban": {
        if (!requirePerm(message, PermissionFlagsBits.BanMembers)) return;
        if (!targetMember) return void message.reply("Usage: `!ban @user [reason]`");
        if (!targetMember.bannable) return void message.reply("I can't ban that member.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await message.guild.members.ban(targetMember.id, { reason });
        await message.reply(`🔨 Banned **${targetUser.tag}** — ${reason}`);
        break;
      }
      case "unban": {
        if (!requirePerm(message, PermissionFlagsBits.BanMembers)) return;
        const uid = args[0]; if (!uid) return void message.reply("Usage: `!unban <user_id>`");
        await message.guild.members.unban(uid, args.slice(1).join(" ") || "No reason");
        await message.reply(`✅ Unbanned \`${uid}\``);
        break;
      }
      case "kick": {
        if (!requirePerm(message, PermissionFlagsBits.KickMembers)) return;
        if (!targetMember) return void message.reply("Usage: `!kick @user [reason]`");
        if (!targetMember.kickable) return void message.reply("I can't kick that member.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await targetMember.kick(reason);
        await message.reply(`👢 Kicked **${targetUser.tag}** — ${reason}`);
        break;
      }
      case "timeout": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        const mins = Number(args[1]);
        if (!targetMember || !mins) return void message.reply("Usage: `!timeout @user <minutes> [reason]`");
        if (!targetMember.moderatable) return void message.reply("I can't timeout that member.");
        await targetMember.timeout(mins * 60000, args.slice(2).join(" ") || "No reason");
        await message.reply(`⏱️ Timed out **${targetUser.tag}** for ${mins} min`);
        break;
      }
      case "untimeout": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        if (!targetMember) return void message.reply("Usage: `!untimeout @user`");
        await targetMember.timeout(null);
        await message.reply(`✅ Removed timeout from **${targetUser.tag}**`);
        break;
      }
      case "warn": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        const reason = args.slice(1).join(" ");
        if (!targetUser || !reason) return void message.reply("Usage: `!warn @user <reason>`");
        warnings.add({ id: `${Date.now()}`, userId: targetUser.id, guildId: message.guild.id, moderatorId: message.author.id, reason, createdAt: new Date().toISOString() });
        const count = warnings.forUser(message.guild.id, targetUser.id).length;
        await message.reply(`⚠️ Warned **${targetUser.tag}** — ${reason} (total: ${count})`);
        await targetUser.send(`You were warned in **${message.guild.name}**: ${reason}`).catch(()=>{});
        break;
      }
      case "warnings": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        if (!targetUser) return void message.reply("Usage: `!warnings @user`");
        const list = warnings.forUser(message.guild.id, targetUser.id);
        if (!list.length) return void message.reply(`**${targetUser.tag}** has no warnings.`);
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`Warnings for ${targetUser.tag}`).setColor(0xf5a623).setDescription(list.map((w,i)=>`**${i+1}.** ${w.reason}`).join("\n"))] });
        break;
      }
      case "clearwarnings": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        if (!targetUser) return void message.reply("Usage: `!clearwarnings @user`");
        await message.reply(`🧼 Cleared ${warnings.clear(message.guild.id, targetUser.id)} warning(s) for **${targetUser.tag}**`);
        break;
      }
      case "purge": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const amount = Number(args[0]);
        if (!amount || amount < 1 || amount > 100) return void message.reply("Usage: `!purge <1-100>`");
        const msgs = await message.channel.messages.fetch({ limit: amount + 1 });
        const deleted = await message.channel.bulkDelete(msgs, true);
        const n = await message.channel.send(`🧹 Deleted ${deleted.size - 1} message(s).`);
        setTimeout(() => n.delete().catch(()=>{}), 4000);
        break;
      }
      case "lock": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        await message.reply("🔒 Channel locked.");
        break;
      }
      case "unlock": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        await message.reply("🔓 Channel unlocked.");
        break;
      }
      case "say": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const text = args.join(" ");
        if (!text) return void message.reply("Usage: `!say <message>`");
        if (message.deletable) await message.delete().catch(()=>{});
        await message.channel.send(text);
        break;
      }
      case "roll": {
        const sides = Number(args[0]) || 6;
        const count = Math.min(Number(args[1]) || 1, 10);
        const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
        await message.reply(count === 1 ? `🎲 Rolled a **${rolls[0]}** (d${sides})` : `🎲 Rolled: ${rolls.join(", ")} (d${sides})`);
        break;
      }
      case "coinflip":
        await message.reply(`🪙 **${Math.random() < 0.5 ? "Heads" : "Tails"}**!`);
        break;
      case "poll": {
        const parts = message.content.slice(PREFIX.length + "poll".length).trim().split("|").map(p=>p.trim()).filter(Boolean);
        if (parts.length < 3) return void message.reply("Usage: `!poll Question? | Option 1 | Option 2`");
        const [question, ...options] = parts;
        const sent = await message.channel.send({ embeds: [new EmbedBuilder().setTitle(`📊 ${question}`).setColor(0x5865f2).setDescription(options.slice(0,5).map((o,i)=>`${NUMBER_EMOJI[i]} ${o}`).join("\n")).setFooter({ text: `Poll by ${message.author.tag}` })] });
        for (let i = 0; i < Math.min(options.length, 5); i++) await sent.react(NUMBER_EMOJI[i]);
        break;
      }
      case "giveaway": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const ms = parseDuration(args[0] || "");
        const winnerCount = Number(args[1]);
        const prize = args.slice(2).join(" ");
        if (!ms || !winnerCount || !prize) return void message.reply("Usage: `!giveaway <duration e.g. 10m> <winners> <prize>`");
        const endsAt = new Date(Date.now() + ms);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(GIVEAWAY_BTN).setLabel("🎉 Enter").setStyle(ButtonStyle.Success));
        const sent = await message.channel.send({ embeds: [new EmbedBuilder().setTitle("🎉 Giveaway!").setColor(0x57f287).setDescription(`**Prize:** ${prize}\n**Winners:** ${winnerCount}\nEnds <t:${Math.floor(endsAt.getTime()/1000)}:R>`).setFooter({ text: `Hosted by ${message.author.tag}` })], components: [row] });
        giveaways.add({ messageId: sent.id, channelId: message.channel.id, guildId: message.guild.id, prize, winnerCount, endsAt: endsAt.toISOString(), participants: [], ended: false });
        scheduleGiveaway(client, sent.id, ms);
        break;
      }
      case "ticket-setup": case "ticketsetup": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(TICKET_OPEN_BTN).setLabel("🎫 Open Ticket").setStyle(ButtonStyle.Primary));
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle(args.join(" ") || "Need help?").setDescription("Click the button below to open a private support ticket.").setColor(0x5865f2)], components: [row] });
        break;
      }
      default: return;
    }
  } catch (err) {
    console.error(`Error in !${cmd}:`, err);
    await message.reply("Something went wrong.").catch(()=>{});
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error("ERROR: DISCORD_TOKEN environment variable is not set."); process.exit(1); }
client.login(token);
