require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const play = require('play-dl');
const { spawn } = require('child_process');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const queues = new Map();
const PREFIX = '!';

play.getFreeClientID().then(id => play.setToken({ soundcloud: { client_id: id } })).catch(console.error);

client.once('ready', () => {
  console.log(`✅ Bot hazır: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'çal' || command === 'cal') {
    await playCommand(message, args);
  } else if (command === 'dur' || command === 'durdur') {
    stopCommand(message);
  } else if (command === 'atla' || command === 'skip') {
    skipCommand(message);
  } else if (command === 'kuyruk' || command === 'queue') {
    queueCommand(message);
  } else if (command === 'beklet' || command === 'pause') {
    pauseCommand(message);
  } else if (command === 'devam') {
    resumeCommand(message);
  } else if (command === 'yardım' || command === 'help') {
    helpCommand(message);
  }
});

async function playCommand(message, args) {
  if (!args.length) return message.reply('❌ Örnek: `!çal Tarkan Şımarık`');
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return message.reply('❌ Önce bir ses kanalına girmelisin!');

  const query = args.join(' ');
  const loadingMsg = await message.reply('🔍 SoundCloud\'da aranıyor...');

  try {
    const results = await play.search(query, { source: { soundcloud: 'tracks' }, limit: 1 });
    if (!results.length) return loadingMsg.edit('❌ Sonuç bulunamadı!');

    const track = results[0];
    const songInfo = {
      url: track.url,
      title: track.name,
      thumbnail: track.thumbnail,
      duration: formatDuration(track.durationInSec),
      requestedBy: message.author.username,
    };

    const serverQueue = queues.get(message.guild.id);
    if (!serverQueue) {
      const queueData = { textChannel: message.channel, voiceChannel, connection: null, player: null, songs: [songInfo] };
      queues.set(message.guild.id, queueData);
      await loadingMsg.edit({ content: '', embeds: [nowPlayingEmbed(songInfo)] });
      await startPlaying(message.guild.id, voiceChannel);
    } else {
      serverQueue.songs.push(songInfo);
      await loadingMsg.edit({ content: '', embeds: [queuedEmbed(songInfo, serverQueue.songs.length)] });
    }
  } catch (err) {
    console.error(err);
    loadingMsg.edit('❌ Hata: ' + err.message);
  }
}

async function startPlaying(guildId, voiceChannel) {
  const serverQueue = queues.get(guildId);
  if (!serverQueue || !serverQueue.songs.length) { queues.delete(guildId); return; }

  const song = serverQueue.songs[0];

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  const player = createAudioPlayer();
  serverQueue.connection = connection;
  serverQueue.player = player;
  connection.subscribe(player);

  try {
    const stream = await play.stream(song.url);

    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ]);

    stream.stream.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stderr.on('data', () => {});

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    player.play(resource);
    console.log('▶️ Çalıyor:', song.title);
  } catch (err) {
    console.error('Stream hatası:', err);
    serverQueue.textChannel.send('❌ Stream hatası: ' + err.message);
    serverQueue.songs.shift();
    startPlaying(guildId, voiceChannel);
    return;
  }

  player.on(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    if (serverQueue.songs.length > 0) {
      serverQueue.textChannel.send({ embeds: [nowPlayingEmbed(serverQueue.songs[0])] });
      startPlaying(guildId, voiceChannel);
    } else {
      serverQueue.textChannel.send('✅ Kuyruk bitti, görüşürüz! 👋');
      connection.destroy();
      queues.delete(guildId);
    }
  });

  player.on('error', (err) => {
    console.error('Player hatası:', err);
    serverQueue.textChannel.send('❌ Çalma hatası: ' + err.message);
    serverQueue.songs.shift();
    startPlaying(guildId, voiceChannel);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => { queues.delete(guildId); });
}

function stopCommand(message) {
  const q = queues.get(message.guild.id);
  if (!q) return message.reply('❌ Çalan bir şey yok!');
  q.songs = []; q.player?.stop(); q.connection?.destroy();
  queues.delete(message.guild.id);
  message.reply('⏹️ Durduruldu!');
}

function skipCommand(message) {
  const q = queues.get(message.guild.id);
  if (!q) return message.reply('❌ Çalan bir şey yok!');
  q.player?.stop();
  message.reply('⏭️ Atlandı!');
}

function pauseCommand(message) {
  const q = queues.get(message.guild.id);
  if (!q) return message.reply('❌ Çalan bir şey yok!');
  q.player?.pause();
  message.reply('⏸️ Bekletildi.');
}

function resumeCommand(message) {
  const q = queues.get(message.guild.id);
  if (!q) return message.reply('❌ Bekletilmiş bir şey yok!');
  q.player?.unpause();
  message.reply('▶️ Devam ediyor!');
}

function queueCommand(message) {
  const q = queues.get(message.guild.id);
  if (!q || !q.songs.length) return message.reply('📭 Kuyruk boş!');
  const list = q.songs.map((s, i) => `${i === 0 ? '▶️' : `${i}.`} **${s.title}** \`${s.duration}\``).join('\n');
  message.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🎵 Kuyruk').setDescription(list)] });
}

function helpCommand(message) {
  const embed = new EmbedBuilder().setColor('#4ECDC4').setTitle('🎵 Komutlar')
    .addFields(
      { name: '`!çal <şarkı>`', value: 'SoundCloud\'da şarkı çal' },
      { name: '`!dur`', value: 'Durdur' },
      { name: '`!atla`', value: 'Sonraki şarkı' },
      { name: '`!beklet`', value: 'Beklet' },
      { name: '`!devam`', value: 'Devam et' },
      { name: '`!kuyruk`', value: 'Kuyruğu göster' },
    );
  message.reply({ embeds: [embed] });
}

function nowPlayingEmbed(song) {
  return new EmbedBuilder().setColor('#FF6B6B').setTitle('🎵 Şu An Çalıyor')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
      { name: '👤 İsteyen', value: song.requestedBy, inline: true }
    )
    .setThumbnail(song.thumbnail || null)
    .setFooter({ text: 'Atlamak için !atla, durdurmak için !dur' });
}

function queuedEmbed(song, position) {
  return new EmbedBuilder().setColor('#4ECDC4').setTitle('✅ Kuyruğa Eklendi')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
      { name: '📋 Sıra', value: `#${position}`, inline: true }
    )
    .setThumbnail(song.thumbnail || null);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

client.login(process.env.DISCORD_TOKEN);
