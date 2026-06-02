// scripts/score.js
// Tango Hop client integration: subscribes to engine score/win/over events,
// renders the HUD, and submits HMAC-signed scores to the leaderboard API.
// Falls back to localStorage when the API is unreachable or unconfigured.

(() => {
  const CFG = window.TANGOHOP_CONFIG || {};
  const API_URL = (CFG.API_URL || "").replace(/\/$/, "");
  const SECRET = CFG.SECRET || "";
  const STORE_KEY = "tangohop-highscore";
  const ONLINE = !!(API_URL && SECRET);

  let currentScore = 0;
  let localHighScore = +localStorage.getItem(STORE_KEY) || 0;
  let serverRank = null;
  let gameStartedAt = null;
  let submittedForThisRun = false;
  const MAX_DURATION_MS = 30 * 60 * 1000;

  // ---------- HUD ----------
  const hud = document.createElement("div");
  hud.id = "score";
  document.getElementById("score-panel")?.appendChild(hud) ||
    document.body.appendChild(hud);

  function renderHud() {
    const parts = [
      `SCORE ${currentScore}`,
      `HIGH ${Math.max(localHighScore, currentScore)}`
    ];
    if (serverRank) parts.push(`RANK #${serverRank}`);
    if (!ONLINE) parts.push("OFFLINE");
    hud.textContent = parts.join("   ·   ");
  }
  renderHud();

  // ---------- HMAC signing (Web Crypto) ----------
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }
  async function sign(payload) {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload)
    );
    return bytesToHex(new Uint8Array(sig));
  }

  // ---------- Name prompt modal ----------
  function promptForName(score, isWin) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position: fixed; inset: 0;
        background: rgba(10,15,26,0.85);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; backdrop-filter: blur(6px);
      `;
      const modal = document.createElement("div");
      modal.style.cssText = `
        background: #11182a; border: 2px solid #80c343;
        border-radius: 8px; padding: 24px; width: 360px;
        font-family: system-ui, sans-serif; color: #e7eefc;
      `;
      modal.innerHTML = `
        <h2 style="margin:0 0 8px 0; color:#80c343;
                   font:700 18px 'Arcade Classic', system-ui, sans-serif;
                   letter-spacing: 2px;">
          ${isWin ? "CALL COMPLETED!" : "GAME OVER"}
        </h2>
        <p style="margin:0 0 16px 0; font-size:14px;">
          Score: <strong style="color:#80c343">${score}</strong>
          ${
            score > localHighScore
              ? ' &nbsp;<span style="color:#f4d03f">NEW HIGH!</span>'
              : ""
          }
          <br>Enter your handle for the leaderboard.
        </p>
        <input id="th-name" maxlength="24"
          placeholder="Your handle (1–24 alnum / _-)"
          style="width:100%; box-sizing:border-box; padding:10px;
                 background:#0a0f1a; color:#e7eefc; border:1px solid #2a3654;
                 border-radius:4px; font:600 14px ui-monospace, Menlo, monospace;
                 margin-bottom:10px;">
        <input id="th-email" type="email" maxlength="120" required
          placeholder="Email (swag only, auto-deleted after 30 days)"
          style="width:100%; box-sizing:border-box; padding:10px;
                 background:#0a0f1a; color:#e7eefc; border:1px solid #2a3654;
                 border-radius:4px; font:14px system-ui, sans-serif;
                 margin-bottom:16px;">
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button id="th-skip" style="padding:8px 14px; background:transparent;
            color:#7a92b8; border:1px solid #2a3654; border-radius:4px;
            cursor:pointer; font:600 13px system-ui, sans-serif;">Skip</button>
          <button id="th-submit" style="padding:8px 14px; background:#80c343;
            color:#0a2010; border:none; border-radius:4px;
            cursor:pointer; font:700 13px system-ui, sans-serif;">Submit</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const nameInput = modal.querySelector("#th-name");
      const emailInput = modal.querySelector("#th-email");
      nameInput.focus();

      function close(val) {
        overlay.remove();
        resolve(val);
      }
      // Quick client-side gut-check on common slurs/swears for instant feedback.
      // Server runs the full obscenity matcher and is the authority.
      const CLIENT_PROFANITY = /\b(fuck|fuk|fck|shit|sht|ass|azz|cunt|cnt|bitch|btch|cock|dick|dik|piss|tit|fag|jew|nig|nazi|kkk|kys|cum|jiz|jizz|wank|hoe|slut|twat|whore)\b/i;
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      modal.querySelector("#th-submit").onclick = () => {
        const name = nameInput.value.trim();
        if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) {
          nameInput.style.borderColor = "#e02020";
          nameInput.focus();
          return;
        }
        if (CLIENT_PROFANITY.test(name)) {
          nameInput.style.borderColor = "#e02020";
          showResult("Nice try — no froggin' around. Let's keep it clean.", "#e02020");
          nameInput.focus();
          return;
        }
        const email = emailInput.value.trim();
        if (!EMAIL_RE.test(email) || email.length > 120) {
          emailInput.style.borderColor = "#e02020";
          emailInput.focus();
          return;
        }
        close({ name, email });
      };
      modal.querySelector("#th-skip").onclick = () => close(null);
      const onkey = (e) => {
        if (e.key === "Enter") modal.querySelector("#th-submit").click();
        if (e.key === "Escape") close(null);
      };
      nameInput.onkeydown = onkey;
      emailInput.onkeydown = onkey;
    });
  }

  // ---------- Result toast ----------
  function showResult(message, color = "#80c343") {
    const t = document.createElement("div");
    t.textContent = message;
    t.style.cssText = `
      position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%);
      background: #11182a; color: ${color}; border: 1px solid ${color};
      padding: 12px 20px; border-radius: 6px;
      font: 700 14px 'Arcade Classic', system-ui, sans-serif;
      letter-spacing: 1.5px; z-index: 9999;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    `;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  // ---------- Submission ----------
  async function submitScore(finalScore, isWin) {
    if (submittedForThisRun) return;
    submittedForThisRun = true;

    if (finalScore <= 0) return;

    const isNewLocalHigh = finalScore > localHighScore;
    const entry = await promptForName(finalScore, isWin);
    if (!entry) {
      // Skipped — still save local high as a courtesy
      if (isNewLocalHigh) {
        localHighScore = finalScore;
        localStorage.setItem(STORE_KEY, finalScore);
        renderHud();
      }
      return;
    }

    // Always update local high after a submitted score
    if (isNewLocalHigh) {
      localHighScore = finalScore;
      localStorage.setItem(STORE_KEY, finalScore);
    }

    if (!ONLINE) {
      renderHud();
      showResult("SAVED LOCALLY (NO SERVER)", "#f4d03f");
      return;
    }

    const playStart = gameStartedAt ?? Date.now();
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(1, Date.now() - playStart));
    const nonce = randomNonce();
    const payload = `${entry.name}|${finalScore}|${durationMs}|${nonce}`;

    try {
      const signature = await sign(payload);
      const res = await fetch(`${API_URL}/api/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: entry.name,
          email: entry.email,
          score: finalScore,
          durationMs,
          nonce,
          signature
        })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const reason = (body.error || `http_${res.status}`).toString().toUpperCase();
        console.warn("Score rejected:", reason, body);
        renderHud();
        // Server may return a friendly `message` (e.g. profanity hint); prefer it.
        showResult(body.message || `REJECTED: ${reason}`, "#e02020");
        return;
      }
      const data = await res.json();
      serverRank = data.rank;
      renderHud();
      showResult(`RANK #${data.rank} ON THE LEADERBOARD`);
    } catch (err) {
      console.warn("Score submission failed:", err);
      renderHud();
      showResult("SERVER UNREACHABLE — SAVED LOCALLY", "#e02020");
    }
  }

  // ---------- Engine hookups ----------
  function bind() {
    if (!window.Frogger || !window.Frogger.observer) {
      setTimeout(bind, 50);
      return;
    }
    Frogger.observer.subscribe("game-load", () => {
      gameStartedAt = null;
      submittedForThisRun = false;
    });
    Frogger.observer.subscribe("player-moved", () => {
      // First move marks the real game start. Page-load is the wrong signal
      // for the booth display, which sits open for hours between players.
      if (gameStartedAt === null) gameStartedAt = Date.now();
    });
    Frogger.observer.subscribe("score-change", (newScore) => {
      currentScore = newScore;
      renderHud();
    });
    Frogger.observer.subscribe("high-score-change", (newHigh) => {
      if (newHigh > localHighScore) {
        localHighScore = newHigh;
        renderHud();
      }
    });
    Frogger.observer.subscribe("game-won", () => {
      submitScore(currentScore, true);
    });
    Frogger.observer.subscribe("game-over", () => {
      submitScore(currentScore, false);
    });
  }
  bind();
})();
