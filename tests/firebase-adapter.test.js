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
  assert.strictEqual(nodes.completedGames, undefined);
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

run("firebase player updates write room player stats for self restore", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.players[0].skill = 42;
  room.players[0].stageSkillHistory = [8, 9, 10, 11, 12];

  const updates = EVGFirebaseAdapter.playerUpdates("/api/player/restore", room, "alice");

  assert.strictEqual(updates["players/alice"].name, "Alice");
  assert.strictEqual(updates["playerStats/alice"].currentSkill, 42);
  assert.deepStrictEqual(updates["playerStats/alice"].stageSkillHistory, [8, 9, 10, 11, 12]);
});

run("firebase root player node is the canonical saved player record", () => {
  const node = EVGFirebaseAdapter.rootPlayerNode({
    uuid: "alice",
    name: "Alice",
    skill: 18,
    stageSkillHistory: [3, 7, 8],
    joinedAt: "2026-06-06T00:00:00.000Z",
    lastSeenAt: "2026-06-06T00:01:00.000Z",
  }, "unit-room");

  assert.strictEqual(node.name, "Alice");
  assert.strictEqual(node.currentSkill, 18);
  assert.deepStrictEqual(node.stageSkillHistory, [3, 7, 8]);
  assert.strictEqual(node.roomId, "unit-room");
});

run("firebase restore uses saved name and skill without requiring a rename", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  const result = EVGFirebaseAdapter.restorePlayerFromMaster(Engine, room, "alice", {
    name: "Saved Alice",
    currentSkill: 33,
    stageSkillHistory: { 0: 4, 1: 10, 2: 19 },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.player.uuid, "alice");
  assert.strictEqual(result.player.name, "Saved Alice");
  assert.strictEqual(result.player.skill, 33);
  assert.deepStrictEqual(result.player.stageSkillHistory, [4, 10, 19]);
  assert.strictEqual(result.room.players.length, 1);
});

run("firebase restores RTDB object arrays in stage results", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  const stage = Engine.getCurrentStage(room);
  const result = Engine.calculateStage(stage, [{ uuid: "alice", name: "Alice", skill: 0, stageSkillHistory: [] }], {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {}, submittedAt: "2026-06-01T00:00:00.000Z" },
  });
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  const timeline = Object.assign({}, result.timeline);
  timeline[0] = Object.assign({}, timeline[0], {
    boarding: { 0: "alice" },
    exiting: {},
    passengersBeforeCheck: {},
    passengersAfterCheck: { 0: "alice" },
    forcedOff: {},
  });
  nodes.results = {
    [stage.stageId]: {
      stageId: result.stageId,
      params: result.params,
      players: {
        alice: Object.assign({}, result.players.alice, {
          successfulIntervals: { 0: result.players.alice.successfulIntervals[0] },
          predictionBreakdown: {},
          eventBreakdown: {},
        }),
      },
      timeline,
      rankings: Object.assign({}, result.rankings),
      totalBoarded: result.totalBoarded,
      forcedOffCount: result.forcedOffCount,
    },
  };
  nodes.completedGameDetails = {
    previous: {
      gameId: "previous",
      rankings: { 0: { uuid: "alice", name: "Alice", rank: 1, score: 12 } },
      stageResults: nodes.results,
    },
  };
  nodes.completedGameSummaries = {
    previous: {
      gameId: "previous",
      title: "previous",
      rankings: { 0: { uuid: "alice", name: "Alice", rank: 1, score: 12 } },
      stages: { 0: { stageId: "stage-001", name: "stage-001" } },
    },
  };

  const restored = EVGFirebaseAdapter.roomFromFirebaseNodes(nodes, Engine);
  const restoredResult = restored.stageResults[stage.stageId];
  assert.strictEqual(Array.isArray(restoredResult.timeline), true);
  assert.strictEqual(Array.isArray(restoredResult.rankings), true);
  assert.strictEqual(Array.isArray(restoredResult.timeline[0].boarding), true);
  assert.strictEqual(Array.isArray(restoredResult.timeline[0].forcedOff), true);
  assert.strictEqual(Array.isArray(restoredResult.players.alice.successfulIntervals), true);
  assert.strictEqual(restoredResult.timeline.length > 0, true);
  assert.strictEqual(Array.isArray(restored.completedGames[0].rankings), true);
  assert.strictEqual(Array.isArray(restored.completedGames[0].stageResults[stage.stageId].timeline), true);
  assert.strictEqual(Array.isArray(restored.completedGameSummaries[0].rankings), true);
});

run("firebase can reconstruct player-owned completed game details from summaries", () => {
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(Engine.createInitialRoom(Engine.DEFAULT_CONFIG));
  nodes.completedGameSummaries = {
    previous: {
      gameId: "previous",
      title: "Previous Game",
      rankings: { 0: { uuid: "alice", name: "Alice", rank: 1, score: 12 }, 1: { uuid: "bob", name: "Bob", rank: 2, score: 4 } },
      stages: { 0: { stageId: "stage-001", name: "stage-001" } },
    },
  };
  nodes.completedGamePlayerDetails = {
    alice: {
      previous: {
        gameId: "previous",
        scores: { alice: 12 },
        stageResults: {
          "stage-001": {
            stageId: "stage-001",
            players: { alice: { uuid: "alice", name: "Alice", score: 12, predictionBreakdown: [] } },
            rankings: { 0: { uuid: "alice", name: "Alice", rank: 1, score: 12 } },
          },
        },
      },
    },
  };

  const restored = EVGFirebaseAdapter.roomFromFirebaseNodes(nodes, Engine);

  assert.strictEqual(restored.completedGames.length, 1);
  assert.strictEqual(restored.completedGames[0].title, "Previous Game");
  assert.strictEqual(restored.completedGames[0].scores.alice, 12);
  assert.strictEqual(restored.completedGames[0].rankings.length, 2);
  assert.strictEqual(Boolean(restored.completedGames[0].stageResults["stage-001"].players.alice), true);
});

runAsync("firebase room rewrite uses atomic update and avoids rules-closed volatile parent nodes", async () => {
  const previousRoom = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  previousRoom.tickets = {
    "stage-001": {
      alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {}, submittedAt: "2026-06-01T00:00:00.000Z" },
    },
  };
  previousRoom.ticketPresence = {
    "stage-001": {
      alice: { status: "submitted", updatedAt: "2026-06-01T00:00:00.000Z" },
    },
  };
  previousRoom.stageResults = {
    "stage-001": { stageId: "stage-001", timeline: [], rankings: [], players: {} },
  };
  const nextRoom = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  const writes = [];
  const updateCalls = [];
  global.BroadcastChannel = undefined;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
  });
  adapter.firebaseDb = {};
  adapter.sdk = {
    ref: (_db, path) => ({ path }),
    update: async (ref, updates) => {
      updateCalls.push([ref.path, updates]);
    },
    set: async (ref, value) => {
      writes.push([ref.path, value]);
    },
  };

  await adapter.writeRestRoomChildren(nextRoom, { previousRoom, clearVolatile: true });

  assert.strictEqual(writes.length, 0);
  assert.strictEqual(updateCalls.length, 1);
  assert.strictEqual(updateCalls[0][0], "/rooms/unit-room");
  const paths = Object.keys(updateCalls[0][1]);
  assert.strictEqual(paths.includes("tickets"), false);
  assert.strictEqual(paths.includes("ticketPresence"), false);
  assert.strictEqual(paths.includes("results"), false);
  assert.strictEqual(updateCalls[0][1]["tickets/stage-001"], null);
  assert.strictEqual(updateCalls[0][1]["ticketPresence/stage-001"], null);
  assert.strictEqual(updateCalls[0][1]["results/stage-001"], null);
  assert.strictEqual(Boolean(updateCalls[0][1].public), true);
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
  assert.strictEqual(hostPaths.includes("completedGameDetails"), true);
  assert.strictEqual(hostPaths.includes("completedGames"), false);
  assert.strictEqual(screenPaths.includes("tickets"), false);
  assert.strictEqual(screenPaths.includes("results"), false);
  assert.strictEqual(playerPaths.includes("tickets"), false);
  assert.strictEqual(playerPaths.includes("completedGameSummaries"), true);
  assert.strictEqual(playerPaths.includes("completedGameDetails"), false);
  assert.strictEqual(playerPaths.includes("completedGamePlayerDetails/player-uid"), true);
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
  const joined = await adapter.post("/api/player/join", { name: "Alice", uuid: "alice" });
  assert.strictEqual(joined.ok, true);
  const started = await adapter.post("/api/host/start-stage", { hostToken: auth.hostToken, hostName: "host" });
  assert.strictEqual(started.room.room.phase, Engine.PHASES.STAGE_INTRO);
  const voting = await adapter.post("/api/host/open-voting", { hostToken: auth.hostToken, hostName: "host" });
  assert.strictEqual(voting.room.room.phase, Engine.PHASES.VOTING);
  const removed = await adapter.post("/api/host/remove-player", { hostToken: auth.hostToken, hostName: "host", uuid: "alice" });
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(removed.room.room.players.some((player) => player.uuid === "alice"), false);
});
