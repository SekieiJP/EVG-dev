const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadGas() {
  const code = fs.readFileSync(path.join(__dirname, "../gas/src/Code.gs"), "utf8");
  const cache = {};
  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    Array,
    Boolean,
    parseInt,
    isFinite,
    Utilities: {
      getUuid: () => "mock-uuid",
      base64EncodeWebSafe: (text) => Buffer.from(String(text), "utf8").toString("base64url"),
      base64DecodeWebSafe: (text) => Array.from(Buffer.from(String(text), "base64url")),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString("utf8") }),
    },
    CacheService: {
      getScriptCache: () => ({
        put: (key, value) => {
          cache[key] = value;
        },
        get: (key) => cache[key] || null,
      }),
    },
  };
  vm.createContext(sandbox);
  return vm.runInContext(`${code}
({
  EVG_PHASES,
  createInitialRoom_,
  registerPlayer_,
  renamePlayer_,
  submitTicket_,
  abstain_,
  advancePhase_,
  tallyCurrentStage_,
  commitHostResult_,
  acknowledgePlayerNext_,
  calculateStage_,
  importConfig_,
  updateConfig_,
  verifyApiKeyValue_,
  verifyHostToken_,
  storeHostTokenForTest_,
  nextAvailableGameId_,
  chunkString_,
  sanitizeRoomForRole_,
  publicStatus_,
  buildPlayerGameSummary_,
  buildClientConfigSnippet_,
  normalizeGameConfigRow_,
  normalizeArchivePayload_,
  mergeArchiveRows_,
  recalculateArchiveRecords_,
});
`, sandbox);
}

function run(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    throw error;
  }
}

function config() {
  return {
    schemaVersion: "1.0.0",
    gameMeta: { title: "gas-test" },
    stages: [
      {
        stageId: "stage-001",
        name: "First",
        params: { N: 6, X: 2, P: 10, Q: 1 },
        events: [
          {
            type: "E1_prediction",
            question: "全員成功？",
            answerFormat: "yesno",
            metric: "allSucceeded",
            scoreOnCorrect: 5,
            scoreOnWrong: -2,
            scoreOnNoAnswer: 0,
          },
        ],
      },
    ],
  };
}

function addPlayer(gas, room, name, uuid) {
  const result = gas.registerPlayer_(room, name, uuid);
  assert.strictEqual(result.ok, true, result.message);
  return result.room;
}

function advance(gas, room, action) {
  const result = gas.advancePhase_(room, action, "test-host");
  assert.strictEqual(result.ok, true, result.message);
  return result.room;
}

run("GAS logic rejects invalid ticket and phase operations", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");

  assert.strictEqual(gas.abstain_(room, "alice").ok, false);
  assert.strictEqual(gas.advancePhase_(room, "open-voting", "test-host").ok, false);

  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");
  assert.strictEqual(gas.abstain_(room, "missing").ok, false);

  let submitted = gas.submitTicket_(room, "alice", {
    boardFloor: 1,
    exitFloor: 3,
    predictions: { 0: "yes" },
  });
  assert.strictEqual(submitted.ok, true, submitted.message);
  room = submitted.room;

  room = advance(gas, room, "close-voting");
  assert.strictEqual(gas.advancePhase_(room, "close-voting", "test-host").ok, false);

  const expiredRoom = JSON.parse(JSON.stringify(room));
  expiredRoom.countdownEndsAt = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(gas.submitTicket_(expiredRoom, "alice", { boardFloor: 1, exitFloor: 1, predictions: {} }).ok, false);
});

run("GAS logic prevents duplicate tally score accumulation", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");
  room = addPlayer(gas, room, "Bob", "bob");
  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");

  let submitted = gas.submitTicket_(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.message);
  room = submitted.room;
  submitted = gas.submitTicket_(room, "bob", { boardFloor: 2, exitFloor: 2, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.message);
  room = submitted.room;
  room = advance(gas, room, "close-voting");

  const tallied = gas.tallyCurrentStage_(room, "test-host");
  assert.strictEqual(tallied.ok, true, tallied.message);
  room = tallied.room;
  assert.strictEqual(room.scores.alice, 32);
  assert.strictEqual(room.scores.bob, 14);

  const duplicate = gas.tallyCurrentStage_(room, "test-host");
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(room.scores.alice, 32);
  assert.strictEqual(room.scores.bob, 14);

  const ranked = gas.advancePhase_(room, "show-ranking", "test-host");
  assert.strictEqual(ranked.ok, true, ranked.message);
  const acknowledged = gas.acknowledgePlayerNext_(ranked.room, "alice");
  assert.strictEqual(acknowledged.ok, true, acknowledged.message);
  assert.strictEqual(acknowledged.room.phase, gas.EVG_PHASES.RANKING);
  assert.strictEqual(gas.advancePhase_(ranked.room, "start-stage", "test-host").ok, false);
});

run("GAS prediction metric takes precedence over explicit correct answer", () => {
  const gas = loadGas();
  const stage = {
    stageId: "prediction",
    name: "Prediction",
    params: { N: 6, X: 2, P: 10, Q: 1 },
    events: [
      {
        type: "E1_prediction",
        question: "強制下車は何回？",
        answerFormat: "integer",
        metric: "forcedOffCount",
        correctAnswer: 99,
        scoreOnCorrect: 20,
        scoreOnWrong: -5,
        scoreOnNoAnswer: -2,
      },
    ],
  };
  const result = gas.calculateStage_(
    stage,
    [
      { uuid: "alice", name: "Alice" },
      { uuid: "bob", name: "Bob" },
    ],
    {
      alice: { uuid: "alice", boardFloor: 1, exitFloor: 2, predictions: { 0: "0" } },
      bob: { uuid: "bob", boardFloor: 2, exitFloor: 3, predictions: { 0: "99" } },
    }
  );
  assert.strictEqual(result.stats.forcedOffCount, 0);
  assert.strictEqual(result.players.alice.predictionBreakdown[0].correctAnswer, 0);
  assert.strictEqual(result.players.alice.predictionBreakdown[0].matched, true);
  assert.strictEqual(result.players.bob.predictionBreakdown[0].matched, false);
});

run("GAS import config archives results and starts next game with no displayed players", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");
  room = addPlayer(gas, room, "Bob", "bob");
  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");
  let submitted = gas.submitTicket_(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.message);
  room = submitted.room;
  submitted = gas.submitTicket_(room, "bob", { boardFloor: 2, exitFloor: 2, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.message);
  room = submitted.room;
  room = advance(gas, room, "close-voting");
  const tallied = gas.tallyCurrentStage_(room, "test-host");
  assert.strictEqual(tallied.ok, true, tallied.message);
  room = tallied.room;

  const nextConfig = config();
  nextConfig.gameMeta.title = "next-gas-game";
  const imported = gas.importConfig_(room, nextConfig, true);
  assert.strictEqual(imported.ok, true, imported.message);
  assert.strictEqual(imported.room.players.length, 0);
  assert.deepStrictEqual(Object.assign({}, imported.room.scores), {});
  assert.strictEqual(imported.room.stageResults["stage-001"], undefined);
  assert.strictEqual(imported.room.completedGames.length, 1);
  assert.strictEqual(imported.room.completedGames[0].scores.alice, 32);
  assert.strictEqual(imported.room.completedGames[0].interrupted, true);
  assert.strictEqual(imported.room.completedGames[0].finalPhase, gas.EVG_PHASES.REVEAL);
});

run("GAS auth helpers reject wrong API key and expired host token", () => {
  const gas = loadGas();
  const deploymentId = "AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO";
  assert.strictEqual(gas.verifyApiKeyValue_({ apiKey: "wrong" }, "secret").ok, false);
  assert.strictEqual(gas.verifyApiKeyValue_({ apiKey: "secret" }, "secret").ok, true);
  assert.strictEqual(gas.verifyApiKeyValue_({ apiKey: deploymentId }, "old-sheet-value").ok, true);
  assert.strictEqual(gas.verifyApiKeyValue_({ apiKey: "wrong" }, "").ok, true);
  gas.storeHostTokenForTest_("host-token:expired", new Date(Date.now() - 1000).toISOString());
  assert.strictEqual(gas.verifyHostToken_("host-token:expired").ok, false);
  gas.storeHostTokenForTest_("host-token:active", new Date(Date.now() + 60000).toISOString());
  assert.strictEqual(gas.verifyHostToken_("host-token:active").ok, true);
  assert.strictEqual(gas.verifyHostToken_("host-token:missing").ok, false);
});

run("GAS storage helpers chunk current game JSON and allocate unique game ids", () => {
  const gas = loadGas();
  assert.deepStrictEqual(Array.from(gas.chunkString_("abcdef", 2)), ["ab", "cd", "ef"]);
  assert.strictEqual(gas.nextAvailableGameId_("party", ["party", "party_2"]), "party_3");
  assert.strictEqual(gas.nextAvailableGameId_("new", ["party"]), "new");
});

run("GAS game config rows expose reusable active config metadata", () => {
  const gas = loadGas();
  const item = gas.normalizeGameConfigRow_({
    configId: "party-a",
    name: "Party A",
    status: "ACTIVE",
    sortOrder: 3,
    configJson: JSON.stringify(config()),
    notes: "reusable",
    updatedAt: "2026-05-25T00:00:00.000Z",
  });
  assert.strictEqual(item.valid, true, item.error);
  assert.strictEqual(item.configId, "party-a");
  assert.strictEqual(item.name, "Party A");
  assert.strictEqual(item.config.stages.length, 1);
  assert.strictEqual(item.config.stages[0].name, "First");

  const invalid = gas.normalizeGameConfigRow_({ configId: "bad", status: "ACTIVE", configJson: "{bad" });
  assert.strictEqual(invalid.valid, false);
  assert.ok(invalid.error);
});

run("GAS next game import archives interrupted games with completed stages", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");
  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");
  const submitted = gas.submitTicket_(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.message);
  room = advance(gas, submitted.room, "close-voting");
  room = gas.tallyCurrentStage_(room, "test-host").room;

  const nextConfig = config();
  nextConfig.gameMeta.title = "after-interrupt";
  const imported = gas.importConfig_(room, nextConfig, true);
  assert.strictEqual(imported.ok, true, imported.message);
  assert.strictEqual(imported.room.completedGames.length, 1);
  assert.strictEqual(imported.room.completedGames[0].interrupted, true);
  assert.strictEqual(imported.room.completedGames[0].stageResults["stage-001"].players.alice.score, 32);
  assert.strictEqual(imported.room.stageResults["stage-001"], undefined);
});

run("GAS public room hides other tickets and unrevealed player results", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");
  room = addPlayer(gas, room, "Bob", "bob");
  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");
  let submitted = gas.submitTicket_(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  room = submitted.room;
  submitted = gas.submitTicket_(room, "bob", { boardFloor: 2, exitFloor: 2, predictions: { 0: "yes" } });
  room = submitted.room;
  room = advance(gas, room, "close-voting");
  const tallied = gas.tallyCurrentStage_(room, "test-host");
  room = tallied.room;
  room.animationStartedAt = new Date().toISOString();
  const playerRoom = gas.sanitizeRoomForRole_(room, "player", "alice");
  assert.strictEqual(Boolean(playerRoom.tickets["stage-001"].alice), true);
  assert.strictEqual(Boolean(playerRoom.tickets["stage-001"].bob), false);
  assert.strictEqual(playerRoom.stageResults["stage-001"], undefined);
  const screenRoom = gas.sanitizeRoomForRole_(room, "screen", "");
  assert.strictEqual(Boolean(screenRoom.tickets["stage-001"].bob), true);
});

run("GAS status supports unchanged responses and host result commits", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");
  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");
  let submitted = gas.submitTicket_(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  room = submitted.room;
  room = advance(gas, room, "close-voting");

  const unchanged = gas.publicStatus_(room, { sinceVersion: room.roomVersion });
  assert.strictEqual(unchanged.ok, true);
  assert.strictEqual(unchanged.unchanged, true);
  assert.strictEqual(unchanged.room, undefined);

  const hostCalculated = gas.tallyCurrentStage_(JSON.parse(JSON.stringify(room)), "host").room;
  const committed = gas.commitHostResult_(room, hostCalculated, room.roomVersion, "host");
  assert.strictEqual(committed.ok, true, committed.message);
  assert.strictEqual(committed.room.phase, gas.EVG_PHASES.REVEAL);
  assert.strictEqual(Boolean(committed.room.stageResults["stage-001"]), true);
  assert.strictEqual(gas.commitHostResult_(committed.room, hostCalculated, committed.room.roomVersion, "host").ok, false);
  assert.strictEqual(gas.commitHostResult_(room, hostCalculated, Number(room.roomVersion || 0) + 99, "host").ok, false);
});

run("GAS save data summary contains required player metrics", () => {
  const gas = loadGas();
  let room = gas.createInitialRoom_(config());
  room = addPlayer(gas, room, "Alice", "alice");
  room = addPlayer(gas, room, "Bob", "bob");
  room = advance(gas, room, "start-stage");
  room = advance(gas, room, "open-voting");
  let submitted = gas.submitTicket_(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  room = submitted.room;
  submitted = gas.submitTicket_(room, "bob", { boardFloor: 2, exitFloor: 2, predictions: { 0: "yes" } });
  room = submitted.room;
  room = advance(gas, room, "close-voting");
  room = gas.tallyCurrentStage_(room, "test-host").room;
  const summary = gas.buildPlayerGameSummary_(room, room.players.find((player) => player.uuid === "alice"));
  ["currentSkill", "averageSkill", "totalSkill", "bestScore", "gameCount", "stageCount", "forcedOffCount", "predictionAccuracy", "wins"].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, key), true, key);
  });
  ["totalScore", "averageScore", "podiums"].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, key), false, key);
  });
});

run("GAS client config snippet keeps Firebase primary and configures archive-only GAS", () => {
  const gas = loadGas();
  const deploymentId = "AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO";
  const snippet = gas.buildClientConfigSnippet_(`https://script.google.com/macros/s/${deploymentId}/exec`, deploymentId);
  assert.match(snippet, /AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO/);
  assert.match(snippet, /FIREBASE_PROJECT_ID: "elevator-game-live"/);
  assert.match(snippet, /FIREBASE_ARCHIVE_GAS_URL: "https:\/\/script\.google\.com\/macros\/s\//);
  assert.match(snippet, /FIREBASE_ARCHIVE_API_KEY: "AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO"/);
  assert.doesNotMatch(snippet, /USE_GAS_API/);
  assert.doesNotMatch(snippet, /GAS_API_BASE_URL/);
  assert.match(snippet, /POLL_INTERVAL_MS: 10000/);
});

run("GAS archive normalizer accepts Firebase completed-game nodes", () => {
  const gas = loadGas();
  const archive = gas.normalizeArchivePayload_({
    archiveId: "archive-001",
    gameId: "summer-party-2026",
    interrupted: true,
    gameSummary: { title: "Summer party", finalPhase: "ranking" },
    finalRankings: [{ uuid: "alice", name: "Alice", score: 30, rank: 1 }],
    players: {
      alice: { name: "Alice", skill: 88, stageSkillHistory: [40, 48] },
    },
    playerSaveData: {
      alice: { nameSnapshot: "Alice", summary: { gameCount: 1, wins: 1 } },
    },
    stageResults: {
      "stage-001": {
        players: {
          alice: { score: 30, status: "success", stageSkill: 48, ticket: { boardFloor: 1 } },
        },
      },
    },
    stageSettings: {
      "stage-001": { name: "First", params: { N: 6, X: 2, P: 10, Q: 1 } },
    },
  });
  assert.strictEqual(archive.ok, true, archive.message);
  assert.strictEqual(archive.records.saveData.length, 1);
  assert.strictEqual(archive.records.stageResults.length, 1);
  assert.strictEqual(archive.records.stageSettings.length, 1);
  assert.strictEqual(archive.records.players.length, 1);
  assert.strictEqual(archive.records.gameHistory[0].archiveId, "archive-001");
  assert.strictEqual(archive.records.gameHistory[0].gameId, "summer-party-2026");
  assert.strictEqual(JSON.parse(archive.records.gameHistory[0].summaryJson).interrupted, true);
  assert.strictEqual(JSON.parse(archive.records.stageResults[0].resultJson).score, 30);

  const invalid = gas.normalizeArchivePayload_({ archiveId: "only-archive" });
  assert.strictEqual(invalid.ok, false);
});

run("GAS archive upsert keys make export retries idempotent", () => {
  const gas = loadGas();
  const original = [{ archiveId: "a-1", gameId: "g-1", uuid: "alice", score: 10 }];
  const retry = gas.mergeArchiveRows_(original, [{ archiveId: "a-1", gameId: "g-1", uuid: "alice", score: 10 }], ["archiveId", "gameId", "uuid"]);
  assert.strictEqual(retry.rows.length, 1);
  assert.strictEqual(retry.inserted, 0);
  assert.strictEqual(retry.updated, 0);
  assert.strictEqual(retry.unchanged, 1);

  const revised = gas.mergeArchiveRows_(retry.rows, [{ archiveId: "a-1", gameId: "g-1", uuid: "alice", score: 15 }], ["archiveId", "gameId", "uuid"]);
  assert.strictEqual(revised.rows.length, 1);
  assert.strictEqual(revised.updated, 1);
  assert.strictEqual(revised.rows[0].score, 15);

  const nextArchive = gas.mergeArchiveRows_(revised.rows, [{ archiveId: "a-2", gameId: "g-1", uuid: "alice", score: 15 }], ["archiveId", "gameId", "uuid"]);
  assert.strictEqual(nextArchive.rows.length, 2);
});

run("GAS archive recalculation updates only a selected game and player skill history", () => {
  const gas = loadGas();
  const recalculated = gas.recalculateArchiveRecords_({
    players: [{ uuid: "alice", name: "Alice", skill: 0, stageSkillHistoryJson: "[]" }],
    saveData: [
      { archiveId: "a-1", gameId: "g-1", uuid: "alice", nameSnapshot: "Alice", summaryJson: "{}" },
      { archiveId: "a-2", gameId: "g-2", uuid: "alice", nameSnapshot: "Alice", summaryJson: "{}" },
    ],
    stageResults: [
      { archiveId: "a-1", gameId: "g-1", uuid: "alice", stageId: "s-1", stageSkill: 30, score: 12, status: "success", resultJson: JSON.stringify({ ticket: { boardFloor: 1 }, predictionBreakdown: [{ noAnswer: false, matched: true }] }) },
      { archiveId: "a-2", gameId: "g-2", uuid: "alice", stageId: "s-1", stageSkill: 40, score: 99, status: "forced_off", resultJson: JSON.stringify({ ticket: { boardFloor: 1 }, predictionBreakdown: [{ noAnswer: false, matched: false }] }) },
    ],
    gameHistory: [
      { archiveId: "a-1", gameId: "g-1", summaryJson: JSON.stringify({ title: "one" }) },
      { archiveId: "a-2", gameId: "g-2", summaryJson: JSON.stringify({ title: "two" }) },
    ],
  }, "g-1");
  assert.strictEqual(recalculated.ok, true, recalculated.message);
  const first = recalculated.records.saveData.find((row) => row.gameId === "g-1");
  const second = recalculated.records.saveData.find((row) => row.gameId === "g-2");
  assert.strictEqual(JSON.parse(first.summaryJson).bestScore, 12);
  assert.strictEqual(JSON.parse(first.summaryJson).predictionAccuracy, 1);
  assert.strictEqual(second.summaryJson, "{}");
  assert.strictEqual(recalculated.records.players[0].skill, 70);
  assert.strictEqual(JSON.parse(recalculated.records.gameHistory.find((row) => row.gameId === "g-1").summaryJson).scores.alice, 12);
  assert.strictEqual(recalculated.records.gameHistory.find((row) => row.gameId === "g-2").summaryJson, JSON.stringify({ title: "two" }));
});

run("GAS web routing is archive-only and provisions archive_log", () => {
  const source = fs.readFileSync(path.join(__dirname, "../gas/src/Code.gs"), "utf8");
  const routeSource = source.slice(source.indexOf("function route_"), source.indexOf("function createInitialRoom_"));
  assert.match(routeSource, /\/api\/archive\/export/);
  assert.match(routeSource, /\/api\/archive\/recalculate/);
  assert.doesNotMatch(routeSource, /\/api\/status|\/api\/room\/state|\/api\/player\/join|saveRoom_/);
  assert.match(source.slice(0, source.indexOf("function ensureRuntimeReady_")), /archive_log/);
});
