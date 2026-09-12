const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

// --- Зберігання користувачів ---
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); } catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

// --- Онлайн-трекінг ---
const onlineUserIds = new Set();

// --- Auth middleware ---
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });
  const users = loadUsers();
  const user = users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: 'Невірний токен' });
  req.user = user;
  next();
}

// --- API: Реєстрація ---
app.post('/api/register', (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) return res.status(400).json({ error: 'Введіть нікнейм та пароль' });
  const trimNick = nickname.trim();
  if (trimNick.length < 2 || trimNick.length > 20) return res.status(400).json({ error: 'Нікнейм: 2-20 символів' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль: мінімум 4 символи' });

  const users = loadUsers();
  if (users.find(u => u.nickname.toLowerCase() === trimNick.toLowerCase())) {
    return res.status(400).json({ error: 'Цей нікнейм вже зайнятий' });
  }

  const { hash, salt } = hashPassword(password);
  const token = generateToken();
  const user = {
    id: crypto.randomUUID(),
    nickname: trimNick,
    passwordHash: hash, salt, token,
    avatar: null,
    createdAt: Date.now()
  };
  users.push(user);
  saveUsers(users);
  res.json({ token, nickname: user.nickname, id: user.id });
});

// --- API: Вхід ---
app.post('/api/login', (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname || !password) return res.status(400).json({ error: 'Введіть нікнейм та пароль' });
  const users = loadUsers();
  const user = users.find(u => u.nickname.toLowerCase() === nickname.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Невірний нікнейм або пароль' });
  const { hash } = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) return res.status(401).json({ error: 'Невірний нікнейм або пароль' });
  const token = generateToken();
  user.token = token;
  saveUsers(users);
  res.json({ token, nickname: user.nickname, id: user.id });
});

// --- API: Перевірка токена ---
app.get('/api/me', auth, (req, res) => {
  res.json({ id: req.user.id, nickname: req.user.nickname, avatar: req.user.avatar || null });
});

// --- API: Список користувачів ---
app.get('/api/users', auth, (req, res) => {
  const users = loadUsers();
  res.json(users.map(u => ({
    id: u.id,
    nickname: u.nickname,
    avatar: u.avatar || null,
    online: onlineUserIds.has(u.id)
  })));
});

// --- API: Оновлення профілю ---
app.put('/api/profile', auth, (req, res) => {
  const { nickname, avatar } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });

  if (nickname !== undefined) {
    const trimNick = nickname.trim();
    if (trimNick.length < 2 || trimNick.length > 20) return res.status(400).json({ error: 'Нікнейм: 2-20 символів' });
    const taken = users.find(u => u.id !== user.id && u.nickname.toLowerCase() === trimNick.toLowerCase());
    if (taken) return res.status(400).json({ error: 'Цей нікнейм вже зайнятий' });
    user.nickname = trimNick;

    // Оновити нік у всіх активних сокетах цього юзера
    for (const [, s] of io.sockets.sockets) {
      if (s.data.userId === user.id) s.data.nickname = trimNick;
    }
  }

  if (avatar !== undefined) {
    // avatar = null (скинути) або base64 data URL
    if (avatar && typeof avatar === 'string' && avatar.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Аватар завеликий (макс. 2MB)' });
    }
    user.avatar = avatar || null;
  }

  saveUsers(users);
  res.json({ id: user.id, nickname: user.nickname, avatar: user.avatar || null });
});

// --- Socket.IO ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Необхідна авторизація'));
  const users = loadUsers();
  const user = users.find(u => u.token === token);
  if (!user) return next(new Error('Невірний токен'));
  socket.data.nickname = user.nickname;
  socket.data.userId = user.id;
  next();
});

let onlineCount = 0;

io.on('connection', (socket) => {
  onlineCount++;
  onlineUserIds.add(socket.data.userId);

  socket.emit('welcome', { nickname: socket.data.nickname });
  io.emit('user count', onlineCount);
  io.emit('online list', [...onlineUserIds]);
  socket.broadcast.emit('system message', `${socket.data.nickname} приєднався до чату`);

  socket.on('chat message', (text) => {
    if (!text || typeof text !== 'string') return;
    io.emit('chat message', {
      nickname: socket.data.nickname,
      text: text.slice(0, 500),
      time: Date.now()
    });
  });

  socket.on('typing', (isTyping) => {
    socket.broadcast.emit('typing', {
      nickname: socket.data.nickname,
      isTyping: Boolean(isTyping)
    });
  });

  socket.on('disconnect', () => {
    onlineCount--;
    onlineUserIds.delete(socket.data.userId);
    io.emit('user count', onlineCount);
    io.emit('online list', [...onlineUserIds]);
    socket.broadcast.emit('system message', `${socket.data.nickname} залишив чат`);
    socket.broadcast.emit('typing', { nickname: socket.data.nickname, isTyping: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер працює на http://localhost:${PORT}`));