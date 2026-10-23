# chess.com-games

my [chess.com](https://chess.com) games

## Viewer

A small browser viewer for `xb3llum.json`, styled after bellums.org.

```
python -m http.server 8000
```

Then open <http://localhost:8000/>. Opening `index.html` straight from disk
also works; it will ask you to pick the JSON file instead.

- `assets/pgn.js` – PGN parser and SAN move replayer (no dependencies)
- `assets/app.js` – game list, filters, board and eval panel
- `assets/engine.js` – Stockfish 10 (loaded from cdnjs) in a Web Worker;
  evaluates whatever position is on the board
- `assets/style.css` – the bellums.org skin, light and dark
- `tools/check-parser.js` – `node tools/check-parser.js` replays every game
  and checks the final position against chess.com's recorded FEN, then
  checks that engine moves (UCI) convert back to the same SAN

Keys on a game: ← → step, Home / End, F flips the board, E toggles the
engine, Esc goes back.
