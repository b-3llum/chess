/* =========================================================================
   app.js — game list and board viewer for a chess.com JSON export.
   Routes: "#"            list of games with filters
           "#g/<uuid>"    one game on a board
   ========================================================================= */

(function () {
  "use strict";

  const DATA_FILE = "xb3llum.json";
  const PAGE_SIZE = 50;
  const DRAWS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟︎" };

  const $main = document.getElementById("main");
  const $side = document.getElementById("sidemenu");

  const state = {
    games: [],
    me: "",
    filter: { cls: "all", res: "all", side: "all", q: "" },
    page: 0,
    view: null, // { game, replay, ply, flipped }
    evalOn: true,
    engine: null,
  };
  try { state.evalOn = localStorage.getItem("eval") !== "off"; } catch (e) {}

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- theme toggle (auto -> light -> dark) ----

  const themeBtn = document.getElementById("themeToggle");
  const modes = ["auto", "light", "dark"];
  function applyTheme(mode) {
    if (mode === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    themeBtn.textContent = mode;
  }
  let theme = "auto";
  try { theme = localStorage.getItem("theme") || "auto"; } catch (e) {}
  applyTheme(theme);
  themeBtn.addEventListener("click", () => {
    theme = modes[(modes.indexOf(theme) + 1) % modes.length];
    applyTheme(theme);
    try { localStorage.setItem("theme", theme); } catch (e) {}
  });

  // ---- loading ----

  async function load() {
    try {
      const res = await fetch(DATA_FILE);
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      init(await res.json());
    } catch (e) {
      showPicker(e);
    }
  }

  function showPicker(err) {
    $main.innerHTML = `
      <h1>Open your games</h1>
      <p class="lede">Couldn't fetch <code>${esc(DATA_FILE)}</code> (${esc(err.message)}).
        Browsers block that when the page is opened straight from disk.</p>
      <p>Either serve the folder, e.g. <code>python -m http.server</code> and open
        <a href="http://localhost:8000/">localhost:8000</a>, or pick the file here:</p>
      <p><input type="file" id="picker" accept=".json,application/json"></p>`;
    document.getElementById("picker").addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      $main.innerHTML = `<p class="loading">reading ${esc(file.name)}&hellip;</p>`;
      file.text().then((t) => init(JSON.parse(t))).catch(showPicker);
    });
  }

  function init(raw) {
    const games = Array.isArray(raw) ? raw : raw.games || [];
    // The archive owner is whoever appears in the most games.
    const seen = {};
    for (const g of games) for (const s of [g.white, g.black]) seen[s.username] = (seen[s.username] || 0) + 1;
    state.me = Object.keys(seen).sort((a, b) => seen[b] - seen[a])[0] || "";
    document.querySelector("#sitename a").textContent = state.me || "games";
    document.title = `${state.me} games`;

    state.games = games.map(summarise).sort((a, b) => b.end - a.end);
    window.addEventListener("hashchange", route);
    document.addEventListener("keydown", onKey);
    route();
  }

  function summarise(g) {
    const meWhite = g.white.username.toLowerCase() === state.me.toLowerCase();
    const mine = meWhite ? g.white : g.black;
    const opp = meWhite ? g.black : g.white;
    const res = mine.result === "win" ? "win" : DRAWS.has(mine.result) ? "draw" : "loss";
    const opening = g.eco ? decodeURIComponent(g.eco.split("/").pop()).replace(/-/g, " ") : "";
    const plies = (g.pgn.match(/\s\d+\.\s/g) || []).length + (g.pgn.match(/\s\d+\.\.\.\s/g) || []).length;
    return {
      raw: g, id: g.uuid, end: g.end_time, cls: g.time_class, rules: g.rules,
      side: meWhite ? "white" : "black", mine, opp, res, how: res === "win" ? opp.result : mine.result,
      opening, moves: Math.ceil(plies / 2),
    };
  }

  // ---- routing ----

  function route() {
    const m = location.hash.match(/^#g\/(.+)$/);
    const game = m && state.games.find((g) => g.id === m[1]);
    renderSide();
    if (game) openGame(game);
    else {
      state.view = null;
      if (state.engine) state.engine.stop();
      renderList();
    }
  }

  // ---- side index ----

  function filtered(except) {
    const f = state.filter, q = f.q.trim().toLowerCase();
    return state.games.filter((g) =>
      (except === "cls" || f.cls === "all" || g.cls === f.cls) &&
      (except === "res" || f.res === "all" || g.res === f.res) &&
      (except === "side" || f.side === "all" || g.side === f.side) &&
      (!q || g.opp.username.toLowerCase().includes(q) || g.opening.toLowerCase().includes(q)));
  }

  function renderSide() {
    const group = (key, title, options) => {
      const pool = filtered(key);
      const items = options.map(([val, label]) => {
        const count = val === "all" ? pool.length : pool.filter((g) => g[key] === val).length;
        const active = state.filter[key] === val ? " active" : "";
        return `<li><button class="pill${active}" data-k="${key}" data-v="${val}">${label}<span class="st">${count}</span></button></li>`;
      }).join("");
      return `<ul><span class="sh">${title}</span>${items}</ul>`;
    };
    $side.innerHTML =
      group("cls", "time", [["all", "All"], ["bullet", "Bullet"], ["blitz", "Blitz"], ["rapid", "Rapid"], ["daily", "Daily"]]) +
      group("res", "result", [["all", "All"], ["win", "Wins"], ["loss", "Losses"], ["draw", "Draws"]]) +
      group("side", "colour", [["all", "Either"], ["white", "White"], ["black", "Black"]]) +
      `<ul><span class="sh">search</span><li><input type="search" id="q" placeholder="opponent or opening" value="${esc(state.filter.q)}"></li></ul>`;

    $side.querySelectorAll(".pill").forEach((b) => b.addEventListener("click", () => {
      state.filter[b.dataset.k] = b.dataset.v;
      state.page = 0;
      if (location.hash) location.hash = ""; else route();
    }));
    const q = document.getElementById("q");
    q.addEventListener("input", () => {
      state.filter.q = q.value;
      state.page = 0;
      if (location.hash) { location.hash = ""; return; }
      renderList();
      // refresh counts without losing focus in the search box
      const pos = q.selectionStart;
      renderSide();
      const nq = document.getElementById("q");
      nq.focus(); nq.setSelectionRange(pos, pos);
    });
  }

  // ---- list view ----

  function renderList() {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const rows = list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    const w = list.filter((g) => g.res === "win").length;
    const l = list.filter((g) => g.res === "loss").length;
    const d = list.length - w - l;
    const pct = list.length ? Math.round((w / list.length) * 100) : 0;

    $main.innerHTML = `
      <p class="eyebrow">archive / ${esc(state.me)}</p>
      <h1>Games</h1>
      <p class="lede">${list.length.toLocaleString()} games &middot; ${w.toLocaleString()} won,
        ${l.toLocaleString()} lost, ${d.toLocaleString()} drawn (${pct}% wins).</p>
      <div class="tw"><table class="levels">
        <thead><tr><th>Date</th><th>Opponent</th><th>Side</th><th>Result</th><th>Opening</th><th>Moves</th><th>Type</th></tr></thead>
        <tbody>${rows.map(rowHtml).join("") || `<tr><td colspan="7" class="dim">No games match.</td></tr>`}</tbody>
      </table></div>
      <div class="pager">
        <button id="prev" ${state.page === 0 ? "disabled" : ""}>&larr; newer</button>
        <span>page ${state.page + 1} of ${pages}</span>
        <button id="next" ${state.page >= pages - 1 ? "disabled" : ""}>older &rarr;</button>
      </div>`;

    $main.querySelectorAll("tbody tr[data-id]").forEach((tr) =>
      tr.addEventListener("click", (ev) => {
        if (ev.target.closest("a")) return;
        location.hash = "g/" + tr.dataset.id;
      }));
    document.getElementById("prev").onclick = () => { state.page--; renderList(); window.scrollTo(0, 0); };
    document.getElementById("next").onclick = () => { state.page++; renderList(); window.scrollTo(0, 0); };
  }

  function rowHtml(g) {
    return `<tr data-id="${esc(g.id)}">
      <td class="n">${fmtDate(g.end)}</td>
      <td><a href="#g/${esc(g.id)}">${esc(g.opp.username)}</a> <span class="dim mono">${g.opp.rating}</span></td>
      <td class="n">${g.side}</td>
      <td>${resultTag(g)}</td>
      <td class="op">${esc(g.opening) || "&mdash;"}</td>
      <td class="n">${g.moves}</td>
      <td class="n">${esc(g.cls)}${g.rules !== "chess" ? " / " + esc(g.rules) : ""}</td>
    </tr>`;
  }

  function resultTag(g) {
    const word = { win: "won", loss: "lost", draw: "draw" }[g.res];
    return `<span class="tag tag--${g.res}" title="${esc(g.how)}">${word}</span>`;
  }

  function fmtDate(t) {
    const d = new Date(t * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // ---- game view ----

  function openGame(g) {
    if (!state.view || state.view.game !== g) {
      const replay = PGN.replay(g.raw.pgn, g.raw.initial_setup);
      state.view = { game: g, replay, ply: replay.plies.length - 1, flipped: g.side === "black" };
    }
    renderGame();
    window.scrollTo(0, 0);
  }

  function renderGame() {
    const { game: g, replay: r } = state.view;
    const h = r.headers;
    const tc = fmtTimeControl(g.raw.time_control);

    $main.innerHTML = `
      <p class="eyebrow"><a href="#">&larr; all games</a> &nbsp;/&nbsp; ${esc(g.cls)} ${esc(tc)} &nbsp;/&nbsp; ${fmtDate(g.end)}</p>
      <h1>${esc(h.White)} vs ${esc(h.Black)}</h1>
      <p class="lede">${esc(h.Termination || "")} &middot; ${resultTag(g)}</p>
      ${r.error ? `<p class="err">Replay stopped: ${esc(r.error)}</p>` : ""}
      <div class="game${state.evalOn ? " eval-on" : ""}" id="game">
        <div class="left">
          <div class="player" id="pTop"></div>
          <div class="bw">
            <div class="evalbar" id="evalbar" title="Evaluation"><div class="fill"></div></div>
            <div class="board" id="board"></div>
          </div>
          <div class="player" id="pBot"></div>
          <div class="ctl">
            <button data-go="start" title="Start (Home)">|&lt;</button>
            <button data-go="prev" title="Back (&larr;)">&lt;</button>
            <button data-go="next" title="Forward (&rarr;)">&gt;</button>
            <button data-go="end" title="End (End)">&gt;|</button>
            <button data-go="flip" title="Flip board (F)">flip</button>
            <span class="ply" id="plyInfo"></span>
          </div>
          <div class="eval">
            <div class="eh">
              <span class="score" id="evalScore"></span>
              <span class="dim mono" id="evalDepth"></span>
              <button id="evalToggle" title="Toggle engine (E)"></button>
            </div>
            <div class="pv" id="evalPv"></div>
          </div>
        </div>
        <div class="right">
          <div class="moves" id="moves">${movesHtml(r)}</div>
          <table class="kv">
            <tr><th>Opening</th><td>${h.ECOUrl ? `<a href="${esc(h.ECOUrl)}" target="_blank" rel="noopener">${esc(g.opening)}</a>` : esc(g.opening || "—")} <span class="dim mono">${esc(h.ECO || "")}</span></td></tr>
            <tr><th>Control</th><td>${esc(tc)} ${g.raw.rated ? "rated" : "casual"}</td></tr>
            <tr><th>Played</th><td>${esc(h.UTCDate || h.Date || "")} ${esc(h.UTCTime || "")} UTC</td></tr>
            <tr><th>Link</th><td><a href="${esc(g.raw.url)}" target="_blank" rel="noopener">chess.com</a></td></tr>
          </table>
        </div>
      </div>`;

    $main.querySelectorAll(".ctl button").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
    document.getElementById("evalToggle").addEventListener("click", toggleEval);
    $main.querySelector("#moves").addEventListener("click", (ev) => {
      const a = ev.target.closest("a[data-ply]");
      if (!a) return;
      ev.preventDefault();
      setPly(+a.dataset.ply);
    });
    drawPosition();
  }

  function movesHtml(r) {
    const legal = r.plies.length - 1;
    const blackFirst = r.plies.length > 1 && /\sb\s/.test(" " + (r.headers.FEN || "w") + " ");
    let rows = "", ply = 1, num = 1;
    const cell = (i) => i <= legal && r.moves[i - 1]
      ? `<a href="#" data-ply="${i}">${esc(r.moves[i - 1].san)}</a>` : "";
    if (blackFirst) { rows += `<tr><td class="n">1.</td><td>&hellip;</td><td>${cell(1)}</td></tr>`; ply = 2; num = 2; }
    for (; ply <= legal; ply += 2, num++) {
      rows += `<tr><td class="n">${num}.</td><td>${cell(ply)}</td><td>${cell(ply + 1)}</td></tr>`;
    }
    return `<table>${rows}</table><div class="res">${esc(r.result)}</div>`;
  }

  function drawPosition() {
    const v = state.view, r = v.replay, p = r.plies[v.ply];
    let html = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = v.flipped ? row : 7 - row;
        const file = v.flipped ? 7 - col : col;
        const i = rank * 8 + file;
        const dark = (rank + file) % 2 === 0;
        const hi = i === p.from || i === p.to ? " hi" : "";
        const pc = p.board[i];
        let inner = pc ? `<span class="pc ${pc === pc.toUpperCase() ? "pw" : "pb"}">${GLYPH[pc.toLowerCase()]}</span>` : "";
        if (col === 0) inner += `<span class="cr">${rank + 1}</span>`;
        if (row === 7) inner += `<span class="cf">${"abcdefgh"[file]}</span>`;
        html += `<div class="s ${dark ? "d" : "l"}${hi}">${inner}</div>`;
      }
    }
    document.getElementById("board").innerHTML = html;

    // players and clocks: last clock reading at or before this ply
    const clockFor = (white) => {
      for (let i = v.ply; i >= 1; i--) if ((i % 2 === 1) === white && r.moves[i - 1].clk) return r.moves[i - 1].clk;
      return fmtTimeControl(v.game.raw.time_control, true);
    };
    const bar = (white) => {
      const s = white ? v.game.raw.white : v.game.raw.black;
      const clk = clockFor(white) || "";
      const low = /^0:00:[0-2]\d/.test(clk) ? " low" : "";
      return `<span>${white ? "&#9817;" : "&#9823;"} ${esc(s.username)} <span class="dim mono">${s.rating}</span></span><span class="clk${low}">${esc(clk.replace(/^0:/, ""))}</span>`;
    };
    document.getElementById("pTop").innerHTML = bar(v.flipped);
    document.getElementById("pBot").innerHTML = bar(!v.flipped);

    const total = r.plies.length - 1;
    document.getElementById("plyInfo").textContent = `ply ${v.ply} / ${total}`;
    $main.querySelectorAll("#moves a").forEach((a) => a.classList.toggle("active", +a.dataset.ply === v.ply));
    const active = $main.querySelector("#moves a.active");
    if (active) {
      const box = document.getElementById("moves");
      const top = active.getBoundingClientRect().top - box.getBoundingClientRect().top;
      if (top < 0 || top > box.clientHeight - 30) box.scrollTop += top - box.clientHeight / 2;
    }
    const [bStart, bPrev, bNext, bEnd] = $main.querySelectorAll(".ctl button");
    bStart.disabled = bPrev.disabled = v.ply === 0;
    bNext.disabled = bEnd.disabled = v.ply === total;
    evaluate();
  }

  // ---- position evaluation ----

  function evaluate() {
    const v = state.view;
    document.getElementById("evalToggle").textContent = state.evalOn ? "engine on" : "engine off";
    document.getElementById("evalbar").classList.toggle("flipped", v.flipped);
    document.getElementById("evalDepth").textContent = "";
    if (!state.evalOn) {
      document.getElementById("evalScore").textContent = "";
      document.getElementById("evalPv").textContent = "Turn the engine on to evaluate positions.";
      if (state.engine) state.engine.stop();
      return;
    }
    document.getElementById("evalScore").textContent = "…";
    document.getElementById("evalPv").textContent = state.engine && state.engine.ready ? "thinking" : "loading Stockfish…";
    if (!state.engine) {
      try {
        state.engine = new Engine({
          depth: 20,
          onUpdate: showEval,
          onError: (msg) => { document.getElementById("evalPv").innerHTML = `<span class="err">Stockfish didn't load: ${esc(msg)}</span>`; },
        });
      } catch (e) {
        document.getElementById("evalPv").innerHTML = `<span class="err">Stockfish didn't load: ${esc(e.message)}</span>`;
        return;
      }
    }
    state.engine.analyse(v.replay.plies[v.ply].fen);
  }

  function showEval(info) {
    const v = state.view;
    if (!v || !state.evalOn || info.fen !== v.replay.plies[v.ply].fen) return;
    const $score = document.getElementById("evalScore");
    const $pv = document.getElementById("evalPv");
    const pos = new PGN.Position(info.fen);
    let white; // White's share of the bar, 0..100

    if (info.over) {
      const mated = pos.inCheck();
      $score.textContent = mated ? (pos.turn === "w" ? "0-1" : "1-0") : "½-½";
      $pv.textContent = mated ? "Checkmate." : "Stalemate.";
      white = mated ? (pos.turn === "w" ? 0 : 100) : 50;
    } else {
      if (info.mate !== undefined) {
        $score.textContent = (info.mate > 0 ? "+M" : "-M") + Math.abs(info.mate);
        white = info.mate > 0 ? 100 : 0;
      } else {
        $score.textContent = (info.cp > 0 ? "+" : "") + (info.cp / 100).toFixed(2);
        // chess.com/lichess-style curve: ±4 pawns fills most of the bar
        white = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * info.cp)) - 1);
      }
      document.getElementById("evalDepth").textContent = "depth " + info.depth;
      $pv.innerHTML = pvHtml(pos, info.pv.slice(0, 12));
    }
    document.querySelector("#evalbar .fill").style.height = white + "%";
    $score.className = "score" + (white > 52 ? " w" : white < 48 ? " b" : "");
  }

  function pvHtml(pos, pv) {
    const out = [];
    for (let i = 0; i < pv.length; i++) {
      const num = pos.turn === "w" ? `${pos.full}. ` : i === 0 ? `${pos.full}… ` : "";
      let san;
      try { san = pos.moveUci(pv[i]); } catch (e) { break; }
      out.push(`<span class="dim">${num}</span>${i === 0 ? `<b>${esc(san)}</b>` : esc(san)}`);
    }
    return out.join(" ");
  }

  function toggleEval() {
    state.evalOn = !state.evalOn;
    try { localStorage.setItem("eval", state.evalOn ? "on" : "off"); } catch (e) {}
    document.getElementById("game").classList.toggle("eval-on", state.evalOn);
    evaluate();
  }

  function setPly(n) {
    const v = state.view;
    v.ply = Math.max(0, Math.min(v.replay.plies.length - 1, n));
    drawPosition();
  }

  function go(what) {
    const v = state.view;
    if (!v) return;
    if (what === "start") setPly(0);
    else if (what === "prev") setPly(v.ply - 1);
    else if (what === "next") setPly(v.ply + 1);
    else if (what === "end") setPly(Infinity);
    else if (what === "flip") { v.flipped = !v.flipped; drawPosition(); }
  }

  function onKey(ev) {
    if (!state.view || ev.target.matches("input, textarea")) return;
    const map = { ArrowLeft: "prev", ArrowRight: "next", Home: "start", End: "end", f: "flip", F: "flip" };
    if (map[ev.key]) { ev.preventDefault(); go(map[ev.key]); }
    else if (ev.key === "e" || ev.key === "E") toggleEval();
    else if (ev.key === "Escape") location.hash = "";
  }

  function fmtTimeControl(tc, clockOnly) {
    if (!tc) return "";
    if (tc.includes("/")) return clockOnly ? "" : `${+tc.split("/")[1] / 86400}d/move`;
    const [base, inc] = tc.split("+").map(Number);
    const mins = Math.floor(base / 60), secs = base % 60;
    if (clockOnly) return `0:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    return (secs ? `${base}s` : `${mins}m`) + (inc ? ` +${inc}s` : "");
  }

  load();
})();
