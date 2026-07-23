// ===========================================================================
// Desktop Companion — 2D LIVING-PORTRAIT renderer.
// No limb rig (that looked like a puppet). The character is ONE coherent
// image animated the way Live2D / VTuber avatars are:
//   • three registered face layers — base (eyes open), blink (eyes closed),
//     talk (mouth open) — crossfaded by opacity for natural BLINKING and
//     mouth movement while SPEAKING;
//   • whole-body secondary micro-motion — gentle breathing, idle sway, and a
//     subtle lean toward the cursor — so it feels alive, not stiff.
//   window.PET_FRAMES -> { base, blink, talk }  (registered transparent PNGs)
//   window.petAPI     -> Electron bridge (optional)
// Layers + animation params live in the character pack (.character.json) so
// the character is fully editable/importable without touching code.
// ===========================================================================
(function () {
  const FRAMES = window.PET_FRAMES || {};
  const API = window.petAPI || null;
  const isEl = !!(API && API.isElectron);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------------- storage / settings / memory ----------------
  const NS = 'dpet.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) {} }
  };
  const settings = Object.assign({
    provider: 'gemini', apiKey: '', model: '', baseUrl: '',
    name: 'Linh', tts: true, waterMin: 45, restMin: 90, sessionAlertMin: 120
  }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);
  let history = store.get('history', []);
  let facts = store.get('facts', []);
  const SENSITIVE = /(m[aậ]t kh[aẩ]u|password|otp|cvv|s[ốô] th[eẻ])/i;
  function remember(fact) {
    if (fact && fact.trim() && !SENSITIVE.test(fact)) { facts.push({ t: fact.trim(), at: Date.now() }); facts = facts.slice(-30); store.set('facts', facts); return true; }
    return false;
  }
  function pushHist(role, content) { history.push({ role, content }); history = history.slice(-40); store.set('history', history); }

  // ---- IndexedDB (stores the imported character pack; can be large) ----
  function idb() { return new Promise((res, rej) => { const r = indexedDB.open('dpet-store', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
  async function idbGet(k) { const db = await idb(); return new Promise((res) => { const tx = db.transaction('kv', 'readonly'); const q = tx.objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
  async function idbDel(k) { const db = await idb(); return new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = () => res(); }); }

  // ---- character pack: validate / load / import / export ----
  function validChar(c) { return !!(c && c.format === 'desktop-companion-character' && ((Array.isArray(c.layers) && c.layers.length) || (Array.isArray(c.bones) && c.bones.length) || (Array.isArray(c.parts) && c.parts.length))); }
  async function loadStoredCharacter() { try { const c = await idbGet('character'); if (validChar(c)) { buildRig(c); if (c.name) settings.name = c.name; } } catch (e) {} }
  async function importCharacterFile(file) {
    try {
      const c = JSON.parse(await file.text());
      if (!validChar(c)) throw new Error('Sai định dạng (thiếu format/layers)');
      buildRig(c); await idbSet('character', c);
      if (c.name) { settings.name = c.name; saveSettings(); }
      setMood('happy', 2600); say('Đã nạp nhân vật mới từ file!');
    } catch (e) { setMood('annoyed', 3000); say('File nhân vật lỗi: ' + (e.message || e)); }
  }
  function imgToDataURL(img) { try { const c = document.createElement('canvas'); c.width = img.naturalWidth || 512; c.height = img.naturalHeight || 512; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png'); } catch (e) { return null; } }
  function exportCharacter() {
    const layers = layerList.map((l) => ({ id: l.id, image: (l.img && imgToDataURL(l.img)) || l.image }));
    const out = { format: 'desktop-companion-character', version: 3, name: settings.name, canvas: (lastCfg && lastCfg.canvas) || 512, layers, anim: ANIM };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = (settings.name || 'character') + '.character.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    say('Đã xuất file nhân vật (.json). Chỉnh xong Nhập lại để cập nhật nhé!');
  }

  // ---------------- build DOM ----------------
  const root = document.getElementById('pet-root');
  const pet = document.createElement('div'); pet.id = 'pet';
  const portrait = document.createElement('div'); portrait.id = 'portrait';
  root.appendChild(pet); pet.appendChild(portrait);
  // ---- 2D LIVING-PORTRAIT renderer (face layers + secondary micro-motion) ----
  let layerList = [], layerById = {}, lastCfg = null;
  const Z = { base: 1, talk: 2, blink: 3 };            // blink drawn on top of talk
  const ANIM = { breatheAmp: 0.012, bobAmp: 2.0, swayDeg: 0.7, blinkEveryMin: 2.4, blinkEveryMax: 5.5 };
  function defaultCharacter() {
    const im = (id) => FRAMES[id];
    return {
      format: 'desktop-companion-character', version: 3, name: settings.name, canvas: 512,
      layers: [ { id: 'base', image: im('base') }, { id: 'blink', image: im('blink') }, { id: 'talk', image: im('talk') } ],
      anim: { breatheAmp: 0.012, bobAmp: 2.0, swayDeg: 0.7, blinkEveryMin: 2.4, blinkEveryMax: 5.5 }
    };
  }
  function buildRig(cfg) {
    lastCfg = cfg; portrait.innerHTML = ''; layerList = []; layerById = {};
    let defs = cfg.layers;
    if (!defs) { const arr = cfg.bones || cfg.parts || []; const b = arr.find((x) => x.id === 'body') || arr[0]; defs = b ? [{ id: 'base', image: b.image }] : []; }
    defs.forEach((l, i) => {
      const im = document.createElement('img'); im.className = 'layer'; im.draggable = false; im.src = l.image;
      im.style.zIndex = Z[l.id] != null ? Z[l.id] : (i + 1);
      im.style.opacity = (l.id === 'base' || i === 0) ? 1 : 0;
      portrait.appendChild(im);
      const o = { id: l.id, image: l.image, img: im }; layerList.push(o); layerById[l.id] = o;
    });
    Object.assign(ANIM, cfg.anim || {});
  }
  buildRig(defaultCharacter());

  const bubble = document.createElement('div'); bubble.id = 'bubble'; bubble.style.opacity = 0; root.appendChild(bubble);
  const bar = document.createElement('div'); bar.id = 'bar';
  bar.innerHTML = '<button data-a="chat" title="Trò chuyện">💬</button><button data-a="joke" title="Chuyện cười">😂</button><button data-a="wave" title="Chào">👋</button><button data-a="settings" title="Cài đặt">⚙️</button>' + (isEl ? '<button data-a="quit" title="Thoát">✖</button>' : '');
  root.appendChild(bar);
  const chat = document.createElement('div'); chat.id = 'chatbox'; chat.style.display = 'none';
  chat.innerHTML = '<input id="chatin" placeholder="Nói với mình…" /><button id="chatsend">➤</button>';
  root.appendChild(chat);

  // ---------------- animation state ----------------
  let mood = 'normal';          // normal | happy | sleepy | annoyed | surprise | celebrate
  let t = 0, last = performance.now();
  let facing = 1, walking = false;
  let gaze = { x: 0, y: 0 }, gazeT = { x: 0, y: 0 };
  // face state
  let blinking = false, blinkStart = 0, nextBlinkAt = 1.5;
  let talkUntil = 0, greetUntil = 0, popUntil = 0;

  function setMood(m, holdMs) {
    mood = m || 'normal';
    if (m === 'happy' || m === 'celebrate') greetUntil = performance.now() + 950;
    if (m === 'surprise') popUntil = performance.now() + 520;
    if (holdMs) { clearTimeout(setMood._t); setMood._t = setTimeout(() => { mood = 'normal'; }, holdMs); }
  }
  function greetNow() { greetUntil = performance.now() + 1100; }

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    walking = motion.state === 'walk';
    gaze.x = lerp(gaze.x, gazeT.x, Math.min(1, dt * 6)); gaze.y = lerp(gaze.y, gazeT.y, Math.min(1, dt * 6));

    // ---- whole-body micro-motion: breathing / idle sway / lean toward cursor ----
    let breathe = 1 + Math.sin(t * 1.6) * ANIM.breatheAmp;
    let bob = Math.sin(t * 1.6) * ANIM.bobAmp;
    let sway = Math.sin(t * 0.8) * ANIM.swayDeg;
    let tx = gaze.x * 6, ty = gaze.y * 2;
    let rot = gaze.x * 1.2 + sway;
    if (walking) { bob += -Math.abs(Math.sin(t * 7)) * 3; rot += facing * 1.5; }       // gentle floaty stride
    if (mood === 'sleepy') { breathe = 1 + Math.sin(t * 0.9) * 0.02; rot += 2.2; bob += 3; }
    if (mood === 'annoyed') { tx += Math.sin(t * 34) * 3; }                              // quick shiver
    if (now < greetUntil) { const k = (greetUntil - now) / 950; bob += -Math.abs(Math.sin(now / 85)) * 8 * k; breathe += 0.03 * k; }  // happy bounce
    if (now < popUntil) { const k = (popUntil - now) / 520; breathe += 0.06 * k; bob += -6 * k; }                                    // surprise pop
    portrait.style.transform = `translate(${tx.toFixed(1)}px, ${(bob + ty).toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${(facing * breathe).toFixed(4)}, ${breathe.toFixed(4)})`;

    // ---- face: blink + talk via opacity crossfade of the registered layers ----
    if (!blinking && t > nextBlinkAt) { blinking = true; blinkStart = t; nextBlinkAt = t + ANIM.blinkEveryMin + Math.random() * (ANIM.blinkEveryMax - ANIM.blinkEveryMin); }
    let blinkAmt = 0;
    if (blinking) { const bp = (t - blinkStart) / 0.13; if (bp >= 1) blinking = false; else blinkAmt = Math.sin(Math.min(1, bp) * Math.PI); }   // 0 → 1 → 0
    if (mood === 'sleepy') blinkAmt = Math.max(blinkAmt, 0.6 + Math.sin(t * 1.1) * 0.08);        // heavy half-closed eyelids
    let talkAmt = 0;
    if (now < talkUntil) talkAmt = (Math.sin(t * 17) * 0.5 + 0.5);                                // mouth flapping while speaking
    if (layerById.talk) layerById.talk.img.style.opacity = (talkAmt * (1 - blinkAmt)).toFixed(2);
    if (layerById.blink) layerById.blink.img.style.opacity = blinkAmt.toFixed(2);

    updateMotion(dt);
  }
  requestAnimationFrame(loop);

  // ---------------- gaze / follow cursor ----------------
  function lookAt(nx, ny) { gazeT.x = clamp(nx, -1, 1); gazeT.y = clamp(ny, -1, 1); markActive(); }
  let lastBounds = null, lastScreen = null, mvAccX = 0;
  if (isEl && API.onCursor) {
    API.onCursor((c) => { lastBounds = c.bounds; if (c.screen) lastScreen = c.screen; const cx = c.bounds.x + c.bounds.width / 2, cy = c.bounds.y + c.bounds.height * 0.4; lookAt((c.x - cx) / 400, (c.y - cy) / 400); });
  } else {
    document.addEventListener('mousemove', (e) => { const r = pet.getBoundingClientRect(); lookAt((e.clientX - (r.left + r.width / 2)) / 300, (e.clientY - (r.top + r.height * 0.4)) / 300); });
  }

  // ---------------- window motion: roam / walk / fall ----------------
  const motion = { state: 'idle', until: 0, falling: false };
  function screenInfo() {
    if (isEl) { if (!lastBounds || !lastScreen) return null; return { sx: lastScreen.x, sw: lastScreen.width, bx: lastBounds.x, bw: lastBounds.width, by: lastBounds.y, floorY: lastScreen.y + lastScreen.height - lastBounds.height }; }
    const r = root.getBoundingClientRect(); return { sx: 0, sw: window.innerWidth, bx: r.left, bw: r.width, by: r.top, floorY: window.innerHeight - r.height };
  }
  function moveWin(dx, dy) {
    if (isEl) { if (API.moveBy) API.moveBy(dx, dy); if (lastBounds) lastBounds = { x: lastBounds.x + dx, y: lastBounds.y + dy, width: lastBounds.width, height: lastBounds.height }; }
    else { const r = root.getBoundingClientRect(); root.style.left = (r.left + dx) + 'px'; root.style.top = (r.top + dy) + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto'; }
  }
  function busy() { return down || panel || chat.style.display !== 'none'; }
  function updateMotion(dt) {
    if (busy()) return;
    const info = screenInfo(); if (!info) return;
    if (motion.falling) { if (info.by < info.floorY - 2) moveWin(0, Math.min(16, info.floorY - info.by)); else motion.falling = false; return; }
    if (mood === 'sleepy') { motion.state = 'idle'; return; }
    if (motion.state === 'walk') {
      if (info.bx <= info.sx + 4) facing = 1; else if (info.bx + info.bw >= info.sx + info.sw - 4) facing = -1;
      mvAccX += 46 * dt * facing; const step = mvAccX | 0; if (step) { moveWin(step, 0); mvAccX -= step; }
      if (performance.now() > motion.until) motion.state = 'idle';
    }
  }
  setInterval(() => { if (busy() || motion.falling || mood === 'sleepy') return; if (Math.random() < 0.5) { motion.state = 'walk'; facing = Math.random() < 0.5 ? 1 : -1; motion.until = performance.now() + (1400 + Math.random() * 2600); } else motion.state = 'idle'; }, 3800);

  // ---------------- emotion / energy ----------------
  let energy = clamp(store.get('energy', 100), 0, 100);
  let sessionStart = Date.now(), lastActivity = Date.now(), clicks = [], restedAlert = 0;
  function markActive() { lastActivity = Date.now(); }
  setInterval(() => {
    energy = clamp(energy - 0.6, 0, 100); store.set('energy', energy);
    const onlineMin = (Date.now() - sessionStart) / 60000, idleMin = (Date.now() - lastActivity) / 60000;
    if (onlineMin >= settings.sessionAlertMin && Date.now() - restedAlert > 20 * 60000) { restedAlert = Date.now(); setMood('sleepy', 6000); say(`Bạn ngồi máy ${Math.round(onlineMin)} phút rồi. Đứng dậy đi bộ một chút nhé!`); }
    else if ((energy < 25 || idleMin > 5) && mood === 'normal') setMood('sleepy', 4000);
  }, 15000);

  // ---------------- bubble + TTS ----------------
  let bubbleTimer = null, typeTimer = null;
  function say(text, keepMs) {
    bubble.style.opacity = 1; clearTimeout(bubbleTimer); clearInterval(typeTimer);
    let i = 0; bubble.textContent = '';
    typeTimer = setInterval(() => { i++; bubble.textContent = text.slice(0, i); if (i >= text.length) clearInterval(typeTimer); }, 22);
    const hold = keepMs || (2500 + text.length * 45);
    bubbleTimer = setTimeout(() => { bubble.style.opacity = 0; }, hold);
    talkUntil = performance.now() + hold;           // animate the mouth while the bubble is showing
    if (settings.tts) speak(text);
  }
  function speak(text) { try { if (!('speechSynthesis' in window)) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text.replace(/\[\[.*?\]\]/g, '')); u.lang = 'vi-VN'; speechSynthesis.speak(u); } catch (e) {} }

  // ---------------- jokes / reminders ----------------
  const JOKES = ['Máy tính lạnh nhất là máy nào? — Máy nhiều "Windows"! 🪟', 'Lập trình viên thích uống gì? — Java! ☕', 'Vì sao bit buồn? — Vì chỉ có 0 với 1. 🥲', 'Con gì chăm nhất? — Con ong, lúc nào cũng "bận"! 🐝', 'Cá gì càng to càng nhỏ? — Cá sấu (nhỏ)! 🐟'];
  function tellJoke() { setMood('celebrate', 3500); say(JOKES[Math.floor(Math.random() * JOKES.length)], 6000); }
  function scheduleReminder(min, msg) { if (!min || min <= 0) return; setInterval(() => { setMood('happy', 4000); say(msg); notify(settings.name, msg); }, min * 60000); }
  scheduleReminder(settings.waterMin, '💧 Uống một ngụm nước đi bạn ơi~');
  scheduleReminder(settings.restMin, '🌿 Nghỉ mắt 20 giây nhé, nhìn ra xa một chút.');
  function notify(title, body) { try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body }); } catch (e) {} }
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}

  // ---------------- AI brain ----------------
  const PROV = { gemini: { kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-flash' }, openai: { kind: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, ollama: { kind: 'openai', base: 'http://localhost:11434/v1', model: 'llama3.2' }, custom: { kind: 'openai', base: '', model: '' } };
  const MOODS = ['happy', 'normal', 'sleepy', 'annoyed', 'surprise', 'celebrate'];
  function systemPrompt() {
    const now = new Date().toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const f = facts.length ? '\nGhi nhớ về người dùng:\n' + facts.map((x) => '- ' + x.t).join('\n') : '';
    return `Bạn là ${settings.name}, một người bạn nhỏ sống ở góc màn hình. Dễ thương, ấm áp, hài hước nhẹ. Trả lời NGẮN (1-3 câu), tiếng Việt. Đầu câu thêm thẻ [[mood:happy]] với: ${MOODS.join(', ')}. Năng lượng: ${Math.round(energy)}/100. Bây giờ: ${now}.${f}`;
  }
  async function platformFetch(url, opt) { if (isEl && API.apiFetch) { const r = await API.apiFetch(url, opt); return { ok: r.ok, status: r.status, text: async () => r.body }; } const res = await fetch(url, opt); const b = await res.text(); return { ok: res.ok, status: res.status, text: async () => b }; }
  async function callAI(userText) {
    const p = PROV[settings.provider] || PROV.gemini; const key = settings.apiKey.trim(); const model = settings.model.trim() || p.model; const base = (settings.baseUrl.trim() || p.base).replace(/\/$/, '');
    if (settings.provider !== 'ollama' && !key) throw { nokey: true }; if (!base) throw { msg: 'Thiếu Base URL.' };
    pushHist('user', userText); const win = history.slice(-12), sys = systemPrompt(); let url, opt;
    if (p.kind === 'gemini') { url = base + '/models/' + model + ':generateContent?key=' + encodeURIComponent(key); opt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: win.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), systemInstruction: { parts: [{ text: sys }] }, generationConfig: { maxOutputTokens: 400 } }) }; }
    else { url = base + '/chat/completions'; const h = { 'Content-Type': 'application/json' }; if (key) h.Authorization = 'Bearer ' + key; opt = { method: 'POST', headers: h, body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }].concat(win), max_tokens: 400 }) }; }
    const res = await platformFetch(url, opt); const raw = await res.text(); if (!res.ok) throw { msg: 'API ' + res.status + ': ' + raw.slice(0, 160) };
    const j = JSON.parse(raw); let content = p.kind === 'gemini' ? ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((x) => x.text || '').join('') : ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    pushHist('assistant', content); return content;
  }
  async function handleUser(text) {
    if (!text.trim()) return;
    if (/^\/nh[oớ]\s+/i.test(text)) { remember(text.replace(/^\/nh[oớ]\s+/i, '')); setMood('happy', 3000); say('Mình nhớ rồi nha!'); return; }
    if (/chuy[eệ]n c[uườ]i|k[eể] chuy[eệ]n/i.test(text)) { tellJoke(); return; }
    say('…', 1500);
    try {
      const reply = await callAI(text); let m = 'normal', out = reply || '';
      const mt = out.match(/\[\[\s*mood\s*:\s*([a-z]+)\s*\]\]/i); if (mt) { const c = mt[1].toLowerCase(); if (MOODS.includes(c)) m = c; out = out.replace(mt[0], '').trim(); }
      setMood(m, 5000); say(out || '(mình chưa nghĩ ra)');
      if (/ng[aà]y mai|mai (t[oôơ]i|m[iì]nh)|deadline|ph[oỏ]ng v[aấ]n/i.test(text)) remember(text);
    } catch (err) { if (err && err.nokey) { say('Mình chưa có API key. Bấm ⚙️ để nhập nhé (khuyên dùng Gemini free).'); openSettings(); } else { setMood('annoyed', 3000); say('Ối, gọi AI lỗi: ' + (err.msg || err)); } }
  }

  // ---------------- interactions ----------------
  function openChat() { chat.style.display = 'flex'; setTimeout(() => { const el = document.getElementById('chatin'); el && el.focus(); }, 30); markActive(); }
  chat.querySelector('#chatsend').onclick = () => { const el = document.getElementById('chatin'); const v = el.value; el.value = ''; chat.style.display = 'none'; handleUser(v); };
  chat.querySelector('#chatin').addEventListener('keydown', (e) => { if (e.key === 'Enter') chat.querySelector('#chatsend').click(); });
  bar.addEventListener('click', (e) => { const a = e.target.getAttribute('data-a'); if (!a) return; if (a === 'chat') openChat(); else if (a === 'joke') tellJoke(); else if (a === 'wave') { setMood('happy', 2200); greetNow(); say('Chào bạn! 👋'); } else if (a === 'settings') openSettings(); else if (a === 'quit' && isEl) API.quit && API.quit(); });

  let down = null, moved = false, panel = null;
  pet.addEventListener('mouseenter', () => { if (isEl) API.setInteractive && API.setInteractive(true); });
  pet.addEventListener('mouseleave', () => { if (isEl && !down) API.setInteractive && API.setInteractive(false); });
  pet.addEventListener('mousedown', (e) => { down = { x: e.screenX, y: e.screenY }; moved = false; });
  window.addEventListener('mousemove', (e) => { if (!down) return; const dx = e.screenX - down.x, dy = e.screenY - down.y; if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; if (isEl && API.moveBy) API.moveBy(dx, dy); else { const r = root.getBoundingClientRect(); root.style.left = (r.left + dx) + 'px'; root.style.top = (r.top + dy) + 'px'; root.style.right = 'auto'; root.style.bottom = 'auto'; } down = { x: e.screenX, y: e.screenY }; } });
  window.addEventListener('mouseup', () => {
    if (!down) return; const wasDrag = moved; down = null;
    if (isEl && !pet.matches(':hover')) API.setInteractive && API.setInteractive(false);
    if (wasDrag) { motion.falling = true; return; }
    const now = Date.now(); clicks.push(now); clicks = clicks.filter((c) => now - c < 3000); markActive();
    if (clicks.length > 6) { setMood('annoyed', 3000); say('Ê! Đừng bấm mình nhiều thế 😠'); clicks = []; }
    else { setMood('happy', 2500); if (chat.style.display === 'none') openChat(); }
  });

  // ---------------- settings panel ----------------
  function openSettings() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = document.createElement('div'); panel.id = 'panel';
    panel.innerHTML = `<div class="ph">⚙️ Cài đặt</div>
      <label>Tên nhân vật</label><input id="s_name" value="${settings.name}"/>
      <label>Nhà cung cấp AI</label><select id="s_prov"><option value="gemini">Google Gemini (free)</option><option value="openai">OpenAI (ChatGPT)</option><option value="ollama">Ollama (offline)</option><option value="custom">Custom (OpenAI-compatible)</option></select>
      <label>API Key</label><input id="s_key" type="password" value="${settings.apiKey}" placeholder="Dán key…"/>
      <label>Model</label><input id="s_model" value="${settings.model}" placeholder="vd: gemini-1.5-flash"/>
      <label>Base URL (Custom/Ollama)</label><input id="s_base" value="${settings.baseUrl}" placeholder="http://localhost:11434/v1"/>
      <div class="row2"><span>Nhắc uống nước (phút)</span><input id="s_water" type="number" value="${settings.waterMin}"/></div>
      <div class="row2"><span>Nhắc nghỉ (phút)</span><input id="s_rest" type="number" value="${settings.restMin}"/></div>
      <div class="row2"><span>Đọc bằng giọng nói</span><input id="s_tts" type="checkbox" ${settings.tts ? 'checked' : ''}/></div>
      <label>Nhân vật (file .character.json)</label>
      <div class="pb"><button id="s_import">Nhập</button><button id="s_export">Xuất</button><button id="s_reset">Mặc định</button></div>
      <input id="s_charfile" type="file" accept="application/json,.json" style="display:none"/>
      <div class="pb"><button id="s_save">Lưu</button><button id="s_close">Đóng</button></div>`;
    root.appendChild(panel); panel.querySelector('#s_prov').value = settings.provider;
    panel.querySelector('#s_import').onclick = () => panel.querySelector('#s_charfile').click();
    panel.querySelector('#s_charfile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importCharacterFile(f); if (panel) { panel.remove(); panel = null; } });
    panel.querySelector('#s_export').onclick = () => exportCharacter();
    panel.querySelector('#s_reset').onclick = async () => { await idbDel('character'); buildRig(defaultCharacter()); setMood('happy', 2000); say('Đã về nhân vật mặc định.'); panel.remove(); panel = null; };
    panel.querySelector('#s_save').onclick = () => { settings.name = panel.querySelector('#s_name').value.trim() || 'Linh'; settings.provider = panel.querySelector('#s_prov').value; settings.apiKey = panel.querySelector('#s_key').value.trim(); settings.model = panel.querySelector('#s_model').value.trim(); settings.baseUrl = panel.querySelector('#s_base').value.trim(); settings.waterMin = +panel.querySelector('#s_water').value || 0; settings.restMin = +panel.querySelector('#s_rest').value || 0; settings.tts = panel.querySelector('#s_tts').checked; saveSettings(); panel.remove(); panel = null; setMood('happy', 2500); say('Đã lưu cài đặt!'); };
    panel.querySelector('#s_close').onclick = () => { panel.remove(); panel = null; };
  }

  // ---------------- boot ----------------
  loadStoredCharacter(); // if the user imported a custom character, use it
  const lastFact = facts[facts.length - 1];
  setTimeout(() => { setMood('happy', 1800); greetNow(); if (lastFact && Date.now() - lastFact.at < 3 * 24 * 3600000) say(`Chào lại nhé! Mình vẫn nhớ: "${lastFact.t}". Hôm nay sao rồi?`, 7000); else say(`Xin chào! Mình là ${settings.name} 🌸 Bấm vào mình để trò chuyện nha.`, 6000); }, 800);
  if (!settings.apiKey && settings.provider !== 'ollama') setTimeout(() => { setMood('surprise', 3000); say('Mẹo: bấm ⚙️ nhập API key (Gemini miễn phí) để mình chat thông minh hơn!'); }, 8000);
})();
