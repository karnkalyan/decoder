require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors');
const http = require('http'); // Required to wrap express for WS
const WebSocket = require('ws');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());
app.use('/public', express.static('public'));

// --- WEBSOCKET STATE ---
// Map to track active connections: Key = HWID, Value = WebSocket Instance
const clients = new Map();

/**
 * Sends a real-time message to a specific device
 */
const notifyDevice = (hwid, action, extraData = {}) => {
    const ws = clients.get(hwid.toUpperCase());
    if (ws && ws.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({ action, ...extraData });
        ws.send(payload);
        console.log(`[WS] Sent ${action} to ${hwid}`);
    } else {
        console.log(`[WS] Could not notify ${hwid} (Offline)`);
    }
};

// Admin API key middleware
const adminAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// --- HTTP ENDPOINTS ---

app.get('/v1/device/activate', async (req, res) => {
    const { hwid } = req.query;
    if (!hwid) return res.status(400).json({ status: 'ERROR', message: 'Missing HWID' });

    try {
        let device = await prisma.device.findUnique({ where: { hwid: hwid.toUpperCase() } });
        if (!device) {
            device = await prisma.device.create({ data: { hwid: hwid.toUpperCase(), isActivated: false } });
        }

        if (device.isActivated) {
            await prisma.device.update({ where: { hwid: hwid.toUpperCase() }, data: { lastSeen: new Date() } });
            return res.json({ status: 'SUCCESS', message: 'Activated' });
        } else {
            return res.status(403).json({ status: 'PENDING', message: 'Device PENDING Activation' });
        }
    } catch (e) {
        res.status(500).json({ status: 'ERROR', message: 'Internal server error' });
    }
});

app.get('/v1/device/stream', async (req, res) => {
    const { hwid } = req.query;
    if (!hwid) return res.status(400).json({ error: 'Missing HWID' });

    try {
        const device = await prisma.device.findUnique({ where: { hwid: hwid.toUpperCase() } });
        if (device && device.isActivated && device.streamUrl) {
            return res.json({ url: device.streamUrl });
        }
        res.status(401).json({ error: 'Unauthorized or no URL assigned' });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/v1/admin/activate', adminAuth, async (req, res) => {
    const { hwid, isActivated } = req.body;
    if (!hwid) return res.status(400).json({ error: 'Missing HWID' });

    try {
        const device = await prisma.device.upsert({
            where: { hwid: hwid.toUpperCase() },
            update: { isActivated },
            create: { hwid: hwid.toUpperCase(), isActivated },
        });

        // TRIGGER REAL-TIME UPDATE
        if (!isActivated) {
            notifyDevice(hwid, 'deauth');
        } else if (device.streamUrl) {
            notifyDevice(hwid, 'play', { url: device.streamUrl });
        }

        res.json({ status: 'OK', device });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/v1/admin/seturl', adminAuth, async (req, res) => {
    const { hwid, streamUrl } = req.body;
    if (!hwid || !streamUrl) return res.status(400).json({ error: 'Missing HWID or URL' });

    try {
        const device = await prisma.device.upsert({
            where: { hwid: hwid.toUpperCase() },
            update: { streamUrl },
            create: { hwid: hwid.toUpperCase(), streamUrl, isActivated: false },
        });

        // TRIGGER REAL-TIME UPDATE
        if (device.isActivated) {
            notifyDevice(hwid, 'play', { url: streamUrl });
        }

        res.json({ status: 'OK', device });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- SERVER SETUP ---
const PORT = process.env.PORT || 3100;
const server = http.createServer(app); // Wrap Express with HTTP
const wss = new WebSocket.Server({ server, path: '/ws' }); // Listen on /ws

wss.on('connection', (ws, req) => {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
    const hwid = params.get('hwid')?.toUpperCase();

    if (!hwid) {
        ws.terminate();
        return;
    }

    console.log(`[WS] Device Connected: ${hwid}`);
    clients.set(hwid, ws);

    ws.on('close', () => {
        console.log(`[WS] Device Disconnected: ${hwid}`);
        clients.delete(hwid);
    });

    ws.on('error', () => clients.delete(hwid));
});

server.listen(PORT, () => {
    console.log(`DecodX Backend + Realtime WS running on port ${PORT}`);
});