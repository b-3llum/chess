/* =========================================================================
   engine.js — Stockfish in a Web Worker, wrapped for one job: evaluate
   whatever position is on the board right now.

   analyse(fen) can be called as often as you like (every arrow key press);
   only the latest position is searched. onUpdate gets
     { fen, depth, cp | mate (from White's point of view), pv: [uci...] }
   ========================================================================= */

(function (root) {
  "use strict";

  const STOCKFISH_URL = "https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js";

  class Engine {
    constructor({ depth = 20, movetime = 10000, onUpdate, onReady, onError }) {
      this.depth = depth;
      this.movetime = movetime;
      this.onUpdate = onUpdate || (() => {});
      this.current = null;  // fen being searched
      this.next = null;     // fen waiting for the current search to stop
      this.searching = false;
      this.ready = false;

      // A cross-origin script can't be a Worker directly, but a same-origin
      // blob worker may importScripts() it.
      const src = `importScripts(${JSON.stringify(STOCKFISH_URL)});`;
      const blobUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
      this.worker = new Worker(blobUrl);
      this.worker.onerror = (e) => onError && onError(e.message || "Engine failed to load");
      this.worker.onmessage = (e) => this.line(String(e.data), onReady);
      this.send("uci");
    }

    send(cmd) { this.worker.postMessage(cmd); }

    analyse(fen) {
      this.next = fen;
      if (!this.ready) return;
      if (this.searching) this.send("stop");
      else this.start();
    }

    stop() {
      this.next = null;
      if (this.searching) this.send("stop");
    }

    start() {
      if (!this.next) return;
      this.current = this.next;
      this.next = null;
      this.searching = true;
      this.send("position fen " + this.current);
      this.send(`go depth ${this.depth} movetime ${this.movetime}`);
    }

    line(text, onReady) {
      if (text === "uciok") {
        this.send("isready");
      } else if (text === "readyok" && !this.ready) {
        this.ready = true;
        onReady && onReady();
        this.start();
      } else if (/^info depth 0 score (mate|cp) 0/.test(text) || text.startsWith("bestmove (none)")) {
        // Checkmate or stalemate on the board. This build sends only the
        // depth 0 line and no bestmove, so the search ends here.
        if (!this.searching) return;
        this.searching = false;
        if (this.next) this.start();
        else this.report({ depth: 0, pv: [], over: true });
      } else if (text.startsWith("bestmove")) {
        this.searching = false;
        if (this.next) this.start();
      } else if (text.startsWith("info") && text.includes(" pv ") && !this.next) {
        const depth = +(text.match(/ depth (\d+)/) || [])[1];
        const score = text.match(/ score (cp|mate) (-?\d+)/);
        if (!score || / (lower|upper)bound/.test(text)) return;
        const pv = text.split(" pv ")[1].trim().split(/\s+/);
        this.report({ depth, [score[1]]: +score[2], pv });
      }
    }

    // UCI scores are from the side to move; flip to White's point of view.
    report(info) {
      const black = this.current.split(" ")[1] === "b";
      if (black && info.cp !== undefined) info.cp = -info.cp;
      if (black && info.mate !== undefined) info.mate = -info.mate;
      info.fen = this.current;
      this.onUpdate(info);
    }
  }

  root.Engine = Engine;
})(window);
