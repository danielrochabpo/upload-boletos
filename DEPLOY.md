# Deploy no Coolify (VPS Hostinger)

## Pré-requisitos
- VPS com Ubuntu 24.04 e Coolify instalado (já configurado no seu servidor)
- Repositório GitHub (privado ou público)

---

## Passo 1 — Subir o código no GitHub

```bash
git init
git add .
git commit -m "Sistema de upload de boletos"
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

---

## Passo 2 — Criar o projeto no Coolify

1. Acesse o painel do Coolify no seu VPS
2. Clique em **New Resource → Application**
3. Selecione **GitHub** e autorize o acesso
4. Escolha o repositório do projeto
5. Em **Build Pack**, selecione **Docker Compose**
6. Clique em **Continue**

---

## Passo 3 — Configurar as variáveis de ambiente

No Coolify, vá em **Environment Variables** e adicione:

| Variável | Valor |
|---|---|
| `ADMIN_PASSWORD` | Sua senha do painel admin |
| `SESSION_SECRET` | String aleatória longa (ex: gere em [randomkeygen.com](https://randomkeygen.com)) |
| `SMTP_USER` | Seu Gmail (ex: seuemail@gmail.com) |
| `SMTP_PASS` | Senha de app do Gmail (veja abaixo) |
| `ADMIN_EMAIL` | E-mail que receberá notificações |
| `SMTP_HOST` | smtp.gmail.com |
| `SMTP_PORT` | 587 |
| `SMTP_SECURE` | false |

---

## Passo 4 — Configurar senha de app do Gmail

1. Acesse [myaccount.google.com](https://myaccount.google.com)
2. Vá em **Segurança → Verificação em duas etapas** (ative se necessário)
3. Vá em **Segurança → Senhas de app**
4. Crie uma senha para "E-mail / Windows" (ou qualquer nome)
5. Copie os 16 caracteres gerados → use como `SMTP_PASS`

---

## Passo 5 — Configurar volume persistente

No Coolify, vá em **Storages/Volumes** e adicione:

- **Source**: `uploads_data` (ou deixe o Coolify criar automaticamente)
- **Destination**: `/app/uploads`

Isso garante que os arquivos dos clientes **não sejam perdidos** em redeploys.

---

## Passo 6 — Configurar domínio

No Coolify, vá em **Domains** e adicione seu domínio.  
O Coolify gera o certificado SSL automaticamente via Let's Encrypt.

---

## Passo 7 — Deploy

Clique em **Deploy** e aguarde. Acesse seu domínio:

- **Página do cliente**: `https://seudominio.com`
- **Painel admin**: `https://seudominio.com/admin`

---

## Estrutura das pastas de upload

Cada envio cria uma subpasta em `uploads/`:

```
uploads/
├── 2026-04-30T14-30-00_ABC123_Empresa_XYZ/
│   ├── info.json          ← dados do cliente (nome, CPF, e-mail, etc.)
│   ├── boleto_abril.pdf
│   └── planilha.xlsx
└── 2026-04-30T15-00-00_DEF456_Joao_Silva/
    ├── info.json
    └── boleto.pdf
```

---

## Testar localmente antes do deploy

```bash
# Instalar dependências
npm install

# Criar arquivo .env
cp .env.example .env
# Edite o .env com suas configurações reais

# Iniciar servidor
npm start
# Acesse: http://localhost:3000
```
