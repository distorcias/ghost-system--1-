# Ghost System · Webmail (DuckMail)

Webmail com tema Dark/White integrado à API oficial do DuckMail (`https://api.duckmail.sbs`).

## Como a autenticação funciona (conforme a documentação oficial)
- `POST /token` com `{address, password}` devolve um token Bearer (~24 h).
- O token é usado em `GET /me`, `GET /messages`, `GET /messages/{id}` e `PATCH /messages/{id}` (marcar como lida).
- **O navegador nunca vê esse token.** Ele recebe só um cookie de sessão criptografado (`HttpOnly`, `SameSite=Strict`, `Secure` em produção).
- Cada sessão só acessa a caixa da conta cujas credenciais autenticaram. Não há consulta por endereço.

## Deploy na Vercel
> Se aparecer erro de "Flask entrypoint": em **Settings → General**, mude *Framework Preset* para **Other** e deixe *Root Directory* vazio (a raiz deve conter `package.json` e `vercel.json`).

1. Envie a pasta para um repositório Git (ou rode `vercel` na pasta).
2. Em **Settings → Environment Variables**, crie: `SESSION_SECRET` (32+ caracteres; gere com `openssl rand -base64 48`), `NODE_ENV=production` e `TRUST_PROXY=1`. `DUCKMAIL_API_URL` é opcional.
3. Faça o deploy. `public/` é servido como estático e `api/index.js` roda como função serverless (rotas `/api/*`).

## Executar localmente
```bash
cp .env.example .env     # preencha SESSION_SECRET
npm install
node --env-file=.env api/index.js    # Node 20.6+
```
Abra http://localhost:3000 (localmente use `NODE_ENV=development` para o cookie funcionar em HTTP).

## Variáveis de ambiente
| Variável | Descrição |
|---|---|
| `SESSION_SECRET` | Obrigatória. Criptografa a sessão no cookie |
| `NODE_ENV` | `production` ativa cookie `Secure` |
| `DUCKMAIL_API_URL` | URL-base da API (padrão oficial) |
| `TRUST_PROXY` | `1` atrás de proxy (Vercel) |

## Segurança implementada
Sessão sem estado: o token do DuckMail fica criptografado (AES-256-GCM) dentro de cookie `HttpOnly`, ilegível pelo navegador; limite de 8 falhas de login / 15 min por IP; verificação de `Origin` nas requisições POST; validação de entrada nos dois lados; HTML dos e-mails sanitizado (`sanitize-html`) e exibido em `iframe` com `sandbox` sem scripts, e CSP que bloqueia imagens remotas (evita rastreadores); nenhuma senha, token ou conteúdo de e-mail é registrado em log.

## Limitações conhecidas
- Logout apaga o cookie, mas, sem armazenamento no servidor, o token do DuckMail continua válido até expirar (~24 h); ele só existe dentro do cookie criptografado.
- O limite de tentativas de login é por instância serverless (melhor esforço). Para proteção forte, use Vercel Firewall/WAF ou Upstash Redis.
- A busca filtra as mensagens da página carregada (a API do DuckMail para contas SMTP não tem filtro).
- Anexos são listados, mas o download não está implementado.
- Atualização automática a cada 20 s (a documentação recomenda ~2 s no máximo de frequência).
