const assert = require("assert");
const Engine = require("../game/assets/js/engine");

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
    gameMeta: { title: "multiplayer-test" },
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
      {
        stageId: "stage-002",
        name: "Second",
        params: { N: 6, X: 3, P: 8, Q: 1 },
        events: [],
      },
    ],
  };
}

function addPlayer(room, name, uuid) {
  const result = Engine.registerPlayer(room, name, uuid);
  assert.strictEqual(result.ok, true, result.error);
  return result.room;
}

function advance(room, action) {
  const result = Engine.advancePhase(room, action, "test-host");
  assert.strictEqual(result.ok, true, result.error);
  return result.room;
}

run("multiple players can join, submit, abstain, and tally one stage", () => {
  let room = Engine.createInitialRoom(config());
  room = addPlayer(room, "Alice", "alice");
  room = addPlayer(room, "Bob", "bob");
  room = addPlayer(room, "Carol", "carol");

  const duplicate = Engine.registerPlayer(room, "Alice", "other");
  assert.strictEqual(duplicate.ok, false);
  assert.match(duplicate.error, /名前/);

  const earlyAbstain = Engine.abstain(room, "alice");
  assert.strictEqual(earlyAbstain.ok, false);
  assert.deepStrictEqual(room.tickets, {});

  room = advance(room, "start-stage");
  room = advance(room, "open-voting");

  const unknownAbstain = Engine.abstain(room, "missing");
  assert.strictEqual(unknownAbstain.ok, false);

  let result = Engine.submitTicket(room, "alice", {
    boardFloor: 1,
    exitFloor: 3,
    predictions: { 0: "yes" },
  });
  assert.strictEqual(result.ok, true, result.error);
  room = result.room;

  result = Engine.submitTicket(room, "bob", {
    boardFloor: 2,
    exitFloor: 3,
    predictions: { 0: "yes" },
  });
  assert.strictEqual(result.ok, true, result.error);
  room = result.room;

  result = Engine.abstain(room, "carol");
  assert.strictEqual(result.ok, true, result.error);
  room = result.room;

  room = advance(room, "close-voting");

  const duplicateClose = Engine.advancePhase(room, "close-voting", "test-host");
  assert.strictEqual(duplicateClose.ok, false);

  const expiredRoom = Engine.deepClone(room);
  expiredRoom.countdownEndsAt = new Date(Date.now() - 1000).toISOString();
  const lateSubmit = Engine.submitTicket(expiredRoom, "alice", {
    boardFloor: 1,
    exitFloor: 1,
    predictions: {},
  });
  assert.strictEqual(lateSubmit.ok, false);

  result = Engine.tallyCurrentStage(room);
  assert.strictEqual(result.ok, true, result.error);
  room = result.room;

  const duplicateTally = Engine.tallyCurrentStage(room);
  assert.strictEqual(duplicateTally.ok, false);

  const stageResult = room.stageResults["stage-001"];
  assert.strictEqual(stageResult.players.alice.status, "success");
  assert.strictEqual(stageResult.players.bob.status, "success");
  assert.strictEqual(stageResult.players.carol.status, "abstained");
  assert.strictEqual(stageResult.players.alice.score, 32);
  assert.strictEqual(stageResult.players.bob.score, 23);
  assert.strictEqual(room.scores.alice, 32);
  assert.strictEqual(room.scores.bob, 23);
  assert.strictEqual(room.scores.carol, 0);
});

run("pending name changes apply on the next stage without mutating current results", () => {
  let room = Engine.createInitialRoom(config());
  room = addPlayer(room, "Alice", "alice");
  room = addPlayer(room, "Bob", "bob");
  room = advance(room, "start-stage");
  room = advance(room, "open-voting");

  const renamed = Engine.renamePlayer(room, "alice", "Alicia");
  assert.strictEqual(renamed.ok, true, renamed.error);
  room = renamed.room;
  assert.strictEqual(room.players.find((player) => player.uuid === "alice").name, "Alice");
  assert.strictEqual(room.players.find((player) => player.uuid === "alice").pendingName, "Alicia");

  let submitted = Engine.submitTicket(room, "alice", { boardFloor: 1, exitFloor: 1, predictions: {} });
  assert.strictEqual(submitted.ok, true, submitted.error);
  room = submitted.room;
  submitted = Engine.submitTicket(room, "bob", { boardFloor: 2, exitFloor: 2, predictions: {} });
  assert.strictEqual(submitted.ok, true, submitted.error);
  room = submitted.room;
  room = advance(room, "close-voting");

  const tallied = Engine.tallyCurrentStage(room);
  assert.strictEqual(tallied.ok, true, tallied.error);
  room = tallied.room;
  assert.strictEqual(room.stageResults["stage-001"].players.alice.name, "Alice");

  room = advance(room, "show-ranking");
  assert.strictEqual(Engine.advancePhase(room, "start-stage", "test-host").ok, false);
  room = advance(room, "next-stage");
  assert.strictEqual(room.currentStageIndex, 1);
  assert.strictEqual(room.players.find((player) => player.uuid === "alice").name, "Alicia");
  assert.strictEqual(room.players.find((player) => player.uuid === "alice").pendingName, null);
});

run("next game import preserves connected players and archives current results", () => {
  let room = Engine.createInitialRoom(config());
  room = addPlayer(room, "Alice", "alice");
  room = addPlayer(room, "Bob", "bob");
  room = advance(room, "start-stage");
  room = advance(room, "open-voting");
  let submitted = Engine.submitTicket(room, "alice", { boardFloor: 1, exitFloor: 3, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.error);
  room = submitted.room;
  submitted = Engine.submitTicket(room, "bob", { boardFloor: 2, exitFloor: 2, predictions: { 0: "yes" } });
  assert.strictEqual(submitted.ok, true, submitted.error);
  room = submitted.room;
  room = advance(room, "close-voting");
  const tallied = Engine.tallyCurrentStage(room);
  assert.strictEqual(tallied.ok, true, tallied.error);
  room = tallied.room;

  const nextConfig = config();
  nextConfig.gameMeta.title = "next-game";
  const nextRoom = Engine.createNextGameRoom(room, nextConfig);
  assert.strictEqual(nextRoom.config.gameMeta.title, "next-game");
  assert.deepStrictEqual(nextRoom.players.map((player) => player.uuid), ["alice", "bob"]);
  assert.strictEqual(nextRoom.scores.alice, 0);
  assert.strictEqual(nextRoom.scores.bob, 0);
  assert.strictEqual(nextRoom.stageResults["stage-001"], undefined);
  assert.strictEqual(nextRoom.completedGames.length, 1);
  assert.strictEqual(nextRoom.completedGames[0].scores.alice, 32);
  assert.strictEqual(nextRoom.players.find((player) => player.uuid === "alice").skill, room.players.find((player) => player.uuid === "alice").skill);
});
