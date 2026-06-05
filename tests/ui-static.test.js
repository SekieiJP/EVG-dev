const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "game/assets/js/app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "game/assets/css/styles.css"), "utf8");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notStrictEqual(startIndex, -1, `${start} not found`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notStrictEqual(endIndex, -1, `${end} not found after ${start}`);
  return source.slice(startIndex, endIndex);
}

function run(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

run("screen reveal animation does not render stage rankings", () => {
  const revealRenderer = section(appSource, "function renderElevatorAnimation", "function renderFloorEvent");
  assert.strictEqual(revealRenderer.includes("screen-result-list"), false);
  assert.strictEqual(revealRenderer.includes("result.rankings"), false);
});

run("screen reveal score boxes are not sorted by score", () => {
  const scoreRows = section(appSource, "function buildRevealScoreRows", "function calculateRevealScore");
  assert.strictEqual(scoreRows.includes("b.score - a.score"), false);
  assert.strictEqual(scoreRows.includes("playerOrder"), true);
});

run("screen reveal score boxes occupy the side panel", () => {
  const revealScoreboard = section(cssSource, ".reveal-scoreboard", ".score-tile");
  assert.strictEqual(revealScoreboard.includes("grid-column: 1 / -1"), false);
  assert.strictEqual(revealScoreboard.includes("max-height: calc(100vh - 145px)"), true);
});
