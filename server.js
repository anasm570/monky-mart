const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    connectionStateRecovery: {}
});

const DATA_FILE = path.join(__dirname, 'players.json');

// تحميل بيانات اللاعبين
function loadPlayers() {
    if (!fs.existsSync(DATA_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE));
    } catch (e) {
        return {};
    }
}
function savePlayers(players) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(players, null, 2));
}

// قائمة المحاصيل (مراحل)
const CROPS = [
    { id: 'corn', name: '🌽 ذرة', baseValue: 10, unlockCost: 0, pos: { x: 150, y: 400 } },
    { id: 'strawberry', name: '🍓 فراولة', baseValue: 20, unlockCost: 500, pos: { x: 400, y: 420 } },
    { id: 'apple', name: '🍎 تفاح', baseValue: 30, unlockCost: 1000, pos: { x: 650, y: 380 } },
    { id: 'orange', name: '🍊 برتقال', baseValue: 45, unlockCost: 2000, pos: { x: 70, y: 100 } },
    { id: 'grape', name: '🍇 عنب', baseValue: 60, unlockCost: 4000, pos: { x: 520, y: 220 } },
    { id: 'banana', name: '🍌 موز', baseValue: 80, unlockCost: 7000, pos: { x: 300, y: 80 } },
    { id: 'pineapple', name: '🍍 أناناس', baseValue: 110, unlockCost: 12000, pos: { x: 720, y: 460 } },
    { id: 'watermelon', name: '🍉 بطيخ', baseValue: 150, unlockCost: 20000, pos: { x: 50, y: 300 } }
];

class GameWorld {
    constructor() {
        this.players = new Map();      // socketId -> {id, name, x, y, color}
        this.money = 1000;             // النقود المشتركة (تعاونية)
        this.unlockedCrops = ['corn']; // المحاصيل المفتوحة حالياً
    }

    getClientData() {
        return {
            money: this.money,
            unlockedCrops: this.unlockedCrops,
            crops: CROPS.map(c => ({ ...c, unlocked: this.unlockedCrops.includes(c.id) }))
        };
    }
}

const world = new GameWorld();

// دوال لحساب تقدم اللاعب وحفظه
function getPlayerProgress(username) {
    const players = loadPlayers();
    return players[username] || { money: 0, unlockedCrops: ['corn'], password: '' };
}

function savePlayerProgress(username, money, unlockedCrops, password) {
    const players = loadPlayers();
    players[username] = { password, money, unlockedCrops, lastSeen: new Date() };
    savePlayers(players);
}

function authenticate(username, password) {
    const players = loadPlayers();
    if (players[username] && players[username].password === password) {
        return true;
    }
    if (!players[username]) {
        // تسجيل جديد
        players[username] = { password, money: 0, unlockedCrops: ['corn'] };
        savePlayers(players);
        return true;
    }
    return false;
}

// خدمة الملفات الثابتة من مجلد public
app.use(express.static(path.join(__dirname, 'public')));

// جعل الصفحة الرئيسية تخدم الملف index+.html (بدلاً من index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index+.html'));
});

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('login', ({ username, password }) => {
        if (authenticate(username, password)) {
            currentUser = username;
            const progress = getPlayerProgress(username);
            // دمج التقدم المحفوظ مع العالم الحالي (نأخذ الحد الأقصى)
            if (progress.money > world.money) world.money = progress.money;
            if (progress.unlockedCrops) {
                for (let crop of progress.unlockedCrops) {
                    if (!world.unlockedCrops.includes(crop)) world.unlockedCrops.push(crop);
                }
            }
            // إنشاء لاعب جديد في العالم
            const newPlayer = {
                id: socket.id,
                name: username,
                x: Math.random() * 700 + 50,
                y: Math.random() * 400 + 50,
                color: '#' + Math.floor(Math.random() * 16777215).toString(16)
            };
            world.players.set(socket.id, newPlayer);
            socket.emit('login_success', { username, gameData: world.getClientData(), player: newPlayer });
            io.emit('player_joined', newPlayer);
            io.emit('game_state', world.getClientData());
        } else {
            socket.emit('login_failed', { message: 'اسم مستخدم أو كلمة مرور خاطئة' });
        }
    });

    socket.on('player_move', (data) => {
        if (world.players.has(socket.id)) {
            const p = world.players.get(socket.id);
            p.x = data.x;
            p.y = data.y;
            socket.broadcast.emit('player_moved', { id: socket.id, x: p.x, y: p.y });
        }
    });

    socket.on('collect_crop', ({ cropId, value }) => {
        if (!currentUser) return;
        const crop = CROPS.find(c => c.id === cropId);
        if (!crop) return;
        if (!world.unlockedCrops.includes(cropId)) return;
        world.money += value;
        // حفظ تقدم اللاعب فوراً
        savePlayerProgress(currentUser, world.money, world.unlockedCrops, '');
        io.emit('game_state', world.getClientData());
    });

    socket.on('buy_crop', ({ cropId, cost }) => {
        if (!currentUser) return;
        const crop = CROPS.find(c => c.id === cropId);
        if (!crop) return;
        if (world.money >= cost && !world.unlockedCrops.includes(cropId)) {
            world.money -= cost;
            world.unlockedCrops.push(cropId);
            savePlayerProgress(currentUser, world.money, world.unlockedCrops, '');
            io.emit('game_state', world.getClientData());
            socket.emit('buy_success', { cropId });
        } else {
            socket.emit('buy_failed', { message: 'ليس لديك نقود كافية أو المحصول مفتوح بالفعل' });
        }
    });

    socket.on('disconnect', () => {
        if (world.players.has(socket.id)) {
            world.players.delete(socket.id);
            io.emit('player_left', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Monkey Mart متعدد اللاعبين يعمل على http://localhost:${PORT}`));