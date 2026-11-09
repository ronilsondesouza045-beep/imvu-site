# IMVU Radar — Web

Versão web do **IMVU Radar**: qualquer pessoa digita um nick e vê, em tempo real, em qual sala a conta está, a privacidade da sala, o link direto `imvu://room/...` e os ocupantes com avatar 2D.

## Online agora

- **Site:** https://imvu-radar-web.netlify.app
- **Backend:** https://imvu-radar-backend.onrender.com
- **Health:** https://imvu-radar-backend.onrender.com/health
- **Repo:** https://github.com/ronilsondesouza045-beep/imvu-site
- **Painel Render:** https://dashboard.render.com/web/srv-dbp5ob0n74is73cuq7jg

O Render faz auto-deploy a cada push na `main`. O frontend na Netlify é um deploy manual; para atualizar depois de mudar o `frontend/`:

```powershell
cd C:\Users\ronis\Desktop\imvu-site\frontend
netlify deploy --prod --dir . --no-build
```

O backend foi escrito em Node.js replicando o que o app Android (Kotlin) já faz:

- login na API do IMVU → `sauce` + `cid` + `session_id`
- resolução de nick → `cid`
- leitura de salas, roster e `avatar_portrait_image`
- conexão no WebSocket do IMVU (IMQ), assinatura das filas `chat-<cid>-*`
- eventos de entrada/saída em tempo real

```
frontend (HTML/JS/Tailwind)
        │  WebSocket (JSON)
        ▼
backend Node.js (Express + ws)
        │  REST + WebSocket
        ▼
api.imvu.com  +  wss://wss-imq.imvu.com/streaming/imvu_pre
```

---

## Estrutura

```
imvu-site/
├─ backend/
│  ├─ server.js          # Express + WebSocketServer + /health + /api/avatar
│  ├─ src/
│  │  ├─ imvu.js         # REST do IMVU (login, resolve, sala, roster, avatar)
│  │  ├─ imq.js          # IMQ (connect, subscribe, unsubscribe, presença)
│  │  └─ tracker.js      # orquestra alvo, sala, ocupantes e eventos
│  ├─ package.json
│  ├─ .env               # credenciais + portas (NÃO commitar)
│  └─ .env.example
├─ frontend/
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js
│  ├─ config.js          # URL do backend no deploy
│  ├─ vercel.json
│  └─ netlify.toml
├─ render.yaml
└─ README.md
```

---

## Rodar localmente

Requisitos: **Node.js 20+** (testado no Node 24) e npm.

### 1. Backend

```powershell
cd C:\Users\ronis\Desktop\imvu-site\backend
npm install
node server.js
```

O backend sobe em **http://localhost:8080**. Ele já serve o frontend em `/`, então basta abrir:

```
http://localhost:8080
```

Teste rápido:

```powershell
curl.exe http://localhost:8080/health
curl.exe "http://localhost:8080/api/resolve?nick=tropinha1"
```

### 2. Frontend separado (opcional)

Se quiser rodar o frontend fora do backend:

```powershell
cd C:\Users\ronis\Desktop\imvu-site\frontend
npx serve -l 5500
```

Abra com a URL do backend explícita:

```
http://localhost:5500/?backend=http://localhost:8080
```

Ou edite `frontend/config.js`:

```js
window.RADAR_BACKEND = "http://localhost:8080";
```

### 3. Variáveis do backend

`backend/.env`:

```env
PORT=8080
IMVU_USER=sua_conta
IMVU_PASS=sua_senha
CORS_ORIGIN=*
MAX_WATCHERS=20
TARGET_ROOM_SCAN=800
OWN_ROOM_SCAN=60
```

| Variável | Para que serve |
|---|---|
| `IMVU_USER` / `IMVU_PASS` | conta usada pelo backend para login e IMQ |
| `CORS_ORIGIN` | `*` ou lista de origens separadas por vírgula |
| `MAX_WATCHERS` | limite de navegadores vigiando ao mesmo tempo |
| `TARGET_ROOM_SCAN` | quantas filas `chat-<cid>-1..N` assinar (1–800) |
| `OWN_ROOM_SCAN` | quantas salas próprias do alvo varrer no sync inicial |
| `PROBE_INTERVAL_MS` | intervalo do probe de filas (padrão 15000) |
| `PROBE_TIMEOUT_MS` | timeout do probe (padrão 12000) |
| `ROOM_REFRESH_MS` | atualização periódica do roster (padrão 20000) |

A conta em `IMVU_USER` precisa existir e conseguir logar na API. Use uma conta dedicada; nunca coloque as credenciais no frontend.

---

## O que foi extraído do Kotlin

Arquivos de referência: `app/src/main/java/br/com/imvuradar/app/core/ImvuApi.kt`, `ImqClient.kt`, `Tracker.kt` e `Config.kt`.

| Operação | Endpoint / mensagem |
|---|---|
| API base | `https://api.imvu.com` |
| IMQ WS | `wss://wss-imq.imvu.com/streaming/imvu_pre` |
| Login | `POST /login` com `{gdpr_cookie_acceptance, username, password, remember_device}` |
| Sauce | `login.denormalized[*].data.sauce` |
| Sessão | `GET /login/me` → `relations.quick_chat_profile` (cid) e `data.session_id` |
| Resolver nick | `GET /user?username=<nick>` |
| Usuário por cid | `GET /user/user-<cid>` |
| Lista de salas | `GET /room_list/room_list-<botCid>-<friends|recent|explore|feature>/rooms` |
| Metadados da sala | `GET /room/room-<roomId>` → `name`, `privacy`, `occupancy`, `capacity`, `owner_avatarname` |
| Roster | `GET /chat/chat-<roomId>/participants` |
| Presença | `GET /presence/presence-<cid>` |
| Índice extra (opcional) | `https://catvu.live/api/private-room/find?username=<nick>` |

### Protocolo IMQ (idêntico ao `ImqClient.kt`)

1. Abrir `wss://wss-imq.imvu.com/streaming/imvu_pre`.
2. Enviar `msg_c2g_connect`:

```json
{
  "record": "msg_c2g_connect",
  "user_id": "<cid do bot>",
  "cookie": "<session_id em base64>",
  "metadata": [
    { "record": "metadata", "key": "app", "value": "<imvu_next em base64>" },
    { "record": "metadata", "key": "platform_type", "value": "<big em base64>" }
  ],
  "op_id": 1001
}
```

3. Ao receber `msg_g2c_result` com `status: 0` e o `op_id` do connect, enviar `{"record":"msg_c2g_open_floodgates"}`.
4. Assinar as filas com `msg_c2g_subscribe`:

```json
{
  "record": "msg_c2g_subscribe",
  "queues_with_results": [
    { "record": "subscription", "name": "inv:/chat/chat-<cid>-1", "op_id": 1002 },
    { "record": "subscription", "name": "inv:/presence/presence-<cid>", "op_id": 1003 },
    { "record": "subscription", "name": "inv:/user/user-<cid>", "op_id": 1004 }
  ]
}
```

Filas usadas por alvo: `inv:/chat/chat-<cid>-1..800`, `inv:/user/user-<cid>` e `inv:/presence/presence-<cid>`. A sala atual também é assinada como `inv:/chat/chat-<roomId>`.

5. Eventos:
   - `msg_g2c_send_message` com `mount: "edge:participants"` → `message` em base64 com `{action, objects}`; os cids saem de `objects` por `/user-(\d+)`.
   - `msg_g2c_state_change` na fila `presence-<cid>` → propriedades em base64; se vier `room`, `room_id`, `location`, `current_room` ou `chat_room`, é a sala atual.
6. Ao parar de vigiar, o backend envia `msg_c2g_unsubscribe` com a mesma estrutura de `queues_with_results` e para de reassinar no keepalive.
7. Keepalive: `{"record":"msg_c2g_ping"}` a cada 15s; watchdog de 60s sem mensagem; reconexão com backoff de 5/15/30/60/120/300s.

> O campo `avatar_portrait_image` às vezes vem como um PNG vazio no crop `dressup_front_heads`. O proxy `/api/avatar` detecta isso e cai automaticamente para o `avatar_image` completo (mesma URL sem query string).

---

## WebSocket do site (frontend ↔ backend)

O frontend conecta em `ws://localhost:8080` (ou `wss://<backend>`).

Cliente → backend:

```json
{ "type": "watch", "nick": "AnaZaniel" }
{ "type": "stop" }
{ "type": "ping" }
```

Backend → cliente:

```json
{ "type": "hello", "service": "imvu-radar", "version": "1.0.0" }
{ "type": "watching", "target": { "cid": "104826507", "username": "AnaZaniel", "displayName": "Ana", "avatar": "...", "portrait": "...", "online": true } }
{ "type": "status", "state": "loading|online|offline|error", "message": "..." }
{ "type": "room", "room": { "roomId": "128923122-3240", "name": "Gallaway", "privacy": "public", "privacyLabel": "Pública", "owner": "aens", "directLink": "imvu://room/aens/Gallaway", "webLink": "https://www.imvu.com/next/chat/room-128923122-3240/" }, "occupants": [], "total": 5 }
{ "type": "occupant_join", "occupant": { "cid": "...", "username": "...", "displayName": "...", "avatar": "..." }, "total": 6 }
{ "type": "occupant_leave", "cid": "...", "occupant": { "...": "..." }, "total": 5 }
{ "type": "room_leave", "room": { "...": "..." }, "message": "Saiu da sala" }
{ "type": "offline", "message": "Sem sala no momento" }
{ "type": "error", "code": "nick_not_found", "message": "Nick ... nao encontrado" }
```

Quando o navegador fecha a aba, o servidor remove o watcher, dá unsubscribe nas filas do alvo e, se não houver mais ninguém vigiando, remove a assinatura da sala.

---

## Deploy gratuito

### Backend no Render

1. Suba o projeto para um repositório no GitHub.
2. No Render: **New → Blueprint** e selecione o repositório. O `render.yaml` da raiz cria o serviço.
   - Se preferir manual: **New → Web Service**, root directory `backend`, build `npm install`, start `npm start`.
3. Preencha as variáveis secretas quando o Render pedir:
   - `IMVU_USER`
   - `IMVU_PASS`
4. Confirme `CORS_ORIGIN=*` (ou a URL do frontend).
5. Após o deploy, teste:

```
https://SEU-SERVICO.onrender.com/health
```

6. Copie a URL do serviço. Você vai usá-la no frontend.

> O plano free do Render dorme após alguns minutos sem tráfego. A primeira conexão depois do sono demora ~20–40s; o frontend reconecta sozinho e reenvia o `watch`.

### Frontend na Vercel

1. Edite `frontend/config.js`:

```js
window.RADAR_BACKEND = "https://SEU-SERVICO.onrender.com";
```

2. Na Vercel: **Add New → Project**, importe o repositório.
3. Em **Root Directory**, escolha `frontend`.
4. Framework Preset: **Other**. Build Command: vazio. Output Directory: `.`.
5. Deploy. O `vercel.json` já define os headers básicos.

Abra a URL da Vercel. O app conecta em `wss://SEU-SERVICO.onrender.com`.

### Frontend na Netlify (alternativa)

1. Edite `frontend/config.js` com a URL do Render.
2. Netlify: **Add new site → Import an existing project**.
3. Base directory: `frontend`. Publish directory: `.`. Build command: vazio.
4. Deploy. O `netlify.toml` já está pronto.

### Cloudflare Workers?

O backend usa `ws` com uma conexão de longa duração para o IMQ e processos em memória para os watchers. Workers não rodam esse modelo diretamente; para Cloudflare seria necessário reescrever com **Durable Objects** e a API WebSocket do runtime. Para o caminho gratuito e sem reescrita, use **Render** (ou Railway/Fly.io).

### Deploy em um único serviço (opcional)

Para servir frontend e backend juntos no Render:

- Root Directory: raiz do repositório
- Build Command: `cd backend && npm install`
- Start Command: `node backend/server.js`

Nesse caso, deixe `frontend/config.js` vazio e abra a URL do Render direto. O backend serve `../frontend` automaticamente.

---

## Problemas comuns

| Sintoma | Causa provável | Correção |
|---|---|---|
| `login recusado (HTTP 403/401)` | credenciais inválidas, 2FA ou bloqueio de região | use uma conta dedicada que consiga logar em `api.imvu.com` |
| `nick nao encontrado` | você digitou o display name, não o username | use o username exato do IMVU |
| `IMQ autenticacao falhou` | sessão expirada | o backend força novo login e reconecta; veja o log |
| Frontend conecta mas não recebe nada | backend dormindo ou CORS | abra `/health`; ajuste `CORS_ORIGIN` |
| `Mixed Content` no navegador | frontend HTTPS tentando backend HTTP | use HTTPS/WSS no backend |
| Avatar preto/vazio | portrait vazio no IMVU | o proxy já cai para o avatar completo; limpe o cache se precisar |
| Primeira vigilância demora | sync inicial (listas + salas + probe) | é normal: 10–30s; o status mostra cada etapa |

---

## Notas técnicas

- O backend usa **uma** conta IMVU para todas as consultas; os watchers compartilham a mesma sessão e a mesma conexão IMQ.
- Se o app Android estiver rodando com a mesma conta, os dois logins podem competir pela sessão. Use uma conta dedicada para o backend ou pare o app durante o teste.
- O `imvu://` é exibido em formato legível na interface, mas o botão **Copiar link** copia a versão URL-encoded que o cliente do IMVU espera.
- O sync inicial tenta, em ordem: lista de amigos do bot → listas oficiais (`friends`, `recent`, `explore`) → catvu → salas próprias do alvo → probe das filas IMQ. Depois disso o IMQ manda.
- O probe assina `chat-<cid>-1..800` e considera fila viva quando o gateway responde `status: 0`. As heurísticas de sala privada seguem o `Tracker.kt`.
- `MAX_WATCHERS` limita o custo. Cada alvo assina até 800 filas; com muitos alvos simultâneos, aumente apenas se o host aguentar.
- A API do IMVU não é oficial/documentada para esse uso e pode mudar sem aviso. Se um endpoint mudar, ajuste `backend/src/imvu.js`.
- Credenciais ficam somente no `.env`/variáveis de ambiente do backend. O frontend nunca as recebe.
