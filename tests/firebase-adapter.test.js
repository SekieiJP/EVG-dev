const assert = require("assert");
const Engine = require("../game/assets/js/engine");
const { EVGFirebaseAdapter } = require("../game/assets/js/firebase-adapter");

function run(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    throw error;
  }
}

run("firebase nodes round-trip room state without snapshot", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room = Engine.registerPlayer(room, "Bob", "bob").room;
  room.hostUid = "host-uid";
  room.phase = Engine.PHASES.VOTING;
  room.roomVersion = 7;
  room.scores = { alice: 12, bob: -3 };
  room.tickets = {
    "stage-001": {
      alice: { uuid: "alice", boardFloor: 1, exitFloor: 4, predictions: {}, submittedAt: "2026-06-01T00:00:00.000Z" },
    },
  };
  room.operations = [{ at: "2026-06-01T00:00:00.000Z", actor: "host", action: "open-voting" }];

  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  assert.strictEqual(nodes.snapshot, undefined);
  assert.strictEqual(nodes.meta.hostUid, "host-uid");
  assert.strictEqual(nodes.players.alice.name, "Alice");
  assert.strictEqual(nodes.scores.alice.total, 12);
  assert.strictEqual(nodes.ticketPresence["stage-001"].alice.status, "submitted");

  const restored = EVGFirebaseAdapter.roomFromFirebaseNodes(nodes, Engine);
  assert.strictEqual(restored.hostUid, "host-uid");
  assert.strictEqual(restored.phase, Engine.PHASES.VOTING);
  assert.strictEqual(restored.roomVersion, 7);
  assert.deepStrictEqual(restored.scores, { alice: 12, bob: -3 });
  assert.strictEqual(restored.players.length, 2);
  assert.strictEqual(restored.tickets["stage-001"].alice.exitFloor, 4);
  assert.strictEqual(restored.operations[0].action, "open-voting");
});

run("firebase operation nodes use stable unique keys", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.operations = [
    { at: "2026-06-01T00:00:01.000Z", actor: "host", action: "open-voting" },
    { id: "op-custom", at: "2026-06-01T00:00:00.000Z", actor: "host", action: "start-stage" },
  ];
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  assert.deepStrictEqual(Object.keys(nodes.operations).sort(), ["op-0000", "op-custom"]);
  assert.strictEqual(nodes.operations["op-0000"].id, "op-0000");
  assert.strictEqual(nodes.operations["op-custom"].id, "op-custom");
});
