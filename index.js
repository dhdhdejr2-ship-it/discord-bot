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

const PREFIX = "!";
const GIVEAWAY_BTN   = "giveaway_enter";
const TICKET_SELECT  = "ticket_category";
const TICKET_CLOSE   = "ticket_close";

const NUMBER_EMOJI = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣"];
const EIGHT_BALL = ["It is certain.","It is decidedly so.","Without a doubt.","Yes, definitely.","You may rely on it.","As I see it, yes.","Most likely.","Outlook good.","Yes.","Signs point to yes.","Reply hazy, try again.","Ask again later.","Better not tell you now.","Cannot predict now.","Concentrate and ask again.","Don't count on it.","My reply is no.","My sources say no.","Outlook not so good.","Very doubtful."];

const TICKET_CATEGORIES = {
  access:  { label: "🔐 Access",  description: "Request access to something",  color: 0xe91e8c },
  allies:  { label: "🤝 Allies",  description: "Alliance & partnership requests", color: 0xe91e8c },
  buying:  { label: "🛒 Buying",  description: "Purchasing & buying inquiries", color: 0xe91e8c },
};

const startTime = Date.now();

// ─── In-memory state ───────────────────────────────────────────────────────
const sniped     = new Map(); // channelId → { author, content, timestamp }
const afkUsers   = new Map(); // userId    → { reason, since }
const activeGames = new Map(); // userId   → true

// ─── Game data ─────────────────────────────────────────────────────────────
const TRIVIA = [
  { q: "What is the capital of France?", a: "Paris", options: ["London","Paris","Berlin","Madrid"] },
  { q: "How many sides does a hexagon have?", a: "6", options: ["5","6","7","8"] },
  { q: "What planet is known as the Red Planet?", a: "Mars", options: ["Venus","Jupiter","Mars","Saturn"] },
  { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci", options: ["Picasso","Michelangelo","Leonardo da Vinci","Raphael"] },
  { q: "What is the largest ocean on Earth?", a: "Pacific Ocean", options: ["Atlantic Ocean","Indian Ocean","Pacific Ocean","Arctic Ocean"] },
  { q: "What gas do plants absorb from the atmosphere?", a: "Carbon dioxide", options: ["Oxygen","Nitrogen","Carbon dioxide","Hydrogen"] },
  { q: "How many continents are on Earth?", a: "7", options: ["5","6","7","8"] },
  { q: "What is the fastest land animal?", a: "Cheetah", options: ["Lion","Cheetah","Horse","Leopard"] },
  { q: "What is the hardest natural substance on Earth?", a: "Diamond", options: ["Gold","Iron","Diamond","Quartz"] },
  { q: "What year did World War II end?", a: "1945", options: ["1943","1944","1945","1946"] },
  { q: "What is the chemical symbol for water?", a: "H2O", options: ["O2","CO2","H2O","H2SO4"] },
  { q: "How many bones are in the adult human body?", a: "206", options: ["196","206","216","226"] },
  { q: "What is the smallest planet in our solar system?", a: "Mercury", options: ["Mars","Pluto","Mercury","Venus"] },
  { q: "Who wrote Romeo and Juliet?", a: "Shakespeare", options: ["Dickens","Shakespeare","Tolkien","Hemingway"] },
  { q: "What is the speed of light (approx)?", a: "300,000 km/s", options: ["150,000 km/s","300,000 km/s","500,000 km/s","1,000,000 km/s"] },
  { q: "What language has the most native speakers?", a: "Mandarin Chinese", options: ["English","Spanish","Mandarin Chinese","Hindi"] },
  { q: "What is the tallest mountain in the world?", a: "Mount Everest", options: ["K2","Mount Everest","Kangchenjunga","Lhotse"] },
  { q: "How many players are on a standard soccer team?", a: "11", options: ["9","10","11","12"] },
  { q: "What element does 'O' represent on the periodic table?", a: "Oxygen", options: ["Gold","Osmium","Oxygen","Oganesson"] },
  { q: "What is 7 × 8?", a: "56", options: ["48","54","56","64"] },
];

const WYR = [
  "Would you rather **fly** or be **invisible**?",
  "Would you rather have **unlimited money** or **unlimited time**?",
  "Would you rather **never sleep** or **never eat**?",
  "Would you rather be **always hot** or **always cold**?",
  "Would you rather **speak every language** or **play every instrument**?",
  "Would you rather **live in space** or **under the ocean**?",
  "Would you rather **know when you'll die** or **how you'll die**?",
  "Would you rather **be a famous actor** or **a famous musician**?",
  "Would you rather **always be late** or **always be 2 hours early**?",
  "Would you rather **have no internet** or **no music**?",
  "Would you rather **fight 100 duck-sized horses** or **1 horse-sized duck**?",
  "Would you rather **lose all your money** or **lose all your memories**?",
  "Would you rather **only whisper** or **only shout**?",
  "Would you rather **be famous but broke** or **rich but unknown**?",
  "Would you rather **teleport** or **time travel**?",
];

const RIDDLES = [
  { q: "I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?", a: "an echo" },
  { q: "The more you take, the more you leave behind. What am I?", a: "footsteps" },
  { q: "I have cities, but no houses live there. I have mountains, but no trees grow. I have water, but no fish swim. I have roads, but no cars drive. What am I?", a: "a map" },
  { q: "What has hands but can't clap?", a: "a clock" },
  { q: "What gets wetter the more it dries?", a: "a towel" },
  { q: "I have a head and a tail, but no body. What am I?", a: "a coin" },
  { q: "What has to be broken before you can use it?", a: "an egg" },
  { q: "I'm tall when I'm young, short when I'm old. What am I?", a: "a candle" },
  { q: "What has many teeth but can't bite?", a: "a comb" },
  { q: "What can travel around the world while staying in a corner?", a: "a stamp" },
];

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
    await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Welcome!").setDescription(formatted).setColor(0x57f287).setThumbnail(member.user.displayAvatarURL())] });
  } catch(e) { console.error("Welcome error:", e); }
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
    afkUsers.delete(message.author.id);
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
    giveaways.update(g.messageId, { participants: [...g.participants, interaction.user.id] });
    return interaction.reply({ content: "🎉 You're entered in the giveaway!", ephemeral: true });
  }

  // ── Ticket close button ──
  if (interaction.isButton() && interaction.customId === TICKET_CLOSE) {
    const canClose =
      interaction.member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
      interaction.channel.name.includes(interaction.user.username.toLowerCase());
    if (!canClose) return interaction.reply({ content: "You can't close this ticket.", ephemeral: true });
    await interaction.reply("🔒 Closing ticket in 5 seconds...");
    setTimeout(() => interaction.channel.delete().catch(()=>{}), 5000);
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
      await interaction.reply({ content: `✅ Your ticket has been opened: ${ch}`, ephemeral: true });
    } catch (e) {
      console.error("Ticket create error:", e);
      await interaction.reply({ content: "Failed to create ticket. Make sure the bot has the right permissions.", ephemeral: true });
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

  const targetUser = message.mentions.users.first() || null;
  const targetMember = targetUser ? await message.guild.members.fetch(targetUser.id).catch(()=>null) : null;

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
        const reminder = args.slice(1).join(" ");
        if (!timeStr || !reminder) return void message.reply("Usage: `!remind <time> <message>` — e.g. `!remind 10m Take a break`");
        const ms = parseDuration(timeStr);
        if (!ms) return void message.reply("Invalid time. Use: `10s`, `5m`, `2h`, `1d`");
        if (ms > 86400000 * 7) return void message.reply("Max reminder time is 7 days.");
        await message.reply(`✅ Got it! I'll remind you about **${reminder}** in **${timeStr}**.`);
        setTimeout(async () => {
          try {
            await message.author.send({ embeds: [new EmbedBuilder().setTitle("⏰ Reminder!").setDescription(reminder).setColor(0xffd700).setFooter({ text: `Set in ${message.guild.name}` }).setTimestamp()] });
          } catch {
            await message.channel.send(`⏰ ${message.author}, reminder: **${reminder}**`).catch(()=>{});
          }
        }, ms);
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
        afkUsers.set(message.author.id, { reason, since: Date.now() });
        await message.reply(`💤 You're now AFK: **${reason}**`);
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

      // ── Games ─────────────────────────────────────────────────────────────
      case "rps": {
        const choices = ["rock","paper","scissors"];
        const emojis = { rock: "🪨", paper: "📄", scissors: "✂️" };
        const userChoice = args[0]?.toLowerCase();
        if (!choices.includes(userChoice)) return void message.reply("Usage: `!rps <rock|paper|scissors>`");
        const botChoice = choices[Math.floor(Math.random() * 3)];
        let result;
        if (userChoice === botChoice) result = "🤝 It's a **tie**!";
        else if ((userChoice==="rock"&&botChoice==="scissors")||(userChoice==="paper"&&botChoice==="rock")||(userChoice==="scissors"&&botChoice==="paper"))
          result = "🎉 You **win**!";
        else result = "😢 You **lose**!";
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("✊ Rock Paper Scissors")
          .setDescription(`You: ${emojis[userChoice]} **${userChoice}**\nBot: ${emojis[botChoice]} **${botChoice}**\n\n${result}`)
          .setColor(result.includes("win") ? 0x57f287 : result.includes("lose") ? 0xed4245 : 0xffd700)] });
        break;
      }
      case "slots": {
        const symbols = ["🍒","🍋","🍊","🍇","⭐","💎","7️⃣"];
        const s = () => symbols[Math.floor(Math.random() * symbols.length)];
        const [a, b, c] = [s(), s(), s()];
        const win = a === b && b === c;
        const twoMatch = a === b || b === c || a === c;
        const resultText = win ? "🎉 **JACKPOT! Three of a kind!**" : twoMatch ? "✨ **Two of a kind! Almost!**" : "❌ **No match. Try again!**";
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🎰 Slots")
          .setDescription(`\`[ ${a} | ${b} | ${c} ]\`\n\n${resultText}`)
          .setColor(win ? 0xffd700 : twoMatch ? 0x57f287 : 0x99aab5)] });
        break;
      }
      case "trivia": {
        const q = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
        const shuffled = [...q.options].sort(() => Math.random() - 0.5);
        const letters = ["A","B","C","D"];
        const choiceMap = Object.fromEntries(shuffled.map((opt, i) => [letters[i], opt]));
        const correctLetter = Object.keys(choiceMap).find(k => choiceMap[k] === q.a);
        const optionsText = Object.entries(choiceMap).map(([l, v]) => `**${l})** ${v}`).join("\n");
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🧠 Trivia")
          .setDescription(`${q.q}\n\n${optionsText}\n\n*Type A, B, C, or D — you have 15 seconds!*`)
          .setColor(0x5865f2)] });
        const filter = m => m.author.id === message.author.id && ["a","b","c","d"].includes(m.content.toLowerCase());
        const collector = message.channel.createMessageCollector({ filter, time: 15000, max: 1 });
        collector.on("collect", async m => {
          const answered = m.content.toUpperCase();
          if (answered === correctLetter)
            await message.channel.send(`✅ **Correct!** The answer was **${q.a}**. Well done, ${message.author}!`);
          else
            await message.channel.send(`❌ **Wrong!** The correct answer was **${correctLetter}) ${q.a}**. Better luck next time, ${message.author}!`);
        });
        collector.on("end", collected => {
          if (!collected.size) message.channel.send(`⏰ Time's up! The answer was **${correctLetter}) ${q.a}**.`).catch(()=>{});
        });
        break;
      }
      case "wyr": {
        const prompt = WYR[Math.floor(Math.random() * WYR.length)];
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🤔 Would You Rather...")
          .setDescription(prompt)
          .setColor(0xf5a623)
          .setFooter({ text: "Reply in chat with your choice!" })] });
        break;
      }
      case "riddle": {
        const riddle = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🧩 Riddle")
          .setDescription(`${riddle.q}\n\n*Type your answer — you have 30 seconds!*`)
          .setColor(0x9b59b6)] });
        const filter = m => m.author.id === message.author.id;
        const collector = message.channel.createMessageCollector({ filter, time: 30000, max: 1 });
        collector.on("collect", async m => {
          if (m.content.toLowerCase().includes(riddle.a.toLowerCase()))
            await message.channel.send(`✅ **Correct!** The answer was **${riddle.a}**. Great job, ${message.author}!`);
          else
            await message.channel.send(`❌ **Not quite!** The answer was **${riddle.a}**. Good try, ${message.author}!`);
        });
        collector.on("end", collected => {
          if (!collected.size) message.channel.send(`⏰ Time's up! The answer was **${riddle.a}**.`).catch(()=>{});
        });
        break;
      }
      case "numguess": {
        if (activeGames.has(message.author.id)) return void message.reply("You already have an active guessing game!");
        const target = Math.floor(Math.random() * 100) + 1;
        let attempts = 0;
        activeGames.set(message.author.id, true);
        await message.reply({ embeds: [new EmbedBuilder()
          .setTitle("🔢 Number Guessing Game")
          .setDescription("I'm thinking of a number between **1 and 100**.\nYou have **7 attempts** — type your guesses!")
          .setColor(0x5865f2)] });
        const filter = m => m.author.id === message.author.id && !isNaN(m.content) && m.content.trim() !== "";
        const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 7 });
        collector.on("collect", async m => {
          attempts++;
          const guess = Number(m.content.trim());
          const remaining = 7 - attempts;
          if (guess === target) {
            collector.stop("win");
            activeGames.delete(message.author.id);
            await m.reply(`🎉 **Correct!** The number was **${target}**! You got it in **${attempts}** attempt(s)!`);
          } else if (remaining === 0) {
            collector.stop("lose");
          } else {
            await m.reply(`${guess < target ? "📈 Too low!" : "📉 Too high!"} **${remaining}** attempt(s) left.`);
          }
        });
        collector.on("end", (_, reason) => {
          activeGames.delete(message.author.id);
          if (reason !== "win") message.channel.send(`💀 Game over! The number was **${target}**. Better luck next time!`).catch(()=>{});
        });
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
        const usage = "Usage: `!role <user> | <role>`\nExample: `!role Sam | Moderator` — adds it if Sam doesn't have it, removes it if he does. No ping needed — you can use a name instead of @mentioning.";
        if (!rest) return void message.reply(usage);

        let userPart, rolePart;
        if (rest.includes("|")) {
          [userPart, rolePart] = rest.split("|").map(s => s.trim());
        } else {
          // No "|" given — only works if a role mention is present to mark the split point.
          const roleMentionMatch = rest.match(/<@&\d+>/);
          if (!roleMentionMatch) return void message.reply(`Please separate the user and role with \`|\`.\n\n${usage}`);
          rolePart = roleMentionMatch[0];
          userPart = rest.slice(0, roleMentionMatch.index).trim();
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
        await ch.send({ embeds: [new EmbedBuilder().setTitle("👋 Welcome!").setDescription(msg.replace("{user}", `${message.author}`).replace("{server}", message.guild.name).replace("{count}", message.guild.memberCount)).setColor(0x57f287).setThumbnail(message.author.displayAvatarURL()).setFooter({ text: "This is a preview" })] });
        await message.reply("✅ Preview sent!");
        break;
      }
      case "ticketsetup": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;
        const categoryId = args.find(a => /^\d{17,19}$/.test(a));
        const role = message.mentions.roles.first();
        if (!categoryId && !role) return void message.reply("Usage: `!ticketsetup <category-id> [@staff-role]`");
        setConfig(message.guild.id, {
          ...(categoryId ? { ticketCategory: categoryId } : {}),
          ...(role ? { ticketRole: role.id } : {}),
        });
        await message.reply(`✅ Ticket config updated.${categoryId ? ` Category: \`${categoryId}\`` : ""}${role ? ` Staff role: ${role}` : ""}`);
        break;
      }
      case "ticketpanel": {
        if (!requirePerm(message, PermissionFlagsBits.ManageChannels)) return;

        const imagePath = path.join(__dirname, "assets", "662.png");
        const hasImage = fs.existsSync(imagePath);

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(TICKET_SELECT)
          .setPlaceholder("Choose a category...")
          .addOptions(
            new StringSelectMenuOptionBuilder()
              .setLabel("🔐 Access")
              .setDescription("Request access to something")
              .setValue("access"),
            new StringSelectMenuOptionBuilder()
              .setLabel("🤝 Allies")
              .setDescription("Alliance & partnership requests")
              .setValue("allies"),
            new StringSelectMenuOptionBuilder()
              .setLabel("🛒 Buying")
              .setDescription("Purchasing & buying inquiries")
              .setValue("buying"),
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        const embed = new EmbedBuilder()
          .setTitle("🎫 Open a Support Ticket")
          .setDescription(
            "Need help? Select a category from the menu below and a private ticket will be opened for you.\n\n" +
            "🔐 **Access** — Request access to something\n" +
            "🤝 **Allies** — Alliance & partnership requests\n" +
            "🛒 **Buying** — Purchasing & buying inquiries"
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
        const mins = Number(args[1]);
        if (!targetMember || isNaN(mins) || mins < 1) return void message.reply("Usage: `!to @user <minutes> [reason]`");
        if (mins > 40320) return void message.reply("Timeout duration can't exceed 28 days (40320 minutes).");
        if (!targetMember.moderatable) return void message.reply("I can't timeout that member — they may have a role equal to or higher than mine, or I'm missing the **Timeout Members** permission.");
        const reason = args.slice(2).join(" ") || "No reason provided";
        await targetMember.timeout(mins * 60000, reason);
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
        if (!ms || !winCount || !prize) return void message.reply("Usage: `!giveaway <duration> <winners> <prize>` — e.g. `!giveaway 10m 1 Nitro`");
        const endsAt = new Date(Date.now() + ms).toISOString();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(GIVEAWAY_BTN).setLabel("🎉 Enter Giveaway").setStyle(ButtonStyle.Primary));
        const embed = new EmbedBuilder()
          .setTitle("🎁 Giveaway!")
          .setDescription(`**Prize:** ${prize}\n**Winners:** ${winCount}\n**Ends:** <t:${Math.floor((Date.now()+ms)/1000)}:R>`)
          .setColor(0xffd700)
          .setFooter({ text: `Hosted by ${message.author.tag}` })
          .setTimestamp(Date.now() + ms);
        const gMsg = await message.channel.send({ embeds: [embed], components: [row] });
        giveaways.add({ messageId: gMsg.id, channelId: message.channel.id, guildId: message.guild.id, prize, winnerCount: winCount, endsAt, participants: [], ended: false });
        scheduleGiveaway(client, gMsg.id, ms);
        await message.reply("✅ Giveaway started!");
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
              name: "🎮 Games",
              value: [
                "`!rps <rock|paper|scissors>` — Rock Paper Scissors vs bot",
                "`!coinflip` — Flip a coin",
                "`!roll [sides] [count]` — Roll dice (default: 1d6)",
                "`!slots` — Spin the slot machine",
                "`!trivia` — Answer a random trivia question",
                "`!wyr` — Would You Rather prompt",
                "`!riddle` — Solve a riddle",
                "`!numguess` — Guess a number 1-100 (7 attempts)",
                "`!8ball <question>` — Ask the magic 8-ball",
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
                "`!ticketsetup <category-id> [@staff-role]` — Configure ticket system",
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
                "`!to @user <minutes> [reason]` — Timeout a member",
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
              value: "`!giveaway <duration> <winners> <prize>` — Start a giveaway\nExample: `!giveaway 10m 1 Nitro`",
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
