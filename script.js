// ===================== STATE =====================
let myNickname = null;
let myId = null;
let myAvatar = null;
let authToken = localStorage.getItem('chatToken');
let socket = null;
let typingTimeout = null;
let othersTyping = new Set();
let contactsGranted = localStorage.getItem('contactsGranted') === '1';

// ===================== DOM =====================
const $ = id => document.getElementById(id);
const authScreen = $('auth-screen');
const appScreen = $('app-screen');
const authLoading = $('authLoading');
const authContent = $('authContent');
const authError = $('authError');
const loginForm = $('loginForm');
const registerForm = $('registerForm');
const messagesEl = $('messages');
const statusLine = $('statusLine');
const typingRow = $('typingRow');
const composerForm = $('composerForm');
const messageInput = $('messageInput');
const headerNick = $('headerNick');
const chatRoom = $('chatRoom');
const profileAvatar = $('profileAvatar');
const profileNickDisplay = $('profileNickDisplay');
const profileNickInput = $('profileNickInput');
const profileMsg = $('profileMsg');
const avatarInput = $('avatarInput');

// ===================== AVATAR HELPER =====================
const AVATAR_COLORS = 8;
function getAvatarColorClass(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return 'av-c' + (Math.abs(hash) % AVATAR_COLORS);
}

function setAvatarEl(el, nickname, avatarData) {
  el.innerHTML = '';
  el.className = el.className.replace(/av-c\d/g, '').trim();
  if (avatarData) {
    el.style.backgroundImage = `url(${avatarData})`;
    el.style.background = '';
    const img = document.createElement('img');
    img.src = avatarData;
    el.appendChild(img);
  } else {
    el.style.backgroundImage = '';
    el.classList.add(getAvatarColorClass(nickname || '?'));
    el.textContent = (nickname || '?')[0].toUpperCase();
  }
}

// ===================== AUTH =====================
function showError(msg) { authError.textContent = msg; authError.classList.add('visible'); }
function hideError() { authError.classList.remove('visible'); }

// Auth tabs
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    hideError();
    const t = tab.dataset.tab;
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    loginForm.classList.toggle('hidden', t !== 'login');
    registerForm.classList.toggle('hidden', t !== 'register');
  });
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError();
  const nickname = $('loginNick').value.trim();
  const password = $('loginPass').value;
  if (!nickname || !password) return showError('Заповніть всі поля');
  const btn = loginForm.querySelector('.auth-btn');
  btn.disabled = true; btn.textContent = 'Входимо...';
  try {
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({nickname,password}) });
    const data = await res.json();
    if (!res.ok) return showError(data.error);
    authToken = data.token; myNickname = data.nickname; myId = data.id;
    localStorage.setItem('chatToken', authToken);
    enterApp();
  } catch { showError("Помилка з'єднання з сервером"); }
  finally { btn.disabled = false; btn.textContent = 'Увійти'; }
});

registerForm.addEventListener('submit', async e => {
  e.preventDefault();
  hideError();
  const nickname = $('regNick').value.trim();
  const password = $('regPass').value;
  if (!nickname || !password) return showError('Заповніть всі поля');
  const btn = registerForm.querySelector('.auth-btn');
  btn.disabled = true; btn.textContent = 'Реєстрація...';
  try {
    const res = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({nickname,password}) });
    const data = await res.json();
    if (!res.ok) return showError(data.error);
    authToken = data.token; myNickname = data.nickname; myId = data.id;
    localStorage.setItem('chatToken', authToken);
    enterApp();
  } catch { showError("Помилка з'єднання з сервером"); }
  finally { btn.disabled = false; btn.textContent = 'Зареєструватися'; }
});

// Auto-login
async function tryAutoLogin() {
  if (!authToken) { showAuthForms(); return; }
  authLoading.classList.add('visible');
  authContent.style.display = 'none';
  try {
    const res = await fetch('/api/me', { headers:{'Authorization':'Bearer '+authToken} });
    if (res.ok) {
      const data = await res.json();
      myNickname = data.nickname; myId = data.id; myAvatar = data.avatar;
      enterApp();
    } else {
      localStorage.removeItem('chatToken'); authToken = null;
      showAuthForms();
    }
  } catch { showAuthForms(); }
}

function showAuthForms() {
  authLoading.classList.remove('visible');
  authContent.style.display = '';
}

function enterApp() {
  authScreen.classList.remove('active');
  appScreen.classList.add('active');
  headerNick.textContent = myNickname;
  updateProfileUI();
  connectSocket();
  if (contactsGranted) loadContacts();
}

function logout() {
  localStorage.removeItem('chatToken');
  authToken = null; myNickname = null; myId = null; myAvatar = null;
  if (socket) { socket.disconnect(); socket = null; }
  messagesEl.innerHTML = '';
  if (typingRow) typingRow.textContent = '';
  othersTyping.clear();
  chatRoom.classList.remove('open');
  appScreen.classList.remove('active');
  authScreen.classList.add('active');
  showAuthForms();
  loginForm.reset(); registerForm.reset(); hideError();
  document.querySelector('.auth-tab[data-tab="login"]').click();
}

// ===================== TABS NAVIGATION =====================
const navItems = document.querySelectorAll('.nav-item[data-tab]');
const tabPanes = document.querySelectorAll('.tab-pane');

navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    navItems.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
    tabPanes.forEach(p => p.classList.toggle('active', p.id === target));
  });
});

// ===================== CONTACTS =====================
$('grantContactsBtn').addEventListener('click', () => {
  contactsGranted = true;
  localStorage.setItem('contactsGranted', '1');
  loadContacts();
});

$('refreshContactsBtn')?.addEventListener('click', loadContacts);

async function loadContacts() {
  if (!authToken) return;
  $('contactsPermission').style.display = 'none';
  $('contactsList').style.display = '';
  $('refreshContactsBtn').style.display = '';
  $('contactsList').innerHTML = '<div style="text-align:center;padding:30px;color:#8393a3"><div class="spinner" style="margin:0 auto 12px"></div>Завантаження...</div>';

  try {
    const res = await fetch('/api/users', { headers:{'Authorization':'Bearer '+authToken} });
    const users = await res.json();
    const list = $('contactsList');
    list.innerHTML = '';

    // Відсортувати: онлайн спочатку, потім за ніком
    users.sort((a,b) => (b.online - a.online) || a.nickname.localeCompare(b.nickname));

    if (users.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:40px;color:#8393a3">Поки нікого немає</div>';
      return;
    }

    users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'contact-row';

      const avatar = document.createElement('div');
      avatar.className = 'contact-avatar';
      setAvatarEl(avatar, u.nickname, u.avatar);

      const info = document.createElement('div');
      info.className = 'contact-info';

      const name = document.createElement('div');
      name.className = 'contact-name';
      name.textContent = u.nickname;
      if (u.id === myId) name.textContent += ' (ти)';

      const status = document.createElement('div');
      status.className = 'contact-status ' + (u.online ? 'online' : 'offline');
      status.innerHTML = `<span class="${u.online ? 'online' : 'offline'}-dot"></span>${u.online ? 'онлайн' : 'офлайн'}`;

      info.appendChild(name);
      info.appendChild(status);
      row.appendChild(avatar);
      row.appendChild(info);
      list.appendChild(row);
    });
  } catch {
    $('contactsList').innerHTML = '<div style="text-align:center;padding:40px;color:#ff6b6b">Помилка завантаження</div>';
  }
}

// ===================== PROFILE =====================
function updateProfileUI() {
  setAvatarEl(profileAvatar, myNickname, myAvatar);
  profileNickDisplay.textContent = myNickname || '—';
  profileNickInput.value = myNickname || '';
}

$('avatarWrapper').addEventListener('click', () => avatarInput.click());

avatarInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showProfileMsg('Файл завеликий (макс. 5MB)', true);
    return;
  }

  // Resize to 128x128
  const dataUrl = await resizeImage(file, 128);
  myAvatar = dataUrl;
  setAvatarEl(profileAvatar, myNickname, myAvatar);

  // Save to server
  try {
    const res = await fetch('/api/profile', {
      method:'PUT',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+authToken},
      body:JSON.stringify({ avatar: dataUrl })
    });
    if (res.ok) {
      showProfileMsg('Аватар оновлено!', false);
    } else {
      const d = await res.json();
      showProfileMsg(d.error || 'Помилка', true);
    }
  } catch { showProfileMsg('Помилка з\'єднання', true); }
  avatarInput.value = '';
});

function resizeImage(file, size) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Crop to square center
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

$('profileSaveBtn').addEventListener('click', async () => {
  const newNick = profileNickInput.value.trim();
  if (!newNick) return showProfileMsg('Введіть нікнейм', true);
  if (newNick.length < 2 || newNick.length > 20) return showProfileMsg('Нікнейм: 2-20 символів', true);

  const btn = $('profileSaveBtn');
  btn.disabled = true; btn.textContent = 'Зберігаємо...';
  try {
    const res = await fetch('/api/profile', {
      method:'PUT',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+authToken},
      body:JSON.stringify({ nickname: newNick })
    });
    const data = await res.json();
    if (res.ok) {
      myNickname = data.nickname;
      updateProfileUI();
      headerNick.textContent = myNickname;
      showProfileMsg('Збережено!', false);
    } else {
      showProfileMsg(data.error || 'Помилка', true);
    }
  } catch { showProfileMsg('Помилка з\'єднання', true); }
  finally { btn.disabled = false; btn.textContent = 'Зберегти зміни'; }
});

function showProfileMsg(text, isError) {
  profileMsg.textContent = text;
  profileMsg.className = 'profile-msg ' + (isError ? 'error' : 'success');
  setTimeout(() => { profileMsg.className = 'profile-msg'; }, 3000);
}

$('profileLogoutBtn').addEventListener('click', logout);

// ===================== SOCKET =====================
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token: authToken } });

  socket.on('connect', () => { statusLine.textContent = 'у мережі'; });
  socket.on('disconnect', () => { statusLine.textContent = "з'єднання втрачено..."; });
  socket.on('connect_error', err => { if (err.message === 'Невірний токен') logout(); });

  socket.on('welcome', ({ nickname }) => {
    myNickname = nickname;
    addSystemMessage(`Ви приєднались як "${nickname}"`);
  });

  socket.on('user count', count => { statusLine.textContent = `онлайн: ${count}`; });
  socket.on('system message', text => addSystemMessage(text));

  socket.on('chat message', payload => {
    addChatMessage(payload);
    const listMsg = $('list-last-msg');
    const listTime = $('list-chat-time');
    if (listMsg) listMsg.textContent = `${payload.nickname}: ${payload.text}`;
    if (listTime) listTime.textContent = formatTime(payload.time);
  });

  socket.on('typing', ({ nickname, isTyping }) => {
    if (isTyping) othersTyping.add(nickname); else othersTyping.delete(nickname);
    renderTypingRow();
  });

  // Оновити контакти при зміні онлайну
  socket.on('online list', () => {
    if (contactsGranted && $('contactsList').style.display !== 'none') loadContacts();
  });
}

// ===================== CHAT UI =====================
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('uk-UA', { hour:'2-digit', minute:'2-digit' });
}
function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function addSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function addChatMessage({ nickname, text, time }) {
  const isOwn = nickname === myNickname;
  const row = document.createElement('div');
  row.className = `msg-row ${isOwn ? 'msg-row--out' : 'msg-row--in'}`;
  if (!isOwn) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-nickname';
    nameEl.textContent = nickname;
    row.appendChild(nameEl);
  }
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  const timeEl = document.createElement('span');
  timeEl.className = 'msg-time';
  timeEl.textContent = formatTime(time);
  bubble.appendChild(timeEl);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom();
}

function renderTypingRow() {
  if (!typingRow) return;
  if (othersTyping.size === 0) { typingRow.textContent = ''; return; }
  const names = [...othersTyping];
  typingRow.textContent = names.length === 1 ? `${names[0]} друкує...` : `${names.length} людей друкують...`;
}

// ===================== CHAT ROOM NAV =====================
$('generalChatItem').addEventListener('click', () => {
  chatRoom.classList.add('open');
  scrollToBottom();
  messageInput.focus();
});

$('chatBackBtn').addEventListener('click', () => {
  chatRoom.classList.remove('open');
});

composerForm.addEventListener('submit', e => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat message', text);
  socket.emit('typing', false);
  messageInput.value = '';
  messageInput.focus();
});

messageInput.addEventListener('input', () => {
  if (!socket) return;
  socket.emit('typing', true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('typing', false), 1500);
});

// ===================== INIT =====================
tryAutoLogin();