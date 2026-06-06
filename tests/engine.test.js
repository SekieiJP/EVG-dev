const assert = require("assert");
const Engine = require("../game/assets/js/engine");

function stage(overrides = {}) {
  return {
    stageId: "s",
    name: "test",
    params: { N: 10, X: 2, P: 10, Q: 3, ...(overrides.params || {}) },
    events: overrides.events || [],
  };
}

function players(names) {
  return names.map((name, index) => ({ uuid: `p${index + 1}`, name }));
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

run("same-floor success counts as one floor", () => {
  const result = Engine.calculateStage(stage(), players(["A"]), {
    p1: { uuid: "p1", boardFloor: 5, exitFloor: 5, predictions: {} },
  });
  assert.strictEqual(result.players.p1.status, "success");
  assert.strictEqual(result.players.p1.actualRise, 1);
  assert.strictEqual(result.players.p1.penalty, 3);
  assert.strictEqual(result.players.p1.score, 7);
});

run("full route counts inclusive floor units", () => {
  const result = Engine.calculateStage(stage(), players(["A"]), {
    p1: { uuid: "p1", boardFloor: 1, exitFloor: 10, predictions: {} },
  });
  assert.strictEqual(result.players.p1.status, "success");
  assert.strictEqual(result.players.p1.actualRise, 10);
  assert.strictEqual(result.players.p1.successPoint, 100);
  assert.strictEqual(result.players.p1.penalty, 30);
  assert.strictEqual(result.players.p1.score, 70);
});

run("capacity overflow keeps climbed distance for existing passengers", () => {
  const result = Engine.calculateStage(stage({ params: { X: 1 } }), players(["A", "B"]), {
    p1: { uuid: "p1", boardFloor: 1, exitFloor: 10, predictions: {} },
    p2: { uuid: "p2", boardFloor: 3, exitFloor: 8, predictions: {} },
  });
  assert.strictEqual(result.players.p1.status, "forced_off");
  assert.strictEqual(result.players.p2.status, "forced_off");
  assert.strictEqual(result.players.p1.actualRise, 2);
  assert.strictEqual(result.players.p2.actualRise, 0);
  assert.strictEqual(result.players.p1.score, -10);
  assert.strictEqual(result.players.p2.score, -18);
});

run("forbidden floor accepts ticket but charges penalty only", () => {
  const result = Engine.calculateStage(
    stage({ events: [{ type: "E2_forbidden", fromFloor: 4, toFloor: 5 }] }),
    players(["A"]),
    { p1: { uuid: "p1", boardFloor: 4, exitFloor: 8, predictions: {} } }
  );
  assert.strictEqual(result.players.p1.status, "invalid");
  assert.strictEqual(result.players.p1.score, -15);
});

run("prediction metric normalizes to default question text", () => {
  const config = Engine.normalizeConfig({
    stages: [
      stage({
        events: [
          {
            type: "E1_prediction",
            question: "カスタム文",
            answerFormat: "integer",
            metric: "forcedOffCount",
          },
          {
            type: "E1_prediction",
            question: "手動判定の問題文",
            answerFormat: "integer",
            correctAnswer: 3,
          },
        ],
      }),
    ],
  });
  assert.strictEqual(config.stages[0].events[0].question, "強制下車は何回発生する？");
  assert.strictEqual(config.stages[0].events[1].question, "手動判定の問題文");
});

run("remove player leaves save data conceptually intact but removes current room participation", () => {
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
  assert.strictEqual(removed.room.players.some((player) => player.uuid === "bob"), false);
  assert.strictEqual(removed.room.players.some((player) => player.uuid === "alice"), true);
  assert.strictEqual(removed.room.scores.alice > 0, true);
  assert.strictEqual(removed.room.scores.bob, undefined);
  assert.strictEqual(removed.room.tickets[stage.stageId].bob, undefined);
  assert.strictEqual(removed.room.ticketPresence[stage.stageId].bob, undefined);
  assert.strictEqual(removed.room.stageResults[stage.stageId].players.bob, undefined);
  assert.strictEqual(Boolean(removed.room.stageResults[stage.stageId].players.alice), true);
  assert.strictEqual(removed.room.stageResults[stage.stageId].rankings.some((row) => row.uuid === "bob"), false);
  assert.strictEqual(removed.room.stageResults[stage.stageId].timeline.some((step) => {
    return ["boarding", "exiting", "passengersBeforeCheck", "passengersAfterCheck", "forcedOff"]
      .some((key) => (step[key] || []).includes("bob"));
  }), false);
});

run("same game JSON creates distinct game ids on restart", () => {
  const config = Engine.normalizeConfig(Engine.DEFAULT_CONFIG);
  const first = Engine.createInitialRoom(config);
  const second = Engine.createNextGameRoom(first, config);
  assert.notStrictEqual(first.gameId, second.gameId);
});

run("zone multiplier applies only to successful P side", () => {
  const result = Engine.calculateStage(
    stage({ events: [{ type: "E3a_zone_multiplier", fromFloor: 3, toFloor: 5, multiplier: 2 }] }),
    players(["A"]),
    { p1: { uuid: "p1", boardFloor: 1, exitFloor: 5, predictions: {} } }
  );
  assert.strictEqual(result.players.p1.successPoint, 80);
  assert.strictEqual(result.players.p1.penalty, 15);
  assert.strictEqual(result.players.p1.score, 65);
});

run("special floor bonus applies after capacity check", () => {
  const result = Engine.calculateStage(
    stage({ events: [{ type: "E4_special_floor", floor: 3, bonus: 25 }] }),
    players(["A"]),
    { p1: { uuid: "p1", boardFloor: 1, exitFloor: 3, predictions: {} } }
  );
  assert.strictEqual(result.players.p1.status, "success");
  assert.strictEqual(result.players.p1.actualRise, 3);
  assert.strictEqual(result.players.p1.successPoint, 30);
  assert.strictEqual(result.players.p1.eventBonus, 25);
  assert.strictEqual(result.players.p1.score, 46);
});

run("entry fee charges every non-abstained ticket including invalid tickets", () => {
  const result = Engine.calculateStage(
    stage({
      events: [
        { type: "E2_forbidden", fromFloor: 4, toFloor: 5 },
        { type: "E7_entry_fee", score: -12 },
      ],
    }),
    players(["A", "B", "C"]),
    {
      p1: { uuid: "p1", boardFloor: 1, exitFloor: 3, predictions: {} },
      p2: { uuid: "p2", boardFloor: 4, exitFloor: 8, predictions: {} },
      p3: { uuid: "p3", abstained: true, predictions: {} },
    }
  );
  assert.strictEqual(result.players.p1.score, 9);
  assert.strictEqual(result.players.p2.status, "invalid");
  assert.strictEqual(result.players.p2.score, -27);
  assert.strictEqual(result.players.p3.score, 0);
});

run("completion bonus applies only to successful exits", () => {
  const result = Engine.calculateStage(
    stage({ params: { X: 1 }, events: [{ type: "E8_completion_bonus", score: 25 }] }),
    players(["A", "B"]),
    {
      p1: { uuid: "p1", boardFloor: 1, exitFloor: 2, predictions: {} },
      p2: { uuid: "p2", boardFloor: 1, exitFloor: 10, predictions: {} },
    }
  );
  assert.strictEqual(result.players.p1.status, "forced_off");
  assert.strictEqual(result.players.p1.eventBonus, 0);
  assert.strictEqual(result.players.p2.eventBonus, 0);

  const success = Engine.calculateStage(
    stage({ events: [{ type: "E8_completion_bonus", score: 25 }] }),
    players(["A"]),
    { p1: { uuid: "p1", boardFloor: 1, exitFloor: 2, predictions: {} } }
  );
  assert.strictEqual(success.players.p1.status, "success");
  assert.strictEqual(success.players.p1.eventBonus, 25);
  assert.strictEqual(success.players.p1.score, 39);
});

run("prediction no answer and correct answer scoring are applied", () => {
  const result = Engine.calculateStage(
    stage({
      events: [
        {
          type: "E1_prediction",
          question: "forced?",
          answerFormat: "integer",
          correctAnswer: 0,
          scoreOnCorrect: 20,
          scoreOnWrong: -5,
          scoreOnNoAnswer: -2,
        },
      ],
    }),
    players(["A", "B"]),
    {
      p1: { uuid: "p1", boardFloor: 1, exitFloor: 2, predictions: { 0: "0" } },
      p2: { uuid: "p2", boardFloor: 2, exitFloor: 3, predictions: {} },
    }
  );
  assert.strictEqual(result.players.p1.eventBonus, 20);
  assert.strictEqual(result.players.p2.eventBonus, -2);
});

run("prediction metric takes precedence over explicit correct answer", () => {
  const result = Engine.calculateStage(
    stage({
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
    }),
    players(["A", "B"]),
    {
      p1: { uuid: "p1", boardFloor: 1, exitFloor: 2, predictions: { 0: "0" } },
      p2: { uuid: "p2", boardFloor: 2, exitFloor: 3, predictions: { 0: "99" } },
    }
  );
  assert.strictEqual(result.stats.forcedOffCount, 0);
  assert.strictEqual(result.players.p1.predictionBreakdown[0].correctAnswer, 0);
  assert.strictEqual(result.players.p1.predictionBreakdown[0].matched, true);
  assert.strictEqual(result.players.p2.predictionBreakdown[0].matched, false);
});

run("range prediction matches metric value inside selected range", () => {
  const result = Engine.calculateStage(
    stage({
      events: [
        {
          type: "E1_prediction",
          question: "乗車成功者数は？",
          answerFormat: "range",
          metric: "totalBoarded",
          ranges: [
            { value: "low", label: "0〜1人", min: 0, max: 1 },
            { value: "high", label: "2〜3人", min: 2, max: 3 },
          ],
          scoreOnCorrect: 12,
          scoreOnWrong: -4,
          scoreOnNoAnswer: -1,
        },
      ],
    }),
    players(["A", "B"]),
    {
      p1: { uuid: "p1", boardFloor: 1, exitFloor: 2, predictions: { 0: "high" } },
      p2: { uuid: "p2", boardFloor: 2, exitFloor: 2, predictions: { 0: "low" } },
    }
  );
  assert.strictEqual(result.stats.totalBoarded, 2);
  assert.strictEqual(result.players.p1.predictionBreakdown[0].matched, true);
  assert.strictEqual(result.players.p1.eventBonus, 12);
  assert.strictEqual(result.players.p2.predictionBreakdown[0].matched, false);
  assert.strictEqual(result.players.p2.eventBonus, -4);
});

run("player prediction can target top pre-prediction scorer", () => {
  const result = Engine.calculateStage(
    stage({
      events: [
        {
          type: "E1_prediction",
          question: "最高得点者は？",
          answerFormat: "player",
          metric: "topPlayer",
          scoreOnCorrect: 15,
          scoreOnWrong: 0,
          scoreOnNoAnswer: 0,
        },
      ],
    }),
    players(["A", "B"]),
    {
      p1: { uuid: "p1", boardFloor: 1, exitFloor: 2, predictions: { 0: "p2" } },
      p2: { uuid: "p2", boardFloor: 1, exitFloor: 10, predictions: { 0: "p2" } },
    }
  );
  assert.strictEqual(result.players.p1.predictionBreakdown[0].correctAnswer, "p2");
  assert.strictEqual(result.players.p1.predictionBreakdown[0].matched, true);
  assert.strictEqual(result.players.p2.predictionBreakdown[0].matched, true);
});

run("current skill sums top five stage skills", () => {
  assert.strictEqual(Engine.calculateCurrentSkill([10, 20, 30, 40, 50]), 150);
  assert.strictEqual(Engine.calculateCurrentSkill([90, 10]), 100);
});

run("tally stores current skill delta per player result", () => {
  let room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  room = Engine.registerPlayer(room, "Alice", "alice").room;
  room = Engine.registerPlayer(room, "Bob", "bob").room;
  room.players[0].stageSkillHistory = [10, 20, 30, 40, 50];
  room.players[0].skill = Engine.calculateCurrentSkill(room.players[0].stageSkillHistory);
  const currentStage = Engine.getCurrentStage(room);
  room.tickets[currentStage.stageId] = {
    alice: { uuid: "alice", boardFloor: 1, exitFloor: 2, predictions: {} },
    bob: { uuid: "bob", boardFloor: 1, exitFloor: 3, predictions: {} },
  };
  const tallied = Engine.tallyCurrentStage(Object.assign({}, room, { phase: Engine.PHASES.COUNTDOWN }));
  const alice = tallied.room.stageResults[currentStage.stageId].players.alice;
  assert.strictEqual(typeof alice.skillBefore, "number");
  assert.strictEqual(typeof alice.skillAfter, "number");
  assert.strictEqual(alice.skillDelta, Number((alice.skillAfter - alice.skillBefore).toFixed(2)));
});
