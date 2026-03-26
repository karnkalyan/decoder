#!/usr/bin/env node
/**
 * DecodX Setup Script
 * Run once: node setup.js
 * Creates the first SUPER_ADMIN user
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const prisma = new PrismaClient();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

async function main() {
    console.log('\n🔧 DecodX Setup — Create Admin User\n');

    const existing = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    if (existing) {
        console.log(`⚠️  A SUPER_ADMIN already exists: ${existing.email}`);
        const proceed = await ask('Create another? (y/N): ');
        if (proceed.trim().toLowerCase() !== 'y') { rl.close(); await prisma.$disconnect(); return; }
    }

    const email = await ask('Email: ');
    const password = await ask('Password: ');
    const first = await ask('First name: ');
    const last = await ask('Last name: ');

    const hash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
        data: {
            email: email.toLowerCase().trim(),
            passwordHash: hash,
            firstName: first.trim(),
            lastName: last.trim(),
            role: 'SUPER_ADMIN',
            subscription: 'ENTERPRISE',
            maxDevicesAllowed: 9999,
            isActive: true
        }
    });

    console.log(`\n✅ Admin user created: ${user.email} (id=${user.id})`);
    console.log(`   Login at: http://localhost:${process.env.PORT || 3100}/\n`);

    rl.close();
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });