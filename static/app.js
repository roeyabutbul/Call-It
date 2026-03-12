// ── State ────────────────────────────────────────────────────
const state = {
  code: null,
  sessionId: null,
  isCreator: false,
  creatorId: null,
  hasVoted: false,
  lobbyStatus: "active",
  ws: null,
  pingInterval: null,
};

// ── Screen navigation ─────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ── Push notifications ────────────────────────────────────────
async function registerPush(lobbyCode) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    const keyRes = await fetch("/api/vapid-public-key");
    const { public_key } = await keyRes.json();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(public_key),
    });

    await fetch(`/api/lobby/${lobbyCode}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  } catch (e) {
    // Push not supported or denied — silently skip
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ── On load: check URL param or saved session ─────────────────
window.addEventListener("load", () => {
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = params.get("code");
  if (codeFromUrl) {
    document.getElementById("join-code").value = codeFromUrl.toUpperCase();
    showScreen("screen-join");
    return;
  }

  const saved = localStorage.getItem("barout_session");
  if (saved) {
    try {
      rejoinLobby(JSON.parse(saved));
    } catch {
      localStorage.removeItem("barout_session");
    }
  }
});

async function rejoinLobby(session) {
  try {
    const res = await fetch(`/api/lobby/${session.code}?session_id=${session.sessionId}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.status === "threshold_reached") {
      localStorage.removeItem("barout_session");
      return; // stay on home screen
    }
    state.code      = session.code;
    state.sessionId = session.sessionId;
    state.isCreator = data.is_creator;
    state.hasVoted  = data.has_voted;
    renderLobby(data);
    showScreen("screen-lobby");
    connectWS();
    registerPush(session.code);
  } catch {
    localStorage.removeItem("barout_session");
  }
}

// ── Create lobby ──────────────────────────────────────────────
async function createLobby() {
  const name = document.getElementById("create-name").value.trim();
  try {
    const res = await fetch("/api/lobby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || null }),
    });
    const data = await res.json();
    state.code      = data.code;
    state.sessionId = data.session_id;
    state.isCreator = true;
    state.hasVoted  = false;
    saveSession();
    await loadAndRender();
    showScreen("screen-lobby");
    connectWS();
    registerPush(data.code);
  } catch {
    alert("Failed to create lobby — is the server running?");
  }
}

// ── Join lobby ────────────────────────────────────────────────
async function joinLobby() {
  const code  = document.getElementById("join-code").value.trim().toUpperCase();
  const name  = document.getElementById("join-name").value.trim();
  const errEl = document.getElementById("join-error");
  errEl.textContent = "";

  if (code.length !== 6) { errEl.textContent = "Lobby code must be 6 characters"; return; }

  try {
    const res = await fetch(`/api/lobby/${code}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || null }),
    });
    if (!res.ok) {
      const err = await res.json();
      errEl.textContent = err.detail || "Could not join lobby";
      return;
    }
    const data = await res.json();
    state.code      = code;
    state.sessionId = data.session_id;
    state.isCreator = false;
    state.hasVoted  = false;
    saveSession();
    await loadAndRender();
    showScreen("screen-lobby");
    connectWS();
    registerPush(code);
  } catch {
    errEl.textContent = "Failed to join — try again";
  }
}

// ── Load lobby data and render ────────────────────────────────
async function loadAndRender() {
  const res  = await fetch(`/api/lobby/${state.code}?session_id=${state.sessionId}`);
  const data = await res.json();
  renderLobby(data);
}

function renderLobby(data) {
  document.getElementById("lobby-code-display").textContent = state.code;
  document.getElementById("member-count").textContent       = data.member_count;
  document.getElementById("threshold-total").textContent    = data.member_count;

  state.hasVoted  = data.has_voted || state.hasVoted;
  state.isCreator = data.is_creator || state.isCreator;
  if (data.creator_id) state.creatorId = data.creator_id;

  // Member list
  renderMembers(data.members || []);

  // Threshold
  renderThreshold(data.threshold, data.threshold_raw);

  // Creator controls
  if (state.isCreator) document.getElementById("creator-controls").classList.remove("hidden");

  // Update lobby status before rendering vote button
  if (data.status === "threshold_reached") state.lobbyStatus = "threshold_reached";
  else state.lobbyStatus = "active";

  // Vote button
  renderVoteButton();

  // Show overlay if needed
  if (data.status === "threshold_reached") {
    const dismissed = JSON.parse(localStorage.getItem("barout_dismissed") || "{}");
    if (!dismissed[state.code]) showOverlay();
  }
}

function renderMembers(members) {
  const list = document.getElementById("member-list");
  list.innerHTML = "";
  members.forEach(({ id, name }) => {
    const chip = document.createElement("div");
    chip.className = "member-chip";

    const label = document.createElement("span");
    label.textContent = name || "👤 Anonymous";
    chip.appendChild(label);

    // Kick button — only creator sees it, not on their own chip
    if (state.isCreator && id !== state.sessionId) {
      const kick = document.createElement("button");
      kick.className = "btn-kick";
      kick.textContent = "✕";
      kick.title = "Remove from lobby";
      kick.onclick = () => kickMember(id);
      chip.appendChild(kick);
    }

    list.appendChild(chip);
  });
}

function renderThreshold(threshold, raw) {
  document.getElementById("threshold-value").textContent = threshold;
  const tag = document.getElementById("threshold-mode-tag");
  tag.textContent = (raw === -1) ? "(majority)" : "";
}

function renderVoteButton() {
  const btn       = document.getElementById("vote-btn");
  const status    = document.getElementById("vote-status");
  const cancelBtn = document.getElementById("cancel-vote-btn");

  if (state.hasVoted) {
    btn.disabled = true;
    btn.innerHTML = '<span class="vote-icon">✓</span><span class="vote-text">You\'re Ready</span>';
    status.classList.remove("hidden");
    // Can only cancel if lobby is still active
    if (state.lobbyStatus === "active") {
      cancelBtn.classList.remove("hidden");
    } else {
      cancelBtn.classList.add("hidden");
    }
  } else if (state.lobbyStatus === "threshold_reached") {
    // Lobby is done but this person didn't vote
    btn.disabled = true;
    btn.innerHTML = '<span class="vote-icon">🚪</span><span class="vote-text">I\'m Ready to Leave</span>';
    status.classList.add("hidden");
    cancelBtn.classList.add("hidden");
  } else {
    btn.disabled = false;
    btn.innerHTML = '<span class="vote-icon">🚪</span><span class="vote-text">I\'m Ready to Leave</span>';
    status.classList.add("hidden");
    cancelBtn.classList.add("hidden");
  }
}

// ── Cast vote ─────────────────────────────────────────────────
async function castVote() {
  if (state.hasVoted) return;
  try {
    const res = await fetch(`/api/lobby/${state.code}/vote?session_id=${state.sessionId}`, {
      method: "POST",
    });
    if (!res.ok) { const e = await res.json(); alert(e.detail || "Failed to send vote"); return; }
    state.hasVoted = true;
    saveSession();
    renderVoteButton();
  } catch {
    alert("Failed to send vote — try again");
  }
}

async function cancelVote() {
  try {
    const res = await fetch(`/api/lobby/${state.code}/vote?session_id=${state.sessionId}`, {
      method: "DELETE",
    });
    if (!res.ok) { const e = await res.json(); alert(e.detail || "Failed to cancel vote"); return; }
    state.hasVoted = false;
    saveSession();
    renderVoteButton();
  } catch {
    alert("Failed to cancel vote — try again");
  }
}

// ── Leave / Kick ──────────────────────────────────────────────
async function leaveLobby() {
  if (!confirm("Leave this lobby?")) return;
  try {
    await fetch(`/api/lobby/${state.code}/member/${state.sessionId}?requester_id=${state.sessionId}`, {
      method: "DELETE",
    });
  } catch { /* ignore — we're leaving anyway */ }
  localStorage.removeItem("barout_session");
  state.code = null;
  state.sessionId = null;
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
  showScreen("screen-home");
}

async function kickMember(targetId) {
  try {
    const res = await fetch(`/api/lobby/${state.code}/member/${targetId}?requester_id=${state.sessionId}`, {
      method: "DELETE",
    });
    if (!res.ok) { const e = await res.json(); alert(e.detail); }
  } catch {
    alert("Failed to remove member — try again");
  }
}

// ── Threshold editing (creator only) ─────────────────────────
function toggleThresholdEdit() {
  document.getElementById("threshold-edit").classList.toggle("hidden");
  document.getElementById("threshold-input").focus();
}

function applyThresholdFromInput() {
  const val = parseInt(document.getElementById("threshold-input").value);
  if (isNaN(val) || val < 1) { alert("Enter a valid number (at least 1)"); return; }
  applyThreshold(val);
}

async function applyThreshold(value) {
  try {
    const res = await fetch(`/api/lobby/${state.code}/threshold`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold: value, session_id: state.sessionId }),
    });
    if (!res.ok) { const e = await res.json(); alert(e.detail); return; }
    document.getElementById("threshold-edit").classList.add("hidden");
    document.getElementById("threshold-input").value = "";
  } catch {
    alert("Failed to update threshold");
  }
}

// ── WebSocket ─────────────────────────────────────────────────
function connectWS() {
  if (state.ws) state.ws.close();
  if (state.pingInterval) clearInterval(state.pingInterval);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${proto}//${location.host}/ws/${state.code}/${state.sessionId}`);

  state.ws.onmessage = (e) => handleWS(JSON.parse(e.data));

  state.ws.onclose = () => {
    if (state.code && state.lobbyStatus === "active") setTimeout(connectWS, 3000);
  };

  // Keepalive
  state.pingInterval = setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send("ping");
  }, 25000);
}

function handleWS(msg) {
  switch (msg.type) {
    case "member_joined":
      document.getElementById("member-count").textContent    = msg.member_count;
      document.getElementById("threshold-total").textContent = msg.member_count;
      renderThreshold(msg.threshold, msg.threshold_raw);
      renderMembers(msg.members || []);
      loadAndRender();
      break;

    case "member_left":
      // If I was kicked, go home
      if (msg.session_id === state.sessionId) {
        localStorage.removeItem("barout_session");
        state.code = null;
        state.sessionId = null;
        if (state.ws) { state.ws.close(); state.ws = null; }
        if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
        if (msg.reason === "kicked") alert("You were removed from the lobby.");
        showScreen("screen-home");
        return;
      }
      // If creator transferred to me
      if (msg.new_creator_id && msg.new_creator_id === state.sessionId) {
        state.isCreator = true;
        state.creatorId = state.sessionId;
        document.getElementById("creator-controls").classList.remove("hidden");
      }
      document.getElementById("member-count").textContent    = msg.member_count;
      document.getElementById("threshold-total").textContent = msg.member_count;
      renderThreshold(msg.threshold, msg.threshold_raw);
      renderMembers(msg.members || []);
      break;

    case "threshold_updated":
      renderThreshold(msg.threshold, msg.is_majority ? -1 : msg.threshold);
      document.getElementById("threshold-value").textContent = msg.threshold;
      break;

    case "threshold_reached":
      state.lobbyStatus = "threshold_reached";
      if (state.pingInterval) { clearInterval(state.pingInterval); state.pingInterval = null; }
      renderVoteButton();
      showOverlay();
      break;

    case "vote_cancelled":
      state.lobbyStatus = "active";
      renderVoteButton();
      hideOverlay();
      break;
  }
}

// ── Overlay ───────────────────────────────────────────────────
function showOverlay() {
  document.getElementById("overlay").classList.remove("hidden");
}

// Called when user taps "Got it!" — marks as dismissed so it doesn't re-show on refresh
function dismissOverlay() {
  document.getElementById("overlay").classList.add("hidden");
  if (state.code) {
    const dismissed = JSON.parse(localStorage.getItem("barout_dismissed") || "{}");
    dismissed[state.code] = true;
    localStorage.setItem("barout_dismissed", JSON.stringify(dismissed));
  }
}

// Called internally (e.g. vote cancelled) — hides overlay and clears the dismissed flag
// so the overlay can show again if threshold is reached again
function hideOverlay() {
  document.getElementById("overlay").classList.add("hidden");
  if (state.code) {
    const dismissed = JSON.parse(localStorage.getItem("barout_dismissed") || "{}");
    delete dismissed[state.code];
    localStorage.setItem("barout_dismissed", JSON.stringify(dismissed));
  }
}

// ── Sharing ───────────────────────────────────────────────────
function copyCode(btn) {
  navigator.clipboard.writeText(state.code).then(() => flash(btn, "✓", "📋"));
}

function shareLink(btn) {
  const url = `${location.origin}?code=${state.code}`;
  if (navigator.share) {
    navigator.share({ title: "Join my BarOut lobby!", text: `Code: ${state.code}`, url });
  } else {
    navigator.clipboard.writeText(url).then(() => flash(btn, "✓", "🔗"));
  }
}

function flash(btn, temp, restore) {
  btn.textContent = temp;
  setTimeout(() => (btn.textContent = restore), 1500);
}

// ── Persistence ───────────────────────────────────────────────
function saveSession() {
  localStorage.setItem("barout_session", JSON.stringify({
    code:      state.code,
    sessionId: state.sessionId,
    isCreator: state.isCreator,
    hasVoted:  state.hasVoted,
  }));
}
