const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "game/assets/js/app.js"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "game/assets/css/styles.css"), "utf8");
const configSource = fs.readFileSync(path.join(root, "game/assets/js/config.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "game/index.html"), "utf8");

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

run("long reveal animation compresses empty floors", () => {
  assert.strictEqual(appSource.includes("const REVEAL_SKIP_EMPTY_MIN_FLOORS = 30"), true);
  assert.strictEqual(appSource.includes("const REVEAL_EMPTY_FLOOR_FACTOR = 0.3"), true);
  assert.strictEqual(appSource.includes("function shouldCompressRevealFloor"), true);
  assert.strictEqual(appSource.includes("function hasRevealBonusAtFloor"), true);
});

run("reveal camera position is driven by computed schedule", () => {
  const revealRenderer = section(appSource, "function renderElevatorAnimation", "function renderFloorEvent");
  assert.strictEqual(revealRenderer.includes("getRevealSchedule(stage, result)"), true);
  assert.strictEqual(revealRenderer.includes("--reveal-shift"), true);
  assert.strictEqual(cssSource.includes("animation: cameraClimb"), false);
});

run("reveal completion is persisted and restored from room state", () => {
  assert.strictEqual(appSource.includes("revealEndsAt"), true);
  assert.strictEqual(appSource.includes("function stampRevealEndsAt"), true);
  const completion = section(appSource, "function isRevealPlaybackComplete", "function buildRevealScoreRows");
  assert.strictEqual(completion.includes("state.room.revealEndsAt"), true);
  assert.strictEqual(appSource.includes("room.revealEndsAt = room.revealEndsAt || null"), true);
});

run("final stage ranking hides the total score side column", () => {
  const rankingRenderer = section(appSource, "function renderRankingBoard", "function renderRankRow");
  assert.strictEqual(rankingRenderer.includes("!isLastStage"), true);
  assert.strictEqual(rankingRenderer.includes("const rankingRows = state.room.phase === Engine.PHASES.RANKING && result ? result.rankings : rankings"), true);
});

run("player view has no manual next button or ranking hold state", () => {
  assert.strictEqual(appSource.includes("player-next"), false);
  assert.strictEqual(appSource.includes("/api/player/proceed-next"), false);
  assert.strictEqual(appSource.includes("playerRankingHold"), false);
  assert.strictEqual(appSource.includes("restorePlayerRankingHoldIfNeeded"), false);
});

run("client runtime contains no GAS or local fallback transport", () => {
  assert.strictEqual(appSource.includes("GAS_API_BASE_URL"), false);
  assert.strictEqual(appSource.includes("GAS_API_KEY"), false);
  assert.strictEqual(appSource.includes("USE_GAS_API"), false);
  assert.strictEqual(appSource.includes("fetchJsonWithRetry"), false);
  assert.strictEqual(appSource.includes("screenLocalSync"), false);
  assert.strictEqual(configSource.includes("script.google.com/macros"), false);
  assert.strictEqual(configSource.includes("GAS_API"), false);
});

run("firebase client history uses subscribed data instead of REST fallbacks", () => {
  assert.strictEqual(appSource.includes('/api/history/player/'), false);
  assert.strictEqual(appSource.includes("buildLocalPersonalHistory"), true);
  assert.strictEqual(appSource.includes("startup-fetch"), false);
  assert.strictEqual(appSource.includes("maybeFetchRemoteAfterDeadline"), false);
  assert.strictEqual(appSource.includes("checkRevealCompletionRemoteState"), false);
  assert.strictEqual(appSource.includes("revealOnly"), false);
});

run("debug logs retain enough host evidence for UUID investigations", () => {
  assert.strictEqual(appSource.includes("state.logs = state.logs.slice(0, 2000)"), true);
  assert.strictEqual(appSource.includes("requestUuid"), true);
  assert.strictEqual(appSource.includes("payloadUuid"), true);
  assert.strictEqual(appSource.includes("responsePlayerUuid"), true);
  assert.strictEqual(appSource.includes("host.remove-player.start"), true);
  assert.strictEqual(appSource.includes("buttonUuid"), true);
  assert.strictEqual(appSource.includes("afterPlayers"), true);
  assert.strictEqual(appSource.includes("subscriptionErrors"), true);
});

run("api meta preserves explicit payload uuid for host target actions", () => {
  const metaBuilder = section(appSource, "function withApiMeta", "async function maybeBusy");
  assert.strictEqual(metaBuilder.includes("uuid: payload.uuid || state.playerUuid || \"\""), true);
  assert.strictEqual(metaBuilder.includes("uuid: state.playerUuid || payload.uuid || \"\""), false);
});

run("static assets include release cache busting query", () => {
  [
    "./assets/css/styles.css",
    "./assets/js/config.js",
    "./assets/js/engine.js",
    "./assets/vendor/qrcode-generator/qrcode.js",
    "./assets/js/firebase-adapter.js",
    "./assets/js/app.js",
  ].forEach((asset) => {
    assert.strictEqual(indexSource.includes(`${asset}?v=`), true, asset);
  });
});

run("player countdown updates do not rerender active ticket input", () => {
  assert.strictEqual(appSource.includes("data-player-countdown"), true);
  assert.strictEqual(appSource.includes("function updatePlayerCountdownDom"), true);
  assert.strictEqual(appSource.includes("function shouldPatchPlayerCountdownOnly"), true);
  assert.strictEqual(appSource.includes("needsPlayerCountdownPatch"), true);
  assert.strictEqual(cssSource.includes(".inline-countdown:empty"), true);
});

run("history player stats show the approved metric set only", () => {
  const statsRenderer = section(appSource, "function renderPlayerStats", "function renderSkillDelta");
  assert.strictEqual(statsRenderer.includes("累積得点"), false);
  assert.strictEqual(statsRenderer.includes("平均得点"), false);
  assert.strictEqual(statsRenderer.includes("表彰台回数"), false);
  ["現在Skill値", "平均Skill値", "合計Skill値", "最高得点", "参加ゲーム数", "参加ステージ数", "強制下車回数", "予想イベント正解率", "優勝回数"].forEach((label) => {
    assert.strictEqual(statsRenderer.includes(label), true, label);
  });
});
