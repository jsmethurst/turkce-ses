const { SUPABASE_URL, SUPABASE_KEY } = window.APP_CONFIG;
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $app = document.getElementById("app");

const state = {
  user: null, tab: "library", recordings: [], openId: null,
  filter: { q: "", favorites: false, category: "" },
  rec: null, // active MediaRecorder session
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (s) => (isFinite(s) ? Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0") : "0:00");
const splitSentences = (t) => (t || "").split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

// Estimate sentence start times by character length; refined by the user with "Now".
function estimateTimings(transcript, duration) {
  const parts = splitSentences(transcript);
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  let t = 0;
  return parts.map((text) => {
    const start = t;
    t += ((text.length / total) * (duration || 0));
    return { text, translation: "", start, end: t };
  });
}

/* ---------- data ---------- */
async function loadRecordings() {
  const { data, error } = await sb.from("recordings").select("*").order("created_at", { ascending: false });
  if (error) return alert(error.message);
  state.recordings = data;
}
async function saveRecording(id, patch) {
  patch.updated_at = new Date().toISOString();
  const { error } = await sb.from("recordings").update(patch).eq("id", id);
  if (error) alert(error.message);
  Object.assign(state.recordings.find((r) => r.id === id) || {}, patch);
}
async function createRecording({ blob, mime, title, transcript, duration }) {
  let audio_path = null;
  if (blob) {
    const ext = (mime || "").includes("mp4") ? "m4a" : (mime || "").includes("webm") ? "webm" : (mime || "").split("/")[1] || "bin";
    audio_path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from("audio").upload(audio_path, blob, { contentType: mime });
    if (up.error) throw up.error;
  }
  const row = {
    title: title || "Untitled", transcript: transcript || "", audio_path, audio_mime: mime || null,
    duration_sec: duration || null, sentences: estimateTimings(transcript, duration),
  };
  const { data, error } = await sb.from("recordings").insert(row).select().single();
  if (error) throw error;
  state.recordings.unshift(data);
  return data;
}
async function deleteRecording(r) {
  if (!confirm("Delete this recording?")) return;
  if (r.audio_path) await sb.storage.from("audio").remove([r.audio_path]);
  await sb.from("recordings").delete().eq("id", r.id);
  state.recordings = state.recordings.filter((x) => x.id !== r.id);
  state.openId = null; render();
}
async function audioUrl(r) {
  if (!r.audio_path) return null;
  const { data } = await sb.storage.from("audio").createSignedUrl(r.audio_path, 3600);
  return data?.signedUrl || null;
}

/* ---------- views ---------- */
function render() {
  if (!state.user) return renderAuth();
  $app.innerHTML = `<div id="view"></div>
    <nav class="nav">
      <button data-tab="library" class="${state.tab === "library" && !state.openId ? "on" : ""}">Library</button>
      <button data-tab="practice" class="${state.tab === "practice" ? "on" : ""}">Practice</button>
      <button class="rec" data-tab="add" aria-label="Add">＋</button>
      <button data-tab="settings" class="${state.tab === "settings" ? "on" : ""}">Settings</button>
    </nav>`;
  $app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; state.openId = null; render(); }));
  const v = document.getElementById("view");
  if (state.openId) return renderDetail(v, state.recordings.find((r) => r.id === state.openId));
  ({ library: renderLibrary, practice: renderPractice, add: renderAdd, settings: renderSettings })[state.tab](v);
}

function renderAuth() {
  $app.innerHTML = `<h1>Türkçe Ses</h1>
    <form class="card" id="authform" novalidate><label>Email</label><input name="email" type="email" autocomplete="username" autocapitalize="off" inputmode="email">
    <label>Password (at least 6 characters)</label><input name="password" type="password" autocomplete="current-password">
    <div class="err" id="autherr"></div>
    <div class="row"><button type="submit" class="primary grow" id="in">Sign in</button><button type="button" class="grow" id="up">Create account</button></div></form>`;
  const form = document.getElementById("authform"), msg = document.getElementById("autherr");
  const creds = () => {
    const email = form.elements.email.value.trim(), password = form.elements.password.value;
    if (!email || !password) { msg.textContent = "Enter your email and a password first."; return null; }
    if (password.length < 6) { msg.textContent = "Password must be at least 6 characters."; return null; }
    msg.textContent = ""; return { email, password };
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const c = creds(); if (!c) return;
    msg.textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword(c);
    msg.textContent = error ? error.message : "";
  };
  document.getElementById("up").onclick = async () => {
    const c = creds(); if (!c) return;
    msg.textContent = "Creating account…";
    const { data, error } = await sb.auth.signUp(c);
    msg.textContent = error ? error.message : data.session ? "" : "Check your email to confirm, then sign in.";
  };
}

function renderLibrary(v) {
  const f = state.filter;
  const cats = [...new Set(state.recordings.map((r) => r.category).filter(Boolean))];
  const list = state.recordings.filter((r) =>
    (!f.favorites || r.favorite) && (!f.category || r.category === f.category) &&
    (!f.q || (r.title + r.transcript + r.translation + r.tags.join(" ")).toLowerCase().includes(f.q.toLowerCase())));
  v.innerHTML = `<h1>Library</h1>
    <input id="q" type="search" placeholder="Search" value="${esc(f.q)}">
    <div class="row"><button id="fav" class="${f.favorites ? "on" : ""}">★ Favorites</button>
    <select id="cat" style="width:auto;margin:0"><option value="">All categories</option>${cats.map((c) => `<option ${c === f.category ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
    ${list.map((r) => `<div class="card item" data-id="${r.id}"><div class="grow"><div class="t">${esc(r.title)}</div>
      <div class="muted">${esc((r.transcript || "No transcript").slice(0, 70))}</div>
      <div>${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div></div>
      <div class="muted">${r.favorite ? "★ " : ""}${r.duration_sec ? fmt(r.duration_sec) : ""}</div></div>`).join("") || `<p class="muted">Nothing here yet. Tap ＋ to add audio.</p>`}`;
  q.oninput = (e) => { f.q = e.target.value; const pos = e.target.selectionStart; renderLibrary(v); q.focus(); q.setSelectionRange(pos, pos); };
  fav.onclick = () => { f.favorites = !f.favorites; renderLibrary(v); };
  cat.onchange = (e) => { f.category = e.target.value; renderLibrary(v); };
  v.querySelectorAll(".item").forEach((el) => (el.onclick = () => { state.openId = el.dataset.id; render(); }));
}

function renderAdd(v) {
  const canRec = !!(navigator.mediaDevices && window.MediaRecorder);
  v.innerHTML = `<h1>Add</h1>
    <div class="card"><label>Title</label><input id="title" placeholder="e.g. At the bakery">
    <label>Turkish text (optional)</label><textarea id="tx" placeholder="Paste or type the Turkish transcript"></textarea>
    <div class="err" id="err"></div>
    <div class="row">${canRec ? `<button id="rec">● Record</button>` : ""}
    <label class="grow" style="margin:0"><input id="file" type="file" accept="audio/*,video/mp4" style="margin:0"></label></div>
    <div class="row" id="recstat"></div>
    <div class="row" style="margin-top:12px"><button class="primary grow" id="save">Save</button></div></div>`;
  let blob = null, mime = "", duration = 0;
  const stat = document.getElementById("recstat");

  const getDuration = (b) => new Promise((res) => {
    const a = new Audio(URL.createObjectURL(b));
    a.onloadedmetadata = () => {
      if (a.duration === Infinity) { a.currentTime = 1e101; a.ontimeupdate = () => { a.ontimeupdate = null; res(a.duration); }; }
      else res(a.duration);
    };
    a.onerror = () => res(0);
  });

  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    blob = f; mime = f.type; duration = await getDuration(f);
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, "");
    stat.innerHTML = `<span class="muted">${esc(f.name)} · ${fmt(duration)}</span>`;
  };
  if (canRec) rec.onclick = async () => {
    if (state.rec) { state.rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [], mr = new MediaRecorder(stream), t0 = Date.now();
      state.rec = mr; rec.textContent = "■ Stop";
      stat.innerHTML = `<span class="recdot"></span><span class="muted">Recording…</span>`;
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); state.rec = null; rec.textContent = "● Record";
        mime = mr.mimeType || "audio/webm"; blob = new Blob(chunks, { type: mime });
        duration = (Date.now() - t0) / 1000;
        stat.innerHTML = `<span class="muted">Recorded ${fmt(duration)}</span>`;
      };
      mr.start();
    } catch (e) { err.textContent = "Microphone unavailable: " + e.message; }
  };
  save.onclick = async () => {
    if (!blob && !tx.value.trim()) { err.textContent = "Add audio or some text first."; return; }
    save.disabled = true; err.textContent = "Saving…";
    try {
      const r = await createRecording({ blob, mime, title: title.value.trim(), transcript: tx.value.trim(), duration });
      state.tab = "library"; state.openId = r.id; render();
    } catch (e) { err.textContent = e.message; save.disabled = false; }
  };
}

async function renderDetail(v, r) {
  if (!r) { state.openId = null; return render(); }
  const url = await audioUrl(r);
  const sents = r.sentences || [];
  v.innerHTML = `<div class="row" style="margin-top:12px"><button class="ghost" id="back">← Back</button><span class="grow"></span>
    <button id="fav" class="${r.favorite ? "on" : ""}">★</button></div>
    <h1>${esc(r.title)}</h1>
    ${url ? `<audio id="au" src="${url}" controls preload="metadata"></audio>
    <div class="row" style="margin-top:8px">${[0.75, 1, 1.25].map((s) => `<button data-sp="${s}">${s}×</button>`).join("")}
    <button id="loop">Loop sentence</button></div>` : `<p class="muted">No audio attached.</p>`}
    <h2>Sentences</h2>
    <div id="sents">${sents.map((s, i) => `<div class="sent" data-i="${i}"><div>${esc(s.text)}</div>
      <div class="tr">${esc(s.translation || "")}</div>
      ${url ? `<div class="muted">${fmt(s.start)} <button class="ghost" data-now="${i}">Set start = now</button></div>` : ""}</div>`).join("") || `<p class="muted">Add a transcript below.</p>`}</div>
    <h2>Details</h2>
    <label>Title</label><input id="f-title" value="${esc(r.title)}">
    <label>Category</label><input id="f-cat" value="${esc(r.category || "")}">
    <label>Tags (comma separated)</label><input id="f-tags" value="${esc(r.tags.join(", "))}">
    <label>Turkish transcript</label><textarea id="f-tx">${esc(r.transcript)}</textarea>
    <label>English translation (one line per sentence, in order)</label><textarea id="f-tr">${esc(sents.map((s) => s.translation || "").join("\n"))}</textarea>
    <label>Notes</label><textarea id="f-notes">${esc(r.notes)}</textarea>
    <div class="row"><button class="primary grow" id="save">Save changes</button><button id="del">Delete</button></div>`;
  document.getElementById("back").onclick = () => { state.openId = null; render(); };
  fav.onclick = async () => { await saveRecording(r.id, { favorite: !r.favorite }); render(); };
  del.onclick = () => deleteRecording(r);
  save.onclick = async () => {
    const tx = document.getElementById("f-tx").value.trim();
    const trs = document.getElementById("f-tr").value.split("\n");
    let ns = sents;
    if (tx !== r.transcript) ns = estimateTimings(tx, r.duration_sec);
    ns = ns.map((s, i) => ({ ...s, translation: (trs[i] || "").trim() }));
    await saveRecording(r.id, {
      title: document.getElementById("f-title").value.trim() || "Untitled",
      category: document.getElementById("f-cat").value.trim() || null,
      tags: document.getElementById("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      transcript: tx, notes: document.getElementById("f-notes").value, sentences: ns,
    });
    render();
  };
  if (!url) return;
  const au = document.getElementById("au");
  let looping = false, cur = -1;
  const idxAt = (t) => { let k = -1; sents.forEach((s, i) => { if (t >= s.start - 0.05) k = i; }); return k; };
  const playSentence = (i) => { au.currentTime = sents[i].start; au.play(); };
  v.querySelectorAll("[data-sp]").forEach((b) => (b.onclick = () => { au.playbackRate = +b.dataset.sp; v.querySelectorAll("[data-sp]").forEach((x) => x.classList.toggle("on", x === b)); }));
  loop.onclick = () => { looping = !looping; loop.classList.toggle("on", looping); };
  v.querySelectorAll(".sent").forEach((el) => (el.onclick = (e) => { if (e.target.dataset.now) return; playSentence(+el.dataset.i); }));
  v.querySelectorAll("[data-now]").forEach((b) => (b.onclick = async () => {
    const i = +b.dataset.now;
    sents[i].start = au.currentTime; if (i > 0) sents[i - 1].end = au.currentTime;
    await saveRecording(r.id, { sentences: sents }); render();
  }));
  au.ontimeupdate = () => {
    const i = idxAt(au.currentTime);
    if (looping && cur >= 0 && sents[cur] && au.currentTime >= sents[cur].end) { au.currentTime = sents[cur].start; return; }
    if (i !== cur) { cur = i; v.querySelectorAll(".sent").forEach((el, k) => el.classList.toggle("active", k === i)); }
  };
}

function renderPractice(v) {
  const pool = state.recordings.filter((r) => (r.sentences || []).length);
  if (!pool.length) { v.innerHTML = `<h1>Practice</h1><p class="muted">Add a recording with a transcript to practise.</p>`; return; }
  const mode = state.mode || "sentences";
  v.innerHTML = `<h1>Practice</h1>
    <div class="row">${[["listen", "Listen"], ["sentences", "Sentences"], ["recall", "Recall"]].map(([m, l]) => `<button data-m="${m}" class="${m === mode ? "on" : ""}">${l}</button>`).join("")}</div>
    <div id="card" class="card"></div><div class="row"><button class="primary grow" id="next">Next</button></div>`;
  v.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { state.mode = b.dataset.m; renderPractice(v); }));
  let shown = false, audio = null;
  const pick = async () => {
    shown = false;
    const r = pool[Math.floor(Math.random() * pool.length)], s = r.sentences[Math.floor(Math.random() * r.sentences.length)];
    const card = document.getElementById("card");
    const url = await audioUrl(r);
    const draw = () => {
      const turkish = `<div class="big">${esc(s.text)}</div>${s.translation ? `<div class="muted" style="text-align:center">${esc(s.translation)}</div>` : ""}`;
      card.innerHTML = (mode === "recall"
        ? `<div class="big">${esc(s.translation || "(no translation yet)")}</div>${shown ? turkish : ""}`
        : mode === "listen" ? (shown ? turkish : `<div class="big">🎧</div>`) : turkish) +
        `<div class="row" style="justify-content:center">${url ? `<button id="play">▶ Play</button>` : ""}${mode !== "sentences" ? `<button id="rev">${shown ? "Hide" : "Reveal"}</button>` : ""}</div>`;
      if (url) document.getElementById("play").onclick = () => {
        audio = audio || new Audio(url); audio.currentTime = s.start; audio.play();
        if (s.end > s.start) { const stop = () => { if (audio.currentTime >= s.end) { audio.pause(); audio.removeEventListener("timeupdate", stop); } }; audio.addEventListener("timeupdate", stop); }
      };
      if (mode !== "sentences") document.getElementById("rev").onclick = () => { shown = !shown; draw(); };
    };
    draw();
  };
  document.getElementById("next").onclick = () => { audio = null; pick(); };
  pick();
}

function renderSettings(v) {
  v.innerHTML = `<h1>Settings</h1><div class="card"><div class="muted">Signed in as</div><div>${esc(state.user.email)}</div></div>
    <button id="out">Sign out</button>`;
  document.getElementById("out").onclick = () => sb.auth.signOut();
}

/* ---------- boot ---------- */
// Never await Supabase calls inside this callback (it holds the auth lock and deadlocks); defer them.
sb.auth.onAuthStateChange((_e, session) => {
  state.user = session?.user || null;
  setTimeout(async () => {
    if (state.user) await loadRecordings(); else state.recordings = [];
    render();
  }, 0);
});
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
