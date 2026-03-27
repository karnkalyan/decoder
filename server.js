require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ═══════════════════════════════════════════
   IN-MEMORY STATE
═══════════════════════════════════════════ */
const clients = new Map();       // hwid → WebSocket
const deviceRuntime = new Map(); // hwid → { currentUrl, bufferPercent, uptime, … }

/* ═══════════════════════════════════════════
   ENSURE REQUIRED DIRECTORIES EXIST
═══════════════════════════════════════════ */
const APK_DIR = path.join(__dirname, 'apk');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

[APK_DIR, UPLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[INIT] Created directory: ${dir}`);
    }
});

/* ═══════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════ */

const adminApiAuth = (req, res, next) => {
    if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY)
        return res.status(401).json({ error: 'Unauthorized' });
    next();
};

const jwtAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ error: 'No token' });
    }
    try {
        const secret = process.env.JWT_SECRET || 'decodx-secret-change-me';
        const decoded = jwt.verify(token, secret);
        req.user = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

const requireAdmin = (req, res, next) => {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(req.user?.role))
        return res.status(403).json({ error: 'Forbidden' });
    next();
};

const flexAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKey === process.env.ADMIN_API_KEY) return next();
    return jwtAuth(req, res, () => requireAdmin(req, res, next));
};

/* ═══════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════ */
const notifyDevice = (hwid, action, extra = {}) => {
    const normalizedHwid = hwid.toUpperCase();
    const ws = clients.get(normalizedHwid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({ action, ...extra });
        ws.send(payload);
        console.log(`[WS] → ${action} → ${normalizedHwid} payload=${payload}`);
        return true;
    }
    console.log(`[WS] ✗ ${normalizedHwid} offline (action=${action})`);
    return false;
};

const broadcastToAll = (action, extra = {}) => {
    let sent = 0;
    for (const [hwid, ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action, ...extra }));
            sent++;
        }
    }
    console.log(`[WS] broadcast → ${action} to ${sent} clients`);
    return sent;
};

const logEvent = async (hwid, event, details = null) => {
    try {
        const dev = await prisma.device.findUnique({ where: { hwid: hwid.toUpperCase() } });
        if (dev) {
            await prisma.connectionLog.create({
                data: { deviceId: dev.id, event, details }
            });
        }
    } catch (e) {
        console.error('[LOG]', e.message);
    }
};

const auditLog = async (userId, action, targetId, type, details, ip) => {
    try {
        await prisma.auditLog.create({
            data: { userId, action, targetId: String(targetId || ''), type, details, ipAddress: ip }
        });
    } catch (_) { }
};

/* ═══════════════════════════════════════════
   APK UPDATE ENDPOINTS
═══════════════════════════════════════════ */

const APK_CONFIG_PATH = path.join(__dirname, 'apk_config.json');
let apkConfig = { version: '1.0.0', downloadUrl: '' };

try {
    if (fs.existsSync(APK_CONFIG_PATH)) {
        apkConfig = JSON.parse(fs.readFileSync(APK_CONFIG_PATH, 'utf8'));
    }
} catch (e) { }

const saveApkConfig = () => {
    fs.writeFileSync(APK_CONFIG_PATH, JSON.stringify(apkConfig, null, 2));
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `tmp_${Date.now()}_${file.originalname}`);
    }
});
const upload = multer({ storage });

app.use('/apk', express.static(APK_DIR));

app.get('/v1/apk/check', async (req, res) => {
    res.json({
        version: apkConfig.version,
        downloadUrl: apkConfig.downloadUrl
    });
});

app.post('/v1/admin/apk/update', flexAuth, async (req, res) => {
    const { version, downloadUrl } = req.body;
    if (!version) return res.status(400).json({ error: 'Version required' });
    apkConfig.version = version;
    if (downloadUrl) apkConfig.downloadUrl = downloadUrl;
    saveApkConfig();
    res.json({ status: 'OK', config: apkConfig });
});

app.post('/v1/admin/apk/upload', flexAuth, upload.single('apk'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const version = req.body.version || '1.0.0';
    const forceUpdate = req.body.forceUpdate === 'true' || req.body.forceUpdate === true;
    const fileName = `decodx_${version}_${Date.now()}.apk`;
    const targetPath = path.join(APK_DIR, fileName);

    try {
        fs.renameSync(req.file.path, targetPath);
    } catch (err) {
        try {
            fs.copyFileSync(req.file.path, targetPath);
            fs.unlinkSync(req.file.path);
        } catch (copyErr) {
            console.error('[APK] Copy fallback failed:', copyErr.message);
            return res.status(500).json({ error: 'Failed to save APK file' });
        }
    }

    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const downloadUrl = `${proto}://${host}/apk/${fileName}`;

    apkConfig.version = version;
    apkConfig.downloadUrl = downloadUrl;
    saveApkConfig();

    let notified = 0;
    if (forceUpdate) {
        notified = broadcastToAll('force_update', { version, downloadUrl });
    }

    console.log(`[APK] Uploaded v${version} → ${downloadUrl} (forceUpdate=${forceUpdate}, notified=${notified})`);
    res.json({ status: 'OK', version, downloadUrl, notifiedDevices: notified });
});

app.get('/v1/admin/apk/info', flexAuth, async (req, res) => {
    let files = [];
    try {
        files = fs.readdirSync(APK_DIR)
            .filter(f => f.endsWith('.apk'))
            .map(f => ({
                name: f,
                size: fs.statSync(path.join(APK_DIR, f)).size,
                url: `/apk/${f}`
            }));
    } catch (_) { }
    res.json({ ...apkConfig, files });
});

app.post('/v1/admin/apk/force-push', flexAuth, async (req, res) => {
    if (!apkConfig.downloadUrl) {
        return res.status(400).json({ error: 'No APK configured yet' });
    }
    const notified = broadcastToAll('force_update', {
        version: apkConfig.version,
        downloadUrl: apkConfig.downloadUrl
    });
    res.json({ status: 'OK', notifiedDevices: notified });
});

/* ═══════════════════════════════════════════
   AUTH ENDPOINTS
═══════════════════════════════════════════ */

app.post('/v1/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
    try {
        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (!user || !user.isActive)
            return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET || 'decodx-secret-change-me',
            { expiresIn: '24h' }
        );

        await prisma.user.update({
            where: { id: user.id },
            data: { lastLogin: new Date() }
        });

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await auditLog(user.id, 'LOGIN', null, 'AUTH', null, ip);

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                role: user.role,
                subscription: user.subscription
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/v1/auth/me', jwtAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) return res.status(404).json({ error: 'Not found' });
        res.json({
            id: user.id, email: user.email, firstName: user.firstName,
            lastName: user.lastName, role: user.role, subscription: user.subscription,
            lastLogin: user.lastLogin
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/v1/auth/change-password', jwtAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
        const hash = await bcrypt.hash(newPassword, 12);
        await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
        res.json({ status: 'OK' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ═══════════════════════════════════════════
   USER MANAGEMENT
═══════════════════════════════════════════ */

app.get('/v1/admin/users', jwtAuth, requireAdmin, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, email: true, firstName: true, lastName: true,
                role: true, subscription: true, isActive: true,
                maxDevicesAllowed: true, lastLogin: true, createdAt: true,
                _count: { select: { devices: true } }
            }
        });
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/v1/admin/users', jwtAuth, requireAdmin, async (req, res) => {
    const { email, password, firstName, lastName, role, subscription, maxDevicesAllowed } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
    try {
        const hash = await bcrypt.hash(password, 12);
        const user = await prisma.user.create({
            data: {
                email: email.toLowerCase(),
                passwordHash: hash,
                firstName, lastName,
                role: role || 'USER',
                subscription: subscription || 'FREE',
                maxDevicesAllowed: maxDevicesAllowed || 5
            }
        });
        res.json({ status: 'OK', user: { id: user.id, email: user.email } });
    } catch (e) {
        if (e.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: e.message });
    }
});

app.put('/v1/admin/users/:id', jwtAuth, requireAdmin, async (req, res) => {
    const { firstName, lastName, role, subscription, isActive, maxDevicesAllowed } = req.body;
    try {
        const user = await prisma.user.update({
            where: { id: parseInt(req.params.id) },
            data: { firstName, lastName, role, subscription, isActive, maxDevicesAllowed }
        });
        res.json({ status: 'OK', user: { id: user.id, email: user.email } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/v1/admin/users/:id', jwtAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    try {
        await prisma.user.delete({ where: { id } });
        res.json({ status: 'OK' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ═══════════════════════════════════════════
   DEVICE ENDPOINTS
═══════════════════════════════════════════ */

app.get('/v1/device/activate', async (req, res) => {
    const { hwid } = req.query;
    if (!hwid) return res.status(400).json({ status: 'ERROR', message: 'Missing HWID' });
    try {
        let dev = await prisma.device.findUnique({ where: { hwid: hwid.toUpperCase() } });
        if (!dev) {
            dev = await prisma.device.create({
                data: { hwid: hwid.toUpperCase(), isActivated: false, status: 'IDLE' }
            });
        }
        if (dev.isActivated) {
            await prisma.device.update({
                where: { hwid: hwid.toUpperCase() },
                data: { lastSeen: new Date() }
            });
            return res.json({ status: 'SUCCESS' });
        }
        return res.status(403).json({ status: 'PENDING' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'ERROR' });
    }
});

app.get('/v1/device/stream', async (req, res) => {
    const { hwid } = req.query;
    if (!hwid) return res.status(400).json({ error: 'Missing HWID' });
    try {
        const dev = await prisma.device.findUnique({
            where: { hwid: hwid.toUpperCase() },
            include: { channel: true }
        });
        if (dev?.isActivated) {
            const url = dev.streamUrl || dev.channel?.streamUrl;
            if (url) return res.json({ url });
        }
        res.status(401).json({ error: 'No URL' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

/* ═══════════════════════════════════════════
   ADMIN DEVICE ENDPOINTS
═══════════════════════════════════════════ */

app.get('/v1/admin/devices', flexAuth, async (req, res) => {
    try {
        const devices = await prisma.device.findMany({
            orderBy: { lastSeen: 'desc' },
            include: { channel: true, user: { select: { id: true, email: true, firstName: true } } }
        });
        const result = devices.map(d => ({
            ...d,
            isOnline: clients.has(d.hwid),
            runtime: deviceRuntime.get(d.hwid) || null
        }));
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/v1/admin/device/:hwid', flexAuth, async (req, res) => {
    try {
        const dev = await prisma.device.findUnique({
            where: { hwid: req.params.hwid.toUpperCase() },
            include: { channel: true }
        });
        if (!dev) return res.status(404).json({ error: 'Not found' });
        res.json({
            ...dev,
            isOnline: clients.has(dev.hwid),
            runtime: deviceRuntime.get(dev.hwid) || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/v1/admin/device/:hwid/logs', flexAuth, async (req, res) => {
    try {
        const dev = await prisma.device.findUnique({ where: { hwid: req.params.hwid.toUpperCase() } });
        if (!dev) return res.status(404).json({ error: 'Not found' });
        const logs = await prisma.connectionLog.findMany({
            where: { deviceId: dev.id },
            orderBy: { createdAt: 'desc' },
            take: parseInt(req.query.limit) || 200
        });
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * ACTIVATE / DEACTIVATE endpoint
 * 
 * KEY FIX: When deactivating, we send 'deauth' FIRST, wait briefly, then
 * also send 'stop' as a belt-and-suspenders measure. This ensures the
 * Android client receives the command and fully tears down the player.
 * 
 * When activating, we send 'play' with the stream URL so playback starts
 * immediately without the device needing to poll.
 */
app.post('/v1/admin/activate', flexAuth, async (req, res) => {
    const { hwid, isActivated } = req.body;
    if (!hwid) return res.status(400).json({ error: 'Missing HWID' });
    try {
        const normalizedHwid = hwid.toUpperCase();
        const dev = await prisma.device.upsert({
            where: { hwid: normalizedHwid },
            update: { isActivated },
            create: { hwid: normalizedHwid, isActivated }
        });

        if (!isActivated) {
            // ── DEAUTH ──
            console.log(`[DEAUTH] Deactivating device ${normalizedHwid}`);
            notifyDevice(normalizedHwid, 'deauth');
            setTimeout(() => notifyDevice(normalizedHwid, 'stop'), 500);
            await logEvent(normalizedHwid, 'DEAUTHORIZED');

            const rt = deviceRuntime.get(normalizedHwid);
            if (rt) { rt.status = 'DEAUTHORIZED'; rt.currentUrl = ''; }
        } else {
            // ── AUTH: send activate FIRST, then play ──
            console.log(`[AUTH] Activating device ${normalizedHwid}`);
            await logEvent(normalizedHwid, 'ACTIVATED');

            // Step 1: Tell device it's activated (flips isActivated flag on device)
            notifyDevice(normalizedHwid, 'activate');

            // Step 2: Find stream URL and send play after brief delay
            const fullDev = await prisma.device.findUnique({
                where: { hwid: normalizedHwid },
                include: { channel: true }
            });
            const streamUrl = fullDev?.streamUrl || fullDev?.channel?.streamUrl;

            if (streamUrl) {
                // Delay ensures 'activate' is processed before 'play' arrives
                setTimeout(() => {
                    notifyDevice(normalizedHwid, 'play', { url: streamUrl });
                }, 500);
            }
        }

        res.json({ status: 'OK', device: dev });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/v1/admin/seturl', flexAuth, async (req, res) => {
    const { hwid, streamUrl } = req.body;
    if (!hwid || !streamUrl) return res.status(400).json({ error: 'Missing fields' });
    try {
        const normalizedHwid = hwid.toUpperCase();
        const dev = await prisma.device.upsert({
            where: { hwid: normalizedHwid },
            update: { streamUrl },
            create: { hwid: normalizedHwid, streamUrl, isActivated: false }
        });
        if (dev.isActivated) {
            // Send stop first, then play with new URL to avoid double audio
            notifyDevice(normalizedHwid, 'stop');
            setTimeout(() => {
                notifyDevice(normalizedHwid, 'play', { url: streamUrl });
            }, 1000);
        }
        await logEvent(normalizedHwid, 'URL_CHANGED', streamUrl);
        res.json({ status: 'OK', device: dev });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/v1/admin/device/:hwid/command', flexAuth, async (req, res) => {
    const hwid = req.params.hwid.toUpperCase();
    const { command, data } = req.body;
    if (!command) return res.status(400).json({ error: 'Missing command' });
    const sent = notifyDevice(hwid, command, data || {});
    if (sent) {
        await logEvent(hwid, `CMD_${command.toUpperCase()}`, JSON.stringify(data || {}));
        return res.json({ status: 'OK' });
    }
    res.status(404).json({ error: 'Device offline' });
});

app.post('/v1/admin/device/:hwid/reboot', flexAuth, async (req, res) => {
    const hwid = req.params.hwid.toUpperCase();
    const sent = notifyDevice(hwid, 'reboot_device');
    if (sent) {
        await logEvent(hwid, 'CMD_REBOOT_DEVICE');
        return res.json({ status: 'OK', message: 'Reboot command sent' });
    }
    res.status(404).json({ error: 'Device offline' });
});

app.post('/v1/admin/device/:hwid/name', flexAuth, async (req, res) => {
    try {
        const dev = await prisma.device.update({
            where: { hwid: req.params.hwid.toUpperCase() },
            data: { name: req.body.name }
        });
        res.json({ status: 'OK', device: dev });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/v1/admin/device/:hwid', flexAuth, async (req, res) => {
    try {
        const normalizedHwid = req.params.hwid.toUpperCase();

        // Deauth device first before deleting
        notifyDevice(normalizedHwid, 'deauth');

        await prisma.device.delete({ where: { hwid: normalizedHwid } });

        const ws = clients.get(normalizedHwid);
        if (ws) {
            setTimeout(() => {
                ws.terminate();
                clients.delete(normalizedHwid);
                deviceRuntime.delete(normalizedHwid);
            }, 1000);
        }

        res.json({ status: 'OK' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/v1/admin/bulk-command', flexAuth, async (req, res) => {
    const { hwids, command, data } = req.body;
    if (!command) return res.status(400).json({ error: 'Missing command' });

    const targets = hwids?.length
        ? hwids.map(h => h.toUpperCase())
        : [...clients.keys()];

    let sent = 0;
    for (const hwid of targets) {
        if (notifyDevice(hwid, command, data || {})) {
            sent++;
            await logEvent(hwid, `BULK_CMD_${command.toUpperCase()}`, JSON.stringify(data || {}));
        }
    }
    res.json({ status: 'OK', sent, total: targets.length });
});

app.get('/v1/admin/stats', flexAuth, async (req, res) => {
    try {
        const [total, activated] = await Promise.all([
            prisma.device.count(),
            prisma.device.count({ where: { isActivated: true } })
        ]);
        const online = clients.size;
        let playing = 0, buffering = 0, errors = 0;
        for (const [hwid] of clients) {
            const rt = deviceRuntime.get(hwid);
            if (rt?.status === 'PLAYING') playing++;
            else if (rt?.status === 'BUFFERING') buffering++;
            else if (rt?.status === 'ERROR') errors++;
        }
        res.json({ total, activated, online, playing, buffering, errors, offline: total - online });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ═══════════════════════════════════════════
   WEBSOCKET SERVER
═══════════════════════════════════════════ */

const PORT = process.env.PORT || 3100;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Ping/pong to detect dead connections
const WS_PING_INTERVAL = 30000;
const WS_PONG_TIMEOUT = 10000;

wss.on('connection', async (ws, req) => {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const hwid = params.get('hwid')?.toUpperCase();
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!hwid) { ws.terminate(); return; }

    console.log(`[WS] ✓ ${hwid} connected (${ip})`);

    // Close any existing connection for same HWID (prevent ghost connections)
    const old = clients.get(hwid);
    if (old && old.readyState === WebSocket.OPEN) {
        console.log(`[WS] Terminating old connection for ${hwid}`);
        old.terminate();
    }
    clients.set(hwid, ws);

    // Mark connection as alive for ping/pong
    ws.isAlive = true;

    try {
        await prisma.device.upsert({
            where: { hwid },
            update: { status: 'IDLE', lastSeen: new Date(), ipAddress: ip },
            create: { hwid, status: 'IDLE', lastSeen: new Date(), ipAddress: ip, isActivated: false }
        });
        await logEvent(hwid, 'WS_CONNECTED', ip);
    } catch (_) { }

    // Send current state to newly connected device
    try {
        const dev = await prisma.device.findUnique({ where: { hwid } });

        if (dev?.isActivated && dev?.streamUrl) {
            // Device is activated and has a URL — send play command
            ws.send(JSON.stringify({ action: 'play', url: dev.streamUrl }));
            console.log(`[WS] Sent play command to ${hwid} on connect: ${dev.streamUrl}`);
        } else if (dev && !dev.isActivated) {
            // Device exists but is not activated — send deauth to be safe
            ws.send(JSON.stringify({ action: 'deauth' }));
            console.log(`[WS] Sent deauth to ${hwid} on connect (not activated)`);
        }

        // Inform device of current APK version
        if (apkConfig.version && apkConfig.downloadUrl) {
            ws.send(JSON.stringify({
                action: 'apk_info',
                version: apkConfig.version,
                downloadUrl: apkConfig.downloadUrl
            }));
        }
    } catch (_) { }

    // Setup ping/pong heartbeat for this connection
    const pingInterval = setInterval(() => {
        if (!ws.isAlive) {
            console.log(`[WS] ${hwid} failed pong – terminating`);
            clearInterval(pingInterval);
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) { clearInterval(pingInterval); }
    }, WS_PING_INTERVAL);

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg.type === 'heartbeat') {
                ws.isAlive = true; // heartbeat also counts as alive

                const up = { status: msg.status || 'IDLE', lastSeen: new Date() };
                const di = msg.deviceInfo || {};
                if (di.model) up.model = di.model;
                if (di.brand) up.brand = di.brand;
                if (di.osVersion) up.osVersion = di.osVersion;
                if (di.appVersion) up.appVersion = di.appVersion;
                if (di.ipAddress) up.ipAddress = di.ipAddress;
                if (di.sdkVersion) up.sdkVersion = di.sdkVersion;
                if (di.screenRes) up.screenRes = di.screenRes;

                await prisma.device.update({ where: { hwid }, data: up });

                deviceRuntime.set(hwid, {
                    currentUrl: msg.currentUrl || '',
                    bufferPercent: msg.bufferPercent ?? -1,
                    uptime: msg.uptime || 0,
                    status: msg.status || 'IDLE',
                    protocol: msg.protocol || '',
                    consecutiveStalls: msg.consecutiveStalls || 0,
                    retryCount: msg.retryCount || 0,
                    ts: Date.now()
                });

            } else if (msg.type === 'log') {
                await logEvent(hwid, msg.event || 'APP_LOG', msg.details || '');
            }
        } catch (e) {
            console.error('[WS] parse err:', e.message);
        }
    });

    ws.on('close', async () => {
        console.log(`[WS] ✗ ${hwid} disconnected`);
        clearInterval(pingInterval);

        // Only remove from clients if this is still the active connection for this HWID
        if (clients.get(hwid) === ws) {
            clients.delete(hwid);
            deviceRuntime.delete(hwid);
        }

        try {
            await prisma.device.update({ where: { hwid }, data: { status: 'OFFLINE' } });
            await logEvent(hwid, 'WS_DISCONNECTED');
        } catch (_) { }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error for ${hwid}:`, err.message);
        clearInterval(pingInterval);
        if (clients.get(hwid) === ws) {
            clients.delete(hwid);
            deviceRuntime.delete(hwid);
        }
    });
});

// Periodic cleanup of stale devices
setInterval(async () => {
    try {
        const cutoff = new Date(Date.now() - 90_000);
        await prisma.device.updateMany({
            where: { lastSeen: { lt: cutoff }, status: { not: 'OFFLINE' } },
            data: { status: 'OFFLINE' }
        });
    } catch (_) { }
}, 30_000);

server.listen(PORT, () => console.log(`DecodX running on :${PORT}`));