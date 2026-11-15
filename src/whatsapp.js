import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const retryDelaysMs = [2000, 5000, 10000, 20000, 30000];

export function normalizeRecipient(value) {
  const recipient = String(value || '').trim();
  if (recipient.includes('@')) {
    if (!/^[\d-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(recipient)) {
      throw new Error('Use a saved WhatsApp contact or group.');
    }
    return recipient;
  }

  const digits = recipient.replace(/[\s()+-]/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    throw new Error('Enter an international phone number with country code.');
  }
  return `${digits}@s.whatsapp.net`;
}

function displayName(entry, jid) {
  return String(entry.name || entry.notify || entry.verifiedName || entry.subject || jid.split('@')[0]);
}

function toChat(entry, typeHint) {
  const jid = entry.id || entry.jid;
  if (!jid || typeof jid !== 'string' || !jid.includes('@')) return null;
  const type = typeHint || (jid.endsWith('@g.us') ? 'group' : 'individual');
  return { jid, name: displayName(entry, jid), type };
}

export function createWhatsApp({ store, dataDir = process.env.DATA_DIR || 'data' }) {
  const authDir = join(dataDir, 'auth_info');
  const state = {
    connectionState: 'connecting',
    qrDataUrl: null,
    connectedUser: null,
  };
  let socket;
  let generation = 0;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let starting = false;
  let stopped = false;

  const updateChats = (entries, typeHint) => {
    const chats = entries.map((entry) => toChat(entry, typeHint)).filter(Boolean);
    if (chats.length) store.upsertChats(chats);
  };

  const scheduleReconnect = (delayMs) => {
    if (stopped || reconnectTimer) return;
    state.connectionState = 'connecting';
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void start();
    }, delayMs);
    reconnectTimer.unref?.();
  };

  async function start() {
    if (stopped || starting) return;
    starting = true;
    const currentGeneration = ++generation;
    state.connectionState = 'connecting';
    state.qrDataUrl = null;

    try {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await chmod(authDir, 0o700);
      const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
      if (stopped || currentGeneration !== generation) return;

      const currentSocket = makeWASocket({
        auth: authState,
        logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
      });
      socket = currentSocket;
      currentSocket.ev.on('creds.update', saveCreds);
      currentSocket.ev.on('messaging-history.set', ({ contacts, chats }) => {
        updateChats(contacts);
        updateChats(chats);
      });
      currentSocket.ev.on('contacts.upsert', (contacts) => updateChats(contacts));
      currentSocket.ev.on('contacts.update', (contacts) => updateChats(contacts));
      currentSocket.ev.on('chats.upsert', (chats) => updateChats(chats));
      currentSocket.ev.on('groups.upsert', (groups) => updateChats(groups, 'group'));
      currentSocket.ev.on('groups.update', (groups) => updateChats(groups, 'group'));

      currentSocket.ev.on('connection.update', async (update) => {
        if (stopped || currentGeneration !== generation) return;

        if (update.qr) {
          try {
            const qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
            if (currentGeneration === generation && state.connectionState !== 'connected') {
              state.qrDataUrl = qrDataUrl;
              state.connectionState = 'qr_ready';
            }
          } catch (error) {
            console.warn('Could not render WhatsApp pairing QR:', error.message);
          }
        }

        if (update.connection === 'open') {
          reconnectAttempt = 0;
          state.connectionState = 'connected';
          state.qrDataUrl = null;
          state.connectedUser = currentSocket.user
            ? { id: currentSocket.user.id, name: currentSocket.user.name || currentSocket.user.id }
            : null;
          void syncGroups().catch((error) => console.warn('Group sync failed:', error.message));
        }

        if (update.connection === 'close') {
          socket = undefined;
          state.connectionState = 'disconnected';
          state.qrDataUrl = null;
          state.connectedUser = null;
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            reconnectAttempt = 0;
            await rm(authDir, { recursive: true, force: true });
            scheduleReconnect(2000);
          } else {
            const wait = retryDelaysMs[Math.min(reconnectAttempt, retryDelaysMs.length - 1)];
            reconnectAttempt += 1;
            scheduleReconnect(wait);
          }
        }
      });
    } catch (error) {
      if (currentGeneration === generation && !stopped) {
        console.warn('WhatsApp connection setup failed:', error.message);
        state.connectionState = 'disconnected';
        state.qrDataUrl = null;
        const wait = retryDelaysMs[Math.min(reconnectAttempt, retryDelaysMs.length - 1)];
        reconnectAttempt += 1;
        scheduleReconnect(wait);
      }
    } finally {
      starting = false;
    }
  }

  async function syncGroups() {
    if (!socket || state.connectionState !== 'connected') throw new Error('WhatsApp is not connected.');
    const groups = await socket.groupFetchAllParticipating();
    updateChats(Object.values(groups), 'group');
    return Object.keys(groups).length;
  }

  async function sendWhatsAppMessage(jid, text) {
    if (!socket || state.connectionState !== 'connected') throw new Error('WhatsApp is not connected.');
    const result = await socket.sendMessage(normalizeRecipient(jid), { text });
    return result?.key?.id || null;
  }

  async function logout() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const oldSocket = socket;
    socket = undefined;
    generation += 1;
    state.connectionState = 'disconnected';
    state.qrDataUrl = null;
    state.connectedUser = null;
    try {
      await oldSocket?.logout();
    } catch (error) {
      console.warn('WhatsApp logout request failed:', error.message);
    }
    await rm(authDir, { recursive: true, force: true });
    reconnectAttempt = 0;
    scheduleReconnect(1500);
  }

  async function stop() {
    stopped = true;
    generation += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const oldSocket = socket;
    socket = undefined;
    oldSocket?.end(undefined);
  }

  return {
    start,
    stop,
    logout,
    syncGroups,
    sendWhatsAppMessage,
    isConnected: () => state.connectionState === 'connected',
    getStatus: () => ({ ...state }),
  };
}