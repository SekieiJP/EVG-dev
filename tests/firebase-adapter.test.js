const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Engine = require("../game/assets/js/engine");
const FirebaseAdapterModule = require("../game/assets/js/firebase-adapter");
const { EVGFirebaseAdapter } = FirebaseAdapterModule;

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

function nestedValue(source, pathValue) {
  return String(pathValue || "")
    .split("/")
    .filter(Boolean)
    .reduce((value, key) => value && value[key], source);
}

function applyMultiLocationUpdates(source, updates) {
  const next = Engine.deepClone(source || {});
  Object.keys(updates || {}).forEach((pathValue) => {
    const parts = String(pathValue).split("/").filter(Boolean);
    const leaf = parts.pop();
    let cursor = next;
    parts.forEach((part) => {
      cursor[part] = cursor[part] && typeof cursor[part] === "object" ? cursor[part] : {};
      cursor = cursor[part];
    });
    if (updates[pathValue] === null) delete cursor[leaf];
    else cursor[leaf] = Engine.deepClone(updates[pathValue]);
  });
  return next;
}

function productionLikeRestHarness(room, allResults, options = {}) {
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  nodes.results = Engine.deepClone(allResults || {});
  nodes.roles = { hosts: { host: true } };
  Object.assign(nodes, Engine.deepClone(options.extraNodes || {}));
  const reads = [];
  const updates = [];
  const roomPrefix = "/rooms/unit-room/";
  return {
    reads,
    updates,
    sdk: {
      ref: (_db, pathValue) => pathValue,
      get: async (pathValue) => {
        reads.push(pathValue);
        if ((options.failReadPaths || []).includes(pathValue)) {
          throw new Error(options.readError || "Permission denied");
        }
        const relative = String(pathValue).startsWith(roomPrefix)
          ? String(pathValue).slice(roomPrefix.length)
          : String(pathValue).replace(/^\//, "");
        const value = nestedValue(nodes, relative);
        return {
          exists: () => value !== undefined && value !== null,
          val: () => value === undefined ? null : Engine.deepClone(value),
        };
      },
      update: async (pathValue, nextUpdates) => {
        updates.push({ path: pathValue, updates: Engine.deepClone(nextUpdates) });
      },
    },
  };
}

function productionStageResult(stageId, calculatedAt, playerRows) {
  const players = (playerRows || []).reduce((acc, row) => {
    acc[row.uuid] = {
      uuid: row.uuid,
      name: row.name,
      score: row.score,
      stageSkill: row.stageSkill,
      ticket: { uuid: row.uuid, abstained: false },
    };
    return acc;
  }, {});
  return {
    stageId,
    stageName: stageId,
    calculatedAt,
    players,
    rankings: (playerRows || []).map((row, index) => ({
      uuid: row.uuid,
      name: row.name,
      rank: index + 1,
      score: row.score,
      currentSkill: row.stageSkill,
    })),
    timeline: [],
    stats: {},
  };
}

function productionFourStageConfig() {
  const config = Engine.deepClone(Engine.DEFAULT_CONFIG);
  const fourth = Engine.deepClone(config.stages[config.stages.length - 1]);
  fourth.stageId = "stage-004";
  fourth.name = "Stage 4";
  config.stages.push(fourth);
  return Engine.normalizeConfig(config);
}

run("firebase nodes round-trip room state without snapshot", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room = Engine.registerPlayer(room, "Bob", "bob").room;
  room.hostUid = "host-uid";
  room.phase = Engine.PHASES.VOTING;
  room.roomVersion = 7;
  room.countdownSeconds = 24;
  room.revealEndsAt = "2026-06-01T00:02:00.000Z";
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
  assert.strictEqual(nodes.meta.schemaVersion, "firebase-rtdb-v4-public-projection");
  assert.strictEqual(nodes.players.alice.name, "Alice");
  assert.strictEqual(nodes.scores.alice.total, 12);
  assert.strictEqual(nodes.roomSettings.countdownSeconds, 24);
  assert.strictEqual(nodes.ticketPresence["stage-001"].alice.status, "submitted");

  nodes.roles = { hosts: { "host-uid": true } };
  const restored = EVGFirebaseAdapter.roomFromFirebaseNodes(nodes, Engine);
  assert.strictEqual(restored.hostUid, "host-uid");
  assert.strictEqual(restored.firebaseSchemaVersion, "firebase-rtdb-v4-public-projection");
  assert.strictEqual(restored.phase, Engine.PHASES.VOTING);
  assert.strictEqual(restored.roomVersion, 7);
  assert.strictEqual(restored.countdownSeconds, 24);
  assert.strictEqual(restored.revealEndsAt, "2026-06-01T00:02:00.000Z");
  assert.deepStrictEqual(restored.scores, { alice: 12, bob: -3 });
  assert.strictEqual(restored.players.length, 2);
  assert.strictEqual(restored.tickets["stage-001"].alice.exitFloor, 4);
  assert.strictEqual(restored.operations[0].action, "open-voting");
});

run("firebase Host room-setting update persists only the validated countdown setting with the atomic phase version", () => {
  const current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current.roomId = "unit-room";
  current.roomVersion = 7;
  const changed = Engine.updateRoomSettings(
    current,
    { countdownSeconds: 18 },
    "host",
    "2026-07-31T00:00:00.000Z"
  );
  assert.strictEqual(changed.ok, true, changed.error);
  changed.room.roomVersion = 8;
  const updates = EVGFirebaseAdapter.hostAtomicUpdates(
    "/api/host/update-room-settings",
    current,
    changed.room,
    "unit-room",
    Engine
  );
  assert.strictEqual(updates["rooms/unit-room/roomSettings/countdownSeconds"], 18);
  assert.strictEqual(updates["rooms/unit-room/public"].roomVersion, 8);
  assert.strictEqual(updates["rooms/unit-room/roomSettings"], undefined);
});

run("firebase operation nodes use stable unique keys", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.operations = [
    { at: "2026-06-01T00:00:01.000Z", actor: "host", action: "open-voting" },
    { id: "op-0000", at: "2026-06-01T00:00:02.000Z", actor: "host", action: "remove-player" },
    { id: "op-custom", at: "2026-06-01T00:00:00.000Z", actor: "host", action: "start-stage" },
  ];
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  const keys = Object.keys(nodes.operations).sort();
  assert.strictEqual(keys.length, 3);
  assert.strictEqual(keys.includes("op-0000"), true);
  assert.strictEqual(keys.includes("op-custom"), true);
  const generatedKey = keys.find((key) => !["op-0000", "op-custom"].includes(key));
  assert.match(generatedKey, /^op-[a-z0-9]+-[a-z0-9]{4}$/);
  assert.strictEqual(nodes.operations[generatedKey].action, "open-voting");
  assert.strictEqual(nodes.operations["op-0000"].action, "remove-player");
  assert.strictEqual(nodes.operations["op-custom"].id, "op-custom");
});

run("firebase subscription errors are exposed in debug info and logs", () => {
  const cancelCallbacks = {};
  const logs = [];
  global.BroadcastChannel = undefined;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
    log: (kind, detail) => logs.push({ kind, detail }),
  });
  adapter.auth = { uid: "host-uid" };
  adapter.firebaseDb = {};
  adapter.debug.isHostAllowed = true;
  adapter.sdk = {
    ref: (db, path) => path,
    onValue: (ref, next, cancel) => {
      const relativePath = String(ref).replace("/rooms/unit-room/", "");
      cancelCallbacks[relativePath] = cancel;
      if (relativePath === "public") {
        next({ val: () => ({ gameId: "game", phase: Engine.PHASES.FINAL, roomVersion: 1, currentStageIndex: 0, currentStageId: "stage-001" }) });
      }
      return () => {};
    },
  };

  adapter.listenRest(() => {});
  cancelCallbacks.historyPlayers(new Error("Permission denied"));
  cancelCallbacks["results/stage-001"](new Error("Stage denied"));

  const debug = adapter.getDebugInfo();
  assert.strictEqual(debug.subscriptionErrors.historyPlayers, "Permission denied");
  assert.strictEqual(debug.subscriptionErrors["results/stage-001"], "Stage denied");
  assert.strictEqual(logs.some((entry) => entry.kind === "firebase.subscribe.error" && entry.detail.path === "historyPlayers"), true);
});

run("firebase adapter derives command time from the RTDB server offset", () => {
  global.BroadcastChannel = undefined;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.debug.serverTimeOffsetMs = 90_000;
  const before = Date.now() + 90_000;
  const actual = new Date(adapter.serverNowIso()).getTime();
  const after = Date.now() + 90_000;
  assert.strictEqual(actual >= before && actual <= after, true);
});

runAsync("firebase Host auth backfills a missing countdown room setting with 10 seconds", async () => {
  global.BroadcastChannel = undefined;
  const writes = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host-uid" };
  adapter.firebaseDb = {};
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async () => ({ exists: () => false, val: () => null }),
    set: async (ref, value) => writes.push([ref, value]),
  };

  const value = await adapter.ensureCountdownRoomSetting();

  assert.strictEqual(value, 10);
  assert.deepStrictEqual(writes, [[
    "/rooms/unit-room/roomSettings/countdownSeconds",
    10,
  ]]);
});

runAsync("firebase restored Host session backfills an existing room before subscriptions without creating an empty room setting", async () => {
  global.BroadcastChannel = undefined;
  global.localStorage = global.localStorage || {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  FirebaseAdapterModule.__evgFirebaseSdk = {
    initializeApp: () => ({}),
    getAuth: () => ({
      currentUser: {
        uid: "host-uid",
        getIdToken: async () => "id-token",
      },
    }),
    getDatabase: () => ({}),
    ref: (_db, path) => path,
    onValue: () => () => {},
  };

  const calls = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
    isHostSessionActive: () => {
      calls.push("session");
      return true;
    },
  });
  adapter.isHostAllowed = async () => {
    calls.push("allowlist");
    adapter.debug.isHostAllowed = true;
    return true;
  };
  adapter.backfillHistoryIndexes = async () => {
    calls.push("backfill");
    return { roomId: "unit-room" };
  };
  adapter.ensureCountdownRoomSetting = async () => {
    calls.push("countdown-setting");
    return 10;
  };

  await adapter.initRest();

  assert.deepStrictEqual(calls, [
    "allowlist",
    "session",
    "backfill",
    "countdown-setting",
  ]);

  const emptyRoomCalls = [];
  const emptyRoomAdapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
    isHostSessionActive: () => true,
  });
  emptyRoomAdapter.isHostAllowed = async () => {
    emptyRoomAdapter.debug.isHostAllowed = true;
    return true;
  };
  emptyRoomAdapter.backfillHistoryIndexes = async () => {
    emptyRoomCalls.push("backfill");
    return null;
  };
  emptyRoomAdapter.ensureCountdownRoomSetting = async () => {
    emptyRoomCalls.push("countdown-setting");
    return 10;
  };

  await emptyRoomAdapter.initRest();

  assert.deepStrictEqual(emptyRoomCalls, ["backfill"]);
  delete FirebaseAdapterModule.__evgFirebaseSdk;
});

runAsync("firebase read errors include the rejected path", async () => {
  global.BroadcastChannel = undefined;
  const logs = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
    log: (kind, detail) => logs.push({ kind, detail }),
  });
  adapter.firebaseDb = {};
  adapter.sdk = {
    ref: (db, path) => path,
    get: async (ref) => {
      if (String(ref).endsWith("/completedGameDetails")) throw new Error("Permission denied");
      if (String(ref) === "/players/alice") throw new Error("Root player denied");
      return { exists: () => true, val: () => ({ ok: true }) };
    },
  };

  await assert.rejects(
    () => adapter.readRestNodes(["public", "completedGameDetails"]),
    /Permission denied at completedGameDetails/
  );
  assert.match(adapter.getDebugInfo().lastRulesError, /completedGameDetails/);

  await assert.rejects(
    () => adapter.readRootPlayer("alice"),
    /Root player denied at \/players\/alice/
  );
  assert.match(adapter.getDebugInfo().lastRulesError, /\/players\/alice/);
  assert.strictEqual(
    logs.some((entry) => (
      entry.kind === "firebase.root-player.read.error"
      && entry.detail.path === "/players/alice"
    )),
    true
  );
});

run("firebase player updates write room player stats for self restore", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.players[0].skill = 42;
  room.players[0].stageSkillHistory = [8, 9, 10, 11, 12];

  const updates = EVGFirebaseAdapter.playerUpdates("/api/player/restore", room, "alice");

  assert.strictEqual(updates["players/alice"].name, "Alice");
  assert.strictEqual(updates["playerStats/alice"].currentSkill, 42);
  assert.deepStrictEqual(JSON.parse(updates["playerStats/alice"].stageSkillHistoryJson), [8, 9, 10, 11, 12]);
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
  assert.deepStrictEqual(JSON.parse(node.stageSkillHistoryJson), [3, 7, 8]);
  assert.strictEqual(node.roomId, "unit-room");
});

runAsync("firebase ticket and presence are written in one root multi-location update", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.phase = Engine.PHASES.VOTING;
  const calls = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "player",
    getUuid: () => "alice",
  });
  adapter.auth = { uid: "alice" };
  adapter.firebaseDb = {};
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.serverNowIso = () => "2026-07-29T00:00:00.000Z";
  adapter.sdk = {
    ref: (_db, pathValue) => pathValue,
    update: async (pathValue, updates) => calls.push({ pathValue, updates }),
    set: async () => {
      throw new Error("atomic Player update must not fall back to set");
    },
  };

  const response = await adapter.postRestPlayer("/api/ticket/submit", {
    uuid: "alice",
    ticket: { boardFloor: 1, exitFloor: 3, predictions: {} },
  });

  assert.strictEqual(response.ok, true, response.error);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathValue, "/");
  assert.ok(calls[0].updates["rooms/unit-room/tickets/stage-001/alice"]);
  assert.ok(calls[0].updates["rooms/unit-room/ticketPresence/stage-001/alice"]);
});

runAsync("firebase profile writes root and room nodes atomically without invalid new-player stats", async () => {
  const makeAdapter = (room, masterPlayer, uid, calls) => {
    const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
      config: { FIREBASE_ROOM_ID: "unit-room" },
      engine: Engine,
      getRole: () => "player",
      getUuid: () => uid,
    });
    adapter.auth = { uid };
    adapter.firebaseDb = {};
    adapter.readRestRoom = async () => Engine.deepClone(room);
    adapter.readRootPlayer = async () => masterPlayer && Engine.deepClone(masterPlayer);
    adapter.sdk = {
      ref: (_db, pathValue) => pathValue,
      update: async (pathValue, updates) => calls.push({ pathValue, updates }),
      set: async () => {
        throw new Error("atomic Player update must not fall back to set");
      },
    };
    return adapter;
  };

  let existingRoom = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  existingRoom = Engine.registerPlayer(existingRoom, "Alice", "alice").room;
  existingRoom.players[0].skill = 42;
  existingRoom.players[0].stageSkillHistory = [42];
  existingRoom.players[0].appliedSkillStageIds = ["game-stage"];
  const masterPlayer = {
    name: "Alice",
    currentSkill: 42,
    stageSkillHistoryJson: "[42]",
    appliedSkillStageIdsJson: "[\"game-stage\"]",
    joinedAt: existingRoom.players[0].joinedAt,
    lastSeenAt: existingRoom.players[0].lastSeenAt,
    updatedAt: existingRoom.players[0].lastSeenAt,
    roomId: "unit-room",
  };
  const existingCalls = [];
  const existingAdapter = makeAdapter(existingRoom, masterPlayer, "alice", existingCalls);
  const renamed = await existingAdapter.postRestPlayer("/api/player/rename", {
    uuid: "alice",
    name: "Alice Renamed",
  });

  assert.strictEqual(renamed.ok, true, renamed.error);
  assert.strictEqual(existingCalls.length, 1);
  assert.strictEqual(existingCalls[0].pathValue, "/");
  assert.strictEqual(existingCalls[0].updates["players/alice"].name, "Alice Renamed");
  assert.strictEqual(existingCalls[0].updates["rooms/unit-room/players/alice"].name, "Alice Renamed");
  assert.strictEqual(existingCalls[0].updates["rooms/unit-room/playerStats/alice"].currentSkill, 42);
  const aliceProfileId = EVGFirebaseAdapter.publicProfileId("alice");
  assert.strictEqual(existingCalls[0].updates["rooms/unit-room/players/alice"].profileId, aliceProfileId);
  assert.strictEqual(existingCalls[0].updates[`rooms/unit-room/publicPlayers/${aliceProfileId}`].profileId, aliceProfileId);
  assert.strictEqual(existingCalls[0].updates[`rooms/unit-room/publicProfileOwners/${aliceProfileId}`], "alice");

  const newCalls = [];
  const newAdapter = makeAdapter(Engine.createInitialRoom(Engine.DEFAULT_CONFIG), null, "new-player", newCalls);
  const joined = await newAdapter.postRestPlayer("/api/player/join", {
    uuid: "new-player",
    name: "New Player",
  });

  assert.strictEqual(joined.ok, true, joined.error);
  assert.strictEqual(newCalls.length, 1);
  assert.strictEqual(newCalls[0].updates["players/new-player"].currentSkill, 0);
  assert.strictEqual(newCalls[0].updates["rooms/unit-room/players/new-player"].name, "New Player");
  assert.strictEqual(newCalls[0].updates["rooms/unit-room/playerStats/new-player"], undefined);
  const newProfileId = EVGFirebaseAdapter.publicProfileId("new-player");
  assert.strictEqual(newCalls[0].updates["rooms/unit-room/players/new-player"].profileId, newProfileId);
  assert.strictEqual(newCalls[0].updates[`rooms/unit-room/publicProfileOwners/${newProfileId}`], "new-player");
});

run("firebase history detail keys preserve valid Unicode game ids", () => {
  assert.strictEqual(
    EVGFirebaseAdapter.firebaseExistingKey("清新本部杯・2026初夏-20260612"),
    "清新本部杯・2026初夏-20260612"
  );
  ["bad/key", "bad.key", "bad#key", "bad$key", "bad[key]"].forEach((gameId) => {
    assert.strictEqual(EVGFirebaseAdapter.firebaseExistingKey(gameId), "");
  });
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

run("firebase player history summary matches approved metric keys", () => {
  global.BroadcastChannel = undefined;
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.players[0].skill = 30;
  room.players[0].stageSkillHistory = [10, 20];
  room.completedGames = [{
    gameId: "previous",
    title: "Previous",
    scores: { alice: 18 },
    rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 18 }],
    stageResults: {
      "stage-001": {
        stageId: "stage-001",
        players: {
          alice: {
            uuid: "alice",
            name: "Alice",
            score: 18,
            stageSkill: 10,
            forcedOff: false,
            predictionBreakdown: [{ matched: true, noAnswer: false }],
          },
        },
      },
    },
  }];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_USE_LOCAL_MOCK: true, FIREBASE_ROOM_ID: "unit-history-summary" },
    engine: Engine,
    getRole: () => "player",
    getUuid: () => "alice",
  });

  const summary = adapter.playerHistory(room, "alice").summary;

  ["currentSkill", "averageSkill", "totalSkill", "bestScore", "gameCount", "stageCount", "forcedOffCount", "predictionAccuracy", "wins"].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, key), true, key);
  });
  ["totalScore", "averageScore", "podiums"].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(summary, key), false, key);
  });
  assert.strictEqual(summary.averageSkill, 15);
  assert.strictEqual(summary.totalSkill, 30);
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

  const restored = EVGFirebaseAdapter.roomFromFirebaseNodes(nodes, Engine, {
    role: "player",
    uid: "alice",
  });

  assert.strictEqual(restored.completedGames.length, 1);
  assert.strictEqual(restored.completedGames[0].title, "Previous Game");
  assert.strictEqual(restored.completedGames[0].scores.alice, 12);
  assert.strictEqual(restored.completedGames[0].rankings.length, 2);
  assert.strictEqual(Boolean(restored.completedGames[0].stageResults["stage-001"].players.alice), true);
});

runAsync("firebase room rewrite uses atomic update and avoids rules-closed volatile parent nodes", async () => {
  const previousRoom = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  previousRoom.completedGames = [{ gameId: "old-game", title: "Old", stageResults: {} }];
  previousRoom.completedGameSummaries = [{ gameId: "old-game", title: "Old" }];
  previousRoom.historyPlayers = [{ profileId: "p_alice", name: "Alice", currentSkill: 40, updatedAt: "2026-06-01T00:00:00.000Z" }];
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
  assert.strictEqual(paths.includes("players"), false);
  assert.strictEqual(paths.includes("playerStats"), false);
  assert.strictEqual(paths.includes("scores"), false);
  assert.strictEqual(paths.includes("tickets"), false);
  assert.strictEqual(paths.includes("ticketPresence"), false);
  assert.strictEqual(paths.includes("results"), false);
  [
    "completedGameSummaries",
    "completedGamePublicDetails",
    "completedGameDetails",
    "completedGamePlayerDetails",
    "historyPlayers",
  ].forEach((historyParent) => {
    assert.strictEqual(paths.includes(historyParent), false);
    assert.strictEqual(paths.some((path) => path.startsWith(`${historyParent}/`)), false);
  });
  assert.strictEqual(updateCalls[0][1]["tickets/stage-001"], null);
  assert.strictEqual(updateCalls[0][1]["ticketPresence/stage-001"], null);
  assert.strictEqual(updateCalls[0][1]["results/stage-001"], null);
  assert.strictEqual(Boolean(updateCalls[0][1].public), true);
});

runAsync("firebase empty existing lobby import preserves game and Skill history", async () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.roomId = "unit-room";
  room.roomVersion = 14;
  room.players = [];
  room.stageResults = {};
  room.completedGames = [{
    gameId: "history-game",
    title: "History Game",
    finishedAt: "2026-07-30T00:00:00.000Z",
    scores: { alice: 12 },
    rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 12, currentSkill: 48 }],
    stageResults: {},
  }];
  room.completedGameSummaries = [{
    gameId: "history-game",
    title: "History Game",
    finishedAt: "2026-07-30T00:00:00.000Z",
  }];
  room.historyPlayers = [{
    profileId: "p_alice",
    name: "Alice",
    currentSkill: 48,
    updatedAt: "2026-07-30T00:00:00.000Z",
  }];
  let committed = null;
  let commitOptions = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.commitRestRoomChildren = async (nextRoom, _currentRoom, options) => {
    committed = Engine.deepClone(nextRoom);
    commitOptions = options;
    return { ok: true };
  };
  adapter.exportArchiveGame = async () => {
    throw new Error("empty lobby must not invoke archive export");
  };

  const response = await adapter.postRestHost("/api/host/import-config", {
    hostToken: "firebase-host:host:test",
    config: Engine.DEFAULT_CONFIG,
    baseVersion: 14,
  });

  assert.strictEqual(response.ok, true, response.error);
  assert.notStrictEqual(committed.gameId, room.gameId);
  assert.strictEqual(committed.roomVersion, 15);
  assert.deepStrictEqual(committed.completedGames, room.completedGames);
  assert.deepStrictEqual(committed.completedGameSummaries, room.completedGameSummaries);
  assert.deepStrictEqual(committed.historyPlayers, room.historyPlayers);
  assert.deepStrictEqual(commitOptions.historyGameIds, []);
  assert.strictEqual(commitOptions.upsertHistoryPlayers, true);

  const candidate = adapter.applyMutation(
    "/api/host/start-game-config",
    { config: Engine.DEFAULT_CONFIG, baseVersion: 14 },
    Engine.deepClone(room)
  );
  assert.strictEqual(candidate.ok, true, candidate.error);
  assert.deepStrictEqual(candidate.room.completedGames, room.completedGames);
  assert.deepStrictEqual(candidate.room.completedGameSummaries, room.completedGameSummaries);
  assert.deepStrictEqual(candidate.room.historyPlayers, room.historyPlayers);

  const updatedConfig = await adapter.postRestHost("/api/host/update-config", {
    hostToken: "firebase-host:host:test",
    config: Engine.DEFAULT_CONFIG,
  });
  assert.strictEqual(updatedConfig.ok, true, updatedConfig.error);
  assert.deepStrictEqual(commitOptions.historyGameIds, []);
  assert.strictEqual(commitOptions.upsertHistoryPlayers, false);
});

runAsync("firebase next game writes only the newly archived game and profile children", async () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.roomId = "unit-room";
  room.gameId = "current-game";
  room.completedGames = [{ gameId: "old-game", title: "Old", stageResults: {} }];
  room.completedGameSummaries = [{ gameId: "old-game", title: "Old" }];
  room.historyPlayers = [{ profileId: "p_old", name: "Old", currentSkill: 33, updatedAt: "2026-07-29T00:00:00.000Z" }];
  room.players = [{
    uuid: "alice",
    name: "Alice",
    skill: 52,
    stageSkillHistory: [52],
    appliedSkillStageIds: ['["current-game","stage-001"]'],
    connected: true,
  }];
  room.scores = { alice: 20 };
  room.stageResults = {
    "stage-001": {
      stageId: "stage-001",
      calculatedAt: "2026-07-31T00:00:00.000Z",
      players: { alice: { uuid: "alice", name: "Alice", score: 20, stageSkill: 52 } },
      rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 20, currentSkill: 52 }],
    },
  };
  const nextRoom = Engine.createNextGameRoom(room, Engine.DEFAULT_CONFIG, "2026-07-31T01:00:00.000Z");
  const archived = nextRoom.completedGames.find((game) => game.gameId === room.gameId);
  assert.ok(archived);
  let updates = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.firebaseDb = {};
  adapter.sdk = {
    ref: (_db, path) => path,
    update: async (_path, nextUpdates) => {
      updates = nextUpdates;
    },
  };

  await adapter.writeRestRoomChildren(nextRoom, {
    previousRoom: room,
    clearVolatile: true,
    historyGameIds: [archived.gameId],
    upsertHistoryPlayers: true,
  });

  const paths = Object.keys(updates);
  assert.strictEqual(paths.includes("players"), false);
  assert.strictEqual(paths.includes("playerStats"), false);
  assert.strictEqual(paths.includes("scores"), false);
  [
    "completedGameSummaries",
    "completedGamePublicDetails",
    "completedGameDetails",
    "completedGamePlayerDetails",
    "historyPlayers",
  ].forEach((parent) => assert.strictEqual(paths.includes(parent), false));
  assert.ok(updates[`completedGameSummaries/${archived.gameId}`]);
  assert.ok(updates[`completedGamePublicDetails/${archived.gameId}`]);
  assert.ok(updates[`completedGameDetails/${archived.gameId}`]);
  assert.ok(updates[`completedGamePlayerDetails/alice/${archived.gameId}`]);
  assert.strictEqual(paths.some((path) => path.includes("old-game")), false);
  assert.strictEqual(
    paths.filter((path) => /^(completedGame|historyPlayers\/)/.test(path)).some((path) => updates[path] === null),
    false
  );
});

runAsync("firebase history guard stops RTDB and GAS side effects when an existing id disappears", async () => {
  const current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current.roomVersion = 5;
  current.completedGames = [{ gameId: "must-stay", title: "Stored", stageResults: {} }];
  current.completedGameSummaries = [{ gameId: "must-stay", title: "Stored" }];
  current.historyPlayers = [{ profileId: "p_must_stay", name: "Stored", currentSkill: 60, updatedAt: "2026-07-30T00:00:00.000Z" }];
  const next = Engine.createNextGameRoom(current, Engine.DEFAULT_CONFIG, "2026-07-31T00:00:00.000Z");
  next.completedGames = [];
  next.completedGameSummaries = [];
  next.historyPlayers = [];
  const failure = EVGFirebaseAdapter.historyPreservationFailure(current, next);
  assert.strictEqual(failure.code, "history_preservation_failed");
  assert.deepStrictEqual(failure.missingGameIds, ["must-stay"]);
  assert.deepStrictEqual(failure.missingProfileIds, ["p_must_stay"]);

  let writes = 0;
  let exports = 0;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(current);
  adapter.applyMutation = () => ({ ok: true, room: Engine.deepClone(next) });
  adapter.commitRestRoomChildren = async () => {
    writes += 1;
    return { ok: true };
  };
  adapter.exportArchiveGame = async () => {
    exports += 1;
    return { ok: true };
  };

  const response = await adapter.postRestHost("/api/host/import-config", {
    hostToken: "firebase-host:host:test",
    config: Engine.DEFAULT_CONFIG,
    baseVersion: 5,
  });
  assert.strictEqual(response.code, "history_preservation_failed");
  assert.strictEqual(writes, 0);
  assert.strictEqual(exports, 0);
});

run("firebase existing state without public is never treated as a new room", () => {
  assert.strictEqual(EVGFirebaseAdapter.persistedGameStateExists({ roles: { hosts: { host: true } } }), false);
  assert.strictEqual(EVGFirebaseAdapter.persistedGameStateExists({ roomSettings: { countdownSeconds: 10 } }), false);
  assert.strictEqual(EVGFirebaseAdapter.persistedGameStateExists({ meta: { roomId: "unit-room" } }), true);
  assert.strictEqual(EVGFirebaseAdapter.persistedGameStateExists({ completedGameSummaries: { old: { gameId: "old" } } }), true);
  assert.strictEqual(EVGFirebaseAdapter.persistedGameStateExists({ historyPlayers: { p_old: { profileId: "p_old" } } }), true);
});

runAsync("firebase import and Host claim reject a missing public node when history still exists", async () => {
  let writes = 0;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => {
    adapter.lastRestRoomReadState = { gameStateExists: true, publicExists: false };
    return null;
  };
  adapter.commitRestRoomChildren = async () => {
    writes += 1;
    return { ok: true };
  };
  const response = await adapter.postRestHost("/api/host/import-config", {
    hostToken: "firebase-host:host:test",
    config: Engine.DEFAULT_CONFIG,
  });
  assert.strictEqual(response.code, "room_state_incomplete");
  assert.strictEqual(writes, 0);

  adapter.readRestNodes = async () => ({
    completedGameSummaries: { old: { gameId: "old" } },
    historyPlayers: { p_old: { profileId: "p_old" } },
  });
  adapter.writeRestRoomChildren = async () => {
    writes += 1;
  };
  await assert.rejects(() => adapter.claimHost(), /ROOM_STATE_INCOMPLETE/);
  assert.strictEqual(writes, 0);
});

run("firebase stale next-game request is rejected before a new game is generated", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.roomVersion = 9;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  const response = adapter.applyMutation(
    "/api/host/import-config",
    { config: Engine.DEFAULT_CONFIG, baseVersion: 8 },
    room
  );
  assert.strictEqual(response.code, "version_conflict");
  assert.strictEqual(response.room, undefined);
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
  const historyPaths = EVGFirebaseAdapter.firebaseBaseSubscriptionPaths("history", "history-uid");
  const hostStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("host", "host-uid", "stage-001");
  const lockedHostStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("host", "host-uid", "stage-001", false);
  const screenStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("screen", "screen-uid", "stage-001");
  const playerStagePaths = EVGFirebaseAdapter.firebaseStageSubscriptionPaths("player", "player-uid", "stage-001");

  assert.strictEqual(hostPaths.includes(""), false);
  assert.strictEqual(playerPaths.includes(""), false);
  assert.strictEqual(hostPaths.includes("roles/hosts/host-uid"), true);
  assert.deepStrictEqual(lockedHostPaths, ["meta", "public", "roomSettings", "publicConfig", "roles/hosts/host-uid"]);
  assert.strictEqual(hostPaths.includes("tickets"), false);
  assert.strictEqual(hostPaths.includes("results"), false);
  assert.strictEqual(hostPaths.includes("completedGameDetails"), false);
  assert.strictEqual(hostPaths.includes("historyPlayers"), true);
  assert.strictEqual(hostPaths.includes("completedGames"), false);
  assert.strictEqual(screenPaths.includes("tickets"), false);
  assert.strictEqual(screenPaths.includes("results"), false);
  assert.strictEqual(screenPaths.includes("players"), false);
  assert.strictEqual(screenPaths.includes("scores"), false);
  assert.strictEqual(screenPaths.includes("publicConfig"), true);
  assert.strictEqual(screenPaths.includes("publicPlayers"), true);
  assert.strictEqual(screenPaths.includes("publicScores"), true);
  assert.strictEqual(playerPaths.includes("tickets"), false);
  assert.strictEqual(playerPaths.includes("players"), false);
  assert.strictEqual(playerPaths.includes("publicPlayers"), true);
  assert.strictEqual(playerPaths.includes("publicScores"), true);
  assert.strictEqual(playerPaths.includes("completedGameSummaries"), true);
  assert.strictEqual(playerPaths.includes("historyPlayers"), false);
  assert.strictEqual(playerPaths.includes("completedGameDetails"), false);
  assert.strictEqual(playerPaths.includes("completedGamePlayerDetails/player-uid"), true);
  assert.strictEqual(playerPaths.includes("scores/player-uid"), true);
  assert.deepStrictEqual(hostStagePaths, ["ticketPresence/stage-001", "tickets/stage-001", "results/stage-001"]);
  assert.deepStrictEqual(lockedHostStagePaths, []);
  assert.deepStrictEqual(screenStagePaths, ["publicTicketPresence/stage-001", "publicResults/stage-001"]);
  assert.deepStrictEqual(playerStagePaths, [
    "ticketPresence/stage-001/player-uid",
    "tickets/stage-001/player-uid",
    "results/stage-001/players/player-uid",
    "publicResults/stage-001",
  ]);
  assert.deepStrictEqual(historyPaths, [
    "meta",
    "public",
    "completedGameSummaries",
    "completedGamePublicDetails",
    "historyPlayers",
    "completedGamePlayerDetails/history-uid",
  ]);
});

run("firebase mutation reads exclude completed history unless finalization or next game needs it", () => {
  const regular = EVGFirebaseAdapter.restMutationBaseReadPaths("host", "host-uid", true, false);
  const nextGame = EVGFirebaseAdapter.restMutationBaseReadPaths("host", "host-uid", true, true);
  const player = EVGFirebaseAdapter.restMutationBaseReadPaths("player", "player-uid", true, false);

  assert.strictEqual(regular.includes("completedGameDetails"), false);
  assert.strictEqual(regular.includes("completedGameSummaries"), false);
  assert.strictEqual(regular.includes("historyPlayers"), true);
  assert.strictEqual(nextGame.includes("completedGameDetails"), true);
  assert.strictEqual(nextGame.includes("completedGameSummaries"), true);
  assert.strictEqual(player.includes("completedGamePlayerDetails/player-uid"), false);
});

run("firebase public history nodes expose skill summaries and stage rankings only", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.players[0].skill = 42;
  room.completedGames = [{
    gameId: "previous",
    title: "Previous",
    rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 20, skill: 42 }],
    stageResults: {
      "stage-001": {
        stageId: "stage-001",
        rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 20 }],
        players: { alice: { uuid: "alice", name: "Alice", score: 20, predictionBreakdown: [{ answer: "secret" }] } },
      },
    },
  }];

  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(room);
  const publicProfiles = Object.values(nodes.historyPlayers);
  assert.strictEqual(publicProfiles[0].currentSkill, 42);
  assert.match(publicProfiles[0].profileId, /^p_[a-z0-9]+$/);
  assert.strictEqual(nodes.completedGamePublicDetails.previous.stageResults["stage-001"].rankings[0].score, 20);
  assert.strictEqual(nodes.completedGamePublicDetails.previous.stageResults["stage-001"].players, undefined);
  assert.strictEqual(JSON.stringify(nodes.historyPlayers).includes('"uuid"'), false);
  assert.strictEqual(JSON.stringify(nodes.completedGameSummaries).includes('"uuid"'), false);
  assert.strictEqual(JSON.stringify(nodes.completedGamePublicDetails).includes('"uuid"'), false);
  const historyRoom = EVGFirebaseAdapter.roomFromFirebaseNodes({
    meta: nodes.meta,
    public: nodes.public,
    completedGameSummaries: nodes.completedGameSummaries,
    completedGamePublicDetails: nodes.completedGamePublicDetails,
    historyPlayers: nodes.historyPlayers,
  }, Engine, { role: "history", uid: "history-viewer" });
  assert.strictEqual(historyRoom.completedGames.length, 1);
  assert.strictEqual(historyRoom.completedGames[0].stageResults["stage-001"].rankings[0].score, 20);
  assert.strictEqual(JSON.stringify(historyRoom.completedGames).includes('"uuid"'), false);
});

run("firebase career backfill rebuilds all finite current-game StageSkills and repairs a partial final archive", () => {
  const config = Engine.deepClone(Engine.DEFAULT_CONFIG);
  config.stages = Array.from({ length: 5 }, (_, index) => {
    return Object.assign({}, Engine.deepClone(config.stages[index % config.stages.length]), {
      stageId: `stage-${String(index + 1).padStart(3, "0")}`,
      name: `Stage ${index + 1}`,
    });
  });
  let room = Engine.createInitialRoom(config);
  room.gameId = "production-like-game";
  for (let index = 0; index < 6; index += 1) {
    room = Engine.registerPlayer(room, `Player ${index + 1}`, `p${index + 1}`).room;
  }
  room.phase = Engine.PHASES.FINAL;
  config.stages.forEach((stage, stageIndex) => {
    const players = {};
    room.players.forEach((player, playerIndex) => {
      players[player.uuid] = {
        uuid: player.uuid,
        name: player.name,
        score: 10 + stageIndex + playerIndex,
        stageSkill: stageIndex === 4 && playerIndex === 5
          ? null
          : stageIndex === 0 && playerIndex === 0
            ? 0
            : 20 + stageIndex * 10 + playerIndex,
        ticket: { uuid: player.uuid, boardFloor: 1, exitFloor: 2, predictions: {} },
      };
    });
    room.stageResults[stage.stageId] = {
      stageId: stage.stageId,
      calculatedAt: `2026-07-29T00:0${stageIndex}:00.000Z`,
      players,
      rankings: [],
      timeline: [],
    };
  });
  room.completedGames = [{
    gameId: room.gameId,
    title: "partial",
    finishedAt: "2026-07-29T00:05:00.000Z",
    stageResults: {
      [config.stages[4].stageId]: {
        stageId: config.stages[4].stageId,
        calculatedAt: "2026-07-29T00:04:00.000Z",
        players: {},
      },
    },
  }];

  const recovered = EVGFirebaseAdapter.recoverCareerSkillState(room, {}, Engine);
  assert.strictEqual(recovered.players.reduce((sum, player) => sum + player.stageSkillHistory.length, 0), 29);
  assert.strictEqual(recovered.players[0].stageSkillHistory.length, 5);
  assert.strictEqual(recovered.players[0].stageSkillHistory.includes(0), true);
  assert.strictEqual(recovered.players[0].skill, Engine.calculateCurrentSkill(recovered.players[0].stageSkillHistory));
  assert.deepStrictEqual(
    recovered.players.map((player) => player.stageSkillHistory.length).sort((a, b) => a - b),
    [4, 5, 5, 5, 5, 5]
  );
  assert.strictEqual(recovered.players.every((player) => player.skill !== 0), true);
  assert.deepStrictEqual(recovered.players[0].appliedSkillStageIds, config.stages.map((stage) => {
    return Engine.skillStageApplicationId(room.gameId, stage.stageId);
  }));
  assert.strictEqual(recovered.players.every((player) => {
    return player.appliedSkillStageIds.every((id) => {
      const parsed = JSON.parse(id);
      return Array.isArray(parsed) && parsed.length === 2;
    });
  }), true);
  assert.strictEqual(Object.keys(recovered.completedGames[0].stageResults).length, 5);

  const repeated = EVGFirebaseAdapter.recoverCareerSkillState(recovered, {}, Engine);
  assert.deepStrictEqual(
    repeated.players.map((player) => player.stageSkillHistory),
    recovered.players.map((player) => player.stageSkillHistory)
  );
  assert.deepStrictEqual(
    repeated.players.map((player) => player.appliedSkillStageIds),
    recovered.players.map((player) => player.appliedSkillStageIds)
  );
});

run("firebase career backfill matches the anonymized production RTDB shape", () => {
  const fixturePath = path.join(
    __dirname,
    "fixtures",
    "production-skill-backfill-anonymized.json"
  );
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const room = EVGFirebaseAdapter.roomFromFirebaseNodes(
    fixture.roomNodes,
    Engine
  );
  const recovered = EVGFirebaseAdapter.recoverCareerSkillState(
    room,
    fixture.rootPlayers,
    Engine
  );
  const histories = recovered.players.map((player) => player.stageSkillHistory);
  const currentGame = recovered.completedGames.find((game) => {
    return game.gameId === fixture.roomNodes.public.gameId;
  });

  assert.strictEqual(
    histories.reduce((sum, history) => sum + history.length, 0),
    fixture.expected.finiteStageSkillCount
  );
  assert.deepStrictEqual(
    histories.map((history) => history.length).sort((a, b) => a - b),
    fixture.expected.historyLengths
  );
  assert.deepStrictEqual(
    recovered.players
      .map((player) => Number(player.skill.toFixed(2)))
      .sort((a, b) => b - a),
    fixture.expected.currentSkillsDescending
  );
  assert.strictEqual(recovered.players.every((player) => player.skill > 0), true);
  assert.strictEqual(
    Object.keys(currentGame && currentGame.stageResults || {}).length,
    fixture.expected.currentGameStageCount
  );
  assert.strictEqual(
    recovered.players.every((player) => {
      return player.appliedSkillStageIds.every((applicationId) => {
        const pair = JSON.parse(applicationId);
        return pair[0] === fixture.roomNodes.public.gameId &&
          /^stage-[1-5]$/.test(pair[1]);
      });
    }),
    true
  );
});

run("firebase career backfill treats repeated stage ids in different games as separate results", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "game-new";
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  const result = (stageSkill, calculatedAt) => ({
    stageId: "stage-001",
    calculatedAt,
    players: {
      alice: {
        uuid: "alice",
        name: "Alice",
        score: stageSkill,
        stageSkill,
        ticket: { uuid: "alice", boardFloor: 1, exitFloor: 2, predictions: {} },
      },
    },
    rankings: [],
    timeline: [],
  });
  room.completedGames = [{
    gameId: "game-old",
    title: "old",
    finishedAt: "2026-07-28T00:01:00.000Z",
    stageResults: { "stage-001": result(30, "2026-07-28T00:00:00.000Z") },
  }];
  room.stageResults = { "stage-001": result(40, "2026-07-29T00:00:00.000Z") };

  const recovered = EVGFirebaseAdapter.recoverCareerSkillState(room, {}, Engine);
  assert.deepStrictEqual(recovered.players[0].stageSkillHistory, [30, 40]);
  assert.deepStrictEqual(recovered.players[0].appliedSkillStageIds, [
    Engine.skillStageApplicationId("game-old", "stage-001"),
    Engine.skillStageApplicationId("game-new", "stage-001"),
  ]);
});

run("firebase career backfill preserves a nonempty canonical root Skill history", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "game-current";
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.stageResults = {
    "stage-001": {
      stageId: "stage-001",
      calculatedAt: "2026-07-29T00:00:00.000Z",
      players: {
        alice: { uuid: "alice", name: "Alice", stageSkill: 40 },
      },
    },
  };
  const recovered = EVGFirebaseAdapter.recoverCareerSkillState(room, {
    alice: {
      currentSkill: 777,
      stageSkillHistoryJson: "[88]",
      appliedSkillStageIdsJson: "[\"legacy-stage\"]",
    },
  }, Engine);
  assert.deepStrictEqual(recovered.players[0].stageSkillHistory, [88]);
  assert.deepStrictEqual(recovered.players[0].appliedSkillStageIds, ["legacy-stage"]);
  assert.strictEqual(recovered.players[0].skill, 777);
});

run("firebase career backfill rejects conflicting duplicate game-stage results", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "game-conflict";
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  const result = (stageSkill) => ({
    stageId: "stage-001",
    calculatedAt: "2026-07-29T00:00:00.000Z",
    players: { alice: { uuid: "alice", name: "Alice", stageSkill } },
  });
  room.completedGames = [{
    gameId: room.gameId,
    finishedAt: "2026-07-29T00:01:00.000Z",
    stageResults: { "stage-001": result(30) },
  }];
  room.stageResults = { "stage-001": result(40) };

  assert.throws(
    () => EVGFirebaseAdapter.recoverCareerSkillState(room, {}, Engine),
    /SKILL_HISTORY_CONFLICT/
  );
});

run("firebase career backfill rejects unscoped nonempty room history instead of guessing by value", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "game-ambiguous";
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.players[0].stageSkillHistory = [40];
  room.players[0].appliedSkillStageIds = ["stage-001"];
  room.stageResults = {
    "stage-001": {
      stageId: "stage-001",
      calculatedAt: "2026-07-29T00:00:00.000Z",
      players: { alice: { uuid: "alice", name: "Alice", stageSkill: 40 } },
    },
  };

  assert.throws(
    () => EVGFirebaseAdapter.recoverCareerSkillState(room, {}, Engine),
    /SKILL_HISTORY_AMBIGUOUS/
  );
});

runAsync("firebase Host backfill reads every current result and atomically writes recovered mirrors", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "backfill-game";
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room.phase = Engine.PHASES.FINAL;
  room.roomVersion = 9;
  const result = (stageId, stageSkill, calculatedAt) => ({
    stageId,
    calculatedAt,
    players: {
      alice: { uuid: "alice", name: "Alice", stageSkill, score: stageSkill },
    },
    rankings: [],
    timeline: [],
  });
  const allResults = {
    "stage-001": result("stage-001", 30, "2026-07-29T00:00:00.000Z"),
    "stage-002": result("stage-002", 40, "2026-07-29T00:01:00.000Z"),
  };
  room.stageResults = { "stage-002": allResults["stage-002"] };

  const reads = [];
  let rootUpdate = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.serverNowIso = () => "2026-07-29T00:02:00.000Z";
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      reads.push(path);
      const value = path === "/rooms/unit-room/results"
        ? allResults
        : path === "/players/alice"
          ? { currentSkill: 0 }
          : null;
      return {
        exists: () => value !== null,
        val: () => value,
      };
    },
    update: async (path, updates) => {
      assert.strictEqual(path, "/");
      rootUpdate = updates;
    },
  };
  adapter.firebaseDb = {};

  await adapter.backfillHistoryIndexes();
  assert.strictEqual(reads.includes("/rooms/unit-room/results"), true);
  assert.strictEqual(rootUpdate["rooms/unit-room/public"].roomVersion, 10);
  assert.strictEqual(
    JSON.parse(rootUpdate["rooms/unit-room/playerStats/alice"].stageSkillHistoryJson).length,
    2
  );
  assert.strictEqual(JSON.parse(rootUpdate["players/alice"].stageSkillHistoryJson).length, 2);
  assert.strictEqual(
    rootUpdate[`rooms/unit-room/historyPlayers/${EVGFirebaseAdapter.publicProfileId("alice")}`].currentSkill,
    70
  );
  assert.strictEqual(rootUpdate["rooms/unit-room/historyPlayers"], undefined);
  const aliceProfileId = EVGFirebaseAdapter.publicProfileId("alice");
  assert.strictEqual(rootUpdate["rooms/unit-room/players/alice/profileId"], aliceProfileId);
  assert.strictEqual(rootUpdate[`rooms/unit-room/publicPlayers/${aliceProfileId}`].profileId, aliceProfileId);
  assert.strictEqual(rootUpdate[`rooms/unit-room/publicProfileOwners/${aliceProfileId}`], "alice");
  assert.ok(rootUpdate["rooms/unit-room/publicConfig"]);
  assert.ok(rootUpdate["rooms/unit-room/publicResults/stage-001"]);
  assert.strictEqual(JSON.stringify(rootUpdate["rooms/unit-room/publicResults/stage-001"]).includes("alice"), false);
  assert.strictEqual(
    rootUpdate["rooms/unit-room/meta"].schemaVersion,
    "firebase-rtdb-v4-public-projection"
  );

  const migrated = Engine.deepClone(room);
  migrated.firebaseSchemaVersion = "firebase-rtdb-v4-public-projection";
  adapter.readRestRoom = async () => migrated;
  reads.length = 0;
  rootUpdate = null;
  await adapter.backfillHistoryIndexes();
  assert.deepStrictEqual(reads, []);
  assert.strictEqual(rootUpdate, null);
});

runAsync("firebase Host backfill mirrors a nonempty canonical root without overwriting it", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "canonical-game";
  room = Engine.registerPlayer(room, "Room Alice", "alice").room;
  room.roomVersion = 3;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  let rootUpdate = null;
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      const value = path.endsWith("/results")
        ? {}
        : path === "/players/alice"
          ? {
              name: "Canonical Alice",
              currentSkill: 88,
              stageSkillHistoryJson: "[88]",
              appliedSkillStageIdsJson: "[\"legacy-stage\"]",
              joinedAt: "2026-07-01T00:00:00.000Z",
              lastSeenAt: "2026-07-28T00:00:00.000Z",
              updatedAt: "2026-07-28T00:00:00.000Z",
              roomId: "another-room",
            }
          : null;
      return { exists: () => value !== null, val: () => value };
    },
    update: async (_path, updates) => {
      rootUpdate = updates;
    },
  };
  adapter.firebaseDb = {};

  await adapter.backfillHistoryIndexes();
  assert.strictEqual(rootUpdate["players/alice"], undefined);
  assert.deepStrictEqual(
    JSON.parse(rootUpdate["rooms/unit-room/playerStats/alice"].stageSkillHistoryJson),
    [88]
  );
  assert.strictEqual(rootUpdate["rooms/unit-room/playerStats/alice"].currentSkill, 88);
});

runAsync("firebase Host backfill rereads and recalculates after a version conflict", async () => {
  let baseRoom = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  baseRoom.gameId = "retry-game";
  baseRoom = Engine.registerPlayer(baseRoom, "Alice", "alice").room;
  baseRoom.roomVersion = 9;
  const result = (stageId, stageSkill) => ({
    stageId,
    calculatedAt: `2026-07-29T00:0${stageId.endsWith("2") ? 1 : 0}:00.000Z`,
    players: { alice: { uuid: "alice", name: "Alice", stageSkill } },
  });
  const firstResults = { "stage-001": result("stage-001", 30) };
  const secondResults = Object.assign({}, firstResults, {
    "stage-002": result("stage-002", 40),
  });
  let readCount = 0;
  let updateCount = 0;
  let committedUpdates = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.readRestRoom = async () => {
    readCount += 1;
    const room = Engine.deepClone(baseRoom);
    room.roomVersion = readCount === 1 ? 9 : 10;
    return room;
  };
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      const value = path.endsWith("/results")
        ? (readCount === 1 ? firstResults : secondResults)
        : path === "/players/alice"
          ? { currentSkill: 0 }
          : null;
      return { exists: () => value !== null, val: () => value };
    },
    update: async (_path, updates) => {
      updateCount += 1;
      if (updateCount === 1) throw new Error("PERMISSION_DENIED: version conflict");
      committedUpdates = updates;
    },
  };
  adapter.firebaseDb = {};

  await adapter.backfillHistoryIndexes();
  assert.strictEqual(readCount, 2);
  assert.strictEqual(updateCount, 2);
  assert.strictEqual(committedUpdates["rooms/unit-room/public"].roomVersion, 11);
  assert.deepStrictEqual(
    JSON.parse(committedUpdates["rooms/unit-room/playerStats/alice"].stageSkillHistoryJson),
    [30, 40]
  );
});

run("firebase committed tally preserves updated Skill in every authoritative node", () => {
  global.BroadcastChannel = undefined;
  let current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current = Engine.registerPlayer(current, "Alice", "alice").room;
  current = Engine.registerPlayer(current, "Bob", "bob").room;
  const stage = Engine.getCurrentStage(current);
  current.tickets[stage.stageId] = {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {} },
    bob: { uuid: "bob", boardFloor: 1, exitFloor: 4, predictions: {} },
  };
  current.phase = Engine.PHASES.COUNTDOWN;
  current.roomVersion = 4;
  current.historyPlayers = [{ profileId: "p_historical", name: "Historical", currentSkill: 88, updatedAt: "2026-07-28T00:00:00.000Z" }];
  const tallied = Engine.tallyCurrentStage(current, "2026-07-29T00:00:00.000Z");
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  const committed = adapter.commitHostResult(current, tallied.room, 4);
  assert.strictEqual(committed.ok, true);
  assert.strictEqual(committed.room.players[0].skill, tallied.room.players[0].skill);
  assert.deepStrictEqual(committed.room.players[0].stageSkillHistory, tallied.room.players[0].stageSkillHistory);
  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes(committed.room);
  assert.strictEqual(nodes.playerStats.alice.currentSkill, tallied.room.players[0].skill);
  assert.strictEqual(nodes.historyPlayers[EVGFirebaseAdapter.publicProfileId("alice")].currentSkill, tallied.room.players[0].skill);
  assert.strictEqual(EVGFirebaseAdapter.rootPlayerNode(committed.room.players[0], "unit-room").currentSkill, tallied.room.players[0].skill);
});

run("firebase host transition update is atomic across public results skill and player master", () => {
  let current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current = Engine.registerPlayer(current, "Alice", "alice").room;
  current = Engine.registerPlayer(current, "Bob", "bob").room;
  const stage = Engine.getCurrentStage(current);
  current.tickets[stage.stageId] = {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {} },
    bob: { uuid: "bob", boardFloor: 1, exitFloor: 4, predictions: {} },
  };
  current.phase = Engine.PHASES.COUNTDOWN;
  current.roomVersion = 4;
  current.historyPlayers = [{ profileId: "p_historical", name: "Historical", currentSkill: 88, updatedAt: "2026-07-28T00:00:00.000Z" }];
  const tallied = Engine.tallyCurrentStage(current);
  assert.strictEqual(tallied.ok, true);
  const next = tallied.room;
  next.roomVersion = 5;

  const updates = EVGFirebaseAdapter.hostAtomicUpdates("/api/host/commit-result", current, next, "unit-room", Engine);
  assert.strictEqual(updates["rooms/unit-room/public"].roomVersion, 5);
  assert.ok(updates["rooms/unit-room/results/stage-001"]);
  assert.ok(updates["rooms/unit-room/publicResults/stage-001"]);
  assert.strictEqual(
    JSON.stringify(updates["rooms/unit-room/publicResults/stage-001"]).includes('"uuid"'),
    false
  );
  assert.ok(updates[`rooms/unit-room/publicScores/${EVGFirebaseAdapter.publicProfileId("alice")}`]);
  assert.strictEqual(updates["rooms/unit-room/scores"], undefined);
  assert.strictEqual(updates["rooms/unit-room/playerStats"], undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updates, "rooms/unit-room/scores/alice/total"), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updates, "rooms/unit-room/playerStats/alice/currentSkill"), true);
  assert.strictEqual(updates["rooms/unit-room/historyPlayers"], undefined);
  assert.strictEqual(updates["rooms/unit-room/historyPlayers/p_historical"].currentSkill, 88);
  assert.ok(updates[`rooms/unit-room/historyPlayers/${EVGFirebaseAdapter.publicProfileId("alice")}`]);
  assert.strictEqual(updates["players/alice"], undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updates, "players/alice/currentSkill"), true);
});

run("firebase result commit preserves a player join and rename that land after the Host read", () => {
  let current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current = Engine.registerPlayer(current, "Alice", "alice").room;
  current = Engine.registerPlayer(current, "Bob", "bob").room;
  const stage = Engine.getCurrentStage(current);
  current.tickets[stage.stageId] = {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {} },
    bob: { uuid: "bob", boardFloor: 1, exitFloor: 4, predictions: {} },
  };
  current.phase = Engine.PHASES.COUNTDOWN;
  current.roomVersion = 4;
  const next = Engine.tallyCurrentStage(current, "2026-07-29T00:00:00.000Z").room;
  next.roomVersion = 5;
  const updates = EVGFirebaseAdapter.hostAtomicUpdates(
    "/api/host/commit-result",
    current,
    next,
    "unit-room",
    Engine
  );

  let concurrentRoom = Engine.registerPlayer(current, "Charlie", "charlie").room;
  concurrentRoom = Engine.renamePlayer(concurrentRoom, "alice", "Alice Concurrent").room;
  const serverState = {
    rooms: { "unit-room": EVGFirebaseAdapter.roomToFirebaseNodes(concurrentRoom) },
    players: {
      alice: EVGFirebaseAdapter.rootPlayerNode(concurrentRoom.players.find((player) => player.uuid === "alice"), "unit-room"),
      bob: EVGFirebaseAdapter.rootPlayerNode(concurrentRoom.players.find((player) => player.uuid === "bob"), "unit-room"),
      charlie: EVGFirebaseAdapter.rootPlayerNode(concurrentRoom.players.find((player) => player.uuid === "charlie"), "unit-room"),
    },
  };
  serverState.players.alice.name = "Alice Root Concurrent";
  const committed = applyMultiLocationUpdates(serverState, updates);

  assert.strictEqual(updates["rooms/unit-room/players"], undefined);
  assert.strictEqual(updates["rooms/unit-room/playerStats"], undefined);
  assert.strictEqual(updates["rooms/unit-room/scores"], undefined);
  assert.strictEqual(updates["players/alice"], undefined);
  assert.strictEqual(committed.rooms["unit-room"].players.charlie.name, "Charlie");
  assert.strictEqual(committed.rooms["unit-room"].scores.charlie.total, 0);
  assert.strictEqual(committed.rooms["unit-room"].playerStats.charlie.currentSkill, 0);
  assert.strictEqual(committed.rooms["unit-room"].players.alice.pendingName, "Alice Concurrent");
  assert.strictEqual(committed.players.alice.name, "Alice Root Concurrent");
  assert.strictEqual(committed.rooms["unit-room"].playerStats.alice.currentSkill, next.players[0].skill);
});

run("firebase stage start changes only pending-name leaves and preserves concurrent roster writes", () => {
  let current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current = Engine.registerPlayer(current, "Alice", "alice").room;
  current = Engine.registerPlayer(current, "Bob", "bob").room;
  current.players.find((player) => player.uuid === "alice").pendingName = "Alice Staged";
  current.roomVersion = 9;
  const advanced = Engine.advancePhase(
    current,
    "start-stage",
    "host",
    "2026-07-29T00:00:00.000Z"
  );
  assert.strictEqual(advanced.ok, true, advanced.error);
  advanced.room.roomVersion = 10;
  const updates = EVGFirebaseAdapter.hostAtomicUpdates(
    "/api/host/start-stage",
    current,
    advanced.room,
    "unit-room",
    Engine
  );

  let concurrentRoom = Engine.registerPlayer(current, "Charlie", "charlie").room;
  concurrentRoom = Engine.renamePlayer(concurrentRoom, "bob", "Bob Concurrent").room;
  const serverState = {
    rooms: { "unit-room": EVGFirebaseAdapter.roomToFirebaseNodes(concurrentRoom) },
    players: {},
  };
  concurrentRoom.players.forEach((player) => {
    serverState.players[player.uuid] = EVGFirebaseAdapter.rootPlayerNode(player, "unit-room");
  });
  const committed = applyMultiLocationUpdates(serverState, updates);

  assert.strictEqual(updates["rooms/unit-room/players"], undefined);
  assert.strictEqual(updates["rooms/unit-room/playerStats"], undefined);
  assert.strictEqual(updates["players/alice"], undefined);
  assert.strictEqual(updates["rooms/unit-room/players/alice/name"], "Alice Staged");
  assert.strictEqual(updates["rooms/unit-room/players/alice/pendingName"], null);
  assert.strictEqual(updates["players/alice/name"], "Alice Staged");
  assert.strictEqual(committed.rooms["unit-room"].players.alice.name, "Alice Staged");
  assert.strictEqual(committed.rooms["unit-room"].players.alice.pendingName, undefined);
  assert.strictEqual(committed.rooms["unit-room"].players.bob.name, "Bob Concurrent");
  assert.strictEqual(committed.players.bob.name, "Bob Concurrent");
  assert.strictEqual(committed.rooms["unit-room"].players.charlie.name, "Charlie");
});

run("firebase final transition atomically persists completed history and queued archive", () => {
  let current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current.config.stages = [current.config.stages[0]];
  current = Engine.registerPlayer(current, "Alice", "alice").room;
  current = Engine.registerPlayer(current, "Bob", "bob").room;
  const stage = Engine.getCurrentStage(current);
  current.tickets[stage.stageId] = {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {} },
    bob: { uuid: "bob", boardFloor: 1, exitFloor: 4, predictions: {} },
  };
  current.phase = Engine.PHASES.COUNTDOWN;
  current.roomVersion = 7;
  const tallied = Engine.tallyCurrentStage(current, "2026-07-29T00:00:00.000Z").room;
  const ranked = Engine.advancePhase(tallied, "show-ranking", "host", "2026-07-29T00:00:01.000Z").room;
  const finalRoom = Engine.advancePhase(ranked, "next-stage", "host", "2026-07-29T00:00:02.000Z").room;
  finalRoom.roomVersion = 8;
  const archived = Engine.archiveCurrentGame(finalRoom, "2026-07-29T00:00:02.000Z");
  assert.deepStrictEqual(
    archived.playerSnapshots.map((player) => player.uuid).sort(),
    ["alice", "bob"]
  );
  assert.strictEqual(
    archived.playerSnapshots.every((player) => {
      return Array.isArray(player.stageSkillHistory) && Number.isFinite(player.skill);
    }),
    true
  );
  finalRoom.completedGames.push(archived);
  finalRoom.archive = {
    requestedAt: "2026-07-29T00:00:02.000Z",
    status: "queued",
    archiveId: "archive-unit",
    gameId: archived.gameId,
    error: "",
  };
  const updates = EVGFirebaseAdapter.hostAtomicUpdates("/api/host/advance", ranked, finalRoom, "unit-room", Engine);
  assert.ok(updates[`rooms/unit-room/completedGameSummaries/${archived.gameId}`]);
  assert.ok(updates[`rooms/unit-room/completedGamePublicDetails/${archived.gameId}`]);
  assert.ok(updates[`rooms/unit-room/completedGameDetails/${archived.gameId}`]);
  assert.ok(updates[`rooms/unit-room/completedGamePlayerDetails/alice/${archived.gameId}`]);
  assert.strictEqual(updates["rooms/unit-room/completedGameSummaries"], undefined);
  assert.strictEqual(updates["rooms/unit-room/completedGamePublicDetails"], undefined);
  assert.strictEqual(updates["rooms/unit-room/completedGameDetails"], undefined);
  assert.strictEqual(updates["rooms/unit-room/completedGamePlayerDetails"], undefined);
  assert.strictEqual(updates["rooms/unit-room/archive"].status, "queued");
});

runAsync("firebase final transition materializes every production result before RTDB history and GAS export", async () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.roomId = "unit-room";
  room.gameId = "production-four-stage-final";
  room.config = productionFourStageConfig();
  room.currentStageIndex = 3;
  room.phase = Engine.PHASES.RANKING;
  room.roomVersion = 40;
  room.players = [{
    uuid: "alice",
    name: "Alice",
    skill: 86,
    stageSkillHistory: [20, 21, 22, 23],
    appliedSkillStageIds: room.config.stages.map((stage) => JSON.stringify([room.gameId, stage.stageId])),
    connected: true,
  }];
  room.scores = { alice: 86 };
  const allResults = room.config.stages.reduce((acc, stage, index) => {
    acc[stage.stageId] = productionStageResult(
      stage.stageId,
      `2026-07-31T0${index + 1}:00:00.000Z`,
      [{ uuid: "alice", name: "Alice", score: 20 + index, stageSkill: 20 + index }]
    );
    return acc;
  }, {});
  room.stageResults = allResults;

  const harness = productionLikeRestHarness(room, allResults);
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.firebaseDb = {};
  adapter.sdk = harness.sdk;
  adapter.debug.isHostAllowed = true;
  adapter.isHostAllowed = async () => true;
  adapter.serverNowIso = () => "2026-07-31T05:00:00.000Z";
  let exportedGame = null;
  adapter.exportArchiveGame = async (game) => {
    exportedGame = Engine.deepClone(game);
    return {
      ok: true,
      archive: { status: "exported", gameId: game.gameId, archiveId: `archive-${game.gameId}` },
    };
  };

  const response = await adapter.postRestHost("/api/host/advance", {
    hostToken: "firebase-host:host:test",
    hostName: "host",
  });

  assert.strictEqual(response.ok, true, response.error);
  assert.deepStrictEqual(Object.keys(exportedGame.stageResults).sort(), Object.keys(allResults).sort());
  assert.strictEqual(harness.reads.includes("/rooms/unit-room/results"), true);
  assert.strictEqual(
    harness.reads.some((pathValue) => pathValue === "/rooms/unit-room/results/stage-004"),
    false
  );
  const writes = harness.updates[0].updates;
  const completed = writes[`rooms/unit-room/completedGameDetails/${room.gameId}`];
  assert.deepStrictEqual(Object.keys(completed.stageResults).sort(), Object.keys(allResults).sort());
  assert.strictEqual(completed.stageResults["stage-001"].players.alice.score, 20);
  assert.strictEqual(completed.stageResults["stage-004"].players.alice.score, 23);
});

runAsync("firebase import and saved-config start archive all results and keep every same-day participant", async () => {
  for (const pathValue of ["/api/host/import-config", "/api/host/start-game-config"]) {
    const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
    room.roomId = "unit-room";
    room.gameId = `production-interrupted-${pathValue.split("/").pop()}`;
    room.config = productionFourStageConfig();
    room.currentStageIndex = 3;
    room.phase = Engine.PHASES.STAGE_INTRO;
    room.roomVersion = 50;
    room.players = [
      {
        uuid: "alice",
        name: "Alice",
        skill: 72,
        stageSkillHistory: [32, 40],
        appliedSkillStageIds: ['["old","stage-001"]', '["old","stage-002"]'],
        connected: true,
      },
      {
        uuid: "bob",
        name: "Bob",
        skill: 55,
        stageSkillHistory: [55],
        appliedSkillStageIds: ['["old","stage-004"]'],
        connected: true,
      },
      {
        uuid: "yesterday",
        name: "Yesterday",
        skill: 44,
        stageSkillHistory: [44],
        appliedSkillStageIds: ['["old","stage-003"]'],
        connected: true,
      },
    ];
    room.scores = { alice: 31, bob: 24, yesterday: 18 };
    const stageIds = room.config.stages.map((stage) => stage.stageId);
    const allResults = {
      [stageIds[0]]: productionStageResult(stageIds[0], "2026-07-31T01:00:00.000Z", [
        { uuid: "alice", name: "Alice", score: 31, stageSkill: 72 },
      ]),
      [stageIds[1]]: productionStageResult(stageIds[1], "2026-07-31T02:00:00.000Z", []),
      [stageIds[2]]: productionStageResult(stageIds[2], "2026-07-30T01:00:00.000Z", [
        { uuid: "yesterday", name: "Yesterday", score: 18, stageSkill: 44 },
      ]),
      [stageIds[3]]: productionStageResult(stageIds[3], "2026-07-31T03:00:00.000Z", [
        { uuid: "bob", name: "Bob", score: 24, stageSkill: 55 },
      ]),
    };
    room.stageResults = allResults;
    const extraNodes = pathValue === "/api/host/start-game-config"
      ? {
          nextGameConfigs: {
            "config-next": {
              configId: "config-next",
              status: "ACTIVE",
              config: Engine.DEFAULT_CONFIG,
            },
          },
        }
      : {};
    const harness = productionLikeRestHarness(room, allResults, { extraNodes });
    const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
      config: { FIREBASE_ROOM_ID: "unit-room" },
      engine: Engine,
      getRole: () => "host",
    });
    adapter.auth = { uid: "host" };
    adapter.firebaseDb = {};
    adapter.sdk = harness.sdk;
    adapter.debug.isHostAllowed = true;
    adapter.isHostAllowed = async () => true;
    adapter.serverNowIso = () => "2026-07-31T05:00:00.000Z";
    let exportedGame = null;
    adapter.exportArchiveGame = async (game) => {
      exportedGame = Engine.deepClone(game);
      return {
        ok: true,
        archive: { status: "exported", gameId: game.gameId, archiveId: `archive-${game.gameId}` },
      };
    };
    const payload = pathValue === "/api/host/start-game-config"
      ? { hostToken: "firebase-host:host:test", configId: "config-next", baseVersion: 50 }
      : { hostToken: "firebase-host:host:test", config: Engine.DEFAULT_CONFIG, baseVersion: 50 };

    const response = await adapter.postRestHost(pathValue, payload);

    assert.strictEqual(response.ok, true, `${pathValue}: ${response.error || "failed"}`);
    assert.strictEqual(harness.reads.includes("/rooms/unit-room/results"), true, pathValue);
    assert.deepStrictEqual(Object.keys(exportedGame.stageResults).sort(), stageIds.sort(), pathValue);
    assert.deepStrictEqual(response.room.players.map((player) => player.uuid).sort(), ["alice", "bob"], pathValue);
    assert.strictEqual(response.room.players.find((player) => player.uuid === "alice").skill, 72, pathValue);
    assert.deepStrictEqual(response.room.players.find((player) => player.uuid === "alice").stageSkillHistory, [32, 40], pathValue);
    assert.deepStrictEqual(response.room.scores, { alice: 0, bob: 0 }, pathValue);
    const writes = harness.updates[0].updates;
    const completed = writes[`rooms/unit-room/completedGameDetails/${room.gameId}`];
    assert.deepStrictEqual(Object.keys(completed.stageResults).sort(), Object.keys(allResults).sort(), pathValue);
  }
});

runAsync("firebase non-final advance reads only the current result child", async () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.roomId = "unit-room";
  room.gameId = "production-mid-game";
  room.config = productionFourStageConfig();
  room.currentStageIndex = 1;
  room.phase = Engine.PHASES.RANKING;
  room.roomVersion = 60;
  const allResults = room.config.stages.reduce((acc, stage, index) => {
    acc[stage.stageId] = productionStageResult(stage.stageId, `2026-07-31T0${index + 1}:00:00.000Z`, []);
    return acc;
  }, {});
  room.stageResults = allResults;
  const harness = productionLikeRestHarness(room, allResults);
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.firebaseDb = {};
  adapter.sdk = harness.sdk;
  adapter.debug.isHostAllowed = true;
  adapter.isHostAllowed = async () => true;
  adapter.exportArchiveGame = async () => {
    throw new Error("non-final advance must not export");
  };

  const response = await adapter.postRestHost("/api/host/advance", {
    hostToken: "firebase-host:host:test",
    hostName: "host",
  });

  assert.strictEqual(response.ok, true, response.error);
  assert.strictEqual(harness.reads.includes("/rooms/unit-room/results"), false);
  assert.strictEqual(harness.reads.includes("/rooms/unit-room/results/stage-002"), true);
  assert.strictEqual(response.room.phase, Engine.PHASES.STAGE_INTRO);
  assert.strictEqual(response.room.currentStageIndex, 2);
});

runAsync("firebase required results-parent read failure stops RTDB and GAS side effects", async () => {
  for (const pathValue of ["/api/host/advance", "/api/host/import-config", "/api/host/start-game-config"]) {
    const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
    room.roomId = "unit-room";
    room.gameId = `read-failure-${pathValue.split("/").pop()}`;
    room.config = productionFourStageConfig();
    room.currentStageIndex = 3;
    room.phase = pathValue === "/api/host/advance" ? Engine.PHASES.RANKING : Engine.PHASES.STAGE_INTRO;
    room.roomVersion = 70;
    const allResults = room.config.stages.reduce((acc, stage) => {
      acc[stage.stageId] = productionStageResult(stage.stageId, "2026-07-31T01:00:00.000Z", []);
      return acc;
    }, {});
    room.stageResults = allResults;
    const harness = productionLikeRestHarness(room, allResults, {
      failReadPaths: ["/rooms/unit-room/results"],
      extraNodes: pathValue === "/api/host/start-game-config"
        ? {
            nextGameConfigs: {
              "config-next": {
                configId: "config-next",
                status: "ACTIVE",
                config: Engine.DEFAULT_CONFIG,
              },
            },
          }
        : {},
    });
    const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
      config: { FIREBASE_ROOM_ID: "unit-room" },
      engine: Engine,
      getRole: () => "host",
    });
    adapter.auth = { uid: "host" };
    adapter.firebaseDb = {};
    adapter.sdk = harness.sdk;
    adapter.debug.isHostAllowed = true;
    adapter.isHostAllowed = async () => true;
    let exports = 0;
    adapter.exportArchiveGame = async () => {
      exports += 1;
      return { ok: true };
    };
    const payload = pathValue === "/api/host/import-config"
      ? { hostToken: "firebase-host:host:test", config: Engine.DEFAULT_CONFIG, baseVersion: 70 }
      : pathValue === "/api/host/start-game-config"
        ? { hostToken: "firebase-host:host:test", configId: "config-next", baseVersion: 70 }
        : { hostToken: "firebase-host:host:test", hostName: "host" };

    await assert.rejects(
      () => adapter.postRestHost(pathValue, payload),
      /Permission denied at results/
    );
    assert.strictEqual(harness.updates.length, 0, pathValue);
    assert.strictEqual(exports, 0, pathValue);
    assert.match(adapter.getDebugInfo().lastRulesError, /results/, pathValue);
  }
});

runAsync("firebase final archive callback then next game remains visible to a fresh History model", async () => {
  let persisted = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  persisted.roomId = "unit-room";
  persisted.gameId = "integration-final-game";
  persisted.config.stages = [persisted.config.stages[0]];
  persisted = Engine.registerPlayer(persisted, "Alice", "alice").room;
  persisted.players[0].skill = 64;
  persisted.players[0].stageSkillHistory = [64];
  persisted.players[0].appliedSkillStageIds = ['["integration-final-game","stage-001"]'];
  persisted.scores = { alice: 25 };
  persisted.stageResults = {
    "stage-001": {
      stageId: "stage-001",
      stageName: "Integrated stage",
      calculatedAt: "2026-07-31T01:00:00.000Z",
      players: {
        alice: {
          uuid: "alice",
          name: "Alice",
          score: 25,
          stageSkill: 64,
          ticket: { uuid: "alice", abstained: false },
        },
      },
      rankings: [{ uuid: "alice", name: "Alice", rank: 1, score: 25, currentSkill: 64 }],
    },
  };
  persisted.phase = Engine.PHASES.RANKING;
  persisted.roomVersion = 30;

  const updateCalls = [];
  const gasGameIds = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.firebaseDb = {};
  adapter.serverNowIso = () => "2026-07-31T02:00:00.000Z";
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(persisted);
  adapter.sdk = {
    ref: (_db, path) => path,
    update: async (path, updates) => updateCalls.push({ path, updates }),
  };
  const commitAtomic = adapter.commitHostAtomicUpdate.bind(adapter);
  adapter.commitHostAtomicUpdate = async (path, currentRoom, nextRoom) => {
    const result = await commitAtomic(path, currentRoom, nextRoom);
    if (result.ok) persisted = Engine.deepClone(nextRoom);
    return result;
  };
  const commitRoom = adapter.commitRestRoomChildren.bind(adapter);
  adapter.commitRestRoomChildren = async (nextRoom, currentRoom, options) => {
    const result = await commitRoom(nextRoom, currentRoom, options);
    if (result.ok) persisted = Engine.deepClone(nextRoom);
    return result;
  };
  adapter.exportArchiveGame = async (game) => {
    gasGameIds.push(game.gameId);
    persisted.archive = {
      status: "exported",
      gameId: game.gameId,
      archiveId: `archive-${game.gameId}`,
      completedAt: "2026-07-31T02:00:01.000Z",
    };
    return { ok: true, archive: Engine.deepClone(persisted.archive) };
  };

  const finalized = await adapter.postRestHost("/api/host/advance", {
    hostToken: "firebase-host:host:test",
    hostName: "host",
  });
  assert.strictEqual(finalized.ok, true, finalized.error);
  assert.deepStrictEqual(gasGameIds, ["integration-final-game"]);
  assert.strictEqual(persisted.phase, Engine.PHASES.FINAL);
  assert.strictEqual(persisted.completedGames.length, 1);
  const finalWrites = updateCalls[0].updates;
  assert.ok(finalWrites["rooms/unit-room/completedGameDetails/integration-final-game"]);
  assert.strictEqual(finalWrites["rooms/unit-room/completedGameDetails"], undefined);

  const next = await adapter.postRestHost("/api/host/import-config", {
    hostToken: "firebase-host:host:test",
    config: Engine.DEFAULT_CONFIG,
    baseVersion: persisted.roomVersion,
  });
  assert.strictEqual(next.ok, true, next.error);
  assert.deepStrictEqual(gasGameIds, ["integration-final-game"]);
  assert.strictEqual(persisted.players[0].skill, 64);
  assert.strictEqual(persisted.scores.alice, 0);
  const nextWrites = updateCalls[1].updates;
  [
    "rooms/unit-room/completedGameSummaries",
    "rooms/unit-room/completedGamePublicDetails",
    "rooms/unit-room/completedGameDetails",
    "rooms/unit-room/completedGamePlayerDetails",
    "rooms/unit-room/historyPlayers",
  ].forEach((parent) => assert.strictEqual(nextWrites[parent], undefined));

  const freshRoom = EVGFirebaseAdapter.roomFromFirebaseNodes(
    EVGFirebaseAdapter.roomToFirebaseNodes(persisted),
    Engine
  );
  const history = adapter.historyGames(freshRoom, { role: "host" });
  assert.strictEqual(history.ok, true);
  assert.strictEqual(history.summaries.some((game) => game.gameId === "integration-final-game"), true);
  assert.strictEqual(freshRoom.completedGames.some((game) => game.gameId === "integration-final-game"), true);
  assert.strictEqual(
    freshRoom.completedGames[0].stageResults["stage-001"].players.alice.stageSkill,
    64
  );
});

run("firebase manual archive can resend a current game already persisted as completed", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "completed-current";
  room.phase = Engine.PHASES.FINAL;
  room.stageResults = {
    "stage-001": {
      stageId: "stage-001",
      players: { alice: { uuid: "alice", name: "Alice", score: 20, stageSkill: 40 } },
    },
    "stage-002": {
      stageId: "stage-002",
      players: { alice: { uuid: "alice", name: "Alice", score: 30, stageSkill: 50 } },
    },
  };
  const persisted = {
    gameId: room.gameId,
    title: "Persisted game",
    finishedAt: "2026-07-29T00:00:00.000Z",
    stageResults: { "stage-001": Engine.deepClone(room.stageResults["stage-001"]) },
  };
  room.completedGames = [persisted];

  assert.strictEqual(Engine.archiveCurrentGame(room), null);
  const repaired = EVGFirebaseAdapter.archiveGameForCurrentRoom(room, Engine);
  assert.strictEqual(repaired.gameId, persisted.gameId);
  assert.strictEqual(Object.keys(repaired.stageResults).length, 2);
  const repairedRoom = Engine.deepClone(room);
  repairedRoom.completedGames = [repaired];
  repairedRoom.roomVersion = 1;
  repairedRoom.archive = {
    status: "queued",
    gameId: repaired.gameId,
    archiveId: "archive-repaired",
  };
  const repairUpdates = EVGFirebaseAdapter.hostAtomicUpdates(
    "/api/host/archive-current",
    room,
    repairedRoom,
    "unit-room",
    Engine
  );
  assert.strictEqual(
    Object.keys(repairUpdates[`rooms/unit-room/completedGameDetails/${repaired.gameId}`].stageResults).length,
    2
  );
  assert.strictEqual(repairUpdates["rooms/unit-room/archive"].archiveId, "archive-repaired");

  const unfinished = Engine.deepClone(room);
  unfinished.gameId = "not-yet-persisted";
  unfinished.completedGames = [];
  assert.strictEqual(
    EVGFirebaseAdapter.archiveGameForCurrentRoom(unfinished, Engine).gameId,
    unfinished.gameId
  );
});

run("firebase completed games defer archive export without blocking the next game", () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  const pending = {
    status: "failed",
    gameId: "older-game",
    archiveId: "archive-older",
    error: "retry",
  };
  const newGame = { gameId: "newly-finished" };
  const canExport = EVGFirebaseAdapter.queueArchiveForGame(
    room,
    pending,
    newGame,
    "unit-room"
  );
  assert.strictEqual(canExport, false);
  assert.strictEqual(room.archive.gameId, pending.gameId);
  assert.strictEqual(room.archive.archiveId, pending.archiveId);
  assert.deepStrictEqual(
    EVGFirebaseAdapter.pendingArchiveGameIds(room.archive),
    [newGame.gameId]
  );
  assert.notStrictEqual(room.archive, pending);
  EVGFirebaseAdapter.queueArchiveForGame(room, room.archive, newGame, "unit-room");
  assert.deepStrictEqual(
    EVGFirebaseAdapter.pendingArchiveGameIds(room.archive),
    [newGame.gameId]
  );

  const sameGameRoom = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  const sameGamePending = {
    status: "failed",
    gameId: newGame.gameId,
    archiveId: "archive-existing",
  };
  assert.strictEqual(
    EVGFirebaseAdapter.queueArchiveForGame(
      sameGameRoom,
      sameGamePending,
      newGame,
      "unit-room"
    ),
    true
  );
  assert.strictEqual(sameGameRoom.archive.status, "queued");
  assert.strictEqual(sameGameRoom.archive.archiveId, "archive-existing");
  assert.deepStrictEqual(
    EVGFirebaseAdapter.pendingArchiveGameIds(sameGameRoom.archive),
    []
  );
});

runAsync("firebase manual archive preserves archive id and repairs partial completed details", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "manual-game";
  room.phase = Engine.PHASES.FINAL;
  room.archive = {
    status: "failed",
    gameId: room.gameId,
    archiveId: "archive-manual",
    error: "previous failure",
  };
  room.completedGames = [{
    gameId: room.gameId,
    title: "partial",
    finishedAt: "2026-07-29T00:02:00.000Z",
    stageResults: {
      "stage-001": {
        stageId: "stage-001",
        players: { alice: { uuid: "alice", name: "Alice", score: 10, stageSkill: 20 } },
      },
    },
  }];
  const allResults = {
    "stage-001": room.completedGames[0].stageResults["stage-001"],
    "stage-002": {
      stageId: "stage-002",
      players: { alice: { uuid: "alice", name: "Alice", score: 15, stageSkill: 30 } },
    },
  };
  const sent = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      const value = path.endsWith("/results") ? allResults : null;
      return { exists: () => value !== null, val: () => value };
    },
  };
  adapter.firebaseDb = {};
  let persistedRoom = null;
  adapter.commitHostAtomicUpdate = async (_path, _currentRoom, nextRoom) => {
    persistedRoom = Engine.deepClone(nextRoom);
    return { ok: true };
  };
  adapter.exportArchiveGame = async (game, _sourceRoom, archiveId) => {
    sent.push({ game, archiveId });
    return { ok: true, archive: { status: "exported", gameId: game.gameId, archiveId } };
  };
  const payload = { hostToken: "firebase-host:host:test" };

  assert.strictEqual((await adapter.postRestHost("/api/host/archive-current", payload)).ok, true);
  assert.strictEqual((await adapter.postRestHost("/api/host/archive-current", payload)).ok, true);
  assert.deepStrictEqual(sent.map((item) => item.archiveId), ["archive-manual", "archive-manual"]);
  assert.strictEqual(Object.keys(sent[0].game.stageResults).length, 2);
  assert.strictEqual(
    Object.keys(persistedRoom.completedGames[0].stageResults).length,
    2
  );
  const nextGame = Engine.createNextGameRoom(
    persistedRoom,
    Engine.DEFAULT_CONFIG,
    "2026-07-29T00:03:00.000Z"
  );
  assert.strictEqual(
    Object.keys(nextGame.completedGames.find((game) => game.gameId === "manual-game").stageResults).length,
    2
  );
});

runAsync("firebase manual archive will not replace another game's unfinished archive", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "game-b";
  room.phase = Engine.PHASES.FINAL;
  room.archive = {
    status: "failed",
    gameId: "game-a",
    archiveId: "archive-a",
    error: "retry me",
  };
  const results = {
    "stage-001": {
      stageId: "stage-001",
      players: { alice: { uuid: "alice", name: "Alice", score: 10, stageSkill: 20 } },
    },
  };
  let exported = false;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async () => ({ exists: () => true, val: () => results }),
  };
  adapter.firebaseDb = {};
  adapter.exportArchiveGame = async () => {
    exported = true;
    return { ok: true };
  };

  const response = await adapter.postRestHost("/api/host/archive-current", {
    hostToken: "firebase-host:host:test",
  });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.code, "archive_pending");
  assert.strictEqual(exported, false);
  assert.deepStrictEqual(room.archive, {
    status: "failed",
    gameId: "game-a",
    archiveId: "archive-a",
    error: "retry me",
  });
});

runAsync("firebase archive retry rejects a game id different from the tracked archive", async () => {
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  const reads = [];
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      reads.push(path);
      const value = path.endsWith("/archive")
        ? { status: "failed", gameId: "game-a", archiveId: "archive-a" }
        : null;
      return { exists: () => value !== null, val: () => value };
    },
  };
  adapter.firebaseDb = {};

  const response = await adapter.postRestHost("/api/host/archive-retry", {
    hostToken: "firebase-host:host:test",
    gameId: "game-b",
  });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.code, "archive_mismatch");
  assert.deepStrictEqual(reads, ["/rooms/unit-room/archive"]);
});

runAsync("firebase archive retry can recover a queued job with the same archive id", async () => {
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  const tracked = {
    status: "queued",
    gameId: "game-a",
    archiveId: "archive-a",
  };
  const completed = {
    gameId: "game-a",
    title: "Queued game",
    stageResults: {
      "stage-001": {
        stageId: "stage-001",
        players: { alice: { uuid: "alice", name: "Alice", stageSkill: 20 } },
      },
    },
  };
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      const value = path.endsWith("/archive")
        ? tracked
        : path.endsWith("/completedGameDetails/game-a")
          ? completed
          : null;
      return { exists: () => value !== null, val: () => value };
    },
  };
  adapter.firebaseDb = {};
  let sent = null;
  adapter.exportArchiveGame = async (game, sourceRoom, archiveId, archiveState) => {
    sent = { game, sourceRoom, archiveId, archiveState };
    return { ok: true, archive: { status: "exported", gameId: game.gameId, archiveId } };
  };

  const response = await adapter.postRestHost("/api/host/archive-retry", {
    hostToken: "firebase-host:host:test",
    gameId: "game-a",
  });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(sent.game.gameId, "game-a");
  assert.strictEqual(sent.sourceRoom, null);
  assert.strictEqual(sent.archiveId, "archive-a");
  assert.strictEqual(sent.archiveState, tracked);
});

runAsync("firebase archive retry resumes the deferred queue after an intermediate failure", async () => {
  const tracked = {
    status: "failed",
    gameId: "game-a",
    archiveId: "archive-a",
    pendingGameIdsJson: JSON.stringify(["game-b", "game-c"]),
  };
  const completedGames = {
    "game-a": {
      gameId: "game-a",
      title: "Game A",
      rankings: [{ uuid: "alice", name: "Alice", rank: 1, currentSkill: 20 }],
      stageResults: {},
    },
    "game-b": {
      gameId: "game-b",
      title: "Game B",
      rankings: [{ uuid: "alice", name: "Alice", rank: 1, currentSkill: 30 }],
      stageResults: {},
    },
    "game-c": {
      gameId: "game-c",
      title: "Game C",
      rankings: [{ uuid: "alice", name: "Alice", rank: 1, currentSkill: 40 }],
      stageResults: {},
    },
  };
  const archiveWrites = [];
  const sentGameIds = [];
  const attempts = {};
  let archiveState = Engine.deepClone(tracked);
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async (path) => {
      const value = path.endsWith("/archive")
        ? archiveState
        : completedGames[path.split("/").pop()] || null;
      return { exists: () => value !== null, val: () => value };
    },
    set: async (path, value) => {
      if (path.endsWith("/archive")) {
        archiveState = Engine.deepClone(value);
        archiveWrites.push(Engine.deepClone(value));
      }
    },
  };
  adapter.firebaseDb = {};
  adapter.callArchiveApi = async (_path, payload) => {
    const gameId = payload.archive.gameId;
    attempts[gameId] = Number(attempts[gameId] || 0) + 1;
    sentGameIds.push(gameId);
    if (gameId === "game-b" && attempts[gameId] === 1) {
      return { ok: false, status: "failed", error: "temporary failure" };
    }
    return { ok: true, status: "exported" };
  };

  const firstResponse = await adapter.postRestHost("/api/host/archive-retry", {
    hostToken: "firebase-host:host:test",
    gameId: "game-a",
  });
  assert.strictEqual(firstResponse.ok, false);
  assert.deepStrictEqual(sentGameIds, ["game-a", "game-b"]);
  assert.strictEqual(archiveState.status, "failed");
  assert.strictEqual(archiveState.gameId, "game-b");
  assert.deepStrictEqual(
    EVGFirebaseAdapter.pendingArchiveGameIds(archiveState),
    ["game-c"]
  );

  const response = await adapter.postRestHost("/api/host/archive-retry", {
    hostToken: "firebase-host:host:test",
    gameId: "game-b",
  });

  assert.strictEqual(response.ok, true);
  assert.deepStrictEqual(sentGameIds, ["game-a", "game-b", "game-b", "game-c"]);
  assert.strictEqual(archiveWrites[0].archiveId, "archive-a");
  assert.strictEqual(
    archiveWrites.some((archive) => {
      return archive.status === "queued" &&
        archive.gameId === "game-b" &&
        EVGFirebaseAdapter.pendingArchiveGameIds(archive).join(",") === "game-c";
    }),
    true
  );
  const finalArchive = archiveWrites[archiveWrites.length - 1];
  assert.strictEqual(finalArchive.status, "exported");
  assert.strictEqual(finalArchive.gameId, "game-c");
  assert.deepStrictEqual(
    EVGFirebaseAdapter.pendingArchiveGameIds(finalArchive),
    []
  );
});

runAsync("firebase archive transaction preserves a concurrently appended game", async () => {
  const completed = {
    gameId: "game-b",
    rankings: [{ uuid: "alice", name: "Alice", currentSkill: 20 }],
    stageResults: {},
  };
  let archiveState = {
    status: "queued",
    gameId: "game-a",
    archiveId: "archive-a",
    pendingGameIdsJson: "[]",
  };
  const sent = [];
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.sdk = {
    ref: (_db, path) => path,
    runTransaction: async (_path, updater) => {
      const next = updater(Engine.deepClone(archiveState));
      if (next === undefined) {
        return {
          committed: false,
          snapshot: {
            exists: () => true,
            val: () => Engine.deepClone(archiveState),
          },
        };
      }
      archiveState = Engine.deepClone(next);
      return {
        committed: true,
        snapshot: {
          exists: () => true,
          val: () => Engine.deepClone(archiveState),
        },
      };
    },
    get: async (path) => {
      const value = path.endsWith("/completedGameDetails/game-b")
        ? completed
        : null;
      return { exists: () => value !== null, val: () => value };
    },
  };
  adapter.firebaseDb = {};
  adapter.callArchiveApi = async (_path, payload) => {
    sent.push(payload.archive.gameId);
    if (payload.archive.gameId === "game-a") {
      archiveState.pendingGameIdsJson = JSON.stringify(["game-b"]);
    }
    return { ok: true, status: "exported" };
  };

  const response = await adapter.exportArchiveGame(
    {
      gameId: "game-a",
      rankings: [{ uuid: "alice", name: "Alice", currentSkill: 10 }],
      stageResults: {},
    },
    null,
    "archive-a",
    archiveState
  );

  assert.strictEqual(response.ok, true);
  assert.deepStrictEqual(sent, ["game-a", "game-b"]);
  assert.strictEqual(archiveState.status, "exported");
  assert.strictEqual(archiveState.gameId, "game-b");
});

runAsync("firebase archive retry payload prefers the completion-time player snapshot", async () => {
  const game = {
    gameId: "snapshot-game",
    rankings: [{ uuid: "alice", name: "Alice", currentSkill: 90 }],
    stageResults: {
      "stage-001": {
        stageId: "stage-001",
        players: {
          alice: { uuid: "alice", name: "Alice", score: 10, stageSkill: 40 },
        },
      },
    },
    playerSnapshots: [{
      uuid: "alice",
      name: "Alice",
      skill: 90,
      stageSkillHistory: [40, 50],
    }],
  };
  const sourceRoom = {
    players: [{
      uuid: "alice",
      name: "Alice changed later",
      skill: 999,
      stageSkillHistory: [999],
    }],
    archive: {
      status: "failed",
      gameId: game.gameId,
      archiveId: "archive-snapshot",
      pendingGameIdsJson: "[]",
    },
  };
  let archiveState = Engine.deepClone(sourceRoom.archive);
  let sentPayload = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async () => ({
      exists: () => true,
      val: () => Engine.deepClone(archiveState),
    }),
    set: async (_path, value) => {
      archiveState = Engine.deepClone(value);
    },
  };
  adapter.firebaseDb = {};
  adapter.callArchiveApi = async (_path, payload) => {
    sentPayload = payload.archive;
    return { ok: true, status: "exported" };
  };

  const response = await adapter.exportArchiveGame(
    game,
    sourceRoom,
    "archive-snapshot",
    sourceRoom.archive
  );

  assert.strictEqual(response.ok, true);
  assert.strictEqual(sentPayload.players[0].name, "Alice");
  assert.strictEqual(sentPayload.players[0].currentSkill, 90);
  assert.deepStrictEqual(sentPayload.players[0].stageSkillHistory, [40, 50]);
  assert.strictEqual(sentPayload.playerSaveData[0].summary.averageSkill, 45);
  assert.strictEqual(sentPayload.playerSaveData[0].summary.totalSkill, 90);
});

runAsync("firebase final transition defers GAS while preserving an older failed archive", async () => {
  let current = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  current.gameId = "game-b";
  current.phase = Engine.PHASES.RANKING;
  current.roomVersion = 12;
  current.archive = {
    status: "failed",
    gameId: "game-a",
    archiveId: "archive-a",
    error: "retry first",
  };
  current.stageResults = {
    "stage-001": {
      stageId: "stage-001",
      players: { alice: { uuid: "alice", name: "Alice", score: 10, stageSkill: 20 } },
    },
  };
  const finalRoom = Engine.deepClone(current);
  finalRoom.phase = Engine.PHASES.FINAL;
  let committed = null;
  let exportCount = 0;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(current);
  adapter.applyMutation = () => ({ ok: true, room: Engine.deepClone(finalRoom) });
  adapter.commitHostAtomicUpdate = async (_path, _currentRoom, nextRoom) => {
    committed = Engine.deepClone(nextRoom);
    return { ok: true };
  };
  adapter.exportArchiveGame = async () => {
    exportCount += 1;
    return { ok: true };
  };

  const response = await adapter.postRestHost("/api/host/advance", {
    hostToken: "firebase-host:host:test",
  });
  assert.strictEqual(response.ok, true);
  assert.strictEqual(exportCount, 0);
  assert.strictEqual(committed.archive.gameId, "game-a");
  assert.strictEqual(committed.archive.archiveId, "archive-a");
  assert.deepStrictEqual(
    EVGFirebaseAdapter.pendingArchiveGameIds(committed.archive),
    ["game-b"]
  );
  assert.strictEqual(
    committed.completedGames.some((game) => {
      return game.gameId === "game-b" && Object.keys(game.stageResults || {}).length === 1;
    }),
    true
  );
});

runAsync("firebase manual archive rejects non-final rooms before RTDB or GAS writes", async () => {
  const room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.stageResults = {
    "stage-001": { stageId: "stage-001", players: {} },
  };
  let databaseRead = false;
  let committed = false;
  let exported = false;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async () => {
      databaseRead = true;
      return { exists: () => false, val: () => null };
    },
  };
  adapter.commitHostAtomicUpdate = async () => {
    committed = true;
    return { ok: true };
  };
  adapter.exportArchiveGame = async () => {
    exported = true;
    return { ok: true };
  };

  const response = await adapter.postRestHost("/api/host/archive-current", {
    hostToken: "firebase-host:host:test",
  });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.code, "not_ready");
  assert.strictEqual(databaseRead, false);
  assert.strictEqual(committed, false);
  assert.strictEqual(exported, false);
});

runAsync("firebase manual archive does not call GAS when the RTDB CAS loses", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room.gameId = "cas-game";
  room.phase = Engine.PHASES.FINAL;
  room.roomVersion = 20;
  const allResults = {
    "stage-001": {
      stageId: "stage-001",
      players: { alice: { uuid: "alice", name: "Alice", score: 10, stageSkill: 20 } },
    },
  };
  let exported = false;
  let attemptedRoom = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
  });
  adapter.auth = { uid: "host" };
  adapter.isHostAllowed = async () => true;
  adapter.readRestRoom = async () => Engine.deepClone(room);
  adapter.sdk = {
    ref: (_db, path) => path,
    get: async () => ({ exists: () => true, val: () => allResults }),
  };
  adapter.firebaseDb = {};
  adapter.commitHostAtomicUpdate = async (_path, _currentRoom, nextRoom) => {
    attemptedRoom = Engine.deepClone(nextRoom);
    return { ok: false, code: "version_conflict", error: "lost CAS" };
  };
  adapter.exportArchiveGame = async () => {
    exported = true;
    return { ok: true };
  };

  const response = await adapter.postRestHost("/api/host/archive-current", {
    hostToken: "firebase-host:host:test",
  });
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.code, "version_conflict");
  assert.strictEqual(attemptedRoom.roomVersion, 21);
  assert.strictEqual(attemptedRoom.archive.status, "queued");
  assert.strictEqual(exported, false);
});

runAsync("firebase host remove player writes only removed player child nodes", async () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room = Engine.registerPlayer(room, "Bob", "bob").room;
  const stage = Engine.getCurrentStage(room);
  room.tickets[stage.stageId] = {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 3, predictions: {}, submittedAt: "2026-06-01T00:00:00.000Z" },
    bob: { uuid: "bob", boardFloor: 1, exitFloor: 4, predictions: {}, submittedAt: "2026-06-01T00:00:00.000Z" },
  };
  room.ticketPresence = {
    [stage.stageId]: {
      alice: { status: "submitted", updatedAt: "2026-06-01T00:00:00.000Z" },
      bob: { status: "submitted", updatedAt: "2026-06-01T00:00:00.000Z" },
    },
  };
  const tallied = Engine.tallyCurrentStage(Object.assign({}, room, { phase: Engine.PHASES.COUNTDOWN }));
  assert.strictEqual(tallied.ok, true, tallied.error);
  const removed = Engine.removePlayerFromRoom(tallied.room, "bob", "host");
  assert.strictEqual(removed.ok, true, removed.error);

  let updates = null;
  const adapter = EVGFirebaseAdapter.createFirebaseAdapter({
    config: { FIREBASE_ROOM_ID: "unit-room" },
    engine: Engine,
    getRole: () => "host",
    getUuid: () => "host-uid",
  });
  adapter.writeRestChildUpdates = async (nextUpdates) => {
    updates = nextUpdates;
  };

  await adapter.writeHostSideEffects("/api/host/remove-player", tallied.room, removed.room);

  assert.strictEqual(updates.players, undefined);
  assert.strictEqual(updates.playerStats, undefined);
  assert.strictEqual(updates.scores, undefined);
  assert.strictEqual(updates["players/bob"], null);
  assert.strictEqual(updates["playerStats/bob"], null);
  assert.strictEqual(updates["scores/bob"], null);
  assert.strictEqual(updates[`tickets/${stage.stageId}/bob`], null);
  assert.strictEqual(updates[`ticketPresence/${stage.stageId}/bob`], null);
  assert.strictEqual(updates[`results/${stage.stageId}/players/bob`], null);
  assert.strictEqual(updates[`results/${stage.stageId}/rankings`].some((row) => row.uuid === "bob"), false);
  assert.strictEqual(JSON.stringify(updates[`results/${stage.stageId}/timeline`]).includes("bob"), false);
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
