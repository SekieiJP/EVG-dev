const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadGas() {
  const code = fs.readFileSync(path.join(__dirname, "../gas/src/Code.gs"), "utf8");
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
  calculateStage_,
  importConfig_,
  updateConfig_,
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
