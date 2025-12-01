require('dotenv').config();
const express = require('express');
const cors = require('cors');
const venom = require('venom-bot');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Armazena sessões ativas
const sessions = new Map();

// Configurações
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // URL do Supabase Edge Function
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
async function sendWebhook(event, phone, data) {
  if (!WEBHOOK_URL) {
    console.log('[Webhook] URL não configurada, pulando...');
    return;
  }
  
  try {
    await axios.post(WEBHOOK_URL, {
      event,
      phone,
      data,
      timestamp: new Date().toISOString()
    }, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log(`[Webhook] Enviado: ${event} para ${phone}`);
  } catch (error) {
    console.error('[Webhook] Erro:', error.message);
  }
}

// Cria nova sessão do WhatsApp
async function createSession(sessionId, phone) {
  if (sessions.has(sessionId)) {
    console.log(`[Session] ${sessionId} já existe`);
    return sessions.get(sessionId);
  }

  console.log(`[Session] Criando sessão: ${sessionId}`);

  try {
    const client = await venom.create(
      sessionId,
      // Callback do QR Code
      (base64Qr, asciiQR) => {
        console.log(`[QR] Novo QR code para ${sessionId}`);
        sendWebhook('qr', phone, { 
          qr_code: base64Qr,
          session_id: sessionId 
        });
      },
      // Callback de status
      (statusSession) => {
        console.log(`[Status] ${sessionId}: ${statusSession}`);
      },
      // Opções
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

    // Eventos da sessão
    client.onStateChange((state) => {
      console.log(`[State] ${sessionId}: ${state}`);
      
      if (state === 'CONNECTED') {
        sendWebhook('connected', phone, { session_id: sessionId });
      } else if (state === 'DISCONNECTED' || state === 'CONFLICT') {
        sendWebhook('disconnected', phone, { 
          session_id: sessionId,
          reason: state 
        });
        sessions.delete(sessionId);
      }
    });

    // Recebe mensagens
    client.onMessage(async (message) => {
      console.log(`[Message] De ${message.from}: ${message.body?.substring(0, 50)}...`);
      
      // Monta dados da mensagem
      const messageData = {
        session_id: sessionId,
        message_id: message.id,
        from: message.from,
        to: message.to,
        body: message.body,
        type: message.type,
        is_group: message.isGroupMsg,
        sender_name: message.sender?.pushname || message.sender?.name,
        timestamp: message.timestamp
      };

      // Se for mídia, pega a URL
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

      sendWebhook('message', phone, messageData);
    });

    sessions.set(sessionId, { client, phone });
    console.log(`[Session] ${sessionId} criada com sucesso`);
    
    return { client, phone };

  } catch (error) {
    console.error(`[Session] Erro ao criar ${sessionId}:`, error.message);
    throw error;
  }
}

// ==================== ROTAS ====================

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'keepy-venom',
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

// Health check detalhado
app.get('/health', (req, res) => {
  const sessionList = [];
  sessions.forEach((value, key) => {
    sessionList.push({ id: key, phone: value.phone });
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
  const { phone, user_id } = req.body;
  
  if (!phone) {
    return res.status(400).json({ error: 'Phone é obrigatório' });
  }

  const sessionId = `keepy_${user_id || phone}`;
  
  try {
    // Não bloqueia esperando a sessão ser criada completamente
    createSession(sessionId, phone).catch(err => {
      console.error('[Session] Erro em background:', err.message);
    });
    
    res.json({ 
      success: true, 
      message: 'Sessão iniciando, aguarde o QR code',
      session_id: sessionId 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Status da sessão
app.get('/session/:sessionId/status', authenticate, (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.json({ exists: false, status: 'not_found' });
  }

  res.json({ 
    exists: true, 
    status: 'active',
    phone: session.phone 
  });
});

// Encerra sessão
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

// Envia mensagem de texto
app.post('/message/send', authenticate, async (req, res) => {
  const { session_id, phone, to, message } = req.body;
  
  // Encontra sessão pelo ID ou phone
  let session;
  if (session_id) {
    session = sessions.get(session_id);
  } else if (phone) {
    sessions.forEach((value, key) => {
      if (value.phone === phone) session = value;
    });
  }

  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }

  try {
    // Formata número (adiciona @c.us se necessário)
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

// Envia arquivo/imagem
app.post('/message/send-file', authenticate, async (req, res) => {
  const { session_id, to, file_base64, filename, caption } = req.body;
  
  const session = sessions.get(session_id);
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

// Lista sessões ativas
app.get('/sessions', authenticate, (req, res) => {
  const sessionList = [];
  sessions.forEach((value, key) => {
    sessionList.push({ 
      session_id: key, 
      phone: value.phone 
    });
  });
  
  res.json({ sessions: sessionList });
});

// ==================== INICIA SERVIDOR ====================

app.listen(PORT, () => {
  console.log(`🚀 Keepy Venom rodando na porta ${PORT}`);
  console.log(`📱 Webhook URL: ${WEBHOOK_URL || 'não configurada'}`);
});
