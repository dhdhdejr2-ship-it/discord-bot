const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, AttachmentBuilder } = require("discord.js");
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

// Guild config: { guildId: { welcomeChannel, welcomeMsg, modlogChannel, ticketCategory, ticketRole } }
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

// Reminders are persisted (like giveaways) so they survive a bot restart —
// previously they only lived in an in-memory setTimeout and were silently
// lost whenever the process restarted (e.g. on every redeploy).
const reminders = {
  add(r) { const d = loadJSON("reminders.json"); d.push(r); saveJSON("reminders.json", d); },
  remove(id) { const d = loadJSON("reminders.json"); saveJSON("reminders.json", d.filter(r => r.id !== id)); },
  all() { return loadJSON("reminders.json"); },
};

// ─── Casino economy ─────────────────────────────────────────────────────────
// Per-guild, per-user wallets: { "guildId:userId": { balance, bank, lastDaily, lastWork, lastSteal, lastGrab } }
// `balance` is your wallet (cash on hand) — it's what !steal can take.
// `bank` is safe from !steal; move money there with !deposit.
const STARTING_BALANCE = 500;
const DEFAULT_ACCOUNT = { balance: STARTING_BALANCE, bank: 0, lastDaily: 0, lastWork: 0, lastSteal: 0, lastGrab: 0 };
const economy = {
  key(guildId, userId) { return `${guildId}:${userId}`; },
  get(guildId, userId) {
    const d = loadJSON("economy.json", {});
    const k = this.key(guildId, userId);
    if (!d[k]) { d[k] = { ...DEFAULT_ACCOUNT }; saveJSON("economy.json", d); }
    return { ...DEFAULT_ACCOUNT, ...d[k] };
  },
  set(guildId, userId, changes) {
    const d = loadJSON("economy.json", {});
    const k = this.key(guildId, userId);
    d[k] = { ...DEFAULT_ACCOUNT, ...(d[k] || {}), ...changes };
    saveJSON("economy.json", d);
    return d[k];
  },
  add(guildId, userId, amount) {
    const acc = this.get(guildId, userId);
    return this.set(guildId, userId, { balance: Math.max(0, acc.balance + amount) });
  },
  top(guildId, limit = 10) {
    const d = loadJSON("economy.json", {});
    return Object.entries(d)
      .filter(([k]) => k.startsWith(`${guildId}:`))
      .map(([k, v]) => ({ userId: k.split(":")[1], balance: (v.balance || 0) + (v.bank || 0) }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, limit);
  },
};
function fmtMoney(n) { return `💰 ${n.toLocaleString()} chips`; }

const PREFIX = "!";
const OWNER_ID = "1449567336012054575"; // only this user can use !givemoney
const GIVEAWAY_BTN   = "giveaway_enter";
const TICKET_SELECT  = "ticket_category";
const TICKET_CLOSE   = "ticket_close";

const NUMBER_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣"];

const TICKET_CATEGORIES = {
  access:  { label: "🔓 Free Access", description: "Join the gang & get turf access",  color: 0xe91e8c },
  allies:  { label: "🤝 Allies",      description: "Alliance & partnership requests",   color: 0xe91e8c },
  support: { label: "🎫 Support",     description: "Questions, help & general support", color: 0xe91e8c },
};

const startTime = Date.now();

// ─── In-memory state ───────────────────────────────────────────────────────
const sniped     = new Map(); // channelId → { author, content, timestamp }
const afkUsers   = new Map(); // userId    → { reason, since }

function parseDuration(s) {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)/i);
  if (!m) return null;
  const n = Number(m[1]), u = m[2].toLowerCase();
  return u === "s" ? n*1000 : u === "m" ? n*60000 : u === "h" ? n*3600000 : n*86400000;
}

// Like parseDuration, but also accepts a bare number (treated as minutes) —
// used by !to/!timeout so "10", "10m", "10min", and "10minutes" all work.
function parseTimeoutDuration(s) {
  if (!s) return null;
  const viaUnit = parseDuration(s);
  if (viaUnit) return viaUnit;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n * 60000 : null;
}

function requirePerm(msg, perm) {
  if (!msg.member?.permissions.has(perm)) {
    msg.reply("You don't have permission to use that command.").catch(()=>{});
    return false;
  }
  return true;
}

// Resolve a guild member from a mention, raw ID, or username/nickname search —
// lets staff target someone by name so the command doesn't ping them.
async function resolveMember(guild, query) {
  if (!query) return null;
  const mentionMatch = query.match(/^<@!?(\d+)>$/);
  const id = mentionMatch ? mentionMatch[1] : (/^\d{17,19}$/.test(query) ? query : null);
  if (id) return guild.members.fetch(id).catch(() => null);

  await guild.members.fetch().catch(() => {});
  const q = query.toLowerCase().replace(/^@/, "");
  return (
    guild.members.cache.find(
      m => m.user.username.toLowerCase() === q || m.user.tag.toLowerCase() === q || m.displayName.toLowerCase() === q
    ) ||
    guild.members.cache.find(
      m => m.user.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)
    ) ||
    null
  );
}

// Resolve a role from a mention, raw ID, or name search.
function resolveRole(guild, query) {
  if (!query) return null;
  const mentionMatch = query.match(/^<@&(\d+)>$/);
  if (mentionMatch) return guild.roles.cache.get(mentionMatch[1]) || null;
  if (/^\d{17,19}$/.test(query)) return guild.roles.cache.get(query) || null;
  const q = query.toLowerCase();
  return (
    guild.roles.cache.find(r => r.name.toLowerCase() === q) ||
    guild.roles.cache.find(r => r.name.toLowerCase().includes(q)) ||
    null
  );
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

function safeMath(expr) {
  const cleaned = expr.replace(/\s+/g, "");
  if (!/^[\d+\-*/().%^]+$/.test(cleaned)) return null;
  try {
    const safe = cleaned.replace(/\^/g, "**");
    const result = Function('"use strict"; return (' + safe + ')')();
    if (typeof result !== "number" || !isFinite(result)) return null;
    return Math.round(result * 1e10) / 1e10;
  } catch { return null; }
}

// ─── Giveaways ─────────────────────────────────────────────────────────────
async function endGiveaway(client, messageId) {
  const g = giveaways.get(messageId);
  if (!g || g.ended) return;
  giveaways.update(messageId, { ended: true });
  try {
    const channel = await client.channels.fetch(g.channelId);
    const message = await channel.messages.fetch(messageId);
    const prize = g.prize;
    if (!g.participants.length) {
      const embed = EmbedBuilder.from(message.embeds[0]).setTitle("🎉 Giveaway Ended!").setDescription(`**Prize:** ${prize}\n**Winner(s):** No participants!`).setColor(0xed4245);
      return await message.edit({ embeds: [embed], components: [] });
    }
    const shuffled = [...g.participants].sort(() => Math.random() - 0.5);
    const winners = shuffled.slice(0, g.winnerCount);
    const mentions = winners.map(id => `<@${id}>`).join(", ");
    const embed = EmbedBuilder.from(message.embeds[0]).setTitle("🎉 Giveaway Ended!").setDescription(`**Prize:** ${prize}\n**Winner(s):** ${mentions}`).setColor(0xffd700);
    await message.edit({ embeds: [embed], components: [] });
    await channel.send(`🎊 Congrats ${mentions}! You won **${prize}**!`);
  } catch (e) { console.error("Giveaway end error:", e); }
}
function scheduleGiveaway(client, messageId, ms) { setTimeout(() => endGiveaway(client, messageId), ms); }

// ─── Reminders ─────────────────────────────────────────────────────────────
async function fireReminder(client, r) {
  reminders.remove(r.id);
  try {
    const user = await client.users.fetch(r.userId);
    await user.send({ embeds: [new EmbedBuilder().setTitle("⏰ Reminder!").setDescription(r.reminder).setColor(0xffd700).setFooter({ text: `Set in ${r.guildName}` }).setTimestamp()] });
  } catch {
    try {
      const ch = await client.channels.fetch(r.channelId);
      await ch.send(`⏰ <@${r.userId}>, reminder: **${r.reminder}**`);
    } catch {}
  }
}
function scheduleReminder(client, r) {
  const delay = new Date(r.dueAt).getTime() - Date.now();
  setTimeout(() => fireReminder(client, r), Math.max(0, delay));
}
function resumeReminders(client) {
  for (const r of reminders.all()) {
    const delay = new Date(r.dueAt).getTime() - Date.now();
    if (delay <= 0) fireReminder(client, r);
    else scheduleReminder(client, r);
  }
}

// ─── Welcome banner image ──────────────────────────────────────────────────
const WELCOME_IMAGE_PATH = path.join(__dirname, "assets", "welcome.png");
function welcomeImageAttachment() {
  if (!fs.existsSync(WELCOME_IMAGE_PATH)) return null;
  return new AttachmentBuilder(WELCOME_IMAGE_PATH, { name: "welcome.png" });
}

// ─── Leave banner image ─────────────────────────────────────────────────────
const LEAVE_IMAGE_PATH = path.join(__dirname, "assets", "leave.png");
function leaveImageAttachment() {
  if (!fs.existsSync(LEAVE_IMAGE_PATH)) return null;
  return new AttachmentBuilder(LEAVE_IMAGE_PATH, { name: "leave.png" });
}

// ─── Giveaway banner image ─────────────────────────────────────────────────
const GIVEAWAY_IMAGE_PATH = path.join(__dirname, "assets", "giveaway.png");
function giveawayImageAttachment() {
  if (!fs.existsSync(GIVEAWAY_IMAGE_PATH)) return null;
  return new AttachmentBuilder(GIVEAWAY_IMAGE_PATH, { name: "giveaway.png" });
}
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

client.once("clientReady", c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  c.user.setPresence({ status: "dnd" });
  resumeGiveaways(client);
  resumeReminders(client);
});

// ─── Welcome ───────────────────────────────────────────────────────────────
client.on("guildMemberAdd", async member => {
  const cfg = getConfig(member.guild.id);
  const chId = cfg.welcomeChannel || process.env.WELCOME_CHANNEL_ID;
  if (!chId) return;
  const msg = cfg.welcomeMsg || `Welcome to **${member.guild.name}**, ${member}! You are member #${member.guild.memberCount}.`;
  try {
    const ch = await client.channels.fetch(chId);
    const formatted = msg
      .replace(/{user}/g, `${member}`)
      .replace(/{username}/g, member.user.username)
      .replace(/{tag}/g, member.user.tag)
      .replace(/{server}/g, member.guild.name)
      .replace(/{count}/g, member.guild.memberCount)
      .replace(/{membercount}/g, member.guild.memberCount);
    const attachment = welcomeImageAttachment();
    const embed = new EmbedBuilder().setTitle("👋 Welcome!").setDescription(formatted).setColor(0x57f287).setThumbnail(member.user.displayAvatarURL());
    if (attachment) embed.setImage("attachment://welcome.png");
    await ch.send({ embeds: [embed], files: attachment ? [attachment] : [] });
  } catch(e) { console.error("Welcome error:", e); }
});

// ─── Leave ─────────────────────────────────────────────────────────────────
client.on("guildMemberRemove", async member => {
  const cfg = getConfig(member.guild.id);
  const chId = cfg.leaveChannel || process.env.LEAVE_CHANNEL_ID;
  if (!chId) return;
  const msg = cfg.leaveMsg || `**${member.user.username}** has left **${member.guild.name}**. We're down to ${member.guild.memberCount} members.`;
  try {
    const ch = await client.channels.fetch(chId);
    const formatted = msg
      .replace(/{user}/g, `${member}`)
      .replace(/{username}/g, member.user.username)
      .replace(/{tag}/g, member.user.tag)
      .replace(/{server}/g, member.guild.name)
      .replace(/{count}/g, member.guild.memberCount)
      .replace(/{membercount}/g, member.guild.memberCount);
    const attachment = leaveImageAttachment();
    const embed = new EmbedBuilder().setTitle("👋 Member Left").setDescription(formatted).setColor(0xed4245).setThumbnail(member.user.displayAvatarURL());
    if (attachment) embed.setImage("attachment://leave.png");
    await ch.send({ embeds: [embed], files: attachment ? [attachment] : [] });
  } catch(e) { console.error("Leave error:", e); }
});

// ─── Snipe: track deleted messages ─────────────────────────────────────────
client.on("messageDelete", message => {
  if (message.author?.bot) return;
  if (message.content) {
    sniped.set(message.channelId, {
      author: message.author?.tag || "Unknown",
      avatarURL: message.author?.displayAvatarURL() || null,
      content: message.content,
      timestamp: Date.now(),
    });
  }
});

// ─── AFK: detect when AFK user speaks ─────────────────────────────────────
client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (afkUsers.has(message.author.id) && !message.content.startsWith(PREFIX)) {
    const { nick } = afkUsers.get(message.author.id);
    afkUsers.delete(message.author.id);
    if (message.member?.nickname?.startsWith("[AFK] ")) {
      await message.member.setNickname(nick || null).catch(() => {});
    }
    const m = await message.reply(`👋 Welcome back, **${message.author.username}**! Your AFK has been removed.`).catch(()=>null);
    if (m) setTimeout(() => m.delete().catch(()=>{}), 5000);
  }
  for (const user of message.mentions.users.values()) {
    if (afkUsers.has(user.id)) {
      const { reason, since } = afkUsers.get(user.id);
      await message.reply(`💤 **${user.username}** is AFK: ${reason} (since <t:${Math.floor(since/1000)}:R>)`).catch(()=>{});
    }
  }
});

// ─── Interactions (Buttons & Select Menus) ─────────────────────────────────
client.on("interactionCreate", async interaction => {
  // ── Giveaway button ──
  if (interaction.isButton() && interaction.customId === GIVEAWAY_BTN) {
    const g = giveaways.get(interaction.message.id);
    if (!g || g.ended) return interaction.reply({ content: "This giveaway has ended.", ephemeral: true });
    if (g.participants.includes(interaction.user.id)) return interaction.reply({ content: "You're already entered!", ephemeral: true });
    const updatedParticipants = [...g.participants, interaction.user.id];
    giveaways.update(g.messageId, { participants: updatedParticipants });

    // Update the giveaway panel to show who's entered
    try {
      const oldEmbed = interaction.message.embeds[0];
      // Build participants display (mentions, max ~40 before truncating)
      const MAX_SHOW = 40;
      const mentions = updatedParticipants.slice(0, MAX_SHOW).map(id => `<@${id}>`).join(", ");
      const overflow = updatedParticipants.length > MAX_SHOW ? ` +${updatedParticipants.length - MAX_SHOW} more` : "";
      const participantField = { name: `🎟️ Entries — ${updatedParticipants.length}`, value: mentions + overflow, inline: false };

      // Rebuild embed, replacing any existing entries field
      const updatedEmbed = EmbedBuilder.from(oldEmbed);
      const fields = (oldEmbed.fields || []).filter(f => !f.name.startsWith("🎟️ Entries"));
      updatedEmbed.setFields([...fields, participantField]);

      await interaction.update({ embeds: [updatedEmbed], components: interaction.message.components });
    } catch(e) {
      console.error("Giveaway panel update error:", e);
      await interaction.reply({ content: "🎉 You're entered in the giveaway!", ephemeral: true });
    }
    return;
  }

  // ── Ticket close button ──
    if (interaction.isButton() && interaction.customId === TICKET_CLOSE) {
      console.log("[CLOSE] clicked by", interaction.user.username, "perms:", interaction.member?.permissions.toArray().join(","));

      if (!interaction.member?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        console.log("[CLOSE] denied — no ManageChannels");
        return interaction.reply({ content: "Only staff can close tickets.", ephemeral: true });
      }

      await interaction.reply("Closing ticket and saving transcript...");

      try {
        console.log("[CLOSE] fetching transcript ch 1480283062284845060");
        const transcriptCh = await interaction.guild.channels.fetch("1480283062284845060");
        console.log("[CLOSE] got ch:", transcriptCh ? transcriptCh.name : "null");

        const fetched = await interaction.channel.messages.fetch({ limit: 100 });
        const sorted = [...fetched.values()].reverse();
        console.log("[CLOSE] messages:", sorted.length);

        const lines2 = sorted.map(m => {
          const t = new Date(m.createdTimestamp).toISOString().replace("T"," ").slice(0,19);
          const body = m.content || (m.embeds.length ? "[embed]" : m.attachments.size ? "[file]" : "");
          return "[" + t + "] " + m.author.username + ": " + body;
        });

        const buf = Buffer.from(lines2.join("\n"), "utf8");
        const file = new AttachmentBuilder(buf, { name: "transcript-" + interaction.channel.name + ".txt" });

        const embed = new EmbedBuilder()
          .setTitle("Ticket Transcript")
          .setDescription("Channel: " + interaction.channel.name + "\nClosed by: " + interaction.user.username + "\nMessages: " + sorted.length)
          .setColor(0xe91e8c)
          .setTimestamp();

        await transcriptCh.send({ embeds: [embed], files: [file] });
        console.log("[CLOSE] transcript sent OK");
      } catch (err) {
        console.error("[CLOSE] transcript FAILED:", err.message);
      }

      await interaction.channel.delete().catch(e => console.error("[CLOSE] delete err:", e.message));
      return;
    }

  // ── Ticket category select menu ──
  if (interaction.isStringSelectMenu() && interaction.customId === TICKET_SELECT) {
    const category = interaction.values[0]; // "access" | "allies" | "buying"
    const cat = TICKET_CATEGORIES[category];
    const { user, guild } = interaction;
    if (!guild) return;

    // Check for existing ticket
    const existing = guild.channels.cache.find(
      c => c.name === `${category}-${user.username.toLowerCase()}`
    );
    if (existing) {
      return interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
    }

    const cfg = getConfig(guild.id);
    try {
      const ch = await guild.channels.create({
        name: `${category}-${user.username.toLowerCase()}`,
        parent: cfg.ticketCategory || process.env.TICKET_CATEGORY_ID || undefined,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: ["ViewChannel"] },
          { id: user.id, allow: ["ViewChannel","SendMessages","ReadMessageHistory"] },
          ...(cfg.ticketRole ? [{ id: cfg.ticketRole, allow: ["ViewChannel","SendMessages","ReadMessageHistory"] }] : []),
          { id: client.user.id, allow: ["ViewChannel","SendMessages","ReadMessageHistory","ManageChannels"] },
        ],
      });

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(TICKET_CLOSE).setLabel("🔒 Close Ticket").setStyle(ButtonStyle.Danger)
      );

      const embed = new EmbedBuilder()
        .setTitle(`${cat.label} Ticket`)
        .setDescription(`Hey ${user}! Welcome to your **${cat.label.replace(/^[^ ]+ /,"")}** ticket.\nStaff will be with you shortly.\n\nDescribe your issue or request below.`)
        .setColor(cat.color)
        .setFooter({ text: "662 Support • Click Close Ticket when done" })
        .setTimestamp();

      await ch.send({ content: `${user}`, embeds: [embed], components: [closeRow] });
      if (cfg.ticketRole) {
        await ch.send({ content: `📢 <@&${cfg.ticketRole}> — New **${cat.label.replace(/^[^ ]+ /, "")} ** ticket opened by ${user}. Please assist when available.` });
      }
      if (!interaction.replied) await interaction.reply({ content: `✅ Your ticket has been opened: ${ch}`, ephemeral: true });
    } catch (e) {
      console.error("Ticket create error:", e);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Failed to create ticket: ${e.message}`, ephemeral: true }).catch(()=>{});
      }
    }
    return;
  }
});

// ─── Commands ───────────────────────────────────────────────────────────────
client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  if (!cmd) return;

  let targetUser = message.mentions.users.first() || null;
  let targetMember = targetUser ? await message.guild.members.fetch(targetUser.id).catch(()=>null) : null;
  // Fall back to a raw user ID (e.g. `!ban 123456789012345678 spam`) — needed
  // because you can't @mention someone who already left the server.
  if (!targetUser && /^\d{17,19}$/.test(args[0] || "")) {
    targetMember = await message.guild.members.fetch(args[0]).catch(() => null);
    targetUser = targetMember ? targetMember.user : await client.users.fetch(args[0]).catch(() => null);
  }

  try {
    switch (cmd) {

      // ── General ──────────────────────────────────────────────────────────
      case "ping": {
        const sent = await message.reply("Pinging...");
        sent.edit(`🏓 Pong! Latency: **${sent.createdTimestamp - message.createdTimestamp}ms** | API: **${Math.round(client.ws.ping)}ms**`);
        break;
      }
      case "botinfo": {
        const embed = new EmbedBuilder()
          .setTitle(`🤖 ${client.user.username} Info`)
          .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
          .setColor(0x5865f2)
          .addFields(
            { name: "Uptime", value: formatUptime(Date.now() - startTime), inline: true },
            { name: "Servers", value: `${client.guilds.cache.size}`, inline: true },
            { name: "Users", value: `${client.users.cache.size}`, inline: true },
            { name: "Ping", value: `${Math.round(client.ws.ping)}ms`, inline: true },
            { name: "Library", value: "discord.js v14", inline: true },
            { name: "Node.js", value: process.version, inline: true },
          )
          .setFooter({ text: "CRIMSON EM#9236" })
          .setTimestamp();
        await message.reply({ embeds: [embed] });
        break;
      }
      case "uptime":
        await message.reply(`⏱️ Bot has been online for **${formatUptime(Date.now() - startTime)}**`);
        break;
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
      case "membercount":
        await message.reply(`👥 **${message.guild.name}** has **${message.guild.memberCount}** members.`);
        break;

      // ── Utility ──────────────────────────────────────────────────────────
      case "poll": {
        const parts = message.content.slice(PREFIX.length + "poll".length).trim().split("|").map(p=>p.trim()).filter(Boolean);
        if (parts.length < 3) return void message.reply("Usage: `!poll Question? | Option 1 | Option 2`");
        const [question, ...options] = parts;
        if (options.length > 5) return void message.reply("Max 5 options per poll.");
        const embed = new EmbedBuilder()
          .setTitle(`📊 ${question}`)
          .setDescription(options.map((o,i)=>`${NUMBER_EMOJI[i]} ${o}`).join("\n"))
          .setColor(0x5865f2)
          .setFooter({ text: `Poll by ${message.author.tag}` });
        const poll = await message.channel.send({ embeds: [embed] });
        for (let i = 0; i < options.length; i++) await poll.react(NUMBER_EMOJI[i]);
        if (message.deletable) await message.delete().catch(()=>{});
        break;
      }
      case "math": {
        const expr = args.join(" ");
        if (!expr) return void message.reply("Usage: `!math <expression>` — e.g. `!math 5^2 + 3*4`");
        const result = safeMath(expr);
        if (result === null) return void message.reply("❌ Invalid or unsafe expression. Only numbers and `+ - * / % ^ ( )` allowed.");
        await message.reply({ embeds: [new EmbedBuilder().setTitle("🧮 Math").setDescription(`**Expression:** \`${expr}\`\n**Result:** \`${result}\``).setColor(0x5865f2)] });
        break;
      }
      case "remind": {
        const timeStr = args[0];
        const reminderText = args.slice(1).join(" ");
        if (!timeStr || !reminderText) return void message.reply("Usage: `!remind <time> <message>` — e.g. `!remind 10m Take a break`");
        const ms = parseDuration(timeStr);
        if (!ms) return void message.reply("Invalid time. Use: `10s`, `5m`, `2h`, `1d`");
        if (ms > 86400000 * 7) return void message.reply("Max reminder time is 7 days.");
        const r = { id: `${Date.now()}-${message.author.id}`, userId: message.author.id, channelId: message.channel.id, guildName: message.guild.name, reminder: reminderText, dueAt: new Date(Date.now() + ms).toISOString() };
        reminders.add(r);
        scheduleReminder(client, r);
        await message.reply(`✅ Got it! I'll remind you about **${reminderText}** in **${timeStr}**.`);
        break;
      }
      case "snipe": {
        const data = sniped.get(message.channel.id);
        if (!data) return void message.reply("Nothing to snipe! No recently deleted messages in this channel.");
        const embed = new EmbedBuilder()
          .setTitle("🔫 Sniped!")
          .setDescription(data.content)
          .setColor(0xed4245)
          .setAuthor({ name: data.author, iconURL: data.avatarURL || undefined })
          .setFooter({ text: `Deleted ${Math.floor((Date.now() - data.timestamp) / 1000)}s ago` });
        await message.reply({ embeds: [embed] });
        break;
      }
      case "afk": {
        const reason = args.join(" ") || "AFK";
        const originalNick = message.member.nickname; // null = no nickname set, just uses username
        afkUsers.set(message.author.id, { reason, since: Date.now(), nick: originalNick });
        const baseName = originalNick || message.member.displayName;
        if (!baseName.startsWith("[AFK] ")) {
          await message.member.setNickname(`[AFK] ${baseName}`.slice(0, 32)).catch(() => {});
        }
        await message.reply(`💤 You're now AFK: **${reason}**`);
        break;
      }

      // ── 662 Casino ───────────────────────────────────────────────────────
      case "balance": case "bal": {
        const user = targetUser || message.author;
        const acc = economy.get(message.guild.id, user.id);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle(`💳 ${user.username}'s Balance`)
          .addFields(
            { name: "Wallet (stealable)", value: fmtMoney(acc.balance), inline: true },
            { name: "Bank (safe)", value: fmtMoney(acc.bank), inline: true },
          )
          .setColor(0xe91e8c)] });
        break;
      }
      case "bank": {
        const acc = economy.get(message.guild.id, message.author.id);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🏦 Your Bank")
          .setDescription(`${fmtMoney(acc.bank)} stored safely — this can't be stolen.\nWallet: ${fmtMoney(acc.balance)}`)
          .setColor(0x5865f2)] });
        break;
      }
      case "deposit": case "dep": {
        const acc = economy.get(message.guild.id, message.author.id);
        const amount = args[0] === "all" ? acc.balance : Math.floor(Number(args[0]));
        if (!amount || amount < 1) return void message.reply("Usage: `!deposit <amount|all>`");
        if (amount > acc.balance) return void message.reply(`You only have ${fmtMoney(acc.balance)} in your wallet.`);
        const updated = economy.set(message.guild.id, message.author.id, { balance: acc.balance - amount, bank: acc.bank + amount });
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🏦 Deposited")
          .setDescription(`Moved **${fmtMoney(amount)}** into your bank.\nWallet: ${fmtMoney(updated.balance)} | Bank: ${fmtMoney(updated.bank)}`)
          .setColor(0x57f287)] });
        break;
      }
      case "withdraw": case "with": {
        const acc = economy.get(message.guild.id, message.author.id);
        const amount = args[0] === "all" ? acc.bank : Math.floor(Number(args[0]));
        if (!amount || amount < 1) return void message.reply("Usage: `!withdraw <amount|all>`");
        if (amount > acc.bank) return void message.reply(`You only have ${fmtMoney(acc.bank)} in your bank.`);
        const updated = economy.set(message.guild.id, message.author.id, { balance: acc.balance + amount, bank: acc.bank - amount });
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🏦 Withdrew")
          .setDescription(`Moved **${fmtMoney(amount)}** back into your wallet.\nWallet: ${fmtMoney(updated.balance)} | Bank: ${fmtMoney(updated.bank)}`)
          .setColor(0x57f287)] });
        break;
      }
      case "grab": {
        const acc = economy.get(message.guild.id, message.author.id);
        const cooldown = 900000; // 15 min
        const remaining = acc.lastGrab + cooldown - Date.now();
        if (remaining > 0) return void message.reply(`⏳ Nothing new to find yet. Try again in **${formatUptime(remaining)}**.`);
        const roll = Math.random();
        if (roll < 0.15) {
          // Whiff — found nothing this time.
          economy.set(message.guild.id, message.author.id, { lastGrab: Date.now() });
          const misses = ["You checked the couch cushions and found lint.","You looked around but came up empty-handed.","Someone beat you to it — no luck this time."];
          await message.reply({ embeds: [new EmbedBuilder().setTitle("🔍 Nothing Found").setDescription(misses[Math.floor(Math.random()*misses.length)]).setColor(0x99aab5)] });
          break;
        }
        const jackpot = roll > 0.97; // rare big find
        const amount = jackpot ? 500 + Math.floor(Math.random() * 501) : 10 + Math.floor(Math.random() * 91); // 10-100, or 500-1000
        const finds = jackpot
          ? ["You found a dropped wallet stuffed with cash!","You stumbled on a hidden stash!","You found an envelope of cash taped under a bench!"]
          : ["You found some loose change on the ground.","You found a few crumpled bills in your pocket.","You found some coins in a vending machine tray.","You found a bit of cash on the sidewalk."];
        const updated = economy.set(message.guild.id, message.author.id, { balance: acc.balance + amount, lastGrab: Date.now() });
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle(jackpot ? "🤑 Jackpot Find!" : "🔍 Found Money!")
          .setDescription(`${finds[Math.floor(Math.random()*finds.length)]}\nYou grabbed **${fmtMoney(amount)}**!\nWallet: ${fmtMoney(updated.balance)}`)
          .setColor(jackpot ? 0xffd700 : 0x57f287)] });
        break;
      }
      case "daily": {
        const acc = economy.get(message.guild.id, message.author.id);
        const cooldown = 86400000;
        const remaining = acc.lastDaily + cooldown - Date.now();
        if (remaining > 0) return void message.reply(`⏳ You already claimed your daily. Come back in **${formatUptime(remaining)}**.`);
        const amount = 100 + Math.floor(Math.random() * 201); // 100-300
        const updated = economy.set(message.guild.id, message.author.id, { balance: acc.balance + amount, lastDaily: Date.now() });
        await message.reply({ embeds: [new EmbedBuilder().setTitle("📅 Daily Claimed!").setDescription(`You got **${fmtMoney(amount)}**!\nBalance: ${fmtMoney(updated.balance)}`).setColor(0x57f287)] });
        break;
      }
      case "work": {
        const acc = economy.get(message.guild.id, message.author.id);
        const cooldown = 3600000;
        const remaining = acc.lastWork + cooldown - Date.now();
        if (remaining > 0) return void message.reply(`⏳ You're tired. Rest for **${formatUptime(remaining)}** before working again.`);
        const jobs = ["ran a package for a plug","flipped some sneakers","hustled a car wash","did a food delivery run","fixed someone's PC","sold merch outside the venue"];
        const job = jobs[Math.floor(Math.random() * jobs.length)];
        const amount = 50 + Math.floor(Math.random() * 101); // 50-150
        const updated = economy.set(message.guild.id, message.author.id, { balance: acc.balance + amount, lastWork: Date.now() });
        await message.reply({ embeds: [new EmbedBuilder().setTitle("💼 Work Complete").setDescription(`You ${job} and earned **${fmtMoney(amount)}**!\nBalance: ${fmtMoney(updated.balance)}`).setColor(0x57f287)] });
        break;
      }
      case "give": case "pay": {
        const user = targetUser;
        const amount = Math.floor(Number(args.find(a => /^\d+$/.test(a)) || 0));
        if (!user || user.id === message.author.id) return void message.reply("Usage: `!give <@user> <amount>`");
        if (user.bot) return void message.reply("You can't give chips to a bot.");
        if (!amount || amount < 1) return void message.reply("Enter a valid amount to give.");
        const acc = economy.get(message.guild.id, message.author.id);
        if (acc.balance < amount) return void message.reply(`You don't have enough. Balance: ${fmtMoney(acc.balance)}`);
        economy.add(message.guild.id, message.author.id, -amount);
        economy.add(message.guild.id, user.id, amount);
        await message.reply(`✅ Sent **${fmtMoney(amount)}** to ${user}.`);
        break;
      }
      case "steal": {
        const user = targetUser;
        if (!user || user.id === message.author.id) return void message.reply("Usage: `!steal <@user>`");
        if (user.bot) return void message.reply("You can't steal from a bot.");
        const thief = economy.get(message.guild.id, message.author.id);
        const cooldown = 1800000; // 30 min
        const remaining = thief.lastSteal + cooldown - Date.now();
        if (remaining > 0) return void message.reply(`⏳ Lay low for **${formatUptime(remaining)}** before your next heist.`);
        const victim = economy.get(message.guild.id, user.id);
        economy.set(message.guild.id, message.author.id, { lastSteal: Date.now() });
        if (victim.balance < 50) return void message.reply(`${user.username}'s wallet is thin (their bank is safe) — nothing worth stealing.`);
        const success = Math.random() < 0.4; // 40% success
        if (success) {
          const amount = Math.floor(victim.balance * (0.1 + Math.random() * 0.25)); // 10-35%
          economy.add(message.guild.id, user.id, -amount);
          economy.add(message.guild.id, message.author.id, amount);
          await message.reply({ embeds: [new EmbedBuilder()
            .setTitle("🕶️ Heist Successful!")
            .setDescription(`You stole **${fmtMoney(amount)}** from ${user}!`)
            .setColor(0x57f287)], allowedMentions: { parse: [] } });
        } else {
          const fine = Math.floor(50 + Math.random() * 150);
          economy.add(message.guild.id, message.author.id, -fine);
          await message.reply({ embeds: [new EmbedBuilder()
            .setTitle("🚨 Caught!")
            .setDescription(`You got caught trying to rob ${user} and paid a **${fmtMoney(fine)}** fine.`)
            .setColor(0xed4245)], allowedMentions: { parse: [] } });
        }
        break;
      }
      case "coinflip": case "cf": {
        const acc = economy.get(message.guild.id, message.author.id);
        const bet = args[0] === "all" ? acc.balance : Math.floor(Number(args[0]));
        const side = (args[1] || "").toLowerCase();
        if (!bet || bet < 1 || !["heads","tails"].includes(side)) return void message.reply("Usage: `!coinflip <amount|all> <heads|tails>`");
        if (bet > acc.balance) return void message.reply(`You don't have that much. Balance: ${fmtMoney(acc.balance)}`);
        const result = Math.random() < 0.5 ? "heads" : "tails";
        const win = result === side;
        economy.add(message.guild.id, message.author.id, win ? bet : -bet);
        const updated = economy.get(message.guild.id, message.author.id);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🪙 Coinflip")
          .setDescription(`It landed on **${result}**!\n${win ? `You won **${fmtMoney(bet)}**! 🎉` : `You lost **${fmtMoney(bet)}**. 😢`}\nBalance: ${fmtMoney(updated.balance)}`)
          .setColor(win ? 0x57f287 : 0xed4245)] });
        break;
      }
      case "slots": {
        const acc = economy.get(message.guild.id, message.author.id);
        const bet = args[0] === "all" ? acc.balance : Math.floor(Number(args[0]));
        if (!bet || bet < 1) return void message.reply("Usage: `!slots <amount|all>`");
        if (bet > acc.balance) return void message.reply(`You don't have that much. Balance: ${fmtMoney(acc.balance)}`);
        const symbols = ["🍒","🍋","🍊","🍇","⭐","💎","7️⃣"];
        const s = () => symbols[Math.floor(Math.random() * symbols.length)];
        const [a, b, c] = [s(), s(), s()];
        const jackpot = a === b && b === c && a === "7️⃣";
        const win3 = a === b && b === c;
        const win2 = a === b || b === c || a === c;
        let multiplier = 0, resultText;
        if (jackpot) { multiplier = 10; resultText = "🎉 **JACKPOT!!! 10x payout!**"; }
        else if (win3) { multiplier = 4; resultText = "🎊 **Three of a kind! 4x payout!**"; }
        else if (win2) { multiplier = 1.5; resultText = "✨ **Two of a kind! 1.5x payout!**"; }
        else { multiplier = -1; resultText = "❌ **No match. You lose your bet.**"; }
        const delta = Math.floor(bet * multiplier);
        economy.add(message.guild.id, message.author.id, delta);
        const updated = economy.get(message.guild.id, message.author.id);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🎰 662 Slots")
          .setDescription(`\`[ ${a} | ${b} | ${c} ]\`\n\n${resultText}\n${delta >= 0 ? `Won **${fmtMoney(delta)}**` : `Lost **${fmtMoney(-delta)}**`}\nBalance: ${fmtMoney(updated.balance)}`)
          .setColor(jackpot ? 0xffd700 : win3 ? 0x57f287 : win2 ? 0x99aab5 : 0xed4245)] });
        break;
      }
      case "dice": {
        const acc = economy.get(message.guild.id, message.author.id);
        const bet = args[0] === "all" ? acc.balance : Math.floor(Number(args[0]));
        if (!bet || bet < 1) return void message.reply("Usage: `!dice <amount|all>` — roll higher than the house to win");
        if (bet > acc.balance) return void message.reply(`You don't have that much. Balance: ${fmtMoney(acc.balance)}`);
        const you = Math.floor(Math.random() * 6) + 1;
        const house = Math.floor(Math.random() * 6) + 1;
        const win = you > house;
        const tie = you === house;
        const delta = tie ? 0 : win ? bet : -bet;
        economy.add(message.guild.id, message.author.id, delta);
        const updated = economy.get(message.guild.id, message.author.id);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🎲 Dice Duel")
          .setDescription(`You rolled **${you}**, house rolled **${house}**.\n${tie ? "🤝 Tie — bet refunded." : win ? `🎉 You won **${fmtMoney(bet)}**!` : `😢 You lost **${fmtMoney(bet)}**.`}\nBalance: ${fmtMoney(updated.balance)}`)
          .setColor(tie ? 0xffd700 : win ? 0x57f287 : 0xed4245)] });
        break;
      }
      case "givemoney": {
        if (message.author.id !== OWNER_ID) return void message.reply("🚫 This command is locked — only the owner can use it.");
        const user = targetUser || message.author;
        const amount = Math.floor(Number(args.find(a => /^-?\d+$/.test(a)) || 0));
        if (!amount) return void message.reply("Usage: `!givemoney [@user] <amount>`");
        const updated = economy.add(message.guild.id, user.id, amount);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("💸 Chips Granted")
          .setDescription(`Gave **${fmtMoney(amount)}** to ${user}.\nNew balance: ${fmtMoney(updated.balance)}`)
          .setColor(0xffd700)] });
        break;
      }
      case "leaderboard": case "lb": {
        const top = economy.top(message.guild.id, 10);
        if (!top.length) return void message.reply("Nobody has any chips yet.");
        const lines = await Promise.all(top.map(async (e, i) => {
          const u = await client.users.fetch(e.userId).catch(() => null);
          return `**${i + 1}.** ${u ? u.username : "Unknown User"} — ${fmtMoney(e.balance)}`;
        }));
        await message.reply({ embeds: [new EmbedBuilder().setTitle("🏆 662 Casino Leaderboard").setDescription(`*Ranked by net worth (wallet + bank)*\n\n${lines.join("\n")}`).setColor(0xffd700)] });
        break;
      }

      // ── Admin ─────────────────────────────────────────────────────────────
      case "say": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const parts = message.content.slice(PREFIX.length + "say".length).trim();
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

        const rest = message.content.slice(PREFIX.length + "role".length).trim();
        const usage = "Usage: `!role <@user> <role>` or `!role <user> | <role>`\nExample: `!role @Sam Moderator` or `!role Sam | Moderator` — adds it if Sam doesn't have it, removes it if he does. No ping needed for the user — a name or ID works too.";
        if (!rest) return void message.reply(usage);

        let userPart, rolePart;
        // If the user is @mentioned, cut that out first and treat literally everything
        // else as the role name — this way a role name containing "|" (or anything
        // else) still works, instead of breaking on the "|" separator.
        const userMentionMatch = rest.match(/<@!?(\d+)>/);
        if (userMentionMatch) {
          userPart = userMentionMatch[0];
          rolePart = (rest.slice(0, userMentionMatch.index) + rest.slice(userMentionMatch.index + userMentionMatch[0].length)).trim();
        } else if (rest.includes("|")) {
          [userPart, rolePart] = rest.split("|").map(s => s.trim());
        } else {
          // No mention and no "|" — mark the split point with a bare role ID instead.
          const roleAnchorMatch = rest.match(/\b\d{17,19}\b/);
          if (!roleAnchorMatch) return void message.reply(`Please mention the user, or separate the user and role with \`|\`.\n\n${usage}`);
          rolePart = roleAnchorMatch[0];
          userPart = rest.slice(0, roleAnchorMatch.index).trim();
        }
        if (!userPart || !rolePart) return void message.reply(usage);

        const member = await resolveMember(message.guild, userPart);
        if (!member) return void message.reply(`Couldn't find a member matching \`${userPart}\`.`);

        const role = resolveRole(message.guild, rolePart);
        if (!role) return void message.reply(`Couldn't find a role matching \`${rolePart}\`.`);
        if (!role.editable) return void message.reply(`I can't manage **${role.name}** — it's above my highest role, or I'm missing the **Manage Roles** permission.`);

        const hasRole = member.roles.cache.has(role.id);
        if (hasRole) {
          await member.roles.remove(role);
          await message.reply({ content: `✅ Removed **${role.name}** from **${member.user.tag}**`, allowedMentions: { parse: [] } });
        } else {
          await member.roles.add(role);
          await message.reply({ content: `✅ Added **${role.name}** to **${member.user.tag}**`, allowedMentions: { parse: [] } });
        }
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
        const previewAttachment = welcomeImageAttachment();
        const previewEmbed = new EmbedBuilder().setTitle("👋 Welcome!").setDescription(msg.replace("{user}", `${message.author}`).replace("{server}", message.guild.name).replace("{count}", message.guild.memberCount)).setColor(0x57f287).setThumbnail(message.author.displayAvatarURL()).setFooter({ text: "This is a preview" });
        if (previewAttachment) previewEmbed.setImage("attachment://welcome.png");
        await ch.send({ embeds: [previewEmbed], files: previewAttachment ? [previewAttachment] : [] });
        await message.reply("✅ Preview sent!");
        break;
      }
      case "setleave": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const ch = message.mentions.channels.first();
        const msg = message.content.slice(PREFIX.length + "setleave".length).replace(/<#\d+>/, "").trim();
        if (!ch) return void message.reply("Usage: `!setleave #channel <message>` — use {user}, {server}, {count}");
        setConfig(message.guild.id, { leaveChannel: ch.id, leaveMsg: msg || undefined });
        await message.reply(`✅ Leave messages will be sent to ${ch}${msg ? ` with custom message.` : ` with default message.`}`);
        break;
      }
      case "testleave": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const cfg = getConfig(message.guild.id);
        const chId = cfg.leaveChannel || process.env.LEAVE_CHANNEL_ID;
        if (!chId) return void message.reply("No leave channel set. Use `!setleave #channel` first.");
        const msg = cfg.leaveMsg || `**${message.author.username}** has left **${message.guild.name}**. We're down to ${message.guild.memberCount} members.`;
        const ch = await client.channels.fetch(chId);
        const previewAttachment = leaveImageAttachment();
        const previewEmbed = new EmbedBuilder().setTitle("👋 Member Left").setDescription(msg.replace("{user}", `${message.author}`).replace("{server}", message.guild.name).replace("{count}", message.guild.memberCount)).setColor(0xed4245).setThumbnail(message.author.displayAvatarURL()).setFooter({ text: "This is a preview" });
        if (previewAttachment) previewEmbed.setImage("attachment://leave.png");
        await ch.send({ embeds: [previewEmbed], files: previewAttachment ? [previewAttachment] : [] });
        await message.reply("✅ Preview sent!");
        break;
      }
      case "ticketsetup": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        const categoryId = args.find(a => /^\d{17,19}$/.test(a));
        // Role can be given as a mention, a raw ID, or just its name — no ping required.
        const roleQuery = args.filter(a => a !== categoryId).join(" ");
        const role = message.mentions.roles.first() || resolveRole(message.guild, roleQuery);
        if (!categoryId && !role) return void message.reply("Usage: `!ticketsetup <category-id> [staff-role name or ID]`");
        setConfig(message.guild.id, {
          ...(categoryId ? { ticketCategory: categoryId } : {}),
          ...(role ? { ticketRole: role.id } : {}),
        });
        await message.reply({ content: `✅ Ticket config updated.${categoryId ? ` Category: \`${categoryId}\`` : ""}${role ? ` Staff role: **${role.name}**` : ""}`, allowedMentions: { parse: [] } });
        break;
      }
      case "ticketpanel": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;

        const imagePath = path.join(__dirname, "assets", "ltd.png");
        const hasImage = fs.existsSync(imagePath);

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(TICKET_SELECT)
          .setPlaceholder("Select a ticket category...")
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel("🔓 Free Access")
              .setDescription("Join the gang & get turf access")
              .setValue("access"),
            new StringSelectMenuOptionBuilder()
              .setLabel("🤝 Allies")
              .setDescription("Alliance & partnership requests")
              .setValue("allies"),
            new StringSelectMenuOptionBuilder()
              .setLabel("🎫 Support")
              .setDescription("Questions, help & general support")
              .setValue("support"),
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
          .setTitle("🎫 Support Ticket")
          .setDescription(
            "Welcome to our support panel! We have a couple of different support options so please choose the option that fits your request. " +
            "Once your ticket is opened our staff team will assist you as soon as possible.\n\u200b"
          )
          .addFields(
            {
              name: "🔓 Free Access",
              value: "Please use the free access option if you're looking to join this gang and get access to our future turf.",
            },
            {
              name: "🤝 Allies",
              value: "Please use the allies option if you want to ally with us.",
            },
            {
              name: "🎫 Support",
              value: "Please use the support option if you have any questions or need help with something.",
            },
          )
          .setColor(0xe91e8c)
          .setFooter({ text: "662 Support • Only you and staff can see your ticket" })
          .setTimestamp();

        if (hasImage) {
          const attachment = new AttachmentBuilder(imagePath, { name: "662.png" });
          embed.setImage("attachment://662.png");
          await message.channel.send({ embeds: [embed], files: [attachment], components: [row] });
        } else {
          await message.channel.send({ embeds: [embed], components: [row] });
        }

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
      case "settranscript": {
        if (!requirePerm(message, PermissionFlagsBits.ManageGuild)) return;
        const ch = message.mentions.channels.first();
        if (!ch) return void message.reply("Usage: `!settranscript #channel`");
        setConfig(message.guild.id, { transcriptChannel: ch.id });
        await message.reply(`✅ Transcript channel set to ${ch}`);
        break;
      }

      // ── Moderation ────────────────────────────────────────────────────────
      case "kick": {
        if (!requirePerm(message, PermissionFlagsBits.KickMembers)) return;
        if (!targetMember) return void message.reply("Usage: `!kick @user [reason]`");
        if (!targetMember.kickable) return void message.reply("I can't kick that member — they may have a role equal to or higher than mine, or I'm missing the **Kick Members** permission.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await targetMember.kick(reason);
        await message.reply(`👢 Kicked **${targetUser.tag}** — ${reason}`);
        await logToModlog(message.guild, new EmbedBuilder().setTitle("👢 Member Kicked").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Reason", value: reason }).setColor(0xffa500).setTimestamp());
        break;
      }
      case "ban": {
        if (!requirePerm(message, PermissionFlagsBits.BanMembers)) return;
        if (!targetUser) return void message.reply("Usage: `!ban @user [reason]`");
        if (targetMember && !targetMember.bannable) return void message.reply("I can't ban that member — they may have a role equal to or higher than mine, or I'm missing the **Ban Members** permission.");
        const reason = args.slice(1).join(" ") || "No reason provided";
        await message.guild.members.ban(targetUser.id, { reason });
        await message.reply(`🔨 Banned **${targetUser.tag}** — ${reason}`);
        await logToModlog(message.guild, new EmbedBuilder().setTitle("🔨 Member Banned").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Reason", value: reason }).setColor(0xed4245).setTimestamp());
        break;
      }
      case "unban": {
        if (!requirePerm(message, PermissionFlagsBits.BanMembers)) return;
        const userId = args[0];
        if (!userId) return void message.reply("Usage: `!unban <user-id>`");
        await message.guild.members.unban(userId);
        await message.reply(`✅ Unbanned user with ID **${userId}**`);
        break;
      }
      case "timeout": case "to": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        const ms = parseTimeoutDuration(args[1]);
        if (!targetMember || !ms) return void message.reply("Usage: `!to @user <duration> [reason]` — e.g. `!to @user 10`, `10m`, `10min`, `1h`, `1d` (a bare number means minutes)");
        const maxMs = 28 * 24 * 60 * 60 * 1000; // Discord's timeout cap
        if (ms > maxMs) return void message.reply("Timeout duration can't exceed 28 days.");
        if (!targetMember.moderatable) return void message.reply("I can't timeout that member — they may have a role equal to or higher than mine, or I'm missing the **Timeout Members** permission.");
        const mins = Math.round(ms / 60000);
        const reason = args.slice(2).join(" ") || "No reason provided";
        await targetMember.timeout(ms, reason);
        await message.reply(`⏱️ Timed out **${targetUser.tag}** for **${mins}m** — ${reason}`);
        await logToModlog(message.guild, new EmbedBuilder().setTitle("⏱️ Member Timed Out").addFields({ name: "User", value: targetUser.tag, inline: true },{ name: "Moderator", value: message.author.tag, inline: true },{ name: "Duration", value: `${mins} min`, inline: true },{ name: "Reason", value: reason }).setColor(0xffa500).setTimestamp());
        break;
      }
      case "untimeout": case "rto": {
        if (!requirePerm(message, PermissionFlagsBits.ModerateMembers)) return;
        if (!targetMember) return void message.reply("Usage: `!rto @user`");
        if (!targetMember.moderatable) return void message.reply("I can't manage that member — they may have a role equal to or higher than mine, or I'm missing the **Timeout Members** permission.");
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
      case "slowmode": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        const secs = Number(args[0]);
        if (isNaN(secs) || secs < 0 || secs > 21600) return void message.reply("Usage: `!slowmode <seconds>` (0 to disable, max 21600)");
        await message.channel.setRateLimitPerUser(secs);
        await message.reply(secs === 0 ? "✅ Slowmode disabled." : `✅ Slowmode set to **${secs} second(s)**.`);
        break;
      }
      case "clear": case "purge": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const amount = Number(args[0]);
        if (!amount || amount < 1 || amount > 100) return void message.reply("Usage: `!purge <1-100> [@user]`");
        let msgs = await message.channel.messages.fetch({ limit: 100 });
        if (targetUser) msgs = msgs.filter(m => m.author.id === targetUser.id);
        const toDelete = [...msgs.values()].slice(0, amount);
        await message.channel.bulkDelete(toDelete, true).catch(()=>{});
        const reply = await message.channel.send(`🗑️ Deleted **${toDelete.length}** message(s).`);
        setTimeout(() => reply.delete().catch(()=>{}), 3000);
        break;
      }

      // ── Giveaway ─────────────────────────────────────────────────────────
      case "giveaway": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        const [durStr, winStr, ...prizeArr] = args;
        const prize = prizeArr.join(" ");
        const ms = parseDuration(durStr || "");
        const winCount = Number(winStr);
        if (!ms || !Number.isInteger(winCount) || winCount < 1 || !prize) return void message.reply("Usage: `!giveaway <duration> <winners> <prize>` — e.g. `!giveaway 10m 1 Nitro`");
        const endsAt = new Date(Date.now() + ms).toISOString();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(GIVEAWAY_BTN).setLabel("🎉 Enter Giveaway").setStyle(ButtonStyle.Primary));
        const embed = new EmbedBuilder()
          .setTitle("🎁 Giveaway!")
          .setDescription(`**Prize:** ${prize}\n**Winners:** ${winCount}\n**Ends:** <t:${Math.floor((Date.now()+ms)/1000)}:R>`)
          .setColor(0xffd700)
          .setFooter({ text: `Hosted by ${message.author.tag}` })
          .setTimestamp(Date.now() + ms)
          .setFields({ name: "🎟️ Entries — 0", value: "Nobody yet — be the first!", inline: false });
        const giveawayAttachment = giveawayImageAttachment();
        if (giveawayAttachment) embed.setImage("attachment://giveaway.png");
        const gMsg = await message.channel.send({ embeds: [embed], components: [row], files: giveawayAttachment ? [giveawayAttachment] : [] });
        giveaways.add({ messageId: gMsg.id, channelId: message.channel.id, guildId: message.guild.id, prize, winnerCount: winCount, endsAt, participants: [], ended: false });
        scheduleGiveaway(client, gMsg.id, ms);
        await message.reply("✅ Giveaway started!");
        break;
      }
      case "glist": case "giveawaylist": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        let messageId = args[0];
        if (!messageId) {
          const active = giveaways.all().filter(g => g.channelId === message.channel.id && !g.ended);
          if (!active.length) {
            // Fall back to most recent ended giveaway in this channel
            const all = giveaways.all().filter(g => g.channelId === message.channel.id);
            if (!all.length) return void message.reply("No giveaways found in this channel. Usage: `!glist <messageId>`");
            messageId = all[all.length - 1].messageId;
          } else {
            messageId = active[active.length - 1].messageId;
          }
        }
        const g = giveaways.get(messageId);
        if (!g) return void message.reply("Couldn't find a giveaway with that message ID.");
        if (!g.participants.length) {
          return void message.reply({ embeds: [new EmbedBuilder().setTitle(`🎁 Giveaway Participants — ${g.prize}`).setDescription("Nobody has entered yet.").setColor(0xfee75c)] });
        }
        // Resolve IDs to usernames in batches
        const names = await Promise.all(
          g.participants.map(async (id, i) => {
            try {
              const u = await client.users.fetch(id);
              return `${i + 1}. ${u.username} (\`${id}\`)`;
            } catch {
              return `${i + 1}. Unknown User (\`${id}\`)`;
            }
          })
        );
        const status = g.ended ? "Ended" : "Active";
        const chunks = [];
        for (let i = 0; i < names.length; i += 30) chunks.push(names.slice(i, i + 30));
        for (let p = 0; p < chunks.length; p++) {
          const embed = new EmbedBuilder()
            .setTitle(`🎁 ${g.prize} — Participants (${g.participants.length}) [${status}]`)
            .setDescription(chunks[p].join("\n"))
            .setColor(0xfee75c)
            .setFooter({ text: `Page ${p + 1}/${chunks.length} • Message ID: ${messageId}` });
          await message.channel.send({ embeds: [embed] });
        }
        break;
      }
      case "gend": case "endgiveaway": {
        if (!requirePerm(message, PermissionFlagsBits.ManageMessages)) return;
        let messageId = args[0];
        if (!messageId) {
          // No ID given — end the most recent active giveaway in this channel.
          const active = giveaways.all().filter(g => g.channelId === message.channel.id && !g.ended);
          if (!active.length) return void message.reply("No active giveaway in this channel. Usage: `!gend <messageId>`");
          messageId = active[active.length - 1].messageId;
        }
        const g = giveaways.get(messageId);
        if (!g) return void message.reply("Couldn't find a giveaway with that message ID.");
        if (g.ended) return void message.reply("That giveaway has already ended.");
        await endGiveaway(client, messageId);
        await message.reply("✅ Giveaway ended early.");
        break;
      }

      // ── Help ─────────────────────────────────────────────────────────────
      case "help": {
        const embed = new EmbedBuilder()
          .setTitle("📖 Command List")
          .setColor(0x5865f2)
          .addFields(
            {
              name: "📌 General",
              value: [
                "`!ping` — Bot latency",
                "`!botinfo` — Bot stats and info",
                "`!uptime` — How long the bot has been online",
                "`!userinfo [@user]` — View user info",
                "`!serverinfo` — View server info",
                "`!avatar [@user]` — Get a user's avatar",
                "`!membercount` — Server member count",
              ].join("\n"),
            },
            {
              name: "🔧 Utility",
              value: [
                "`!poll Question? | A | B` — Create a poll (up to 5 options)",
                "`!math <expression>` — Calculate math (e.g. `!math 5^2 + 3*4`)",
                "`!remind <time> <message>` — Set a reminder (e.g. `!remind 10m Drink water`)",
                "`!snipe` — Show the last deleted message in this channel",
                "`!afk [reason]` — Set your AFK status",
              ].join("\n"),
            },
            {
              name: "🎰 662 Casino",
              value: [
                "`!balance [@user]` — Check your (or someone's) wallet + bank",
                "`!daily` — Claim your daily chips (every 24h)",
                "`!work` — Earn chips (every 1h)",
                "`!grab` — Look around for loose chips (every 15min)",
                "`!bank` — Check your bank balance",
                "`!deposit <amount|all>` — Move chips into your bank (safe from !steal)",
                "`!withdraw <amount|all>` — Move chips back into your wallet",
                "`!give <@user> <amount>` — Send chips to someone",
                "`!steal <@user>` — Attempt to rob someone's wallet chips (40% success, 30min cooldown, bank is safe)",
                "`!coinflip <amount|all> <heads|tails>` — Bet on a coin flip",
                "`!slots <amount|all>` — Spin the slots",
                "`!dice <amount|all>` — Roll against the house",
                "`!leaderboard` — Richest by net worth (wallet + bank)",
              ].join("\n"),
            },
            {
              name: "⚙️ Admin",
              value: [
                "`!say [#channel] <message>` — Make the bot say something",
                "`!announce #channel <title> | <message>` — Post an announcement",
                "`!role <user> | <role>` — Toggle a role by name or mention (no ping needed), e.g. `!role Sam | Moderator`",
                "`!setwelcome #channel <message>` — Set welcome message",
                "`!testwelcome` — Preview the welcome message",
                "`!setleave #channel <message>` — Set leave message",
                "`!testleave` — Preview the leave message",
                "`!ticketsetup <category-id> [staff-role name or ID]` — Configure ticket system",
                "`!ticketpanel` — Post the ticket panel with dropdown",
                "`!setmodlog #channel` — Set the mod log channel",
              ].join("\n"),
            },
            {
              name: "🛡️ Moderation",
              value: [
                "`!kick @user [reason]` — Kick a member",
                "`!ban @user [reason]` — Ban a member",
                "`!unban <id>` — Unban a member",
                "`!to @user <duration> [reason]` — Timeout a member, e.g. `10`, `10m`, `1h`, `1d`",
                "`!rto @user` — Remove a timeout",
                "`!warn @user <reason>` — Warn a member",
                "`!warnings @user` — View a member's warnings",
                "`!clearwarnings @user` — Clear all warnings",
                "`!lock` — Lock the current channel",
                "`!unlock` — Unlock the current channel",
                "`!slowmode <seconds>` — Set slowmode",
                "`!purge <1-100> [@user]` — Delete messages",
              ].join("\n"),
            },
            {
              name: "🎁 Giveaway",
              value: [
                "`!giveaway <duration> <winners> <prize>` — Start a giveaway, e.g. `!giveaway 10m 1 Nitro`",
                "`!gend [messageId]` — End a giveaway early (defaults to the latest one in this channel)",
                "`!glist [messageId]` — See everyone who entered a giveaway",
              ].join("\n"),
            },
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
