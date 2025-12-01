require('dotenv').config();
const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Armazena sessões ativas
const sessions = new Map();

// Configurações
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_SECRET = process.env.API_SECRET || 'keepy-secret-key';

// Middleware de autenticação
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
};

// Envia webhook pro Supabase
async function sendWebhook(event, sessionId, data) {
  if (!WEBHOOK_URL) {
    console.log('[Webhook] URL não configurada, pulando...');
    return;
  }
  
  try {
    await axios.post(WEBHOOK_URL, {
      event,
      sessionId,
      data,
      timestamp: new Date().toISOString()
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`[Webhook] Enviado: ${event} para ${sessionId}`);
  } catch (error) {
    console.error('[Webhook] Erro:', error.message);
  }
}

// Cria nova sessão do WhatsApp
async function createSession(sessionId, webhookUrl) {
  if (sessions.has(sessionId)) {
    console.log(`[Session] ${sessionId} já existe`);
    return sessions.get(sessionId);
  }

  console.log(`[Session] Criando sessão: ${sessionId}`);

  const targetWebhook = webhookUrl || WEBHOOK_URL;

  try {
    const client = await venom.create(
      sessionId,
      (base64Qr, asciiQR) => {
        console.log(`[QR] Novo QR code para ${sessionId}`);
        sendWebhook('qr', sessionId, { qrCode: base64Qr });
      },
      (statusSession) => {
        console.log(`[Status] ${sessionId}: ${statusSession}`);
      },
      {
        headless: 'new',
        useChrome: false,
        debug: false,
        logQR: false,
        browserArgs: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ],
        autoClose: 0,
        createPathFileToken: true,
        session: sessionId
      }
    );

    client.onStateChange((state) => {
      console.log(`[State] ${sessionId}: ${state}`);
      
      if (state === 'CONNECTED') {
        sendWebhook('connected', sessionId, {});
      } else if (state === 'DISCONNECTED' || state === 'CONFLICT') {
        sendWebhook('disconnected', sessionId, { reason: state });
        sessions.delete(sessionId);
      }
    });

    client.onMessage(async (message) => {
      console.log(`[Message] De ${message.from}: ${message.body?.substring(0, 50)}...`);
      
      const messageData = {
        message_id: message.id,
        from: message.from,
        to: message.to,
        body: message.body,
        type: message.type,
        is_group: message.isGroupMsg,
        sender_name: message.sender?.pushname || message.sender?.name,
        timestamp: message.timestamp
      };

      if (message.isMedia || message.isMMS) {
        try {
          const buffer = await client.decryptFile(message);
          messageData.media_base64 = buffer.toString('base64');
          messageData.media_mimetype = message.mimetype;
          messageData.media_filename = message.filename;
        } catch (err) {
          console.error('[Media] Erro ao baixar:', err.message);
        }
      }

      sendWebhook('message', sessionId, messageData);
    });

    sessions.set(sessionId, { client, webhookUrl: targetWebhook });
    console.log(`[Session] ${sessionId} criada com sucesso`);
    
    return { client, webhookUrl: targetWebhook };

  } catch (error) {
    console.error(`[Session] Erro ao criar ${sessionId}:`, error.message);
    throw error;
  }
}

// ==================== ROTAS ====================

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'keepy-venom',
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  const sessionList = [];
  sessions.forEach((value, key) => {
    sessionList.push({ sessionId: key });
  });
  
  res.json({ 
    status: 'ok',
    sessions: sessionList,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Inicia nova sessão
app.post('/session/start', authenticate, async (req, res) => {
  const { sessionId, webhookUrl } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId é obrigatório' });
  }

  try {
    createSession(sessionId, webhookUrl).catch(err => {
      console.error('[Session] Erro em background:', err.message);
    });
    
    res.json({ 
      success: true, 
      message: 'Sessão iniciando, aguarde o QR code',
      sessionId: sessionId 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/session/:sessionId/status', authenticate, (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.json({ exists: false, status: 'not_found' });
  }

  res.json({ 
    exists: true, 
    status: 'active',
    sessionId: sessionId 
  });
});

app.post('/session/:sessionId/logout', authenticate, async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  try {
    await session.client.logout();
    await session.client.close();
    sessions.delete(sessionId);
    
    res.json({ success: true, message: 'Sessão encerrada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/message/send', authenticate, async (req, res) => {
  const { sessionId, to, message } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId é obrigatório' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  try {
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const result = await session.client.sendText(chatId, message);
    
    res.json({ 
      success: true, 
      message_id: result.id,
      to: chatId 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/message/send-file', authenticate, async (req, res) => {
  const { sessionId, to, file_base64, filename, caption } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId é obrigatório' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  try {
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const result = await session.client.sendFileFromBase64(
      chatId, 
      file_base64, 
      filename, 
      caption || ''
    );
    
    res.json({ 
      success: true, 
      message_id: result.id 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/sessions', authenticate, (req, res) => {
  const sessionList = [];
  sessions.forEach((value, key) => {
    sessionList.push({ sessionId: key });
  });
  
  res.json({ sessions: sessionList });
});

// ==================== INICIA SERVIDOR ====================

app.listen(PORT, () => {
  console.log(`🚀 Keepy Venom rodando na porta ${PORT}`);
  console.log(`📱 Webhook URL: ${WEBHOOK_URL || 'não configurada'}`);
});
