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
  assert.strictEqual(result.players.p1.score, 10);
});

run("capacity overflow forces current passengers and new boarders to zero climb", () => {
  const result = Engine.calculateStage(stage({ params: { X: 1 } }), players(["A", "B"]), {
    p1: { uuid: "p1", boardFloor: 1, exitFloor: 10, predictions: {} },
    p2: { uuid: "p2", boardFloor: 3, exitFloor: 8, predictions: {} },
  });
  assert.strictEqual(result.players.p1.status, "forced_off");
  assert.strictEqual(result.players.p2.status, "forced_off");
  assert.strictEqual(result.players.p1.actualRise, 0);
  assert.strictEqual(result.players.p1.score, -27);
});

run("forbidden floor accepts ticket but charges penalty only", () => {
  const result = Engine.calculateStage(
    stage({ events: [{ type: "E2_forbidden", fromFloor: 4, toFloor: 5 }] }),
    players(["A"]),
    { p1: { uuid: "p1", boardFloor: 4, exitFloor: 8, predictions: {} } }
  );
  assert.strictEqual(result.players.p1.status, "invalid");
  assert.strictEqual(result.players.p1.score, -12);
});

run("zone multiplier applies only to successful P side", () => {
  const result = Engine.calculateStage(
    stage({ events: [{ type: "E3a_zone_multiplier", fromFloor: 3, toFloor: 5, multiplier: 2 }] }),
    players(["A"]),
    { p1: { uuid: "p1", boardFloor: 1, exitFloor: 5, predictions: {} } }
  );
  assert.strictEqual(result.players.p1.successPoint, 60);
  assert.strictEqual(result.players.p1.penalty, 12);
  assert.strictEqual(result.players.p1.score, 48);
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

run("current skill skips best stage and sums second through fifth", () => {
  assert.strictEqual(Engine.calculateCurrentSkill([10, 20, 30, 40, 50]), 100);
  assert.strictEqual(Engine.calculateCurrentSkill([90, 10]), 10);
});
