const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ─── Storage ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def = []) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def));
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Guild config: { guildId: { welcomeChannel, welcomeMsg, leaveChannel, leaveMsg, modlogChannel } }
function getConfig(guildId) {
  const cfg = loadJSON("config.json", {});
  return cfg[guildId] || {};
}
function setConfig(guildId, changes) {
  const cfg = loadJSON("config.json", {});
  cfg[guildId] = { ...cfg[guildId], ...changes };
  saveJSON("config.json", cfg);
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
const EIGHT_BALL = ["It is certain.","It is decidedly so.","Without a doubt.","Yes, definitely.","You may rely on it.","As I see it, yes.","Most likely.","Outlook good.","Yes.","Signs point to yes.","Reply hazy, try again.","Ask again later.","Better not tell you now.","Cannot predict now.","Concentrate and ask again.","Don't count on it.","My reply is no.","My sources say no.","Outlook not so good.","Very doubtful."];

const startTime = Date.now();

function parseDuration(s) {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)/i);
  if (!m) return null;
  const n = Number(m[1]), u = m[2].toLowerCase();
  return u === "s" ? n*1000 : u === "m" ? n*60000 : u === "h" ? n*3600000 : n*86400000;
}

function requirePerm(msg, perm) {
  if (!msg.member?.permissions.has(perm)) {
    msg.reply("You don't have permission to use that command.").catch(()=>{});
    return false;
  }
  return true;
}

function formatUptime(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  return `${d}d ${h%24}h ${m%60}m ${s%60}s`;
}

async function logToModlog(guild, embed) {
  const cfg = getConfig(guild.id);
  if (!cfg.modlogChannel) return;
  try {
    const ch = await guild.channels.fetch(cfg.modlogChannel);
    if (ch) await ch.send({ embeds: [embed] });
  } catch {}
}

// ─── Giveaways ─────────────────────────────────────────────────────────────
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

// ─── Client ────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once("clientReady", c => { console.log(`✅ Logged in as ${c.user.tag}`); resumeGiveaways(client); });

// ─── Welcome / Leave ───────────────────────────────────────────────────────
client.on("guildMemberAdd", async member => {
  const cfg = getConfig(member.guild.id);
  const chId = cfg.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
  if (!chId) return;
  const msg = cfg.welcomeMsg || `Welcome to **${member.guild.name}**, ${member}! You are member #${member.guild.memberCount}.`;
  try {
    const ch = await client.channels.fetch(chId);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Welcome!").setDescription(msg.replace("{user}", `${member}`).replace("{server}", member.guild.name).replace("{count}", member.guild.memberCount)).setColor(0x57f287).setThumbnail(member.user.displayAvatarURL())] });
  } catch(e) { console.error("Welcome error:", e); }
});

client.on("guildMemberRemove", async member => {
  const cfg = getConfig(member.guild.id);
  const chId = cfg.leaveChannel || process.env.LEAVE_CHANNEL_ID;
  if (!chId) return;
  const msg = cfg.leaveMsg || `**${member.user.tag}** has left the server.`;
  try {
    const ch = await client.channels.fetch(chId);
    await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Goodbye!").setDescription(msg.replace("{user}", member.user.tag).replace("{server}", member.guild.name)).setColor(0xed4245)] });
  } catch(e) { console.error("Leave error:", e); }
});

// ─── Buttons ───────────────────────────────────────────────────────────────
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
    const cfg = getConfig(guild.id);
    const ch = await guild.channels.create({
      name: `ticket-${user.username.toLowerCase()}`,
      parent: cfg.ticketCategory || process.env.TICKET_CATEGORY_ID || undefined,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: ["ViewChannel"] },
        { id: user.id, allow: ["ViewChannel","SendMessages","ReadMessageHistory"] },
        ...(cfg.ticketRole ? [{ id: cfg.ticketRole, allow: ["ViewChannel","SendMessages","ReadMessageHistory"] }] : []),
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

// ─── Commands ───────────────────────────────────────────────────────────────
client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  if (!cmd) return;

  const targetUser = message.mentions.users.first();
  const targetMember = message.mentions.members?.first();

  try {
    switch (cmd) {

      // ── Info ──────────────────────────────────────────────────────────────
      case "ping": {
        const sent = await message.reply("🏓 Pinging...");
        await sent.edit(`🏓 Pong! Latency: **${sent.createdTimestamp - message.createdTimestamp}ms** | API: **${Math.round(client.ws.ping)}ms**`);
        break;
      }
      case "userinfo": {
        const user = targetUser || message.author;
        const member = targetMember || message.member;
        const embed = new EmbedBuilder()
          .setTitle(`👤 ${user.tag}`)
          .setThumbnail(user.displayAvatarURL({ size: 256 }))
          .setColor(0x5865f2)
          .addFields(
            { name: "ID", value: user.id, inline: true },
            { name: "Nickname", value: member?.nickname || "None", inline: true },
            { name: "Account Created", value: `<t:${Math.floor(user.createdTimestamp/1000)}:R>`, inline: true },
            { name: "Joined Server", value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : "N/A", inline: true },
            { name: "Roles", value: member?.roles.cache.filter(r=>r.id!==message.guild.id).map(r=>`${r}`).join(", ") || "None" },
          );
        await message.reply({ embeds: [embed] });
        break;
      }
      case "serverinfo": {
        const g = message.guild;
        await g.fetch();
        const embed = new EmbedBuilder()
          .setTitle(`🏠 ${g.name}`)
          .setThumbnail(g.iconURL({ size: 256 }) || null)
          .setColor(0x5865f2)
          .addFields(
            { name: "Owner", value: `<@${g.ownerId}>`, inline: true },
            { name: "Members", value: `${g.memberCount}`, inline: true },
            { name: "Channels", value: `${g.channels.cache.size}`, inline: true },
            { name: "Roles", value: `${g.roles.cache.size}`, inline: true },
            { name: "Created", value: `<t:${Math.floor(g.createdTimestamp/1000)}:R>`, inline: true },
            { name: "Boost Level", value: `${g.premiumTier}`, inline: true },
          );
        await message.reply({ embeds: [embed] });
        break;
      }
      case "avatar": {
        const user = targetUser || message.author;
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`🖼️ ${user.tag}'s Avatar`).setImage(user.displayAvatarURL({ size: 512 })).setColor(0x5865f2)] });
        break;
      }
      case "membercount": {
        await message.reply(`👥 **${message.guild.name}** has **${message.guild.memberCount}** members.`);
        break;
      }
      case "uptime": {
        await message.reply(`⏱️ Bot has been online for **${formatUptime(Date.now() - startTime)}**`);
        break;
      }

      // ── Fun ───────────────────────────────────────────────────────────────
      case "8ball": {
        const question = args.join(" ");
        if (!question) return void message.reply("Usage: `!8ball <question>`");
        const answer = EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)];
        await message.reply({ embeds: [new EmbedBuilder().setTitle("🎱 Magic 8-Ball").setDescription(`**Question:** ${question}\n**Answer:** ${answer}`).setColor(0x2c2f33)] });
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

      // ── Utility ───────────────────────────────────────────────────────────
      case "poll": {
        const parts = message.content.slice(PREFIX.length + "poll".length).trim().split("|").map(p=>p.trim()).filter(Boolean);
        if (parts.length < 3) return void message.reply("Usage: `!poll Question? | Option 1 | Option 2`");
        const [question, ...options] = parts;
        const sent = await message.channel.send({ embeds: [new EmbedBuilder().setTitle(`📊 ${question}`).setColor(0x5865f2).setDescription(options.slice(0,5).map((o,i)=>`${NUMBER_EMOJI[i]} ${o}`).join("\n")).setFooter({ text: `Poll by ${message.author.tag}` })] });
        for (let i = 0; i < Math.min(options.length, 5); i++) await sent.react(NUMBER_EMOJI[i]);
        break;
      }
      case "remindme": {
        const mins = Number(args[0]);
        const reminderMsg = args.slice(1).join(" ");
        if (!mins || !reminderMsg) return void message.reply("Usage: `!remindme <minutes> <message>`");
        await message.reply(`⏰ I'll remind you in **${mins} minute(s)**!`);
        setTimeout(async () => {
          try { await message.author.send(`⏰ Reminder: **${reminderMsg}**`); }
          catch { await message.channel.send(`⏰ ${message.author}, reminder: **${reminderMsg}**`); }
        }, mins * 60000);
        break;
      }
      case "say": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const parts = message.content.slice(PREFIX.length + "say".length).trim();
        // Support: !say #channel message OR !say message
        let targetCh = message.channel;
        let text = parts;
        if (message.mentions.channels.size) {
          targetCh = message.mentions.channels.first();
          text = parts.replace(/<#\d+>/, "").trim();
        }
        if (!text) return void message.reply("Usage: `!say [#channel] <message>`");
        if (message.deletable) await message.delete().catch(()=>{});
        await targetCh.send(text);
        break;
      }
      case "announce": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const targetCh = message.mentions.channels.first();
        if (!targetCh) return void message.reply("Usage: `!announce #channel <title> | <message>`");
        const rest = message.content.slice(PREFIX.length + "announce".length).replace(/<#\d+>/, "").trim();
        const [title, ...bodyParts] = rest.split("|").map(p=>p.trim());
        const body = bodyParts.join("|").trim();
        if (!title || !body) return void message.reply("Usage: `!announce #channel <title> | <message>`");
        await targetCh.send({ embeds: [new EmbedBuilder().setTitle(`📢 ${title}`).setDescription(body).setColor(0xf5a623).setFooter({ text: `Announced by ${message.author.tag}` }).setTimestamp()] });
        await message.reply(`✅ Announcement sent to ${targetCh}`);
        break;
      }
      case "role": {
        if (!requirePerm(message, PermissionFlagsBits.ManageRoles)) return;
        const action = args[0]?.toLowerCase();
        const role = message.mentions.roles.first();
        if (!targetMember || !role || !["add","remove"].includes(action))
          return void message.reply("Usage: `!role <add|remove> @user @role`");
        if (action === "add") await targetMember.roles.add(role);
        else await targetMember.roles.remove(role);
        await message.reply(`✅ ${action === "add" ? "Added" : "Removed"} role **${role.name}** ${action === "add" ? "to" : "from"} **${targetUser.tag}**`);
        break;
      }
      case "setwelcome": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const ch = message.mentions.channels.first();
        const msg = message.content.slice(PREFIX.length + "setwelcome".length).replace(/<#\d+>/, "").trim();
        if (!ch) return void message.reply("Usage: `!setwelcome #channel <message>` — use {user}, {server}, {count}");
        setConfig(message.guild.id, { welcomeChannel: ch.id, welcomeMsg: msg || undefined });
        await message.reply(`✅ Welcome messages will be sent to ${ch}${msg ? ` with custom message.` : ` with default message.`}`);
        break;
      }
      case "testwelcome": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const cfg = getConfig(message.guild.id);
        const chId = cfg.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
        if (!chId) return void message.reply("No welcome channel set. Use `!setwelcome #channel` first.");
        const msg = cfg.welcomeMsg || `Welcome to **${message.guild.name}**, ${message.author}! You are member #${message.guild.memberCount}.`;
        const ch = await client.channels.fetch(chId);
        await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Welcome!").setDescription(msg.replace("{user}", `${message.author}`).replace("{server}", message.guild.name).replace("{count}", message.guild.memberCount)).setColor(0x57f287).setThumbnail(message.author.displayAvatarURL()).setFooter({ text: "This is a preview" })] });
        await message.reply("✅ Preview sent!");
        break;
      }
      case "setleave": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const ch = message.mentions.channels.first();
        const msg = message.content.slice(PREFIX.length + "setleave".length).replace(/<#\d+>/, "").trim();
        if (!ch) return void message.reply("Usage: `!setleave #channel <message>` — use {user}, {server}");
        setConfig(message.guild.id, { leaveChannel: ch.id, leaveMsg: msg || undefined });
        await message.reply(`✅ Leave messages will be sent to ${ch}`);
        break;
      }
      case "testleave": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const cfg = getConfig(message.guild.id);
        const chId = cfg.leaveChannel || process.env.LEAVE_CHANNEL_ID;
        if (!chId) return void message.reply("No leave channel set. Use `!setleave #channel` first.");
        const msg = cfg.leaveMsg || `**${message.author.tag}** has left the server.`;
        const ch = await client.channels.fetch(chId);
        await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Goodbye!").setDescription(msg.replace("{user}", message.author.tag).replace("{server}", message.guild.name)).setColor(0xed4245).setFooter({ text: "This is a preview" })] });
        await message.reply("✅ Preview sent!");
        break;
      }
      case "ticketsetup": case "ticket-setup": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        // Support: !ticketsetup <category-id> @role   OR just !ticketsetup
        const categoryId = args.find(a => /^\d{17,19}$/.test(a));
        const role = message.mentions.roles.first();
        if (categoryId || role) {
          setConfig(message.guild.id, {
            ...(categoryId ? { ticketCategory: categoryId } : {}),
            ...(role ? { ticketRole: role.id } : {}),
          });
          await message.reply(`✅ Ticket config updated.${categoryId ? ` Category: \`${categoryId}\`` : ""}${role ? ` Staff role: ${role}` : ""}`);
        } else {
          // Just post the panel
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(TICKET_OPEN_BTN).setLabel("🎫 Open Ticket").setStyle(ButtonStyle.Primary));
          await message.channel.send({ embeds: [new EmbedBuilder().setTitle("Need help?").setDescription("Click the button below to open a private support ticket.").setColor(0x5865f2)], components: [row] });
        }
        break;
      }
      case "ticketpanel": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(TICKET_OPEN_BTN).setLabel("🎫 Open Ticket").setStyle(ButtonStyle.Primary));
        const title = args.join(" ") || "Need help?";
        await message.channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription("Click the button below to open a private support ticket.").setColor(0x5865f2)], components: [row] });
        if (message.deletable) await message.delete().catch(()=>{});
        break;
      }
      case "setmodlog": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const ch = message.mentions.channels.first();
        if (!ch) return void message.reply("Usage: `!setmodlog #channel`");
        setConfig(message.guild.id, { modlogChannel: ch.id });
        await message.reply(`✅ Mod log set to ${ch}`);
        break;
      }

      // ── Moderation ────────────────────────────────────────────────────────
      case "ban": {
        if (!requirePerm(message, PermissionFlagsBits.BanMembers)) return;
        if (!targetMember) return void message.reply("Usage: `!ban @user [reason]`");
        if (!targetMember.bannable) return void message.reply("I can't ban that member.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await message.guild.members.ban(targetMember.id, { reason });
        await message.reply(`🔨 Banned **${targetUser.tag}** — ${reason}`);
        await logToModlog(message.guild, new EmbedBuilder().setTitle("🔨 Member Banned").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Reason", value: reason }).setColor(0xed4245).setTimestamp());
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
        await logToModlog(message.guild, new EmbedBuilder().setTitle("👢 Member Kicked").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Reason", value: reason }).setColor(0xffa500).setTimestamp());
        break;
      }
      case "timeout": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        const mins = Number(args[1]);
        if (!targetMember || !mins) return void message.reply("Usage: `!timeout @user <minutes> [reason]`");
        if (!targetMember.moderatable) return void message.reply("I can't timeout that member.");
        const reason = args.slice(2).join(" ") || "No reason provided";
        await targetMember.timeout(mins * 60000, reason);
        await message.reply(`⏱️ Timed out **${targetUser.tag}** for ${mins} min — ${reason}`);
        await logToModlog(message.guild, new EmbedBuilder().setTitle("⏱️ Member Timed Out").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Duration", value: `${mins} min`, inline: true },{ name: "Reason", value: reason }).setColor(0xffa500).setTimestamp());
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
        await logToModlog(message.guild, new EmbedBuilder().setTitle("⚠️ Member Warned").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Reason", value: reason },{ name: "Total Warnings", value: `${count}`, inline: true }).setColor(0xf5a623).setTimestamp());
        break;
      }
      case "warnings": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        if (!targetUser) return void message.reply("Usage: `!warnings @user`");
        const list = warnings.forUser(message.guild.id, targetUser.id);
        if (!list.length) return void message.reply(`**${targetUser.tag}** has no warnings.`);
        await message.reply({ embeds: [new EmbedBuilder().setTitle(`⚠️ Warnings for ${targetUser.tag}`).setColor(0xf5a623).setDescription(list.map((w,i)=>`**${i+1}.** ${w.reason}`).join("\n"))] });
        break;
      }
      case "clearwarnings": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        if (!targetUser) return void message.reply("Usage: `!clearwarnings @user`");
        await message.reply(`🧼 Cleared ${warnings.clear(message.guild.id, targetUser.id)} warning(s) for **${targetUser.tag}**`);
        break;
      }
      case "slowmode": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        const secs = Number(args[0]);
        if (isNaN(secs) || secs < 0 || secs > 21600) return void message.reply("Usage: `!slowmode <seconds>` (0 to disable, max 21600)");
        await message.channel.setRateLimitPerUser(secs);
        await message.reply(secs === 0 ? "✅ Slowmode disabled." : `✅ Slowmode set to **${secs} second(s)**.`);
        break;
      }
      case "clear":
      case "purge": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const amount = Number(args[0]);
        if (!amount || amount < 1 || amount > 100) return void message.reply("Usage: `!purge <1-100> [@user]`");
        let msgs = await message.channel.messages.fetch({ limit: 100 });
        if (targetUser) msgs = msgs.filter(m => m.author.id === targetUser.id);
        const toDelete = [...msgs.values()].slice(0, amount + 1);
        const deleted = await message.channel.bulkDelete(toDelete, true);
        const n = await message.channel.send(`🧹 Deleted ${deleted.size - 1} message(s)${targetUser ? ` from **${targetUser.tag}**` : ""}.`);
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

      // ── Giveaway ──────────────────────────────────────────────────────────
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

      // ── Help ──────────────────────────────────────────────────────────────
      case "help": {
        const embed = new EmbedBuilder()
          .setTitle("📋 Bot Commands")
          .setColor(0x5865f2)
          .addFields(
            { name: "ℹ️ Info", value: "`!ping` `!userinfo [@user]` `!serverinfo` `!avatar [@user]` `!membercount` `!uptime`" },
            { name: "🎉 Fun", value: "`!8ball <question>` `!roll [sides] [count]` `!coinflip`" },
            { name: "🔧 Utility", value: "`!poll Q | Opt1 | Opt2` `!remindme <min> <msg>` `!say [#ch] <msg>` `!announce #ch <title> | <msg>`\n`!role <add|remove> @user @role` `!setwelcome #ch <msg>` `!testwelcome`\n`!setleave #ch <msg>` `!testleave` `!setmodlog #ch`\n`!ticketsetup [cat-id] [@role]` `!ticketpanel [title]`" },
            { name: "🛡️ Moderation", value: "`!ban @user [reason]` `!unban <id>` `!kick @user [reason]`\n`!timeout @user <min>` `!untimeout @user` `!warn @user <reason>`\n`!warnings @user` `!clearwarnings @user`\n`!slowmode <sec>` `!purge <1-100> [@user]` `!lock` `!unlock`" },
            { name: "🎁 Giveaway", value: "`!giveaway <duration> <winners> <prize>`\nExample: `!giveaway 10m 1 Nitro`" },
          )
          .setFooter({ text: `Prefix: ! • CRIMSON EM#9236` });
        await message.reply({ embeds: [embed] });
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
