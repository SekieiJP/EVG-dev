const assert = require("assert");
const Engine = require("../game/assets/js/engine");
const { EVGFirebaseAdapter } = require("../game/assets/js/firebase-adapter");

const playerCount = 50;
const stageCount = 20;
const config = Engine.normalizeConfig({
  gameMeta: { title: "50-player-load-model" },
  stages: Array.from({ length: stageCount }, (_, index) => ({
    stageId: `stage-${String(index + 1).padStart(3, "0")}`,
    name: `Stage ${index + 1}`,
    params: { N: 20, X: 50, P: 5, Q: 1 },
    events: [],
  })),
});

let room = Engine.createInitialRoom(config);
for (let index = 0; index < playerCount; index += 1) {
  room = Engine.registerPlayer(room, `Player ${String(index + 1).padStart(2, "0")}`, `player-${index + 1}`).room;
}

let ticketWrites = 0;
let hostTransitions = 0;
for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
  room = Engine.advancePhase(room, stageIndex === 0 ? "start-stage" : "open-voting", "load-host").room;
  hostTransitions += 1;
  if (stageIndex === 0) {
    room = Engine.advancePhase(room, "open-voting", "load-host").room;
    hostTransitions += 1;
  }
  for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
    const uuid = `player-${playerIndex + 1}`;
    room = Engine.submitTicket(room, uuid, {
      boardFloor: 1 + (playerIndex % 5),
      exitFloor: 10 + (playerIndex % 10),
      predictions: {},
    }).room;
    ticketWrites += 1;
  }
  room = Engine.advancePhase(room, "close-voting", "load-host").room;
  hostTransitions += 1;
  room = Engine.tallyCurrentStage(room).room;
  hostTransitions += 1;
  room = Engine.advancePhase(room, "show-ranking", "load-host").room;
  hostTransitions += 1;
  room = Engine.advancePhase(room, "next-stage", "load-host").room;
  hostTransitions += 1;
}

const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
const currentStageId = config.stages[stageCount - 1].stageId;
const currentResultBytes = Buffer.byteLength(JSON.stringify(nodes.results[currentStageId] || {}), "utf8");
const publicBytes = Buffer.byteLength(JSON.stringify(nodes.public), "utf8");
const playerListBytes = Buffer.byteLength(JSON.stringify(nodes.players), "utf8");
const historySummaryBytes = Buffer.byteLength(JSON.stringify(nodes.completedGameSummaries), "utf8");
const estimatedWrites = ticketWrites + hostTransitions * 8;

assert.strictEqual(room.players.length, playerCount);
assert.strictEqual(Object.keys(room.stageResults).length, stageCount);
assert.strictEqual(ticketWrites, 1000);
assert.ok(estimatedWrites < 2500, `estimated writes ${estimatedWrites}`);
assert.ok(publicBytes < 4096, `public node ${publicBytes} bytes`);
assert.ok(playerListBytes < 64 * 1024, `player list ${playerListBytes} bytes`);
assert.ok(currentResultBytes < 1024 * 1024, `current result ${currentResultBytes} bytes`);
assert.ok(historySummaryBytes < 64 * 1024, `history summaries ${historySummaryBytes} bytes`);

console.log("ok 50-player/20-stage load model", {
  ticketWrites,
  hostTransitions,
  estimatedWrites,
  publicBytes,
  playerListBytes,
  currentResultBytes,
  historySummaryBytes,
});
