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

async function runAsync(name, fn) {
  try {
    await fn();
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
  assert.strictEqual(nodes.meta.hostUid, undefined);
  assert.strictEqual(nodes.players.alice.name, "Alice");
  assert.strictEqual(nodes.scores.alice.total, 12);
  assert.strictEqual(nodes.ticketPresence["stage-001"].alice.status, "submitted");

  nodes.roles = { hosts: { "host-uid": true } };
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

run("firebase legacy helper remains isolated from serializer output", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.phase = Engine.PHASES.REVEAL;
  room.currentStageIndex = 1;
  room.roomVersion = 12;
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  assert.strictEqual(nodes.snapshot, undefined);
  assert.strictEqual(nodes.phase, undefined);

  const restored = EVGFirebaseAdapter.roomFromFirebaseNodes(room, Engine);

  assert.strictEqual(restored.phase, Engine.PHASES.REVEAL);
  assert.strictEqual(restored.currentStageIndex, 1);
  assert.strictEqual(restored.roomVersion, 12);
});

run("firebase subscriptions are scoped by screen role", () => {
  const hostPaths = EVGFirebaseAdapter.firebaseBaseSubscriptionPaths("host", "host-uid");
  const lockedHostPaths = EVGFirebaseAdapter.firebaseBaseSubscriptionPaths("host", "host-uid", false);
  const playerPaths = EVGFirebaseAdapter.firebaseBaseSubscriptionPaths("player", "player-uid");
  const screenPaths = EVGFirebaseAdapter.firebaseBaseSubscriptionPaths("screen", "screen-uid");
  const hostStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("host", "host-uid", "stage-001");
  const lockedHostStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("host", "host-uid", "stage-001", false);
  const screenStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("screen", "screen-uid", "stage-001");
  const playerStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("player", "player-uid", "stage-001");

  assert.strictEqual(hostPaths.includes(""), false);
  assert.strictEqual(playerPaths.includes(""), false);
  assert.strictEqual(hostPaths.includes("roles/hosts/host-uid"), true);
  assert.deepStrictEqual(lockedHostPaths, ["meta", "public", "config", "roomSettings", "roles/hosts/host-uid"]);
  assert.strictEqual(hostPaths.includes("tickets"), false);
  assert.strictEqual(hostPaths.includes("results"), false);
  assert.strictEqual(screenPaths.includes("tickets"), false);
  assert.strictEqual(screenPaths.includes("results"), false);
  assert.strictEqual(playerPaths.includes("tickets"), false);
  assert.strictEqual(playerPaths.includes("scores/player-uid"), true);
  assert.deepStrictEqual(hostStagePaths, ["ticketPresence/stage-001", "tickets/stage-001", "results/stage-001"]);
  assert.deepStrictEqual(lockedHostStagePaths, []);
  assert.deepStrictEqual(screenStagePaths, ["ticketPresence/stage-001", "results/stage-001"]);
  assert.deepStrictEqual(playerStagePaths, [
    "ticketPresence/stage-001/player-uid",
    "tickets/stage-001/player-uid",
    "results/stage-001/players/player-uid",
    "results/stage-001/rankings",
  ]);
});

runAsync("firebase mock host flow advances through public state", async () => {
  const storage = {};
  global.localStorage = {
    getItem: (key) => storage[key] || null,
    setItem: (key, value) => {
      storage[key] = String(value);
    },
    removeItem: (key) => {
      delete storage[key];
    },
  };
  global.BroadcastChannel = undefined;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: {
      FIREBASE_USE_LOCAL_MOCK: true,
      FIREBASE_ROOM_ID: "unit-mock-host-flow",
      FIREBASE_HOST_PASSWORD: "host",
    },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
  });
  await adapter.init();
  const auth = await adapter.post("/api/host/auth", { password: "host" });
  assert.strictEqual(auth.ok, true);
  const started = await adapter.post("/api/host/start-stage", { hostToken: auth.hostToken, hostName: "host" });
  assert.strictEqual(started.room.room.phase, Engine.PHASES.STAGE_INTRO);
  const voting = await adapter.post("/api/host/open-voting", { hostToken: auth.hostToken, hostName: "host" });
  assert.strictEqual(voting.room.room.phase, Engine.PHASES.VOTING);
});
