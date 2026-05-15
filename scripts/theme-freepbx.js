// scripts/theme-freepbx.js
// FreePBX Tango Edition — paints a FreePBX-themed gameboard over the original
// background.gif and provides simple sound hooks. Runs after main.js so the
// engine has already drawn images/gameboard.gif onto #background-canvas; we
// then overwrite that canvas with our themed artwork.

(() => {
  const PALETTE = {
    void: "#0a0f1a",
    lan: "#2d6a30",
    lanLine: "#4a9a4e",
    dmz: "#16331a",
    median: "#1f4322",
    asphalt: "#1a1a1f",
    asphaltEdge: "#0d0d12",
    laneDash: "#f4d03f",
    rtp: "#0e2d4a",
    rtpStream: "#1e88c8",
    rtpGlow: "#7fd8ff",
    bank: "#243d5e",
    home: "#10391a",
    pad: "#80c343",
    padDark: "#5a8c2e",
    inkBright: "#e7eefc",
    inkDim: "#7a92b8",
    sangoma: "#e02020"
  };

  const SFX = {
    win: "sounds/ringback.wav",
    lose: "sounds/fast-busy.wav",
    coin: "sounds/dtmf-1.wav"
  };

  function paintBackground() {
    const c = document.getElementById("background-canvas");
    if (!c) return;
    const ctx = c.getContext("2d");
    const W = c.width;
    const H = c.height;
    const G = 80; // grid square size, must match engine

    const row = (n) => n * G;

    // Wipe to void
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, W, H);

    // -- Row 0: HUD strip (score area) --
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, row(0), W, G);

    // -- Rows 1-2: Home extensions zone (2 rows tall — pad alcove visual
    //    extends up into row 1; engine goal collision row is row 2, where the
    //    captured GoalFrog will appear at the bottom half of each alcove) --
    ctx.fillStyle = PALETTE.home;
    ctx.fillRect(0, row(1), W, G * 2);
    // green wall band along the top of the home zone
    ctx.fillStyle = PALETTE.padDark;
    ctx.fillRect(0, row(1), W, 6);
    // bottom accent strip
    ctx.fillStyle = PALETTE.pad;
    ctx.fillRect(0, row(3) - 3, W, 3);

    // five FreePBX pad slots, aligned to the engine's Goal x-positions
    // (33, 237, 441, 645, 849 with width ~78)
    const padSlots = [
      { x: 33, w: 78 },
      { x: 237, w: 78 },
      { x: 441, w: 78 },
      { x: 645, w: 78 },
      { x: 849, w: 78 }
    ];
    padSlots.forEach((slot, i) => {
      const yTop = row(1) + 8;
      const yH = G * 2 - 16;
      // slot frame
      ctx.fillStyle = PALETTE.padDark;
      ctx.fillRect(slot.x - 3, yTop - 2, slot.w + 6, yH + 4);
      // slot body
      ctx.fillStyle = PALETTE.pad;
      ctx.fillRect(slot.x, yTop, slot.w, yH);
      // EXT label sits in the TOP half of the alcove so the captured
      // GoalFrog (drawn at y=160, bottom half) stays visible
      ctx.fillStyle = "#0a2010";
      ctx.font = '700 14px ui-monospace, Menlo, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("EXT", slot.x + slot.w / 2, yTop + 18);
      ctx.font = '700 22px ui-monospace, Menlo, monospace';
      ctx.fillText(String(101 + i), slot.x + slot.w / 2, yTop + 44);
    });

    // -- Rows 3-7: RTP stream water (5 rows) --
    ctx.fillStyle = PALETTE.rtp;
    ctx.fillRect(0, row(3), W, G * 5);
    // packet-stream horizontal lines
    ctx.strokeStyle = PALETTE.rtpStream;
    ctx.lineWidth = 1;
    for (let y = row(3) + 8; y < row(8); y += 12) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    // brighter accent every 4th line
    ctx.strokeStyle = PALETTE.rtpGlow;
    ctx.globalAlpha = 0.5;
    for (let y = row(3) + 8; y < row(8); y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // RTP label tag (top-left of water)
    drawTag(ctx, "RTP STREAM ▸▸▸", 14, row(3) + 6, PALETTE.rtpGlow, PALETTE.void);

    // -- Row 8: DMZ safe median --
    ctx.fillStyle = PALETTE.median;
    ctx.fillRect(0, row(8), W, G);
    // dashed border edges
    drawDashedLine(ctx, 0, row(8) + 2, W, row(8) + 2, "#3a5e3a", 2, [12, 8]);
    drawDashedLine(ctx, 0, row(9) - 2, W, row(9) - 2, "#3a5e3a", 2, [12, 8]);
    drawTag(ctx, "Responsive Firewall", 14, row(8) + 6, "#bce8a6", PALETTE.void);

    // -- Rows 9-13: SIP trunk lanes (road, 5 rows) --
    ctx.fillStyle = PALETTE.asphalt;
    ctx.fillRect(0, row(9), W, G * 5);
    // top edge of road
    ctx.fillStyle = PALETTE.asphaltEdge;
    ctx.fillRect(0, row(9), W, 4);
    // yellow dashed lane separators between the 5 lanes
    for (let i = 1; i < 5; i++) {
      drawDashedLine(
        ctx, 0, row(9 + i), W, row(9 + i),
        PALETTE.laneDash, 4, [30, 22]
      );
    }
    drawTag(ctx, "SIPStation Trunk Lanes", 14, row(9) + 6, PALETTE.laneDash, PALETTE.void);

    // Bright green band marking the road/LAN boundary so the frog's starting
    // row reads clearly as safe ground rather than another lane.
    ctx.fillStyle = PALETTE.pad;
    ctx.fillRect(0, row(14) - 4, W, 4);

    // -- Row 14: Customer LAN (starting safe row) --
    ctx.fillStyle = PALETTE.lan;
    ctx.fillRect(0, row(14), W, G);
    // subtle grid pattern to suggest a network segment
    ctx.strokeStyle = PALETTE.lanLine;
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, row(14));
      ctx.lineTo(x, row(15));
      ctx.stroke();
    }
    drawTag(ctx, "CUSTOMER LAN", 14, row(14) + 6, "#e8ffd6", PALETTE.void);

    // -- Row 15: bottom HUD (TIME / lives) --
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, row(15), W, G);
    ctx.fillStyle = PALETTE.pad;
    ctx.fillRect(0, row(15), W, 3);
  }

  function drawTag(ctx, text, x, y, fg, bg) {
    ctx.font = '700 14px ui-monospace, Menlo, monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const pad = 6;
    const w = ctx.measureText(text).width + pad * 2;
    const h = 20;
    ctx.fillStyle = bg;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = fg;
    ctx.fillText(text, x + pad, y + 4);
  }

  function drawDashedLine(ctx, x1, y1, x2, y2, color, width, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Audio hooks
  const audio = {};
  for (const k of Object.keys(SFX)) {
    const a = new Audio(SFX[k]);
    a.preload = "auto";
    audio[k] = a;
  }
  window.playSound = (name) => {
    const a = audio[name];
    if (!a) return;
    try { a.currentTime = 0; } catch (e) {}
    a.play().catch(() => {});
  };

  // Paint after the engine has drawn images/gameboard.gif. The engine's image
  // load listener fires before window.load, so by window.load it's safe to
  // overwrite. We also paint immediately as a no-op safeguard in case the
  // engine hasn't drawn yet — and again on window.load to guarantee we win.
  if (document.readyState === "complete") {
    paintBackground();
  } else {
    window.addEventListener("load", paintBackground);
  }
})();
