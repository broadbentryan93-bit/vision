require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  ActivityType,
} = require('discord.js');

const EPHEMERAL = 64;
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const panelScriptMap = new Map();
const panelRoleMap = new Map();
const panelMetaMap = new Map();
const panelSetupMap = new Map();
const keyGenSetupMap = new Map();
const guildLogChannels = new Map();

/* ===================== API HELPERS ===================== */
async function api(path, method = 'GET', discordId = 'system', body) {
  const res = await fetch(`${process.env.API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.BOT_API_TOKEN}`,
      'Content-Type': 'application/json',
      'x-discord-id': discordId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  try { return JSON.parse(txt); }
  catch { return { success: false, raw: txt, status: res.status }; }
}

/* ========== ADMIN EDGE FUNCTIONS ========== */
async function adminApi(path, method = "GET", body) {
  const url = `${process.env.SUPABASE_URL}/functions/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-bot-token": process.env.BOT_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  try { return JSON.parse(txt); }
  catch { return { success: false, raw: txt, status: res.status }; }
}

async function sendGuildLog(interaction, message) {
  const chId = guildLogChannels.get(interaction.guild?.id);
  if (!chId) return;
  const ch = interaction.guild.channels.cache.get(chId);
  if (ch) await ch.send(message).catch(()=>{});
}

/* ===================== COMMAND REGISTRATION ===================== */
async function registerCommands() {
  const commands = [

    new SlashCommandBuilder().setName('banip').setDescription('Ban IP')
      .addStringOption(o=>o.setName('ip').setDescription('IP').setRequired(true))
      .addStringOption(o=>o.setName('reason').setDescription('Reason'))
      .addStringOption(o=>o.setName('script_id').setDescription('Script UUID'))
      .addBooleanOption(o=>o.setName('global').setDescription('Global')),

    new SlashCommandBuilder().setName('banhwid').setDescription('Ban HWID')
      .addStringOption(o=>o.setName('hwid').setDescription('HWID').setRequired(true))
      .addStringOption(o=>o.setName('reason').setDescription('Reason'))
      .addStringOption(o=>o.setName('script_id').setDescription('Script UUID'))
      .addBooleanOption(o=>o.setName('global').setDescription('Global')),

  new SlashCommandBuilder()
  .setName('unbanip')
  .setDescription('Unban an IP address')
  .addStringOption(o =>
    o.setName('ip')
     .setDescription('IP address to unban')
     .setRequired(true))
  .addBooleanOption(o =>
    o.setName('global')
     .setDescription('Global unban')
     .setRequired(false)),

new SlashCommandBuilder()
  .setName('unbanhwid')
  .setDescription('Unban an HWID')
  .addStringOption(o =>
    o.setName('hwid')
     .setDescription('HWID string to unban')
     .setRequired(true))
  .addBooleanOption(o =>
    o.setName('global')
     .setDescription('Global unban')
     .setRequired(false)),

    new SlashCommandBuilder().setName('keysecurity').setDescription('View key security')
      .addStringOption(o=>o.setName('key').setRequired(true)),

    new SlashCommandBuilder().setName('iplogs').setDescription('IP logs')
      .addStringOption(o=>o.setName('key_id').setRequired(true)),
  ].map(c=>c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
}

/* ===================== READY ===================== */
client.once('clientReady', async () => {
  client.user.setPresence({
    activities: [{ name: 'Vision Scripts', type: ActivityType.Watching }],
    status: 'online',
  });
  await registerCommands();
});

/* ===================== INTERACTIONS ===================== */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.guild?.ownerId !== interaction.user.id) {
    return interaction.reply({ content:'❌ Owner only.', flags:EPHEMERAL });
  }

  await interaction.deferReply({ flags: EPHEMERAL });

  const cmd = interaction.commandName;

  if (cmd === 'banip') {
    const res = await adminApi('/admin/ban-ip','POST',{
      ip: interaction.options.getString('ip'),
      reason: interaction.options.getString('reason')||'No reason',
      script_id: interaction.options.getString('script_id'),
      is_global: interaction.options.getBoolean('global')??false
    });
    return interaction.editReply(res.success?'✅ IP banned':'❌ Failed');
  }

  if (cmd === 'banhwid') {
    const res = await adminApi('/admin/ban-hwid','POST',{
      hwid: interaction.options.getString('hwid'),
      reason: interaction.options.getString('reason')||'No reason',
      script_id: interaction.options.getString('script_id'),
      is_global: interaction.options.getBoolean('global')??false
    });
    return interaction.editReply(res.success?'✅ HWID banned':'❌ Failed');
  }

  if (cmd === 'unbanip') {
    const res = await adminApi('/admin/unban-ip','POST',{
      ip: interaction.options.getString('ip'),
      is_global: interaction.options.getBoolean('global')??false
    });
    return interaction.editReply(res.success?'✅ IP unbanned':'❌ Failed');
  }

  if (cmd === 'unbanhwid') {
    const res = await adminApi('/admin/unban-hwid','POST',{
      hwid: interaction.options.getString('hwid'),
      is_global: interaction.options.getBoolean('global')??false
    });
    return interaction.editReply(res.success?'✅ HWID unbanned':'❌ Failed');
  }

  if (cmd === 'keysecurity') {
    const key = interaction.options.getString('key');
    const res = await adminApi(`/admin/key-security?key=${encodeURIComponent(key)}`);
    if (!res.success) return interaction.editReply('❌ Failed');

    const embed = new EmbedBuilder()
      .setTitle('Key Security')
      .addFields(
        {name:'HWID',value:`\`\`\`\n${res.hwid||'pending'}\n\`\`\``},
        {name:'Last IP',value:res.last_ip||'none',inline:true},
        {name:'Last Seen',value:String(res.last_seen||'none'),inline:true},
        {name:'Unique IPs',value:String(res.total_ips||0),inline:true},
      );
    return interaction.editReply({embeds:[embed]});
  }

  if (cmd === 'iplogs') {
    const key_id = interaction.options.getString('key_id');
    const res = await adminApi(`/admin/ip-logs?key_id=${key_id}`);
    if (!res.success) return interaction.editReply('❌ Failed');
    const logs = res.logs?.slice(0,15).map(l=>`${l.ip} • ${l.created_at}`).join('\n')||'None';
    return interaction.editReply(`\`\`\`\n${logs}\n\`\`\``);
  }
});

client.login(process.env.DISCORD_TOKEN);

