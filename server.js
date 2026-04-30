require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const archiver = require('archiver');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('ERRO FATAL: Variável ADMIN_PASSWORD não definida. Configure o arquivo .env');
  process.exit(1);
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-este-segredo',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, sameSite: 'strict' }
}));

// Rate limiter simples em memória
const rateMap = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    let rec = rateMap.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) rec = { count: 0, resetAt: now + windowMs };
    rec.count++;
    rateMap.set(ip, rec);
    if (rec.count > max) {
      return res.status(429).json({ success: false, message: 'Muitas requisições. Aguarde alguns minutos e tente novamente.' });
    }
    next();
  };
}

// Extensões permitidas para upload
const ALLOWED_EXTS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.tiff', '.bmp', '.xlsx', '.xls', '.csv', '.doc', '.docx']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext)
      .replace(/[^\wÀ-ſ\s\-]/g, '_')
      .trim()
      .slice(0, 100);
    cb(null, base + ext);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.has(ext)) cb(null, true);
    else cb(new Error(`Tipo de arquivo não permitido: ${ext}. Use PDF, imagens ou documentos Office.`));
  },
  limits: { fileSize: 50 * 1024 * 1024, files: 20 }
});

// Middleware: cria pasta temporária antes do multer processar
function prepareDir(req, res, next) {
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  req.uploadId = `${ts}_${rnd}`;
  req.uploadDir = path.join(UPLOADS_DIR, req.uploadId);
  fs.mkdirSync(req.uploadDir, { recursive: true });
  next();
}

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.accepts('html')) return res.redirect('/admin/login');
  res.status(401).json({ success: false, message: 'Não autorizado.' });
}

// Proteção contra path traversal
function safeDir(folder) {
  const resolved = path.resolve(UPLOADS_DIR, path.basename(folder));
  if (!resolved.startsWith(path.resolve(UPLOADS_DIR))) throw new Error('Acesso negado.');
  return resolved;
}

// ─── Rota de upload (cliente) ───────────────────────────────────────────────
app.post('/upload', rateLimit(15 * 60 * 1000, 10), prepareDir, (req, res) => {
  upload.array('arquivos', 20)(req, res, async (err) => {
    const cleanup = () => {
      if (req.uploadDir && fs.existsSync(req.uploadDir))
        fs.rmSync(req.uploadDir, { recursive: true, force: true });
    };

    if (err) {
      cleanup();
      return res.status(400).json({ success: false, message: err.message });
    }

    const { nome, cpfCnpj, email, descricao } = req.body;

    if (!nome?.trim()) {
      cleanup();
      return res.status(400).json({ success: false, message: 'O campo Nome é obrigatório.' });
    }
    if (!req.files?.length) {
      cleanup();
      return res.status(400).json({ success: false, message: 'Selecione pelo menos um arquivo.' });
    }

    const info = {
      nome: nome.trim(),
      cpfCnpj: cpfCnpj?.trim() || '',
      email: email?.trim() || '',
      descricao: descricao?.trim() || '',
      timestamp: new Date().toISOString(),
      arquivos: req.files.map(f => ({ nome: f.filename, tamanho: f.size, tipo: f.mimetype }))
    };

    fs.writeFileSync(path.join(req.uploadDir, 'info.json'), JSON.stringify(info, null, 2));

    // Renomeia a pasta incluindo o nome do cliente
    const nomeDir = nome.trim()
      .replace(/[^\wÀ-ſ\s]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 40);
    const finalDirName = `${req.uploadId}_${nomeDir}`;
    const finalDir = path.join(UPLOADS_DIR, finalDirName);
    fs.renameSync(req.uploadDir, finalDir);

    // Notificação por e-mail (não bloqueia a resposta)
    sendEmail(info, finalDirName).catch(e =>
      console.error('[E-mail] Erro ao enviar notificação:', e.message)
    );

    res.json({
      success: true,
      message: `${req.files.length} arquivo(s) recebido(s) com sucesso!`
    });
  });
});

// ─── Notificação por e-mail ─────────────────────────────────────────────────
async function sendEmail(info, folderName) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const dt = new Date(info.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const fileRows = info.arquivos.map(f =>
    `<tr>
      <td style="padding:7px 14px;border-bottom:1px solid #eee">${f.nome}</td>
      <td style="padding:7px 14px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${(f.tamanho / 1024).toFixed(1)} KB</td>
    </tr>`
  ).join('');

  await transporter.sendMail({
    from: `"Boletos – Agendamento" <${process.env.SMTP_USER}>`,
    to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    subject: `📄 Novo envio: ${info.nome} (${info.arquivos.length} arquivo${info.arquivos.length > 1 ? 's' : ''})`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;border:1px solid #dde;border-radius:10px;overflow:hidden">
  <div style="background:linear-gradient(135deg,#1B3A6B,#2563EB);color:white;padding:24px 28px">
    <h2 style="margin:0;font-size:1.2rem">📄 Novo Envio de Boletos</h2>
    <p style="margin:5px 0 0;opacity:.8;font-size:.875rem">${dt}</p>
  </div>
  <div style="padding:24px 28px;background:#fff">
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:.9rem">
      <tr style="background:#F8FAFC"><td style="padding:9px 14px;font-weight:bold;width:130px;color:#374151">Cliente</td><td style="padding:9px 14px">${info.nome}</td></tr>
      <tr><td style="padding:9px 14px;font-weight:bold;color:#374151">CPF/CNPJ</td><td style="padding:9px 14px">${info.cpfCnpj || '<em style="color:#999">não informado</em>'}</td></tr>
      <tr style="background:#F8FAFC"><td style="padding:9px 14px;font-weight:bold;color:#374151">E-mail</td><td style="padding:9px 14px">${info.email || '<em style="color:#999">não informado</em>'}</td></tr>
      <tr><td style="padding:9px 14px;font-weight:bold;color:#374151">Observações</td><td style="padding:9px 14px">${info.descricao || '<em style="color:#999">nenhuma</em>'}</td></tr>
    </table>
    <h3 style="font-size:.95rem;color:#1B3A6B;margin:0 0 12px">Arquivos recebidos (${info.arquivos.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:.875rem;border:1px solid #eee;border-radius:6px;overflow:hidden">
      <thead>
        <tr style="background:#1B3A6B;color:white">
          <th style="padding:8px 14px;text-align:left;font-weight:600">Arquivo</th>
          <th style="padding:8px 14px;text-align:left;font-weight:600">Tamanho</th>
        </tr>
      </thead>
      <tbody>${fileRows}</tbody>
    </table>
    <p style="margin-top:20px;font-size:.75rem;color:#aaa">Pasta no servidor: <code>${folderName}</code></p>
  </div>
</div>`
  });
}

// ─── Admin: login ────────────────────────────────────────────────────────────
app.get('/admin/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/admin/login', rateLimit(15 * 60 * 1000, 10), (req, res) => {
  if (req.body.senha === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Senha incorreta.' });
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ─── Admin: painel ───────────────────────────────────────────────────────────
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// Lista todos os envios
app.get('/admin/api/uploads', requireAuth, (req, res) => {
  try {
    const items = fs.readdirSync(UPLOADS_DIR)
      .filter(name => {
        try {
          return fs.statSync(path.join(UPLOADS_DIR, name)).isDirectory()
            && !name.startsWith('_temp');
        } catch { return false; }
      })
      .map(name => {
        const dir = path.join(UPLOADS_DIR, name);
        let info = {};
        try { info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf-8')); } catch {}
        const files = fs.readdirSync(dir).filter(f => f !== 'info.json');
        const totalSize = files.reduce((s, f) => {
          try { return s + fs.statSync(path.join(dir, f)).size; } catch { return s; }
        }, 0);
        return {
          pasta: name,
          nome: info.nome || name,
          cpfCnpj: info.cpfCnpj || '',
          email: info.email || '',
          descricao: info.descricao || '',
          timestamp: info.timestamp || new Date(0).toISOString(),
          arquivos: info.arquivos || files.map(f => ({ nome: f, tamanho: 0 })),
          totalArquivos: files.length,
          totalTamanho: totalSize
        };
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ success: true, uploads: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Download de uma pasta como ZIP
app.get('/admin/download/:folder', requireAuth, (req, res) => {
  let dir;
  try { dir = safeDir(req.params.folder); } catch { return res.status(400).send('Acesso negado.'); }
  if (!fs.existsSync(dir)) return res.status(404).send('Pasta não encontrada.');

  const folderName = path.basename(dir);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(folderName)}.zip"`);

  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.on('error', err => res.status(500).send(err.message));
  arc.pipe(res);
  fs.readdirSync(dir)
    .filter(f => f !== 'info.json')
    .forEach(f => arc.file(path.join(dir, f), { name: f }));
  arc.finalize();
});

// Download de arquivo individual
app.get('/admin/download/:folder/:file', requireAuth, (req, res) => {
  let dir;
  try { dir = safeDir(req.params.folder); } catch { return res.status(400).send('Acesso negado.'); }
  const file = path.basename(req.params.file);
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath) || file === 'info.json') return res.status(404).send('Arquivo não encontrado.');
  res.download(filePath);
});

// Download de TODOS os envios em um único ZIP
app.get('/admin/download-all', requireAuth, (req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="todos-boletos-${date}.zip"`);

  const arc = archiver('zip', { zlib: { level: 6 } });
  arc.on('error', err => res.status(500).send(err.message));
  arc.pipe(res);

  fs.readdirSync(UPLOADS_DIR)
    .filter(n => {
      try { return fs.statSync(path.join(UPLOADS_DIR, n)).isDirectory() && !n.startsWith('_temp'); }
      catch { return false; }
    })
    .forEach(folder => {
      const dir = path.join(UPLOADS_DIR, folder);
      fs.readdirSync(dir)
        .filter(f => f !== 'info.json')
        .forEach(f => arc.file(path.join(dir, f), { name: `${folder}/${f}` }));
    });

  arc.finalize();
});

// Excluir um envio
app.delete('/admin/uploads/:folder', requireAuth, (req, res) => {
  let dir;
  try { dir = safeDir(req.params.folder); } catch { return res.status(400).json({ success: false, message: 'Acesso negado.' }); }
  if (!fs.existsSync(dir)) return res.status(404).json({ success: false, message: 'Não encontrado.' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`✅ Servidor rodando em http://0.0.0.0:${PORT}`)
);
