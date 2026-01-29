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
  Events, // Added this for the 'ready' event
} = require('discord.js');

const EPHEMERAL = 64;
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* ===================== CLIENT ===================== */
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMembers // Added for role management
  ] 
});

/**
 * Persistent panels are stored in your API (/discord-api/panels).
 * These Maps are just fast runtime caches rebuilt at startup.
 */
const panelScriptMap = new Map(); // messageId -> script_name
const panelRoleMap = new Map(); // messageId -> roleId (optional)
const panelMetaMap = new Map(); // messageId -> { title, description, color, channel_id, guild_id } (optional cache)

const panelSetupMap = new Map(); // userId -> { title, description, color }
const keyGenSetupMap = new Map(); // userId -> scriptName

// Per-guild log channel (NOT persisted unless you add an API endpoint)
const guildLogChannels = new Map(); // guildId -> channelId

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
  try {
    return JSON.parse(txt);
  } catch {
    return { success: false, error: 'Non-JSON response', raw: txt, status: res.status };
  }
}

async function logEvent(type, user, script, details = {}) {
  try {
    await api('/logs/event', 'POST', user, { type, user, script, details });
  } catch {}
}

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
  try {
    const chId = guildLogChannels.get(interaction.guild?.id);
    if (!chId) return;
    const ch = interaction.guild.channels.cache.get(chId);
    if (!ch) return;
    await ch.send(message);
  } catch {}
}

/* ===================== UI ===================== */
function panelButtons() {
  // Order: Redeem | Get Script | Get Role | Stats | Reset HWID
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('redeem').setLabel('Redeem Key').setEmoji('🔑').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('script').setLabel('Get Script').setEmoji('📦').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('getrole').setLabel('Get Role').setEmoji('🎖️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stats').setLabel('Stats').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('hwid').setLabel('Reset HWID').setEmoji('♻️').setStyle(ButtonStyle.Danger),
  );
}

function normalizeHexColor(hex) {
  if (!hex) return '#860086';
  let h = String(hex).trim();
  if (!h.startsWith('#')) h = `#${h}`;
  // Basic validation; Discord accepts many formats but keep it safe
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return '#860086';
  return h;
}

/* ===================== STARTUP RESTORE ===================== */
async function restorePanelsFromApi() {
  const data = await api('/panels', 'GET', 'system');
  if (!data?.success || !Array.isArray(data.panels)) return;

  for (const p of data.panels) {
    if (!p?.message_id || !p?.script_name) continue;
    panelScriptMap.set(p.message_id, p.script_name);
    if (p.role_id) panelRoleMap.set(p.message_id, p.role_id);

    panelMetaMap.set(p.message_id, {
      title: p.title || 'Script Panel',
      description: p.description || 'Use the buttons below.',
      color: normalizeHexColor(p.color || '#8d008d'),
      channel_id: p.channel_id,
      guild_id: p.guild_id,
    });
  }

  // Optional: re-apply buttons/embeds so panels keep working even if message lost components
  // This does NOT create new panels; it only repairs existing ones that still exist.
  for (const [messageId, meta] of panelMetaMap.entries()) {
    try {
      const guild = await client.guilds.fetch(meta.guild_id).catch(() => null);
      if (!guild) continue;

      const channel = await guild.channels.fetch(meta.channel_id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) continue;

      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (!msg) continue;

      // Ensure embed + buttons are present
      const embed = new EmbedBuilder().setTitle(meta.title).setDescription(meta.description).setColor(meta.color);

      // Only edit if missing components or embed mismatch (light touch)
      const hasButtons = Array.isArray(msg.components) && msg.components.length > 0;
      if (!hasButtons) {
        await msg.edit({ embeds: [embed], components: [panelButtons()] }).catch(() => {});
      }
    } catch {}
  }
}

/* ===================== COMMAND REGISTRATION ===================== */
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Create a script panel (Server Owner only)')
      .addStringOption((o) =>
        o.setName('color').setDescription('Embed hex color (optional, like #ff00ff)')
      ),

    new SlashCommandBuilder()
      .setName('genkey')
      .setDescription('Generate a key for a script you own'),

    new SlashCommandBuilder()
      .setName('setpanelrole')
      .setDescription('Set role for a specific panel (Server Owner only)')
      .addStringOption((o) =>
        o.setName('message_id').setDescription('Panel message ID').setRequired(true),
      )
      .addRoleOption((o) => o.setName('role').setDescription('Role to give from this panel').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setlogchannel')
      .setDescription('Set bot log channel (Server Owner only)')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Channel where logs will be sent')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)
      ),

    new SlashCommandBuilder()
      .setName('deletepanel')
      .setDescription('Delete a panel (Server Owner only)')
      .addStringOption((o) =>
        o.setName('message_id').setDescription('Panel message ID').setRequired(true),
      ),
    
    new SlashCommandBuilder()
      .setName('banip')
      .setDescription('Ban an IP address')
      .addStringOption(o =>
        o.setName('ip')
         .setDescription('IP address to ban')
         .setRequired(true))
      .addStringOption(o =>
        o.setName('reason')
         .setDescription('Reason for ban')
         .setRequired(false))
      .addStringOption(o =>
        o.setName('script_id')
         .setDescription('Script UUID')
         .setRequired(false))
      .addBooleanOption(o =>
        o.setName('global')
         .setDescription('Global ban')
         .setRequired(false)),

    new SlashCommandBuilder()
      .setName('banhwid')
      .setDescription('Ban an HWID')
      .addStringOption(o =>
        o.setName('hwid')
         .setDescription('HWID string')
         .setRequired(true))
      .addStringOption(o =>
        o.setName('reason')
         .setDescription('Reason for ban')
         .setRequired(false))
      .addStringOption(o =>
        o.setName('script_id')
         .setDescription('Script UUID')
         .setRequired(false))
      .addBooleanOption(o =>
        o.setName('global')
         .setDescription('Global ban')
         .setRequired(false)),

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
         .setDescription('HWID to unban')
         .setRequired(true))
      .addBooleanOption(o =>
        o.setName('global')
         .setDescription('Global unban')
         .setRequired(false)),

    new SlashCommandBuilder()
      .setName('keysecurity')
      .setDescription('View security info for a key')
      .addStringOption(o =>
        o.setName('key')
         .setDescription('License key')
         .setRequired(true)),

    new SlashCommandBuilder()
      .setName('iplogs')
      .setDescription('View IP logs for a key id')
      .addStringOption(o =>
        o.setName('key_id')
         .setDescription('Key UUID')
         .setRequired(true)),

    new SlashCommandBuilder()
      .setName('listscripts')
      .setDescription('List public scripts (if your API provides it)'),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

/* ===================== READY ===================== */
client.on(Events.ClientReady, async () => {
  console.log(`Bot Ready as ${client.user.tag}`);

  client.user.setPresence({
    activities: [
      { name: 'Vision Scripts', type: ActivityType.Watching }
    ],
    status: 'online',
  });

  await registerCommands().catch(console.error);
  await restorePanelsFromApi().catch(console.error);
});

/* ===================== INTERACTIONS ===================== */
client.on('interactionCreate', async (interaction) => {
  try {
    // Handle command permissions first
    if (interaction.isChatInputCommand()) {
      // List of commands that require owner permission
      const ownerOnlyCommands = ['panel', 'setpanelrole', 'setlogchannel', 'deletepanel'];
      
      if (ownerOnlyCommands.includes(interaction.commandName)) {
        if (interaction.guild?.ownerId !== interaction.user.id) {
          return interaction.reply({ content: '❌ Owner only.', flags: EPHEMERAL });
        }
      }
    }

    /* -------- /setlogchannel -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'setlogchannel') {
      const ch = interaction.options.getChannel('channel');
      
      guildLogChannels.set(interaction.guild.id, ch.id);
      return interaction.reply({ content: `✅ Log channel set to ${ch}.`, flags: EPHEMERAL });
    }

    /* -------- /panel -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
      const color = normalizeHexColor(interaction.options.getString('color'));

      // We don't know the script yet, so just store color
      panelSetupMap.set(interaction.user.id, { color });

      const scriptsRes = await api('/user/scripts', 'GET', interaction.user.id);
      if (!scriptsRes?.success || !Array.isArray(scriptsRes.scripts) || scriptsRes.scripts.length === 0) {
        return interaction.reply({ content: '❌ No scripts found for your account.', flags: EPHEMERAL });
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId('setup_script_select')
        .setPlaceholder('Select script')
        .addOptions(
          scriptsRes.scripts.map((s) => ({
            label: s.name,
            description: s.protection_mode || (s.key_required ? 'key' : 'keyless'),
            value: s.name,
          })),
        );

      return interaction.reply({
        content: 'Choose script for this panel:',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: EPHEMERAL,
      });
    }

    /* -------- panel script select -------- */
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_script_select') {
      await interaction.deferUpdate();

      const cfg = panelSetupMap.get(interaction.user.id);
      if (!cfg) {
        return interaction.editReply({ content: '❌ Panel setup expired. Run /panel again.', components: [] });
      }

      const script = interaction.values[0];

      // TITLE = SCRIPT NAME (ALWAYS)
      const title = script || " Control Panel";

      const description =
        `This control panel is for the project: **${title}**.\n\n` +
        `If you're a buyer, click the buttons below to redeem your key, get the script, or receive your role.`;

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(cfg.color);

      const msg = await interaction.channel.send({ embeds: [embed], components: [panelButtons()] });

      panelScriptMap.set(msg.id, script);
      panelMetaMap.set(msg.id, {
        title,
        description,
        color: cfg.color,
        channel_id: interaction.channel.id,
        guild_id: interaction.guild.id,
      });

      await api('/panels', 'POST', interaction.user.id, {
        message_id: msg.id,
        guild_id: interaction.guild.id,
        channel_id: interaction.channel.id,
        script_name: script,
        title,
        description,
        color: cfg.color,
      }).catch(() => {});

      panelSetupMap.delete(interaction.user.id);

      await logEvent('panel_created', interaction.user.id, script, { message_id: msg.id });
      await sendGuildLog(interaction, `📋 Panel created for **${script}** by <@${interaction.user.id}>`);

      return interaction.editReply({ content: '✅ Panel created.', components: [] });
    }

    /* -------- /setpanelrole -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'setpanelrole') {
      await interaction.deferReply({ flags: EPHEMERAL });

      const messageId = interaction.options.getString('message_id');
      const role = interaction.options.getRole('role');

      if (!panelScriptMap.has(messageId)) {
        return interaction.editReply({ content: '❌ Panel not found (wrong message_id or not restored yet).' });
      }

      panelRoleMap.set(messageId, role.id);

      // Persist via API
      await api('/panels/role', 'POST', interaction.user.id, { message_id: messageId, role_id: role.id }).catch(() => {});

      const script = panelScriptMap.get(messageId);
      await logEvent('panel_role_set', interaction.user.id, script, { message_id: messageId, role_id: role.id });
      await sendGuildLog(interaction, `🎖️ Panel role set for **${script}** to <@&${role.id}>`);
      return interaction.editReply('✅ Role linked to that panel.');
    }

    /* -------- /genkey -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'genkey') {
      await interaction.deferReply({ flags: EPHEMERAL });

      const scriptsRes = await api('/user/scripts', 'GET', interaction.user.id);
      if (!scriptsRes?.success || !Array.isArray(scriptsRes.scripts)) {
        return interaction.editReply('❌ Failed to fetch your scripts.');
      }

      const owned = scriptsRes.scripts.filter(
        (s) => String(s.owner_discord_id) === String(interaction.user.id)
      );

      if (owned.length === 0) {
        return interaction.editReply('❌ You do not own any scripts.');
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId('genkey_script_select')
        .setPlaceholder('Select script')
        .addOptions(
          owned.map((s) => ({
            label: s.name,
            description: `${s.keys_count ?? 0} keys`,
            value: s.name,
          }))
        );

      return interaction.editReply({
        content: 'Select script to generate a key for:',
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }

    /* -------- genkey script select -------- */
    if (interaction.isStringSelectMenu() && interaction.customId === 'genkey_script_select') {
      await interaction.deferUpdate();

      const script = interaction.values[0];
      keyGenSetupMap.set(interaction.user.id, script);

      const durationMenu = new StringSelectMenuBuilder()
        .setCustomId('genkey_duration_select')
        .setPlaceholder('Select duration')
        .addOptions([
          { label: '1 Day', value: '1' },
          { label: '7 Days', value: '7' },
          { label: '30 Days', value: '30' },
          { label: 'Lifetime', value: '9999' },
        ]);

      return interaction.editReply({
        content: `Script: **${script}**\nSelect duration:`,
        components: [new ActionRowBuilder().addComponents(durationMenu)],
      });
    }

    /* -------- genkey duration select -------- */
    if (interaction.isStringSelectMenu() && interaction.customId === 'genkey_duration_select') {
      await interaction.deferReply({ flags: EPHEMERAL });

      const script = keyGenSetupMap.get(interaction.user.id);
      if (!script) return interaction.editReply('❌ Key generation expired. Run /genkey again.');

      const days = parseInt(interaction.values[0], 10);

      const keyData = await api('/admin/key/generate', 'POST', interaction.user.id, {
        script,
        duration_days: days,
        max_uses: 1,
        is_premium: false,
      });

      keyGenSetupMap.delete(interaction.user.id);

      if (!keyData?.success) {
        return interaction.editReply(`❌ Failed to generate key: ${keyData?.error || keyData?.details || 'unknown error'}`);
      }

      await logEvent('key_generated', interaction.user.id, script, {
        duration_days: days,
        max_uses: keyData.max_uses,
      });

      await sendGuildLog(interaction, `🛠️ Key generated for **${script}** by <@${interaction.user.id}>`);

      return interaction.editReply(
        `🔑 Key for **${script}**\n\`\`\`\n${keyData.key}\n\`\`\`\nExpires: ${keyData.expires_at}`
      );
    }

    /* -------- /listscripts -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'listscripts') {
      await interaction.deferReply({ flags: EPHEMERAL });

      const tries = ['/public/scripts', '/scripts/public', '/scripts/list/public'];
      let res = null;

      for (const p of tries) {
        res = await api(p, 'GET', interaction.user.id).catch(() => null);
        if (res?.success && Array.isArray(res.scripts)) break;
        res = null;
      }

      if (!res) {
        return interaction.editReply('❌ Public scripts endpoint not found on API yet.');
      }

      if (res.scripts.length === 0) return interaction.editReply('No public scripts.');

      const out = res.scripts.slice(0, 25).map((s) => `• ${s.name}`).join('\n');
      return interaction.editReply(out);
    }

    /* -------- /deletepanel -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'deletepanel') {
      await interaction.deferReply({ flags: EPHEMERAL });

      const messageId = interaction.options.getString('message_id');

      // Try delete the Discord message if possible
      const meta = panelMetaMap.get(messageId);
      if (meta?.guild_id && meta?.channel_id) {
        try {
          const guild = await client.guilds.fetch(meta.guild_id).catch(() => null);
          const channel = guild ? await guild.channels.fetch(meta.channel_id).catch(() => null) : null;
          if (channel && channel.type === ChannelType.GuildText) {
            const msg = await channel.messages.fetch(messageId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }
        } catch {}
      }

      // Remove from caches
      const script = panelScriptMap.get(messageId);
      panelScriptMap.delete(messageId);
      panelRoleMap.delete(messageId);
      panelMetaMap.delete(messageId);

      // Try to delete from API
      const deleteTries = [
        { path: `/panels/${messageId}`, method: 'DELETE', body: undefined },
        { path: `/panels/delete`, method: 'POST', body: { message_id: messageId } },
        { path: `/panels`, method: 'DELETE', body: { message_id: messageId } },
      ];

      let deleted = false;
      for (const t of deleteTries) {
        const r = await api(t.path, t.method, interaction.user.id, t.body).catch(() => null);
        if (r?.success) {
          deleted = true;
          break;
        }
      }

      await logEvent('panel_deleted', interaction.user.id, script || 'unknown', { message_id: messageId });
      await sendGuildLog(interaction, `🗑️ Panel deleted (${messageId}) by <@${interaction.user.id}>`);

      return interaction.editReply(deleted ? '✅ Panel deleted.' : '✅ Panel removed locally (API delete endpoint not found yet).');
    }

    /* -------- Admin commands -------- */
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      
      if (['banip', 'banhwid', 'unbanip', 'unbanhwid', 'keysecurity', 'iplogs'].includes(cmd)) {
        await interaction.deferReply({ flags: EPHEMERAL });
        
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
      }
    }

    /* ===================== BUTTON HANDLERS ===================== */
    if (interaction.isButton()) {
      const messageId = interaction.message.id;
      const script = panelScriptMap.get(messageId);

      if (!script) {
        return interaction.reply({ content: '❌ This panel is not registered. Recreate it with /panel.', flags: EPHEMERAL });
      }

      if (interaction.customId === 'getrole') {
  const roleId = panelRoleMap.get(messageId);
  if (!roleId) {
    return interaction.reply({ content: '❌ No role configured for this panel.', flags: EPHEMERAL });
  }

  // 🔍 Check user access
  const access = await api(`/user/access?script=${encodeURIComponent(script)}`, 'GET', interaction.user.id);

  if (!access?.success) {
    return interaction.reply({ content: '❌ Failed to verify access.', flags: EPHEMERAL });
  }

  /* ================= KEYLESS SCRIPTS ================= */
  if (access.access_type === 'keyless') {
    // allow role for keyless scripts
    try {
      await interaction.member.roles.add(roleId);
      await logEvent('panel_role_granted', interaction.user.id, script, { role_id: roleId, type: 'keyless' });
      await sendGuildLog(interaction, `🎖️ Keyless role granted to <@${interaction.user.id}> (**${script}**)`);
      return interaction.reply({ content: '✅ Role granted.', flags: EPHEMERAL });
    } catch {
      return interaction.reply({ content: '❌ Bot lacks role permissions.', flags: EPHEMERAL });
    }
  }

  /* ================= KEY SYSTEM SCRIPTS ================= */
  if (!access.has_access || !access.key_used) {
    return interaction.reply({
      content: '🔑 You must redeem a valid key before receiving this role.',
      flags: EPHEMERAL
    });
  }

  /* ================= USER HAS KEY ================= */
  try {
    await interaction.member.roles.add(roleId);
    await logEvent('panel_role_granted', interaction.user.id, script, {
      role_id: roleId,
      key_used: access.key_used
    });
    await sendGuildLog(interaction, `🎖️ Role granted to <@${interaction.user.id}> (**${script}**)`);
    return interaction.reply({ content: '✅ Role granted.', flags: EPHEMERAL });
  } catch (error) {
    console.error('Role assignment error:', error);
    return interaction.reply({ content: '❌ Failed to assign role. Check bot role hierarchy.', flags: EPHEMERAL });
  }
}

      if (interaction.customId === 'redeem') {
        // Check if script is keyless
        const access = await api(`/user/access?script=${encodeURIComponent(script)}`, 'GET', interaction.user.id);
        if (access?.success && access.access_type === 'keyless') {
          return interaction.reply({ content: 'This script is keyless.', flags: EPHEMERAL });
        }

        const modal = new ModalBuilder()
          .setCustomId(`redeem_modal:${messageId}`)
          .setTitle(`Redeem Key for ${script}`)
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('key')
                .setLabel('Enter Key')
                .setStyle(TextInputStyle.Short)
                .setRequired(true),
            ),
          );

        return interaction.showModal(modal);
      }

      // For other buttons that need API calls, defer first
      await interaction.deferReply({ flags: EPHEMERAL });

      if (interaction.customId === 'script') {
        const access = await api(`/user/access?script=${encodeURIComponent(script)}`, 'GET', interaction.user.id);

        if (!access?.success) {
          return interaction.editReply('❌ Failed to check access. Try again.');
        }

        /* ================= KEYLESS ================= */
        if (access.access_type === 'keyless') {
          const loader = `\`\`\`lua
loadstring(game:HttpGet("${access.loader_url}"))()
\`\`\``;

          await logEvent('loader_requested', interaction.user.id, script, { access_type: 'keyless' });
          await sendGuildLog(interaction, `📦 Keyless script requested by <@${interaction.user.id}> (**${script}**)`);
          return interaction.editReply(loader);
        }

        /* ================= KEY SCRIPTS ================= */
        if (!access.has_access) {
          return interaction.editReply('🔑 This script requires a key. Redeem one first.');
        }

        if (access.access_type === 'key' && access.key_used) {
          const loader = `\`\`\`lua
local key = "${access.key_used}"
loadstring(game:HttpGet("${access.loader_url}?raw=1&key=" .. key))()
\`\`\``;

          await logEvent('loader_requested', interaction.user.id, script, { access_type: 'key' });
          await sendGuildLog(interaction, `📦 Script delivered to <@${interaction.user.id}> (**${script}**)`);
          return interaction.editReply(loader);
        }

        /* ================= OWNER / WHITELIST ================= */
        const loader = `\`\`\`lua
loadstring(game:HttpGet("${access.loader_url}"))()
\`\`\``;

        await logEvent('loader_requested', interaction.user.id, script, { access_type: access.access_type });
        await sendGuildLog(interaction, `📦 Script delivered to <@${interaction.user.id}> (**${script}**)`);
        return interaction.editReply(loader);
      }

      if (interaction.customId === 'stats') {
        const stats = await api(`/user/stats?script=${encodeURIComponent(script)}`, 'GET', interaction.user.id);
        const access = await api(`/user/access?script=${encodeURIComponent(script)}`, 'GET', interaction.user.id);

        if (!stats?.success) return interaction.editReply('❌ Failed to fetch stats.');

        const embed = new EmbedBuilder()
          .setTitle(`📊 ${script} Stats`)
          .setColor('#ff00ff')
          .addFields(
            { name: 'Executions', value: String(stats.stats.total_executions), inline: true },
            { name: 'Success', value: String(stats.stats.successful_executions), inline: true },
            { name: 'Active Keys', value: String(stats.stats.active_keys), inline: true },
            {
              name: 'Your Key',
              value: access?.key_used ? `\`\`\`${access.key_used}\`\`\`` : 'No key linked',
              inline: false
            },
            {
              name: 'Access Type',
              value: access?.access_type || 'unknown',
              inline: true
            }
          )
          .setFooter({ text: `User: ${interaction.user.username}` });

        await logEvent('stats_viewed', interaction.user.id, script);
        return interaction.editReply({ embeds: [embed] });
      }

      if (interaction.customId === 'hwid') {
        const res = await api('/user/reset-hwid', 'POST', interaction.user.id, { script });
        if (!res?.success) return interaction.editReply('❌ HWID reset failed.');

        await logEvent('hwid_reset', interaction.user.id, script, res);
        await sendGuildLog(interaction, `♻️ HWID reset by <@${interaction.user.id}> (**${script}**)`);
        return interaction.editReply(res.message || `HWID reset successful. Keys reset: ${res.keys_reset ?? 0}`);
      }
    }

    /* ===================== MODAL SUBMIT ===================== */
    if (interaction.isModalSubmit()) {
      const [modalType, messageId] = String(interaction.customId).split(':');
      if (modalType !== 'redeem_modal') return;

      await interaction.deferReply({ flags: EPHEMERAL });

      const script = panelScriptMap.get(messageId);
      if (!script) return interaction.editReply('❌ Panel not registered.');

      // If keyless, tell them
      const access = await api(`/user/access?script=${encodeURIComponent(script)}`, 'GET', interaction.user.id);
      if (access?.success && access.access_type === 'keyless') {
        return interaction.editReply('This script is keyless.');
      }

      const key = interaction.fields.getTextInputValue('key');
      const res = await api('/key/redeem', 'POST', interaction.user.id, { key });

      if (!res?.success) return interaction.editReply('❌ Invalid or expired key.');

      await logEvent('key_redeemed', interaction.user.id, res.script_name || script, { key_value: res.key_value });
      await sendGuildLog(interaction, `🔑 Key redeemed by <@${interaction.user.id}> (**${res.script_name || script}**)`);

      return interaction.editReply(
        `✅ Key Redeemed\nUses left: ${res.remaining_uses}\nExpires: ${res.expires_at}`,
      );
    }
  } catch (err) {
    console.error('Interaction error:', err);
    
    try {
      if (interaction.isRepliable()) {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ An error occurred.', flags: EPHEMERAL });
        } else if (interaction.deferred) {
          await interaction.editReply('❌ An error occurred.');
        }
      }
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
});

/* ===================== PROCESS SAFETY ===================== */
client.on('error', (e) => console.error('client error:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

client.login(process.env.DISCORD_TOKEN);

