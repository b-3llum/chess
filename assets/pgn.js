/* =========================================================================
   pgn.js — a small PGN parser and SAN move applier.
   No dependencies. Works in the browser (window.PGN) and in Node
   (module.exports) so it can be tested against the whole archive.
   ========================================================================= */

(function (root) {
  "use strict";

  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const FILES = "abcdefgh";

  // ---- PGN text -> { headers, moves: [{ san, clk, comment }], result } ----

  function parsePGN(text) {
    const headers = {};
    const headerRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
    let m, lastHeaderEnd = 0;
    while ((m = headerRe.exec(text))) {
      headers[m[1]] = m[2].replace(/\\(.)/g, "$1");
      lastHeaderEnd = headerRe.lastIndex;
    }
    const body = text.slice(lastHeaderEnd);

    const moves = [];
    let result = headers.Result || "*";
    let i = 0, depth = 0;
    const n = body.length;

    while (i < n) {
      const c = body[i];
      if (c === "{") {
        const end = body.indexOf("}", i + 1);
        const comment = body.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
        if (depth === 0 && moves.length) attachComment(moves[moves.length - 1], comment);
        continue;
      }
      if (c === ";") { // rest-of-line comment
        const end = body.indexOf("\n", i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      if (c === "(") { depth++; i++; continue; }
      if (c === ")") { depth--; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }

      let j = i;
      while (j < n && !/[\s{}();]/.test(body[j])) j++;
      const tok = body.slice(i, j);
      i = j;
      if (depth > 0) continue;               // skip variations
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) { result = tok; continue; }
      if (/^\$\d+$/.test(tok)) continue;     // NAG
      const san = tok.replace(/^\d+\.+/, ""); // "12." / "12..." / "12.e4"
      if (san) moves.push({ san, clk: null, comment: "" });
    }
    return { headers, moves, result };
  }

  function attachComment(move, comment) {
    const clk = comment.match(/\[%clk\s+([\d:.]+)\]/);
    if (clk) move.clk = clk[1];
    const rest = comment.replace(/\[%[^\]]*\]/g, "").trim();
    if (rest) move.comment = move.comment ? move.comment + " " + rest : rest;
  }

  // ---- Position: board as 64 chars, index = rank * 8 + file (a1 = 0) ----

  function sq(name) { return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97); }
  function sqName(i) { return FILES[i & 7] + ((i >> 3) + 1); }
  function colorOf(p) { return p === p.toUpperCase() ? "w" : "b"; }

  class Position {
    constructor(fen) {
      const [placement, turn, castling, ep, half, full] = (fen || START_FEN).trim().split(/\s+/);
      this.board = new Array(64).fill(null);
      placement.split("/").forEach((row, r) => {
        let f = 0;
        for (const ch of row) {
          if (/\d/.test(ch)) f += +ch;
          else this.board[(7 - r) * 8 + f++] = ch;
        }
      });
      this.turn = turn || "w";
      this.castling = castling && castling !== "-" ? castling : "";
      this.ep = ep && ep !== "-" ? sq(ep) : -1;
      this.half = +half || 0;
      this.full = +full || 1;
    }

    clone() {
      const p = Object.create(Position.prototype);
      p.board = this.board.slice();
      p.turn = this.turn;
      p.castling = this.castling;
      p.ep = this.ep;
      p.half = this.half;
      p.full = this.full;
      return p;
    }

    fen() {
      const rows = [];
      for (let r = 7; r >= 0; r--) {
        let row = "", empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[r * 8 + f];
          if (!p) { empty++; continue; }
          if (empty) { row += empty; empty = 0; }
          row += p;
        }
        rows.push(row + (empty || ""));
      }
      return `${rows.join("/")} ${this.turn} ${this.castling || "-"} ${this.ep < 0 ? "-" : sqName(this.ep)} ${this.half} ${this.full}`;
    }

    inCheck() {
      return this.isAttacked(this.kingSquare(this.turn), this.turn === "w" ? "b" : "w");
    }

    // Apply a UCI move such as "e2e4" or "e7e8q". Returns its SAN.
    moveUci(uci) {
      const from = sq(uci.slice(0, 2)), to = sq(uci.slice(2, 4));
      const piece = this.board[from];
      if (!piece) throw new Error(`No piece on ${uci.slice(0, 2)}`);
      const type = piece.toLowerCase();
      let san;
      if (type === "k" && Math.abs(to - from) === 2) {
        san = to > from ? "O-O" : "O-O-O";
      } else {
        const capture = this.board[to] || (type === "p" && to === this.ep) ? "x" : "";
        const promo = uci[4] ? "=" + uci[4].toUpperCase() : "";
        const dest = uci.slice(2, 4);
        if (type === "p") {
          san = (capture ? uci[0] + "x" : "") + dest + promo;
        } else {
          // shortest disambiguation that picks out this exact piece
          const L = type.toUpperCase();
          for (const d of ["", uci[0], uci[1], uci.slice(0, 2)]) {
            try {
              if (this.clone().move(L + d + capture + dest).from === from) { san = L + d + capture + dest; break; }
            } catch (e) { /* ambiguous, try more */ }
          }
          if (!san) throw new Error(`Illegal move ${uci}`);
        }
      }
      this.move(san);
      return san + (this.inCheck() ? "+" : "");
    }

    // Can a piece of `type` standing on `from` move to `to` (ignoring pins)?
    reaches(type, from, to) {
      const df = (to & 7) - (from & 7), dr = (to >> 3) - (from >> 3);
      const adf = Math.abs(df), adr = Math.abs(dr);
      switch (type) {
        case "n": return (adf === 1 && adr === 2) || (adf === 2 && adr === 1);
        case "k": return Math.max(adf, adr) === 1;
        case "b": if (adf !== adr || !adf) return false; break;
        case "r": if ((adf && adr) || (!adf && !adr)) return false; break;
        case "q": if (!((adf === adr && adf) || (!adf !== !adr))) return false; break;
        default: return false;
      }
      const step = Math.sign(dr) * 8 + Math.sign(df);
      for (let s = from + step; s !== to; s += step) if (this.board[s]) return false;
      return true;
    }

    isAttacked(target, byColor) {
      for (let s = 0; s < 64; s++) {
        const p = this.board[s];
        if (!p || colorOf(p) !== byColor) continue;
        const t = p.toLowerCase();
        if (t === "p") {
          const dir = byColor === "w" ? 1 : -1;
          if ((target >> 3) - (s >> 3) === dir && Math.abs((target & 7) - (s & 7)) === 1) return true;
        } else if (this.reaches(t, s, target)) return true;
      }
      return false;
    }

    kingSquare(color) {
      const k = color === "w" ? "K" : "k";
      return this.board.indexOf(k);
    }

    // Apply a SAN move. Returns { from, to, san } or throws.
    move(sanRaw) {
      const san = sanRaw.replace(/[+#!?]+$/, "");
      const us = this.turn, them = us === "w" ? "b" : "w";
      const up = (t) => (us === "w" ? t.toUpperCase() : t);

      if (/^(O-O(-O)?|0-0(-0)?)$/.test(san)) {
        const long = san.length > 3;
        const rank = us === "w" ? 0 : 56;
        const from = rank + 4, to = rank + (long ? 2 : 6);
        const rFrom = rank + (long ? 0 : 7), rTo = rank + (long ? 3 : 5);
        if (this.board[from] !== up("k") || this.board[rFrom] !== up("r"))
          throw new Error(`Illegal castle ${sanRaw}`);
        this.board[to] = this.board[from]; this.board[from] = null;
        this.board[rTo] = this.board[rFrom]; this.board[rFrom] = null;
        this.finish(from, to, up("k"), null);
        return { from, to, san: sanRaw };
      }

      const m = san.match(/^([NBRQK])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([NBRQ]))?$/);
      if (!m) throw new Error(`Cannot read move "${sanRaw}"`);
      const [, pieceLetter, fromFile, fromRank, toName, promo] = m;
      const to = sq(toName);
      const type = pieceLetter ? pieceLetter.toLowerCase() : "p";
      const piece = up(type);

      let candidates = [];
      if (type === "p") {
        const dir = us === "w" ? 8 : -8;
        if (fromFile && fromFile !== toName[0]) {
          candidates.push(to - dir + (fromFile.charCodeAt(0) - toName.charCodeAt(0)));
        } else if (this.board[to - dir] === piece) {
          candidates.push(to - dir);
        } else if (!this.board[to - dir] && this.board[to - 2 * dir] === piece) {
          candidates.push(to - 2 * dir);
        }
      } else {
        for (let s = 0; s < 64; s++) {
          if (this.board[s] !== piece) continue;
          if (fromFile && FILES[s & 7] !== fromFile) continue;
          if (fromRank && (s >> 3) + 1 !== +fromRank) continue;
          if (this.reaches(type, s, to)) candidates.push(s);
        }
      }

      // Drop moves that would leave our king in check (pinned pieces).
      candidates = candidates.filter((from) => {
        if (this.board[from] !== piece) return false;
        const target = this.board[to];
        if (target && colorOf(target) === us) return false;
        const t = this.clone();
        t.board[to] = t.board[from]; t.board[from] = null;
        if (type === "p" && to === this.ep) t.board[to + (us === "w" ? -8 : 8)] = null;
        return !t.isAttacked(t.kingSquare(us), them);
      });
      if (candidates.length !== 1)
        throw new Error(`${candidates.length ? "Ambiguous" : "Illegal"} move "${sanRaw}"`);

      const from = candidates[0];
      const captured = this.board[to];
      if (type === "p" && to === this.ep && !captured) {
        this.board[to + (us === "w" ? -8 : 8)] = null; // en passant
      }
      this.board[to] = promo ? up(promo.toLowerCase()) : piece;
      this.board[from] = null;
      this.finish(from, to, piece, captured);
      return { from, to, san: sanRaw };
    }

    finish(from, to, piece, captured) {
      const lose = (chars) => { for (const c of chars) this.castling = this.castling.replace(c, ""); };
      if (piece === "K") lose("KQ");
      if (piece === "k") lose("kq");
      for (const s of [from, to]) {
        if (s === 0) lose("Q"); if (s === 7) lose("K");
        if (s === 56) lose("q"); if (s === 63) lose("k");
      }
      this.ep = piece.toLowerCase() === "p" && Math.abs(to - from) === 16 ? (from + to) / 2 : -1;
      this.half = piece.toLowerCase() === "p" || captured ? 0 : this.half + 1;
      if (this.turn === "b") this.full++;
      this.turn = this.turn === "w" ? "b" : "w";
    }
  }

  // ---- Replay: PGN text -> every position along the way ----

  function replay(pgnText, startFen) {
    const game = parsePGN(pgnText);
    const pos = new Position(game.headers.FEN || startFen || START_FEN);
    const plies = [{ board: pos.board.slice(), fen: pos.fen(), from: -1, to: -1 }];
    let error = null;
    for (const mv of game.moves) {
      try {
        const { from, to } = pos.move(mv.san);
        plies.push({ board: pos.board.slice(), fen: pos.fen(), from, to });
      } catch (e) {
        error = e.message;
        break;
      }
    }
    return { ...game, plies, error };
  }

  const api = { parsePGN, replay, Position, START_FEN, sqName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PGN = api;
})(typeof window !== "undefined" ? window : globalThis);
