# Keepy Venom

Servidor WhatsApp para o Keepy usando Venom-bot.

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Health check |
| GET | `/health` | Status detalhado |
| POST | `/session/start` | Inicia nova sessão |
| GET | `/session/:id/status` | Status da sessão |
| POST | `/session/:id/logout` | Encerra sessão |
| POST | `/message/send` | Envia mensagem texto |
| POST | `/message/send-file` | Envia arquivo |
| GET | `/sessions` | Lista sessões ativas |

## Variáveis de Ambiente

- `PORT` - Porta do servidor
- `WEBHOOK_URL` - URL do webhook Supabase
- `API_SECRET` - Chave para autenticação

## Deploy

Railway com Dockerfile.
