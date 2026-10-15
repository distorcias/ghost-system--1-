const $ = (s) => document.querySelector(s);
const root = document.documentElement;
let page = 1, total = 0, items = [], current = null, loading = false, timer = null;

// Tema (preferência salva localmente)
function setTheme(t) {
  root.dataset.theme = t; $('#theme').textContent = t === 'dark' ? '☀ White' : '☾ Dark';
  try { localStorage.setItem('gs-theme', t); } catch {}
}
let saved = 'dark'; try { saved = localStorage.getItem('gs-theme') === 'white' ? 'white' : 'dark'; } catch {}
setTheme(saved);
$('#theme').onclick = () => setTheme(root.dataset.theme === 'dark' ? 'white' : 'dark');

async function api(p, opt = {}) {
  const r = await fetch(p, { credentials: 'same-origin', ...opt, headers: { 'Content-Type': 'application/json' } });
  let d = null; try { d = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(d?.error || 'Erro inesperado.'); e.status = r.status; throw e; }
  return d;
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const who = (f) => (f && (f.name || f.address)) || 'Desconhecido';

// Login
$('#eye').onclick = () => { const p = $('#pass'); p.type = p.type === 'password' ? 'text' : 'password'; };
$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const address = $('#email').value.trim(), password = $('#pass').value, err = $('#err');
  err.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return (err.textContent = 'Informe um e-mail válido.');
  if (!password) return (err.textContent = 'Informe a senha.');
  const go = $('#go'); if (go.disabled) return;
  go.disabled = true; go.replaceChildren(el('span', 'spin'), 'Entrando…');
  try {
    const d = await api('/api/login', { method: 'POST', body: JSON.stringify({ address, password, remember: $('#remember').checked }) });
    $('#pass').value = ''; showInbox(d.address);
  } catch (x) { err.textContent = x.message; }
  go.disabled = false; go.textContent = 'Entrar';
};

function showLogin(msg) {
  clearInterval(timer); current = null;
  $('#inbox').hidden = true; $('#login').hidden = false; $('#foot').hidden = false;
  $('#err').textContent = msg || '';
}
function showInbox(addr) {
  $('#who').textContent = addr; $('#login').hidden = true; $('#foot').hidden = true; $('#inbox').hidden = false;
  page = 1; load(); clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) load(true); }, 20000);
}

// Lista
async function load(silent) {
  if (loading) return; loading = true;
  const st = $('#state'); if (!silent) { st.textContent = 'Carregando…'; st.hidden = false; }
  try {
    const d = await api('/api/messages?page=' + page);
    items = d.items; total = d.total; st.hidden = true; render();
  } catch (x) {
    if (x.status === 401) showLogin(x.message);
    else if (!silent) { items = []; render(); st.hidden = false; st.textContent = x.message; }
  }
  loading = false;
}
function render() {
  const q = $('#search').value.trim().toLowerCase(), ul = $('#msgs'); ul.replaceChildren();
  const list = items.filter((m) => !q || (m.subject || '').toLowerCase().includes(q) || who(m.from).toLowerCase().includes(q) || (m.from?.address || '').toLowerCase().includes(q));
  for (const m of list) {
    const li = el('li', (m.seen ? '' : 'unread ') + (current === m.id ? 'on' : ''));
    const body = el('div'); body.append(el('div', 'f', who(m.from)), el('div', 's', m.subject || '(sem assunto)'));
    li.append(el('span', 'dot'), body, el('time', '', fmt(m.createdAt)));
    li.onclick = () => open(m); ul.append(li);
  }
  const pages = Math.max(1, Math.ceil(total / 30));
  $('#pg').textContent = `Página ${page} de ${pages} · ${total} mensagens`;
  $('#prev').disabled = page <= 1; $('#next').disabled = page >= pages;
  const st = $('#state');
  if (!list.length && !loading) { st.hidden = false; st.textContent = q ? 'Nenhuma mensagem encontrada.' : 'Sua caixa de entrada está vazia.'; } else st.hidden = true;
}
$('#search').oninput = render;
$('#refresh').onclick = () => load();
$('#prev').onclick = () => { page--; load(); };
$('#next').onclick = () => { page++; load(); };

// Leitura
async function open(m) {
  current = m.id; m.seen = true; render(); $('#inbox').classList.add('reading');
  const rd = $('#rd'); $('#ph').hidden = true; rd.hidden = false; rd.replaceChildren(el('div', 'empty', 'Carregando…'));
  try {
    const d = await api('/api/messages/' + encodeURIComponent(m.id));
    if (current !== m.id) return;
    rd.replaceChildren(el('h2', '', d.subject || '(sem assunto)'));
    const from = d.from ? `${d.from.name ? d.from.name + ' ' : ''}<${d.from.address}>` : 'Desconhecido';
    rd.append(el('div', 'meta', `De: ${from}`), el('div', 'meta', `Para: ${(d.to || []).map((t) => t.address).join(', ')} · ${fmt(d.createdAt)}`));
    if (d.html) {
      const f = el('iframe'); f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); f.title = 'Conteúdo da mensagem';
      f.srcdoc = '<base target="_blank"><style>body{font:15px/1.6 system-ui,sans-serif;color:#111;background:#fff;margin:16px;word-wrap:break-word}img{max-width:100%;height:auto}</style>' + d.html;
      rd.append(f);
    } else rd.append(el('pre', '', d.text || '(mensagem sem conteúdo)'));
    if (d.attachments.length) rd.append(el('div', 'meta', 'Anexos: ' + d.attachments.map((a) => a.filename).join(', ')));
  } catch (x) {
    if (x.status === 401) return showLogin(x.message);
    rd.replaceChildren(el('div', 'empty', x.message));
  }
}
$('#back').onclick = () => $('#inbox').classList.remove('reading');

// Logout
$('#logout').onclick = async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  items = []; $('#msgs').replaceChildren(); $('#rd').hidden = true; $('#ph').hidden = false; $('#inbox').classList.remove('reading');
  showLogin();
};

// Restaura sessão existente
api('/api/me').then((d) => showInbox(d.address)).catch(() => {});
