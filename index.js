const { WebcastPushConnection } = require('tiktok-live-connector');
const axios = require('axios');
const http = require('http');

// ========== الإعدادات ==========
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TIKTOK_USERNAME || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ خطأ: المتغيرات البيئية غير مكتملة');
    console.error('المطلوب: TIKTOK_USERNAME, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID');
    process.exit(1);
}

// ========== المتغيرات ==========
const stats = {
    isLive: false,
    startTime: null,
    maxViewers: 0,
    totalLikes: 0,
    totalGifts: 0,
    totalDiamonds: 0,
    topGifter: { name: 'لا يوجد', diamonds: 0 },
    highestHundred: 0,
    lastNotification: 0
};

let tiktokConnection = null;
let reconnectTimer = null;
let isConnecting = false;

// ========== نظام Telegram Queue ==========
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;
    
    const { text, resolve, reject } = messageQueue.shift();
    
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            },
            { timeout: 10000 }
        );
        console.log('✅ تم الإرسال إلى Telegram');
        resolve();
    } catch (error) {
        console.error('❌ فشل الإرسال:', error.message);
        if (messageQueue.length < 10) {
            messageQueue.unshift({ text, resolve, reject });
        }
    } finally {
        isProcessingQueue = false;
        setTimeout(processQueue, 2000); // Rate limiting
    }
}

function sendToTelegram(text) {
    return new Promise((resolve, reject) => {
        messageQueue.push({ text, resolve, reject });
        processQueue();
    });
}

// ========== أدوات مساعدة ==========
function resetStats() {
    stats.isLive = true;
    stats.startTime = new Date();
    stats.maxViewers = 0;
    stats.totalLikes = 0;
    stats.totalGifts = 0;
    stats.totalDiamonds = 0;
    stats.topGifter = { name: 'لا يوجد', diamonds: 0 };
    stats.highestHundred = 0;
    stats.lastNotification = 0;
}

function getBaghdadTime() {
    const now = new Date();
    return new Intl.DateTimeFormat('ar-IQ', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    }).format(now);
}

// ========== TikTok Connection ==========
async function connectToTikTok() {
    if (isConnecting || stats.isLive) return;
    isConnecting = true;
    
    console.log(`🔌 الاتصال بـ TikTok: ${TIKTOK_USERNAME}`);
    
    try {
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch(e) {}
        }

        tiktokConnection = new WebcastPushConnection(TIKTOK_USERNAME, {
            processInitialData: true,
            enableWebsocketUpgrade: true,
            clientParams: {
                app_language: 'ar-SA',
                device_platform: 'web'
            }
        });

        // ✅ بدء البث
        tiktokConnection.on('connected', () => {
            console.log('✅ متصل بالبث');
            resetStats();
            
            sendToTelegram(
                `🚀 <b>بدأ البث المباشر!</b>\n\n` +
                `👤 الحساب: <code>${TIKTOK_USERNAME}</code>\n` +
                `🔗 <a href="https://www.tiktok.com/@${TIKTOK_USERNAME}/live">رابط البث</a>\n` +
                `⏰ ${getBaghdadTime()}`
            );
        });

        // 👥 مشاهدين
        tiktokConnection.on('roomUser', (data) => {
            if (!data?.viewerCount) return;
            
            const viewers = data.viewerCount;
            if (viewers > stats.maxViewers) stats.maxViewers = viewers;

            const hundred = Math.floor(viewers / 100) * 100;
            const now = Date.now();
            
            if (hundred >= 100 && hundred > stats.highestHundred && (now - stats.lastNotification > 120000)) {
                stats.highestHundred = hundred;
                stats.lastNotification = now;
                sendToTelegram(
                    `🎊 <b>${hundred} مشاهد!</b>\n` +
                    `👁️ الحالي: ${viewers.toLocaleString()}`
                );
            }
        });

        // ❤️ إعجابات
        tiktokConnection.on('like', (data) => {
            if (data?.totalLikeCount) stats.totalLikes = data.totalLikeCount;
        });

        // 🎁 هدايا
        tiktokConnection.on('gift', (data) => {
            if (!data?.repeatCount) return;
            
            const count = data.repeatCount;
            const value = (data.diamondCount || 0) * count;
            
            stats.totalGifts += count;
            stats.totalDiamonds += value;
            
            if (value > stats.topGifter.diamonds) {
                stats.topGifter = {
                    name: data.nickname || data.uniqueId || 'مجهول',
                    diamonds: value
                };
            }
        });

        // ❌ نهاية البث
        tiktokConnection.on('disconnected', () => {
            if (!stats.isLive) return;
            console.log('🔌 انتهى البث');
            stats.isLive = false;
            
            const duration = stats.startTime ? 
                Math.floor((Date.now() - stats.startTime) / 60000) : 0;
            
            sendToTelegram(
                `🏁 <b>انتهى البث</b>\n\n` +
                `⏱️ المدة: ${duration} دقيقة\n` +
                `🏆 أعلى مشاهدة: ${stats.maxViewers.toLocaleString()}\n` +
                `💖 إعجابات: ${stats.totalLikes.toLocaleString()}\n` +
                `🎁 هدايا: ${stats.totalGifts} (${stats.totalDiamonds}💎)\n` +
                `🌟 أكبر داعم: ${stats.topGifter.name}`
            );
            
            scheduleReconnect(30000);
        });

        // ⚠️ أخطاء
        tiktokConnection.on('error', (err) => {
            console.error('⚠️ خطأ:', err.message);
        });

        await tiktokConnection.connect();
        
    } catch (error) {
        console.error(`❌ فشل: ${error.message}`);
        scheduleReconnect(60000);
    } finally {
        isConnecting = false;
    }
}

function scheduleReconnect(delay) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    console.log(`🔄 إعادة المحاولة بعد ${delay/1000}ث...`);
    reconnectTimer = setTimeout(connectToTikTok, delay);
}

// ========== Health Check Server ==========
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'active',
        tiktok_connected: stats.isLive,
        username: TIKTOK_USERNAME,
        max_viewers: stats.maxViewers,
        uptime_minutes: Math.floor(process.uptime() / 60),
        timestamp: new Date().toISOString()
    }));
}).listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`);
    connectToTikTok();
});
