const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const rimraf = require('rimraf');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3000;
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Initial config
let config = {
    targetGroups: [], // Array of group names
    minDelay: 30,
    maxDelay: 120,
    personalWarming: false, // Inter-account chat
    isRunning: false
};

if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

// Clients management
const clients = {};
const maxAccounts = 8;
let warmingTimeout = null;

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function addHistory(msg) {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
    const entry = { timestamp: new Date().toISOString(), message: msg };
    history.unshift(entry);
    if (history.length > 100) history = history.slice(0, 100);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    io.emit('log', msg);
}

// API Endpoints
app.get('/api/messages', (req, res) => {
    const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
    res.json(data.messages);
});

app.post('/api/messages', (req, res) => {
    const { messages } = req.body;
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify({ messages }, null, 2));
    res.json({ success: true });
});

app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    saveConfig();
    res.json({ success: true });
});

app.post('/api/start', (req, res) => {
    if (config.targetGroups.length === 0 && !config.personalWarming) {
        return res.status(400).json({ error: 'Atur minimal satu grup atau aktifkan Warming Personal' });
    }
    config.isRunning = true;
    saveConfig();
    if (warmingTimeout) clearTimeout(warmingTimeout);
    startWarmingLoop();
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    config.isRunning = false;
    if (warmingTimeout) {
        clearTimeout(warmingTimeout);
        warmingTimeout = null;
    }
    saveConfig();
    res.json({ success: true });
});

app.post('/api/logout/:id', async (req, res) => {
    const id = req.params.id;
    if (clients[id]) {
        try {
            await clients[id].instance.destroy();
            delete clients[id];
            
            const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-account-${id}`);
            if (fs.existsSync(sessionPath)) {
                rimraf.sync(sessionPath);
            }
            
            io.emit('status_update', { id, status: 'disconnected', qr: null });
            res.json({ success: true });
        } catch (err) {
            console.error(`Error logging out account ${id}:`, err);
            res.status(500).json({ error: err.message });
        }
    } else {
        // Just in case session folder exists but client is not initialized
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-account-${id}`);
        if (fs.existsSync(sessionPath)) {
            rimraf.sync(sessionPath);
        }
        res.json({ success: true });
    }
});

app.get('/api/groups', async (req, res) => {
    const activeClients = Object.keys(clients).filter(id => clients[id].status === 'connected');
    if (activeClients.length === 0) return res.json([]);

    try {
        // Collect groups from all active clients and merge them
        const allGroups = [];
        const seenNames = new Set();

        for (const id of activeClients) {
            const client = clients[id].instance;
            const chats = await client.getChats();
            const groups = chats.filter(chat => chat.isGroup);
            
            groups.forEach(g => {
                if (!seenNames.has(g.name)) {
                    allGroups.push({ name: g.name, id: g.id._serialized });
                    seenNames.add(g.name);
                }
            });
        }
        res.json(allGroups);
    } catch (err) {
        console.error('Error fetching groups:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history', (req, res) => {
    if (fs.existsSync(HISTORY_FILE)) {
        res.json(JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')));
    } else {
        res.json([]);
    }
});

// WhatsApp Logic
function initClient(id) {
    if (clients[id]) return;

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `account-${id}` }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    clients[id] = {
        instance: client,
        status: 'loading',
        qr: null
    };

    io.emit('status_update', { id, status: 'loading' });

    client.on('qr', (qr) => {
        qrcode.toDataURL(qr, (err, url) => {
            clients[id].qr = url;
            clients[id].status = 'qr';
            io.emit('status_update', { id, status: 'qr', qr: url });
        });
    });

    client.on('ready', () => {
        clients[id].status = 'connected';
        clients[id].qr = null;
        console.log(`Account ${id} is ready!`);
        io.emit('status_update', { id, status: 'connected' });
    });

    client.on('authenticated', () => {
        console.log(`Account ${id} authenticated`);
    });

    client.on('auth_failure', (msg) => {
        clients[id].status = 'failed';
        io.emit('status_update', { id, status: 'failed', error: msg });
    });

    client.on('disconnected', (reason) => {
        clients[id].status = 'disconnected';
        io.emit('status_update', { id, status: 'disconnected', reason });
    });

    client.initialize().catch(err => {
        console.error(`Error initializing client ${id}:`, err);
    });
}

function loadExistingSessions() {
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath);
        folders.forEach(folder => {
            if (folder.startsWith('session-account-')) {
                const id = folder.replace('session-account-', '');
                console.log(`Auto-loading session for account ${id}...`);
                initClient(id);
            }
        });
    }
}

// Warming Loop
async function startWarmingLoop() {
    if (!config.isRunning) return;

    const activeIds = Object.keys(clients).filter(id => clients[id].status === 'connected');
    
    if (activeIds.length < (config.personalWarming ? 2 : 1)) {
        const msg = config.personalWarming ? 'Butuh minimal 2 akun aktif untuk Personal Warming.' : 'Tidak ada akun aktif terhubung.';
        console.log(msg);
        io.emit('log', `Sistem: ${msg} Menunggu...`);
        warmingTimeout = setTimeout(startWarmingLoop, 10000);
        return;
    }

    // Pick a random sender
    const senderId = activeIds[Math.floor(Math.random() * activeIds.length)];
    const senderClient = clients[senderId].instance;

    try {
        const messagesData = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
        const randomMsg = messagesData.messages[Math.floor(Math.random() * messagesData.messages.length)];

        // Decide Mode: Group or Personal
        let mode = 'group';
        if (config.personalWarming && config.targetGroups.length > 0) {
            mode = Math.random() > 0.5 ? 'personal' : 'group';
        } else if (config.personalWarming) {
            mode = 'personal';
        }

        if (mode === 'group' && config.targetGroups.length > 0) {
            // Group Mode: Sender sends to ALL target groups in the list
            const chats = await senderClient.getChats();
            
            for (const targetName of config.targetGroups) {
                const group = chats.find(chat => chat.isGroup && chat.name.toLowerCase().includes(targetName.toLowerCase()));
                if (group) {
                    const groupMsg = messagesData.messages[Math.floor(Math.random() * messagesData.messages.length)];
                    await senderClient.sendMessage(group.id._serialized, groupMsg);
                    addHistory(`[Akun ${senderId}] Group: "${groupMsg}" ➡️ ${group.name}`);
                    // Small internal delay between groups (1-3 seconds)
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    addHistory(`[Akun ${senderId}] Grup "${targetName}" tidak ditemukan!`);
                }
            }
        } else if (mode === 'personal' && activeIds.length >= 2) {
            // Personal Mode (Inter-account chat)
            const otherIds = activeIds.filter(id => id !== senderId);
            const receiverId = otherIds[Math.floor(Math.random() * otherIds.length)];
            const receiverClient = clients[receiverId].instance;
            
            // Get receiver's number
            const receiverNumber = receiverClient.info.wid._serialized;
            
            await senderClient.sendMessage(receiverNumber, randomMsg);
            addHistory(`[Akun ${senderId}] Personal: "${randomMsg}" ➡️ Akun ${receiverId}`);
        }
    } catch (err) {
        console.error(`Error in warming loop:`, err);
        io.emit('log', `Error: ${err.message}`);
    }

    // Random delay
    const delay = Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1) + config.minDelay) * 1000;
    warmingTimeout = setTimeout(startWarmingLoop, delay);
}

io.on('connection', (socket) => {
    console.log('New web client connected');
    
    // Send initial status of all slots
    const statusMap = {};
    for (let i = 1; i <= maxAccounts; i++) {
        statusMap[i] = clients[i] ? { status: clients[i].status, qr: clients[i].qr } : { status: 'disconnected', qr: null };
    }
    socket.emit('init_status', statusMap);

    socket.on('connect_account', (id) => {
        initClient(id);
    });

    socket.on('logout_account', async (id) => {
        if (clients[id]) {
            try {
                await clients[id].instance.destroy();
                delete clients[id];
                
                const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-account-${id}`);
                if (fs.existsSync(sessionPath)) {
                    rimraf.sync(sessionPath);
                }
                
                io.emit('status_update', { id, status: 'disconnected', qr: null });
            } catch (err) {
                console.error(`Error logging out account ${id}:`, err);
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    loadExistingSessions();
});
