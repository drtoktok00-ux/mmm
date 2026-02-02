const { WebcastPushConnection } = require('tiktok-live-connector');
const axios = require('axios');

// --- الإعدادات من متغيرات البيئة ---
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || "talalmsa455";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ يرجى تعيين TELEGRAM_TOKEN و TELEGRAM_CHAT_ID في Railway Variables");
    process.exit(1);
}

// --- المتغيرات ---
let stats = {
    highestHundred: 0,
    maxViewers: 0, 
    totalLikes: 0,
    totalGifts: 0,
    totalDiamonds: 0,
    topGifter: { name: "لا يوجد", diamonds: 0 },
    isLive: false,
    lastNotification: 0,
    startTime: null
};

let tiktokConnection = null;
let reconnectTimer = null;
let isConnecting = false;

// --- نظام إرسال Telegram بسيط وفعال ---
const telegramQueue = [];
let isSending = false;

async function processTelegramQueue() {
    if (isSending || telegramQueue.length === 0) return;
    isSending = true;
    
    const { text, resolve, reject } = telegramQueue.shift();
    
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        }, { timeout: 10000 });
        
        console.log("✅ تم إرسال الرسالة");
        resolve();
    } catch (err) {
        console.error("❌ خطأ في الإرسال:", err.response?.data?.description || err.message);
        // إعادة المحاولة بعد 5 ثواني إذا كان خطأ مؤقتاً
        if (telegramQueue.length < 5) { // تجنب الازدحام
            setTimeout(() => {
                telegramQueue.unshift({ text, resolve, reject });
                processTelegramQueue();
            }, 5000);
        } else {
            reject(err);
        }
    } finally {
        isSending = false;
        // Rate limit: انتظار 1.5 ثانية بين الرسائل
        setTimeout(processTelegramQueue, 1500);
    }
}

function sendToTelegram(text) {
    return new Promise((resolve, reject) => {
        telegramQueue.push({ text, resolve, reject });
        processTelegramQueue();
    });
}

// --- تصفير الإحصائيات ---
function resetStats() {
    stats = {
        highestHundred: 0,
        maxViewers: 0,
        totalLikes: 0,
        totalGifts: 0,
        totalDiamonds: 0,
        topGifter: { name: "لا يوجد", diamonds: 0 },
        isLive: true,
        lastNotification: 0,
        startTime: new Date()
    };
}

// --- الاتصال الرئيسي ---
async function startMonitoring() {
    if (isConnecting || stats.isLive) return;
    isConnecting = true;
    
    console.log(`🔌 محاولة الاتصال بـ TikTok: ${TIKTOK_USERNAME}`);

    try {
        // إغلاق الاتصال القديم إن وجد
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch(e) {}
        }

        tiktokConnection = new WebcastPushConnection(TIKTOK_USERNAME, {
            processInitialData: true,
            enableWebsocketUpgrade: true,
            clientParams: {
                app_language: "ar-SA",
                device_platform: "web",
                browser_name: "Chrome",
                browser_version: "120.0.0.0"
            }
        });

        // ✅ بدء الاتصال
        tiktokConnection.on('connected', () => {
            console.log(`✅ متصل ببث: ${TIKTOK_USERNAME}`);
            resetStats();
            
            sendToTelegram(
                `🚀 <b>بدأ البث المباشر الآن!</b>\n` +
                `👤 الحساب: <code>${TIKTOK_USERNAME}</code>\n` +
                `🔗 <a href="https://www.tiktok.com/@${TIKTOK_USERNAME}/live">رابط البث</a>\n` +
                `🖥️ الخادم: Railway.app`
            );
        });

        // 👥 مراقبة المشاهدين
        tiktokConnection.on('roomUser', (data) => {
            if (!data?.viewerCount) return;
            
            const viewers = data.viewerCount;
            if (viewers > stats.maxViewers) stats.maxViewers = viewers;

            const currentHundred = Math.floor(viewers / 100) * 100;
            const now = Date.now();
            
            // إشعار كل 100 مشاهد (مع فاصل 3 دقائق)
            if (currentHundred >= 100 && 
                currentHundred > stats.highestHundred && 
                (now - stats.lastNotification > 180000)) {
                
                stats.highestHundred = currentHundred;
                stats.lastNotification = now;
                
                sendToTelegram(
                    `🎊 <b>إنجاز جديد!</b>\n` +
                    `👁️ المشاهدين: <b>${viewers.toLocaleString()}</b>\n` +
                    `📈 تجاوزنا عتبة: <b>${currentHundred}</b>\n` +
                    `⏰ ${new Date().toLocaleTimeString('ar-SA')}`
                );
            }
        });

        // ❤️ الإعجابات
        tiktokConnection.on('like', (data) => {
            if (data?.totalLikeCount) stats.totalLikes = data.totalLikeCount;
        });

        // 🎁 الهدايا
        tiktokConnection.on('gift', (data) => {
            if (!data?.repeatCount) return;
            
            const giftCount = data.repeatCount;
            const diamondValue = (data.diamondCount || 0) * giftCount;
            
            stats.totalGifts += giftCount;
            stats.totalDiamonds += diamondValue;
            
            if (diamondValue > stats.topGifter.diamonds) {
                stats.topGifter = {
                    name: data.nickname || data.uniqueId || "مجهول",
                    diamonds: diamondValue
                };
            }
        });

        // ❌ انقطاع الاتصال
        tiktokConnection.on('disconnected', () => {
            console.log('🔌 انقطع الاتصال');
            if (stats.isLive) {
                stats.isLive = false;
                sendEndNotification();
            }
            scheduleReconnect(30000);
        });

        // ⚠️ أخطاء
        tiktokConnection.on('error', (err) => {
            console.error('⚠️ خطأ في TikTok:', err.message);
        });

        await tiktokConnection.connect();
        
    } catch (err) {
        console.error(`❌ فشل الاتصال: ${err.message}`);
        // في Railway، نحاول مجدداً بسرعة أكبر من HF
        scheduleReconnect(45000);
    } finally {
        isConnecting = false;
    }
}

// --- إشعار النهاية ---
function sendEndNotification() {
    const now = new Date();
    const options = { 
        timeZone: 'Asia/Baghdad', 
        year: 'numeric', month: '2-digit', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', hour12: true 
    };
    
    const formatter = new Intl.DateTimeFormat('ar-IQ', options);
    const parts = formatter.formatToParts(now);
    
    const dateStr = `${parts.find(p => p.type === 'day').value}/${parts.find(p => p.type === 'month').value}/${parts.find(p => p.type === 'year').value}`;
    const timeStr = `${parts.find(p => p.type === 'hour').value}:${parts.find(p => p.type === 'minute').value} ${parts.find(p => p.type === 'dayPeriod').value}`;

    const duration = stats.startTime ? 
        Math.floor((new Date() - stats.startTime) / 60000) + ' دقيقة' : 
        'غير معروف';

    sendToTelegram(
        `🏁 <b>انتهى البث المباشر</b>\n\n` +
        `👤 الحساب: <code>${TIKTOK_USERNAME}</code>\n` +
        `📅 التاريخ: ${dateStr}\n` +
        `⏰ الوقت: ${timeStr}\n` +
        `⏱️ المدة: ${duration}\n` +
        `🏆 أعلى مشاهدة: <b>${stats.maxViewers.toLocaleString()}</b>\n` +
        `💖 إجمالي الإعجابات: <b>${stats.totalLikes.toLocaleString()}</b>\n` +
        `🎁 عدد الهدايا: <b>${stats.totalGifts.toLocaleString()}</b>\n` +
        `💎 قيمة الهدايا: <b>${stats.totalDiamonds.toLocaleString()}</b> دولار\n` +
        `🌟 أكبر داعم: <b>${stats.topGifter.name}</b> (${stats.topGifter.diamonds.toLocaleString()} 💎)`
    );
}

function scheduleReconnect(delay) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    console.log(`🔄 إعادة المحاولة بعد ${delay/1000} ثانية...`);
    reconnectTimer = setTimeout(() => {
        if (!stats.isLive) startMonitoring();
    }, delay);
}

// --- Health Check (مطلوب لـ Railway) ---
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'running',
        tiktok: stats.isLive ? 'connected' : 'disconnected',
        user: TIKTOK_USERNAME,
        viewers: stats.maxViewers,
        uptime: Math.floor(process.uptime() / 60) + ' دقيقة'
    }));
}).listen(process.env.PORT || 3000, () => {
    console.log('🚀 البوت يعمل على Railway');
    console.log(`📊 مراقبة: ${TIKTOK_USERNAME}`);
    startMonitoring();
});
