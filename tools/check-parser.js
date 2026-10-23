// Replays every game in the archive and compares the final position with
// the FEN chess.com recorded. Usage: node tools/check-parser.js [file.json]
const fs = require("fs");
const path = require("path");
const PGN = require("../assets/pgn.js");

const file = process.argv[2] || path.join(__dirname, "..", "xb3llum.json");
const games = JSON.parse(fs.readFileSync(file, "utf8"));

let ok = 0;
const failures = [];
for (const g of games) {
  const r = PGN.replay(g.pgn, g.initial_setup);
  const pos = new PGN.Position(r.headers.FEN || g.initial_setup);
  pos.board = r.plies[r.plies.length - 1].board;
  pos.turn = (r.plies.length - 1) % 2 === 0 ? pos.turn : (pos.turn === "w" ? "b" : "w");
  const got = pos.fen().split(" ").slice(0, 2).join(" ");
  const want = g.fen.split(" ").slice(0, 2).join(" ");
  if (!r.error && got === want) ok++;
  else failures.push({ url: g.url, rules: g.rules, error: r.error, got, want });
}

console.log(`${ok}/${games.length} games replay to the recorded final position`);
for (const f of failures.slice(0, 20)) console.log(f);

// Round trip: rebuild each move as UCI, convert it back with moveUci() and
// compare with the SAN in the PGN. This is what renders engine lines.
let moves = 0;
const sanMismatches = [];
for (const g of games) {
  const r = PGN.replay(g.pgn, g.initial_setup);
  for (let i = 1; i < r.plies.length; i++) {
    const { from, to, board } = r.plies[i];
    const pos = new PGN.Position(r.plies[i - 1].fen);
    const moved = pos.board[from];
    const promo = moved.toLowerCase() === "p" && board[to].toLowerCase() !== "p" ? board[to].toLowerCase() : "";
    let uci = PGN.sqName(from) + PGN.sqName(to) + promo;
    if (moved.toLowerCase() === "k" && Math.abs(to - from) === 2) uci = PGN.sqName(from) + PGN.sqName(to);
    let got;
    try { got = pos.moveUci(uci); } catch (e) { got = "ERR " + e.message; }
    const want = r.moves[i - 1].san.replace(/#$/, "+").replace(/[!?]+$/, "");
    moves++;
    if (got !== want) sanMismatches.push({ url: g.url, uci, got, want });
  }
}
console.log(`${moves - sanMismatches.length}/${moves} moves convert from UCI back to the same SAN`);
for (const f of sanMismatches.slice(0, 20)) console.log(f);
