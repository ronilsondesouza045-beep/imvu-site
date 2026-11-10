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
│  │  ├─ tracker.js      # rastreador (não alterado pelo módulo de rádio)
│  │  └─ musicBot.js     # bot de rádio (@imvu/client + @imvu/imq)
│  ├─ package.json
│  ├─ .env               # credenciais + portas (NÃO commitar)
│  └─ .env.example
├─ frontend/
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js             # rastreador
│  ├─ radio.js           # aba Rádio para Sala
│  ├─ sw.js / manifest.json / icons/
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
OWN_ROOM_SCAN=120
CATVU_RETRY_MS=20000

# Music Bot (conta separada; para usar a conta do rastreador, BOT_ALLOW_SAME_ACCOUNT=1)
BOT_EMAIL=seu_email_do_bot@gmail.com
BOT_PASSWORD=sua_senha_do_bot
BOT_USERNAME=nome_do_bot
BOT_ALLOW_SAME_ACCOUNT=0
BOT_SEND_INTERVAL_MS=1500
# URL publica do backend para o stream MP3 (no Render, RENDER_EXTERNAL_URL e automatica)
PUBLIC_BASE_URL=https://seu-backend.onrender.com
# Segredo do token do stream (opcional; se vazio, aleatorio por processo)
RADIO_SECRET=
```

| Variável | Para que serve |
|---|---|
| `IMVU_USER` / `IMVU_PASS` | conta usada pelo rastreador para login e IMQ |
| `BOT_EMAIL` / `BOT_USERNAME` / `BOT_PASSWORD` | conta do bot de rádio (recomendado: separada do rastreador) |
| `BOT_ALLOW_SAME_ACCOUNT` | `1` permite reutilizar a conta do rastreador no bot; padrão `0` (bloqueia) |
| `BOT_SEND_INTERVAL_MS` | intervalo mínimo entre mensagens do bot (padrão 1500 ms) |
| `PUBLIC_BASE_URL` | URL pública do backend usada no stream MP3; no Render, `RENDER_EXTERNAL_URL` é usada automaticamente |
| `RADIO_SECRET` | segredo do token do stream (opcional; sem ele, o token é aleatório por processo) |
| `CORS_ORIGIN` | `*` ou lista de origens separadas por vírgula |
| `MAX_WATCHERS` | limite de navegadores vigiando ao mesmo tempo |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | chaves Web Push (gere com `npx web-push generate-vapid-keys --json`) |
| `VAPID_SUBJECT` | contato do VAPID, ex. `mailto:seu@email` |
| `SITE_URL` | URL pública do frontend usada no clique da notificação |
| `ALERT_TTL_MS` | quanto tempo um alerta push fica ativo (padrão 2h) |
| `MAX_ALERTS` | limite de assinaturas push simultâneas (padrão 30) |
| `TARGET_ROOM_SCAN` | quantas filas `chat-<cid>-1..N` assinar (1–800) |
| `OWN_ROOM_SCAN` | quantas salas próprias do alvo varrer no sync inicial (padrão 120) |
| `CATVU_RETRY_MS` | intervalo de rechecagem do catvu quando o alvo ainda não foi localizado (padrão 20000) |
| `PROBE_INTERVAL_MS` | intervalo do probe de filas (padrão 15000) |
| `PROBE_TIMEOUT_MS` | timeout do probe (padrão 12000) |
| `ROOM_REFRESH_MS` | atualização periódica do roster (padrão 20000) |

A conta em `IMVU_USER` precisa existir e conseguir logar na API. Use uma conta dedicada; nunca coloque as credenciais no frontend. A conta do bot (`BOT_*`) deve ser, de preferência, **outra** conta, com permissão para entrar na sala onde o DJ vai tocar e ser **Admin** dela. Para reutilizar a conta do rastreador, veja `BOT_ALLOW_SAME_ACCOUNT` na seção do Music Bot.

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
| Usuário por cid | `GET /user/user-<cid>` → `relations.current_room` = sala atual |
| Lista de salas | `GET /room_list/room_list-<botCid>-<friends|recent|explore|feature>/rooms` |
| Metadados da sala | `GET /room/room-<roomId>` → `name`, `privacy`, `occupancy`, `capacity`, `owner_avatarname` |
| Roster | `GET /chat/chat-<roomId>/participants` |
| Presença | `GET /presence/presence-<cid>` |
| Sala atual (primário) | `GET /user/user-<cid>` → `relations.current_room` |
| Sala atual / roster (fallback) | `https://catvu.live/api/private-room/find?username=<nick>` + `/api/private-room/watch/<roomId>` |

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

### Alvo parado e sala privada

O IMQ só manda evento de presença quando o alvo **entra, sai ou troca de sala**. Se ele já estiver parado dentro de uma sala quando o vigia começa, não existe evento para esperar. A leitura principal agora é feita direto no IMVU:

1. `GET /user/user-<cid>` devolve `relations.current_room`, por exemplo `https://api.imvu.com/room/room-66280412-137`. Esse é o `roomId` **atual** do alvo, mesmo parado e mesmo em sala privada.
2. O backend lê essa relation no início do watch e recheca a cada ~20s (`syncCurrentRoom`), em paralelo ao IMQ. Se o `roomId` mudar, a sala é atualizada; se for privada, a tag vem como privada e o link direto é montado pelo dono do `roomId`.
3. O IMQ continua sendo a fonte em tempo real de entrada/saída. Também tratamos `msg_g2c_create_mount` e `msg_g2c_state_change` na fila `presence-<cid>`, que podem entregar o estado inicial da sala na assinatura.
4. O catvu continua como fallback opcional (`find` + `watch`) para nome de sala e roster inicial quando o host consegue acessá-lo. Em Render/cloud o catvu pode estourar timeout ou ser bloqueado; por isso ele **não é mais requisito** para achar o alvo.
5. Se o room node do IMVU vier 403 (sala privada de terceiro), o nome cai para `Sala privada N`; os ocupantes vêm do roster autenticado quando liberado e dos eventos `edge:participants` do IMQ.

O catvu é rechecado a cada `CATVU_RETRY_MS` apenas enquanto o alvo ainda não foi localizado pela relation, pelas listas, pelas salas próprias ou pelo probe.

### Alertas no navegador / Web Push

O sino no header abre o painel **Alertas**:

1. **Ativar alertas** pede permissão de notificação, registra o `sw.js`, assina o Web Push com a chave VAPID e envia `alert_start` pelo WebSocket.
2. O backend mantém o rastreio do nick mesmo quando a aba fecha. O alerta dura `ALERT_TTL_MS` (padrão 2 horas) e pode ser desativado no painel.
3. Notificações padrão:
   - alvo entrou, saiu ou trocou de sala;
   - sala atual no momento em que o alerta é ativado.
4. Opcional: **Avisar também quando alguém entrar ou sair da sala** (`occupants: true`).
5. Clique na notificação abre o site já no nick monitorado.

Se o navegador não suportar Push (ou a assinatura demorar), o painel cai no modo **aba aberta**: as notificações continuam enquanto a aba estiver aberta/minimizada. No iPhone, instale o site na tela inicial (iOS 16.4+) para o push funcionar.

O backend guarda as assinaturas em memória. Se o Render reiniciar, reative os alertas no painel. O workflow `.github/workflows/keepalive.yml` faz um ping no `/health` a cada 5 minutos para evitar que o Render free durma; ele usa os minutos gratuitos de Actions de repositório público.

### Mobile

Abaixo de 640px o site muda para um layout compacto: hero curto, cards de alvo/sala lado a lado, ocupantes em 3 colunas e painel de alertas como bottom sheet. Tudo cabe na tela do celular sem precisar descer para ver sala e ocupantes.

### Music Bot / DJ para Sala

O site ganhou a aba **🎧 Rádio para Sala**, agora com fila e busca livre no YouTube. O bot usa `@imvu/client` e `@imvu/imq` para logar, entrar na sala, ouvir o chat e responder aos comandos.

**O controle automático do rádio é da conta dona da sala (Host).** O IMVU não tem um papel "Admin": o **Host é o dono da sala**. Dá para adicionar o bot como **Moderador** (Web/Desktop: **My Rooms > sala > engrenagem > Settings > Choose Moderators**; Classic: **Chat Rooms > Manage > Edit > Room Moderators**; Mobile: **Settings > Manage Moderators**; o bot precisa estar na lista de amigos do dono), mas no teste o servidor negou `media_targets` e o update do `media_player` para moderador (`not_allowed_to_perform_operation` / `Not authorized`). Para tocar automático, use a **conta dona da sala como conta do bot** (`BOT_USERNAME` = dono; tracker pode continuar em `IMVU_USER`) ou uma **sala que o próprio bot seja dono**. Sem isso, o bot manda o link MP3 no chat; copie em **Media > Radio Streaming > Load** e o áudio funciona.

**Fila por sala.** Cada `!play` adiciona uma música à fila e o bot toca uma de cada vez. `!skip` pula para a próxima e `!stop` limpa a fila e para. O backend mantém um stream MP3 contínuo por sala em `/api/radio/<sala>/<token>.mp3`; o áudio do YouTube é extraído pelo `yt-dlp` e convertido em MP3 128 kbps pelo `ffmpeg-static`. O link do YouTube em si não é MP3 nem contínuo, por isso o proxy é necessário.

**Conta:** recomendado usar uma conta separada do rastreador. Para reutilizar a conta do rastreador, defina `BOT_ALLOW_SAME_ACCOUNT=1` e use as mesmas `BOT_USERNAME`/`BOT_PASSWORD` de `IMVU_USER`/`IMVU_PASS`. No teste com `tropinha1` o radar continuou `loggedIn/IMQ ready` e o bot ficou na sala `The Penthouse`; o painel mostra o aviso de conta compartilhada. A conta precisa ser registrada/antiga: a Guest nova `VUmusic` foi recusada no join com `CHAT_PARTICIPANT-011`; a `tropinha1` entrou.

### Modo de manutenção do Music Bot

Para pausar **somente a música** sem afetar o radar:

1. Defina `BOT_MAINTENANCE=true` no `backend/.env` e em **Render > Environment**.
2. Salve/redeploy. O backend não loga a conta do bot, não inicia ffmpeg/stream e:
   - `/api/status` retorna `{ maintenance: true }`;
   - `/api/bot/*` e `/api/radio/*` retornam **503** com `O bot de música está em manutenção. Voltamos dia 23!`;
   - a aba do site mostra o card de manutenção e os inputs ficam desativados;
   - o tracker, o `/health`, o WebSocket do radar e o resto do site continuam normais.
3. Para voltar no dia 23, basta trocar para `BOT_MAINTENANCE=false` (ou remover a variável), salvar e reiniciar/redeploy. Não precisa alterar código; depois ative o bot na sala normalmente.

Configuração em `backend/.env`:

```env
BOT_EMAIL=seu_email_do_bot@gmail.com
BOT_PASSWORD=sua_senha_do_bot
BOT_USERNAME=nome_do_bot
BOT_ALLOW_SAME_ACCOUNT=0
BOT_SEND_INTERVAL_MS=1500
PUBLIC_BASE_URL=https://seu-backend.onrender.com
RADIO_SECRET=uma_string_longa_opcional
```

No Render, adicione essas variáveis em **Environment**. O `RENDER_EXTERNAL_URL` é automático e usado como base do stream quando `PUBLIC_BASE_URL` não está definido. No deploy atual o bot está com a conta do rastreador (`BOT_USERNAME=tropinha1`, `BOT_ALLOW_SAME_ACCOUNT=1`).

**Dependências e execução:**

```powershell
cd C:\Users\ronis\Desktop\imvu-site\backend
npm install
# as libs novas: ytdl-core, play-dl e ffmpeg-static
node server.js
```

O `postinstall` baixa o binário standalone do `yt-dlp` em `backend/bin` (Windows/Linux) e o `ffmpeg-static` baixa o `ffmpeg`. O `yt-dlp` é o extrator principal; `play-dl` e `ytdl-core` ficam como fallback. Em servidor/datacenter o YouTube pode bloquear a extração; nesse caso o bot avisa no chat e o site mostra o erro.

**Como usar:**

1. Abra o site, aba **🎧 Rádio para Sala**, cole o ID da sala e clique em **Ativar DJ Bot**.
2. Dê **Admin** ao nick do bot na sala.
3. Peça **qualquer música** no campo **Pedir música** do site ou no chat:
   - `!play Michael Jackson - Billie Jean` — busca no YouTube e adiciona à fila;
   - `!skip` — pula para a próxima da fila;
   - `!stop` — limpa a fila e para a música.
4. O botão **Desconectar bot** chama `POST /api/bot/leave` e encerra a sessão; `!stop` não desconecta o bot.

**Anti-ban:** toda mensagem passa por uma fila com intervalo mínimo de **1500 ms**, cooldown de 2,5 s por usuário e limite de 12 mensagens pendentes. O bot também limita a fila a 30 músicas.

**Endpoints:**

| Método | Rota | Função |
|---|---|---|
| `POST` | `/api/bot/join` | body `{ "roomId": "391509865-1" }`; loga e entra na sala |
| `POST` | `/api/bot/leave` | sai da sala e faz logout do bot |
| `POST` | `/api/bot/play` | body `{ "query": "Michael Jackson" }`; busca e adiciona à fila |
| `GET` | `/api/bot/status` | estado do bot, sala, fila, música atual e erros |
| `GET` | `/api/radio/<sala>/<token>.mp3` | stream MP3 contínuo consumido pelo media_player |

O bot precisa ter permissão para entrar na sala (dono, amigo ou convite) e ser Admin para trocar o áudio. As rotas têm limite de 8 s por IP no join, 3 s no play e 2,5 s no leave; se quiser fechar mais o acesso, coloque autenticação na frente delas.

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
| Primeira vigilância demora | sync inicial (catvu + listas + salas + probe) | é normal: 5–30s; o status mostra cada etapa |

---

## Notas técnicas

- O backend usa **uma** conta IMVU para todas as consultas; os watchers compartilham a mesma sessão e a mesma conexão IMQ.
- Se o app Android estiver rodando com a mesma conta, os dois logins podem competir pela sessão. Use uma conta dedicada para o backend ou pare o app durante o teste.
- Não rode o backend local e o backend do Render ao mesmo tempo com a mesma conta: são duas sessões IMQ distintas. Para testar localmente, pare o serviço do Render ou use outra conta.
- O `imvu://` é exibido em formato legível na interface, mas o botão **Copiar link** copia a versão URL-encoded que o cliente do IMVU espera.
- O sync inicial tenta, em ordem: `relations.current_room` do usuário (sala atual, inclusive parado) → catvu find (fallback) → lista de amigos do bot → listas oficiais (`friends`, `recent`, `explore`) → salas próprias do alvo → probe das filas IMQ. Depois disso o IMQ manda.
- Sala privada: a relation `current_room` aponta a sala mesmo sem evento; se o roster do IMVU vier 403, os ocupantes conhecidos vêm dos eventos `edge:participants` do IMQ e o `catvu watch` (quando acessível) complementa o snapshot inicial.
- O probe assina `chat-<cid>-1..800` e considera fila viva quando o gateway responde `status: 0`. As heurísticas de sala privada seguem o `Tracker.kt`.
- `MAX_WATCHERS` limita o custo. Cada alvo assina até 800 filas; com muitos alvos simultâneos, aumente apenas se o host aguentar.
- A API do IMVU não é oficial/documentada para esse uso e pode mudar sem aviso. Se um endpoint mudar, ajuste `backend/src/imvu.js`.
- Credenciais ficam somente no `.env`/variáveis de ambiente do backend. O frontend nunca as recebe.
