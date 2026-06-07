require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// Her sunucu için ayrı kuyruk
const queues = new Map();

const PREFIX = '!';

client.once('ready', () => {
  console.log(`✅ Bot hazır: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Komutlar
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

// ─── !çal komutu ───────────────────────────────────────────────────
async function playCommand(message, args) {
  if (!args.length) {
    return message.reply('❌ Lütfen bir şarkı adı veya YouTube linki girin!\nÖrnek: `!çal Tarkan Şımarık`');
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    return message.reply('❌ Önce bir ses kanalına girmelisin!');
  }

  const query = args.join(' ');
  const loadingMsg = await message.reply('🔍 Aranıyor...');

  try {
    let videoUrl, videoTitle, videoThumbnail, videoDuration;

    // URL mi yoksa arama mı?
    if (ytdl.validateURL(query)) {
      const info = await ytdl.getInfo(query);
      videoUrl = query;
      videoTitle = info.videoDetails.title;
      videoThumbnail = info.videoDetails.thumbnails.slice(-1)[0]?.url;
      videoDuration = formatDuration(parseInt(info.videoDetails.lengthSeconds));
    } else {
      const searchResult = await ytSearch(query);
      const video = searchResult.videos[0];
      if (!video) {
        return loadingMsg.edit('❌ Sonuç bulunamadı!');
      }
      videoUrl = video.url;
      videoTitle = video.title;
      videoThumbnail = video.thumbnail;
      videoDuration = video.timestamp;
    }

    const serverQueue = queues.get(message.guild.id);

    const song = { url: videoUrl, title: videoTitle, thumbnail: videoThumbnail, duration: videoDuration, requestedBy: message.author.username };

    if (!serverQueue) {
      // Yeni kuyruk oluştur
      const queueData = {
        textChannel: message.channel,
        voiceChannel,
        connection: null,
        player: null,
        songs: [song],
        playing: true,
      };
      queues.set(message.guild.id, queueData);
      await loadingMsg.edit({ content: '', embeds: [nowPlayingEmbed(song)] });
      await startPlaying(message.guild.id, voiceChannel);
    } else {
      serverQueue.songs.push(song);
      await loadingMsg.edit({ content: '', embeds: [queuedEmbed(song, serverQueue.songs.length)] });
    }
  } catch (err) {
    console.error(err);
    loadingMsg.edit('❌ Bir hata oluştu: ' + err.message);
  }
}

// ─── Çalmayı başlat ────────────────────────────────────────────────
async function startPlaying(guildId, voiceChannel) {
  const serverQueue = queues.get(guildId);
  if (!serverQueue || !serverQueue.songs.length) {
    queues.delete(guildId);
    return;
  }

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

  const stream = ytdl(song.url, {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25,
  });

  const resource = createAudioResource(stream);
  player.play(resource);

  player.on(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    if (serverQueue.songs.length > 0) {
      const nextSong = serverQueue.songs[0];
      serverQueue.textChannel.send({ embeds: [nowPlayingEmbed(nextSong)] });
      startPlaying(guildId, voiceChannel);
    } else {
      serverQueue.textChannel.send('✅ Kuyruk bitti, görüşürüz! 👋');
      connection.destroy();
      queues.delete(guildId);
    }
  });

  player.on('error', (err) => {
    console.error('Player hatası:', err);
    serverQueue.textChannel.send('❌ Çalma sırasında hata oluştu!');
    serverQueue.songs.shift();
    startPlaying(guildId, voiceChannel);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    queues.delete(guildId);
  });
}

// ─── !dur komutu ───────────────────────────────────────────────────
function stopCommand(message) {
  const serverQueue = queues.get(message.guild.id);
  if (!serverQueue) return message.reply('❌ Şu anda çalan bir şey yok!');
  serverQueue.songs = [];
  serverQueue.player?.stop();
  serverQueue.connection?.destroy();
  queues.delete(message.guild.id);
  message.reply('⏹️ Müzik durduruldu ve kuyruk temizlendi.');
}

// ─── !atla komutu ──────────────────────────────────────────────────
function skipCommand(message) {
  const serverQueue = queues.get(message.guild.id);
  if (!serverQueue) return message.reply('❌ Şu anda çalan bir şey yok!');
  serverQueue.player?.stop();
  message.reply('⏭️ Atlandı!');
}

// ─── !beklet komutu ────────────────────────────────────────────────
function pauseCommand(message) {
  const serverQueue = queues.get(message.guild.id);
  if (!serverQueue) return message.reply('❌ Şu anda çalan bir şey yok!');
  serverQueue.player?.pause();
  message.reply('⏸️ Bekletildi. Devam ettirmek için `!devam` yaz.');
}

// ─── !devam komutu ─────────────────────────────────────────────────
function resumeCommand(message) {
  const serverQueue = queues.get(message.guild.id);
  if (!serverQueue) return message.reply('❌ Bekletilmiş bir şey yok!');
  serverQueue.player?.unpause();
  message.reply('▶️ Devam ediyor!');
}

// ─── !kuyruk komutu ────────────────────────────────────────────────
function queueCommand(message) {
  const serverQueue = queues.get(message.guild.id);
  if (!serverQueue || !serverQueue.songs.length) {
    return message.reply('📭 Kuyruk boş!');
  }

  const list = serverQueue.songs
    .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} **${s.title}** \`${s.duration}\` — *${s.requestedBy}*`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor('#FF6B6B')
    .setTitle('🎵 Müzik Kuyruğu')
    .setDescription(list.length > 4000 ? list.slice(0, 4000) + '...' : list)
    .setFooter({ text: `Toplam ${serverQueue.songs.length} şarkı` });

  message.reply({ embeds: [embed] });
}

// ─── !yardım komutu ────────────────────────────────────────────────
function helpCommand(message) {
  const embed = new EmbedBuilder()
    .setColor('#4ECDC4')
    .setTitle('🎵 Müzik Botu Komutları')
    .addFields(
      { name: '`!çal <şarkı adı veya link>`', value: 'Şarkı çal veya kuyruğa ekle' },
      { name: '`!dur`', value: 'Müziği durdur ve kuyruğu temizle' },
      { name: '`!atla`', value: 'Mevcut şarkıyı atla' },
      { name: '`!beklet`', value: 'Müziği beklet' },
      { name: '`!devam`', value: 'Bekletilmiş müziği devam ettir' },
      { name: '`!kuyruk`', value: 'Kuyruktaki şarkıları göster' },
      { name: '`!yardım`', value: 'Bu mesajı göster' },
    )
    .setFooter({ text: 'İyi dinlemeler! 🎧' });

  message.reply({ embeds: [embed] });
}

// ─── Yardımcı fonksiyonlar ─────────────────────────────────────────
function nowPlayingEmbed(song) {
  return new EmbedBuilder()
    .setColor('#FF6B6B')
    .setTitle('🎵 Şu An Çalıyor')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
      { name: '👤 İsteyen', value: song.requestedBy, inline: true },
    )
    .setThumbnail(song.thumbnail || null)
    .setFooter({ text: 'Atlamak için !atla, durdurmak için !dur' });
}

function queuedEmbed(song, position) {
  return new EmbedBuilder()
    .setColor('#4ECDC4')
    .setTitle('✅ Kuyruğa Eklendi')
    .setDescription(`**[${song.title}](${song.url})**`)
    .addFields(
      { name: '⏱️ Süre', value: song.duration || 'Bilinmiyor', inline: true },
      { name: '📋 Sıra', value: `#${position}`, inline: true },
    )
    .setThumbnail(song.thumbnail || null);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Bot'u başlat
client.login(process.env.DISCORD_TOKEN);
