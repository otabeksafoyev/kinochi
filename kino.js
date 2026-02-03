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
const CARD_NUMBER = "8600 1234 5678 9012";

const bot = new TelegramBot(TOKEN, {
    polling: {
        interval: 500,
        timeout: 20,
        limit: 40,
        retry: true
    }
});

let BOT_USERNAME = 'Kinochi_uz_bot';

// Redis client
const redisClient = redis.createClient({
    url: 'redis://localhost:6379'
});

redisClient.on('error', err => console.error('Redis xatosi:', err));

// Redis ulanish
async function connectRedis() {
    if (!redisClient.isOpen) {
        await redisClient.connect();
        console.log('✅ Redis ulandi');
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
async function is_subscribed(user_id) {
    if (requiredChannelsCache.length === 0) return true;

    const checks = requiredChannelsCache.map(async (ch) => {
        try {
            const member = await bot.getChatMember(`@${ch}`, user_id);
            return ['member', 'creator', 'administrator'].includes(member.status);
        } catch {
            return false;
        }
    });

    const results = await Promise.all(checks);
    return results.every(Boolean);
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
        get_required_channels().forEach(ch => {
            markup.inline_keyboard.push([{ text: `📢 @${ch}`, url: `https://t.me/${ch}` }]);
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
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (users) {
        await users.updateOne({ user_id: chatId }, { $set: { user_id: chatId } }, { upsert: true });
    }

    const args = msg.text.split(' ');
    if (args.length > 1) {
        const movie_id = args[1].trim().padStart(3, '0');
        if (!movies) return bot.sendMessage(chatId, "Bot hali ulanmagan, biroz kuting...");
        const movie = await movies.findOne({ _id: movie_id });
        if (movie) {
            if (await parts.findOne({ movie_id, part: 1 })) {
                await check_subscription_and_proceed(chatId, movie_id, 1);
            } else {
                send_trailer_with_poster(chatId, movie);
            }
        } else {
            bot.sendMessage(chatId, "Bunday ID bilan kino topilmadi");
        }
        return;
    }

    await send_start_banner(chatId);
});

function send_trailer_with_poster(chat_id, movie) {
    if (movie.poster_file_id) bot.sendPhoto(chat_id, movie.poster_file_id, { caption: `🎬 ${movie.title}` }).catch(() => {});
    if (movie.trailer) bot.sendVideo(chat_id, movie.trailer, { caption: `🎬 ${movie.title} (Treyler)` }).catch(() => {});
}

// ======================
// Oddiy raqam yozsa kino chiqarish
// ======================
bot.on('text', async (msg) => {
    const text = msg.text.trim();
    if (text.startsWith('/') || text.length === 0 || !/^\d{1,3}$/.test(text)) return;

    const movie_id = text.padStart(3, '0');
    if (!movies) return bot.sendMessage(msg.chat.id, "Bot hali ulanmagan, biroz kuting...");
    const movie = await movies.findOne({ _id: movie_id });

    if (movie) {
        if (await parts.findOne({ movie_id, part: 1 })) {
            await check_subscription_and_proceed(msg.chat.id, movie_id, 1);
        } else {
            send_trailer_with_poster(msg.chat.id, movie);
        }
    } else {
        bot.sendMessage(msg.chat.id, "Bunday ID bilan kino topilmadi");
    }
});

// ======================
// INLINE QUERY — YANGILANGAN VERSIYA
// ======================
bot.on('inline_query', async (query) => {
    const q = query.query.toLowerCase().trim();
    let movie_list = [];
    const limit = 10;

    if (q.length > 0) {
        movie_list = await movies.find({ title: { $regex: q, $options: "i" } }).limit(limit).toArray();
    } else {
        let cachedTop = await redisClient.get('top_movies');
        if (cachedTop) {
            movie_list = JSON.parse(cachedTop);
        } else {
            movie_list = await movies.find().sort({ views: -1 }).limit(limit).toArray();
            await redisClient.set('top_movies', JSON.stringify(movie_list), { EX: 900 });
        }
    }

    const results = movie_list.map(movie => ({
        type: 'article',
        id: movie._id,
        title: movie.title,
        description: `👁 ${movie.views || 0}`,
        input_message_content: {
            message_text: `🎬 <b>${movie.title}</b>\nJanr: ${movie.genres || 'Noma\'lum'}\nQismlar: ${movie.total_parts || 1}\nKo\'rishlar: ${movie.views || 0}\nID: <code>${movie._id}</code>`,
            parse_mode: "HTML"
        },
        reply_markup: {
            inline_keyboard: [[{ text: "▶️ Tomosha qilish", url: `https://t.me/${BOT_USERNAME}?start=${movie._id}` }]]
        }
    }));

    bot.answerInlineQuery(query.id, results, { cache_time: 0 }).catch(() => {});
});

// ======================
// CALLBACK QUERY
// ======================
bot.on('callback_query', async (query) => {
    bot.answerCallbackQuery(query.id).catch(() => {});
    const chat_id = query.message.chat.id;

    if (query.data === "genres_list") {
        const markup = {
            inline_keyboard: [
                [{ text: "🔥 Action", callback_data: "genre_Action" }, { text: "😂 Komediya", callback_data: "genre_Comedy" }],
                [{ text: "😢 Drama", callback_data: "genre_Drama" }, { text: "💕 Romantika", callback_data: "genre_Romance" }],
                [{ text: "🧙 Fantastika", callback_data: "genre_Fantasy" }, { text: "🚀 Sci-Fi", callback_data: "genre_Sci-Fi" }],
                [{ text: "🔙 Orqaga", callback_data: "back_to_start" }]
            ]
        };
        bot.sendMessage(chat_id, "🎭 Janrni tanlang:", { parse_mode: "HTML", reply_markup: markup });
    }
    else if (query.data.startsWith("genre_")) {
        const genre = query.data.replace("genre_", "");
        const movie_list = await movies.find({ genres: { $regex: genre, $options: "i" } }).limit(20).toArray();

        if (!movie_list.length) {
            return bot.sendMessage(chat_id, `"${genre}" janrida kino topilmadi.`);
        }

        const markup = { inline_keyboard: [] };
        movie_list.forEach(m => {
            markup.inline_keyboard.push([{ text: `▶️ ${m.title}`, url: `https://t.me/${BOT_USERNAME}?start=${m._id}` }]);
        });
        markup.inline_keyboard.push([{ text: "🔙 Orqaga", callback_data: "genres_list" }]);

        bot.sendMessage(chat_id, `${genre} janridagi kinolar:`, { reply_markup: markup });
    }
    else if (query.data === "back_to_start") {
        send_start_banner(chat_id);
    }
    else if (query.data === "news") {
        bot.sendMessage(chat_id, `Yangiliklar: @${NEWS_CHANNEL}`, {
            reply_markup: { inline_keyboard: [[{ text: "Kanalga o'tish", url: `https://t.me/${NEWS_CHANNEL}` }]] }
        });
    }
    else if (query.data === "how_it_works") {
        bot.sendMessage(chat_id, "1. Kino nomini yozing yoki qidiring\n" +
                                 "2. Obuna bo'ling (bir marta)\n" +
                                 "3. ▶️ Tomosha qilish tugmasini bosing\n" +
                                 "4. Qismlarni tanlab ko'ring 🍿");
    }
    else if (query.data === "get_premium") {
        const markup = {
            inline_keyboard: [
                [{ text: "1 oy - 7 000 so'm", callback_data: "select_plan_1month" }],
                [{ text: "3 oy - 19 000 so'm", callback_data: "select_plan_3month" }],
                [{ text: "6 oy - 35 000 so'm", callback_data: "select_plan_6month" }]
            ]
        };
        bot.sendMessage(chat_id, "💎 <b>Premium rejim</b> sizga:\n" +
            "✨ Reklamasiz tomosha\n" +
            "✨ Majburiy obunasiz yo'q\n" +
            "✨ Sifatli ko‘rish & yuklab olish\n" +
            "✨ Qismlarni yuklab olish va ulashish\n\n" +
            "🚀 <b>Hozir obuna bo‘ling!</b>", 
            { parse_mode: "HTML", reply_markup: markup });
    }
    else if (query.data.startsWith("select_plan_")) {
        const plan = query.data.split("_")[2];
        const price = plan === "1month" ? "7 000" : plan === "3month" ? "19 000" : "35 000";
        await pending_payments.updateOne(
            { user_id: chat_id },
            { $set: { plan, status: "pending" } },
            { upsert: true }
        );
        bot.sendMessage(chat_id, `Tanlangan obuna: ${plan.replace("month", " oy")} - ${price} so'm\n\n` +
                                 `Karta raqami: <code>${CARD_NUMBER}</code>\n\n` +
                                 "To'lov qilib, screenshot yuboring. Admin tekshiradi.", { parse_mode: "HTML" });
    }
    else if (query.data.startsWith("check_sub_play_")) {
        const parts_data = query.data.split("_");
        const movie_id = parts_data[3];
        const part = parseInt(parts_data[4]);
        const page = parseInt(parts_data[5] || 1);
        check_subscription_and_proceed(chat_id, movie_id, part, page);
    }
    else if (query.data.startsWith("play_")) {
        const [, movie_id, part, page] = query.data.split("_");
        check_subscription_and_proceed(chat_id, movie_id, parseInt(part), parseInt(page || 1));
    }
    else if (query.data.startsWith("next_page_")) {
        const [, movie_id, current_page] = query.data.split("_");
        const next_page = parseInt(current_page) + 1;
        check_subscription_and_proceed(chat_id, movie_id, 1, next_page);
    }
    else if (query.data.startsWith("prev_page_")) {
        const [, movie_id, current_page] = query.data.split("_");
        const prev_page = parseInt(current_page) - 1;
        check_subscription_and_proceed(chat_id, movie_id, 1, prev_page);
    }
    else if (query.data.startsWith("download_")) {
        const [, movie_id, part] = query.data.split("_");
        const premium = await is_premium(chat_id);
        if (!premium) {
            return bot.sendMessage(chat_id, "🚫 Yuklab olish faqat Premium foydalanuvchilar uchun mavjud!");
        }
        const partDoc = await parts.findOne({ movie_id, part: parseInt(part) });
        if (partDoc) {
            bot.sendDocument(chat_id, partDoc.file_id, { caption: `${movie_id} — ${part}-qism (Yuklab olish)` }).catch(() => {});
        } else {
            bot.sendMessage(chat_id, "Qism topilmadi");
        }
    }
    else if (query.data.startsWith("confirm_premium_")) {
        if (!ADMIN_IDS.includes(query.from.id)) return;
        const parts = query.data.split("_");
        const user_id = parseInt(parts[2]);
        const plan = parts[3];
        const days = plan === "1month" ? 30 : plan === "3month" ? 90 : 180;
        const now = new Date();
        const end_date = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

        await premium_users.updateOne(
            { user_id },
            { $set: { user_id, end_date } },
            { upsert: true }
        );
        await redisClient.set(`premium:${user_id}`, JSON.stringify({ end_date: end_date.toISOString() }), { EX: 900 });
        bot.sendMessage(user_id, "Premium obunangiz faollashtirildi!").catch(() => {});

        try {
            await bot.editMessageCaption({
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                caption: `Foydalanuvchi: ${user_id}\nObuna: ${plan}\nTo'lov screenshot\n\n✅ PREMIUM BERILDI`,
                reply_markup: { inline_keyboard: [] }
            });
        } catch {
            bot.sendMessage(query.message.chat.id, `✅ ${user_id} ga premium berildi`);
        }

        await pending_payments.deleteOne({ user_id });
    }
});

// ======================
// Screenshot qabul qilish
// ======================
bot.on('photo', async (msg) => {
    const user_id = msg.from.id;
    const pending = await pending_payments.findOne({ user_id, status: "pending" });
    if (!pending) return;

    const photo_id = msg.photo[msg.photo.length - 1].file_id;
    const markup = {
        inline_keyboard: [[{ text: "Berish", callback_data: `confirm_premium_${user_id}_${pending.plan}` }]]
    };

    await bot.sendPhoto(`@${PAYMENT_CHANNEL}`, photo_id, {
        caption: `Foydalanuvchi: ${user_id}\nObuna: ${pending.plan}\nTo'lov screenshot`,
        reply_markup: markup
    }).catch(() => {});

    await pending_payments.updateOne({ user_id }, { $set: { status: "sent" } });
    bot.sendMessage(msg.chat.id, "Screenshot yuborildi. Admin tekshiradi va tasdiqlaydi.").catch(() => {});
});

// ======================
// Qism yuborish
// ======================
async function send_part(chat_id, movie_id, part = 1, page = 1, premium = false) {
    const movie = await movies.findOne({ _id: movie_id });
    if (!movie) return bot.sendMessage(chat_id, "Kino topilmadi");

    const partDoc = await parts.findOne({ movie_id, part });
    if (!partDoc) return bot.sendMessage(chat_id, "Bu qism hali yuklanmagan");

    await movies.updateOne({ _id: movie_id }, { $inc: { views: 1 } });

    const total = movie.total_parts || 1;
    const buttons_per_page = 12;
    const total_pages = Math.ceil(total / buttons_per_page);
    const start_part = (page - 1) * buttons_per_page + 1;
    const end_part = Math.min(start_part + buttons_per_page - 1, total);

    const markup = { inline_keyboard: [] };
    const buttons = [];

    for (let p = start_part; p <= end_part; p++) {
        buttons.push({
            text: p === part ? `🎥 ▶️ ${p}-qism` : `🎥 ${p}-qism`,
            callback_data: `play_${movie_id}_${p}_${page}`
        });
    }

    for (let i = 0; i < buttons.length; i += 4) {
        markup.inline_keyboard.push(buttons.slice(i, i + 4));
    }

    const nav_row = [];
    if (page > 1) nav_row.push({ text: "◀️ Oldingi", callback_data: `prev_page_${movie_id}_${page}` });
    if (page < total_pages) nav_row.push({ text: "Keyingi ▶️", callback_data: `next_page_${movie_id}_${page}` });
    if (nav_row.length > 0) markup.inline_keyboard.push(nav_row);

    if (premium) {
        markup.inline_keyboard.push([{ text: "📥 Yuklab olish", callback_data: `download_${movie_id}_${part}` }]);
    }

    const reklama = await redisClient.get('settings:reklama_caption') || "Anime tomosha qilmoqchi bo‘lsangiz: 👉 @RimikAnime_bot";
    const premium_prompt = await redisClient.get('settings:premium_prompt') || "💎 Premium olsangiz, reklamasiz va yuklab olish imkoniyati bor!";

    let caption = `${movie.title} — ${part}-qism`;
    if (!premium) caption += `\n\n${reklama}`;

    bot.sendVideo(chat_id, partDoc.file_id, {
        caption,
        reply_markup: markup,
        disable_notification: !premium,
        protect_content: !premium
    }).catch(() => {});

    if (!premium) {
        bot.sendMessage(chat_id, premium_prompt).catch(() => {});
    }
}

// ======================
// ADMIN BUYRUQLARI
// ======================
bot.onText(/\/addmovie/, async (msg) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    addMovieSession[msg.from.id] = { step: 1 };
    bot.sendMessage(msg.chat.id, "🎬 Kino yoki serial nomini yuboring:");
});

bot.onText(/\/publish\s+(\d+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;

    const movie_id = match[1].padStart(3, '0');
    const movie = await movies.findOne({ _id: movie_id });
    if (!movie) return bot.sendMessage(msg.chat.id, "❌ Kino topilmadi");

    const markup = {
        inline_keyboard: [[{
            text: "▶️ Tomosha qilish",
            url: `https://t.me/${BOT_USERNAME}?start=${movie_id}`
        }]]
    };

    await bot.sendVideo(`@${NEWS_CHANNEL}`, movie.trailer, {
        caption:
`🎬 <b>${movie.title}</b>
🎭 Janr: ${movie.genres}
📦 Qismlar: ${movie.total_parts}
🆔 ID: ${movie_id}`,
        parse_mode: "HTML",
        reply_markup: markup
    });

    bot.sendMessage(msg.chat.id, "✅ NEWS kanalga chiqarildi");
});

bot.onText(/\/changeid\s+(.+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "Bu buyruq faqat adminlar uchun.");
    
    const oldId = match[1].trim().padStart(3, '0');
    const movie = await movies.findOne({ _id: oldId });
    if (!movie) return bot.sendMessage(msg.chat.id, `ID ${oldId} bilan kino topilmadi`);

    pendingIdChange[msg.from.id] = oldId;
    bot.sendMessage(msg.chat.id, `Kinoning ID sini o'zgartirmoqchisiz:\nEski ID: ${oldId}\nNomi: ${movie.title}\n\nYangi ID ni yozing (masalan: 940):`);
});

bot.onText(/\/cancel/, async (msg) => {
    const uid = msg.from.id;
    if (!ADMIN_IDS.includes(uid)) return; // faqat admin

    let canceled = false;

    if (addMovieSession[uid]) {
        delete addMovieSession[uid];
        canceled = true;
    }

    if (pendingIdChange[uid]) {
        delete pendingIdChange[uid];
        canceled = true;
    }

    if (canceled) {
        bot.sendMessage(msg.chat.id, "❌ Joriy buyruq yoki session bekor qilindi.");
    } else {
        bot.sendMessage(msg.chat.id, "⚠️ Hech qanday aktiv session topilmadi.");
    }
});

bot.onText(/\/set_reklama (.+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const new_reklama = match[1].trim();
    await settings.updateOne(
        { key: "reklama_caption" },
        { $set: { value: new_reklama } },
        { upsert: true }
    );
    await redisClient.set('settings:reklama_caption', new_reklama, { EX: 900 });
    bot.sendMessage(msg.chat.id, `Reklama matni yangilandi: ${new_reklama}`);
});

bot.onText(/\/set_premium_prompt (.+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const new_prompt = match[1].trim();
    await settings.updateOne(
        { key: "premium_prompt" },
        { $set: { value: new_prompt } },
        { upsert: true }
    );
    await redisClient.set('settings:premium_prompt', new_prompt, { EX: 900 });
    bot.sendMessage(msg.chat.id, `Premium prompt yangilandi: ${new_prompt}`);
});

bot.onText(/\/addpremium\s+(\d+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const uid = parseInt(match[1]);
    const now = new Date();
    const end_date = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await premium_users.updateOne({ user_id: uid }, { $set: { user_id: uid, end_date } }, { upsert: true });
    await redisClient.set(`premium:${uid}`, JSON.stringify({ end_date: end_date.toISOString() }), { EX: 900 });
    bot.sendMessage(msg.chat.id, `${uid} premium qilindi`);
});

bot.onText(/\/removepremium\s+(\d+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const uid = parseInt(match[1]);
    await premium_users.deleteOne({ user_id: uid });
    await redisClient.del(`premium:${uid}`);
    bot.sendMessage(msg.chat.id, `${uid} premiumdan chiqarildi`);
});

bot.onText(/\/deletemovie\s+(\d+)/, async (msg, match) => {
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(msg.chat.id, "Bu buyruq faqat adminlar uchun.");

    const movie_id = match[1].padStart(3, '0');
    const movie = await movies.findOne({ _id: movie_id });
    if (!movie) return bot.sendMessage(msg.chat.id, `ID ${movie_id} bilan kino topilmadi`);

    try {
        await movies.deleteOne({ _id: movie_id });
        const partsResult = await parts.deleteMany({ movie_id });
        bot.sendMessage(msg.chat.id, `✅ Kino o'chirildi!\nID: ${movie_id}\nNomi: ${movie.title}\nO'chirilgan qismlar: ${partsResult.deletedCount}`);
    } catch (err) {
        console.error("deletemovie xatosi:", err);
        bot.sendMessage(msg.chat.id, "❌ Kino o'chirishda xatolik yuz berdi");
    }
});

// ======================
// SESSION HANDLING (addMovieSession va pendingIdChange)
// ======================
bot.on('message', async (msg) => {
    const userId = msg.from.id;

    if (!ADMIN_IDS.includes(userId)) return;

    if (addMovieSession[userId]) {
        const s = addMovieSession[userId];

        if (s.step === 1) {
            if (!msg.text) return bot.sendMessage(msg.chat.id, "❗ Iltimos, kino nomini matn ko‘rinishida yuboring");
            s.title = msg.text.trim();
            s.step = 2;
            return bot.sendMessage(msg.chat.id, "🎭 Janr(lar)ni yozing (masalan: Action, Drama):");
        }

        if (s.step === 2) {
            if (!msg.text) return bot.sendMessage(msg.chat.id, "❗ Janrni matn ko‘rinishida yuboring");
            s.genres = msg.text.trim();
            s.step = 3;
            return bot.sendMessage(msg.chat.id, "📦 Qismlar sonini yozing (masalan: 12):");
        }

        if (s.step === 3) {
            if (!msg.text || !/^\d+$/.test(msg.text)) return bot.sendMessage(msg.chat.id, "❗ Faqat raqam yozing (masalan: 12)");
            s.total_parts = parseInt(msg.text);
            s.step = 4;
            return bot.sendMessage(msg.chat.id, "🆔 Kino ID sini yozing (avtomatik uchun '.' yuboring):");
        }

        if (s.step === 4) {
            if (!msg.text) return bot.sendMessage(msg.chat.id, "❗ ID ni yuboring yoki '.' yuboring");

            if (msg.text.trim() === ".") {
                s.movie_id = await getNextMovieId();
            } else if (/^\d+$/.test(msg.text.trim())) {
                s.movie_id = msg.text.trim().padStart(3, '0');
                const exists = await movies.findOne({ _id: s.movie_id });
                if (exists) return bot.sendMessage(msg.chat.id, `❌ ID ${s.movie_id} band. Boshqasini tanlang.`);
            } else {
                return bot.sendMessage(msg.chat.id, "❗ Faqat raqam yoki '.' yuboring");
            }

            s.step = 5;
            return bot.sendMessage(msg.chat.id, "🎞 Treyler videoni yuboring:");
        }

        if (s.step === 5) {
            if (!msg.video) return bot.sendMessage(msg.chat.id, "❗ Iltimos, video (treyler) yuboring");

            try {
                s.trailer = msg.video.file_id;

                await movies.insertOne({
                    _id: s.movie_id,
                    title: s.title,
                    genres: s.genres,
                    total_parts: s.total_parts,
                    trailer: s.trailer,
                    views: 0,
                    created_at: new Date()
                });

                await bot.sendMessage(
                    msg.chat.id,
                    `✅ Kino muvaffaqiyatli qo‘shildi!\n\n🎬 ${s.title}\n🎭 ${s.genres}\n📦 Qismlar: ${s.total_parts}\n🆔 ID: ${s.movie_id}`
                );
            } catch (err) {
                console.error("addmovie xatosi:", err);
                return bot.sendMessage(msg.chat.id, "❌ Kino qo‘shishda xatolik yuz berdi");
            }

            delete addMovieSession[userId];
        }

        return;
    }

    if (pendingIdChange[userId]) {
        const text = msg.text?.trim();
        if (!text || !/^\d+$/.test(text)) {
            return bot.sendMessage(
                msg.chat.id,
                "❗ Faqat raqam yozing (masalan: 940)"
            );
        }

        const newId = text.padStart(3, '0');
        const oldId = pendingIdChange[userId];

        if (await movies.findOne({ _id: newId })) {
            delete pendingIdChange[userId];
            return bot.sendMessage(
                msg.chat.id,
                `❌ ID ${newId} band. Boshqasini tanlang.`
            );
        }

        try {
            const movieDoc = await movies.findOne({ _id: oldId });
            if (!movieDoc) throw new Error("Eski kino topilmadi");

            await movies.deleteOne({ _id: oldId });
            await movies.insertOne({ ...movieDoc, _id: newId });

            const partsResult = await parts.updateMany(
                { movie_id: oldId },
                { $set: { movie_id: newId } }
            );

            delete pendingIdChange[userId];

            await bot.sendMessage(
                msg.chat.id,
                `✅ ID muvaffaqiyatli o‘zgartirildi!\n\n` +
                `Eski ID: ${oldId}\n` +
                `Yangi ID: ${newId}\n` +
                `Qismlar yangilandi: ${partsResult.modifiedCount}`
            );
        } catch (err) {
            console.error("changeid xatosi:", err);
            delete pendingIdChange[userId];
            await bot.sendMessage(msg.chat.id, "❌ Xatolik yuz berdi");
        }

        return;
    }
});

// ======================
// Kanal postidan qism yuklash
// ======================
bot.on('channel_post', async (msg) => {
    if (msg.chat.username !== UPLOAD_CHANNEL || !msg.video || !msg.caption) return;

    let movie_id = null;
    let part = null;
    for (let line of msg.caption.split("\n")) {
        if (line.toLowerCase().startsWith("id:")) {
            movie_id = line.split(":", 2)[1]?.trim()?.padStart(3, '0');
        }
        if (line.toLowerCase().startsWith("qism:")) {
            part = parseInt(line.split(":", 2)[1]?.trim());
        }
    }

    if (movie_id && Number.isInteger(part)) {
        await parts.updateOne(
            { movie_id, part },
            { $set: { file_id: msg.video.file_id } },
            { upsert: true }
        );
        bot.sendMessage(ADMIN_IDS[0], `✅ ${movie_id} — ${part}-qism yuklandi`).catch(() => {});
    }
});

// ======================
// Express
// ======================
const app = express();
app.get("/", (req, res) => res.send("Kinochi.uz Bot ishlayapti"));
app.listen(5000, () => {
    console.log(`Express server 5000 portda ishlamoqda`);
});

// ======================
// BOTNI ISHGA TUSHIRISH
// ======================
startBot().catch(console.error);