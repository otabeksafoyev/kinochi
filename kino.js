const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const express = require('express');
const redis = require('redis');

// ======================
// SOZLAMALAR
// ======================
const TOKEN = "8385678349:AAEc_PDzfpP0fq2wv0jlDUfClXoxPRnISOM";
const MONGO_URL = "mongodb+srv://safootabekyev_db_user:kKjW0vqmvhPbPzk6@cluster0.pniaa23.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const UPLOAD_CHANNEL = "kinochidb";
const SUB_CHANNEL = "KInochi_ux";
const NEWS_CHANNEL = "KInochi_ux";
const ADMIN_IDS = [8173188671, 8248009618];
const ADMIN_USERNAME = "safoyev9225";
const PAYMENT_CHANNEL = "safoyev0_0";
const CARD_NUMBER = "5614 6829 1317 5461";

const bot = new TelegramBot(TOKEN, {
    polling: {
        interval: 500,
        timeout: 20,
        limit: 40,
        retry: true
    }
});

let BOT_USERNAME = 'Kinochi_uz_bot';



// Redis client — hardcode variant (test uchun)
const redisClient = redis.createClient({
    socket: {
        host: 'switchyard.proxy.rlwy.net',
        port: 10396
    },
    username: 'default',
    password: 'fYCBjBwRDAUtUqPKugiVtRcosGSrxhyU'
});

redisClient.on('error', err => console.error('Redis xatosi:', err));

// Redis ulanish
async function connectRedis() {
    if (!redisClient.isOpen) {
        await redisClient.connect();
        console.log('✅ Redis ulandi (hardcode bilan)');
    }
}





// MongoDB collections va global o'zgaruvchilar
let client;
let db;
let movies;
let parts;
let settings;
let banned_users;
let counters;
let premium_users;
let pending_payments;
let users;

let addMovieSession = {};
let pendingIdChange = {};
const requiredChannelsCache = [];
let bannedCache = new Set();

// Viloyatlar ro'yxati
const REGIONS = ["Andijon","Buxoro","Farg'ona","Jizzax","Namangan","Navoiy","Qashqadaryo","Qoraqalpog'iston Respublikasi","Samarqand","Sirdaryo","Surxondaryo","Toshkent shahri","Toshkent viloyati","Xorazm"];

// ======================
// CACHE MANAGEMENT
// ======================
async function loadCaches() {
    try {
        await connectRedis();

        let reklama = await redisClient.get('settings:reklama_caption');
        if (!reklama) {
            const doc = await settings.findOne({ key: "reklama_caption" });
            reklama = doc?.value || "Anime tomosha qilmoqchi bo‘lsangiz: 👉 @RimikAnime_bot";
            await redisClient.set('settings:reklama_caption', reklama, { EX: 900 });
        }

        let premium_prompt = await redisClient.get('settings:premium_prompt');
        if (!premium_prompt) {
            const doc = await settings.findOne({ key: "premium_prompt" });
            premium_prompt = doc?.value || "💎 Premium olsangiz, reklamasiz va yuklab olish imkoniyati bor!";
            await redisClient.set('settings:premium_prompt', premium_prompt, { EX: 900 });
        }

        let channelsJson = await redisClient.get('settings:required_channels');
        if (!channelsJson) {
            const chDoc = await settings.findOne({ key: "additional_channels" });
            const chList = [SUB_CHANNEL, ...(chDoc?.channels || [])];
            channelsJson = JSON.stringify(chList);
            await redisClient.set('settings:required_channels', channelsJson, { EX: 900 });
        }
        requiredChannelsCache.length = 0;
        requiredChannelsCache.push(...JSON.parse(channelsJson));

        const bannedIds = await redisClient.sMembers('banned_users');
        bannedCache.clear();
        bannedCache = new Set([...bannedIds].map(Number));

        if (bannedCache.size === 0) {
            const bannedDocs = await banned_users.find({}).project({ user_id: 1 }).toArray();
            const idsToAdd = bannedDocs.map(b => b.user_id.toString());
            if (idsToAdd.length > 0) {
                await redisClient.sAdd('banned_users', idsToAdd);
                bannedCache = new Set(bannedDocs.map(b => b.user_id));
            }
        }

        console.log(`Cache yangilandi: ${requiredChannelsCache.length} kanal, ${bannedCache.size} ban`);
    } catch (err) {
        console.error("Cache yangilashda xato:", err);
    }
}

async function refreshCachesPeriodically() {
    await loadCaches();
    setTimeout(refreshCachesPeriodically, 5 * 60 * 1000);
}

function get_required_channels() {
    return requiredChannelsCache;
}

// ======================
// MongoDB ulanish
// ======================
async function connectToMongo() {
    try {
        await connectRedis();

        client = await MongoClient.connect(MONGO_URL, {
            maxPoolSize: 50,
            minPoolSize: 5
        });
        console.log("✅ MongoDB ulandi");
        db = client.db("kino_bot");

        movies           = db.collection("movies");
        parts            = db.collection("parts");
        settings         = db.collection("settings");
        banned_users     = db.collection("banned_users");
        counters         = db.collection("counters");
        premium_users    = db.collection("premium_users");
        pending_payments = db.collection("pending_payments");
        users            = db.collection("users");

        await counters.updateOne(
            { _id: "movie_id" },
            { $setOnInsert: { seq: 99 } },
            { upsert: true }
        );

        await settings.updateOne(
            { key: "reklama_caption" },
            { $setOnInsert: { value: "Anime tomosha qilmoqchi bo‘lsangiz: 👉 @RimikAnime_bot" } },
            { upsert: true }
        );

        await settings.updateOne(
            { key: "premium_prompt" },
            { $setOnInsert: { value: "💎 Premium olsangiz, reklamasiz va yuklab olish imkoniyati bor!" } },
            { upsert: true }
        );

        await loadCaches();
        refreshCachesPeriodically();

    } catch (err) {
        console.error("❌ Ulanish xatosi:", err.message);
        process.exit(1);
    }
}

// 3 raqamli ID
async function getNextMovieId() {
    const result = await counters.findOneAndUpdate(
        { _id: "movie_id" },
        { $inc: { seq: 1 } },
        { returnDocument: "after", upsert: true }
    );
    return result.seq.toString().padStart(3, '0');
}

// ======================
// Subscription va holatni tekshirish
// ======================
async function get_user_required_channels(user_id) {
    let base = get_required_channels();

    const user = await users.findOne({ user_id });
    if (user?.region) {
        const doc = await settings.findOne({ key: "region_channels" });
        if (doc?.channels?.[user.region]) {
            base = base.concat(doc.channels[user.region]);
        }
    }

    return [...new Set(base)];
}

async function get_subscription_statuses(user_id) {
    const channels = await get_user_required_channels(user_id);
    const statuses = [];

    for (let ch of channels) {
        try {
            const member = await bot.getChatMember(`@${ch}`, user_id);
            statuses.push({
                channel: ch,
                subscribed: ['member', 'creator', 'administrator'].includes(member.status)
            });
        } catch {
            statuses.push({ channel: ch, subscribed: false });
        }
    }
    return statuses;
}

async function is_subscribed(user_id) {
    const premium = await is_premium(user_id);
    if (premium) return true;

    const statuses = await get_subscription_statuses(user_id);
    return statuses.every(s => s.subscribed);
}

async function is_banned(user_id) {
    const isBanned = await redisClient.sIsMember('banned_users', user_id.toString());
    if (isBanned) return true;

    const exists = await banned_users.findOne({ user_id });
    if (exists) {
        await redisClient.sAdd('banned_users', user_id.toString());
        bannedCache.add(user_id);
        return true;
    }
    return false;
}

async function is_premium(user_id) {
    let cached = await redisClient.get(`premium:${user_id}`);
    const now = new Date();

    if (cached) {
        const data = JSON.parse(cached);
        if (new Date(data.end_date) > now) return true;

        await redisClient.del(`premium:${user_id}`);
        await premium_users.deleteOne({ user_id });
        bot.sendMessage(user_id, "Obunangiz muddati tugadi, yana to'lov qiling!").catch(() => {});
        return false;
    }

    const doc = await premium_users.findOne({ user_id });
    if (!doc) return false;

    if (doc.end_date < now) {
        await premium_users.deleteOne({ user_id });
        bot.sendMessage(user_id, "Obunangiz muddati tugadi, yana to'lov qiling!").catch(() => {});
        return false;
    }

    await redisClient.set(`premium:${user_id}`, JSON.stringify({ end_date: doc.end_date.toISOString() }), { EX: 900 });
    return true;
}

async function check_subscription_and_proceed(chat_id, movie_id, part = 1, page = 1) {
    if (await is_banned(chat_id)) {
        return bot.sendMessage(chat_id, `🚫 Bloklangansiz. Admin: @${ADMIN_USERNAME}`);
    }

    const premium = await is_premium(chat_id);

    if (!premium && !(await is_subscribed(chat_id))) {
        const markup = { inline_keyboard: [] };
        const statuses = await get_subscription_statuses(chat_id);
        statuses.forEach(status => {
            const text = status.subscribed ? `✅ @${status.channel}` : `📢 @${status.channel}`;
            markup.inline_keyboard.push([{ text, url: status.subscribed ? undefined : `https://t.me/${status.channel}` }]);
        });
        markup.inline_keyboard.push([{ text: "✅ Tekshirish", callback_data: `check_sub_play_${movie_id}_${part}_${page}` }]);
        return bot.sendMessage(chat_id, "Film/serial ko‘rish uchun quyidagi kanallarga obuna bo‘ling:", { reply_markup: markup });
    }

    send_part(chat_id, movie_id, part, page, premium);
}

// ======================
// Bot ishga tushishi
// ======================
async function startBot() {
    await connectToMongo();

    try {
        const me = await bot.getMe();
        BOT_USERNAME = me.username;
        console.log(`Bot ishga tushdi: @${BOT_USERNAME}`);
    } catch (err) {
        console.error("Bot xatosi:", err);
        process.exit(1);
    }
}

// ======================
// Banner va /start
// ======================
async function send_start_banner(chat_id) {
    if (!movies) {
        return bot.sendMessage(chat_id, "Bot hali to'liq ishga tushmagan, biroz kuting...");
    }

    const total_movies = await movies.countDocuments({});
    const top_movie = await movies.findOne({}, { sort: { views: -1 }, limit: 1 }) || { title: "Hozircha kino yo‘q" };

    const banner_url = "https://i.postimg.cc/7PGZzTkC/Screenshot-2026-01-17-232030.png";

    const caption = `🎬 <b>@KinochiMovieBot</b> — eng sifatli filmlar va seriallar!\n\n` +
`🔥 Eng ko'p ko'rilgan: <b>${top_movie.title}</b>\n\n` +
`📺 Hozir tomosha qilamizmi? 👇`;

    const markup = {
        inline_keyboard: [
            [{ text: "🔍 Kino qidirish", switch_inline_query_current_chat: "" }],
            [{ text: "🎭 Janr bo‘yicha", callback_data: "genres_list" }, { text: "📢 Yangiliklar", callback_data: "news" }],
            [{ text: "🛠 Qanday ishlaydi?", callback_data: "how_it_works" }, { text: "💎 Premium olish", callback_data: "get_premium" }]
        ]
    };

    try {
        await bot.sendPhoto(chat_id, banner_url, { caption, parse_mode: "HTML", reply_markup: markup });
    } catch {
        await bot.sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: markup });
    }

    const enabledDoc = await settings.findOne({ key: "region_survey_enabled" });
    const enabled = enabledDoc?.value || false;
    if (enabled) {
        const user = await users.findOne({ user_id: chat_id });
        if (!user?.region) {
            await send_region_survey(chat_id);
        }
    }
}

function send_trailer_with_poster(chat_id, movie) {
    if (movie.poster_file_id) bot.sendPhoto(chat_id, movie.poster_file_id, { caption: `🎬 ${movie.title}` }).catch(() => {});
    if (movie.trailer) bot.sendVideo(chat_id, movie.trailer, { caption: `🎬 ${movie.title} (Treyler)` }).catch(() => {});
}

async function send_region_survey(chat_id) {
    const markup = { inline_keyboard: [] };

    for (let i = 0; i < REGIONS.length; i += 2) {
        const row = [];
        row.push({ text: REGIONS[i], callback_data: `set_region_${REGIONS[i]}` });
        if (REGIONS[i+1]) row.push({ text: REGIONS[i+1], callback_data: `set_region_${REGIONS[i+1]}` });
        markup.inline_keyboard.push(row);
    }

    bot.sendMessage(chat_id, "❓ Qaysi viloyatdan siz? Tanlang:", { reply_markup: markup });
}

// ======================
// Shunchaki ID yozilsa anime chiqarish (ENG ASOSIY QISM)
// ======================
bot.on('message', async (msg) => {
    // Admin bo'lsa oddiy xabarga javob bermaymiz
    if (ADMIN_IDS.includes(msg.from.id)) return;

    // Matn bo'lmasa → o'tkazib yuboramiz
    if (!msg.text) return;

    let payload = msg.text.trim();

    // Agar buyruq bo'lsa, lekin /start id shaklida bo'lsa, id ni ajratib olish
    if (payload.startsWith('/')) {
        if (payload.startsWith('/start ')) {
            // /start id ni faqat id ga o'zgartirish (deep link uchun)
            payload = payload.replace('/start ', '').trim();
        } else {
            // Boshqa buyruqlar uchun return
            return;
        }
    }

    if (payload.length < 1) return;

    let id = payload;
    let part = 1;

    // Agar qism raqami berilgan bo'lsa (masalan: violet_3)
    if (payload.includes('_')) {
        const parts = payload.split('_');
        id = parts[0].trim();
        part = parseInt(parts[1]) || 1;
    }

    const anime = await findAnime(id);
    if (!anime) {
        return bot.sendMessage(msg.chat.id, "❌ Bunday anime kodi topilmadi.");
    }

    if (await episodes.findOne({ serial_id: anime._id, part })) {
        await check_subscription_and_proceed(msg.chat.id, anime._id, part);
    } else if (await episodes.findOne({ serial_id: anime._id, part: 1 })) {
        await check_subscription_and_proceed(msg.chat.id, anime._id, 1);
    } else {
        send_trailer_with_poster(msg.chat.id, anime);
    }
});

// ======================
// /start (faqat banner chiqarish uchun, parametr siz)
// ======================
bot.onText(/\/start$/, async (msg) => {
    await send_start_banner(msg.chat.id);
});

// ======================
// Web App data
// ======================
bot.on('web_app_data', async (msg) => {
    try {
        const data = JSON.parse(msg.web_app_data.data);
        if (data.anime_id) {
            await check_subscription_and_proceed(msg.chat.id, data.anime_id, 1);
        } else if (data.action === "random") {
            const all_anime = await serials.find().toArray();
            if (all_anime.length) {
                const anime = all_anime[Math.floor(Math.random() * all_anime.length)];
                await check_subscription_and_proceed(msg.chat.id, anime._id, 1);
            }
        }
    } catch {
        bot.sendMessage(msg.chat.id, "❌ Web App ma'lumotida xato");
    }
});

// ======================
// Callback query
// ======================
bot.on('callback_query', async (query) => {
    bot.answerCallbackQuery(query.id);

    const chat_id = query.message.chat.id;

    if (query.data.startsWith("set_region_")) {
        const region = query.data.replace("set_region_", "");
        if (REGIONS.includes(region)) {
            await users.updateOne({ user_id: query.from.id }, { $set: { region } });
            bot.sendMessage(chat_id, `Rahmat! Siz ${region} ni tanladingiz.`);
            try { await bot.deleteMessage(chat_id, query.message.message_id); } catch {}
        }
        return;
    }

    if (query.data === "genres_list") {
        const markup = {
            inline_keyboard: [
                [{ text: "🔥 Action", callback_data: "genre_Action" }, { text: "⚔️ Adventure", callback_data: "genre_Adventure" }],
                [{ text: "😂 Comedy", callback_data: "genre_Comedy" }, { text: "😢 Drama", callback_data: "genre_Drama" }],
                [{ text: "🧙 Fantasy", callback_data: "genre_Fantasy" }, { text: "💕 Romance", callback_data: "genre_Romance" }],
                [{ text: "🚀 Sci-Fi", callback_data: "genre_Sci-Fi" }, { text: "👊 Shounen", callback_data: "genre_Shounen" }],
                [{ text: "☀️ Slice of Life", callback_data: "genre_Slice of Life" }],
                [{ text: "🔙 Orqaga", callback_data: "back_to_start" }]
            ]
        };

        bot.sendMessage(chat_id, "🎭 <b>Janrni tanlang:</b>\n\nTanlaganingizdan keyin shu janrdagi animelar ro‘yxati chiqadi!", { parse_mode: "HTML", reply_markup: markup });
    } else if (query.data.startsWith("genre_")) {
        const genre = query.data.replace("genre_", "");
        const anime_list = await serials.find({ genres: { $regex: genre, $options: "i" } }).limit(20).toArray();

        if (anime_list.length === 0) {
            bot.sendMessage(chat_id, `❌ "${genre}" janrida anime topilmadi.`, {
                reply_markup: { inline_keyboard: [[{ text: "🔙 Janrlarga qaytish", callback_data: "genres_list" }]] }
            });
            return;
        }

        let text = `🎭 <b>${genre}</b> janridagi animelar (${anime_list.length} ta):\n\n`;
        const markup = { inline_keyboard: [] };

        const anime_ids = anime_list.map(a => a._id);
        const first_episodes = await episodes.find({ serial_id: { $in: anime_ids }, part: 1 }).toArray();
        const has_first_map = new Map(first_episodes.map(ep => [ep.serial_id, true]));

        for (let anime of anime_list) {
            const has_episode = has_first_map.has(anime._id);
            const button_text = has_episode ? "▶️ Tomosha qilish" : "📺 Treyler";
            markup.inline_keyboard.push([{
                text: `${button_text} ${anime.title}`,
                url: `https://t.me/${BOT_USERNAME}?start=${anime.custom_id || anime._id}`
            }]);
        }

        markup.inline_keyboard.push([
            { text: "🔙 Janrlarga qaytish", callback_data: "genres_list" },
            { text: "🏠 Bosh menyuga", callback_data: "back_to_start" }
        ]);

        bot.sendMessage(chat_id, text, { parse_mode: "HTML", reply_markup: markup });
    } else if (query.data === "back_to_start") {
        await send_start_banner(chat_id);
    } else if (query.data === "news") {
        bot.sendMessage(chat_id, `📢 Yangiliklar uchun kanalimiz: @${NEWS_CHANNEL}`, {
            reply_markup: { inline_keyboard: [[{ text: "📢 Kanalga o'tish", url: `https://t.me/${NEWS_CHANNEL}` }]] }
        });
    } else if (query.data === "how_it_works") {
        const text = (
            "🧠 <b>Bot qanday ishlaydi?</b>\n\n" +
            "1. Oddiy xabarga anime kodini yozing (masalan: naruto, 85)\n" +
            "2. 🎭 Janr bo‘yicha tugmasidan janr tanlang\n" +
            "3. Majburiy kanallarga obuna bo'ling\n" +
            "4. Qismlarni ketma-ket tomosha qiling\n" +
            "5. Har bir qism uchun darajangiz oshadi 🏆\n\n" +
            "Rahmat foydalanganingiz uchun! ❤️"
        );
        bot.sendMessage(chat_id, text, { parse_mode: "HTML" });
    } else if (query.data === "my_level") {
        const user = await users.findOne({ user_id: query.from.id });
        const watched = user?.watched_episodes || 0;
        const { level, badge } = get_level_and_badge(watched);
        const badge_url = BADGE_URLS[badge];

        const caption = (
            `🏆 <b>Sizning darajangiz</b>\n\n` +
            `Ko‘rilgan qismlar: <b>${watched}</b>\n` +
            `Daraja: <b>${level}</b>\n\n` +
            "Yana ko'proq tomosha qiling va keyingi badge'ni oling! 🔥"
        );

        try {
            await bot.sendPhoto(chat_id, badge_url, { caption, parse_mode: "HTML" });
        } catch {
            await bot.sendMessage(chat_id, caption, { parse_mode: "HTML" });
        }
    } else if (query.data.startsWith("check_sub_play_")) {
        const parts = query.data.split("_");
        const serial_id = parts[3];
        const part = parseInt(parts[4]);
        await check_subscription_and_proceed(chat_id, serial_id, part);
    } else if (query.data.startsWith("play_")) {
        const [, serial_id, part] = query.data.split("_");
        await check_subscription_and_proceed(chat_id, serial_id, parseInt(part));
    }
});

// ======================
// Inline query
// ======================
bot.on('inline_query', async (query) => {
    const results = [];
    const q = query.query.toLowerCase();
    let anime_list = [];
    if (q.length > 0) {
        anime_list = await serials.find({ title: { $regex: q, $options: "i" } }).limit(20).toArray();
    } else {
        anime_list = await serials.find().sort({ views: -1 }).limit(50).toArray();
    }

    const anime_ids = anime_list.map(a => a._id);
    const first_episodes = await episodes.find({ serial_id: { $in: anime_ids }, part: 1 }).toArray();
    const has_first_map = new Map(first_episodes.map(ep => [ep.serial_id, true]));

    for (let anime of anime_list) {
        const has_first = has_first_map.has(anime._id);
        const button_text = has_first ? "▶️ Tomosha qilish" : "📺 Treyler";
        const url = `https://t.me/${BOT_USERNAME}?start=${anime.custom_id || anime._id}`;
        const is_top = q.length === 0;
        results.push({
            type: 'article',
            id: is_top ? `top_${anime._id}` : anime._id,
            title: anime.title,
            description: is_top ? `🔥 Mashhur • ${anime.genres || 'N/A'} • 👁 ${anime.views || 0}` : `${anime.genres || ''} • ${anime.total} qism • 👁 ${anime.views || 0}`,
            thumb_url: "https://i.postimg.cc/NjS4n3Q4/photo-2026-01-05-15-35-26.jpg",
            input_message_content: { message_text: `${is_top ? '🔥' : '🎬'} ${anime.title}\n🎭 Janr: ${anime.genres || 'N/A'}\n📦 Qismlar: ${anime.total}\n👁 Ko‘rilgan: ${anime.views || 0}\nKod: ${anime.custom_id || anime._id}` },
            reply_markup: { inline_keyboard: [[{ text: button_text, url }]] }
        });
    }

    bot.answerInlineQuery(query.id, results, { cache_time: q.length > 0 ? 1 : 300 });
});

// ======================
// Episode jo‘natish
// ======================
async function send_episode(chat_id, serial_id, part = 1) {
    const anime = await serials.findOne({ _id: serial_id });
    const episode = await episodes.findOne({ serial_id, part });
    if (!episode) {
        bot.sendMessage(chat_id, "❌ Bu qism hali yuklanmagan");
        return;
    }

    await serials.updateOne({ _id: serial_id }, { $inc: { views: 1 } });
    await users.updateOne({ user_id: chat_id }, { $inc: { watched_episodes: 1 } });

    const markup = { inline_keyboard: [] };
    const total_parts = anime.total;
    const PAGE_SIZE = 50;
    const BUTTONS_PER_ROW = 5;

    let start, end;
    if (total_parts <= PAGE_SIZE) {
        start = 1;
        end = total_parts + 1;
    } else {
        const current_page = Math.ceil(part / PAGE_SIZE);
        start = (current_page - 1) * PAGE_SIZE + 1;
        end = Math.min(start + PAGE_SIZE, total_parts + 1);
    }

    const existing_parts_docs = await episodes.find({ serial_id, part: { $gte: start, $lt: end } }).project({ part: 1 }).toArray();
    const existing_parts = new Set(existing_parts_docs.map(doc => doc.part));

    const buttons = [];
    for (let p = start; p < end; p++) {
        const exists = existing_parts.has(p);
        const label = p === part ? `▶️ ${p}` : (exists ? `${p}` : `${p} ⚠️`);
        buttons.push({ text: label, callback_data: exists ? `play_${serial_id}_${p}` : "none" });
    }

    while (buttons.length > 0) {
        markup.inline_keyboard.push(buttons.splice(0, BUTTONS_PER_ROW));
    }

    const nav = [];
    if (start > 1) {
        nav.push({ text: "◀️ Orqaga", callback_data: `play_${serial_id}_${start - PAGE_SIZE}` });
    }
    if (end <= total_parts) {
        nav.push({ text: "Keyingi ▶️", callback_data: `play_${serial_id}_${end}` });
    }
    if (nav.length) {
        markup.inline_keyboard.push(nav);
    }

    bot.sendVideo(chat_id, episode.file_id, { caption: `${anime.title} — ${part}-qism`, reply_markup: markup });
}

// ======================
// ADMIN BUYRUQLARI (HAMMASI)
// ======================

bot.onText(/\/resendtrailer(?:\s+(.+))?/, async (msg, match) => {
    if (!is_admin(msg.from.id)) return;

    const sid = match[1]?.trim();
    if (!sid) return bot.sendMessage(msg.chat.id, "❌ Foydalanish: /resendtrailer <anime_id>");

    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) return bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");

    if (!anime.trailer) return bot.sendMessage(msg.chat.id, `❌ ${anime.title} treyleri mavjud emas`);

    await send_anime_card(msg.chat.id, anime._id);
    try { await send_anime_card(`@${SUB_CHANNEL}`, anime._id); } catch {}

    bot.sendMessage(msg.chat.id, `✅ ${anime.title} treyleri yuborildi`);
});

async function send_anime_card(chat_id, serial_id) {
    const anime = await serials.findOne({ _id: serial_id });
    if (!anime) return;

    const markup = {
        inline_keyboard: [[{ text: "🧧 Ko‘rish", url: `https://t.me/${BOT_USERNAME}?start=${anime.custom_id || anime._id}` }]]
    };

    const caption = `
🎌 <b>Yangi Anime Qo‘shildi!</b> 🎌

🎬 <b>Nomi:</b> ${anime.title}
📦 <b>Qismlar soni:</b> ${anime.total}
🎭 <b>Janr:</b> ${anime.genres}
🆔 <b>Anime kodi:</b> <code>${anime.custom_id}</code>

❤️ Rimika Uz bilan birga tomosha qiling!
    `.trim();

    await bot.sendVideo(chat_id, anime.trailer, {
        caption,
        reply_markup: markup,
        parse_mode: "HTML"
    });
}

// Treylerni o'zgartirish
bot.onText(/\/changetrailer(?:\s+(.+))?/, async (msg, match) => {
    if (!is_admin(msg.from.id)) return;
    const sid = match[1]?.trim();
    if (!sid) return bot.sendMessage(msg.chat.id, "Foydalanish: /changetrailer <anime_id>");
    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) return bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");
    bot.sendMessage(msg.chat.id, `Yangi treyler videoni yuboring (${anime.title} uchun):`);
    bot.once('video', async (videoMsg) => {
        if (videoMsg.from.id !== msg.from.id) return;
        await serials.updateOne({ _id: anime._id }, { $set: { trailer: videoMsg.video.file_id } });
        bot.sendMessage(msg.chat.id, `✅ ${anime.title} treyleri yangilandi!`);
        try { await send_anime_card(`@${SUB_CHANNEL}`, anime._id); } catch {}
    });
});

// Poster qo'shish
bot.onText(/\/addposter(?:\s+(.+))?/, async (msg, match) => {
    if (!is_admin(msg.from.id)) return;
    const sid = match[1]?.trim();
    if (!sid) return bot.sendMessage(msg.chat.id, "Foydalanish: /addposter <anime_id>");
    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) return bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");
    bot.sendMessage(msg.chat.id, `Poster rasmni yuboring (${anime.title} uchun):`);
    bot.once('photo', async (photoMsg) => {
        if (photoMsg.from.id !== msg.from.id) return;
        const file_id = photoMsg.photo[photoMsg.photo.length - 1].file_id;
        await serials.updateOne({ _id: anime._id }, { $set: { poster_file_id: file_id } });
        bot.sendMessage(msg.chat.id, `✅ ${anime.title} poster qo‘shildi/yangilandi!`);
    });
});

// Anime ma'lumotlari
bot.onText(/\/animeinfo(?:\s+(.+))?/, async (msg, match) => {
    if (!is_admin(msg.from.id)) return;
    const sid = match[1]?.trim();
    if (!sid) return bot.sendMessage(msg.chat.id, "Foydalanish: /animeinfo <anime_id>");
    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) return bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");
    const epsCount = await episodes.countDocuments({ serial_id: anime._id });
    const text = `
🎬 <b>Anime Ma'lumotlari</b>

<b>Nom:</b> ${anime.title}
<b>Anime kodi:</b> <code>${anime.custom_id}</code>
<b>Internal ID:</b> <code>${anime._id}</code>
<b>Umumiy qismlar:</b> ${anime.total}
<b>Yuklangan qismlar:</b> ${epsCount}
<b>Janrlar:</b> ${anime.genres || 'Yo‘q'}
<b>Ko‘rishlar:</b> ${anime.views || 0}
    `.trim();
    bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// Anime ro'yxati
bot.onText(/\/animelist/, async (msg) => {
    if (!is_admin(msg.from.id)) return;
    const all = await serials.find().sort({ title: 1 }).toArray();
    if (all.length === 0) return bot.sendMessage(msg.chat.id, "❌ Hozircha anime yo‘q");

    const episode_counts = await episodes.aggregate([
        { $group: { _id: "$serial_id", count: { $sum: 1 } } }
    ]).toArray();
    const serial_counts = new Map(episode_counts.map(c => [c._id, c.count]));

    let text = `<b>📋 Anime Ro‘yxati (${all.length} ta)</b>\n\n`;
    for (let a of all) {
        const eps = serial_counts.get(a._id) || 0;
        text += `<b>${a.title}</b>\nKod: ${a.custom_id || 'yo‘q'} | ${eps}/${a.total} qism\n\n`;
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// Adminlar ro'yxati
bot.onText(/\/adminlist/, (msg) => {
    if (!is_admin(msg.from.id)) return;
    const list = ADMIN_IDS.map(id => `• <code>${id}</code>`).join("\n");
    bot.sendMessage(msg.chat.id, `<b>👑 Adminlar:</b>\n${list}`, { parse_mode: "HTML" });
});

// Qism o'chirish
bot.onText(/\/deletepart(?:\s+(.+))\s+(\d+)/, async (msg, match) => {
    if (!is_admin(msg.from.id)) return;
    const sid = match[1]?.trim();
    const part = parseInt(match[2]);
    if (!sid || isNaN(part)) return bot.sendMessage(msg.chat.id, "Foydalanish: /deletepart <anime_id> <qism>");
    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) return bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");
    const result = await episodes.deleteOne({ serial_id: anime._id, part });
    if (result.deletedCount > 0) {
        bot.sendMessage(msg.chat.id, `✅ ${anime.title} — ${part}-qism o‘chirildi`);
    } else {
        bot.sendMessage(msg.chat.id, "❌ Bu qism topilmadi");
    }
});

// Ko'rishlar sonini nolga tushirish
bot.onText(/\/resetviews(?:\s+(.+))?/, async (msg, match) => {
    if (!is_admin(msg.from.id)) return;
    const sid = match[1]?.trim();
    if (!sid) return bot.sendMessage(msg.chat.id, "Foydalanish: /resetviews <anime_id>");
    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) return bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");
    await serials.updateOne({ _id: anime._id }, { $set: { views: 0 } });
    bot.sendMessage(msg.chat.id, `✅ ${anime.title} ko‘rishlar soni 0 ga tushirildi`);
});

// Statistika
bot.onText(/\/stats/, async (msg) => {
    if (!is_admin(msg.from.id)) return;
    const total_users = await users.countDocuments({});
    const total_anime = await serials.countDocuments({});
    const total_episodes = await episodes.countDocuments({});
    const total_views = (await serials.aggregate([{ $group: { _id: null, total: { $sum: "$views" } } }]).toArray())[0]?.total || 0;
    const top5 = await serials.find().sort({ views: -1 }).limit(5).toArray();

    let text = (
        "📊 <b>Bot Statistika</b>\n\n" +
        `👥 Foydalanuvchilar: <b>${total_users}</b>\n` +
        `🎬 Anime soni: <b>${total_anime}</b>\n` +
        `📼 Qismlar soni: <b>${total_episodes}</b>\n` +
        `👁 Jami ko‘rishlar: <b>${total_views}</b>\n\n` +
        "<b>🔥 Top 5 anime:</b>\n"
    );
    top5.forEach((a, i) => {
        text += `${i + 1}. ${a.title} — ${a.views || 0} ko‘rish\n`;
    });

    const regionCounts = await users.aggregate([{ $group: { _id: "$region", count: { $sum: 1 } } }]).toArray();
    const unanswered = await users.countDocuments({ region: { $exists: false } });
    text += "\n<b>Viloyatlar bo'yicha:</b>\n";
    regionCounts.forEach(rc => {
        text += `${rc._id || "Noma'lum"}: ${rc.count}\n`;
    });
    text += `Javob bermagan: ${unanswered}\n`;

    bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// Anime o'chirish
bot.onText(/\/deleteanime/, (msg) => {
    if (!is_admin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, "🗑 O‘chiriladigan anime ID:").then(() => {
        bot.once('message', async (response) => {
            const sid = response.text.trim();
            const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
            if (!anime) {
                bot.sendMessage(response.chat.id, "❌ Topilmadi");
                return;
            }
            await serials.deleteOne({ _id: anime._id });
            await episodes.deleteMany({ serial_id: anime._id });
            bot.sendMessage(response.chat.id, `✅ ${anime.title} o‘chirildi`);
        });
    });
});

// Anime tahrirlash
bot.onText(/\/editanime/, (msg) => {
    if (!is_admin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, "✏️ Tahrirlanadigan anime ID:").then(() => {
        bot.once('message', async (response) => {
            const sid = response.text.trim();
            const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
            if (!anime) {
                bot.sendMessage(response.chat.id, "❌ Topilmadi");
                return;
            }
            const context = { sid: anime._id, chatId: response.chat.id };
            bot.sendMessage(response.chat.id, `Joriy nom: ${anime.title}\nYangi nom (/skip):`).then(() => {
                bot.once('message', (res) => edit_title(res, context));
            });
        });
    });
});

async function edit_title(msg, ctx) {
    if (msg.text !== "/skip") {
        await serials.updateOne({ _id: ctx.sid }, { $set: { title: msg.text } });
    }
    bot.sendMessage(ctx.chatId, "Yangi qismlar soni (/skip):").then(() => {
        bot.once('message', (res) => edit_total(res, ctx));
    });
}

async function edit_total(msg, ctx) {
    if (msg.text !== "/skip") {
        try {
            const total = parseInt(msg.text);
            await serials.updateOne({ _id: ctx.sid }, { $set: { total } });
        } catch {}
    }
    bot.sendMessage(ctx.chatId, "Yangi janrlar (/skip):").then(() => {
        bot.once('message', (res) => edit_genres(res, ctx));
    });
}

async function edit_genres(msg, ctx) {
    if (msg.text !== "/skip") {
        await serials.updateOne({ _id: ctx.sid }, { $set: { genres: msg.text } });
    }
    bot.sendMessage(ctx.chatId, "✅ Yangilandi!");
}

// Qism yuklash (admin video yuborsa va caption /uploadpart bo‘lsa)
bot.on('video', async (msg) => {
    if (is_admin(msg.from.id) && msg.caption && msg.caption.trim().toLowerCase() === "/uploadpart") {
        bot.replyToMessage(msg.chat.id, msg.message_id, "Video qabul qilindi! Anime ID yuboring:").then(() => {
            bot.once('message', (res) => upload_part_id(res, msg.video.file_id));
        });
    }
});

async function upload_part_id(msg, file_id) {
    const sid = msg.text.trim();
    const anime = await serials.findOne({ $or: [{ _id: sid }, { custom_id: sid }] });
    if (!anime) {
        bot.sendMessage(msg.chat.id, "❌ Anime topilmadi");
        return;
    }
    const context = { sid: anime._id, file_id: file_id, chatId: msg.chat.id };
    bot.sendMessage(msg.chat.id, "Qism raqami:").then(() => {
        bot.once('message', (res) => upload_part_num(res, context));
    });
}

async function upload_part_num(msg, ctx) {
    try {
        const part = parseInt(msg.text);
        await episodes.updateOne(
            { serial_id: ctx.sid, part },
            { $set: { file_id: ctx.file_id } },
            { upsert: true }
        );
        bot.sendMessage(ctx.chatId, `✅ ${ctx.sid} — ${part}-qism saqlandi`);
    } catch {
        bot.sendMessage(ctx.chatId, "❌ Raqam kiriting");
    }
}

// Ban / Unban
bot.onText(/\/ban/, async (msg) => {
    if (!is_admin(msg.from.id)) return;
    try {
        const uid = parseInt(msg.text.split(' ')[1]);
        await banned_users.updateOne({ user_id: uid }, { $set: { user_id: uid } }, { upsert: true });
        bot.sendMessage(msg.chat.id, `🚫 ${uid} bloklandi`);
    } catch {
        bot.sendMessage(msg.chat.id, "Foydalanish: /ban <user_id>");
    }
});

bot.onText(/\/unban/, async (msg) => {
    if (!is_admin(msg.from.id)) return;
    try {
        const uid = parseInt(msg.text.split(' ')[1]);
        await banned_users.deleteOne({ user_id: uid });
        bot.sendMessage(msg.chat.id, `✅ ${uid} blokdan chiqdi`);
    } catch {
        bot.sendMessage(msg.chat.id, "Foydalanish: /unban <user_id>");
    }
});

// About
bot.onText(/\/about/, (msg) => {
    const text = (
        "🤖 <b>Rimika Anime Bot</b>\n" +
        `📌 Versiya: <b>${BOT_VERSION}</b>\n` +
        `👨‍💻 Yaratuvchi: @${ADMIN_USERNAME}\n\n` +
        "Anime qidirish, ketma-ket tomosha bilan!"
    );
    bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// Elon (ommaga xabar)
bot.onText(/\/addelon/, (msg) => {
    if (!is_admin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, "📢 Rasm yuboring (yo‘q bo‘lsa /skip):").then(() => {
        bot.once('message', (res) => add_elon_photo(res));
    });
});

async function add_elon_photo(msg) {
    const ctx = { chatId: msg.chat.id };
    if (msg.photo) {
        ctx.photo = msg.photo[msg.photo.length - 1].file_id;
        bot.sendMessage(ctx.chatId, "Matnni yozing:").then(() => {
            bot.once('message', (res) => add_elon_text(res, ctx));
        });
    } else if (msg.text === "/skip") {
        ctx.photo = null;
        bot.sendMessage(ctx.chatId, "Matnni yozing:").then(() => {
            bot.once('message', (res) => add_elon_text(res, ctx));
        });
    } else {
        bot.sendMessage(ctx.chatId, "❌ Rasm yoki /skip");
    }
}

async function add_elon_text(msg, ctx) {
    const text = msg.text;
    let sent = 0;
    const cursor = users.find();
    for await (const user of cursor) {
        try {
            if (ctx.photo) {
                await bot.sendPhoto(user.user_id, ctx.photo, { caption: text, parse_mode: "HTML" });
            } else {
                await bot.sendMessage(user.user_id, text, { parse_mode: "HTML" });
            }
            sent++;
        } catch {}
    }
    bot.sendMessage(ctx.chatId, `✅ ${sent} ta foydalanuvchiga yuborildi`);
}

// Kanal boshqaruvi
bot.onText(/\/(addchannel|removechannel|listchannels)/, async (msg) => {
    if (!is_admin(msg.from.id)) return;
    const cmd = msg.text.split(' ')[0];
    if (cmd === "/addchannel") {
        bot.sendMessage(msg.chat.id, "Yangi kanal username:").then(() => {
            bot.once('message', (res) => add_channel(res));
        });
    } else if (cmd === "/removechannel") {
        bot.sendMessage(msg.chat.id, "O‘chiriladigan kanal username:").then(() => {
            bot.once('message', (res) => remove_channel(res));
        });
    } else if (cmd === "/listchannels") {
        const channels = get_required_channels();
        const text = "📋 Majburiy kanallar:\n" + channels.map(c => `• @${c}`).join("\n");
        bot.sendMessage(msg.chat.id, text);
    }
});

async function add_channel(msg) {
    const ch = msg.text.trim().replace(/^@/, '');
    await settings.updateOne({ key: "additional_channels" }, { $addToSet: { channels: ch } }, { upsert: true });
    await update_required_channels();
    bot.sendMessage(msg.chat.id, `✅ @${ch} qo‘shildi`);
}

async function remove_channel(msg) {
    const ch = msg.text.trim().replace(/^@/, '');
    const result = await settings.updateOne({ key: "additional_channels" }, { $pull: { channels: ch } });
    await update_required_channels();
    bot.sendMessage(msg.chat.id, result.modifiedCount ? "✅ O‘chirildi" : "❌ Topilmadi");
}

// ======================
// Anime qo'shish
// ======================
bot.onText(/\/addanime/, (msg) => {
    if (!is_admin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, "Anime nomini yozing:").then(() => {
        bot.once('message', (res) => step_title(res));
    });
});

async function step_title(msg) {
    const data = { title: msg.text };
    bot.sendMessage(msg.chat.id, "Nechta qismi bor?").then(() => {
        bot.once('message', (res) => step_total(res, data));
    });
}

async function step_total(msg, data) {
    try {
        data.total = parseInt(msg.text);
    } catch {
        data.total = 1;
    }
    bot.sendMessage(msg.chat.id, "Janrlarini yozing:").then(() => {
        bot.once('message', (res) => step_genres(res, data));
    });
}

async function step_genres(msg, data) {
    data.genres = msg.text;
    bot.sendMessage(msg.chat.id, "Custom ID kiriting (masalan: naruto, one-piece, deathnote):").then(() => {
        bot.once('message', (res) => step_custom_id(res, data));
    });
}

async function step_custom_id(msg, data) {
    data.custom_id = msg.text.trim();
    bot.sendMessage(msg.chat.id, "Treyler videoni yuboring:").then(() => {
        bot.once('message', (res) => save_trailer(res, data));
    });
}

async function save_trailer(msg, data) {
    if (!msg.video) {
        bot.sendMessage(msg.chat.id, "❌ Video yuboring!");
        return;
    }

    const internal_id = uuidv4();

    await serials.insertOne({
        _id: internal_id,
        custom_id: data.custom_id,
        title: data.title,
        total: data.total,
        genres: data.genres,
        trailer: msg.video.file_id,
        poster_file_id: null,
        views: 0
    });

    await send_anime_card(msg.chat.id, internal_id);

    bot.sendMessage(msg.chat.id, `✅ Anime qo‘shildi!\n\nInternal ID: ${internal_id}\nCustom ID: ${data.custom_id}`);
}

async function send_anime_card(chat_id, serial_id) {
    const anime = await serials.findOne({ _id: serial_id });
    if (!anime) return;

    const markup = {
        inline_keyboard: [[{ text: "🧧 Ko‘rish", url: `https://t.me/${BOT_USERNAME}?start=${anime.custom_id || anime._id}` }]]
    };

    const caption = `
🎌 <b>Yangi Anime Qo‘shildi!</b> 🎌

🎬 <b>Nomi:</b> ${anime.title}
📦 <b>Qismlar soni:</b> ${anime.total}
🎭 <b>Janr:</b> ${anime.genres}
🆔 <b>Anime kodi:</b> <code>${anime.custom_id}</code>

❤️ Rimika Uz bilan birga tomosha qiling!
    `.trim();

    await bot.sendVideo(chat_id, anime.trailer, {
        caption,
        reply_markup: markup,
        parse_mode: "HTML"
    });
}

// ======================
// Kanalga qism yuklash
// ======================
bot.on('channel_post', async (msg) => {
    if (msg.chat.username !== UPLOAD_CHANNEL || !msg.video || !msg.caption) return;

    let serial_id = null;
    let part = null;
    for (let line of msg.caption.split("\n")) {
        if (line.toLowerCase().startsWith("id:")) {
            serial_id = line.split(":", 2)[1].trim();
        }
        if (line.toLowerCase().startsWith("qism:")) {
            try {
                part = parseInt(line.split(":", 2)[1].trim());
            } catch {}
        }
    }

    if (serial_id && part) {
        const anime = await serials.findOne({ $or: [{ _id: serial_id }, { custom_id: serial_id }] });
        if (anime) {
            await episodes.updateOne(
                { serial_id: anime._id, part },
                { $set: { file_id: msg.video.file_id } },
                { upsert: true }
            );
            bot.sendMessage(ADMIN_IDS[0], `✅ ${anime.title} — ${part}-qism saqlandi!`);
        }
    }
});

// ======================
// Express server
// ======================
const app = express();

app.get("/", (req, res) => {
    res.status(200).send("Anime Bot ishlayapti ✨");
});

app.listen(5000);

// Botni ishga tushiramiz
startBot(); 