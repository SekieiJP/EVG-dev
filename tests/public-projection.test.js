const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Engine = require("../game/assets/js/engine");
const Projection = require("../game/assets/js/public-projection");
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

function fixtureRoom() {
  const uids = {
    alice: "firebase-alice-raw-uid-0001",
    bob: "firebase-bob-raw-uid-0002",
    carol: "firebase-carol-raw-uid-0003",
    dave: "firebase-dave-raw-uid-0004",
  };
  const stage = {
    stageId: "stage-public-projection",
    name: "公開投影テスト",
    params: { N: 5, X: 1, P: 10, Q: 2 },
    events: [
      {
        type: "E1_prediction",
        question: "強制下車は何回発生する？",
        answerFormat: "range",
        metric: "forcedOffCount",
        correctAnswer: uids.bob,
        answer: uids.alice,
        scoreOnCorrect: 3,
        scoreOnWrong: -1,
        scoreOnNoAnswer: -2,
        ranges: [
          { value: "one", label: "1回", min: 1, max: 1, uuid: uids.bob, unknown: "private" },
          { value: "other", label: "その他", min: 0, max: 99 },
        ],
        unknownField: uids.carol,
      },
      { type: "E2_forbidden", fromFloor: 3, toFloor: 3, internalNote: uids.alice },
      { type: "E3a_zone_multiplier", fromFloor: 4, toFloor: 5, multiplier: 2 },
      { type: "E4_special_floor", floor: 4, bonus: 7 },
      { type: "E6_view_bonus", bonusPerExitFloor: 1 },
      { type: "E7_entry_fee", score: -2 },
      { type: "E8_completion_bonus", score: 5 },
      { type: "E99_private", uuid: uids.dave, secret: "not-public" },
    ],
  };
  const players = [
    { uuid: uids.alice, name: "Alice", connected: true },
    { uuid: uids.bob, name: "Bob", connected: true },
    { uuid: uids.carol, name: uids.carol, connected: false },
    { uuid: uids.dave, name: "Dave", connected: true },
  ];
  const tickets = {
    [uids.alice]: { uuid: uids.alice, boardFloor: 1, exitFloor: 4, predictions: ["one"], abstained: false },
    [uids.bob]: { uuid: uids.bob, boardFloor: 2, exitFloor: 5, predictions: ["one"], abstained: false },
    [uids.carol]: { uuid: uids.carol, boardFloor: 3, exitFloor: 3, predictions: ["one"], abstained: false },
    [uids.dave]: { uuid: uids.dave, boardFloor: 4, exitFloor: 5, predictions: ["one"], abstained: false },
  };
  const result = Engine.calculateStage(stage, players, tickets, "2026-08-01T00:00:00.000Z");
  result.gameId = "game-public-projection";
  Object.values(result.players).forEach((player, index) => {
    player.stageSkill = 40 + index;
    player.skillBefore = 100 + index;
    player.skillAfter = 140 + index;
    player.skillDelta = 40;
    player.secretUid = uids.bob;
  });
  result.privateBreakdown = { uuid: uids.alice, ticket: tickets[uids.alice] };
  const scores = Object.keys(result.players).reduce((totals, uid) => {
    totals[uid] = Engine.roundScore(10 + result.players[uid].score);
    return totals;
  }, {});
  const room = {
    roomId: "unit-room",
    gameId: result.gameId,
    config: {
      schemaVersion: "1.0.0",
      gameMeta: {
        title: "公開投影テスト",
        description: "Screen用",
        createdAt: "2026-08-01T00:00:00.000Z",
        configId: "projection-config",
        hostPassword: "must-not-leak",
        apiKey: "must-not-leak",
        uid: uids.alice,
      },
      settings: { hostPassword: "also-private", secret: uids.bob },
      stages: [stage],
      unknownRoot: { uuid: uids.carol },
    },
    players,
    tickets: { [stage.stageId]: tickets },
    ticketPresence: {
      [stage.stageId]: Object.keys(tickets).reduce((presence, uid) => {
        presence[uid] = { status: "submitted", updatedAt: "2026-08-01T00:00:00.000Z", uuid: uid };
        return presence;
      }, {}),
    },
    stageResults: { [stage.stageId]: result },
    scores,
  };
  return { room, result, stage, uids };
}

function visitKeys(value, callback) {
  if (Array.isArray(value)) {
    value.forEach((item) => visitKeys(item, callback));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.keys(value).forEach((key) => {
    callback(key);
    visitKeys(value[key], callback);
  });
}

run("publicProfileId stays byte-compatible with the existing Firebase adapter", () => {
  [
    "firebase-alice-raw-uid-0001",
    "short",
    "日本語を含む識別子",
    "",
  ].forEach((uid) => {
    assert.strictEqual(Projection.publicProfileId(uid), EVGFirebaseAdapter.publicProfileId(uid));
  });
});

run("classic script exposes EVGPublicProjection and CommonJS exports the same API", () => {
  const source = fs.readFileSync(path.join(__dirname, "../game/assets/js/public-projection.js"), "utf8");
  const context = { self: {} };
  vm.runInNewContext(source, context, { filename: "public-projection.js" });
  assert.strictEqual(typeof context.self.EVGPublicProjection.buildPublicProjection, "function");
  assert.strictEqual(
    context.self.EVGPublicProjection.publicProfileId("same-id"),
    Projection.publicProfileId("same-id")
  );
});

run("public projection is deterministic, pure, and keeps the private owner index separate", () => {
  const { room, uids } = fixtureRoom();
  const before = JSON.stringify(room);
  const first = Projection.buildPublicProjection(room);
  const second = Projection.buildPublicProjection(room);
  assert.strictEqual(JSON.stringify(room), before);
  assert.deepStrictEqual(first, second);
  Object.values(uids).forEach((uid) => {
    assert.strictEqual(first.publicProfileOwners[Projection.publicProfileId(uid)], uid);
  });
});

run("public config uses an allowlist and never exposes prediction answers or unknown fields", () => {
  const { room } = fixtureRoom();
  const config = Projection.buildPublicProjection(room).publicConfig;
  assert.strictEqual(config.gameMeta.title, "公開投影テスト");
  assert.strictEqual(config.gameMeta.hostPassword, undefined);
  assert.strictEqual(config.gameMeta.apiKey, undefined);
  assert.strictEqual(config.settings, undefined);
  assert.strictEqual(config.unknownRoot, undefined);
  const prediction = config.stages[0].events.find((event) => event.type === "E1_prediction");
  assert.strictEqual(prediction.question, "強制下車は何回発生する？");
  assert.strictEqual(prediction.answerFormat, "range");
  assert.strictEqual(prediction.metric, "forcedOffCount");
  assert.strictEqual(prediction.scoreOnCorrect, 3);
  assert.strictEqual(prediction.correctAnswer, undefined);
  assert.strictEqual(prediction.answer, undefined);
  assert.strictEqual(prediction.unknownField, undefined);
  assert.deepStrictEqual(prediction.ranges[0], { value: "one", label: "1回", min: 1, max: 1 });
  assert.strictEqual(config.stages[0].events.some((event) => event.type === "E99_private"), false);
  assert.deepStrictEqual(
    config.stages[0].events.find((event) => event.type === "E4_special_floor"),
    { type: "E4_special_floor", floor: 4, bonus: 7 }
  );
});

run("Screen projection retains aliases, timeline, blocked/forced state, checkpoints, scores, and rankings", () => {
  const { room, result, stage, uids } = fixtureRoom();
  const projection = Projection.buildPublicProjection(room);
  const publicResult = projection.publicResults[stage.stageId];
  const aliases = Object.keys(uids).reduce((values, key) => {
    values[key] = Projection.publicProfileId(uids[key]);
    return values;
  }, {});
  assert.deepStrictEqual(Object.keys(projection.publicPlayers).sort(), Object.values(aliases).sort());
  assert.strictEqual(projection.publicPlayers[aliases.carol].name, aliases.carol);
  assert.strictEqual(projection.publicPlayers[aliases.carol].connected, false);
  assert.strictEqual(projection.publicTicketPresence[stage.stageId][aliases.alice].status, "submitted");
  assert.strictEqual(projection.publicScores[aliases.alice].total, room.scores[uids.alice]);
  assert.strictEqual(publicResult.floorCount, stage.params.N);
  assert.strictEqual(publicResult.timeline.length, stage.params.N);
  assert.deepStrictEqual(publicResult.timeline[1].forcedOff.sort(), [aliases.alice, aliases.bob].sort());
  assert.deepStrictEqual(publicResult.timeline[2].blocked, [aliases.carol]);
  assert.strictEqual(publicResult.timeline[1].danger, true);
  assert.strictEqual(publicResult.scoreCheckpoints.length, stage.params.N + 1);
  const finalCheckpoint = publicResult.scoreCheckpoints[stage.params.N];
  Object.keys(uids).forEach((key) => {
    assert.strictEqual(finalCheckpoint.scores[aliases[key]].score, result.players[uids[key]].score);
  });
  assert.strictEqual(publicResult.rankings.every((row) => /^p_[a-z0-9]+$/.test(row.profileId)), true);
  assert.strictEqual(publicResult.rankings.every((row) => row.uuid === undefined && row.uid === undefined), true);
});

run("all public-readable nodes recursively exclude private keys and known raw uid strings", () => {
  const { room, uids } = fixtureRoom();
  const projection = Projection.buildPublicProjection(room);
  const publicReadable = {
    publicConfig: projection.publicConfig,
    publicPlayers: projection.publicPlayers,
    publicTicketPresence: projection.publicTicketPresence,
    publicResults: projection.publicResults,
    publicScores: projection.publicScores,
  };
  const forbiddenKeys = new Set([
    "uid",
    "uuid",
    "ticket",
    "tickets",
    "predictions",
    "breakdown",
    "predictionbreakdown",
    "eventbreakdown",
    "privatebreakdown",
    "stageskill",
    "skillbefore",
    "skillafter",
    "skilldelta",
    "correctanswer",
    "answer",
    "hostpassword",
    "apikey",
    "secretuid",
    "unknownfield",
  ]);
  visitKeys(publicReadable, (key) => {
    assert.strictEqual(forbiddenKeys.has(String(key).toLowerCase()), false, `forbidden public key: ${key}`);
  });
  const serialized = JSON.stringify(publicReadable);
  Object.values(uids).forEach((uid) => {
    assert.strictEqual(serialized.includes(uid), false, `raw uid leaked into a public value: ${uid}`);
  });
  assert.strictEqual(serialized.includes("must-not-leak"), false);
  assert.strictEqual(serialized.includes("also-private"), false);
});
