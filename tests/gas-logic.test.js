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

run("GAS import config can preserve players for the next game", () => {
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
  assert.deepStrictEqual(Array.from(imported.room.players, (player) => player.uuid), ["alice", "bob"]);
  assert.strictEqual(imported.room.scores.alice, 0);
  assert.strictEqual(imported.room.stageResults["stage-001"], undefined);
  assert.strictEqual(imported.room.completedGames.length, 1);
  assert.strictEqual(imported.room.completedGames[0].scores.alice, 32);
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
  ["currentSkill", "averageSkill", "totalSkill", "totalScore", "averageScore", "bestScore", "gameCount", "stageCount", "forcedOffCount", "predictionAccuracy", "wins", "podiums"].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, key), true, key);
  });
});

run("GAS client config snippet contains deployed URL and deployment id", () => {
  const gas = loadGas();
  const deploymentId = "AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO";
  const snippet = gas.buildClientConfigSnippet_(`https://script.google.com/macros/s/${deploymentId}/exec`, deploymentId);
  assert.match(snippet, /AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO/);
  assert.match(snippet, /GAS_API_KEY: "AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO"/);
  assert.match(snippet, /USE_GAS_API: true/);
  assert.match(snippet, /POLL_INTERVAL_MS: 10000/);
});
