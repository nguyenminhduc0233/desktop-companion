// ===========================================================================
// Desktop Companion — 2D SKELETAL RIG renderer (v2, hierarchical bones).
// The character is split into 7 parts: body (root) + upperArm/foreArm (L,R,
// jointed at the elbow) + legL/legR (jointed at the hips). A matrix
// forward-kinematics engine composes each bone's world transform from its
// parent EVERY frame (60fps), and a spring integrator adds secondary motion
// (lag + follow-through/overshoot) — the in-between poses are COMPUTED, not
// hand-drawn, so walking (alternating legs), waving (bend at the elbow) and
// idle sway are all smooth.
//   window.PET_FRAMES -> { body, upperArmL, foreArmL, upperArmR, foreArmR, legL, legR }
//                        (each a full-canvas transparent PNG on a 720 square)
//   window.petAPI     -> Electron bridge (optional)
// Bones/pivots/rest-angles live in the character pack (.character.json) so the
// rig is fully editable/importable without touching code.
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
  function validChar(c) { return !!(c && c.format === 'desktop-companion-character' && ((Array.isArray(c.bones) && c.bones.length) || (Array.isArray(c.parts) && c.parts.length))); }
  async function loadStoredCharacter() { try { const c = await idbGet('character'); if (validChar(c)) { buildRig(c); if (c.name) settings.name = c.name; } } catch (e) {} }
  async function importCharacterFile(file) {
    try {
      const c = JSON.parse(await file.text());
      if (!validChar(c)) throw new Error('Sai định dạng (thiếu format/parts)');
      buildRig(c); await idbSet('character', c);
      if (c.name) { settings.name = c.name; saveSettings(); }
      setMood('happy', 2500); setGesture('wave', 1800); say('Đã nạp nhân vật mới từ file!');
    } catch (e) { setMood('annoyed', 3000); say('File nhân vật lỗi: ' + (e.message || e)); }
  }
  function imgToDataURL(img) { try { const c = document.createElement('canvas'); c.width = img.naturalWidth || 720; c.height = img.naturalHeight || 720; c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/png'); } catch (e) { return null; } }
  function exportCharacter() {
    const bones = boneList.map((b) => ({ id: b.id, image: (b.img && imgToDataURL(b.img)) || b.image, parent: b.parent || null, pivot: b.pivot || [50, 50], rest: b.rest || 0, z: b.z || 1 }));
    const out = { format: 'desktop-companion-character', version: 2, name: settings.name, canvas: (lastCfg && lastCfg.canvas) || 720, bones, rig: { legSwing: RIG.legSwing, armSwing: RIG.armSwing } };
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
  // ---- 2D skeletal rig: hierarchical bones + matrix forward-kinematics ----
  const L = 300;                 // logical square (px) the rig math runs in
  let boneList = [], byIdBone = {}, lastCfg = null;
  const RIG = { legSwing: 8, armSwing: 14 };
  // affine matrix helpers  [a,b,c,d,e,f] = [[a c e],[b d f],[0 0 1]]
  const mMul = (A, B) => [A[0]*B[0]+A[2]*B[1], A[1]*B[0]+A[3]*B[1], A[0]*B[2]+A[2]*B[3], A[1]*B[2]+A[3]*B[3], A[0]*B[4]+A[2]*B[5]+A[4], A[1]*B[4]+A[3]*B[5]+A[5]];
  const mTrans = (x, y) => [1, 0, 0, 1, x, y];
  const mRotAbout = (px, py, deg) => { const r = deg*Math.PI/180, co = Math.cos(r), si = Math.sin(r); return [co, si, -si, co, px - co*px + si*py, py - si*px - co*py]; };
  const mScaleAbout = (px, py, sx, sy) => [sx, 0, 0, sy, px - sx*px, py - sy*py];
  function defaultCharacter() {
    const im = (id) => FRAMES[id];
    return {
      format: 'desktop-companion-character', version: 2, name: settings.name, canvas: 720,
      bones: [
        { id: 'legL', image: im('legL'), parent: 'body', pivot: [44.7, 59.7], rest: -20, z: 1 },
        { id: 'legR', image: im('legR'), parent: 'body', pivot: [55.3, 59.7], rest: 20, z: 1 },
        { id: 'body', image: im('body'), parent: null, pivot: [50, 100], rest: 0, z: 3 },
        { id: 'upperArmL', image: im('upperArmL'), parent: 'body', pivot: [43.1, 25], rest: -78, z: 5 },
        { id: 'foreArmL', image: im('foreArmL'), parent: 'upperArmL', pivot: [26.4, 25.7], rest: 0, z: 5 },
        { id: 'upperArmR', image: im('upperArmR'), parent: 'body', pivot: [56.4, 25], rest: 78, z: 5 },
        { id: 'foreArmR', image: im('foreArmR'), parent: 'upperArmR', pivot: [73.3, 25.7], rest: 0, z: 5 }
      ],
      rig: { legSwing: 8, armSwing: 14 }
    };
  }
  function buildRig(cfg) {
    lastCfg = cfg; portrait.innerHTML = '';
    let defs = cfg.bones;
    if (!defs && cfg.parts) defs = cfg.parts.map((p) => ({ id: p.id, image: p.image, parent: null, pivot: p.pivot || [50, 50], rest: 0, z: p.z || 1 }));
    const bones = (defs || []).map((b) => ({ ...b, angle: b.rest || 0, target: b.rest || 0, vel: 0, _w: [1, 0, 0, 1, 0, 0] }));
    // topo order: parents before children
    const map = {}; bones.forEach((b) => { map[b.id] = b; });
    const out = [], seen = {};
    function visit(b) { if (!b || seen[b.id]) return; if (b.parent && map[b.parent]) visit(map[b.parent]); seen[b.id] = 1; out.push(b); }
    bones.forEach(visit);
    boneList = out; byIdBone = map;
    [...bones].sort((a, b) => (a.z || 0) - (b.z || 0)).forEach((b) => { const im = document.createElement('img'); im.className = 'part'; im.draggable = false; im.src = b.image; im.style.transformOrigin = '0 0'; b.img = im; portrait.appendChild(im); });
    RIG.legSwing = (cfg.rig && cfg.rig.legSwing) || 8;
    RIG.armSwing = (cfg.rig && cfg.rig.armSwing) || 14;
  }
  function restOf(id) { return byIdBone[id] ? (byIdBone[id].rest || 0) : 0; }
  buildRig(defaultCharacter());

  const bubble = document.createElement('div'); bubble.id = 'bubble'; bubble.style.opacity = 0; root.appendChild(bubble);
  const bar = document.createElement('div'); bar.id = 'bar';
  bar.innerHTML = '<button data-a="chat" title="Trò chuyện">💬</button><button data-a="joke" title="Chuyện cười">😂</button><button data-a="wave" title="Vẫy tay">👋</button><button data-a="settings" title="Cài đặt">⚙️</button>' + (isEl ? '<button data-a="quit" title="Thoát">✖</button>' : '');
  root.appendChild(bar);
  const chat = document.createElement('div'); chat.id = 'chatbox'; chat.style.display = 'none';
  chat.innerHTML = '<input id="chatin" placeholder="Nói với mình…" /><button id="chatsend">➤</button>';
  root.appendChild(chat);

  // ---------------- rig / animation state ----------------
  let mood = 'normal';          // normal | happy | sleepy | annoyed | surprise | celebrate
  let t = 0, last = performance.now();
  let facing = 1, walkPhase = 0;
  let gesture = null, gestureUntil = 0;      // 'wave'
  let gaze = { x: 0, y: 0 }, gazeT = { x: 0, y: 0 };

  function setMood(m, holdMs) {
    mood = m || 'normal';
    if (m === 'happy' || m === 'celebrate') setGesture('wave', 1600);
    if (holdMs) { clearTimeout(setMood._t); setMood._t = setTimeout(() => { mood = 'normal'; }, holdMs); }
  }
  function setGesture(g, ms) { gesture = g; gestureUntil = performance.now() + (ms || 1500); }

  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    const walking = motion.state === 'walk';
    if (walking) walkPhase = (walkPhase + dt * 2.0) % 1;
    if (gesture && now > gestureUntil) gesture = null;

    // ---- gaze smoothing ----
    gaze.x = lerp(gaze.x, gazeT.x, Math.min(1, dt * 6)); gaze.y = lerp(gaze.y, gazeT.y, Math.min(1, dt * 6));
    const p2 = walkPhase * Math.PI * 2;

    // ---- per-bone TARGET angles (limbs) ----
    boneList.forEach((b) => { if (b.id !== 'body') b.target = b.rest || 0; });
    const idleSway = Math.sin(t * 1.1) * 3;                    // gentle idle arm sway
    if (byIdBone.upperArmL) byIdBone.upperArmL.target = restOf('upperArmL') + idleSway;
    if (byIdBone.upperArmR) byIdBone.upperArmR.target = restOf('upperArmR') - idleSway;
    if (walking) {                                             // alternating leg + counter-arm swing
      if (byIdBone.legL) byIdBone.legL.target = restOf('legL') + Math.sin(p2) * RIG.legSwing;
      if (byIdBone.legR) byIdBone.legR.target = restOf('legR') + Math.sin(p2 + Math.PI) * RIG.legSwing;
      if (byIdBone.upperArmL) byIdBone.upperArmL.target = restOf('upperArmL') + Math.sin(p2 + Math.PI) * RIG.armSwing;
      if (byIdBone.upperArmR) byIdBone.upperArmR.target = restOf('upperArmR') + Math.sin(p2) * RIG.armSwing;
      if (byIdBone.foreArmL) byIdBone.foreArmL.target = Math.max(0, Math.sin(p2 + Math.PI)) * 16;   // slight elbow bend on forward swing
      if (byIdBone.foreArmR) byIdBone.foreArmR.target = Math.max(0, Math.sin(p2)) * 16;
    }
    if (mood === 'sleepy') { if (byIdBone.upperArmL) byIdBone.upperArmL.target = restOf('upperArmL') + 6; if (byIdBone.upperArmR) byIdBone.upperArmR.target = restOf('upperArmR') - 6; }
    if (gesture === 'wave' && byIdBone.upperArmR && byIdBone.foreArmR) { byIdBone.upperArmR.target = -18; byIdBone.foreArmR.target = -28 + Math.sin(t * 10) * 30; }  // raise upper arm, wave at the elbow

    // ---- spring integrate = secondary motion (lag + follow-through / overshoot) ----
    const stiff = 200, damp = 16;
    boneList.forEach((b) => { if (b.id === 'body') return; const f = (b.target - b.angle) * stiff; b.vel += f * dt; b.vel *= Math.max(0, 1 - damp * dt); b.angle += b.vel * dt; });

    // ---- body / global transform (bob, breathe, lean, facing) ----
    let bob = Math.sin(t * 1.6) * 1.4, breathe = 1 + Math.sin(t * 1.6) * 0.012, lean = gaze.x * 3;
    if (walking) { bob = -Math.abs(Math.sin(p2)) * 4.5; lean = facing * 2 + Math.sin(p2) * 1.4; }
    if (mood === 'annoyed' && gesture !== 'wave') lean += Math.sin(t * 28) * 2.2;
    if (mood === 'sleepy') { lean += 2; breathe = 1 + Math.sin(t * 0.9) * 0.02; }
    const bpx = L / 2, bpy = L;
    const rootM = mMul(mTrans(gaze.x * 4, bob), mMul(mRotAbout(bpx, bpy, lean), mScaleAbout(bpx, bpy, facing, breathe)));

    // ---- forward kinematics: compose world matrix per bone (parents first) ----
    boneList.forEach((b) => {
      const px = (b.pivot[0] / 100) * L, py = (b.pivot[1] / 100) * L;
      const parentM = (b.parent && byIdBone[b.parent]) ? byIdBone[b.parent]._w : rootM;
      b._w = mMul(parentM, mRotAbout(px, py, b.angle));
      if (b.img) b.img.style.transform = `matrix(${b._w.map((v) => v.toFixed(4)).join(',')})`;
    });

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
    bubbleTimer = setTimeout(() => { bubble.style.opacity = 0; }, keepMs || (2500 + text.length * 45));
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
  bar.addEventListener('click', (e) => { const a = e.target.getAttribute('data-a'); if (!a) return; if (a === 'chat') openChat(); else if (a === 'joke') tellJoke(); else if (a === 'wave') { setMood('happy', 2000); setGesture('wave', 1800); } else if (a === 'settings') openSettings(); else if (a === 'quit' && isEl) API.quit && API.quit(); });

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
  setTimeout(() => { setGesture('wave', 2000); if (lastFact && Date.now() - lastFact.at < 3 * 24 * 3600000) say(`Chào lại nhé! Mình vẫn nhớ: "${lastFact.t}". Hôm nay sao rồi?`, 7000); else say(`Xin chào! Mình là ${settings.name} 🌸 Bấm vào mình để trò chuyện nha.`, 6000); }, 800);
  if (!settings.apiKey && settings.provider !== 'ollama') setTimeout(() => { setMood('surprise', 3000); say('Mẹo: bấm ⚙️ nhập API key (Gemini miễn phí) để mình chat thông minh hơn!'); }, 8000);
})();
