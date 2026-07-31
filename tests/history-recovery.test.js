const assert = require("assert");
const { buildHistoryRecovery, rankStagePlayers } = require("../scripts/build-history-recovery");

function sheet(values) {
  return { values };
}

function fixture() {
  const gameId = "recovery-game";
  const archiveId = "archive-recovery-game";
  const finishedAt = "2026-06-12T12:00:00.000Z";
  const stages = [
    { stageId: "s1", name: "Stage 1", params: { N: 10, X: 2, P: 10, Q: 3 }, events: [] },
    { stageId: "s2", name: "Stage 2", params: { N: 20, X: 2, P: 10, Q: 3 }, events: [] },
  ];
  const results = [
    { uuid: "alice", name: "Alice", score: 10, status: "success", stageSkill: 5 },
    { uuid: "bob", name: "Bob", score: 0, status: "absent", stageSkill: null },
    { uuid: "alice", name: "Alice", score: 20, status: "success", stageSkill: 7 },
    { uuid: "bob", name: "Bob", score: 30, status: "success", stageSkill: 9 },
  ];
  const resultRows = results.map((result, index) => {
    const stageId = index < 2 ? "s1" : "s2";
    return [result.uuid, gameId, stageId, result.stageSkill === null ? "" : result.stageSkill, result.score, result.status, JSON.stringify(result), finishedAt, archiveId];
  });
  const summary = {
    gameId,
    title: "Recovered",
    finishedAt,
    interrupted: false,
    finalPhase: "final",
    rankings: [
      { rank: 1, uuid: "alice", name: "Alice", score: 30, skill: 12 },
      { rank: 1, uuid: "bob", name: "Bob", score: 30, skill: 9 },
    ],
    playerCount: 2,
    stageCount: 2,
    stages: stages.map((stage) => ({ stageId: stage.stageId, name: stage.name })),
  };
  const source = { sheets: {
    archive_log: sheet([[archiveId, gameId, finishedAt, finishedAt, "exported", ""]]),
    save_data: sheet([
      ["alice", gameId, "Alice", JSON.stringify({ currentSkill: 12, stageCount: 2 }), finishedAt, archiveId],
      ["bob", gameId, "Bob", JSON.stringify({ currentSkill: 9, stageCount: 2 }), finishedAt, archiveId],
    ]),
    players: sheet([
      ["alice", "Alice", 12, "[5,7]", finishedAt, archiveId, gameId],
      ["bob", "Bob", 9, "[9]", finishedAt, archiveId, gameId],
    ]),
    stage_results: sheet(resultRows),
    stage_settings: sheet(stages.map((stage) => [gameId, stage.stageId, JSON.stringify(stage), finishedAt, archiveId])),
    game_history: sheet([[gameId, JSON.stringify(summary), finishedAt, archiveId]]),
  } };
  const rootPlayers = {
    alice: { name: "Alice", currentSkill: 12, stageSkillHistoryJson: "[5,7]", appliedSkillStageIdsJson: JSON.stringify([JSON.stringify([gameId, "s1"]), JSON.stringify([gameId, "s2"])]), updatedAt: finishedAt },
    bob: { name: "Bob", currentSkill: 9, stageSkillHistoryJson: "[9]", appliedSkillStageIdsJson: JSON.stringify([JSON.stringify([gameId, "s2"])]), updatedAt: finishedAt },
  };
  return { source, rootPlayers, currentRoom: {}, gameId };
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

run("history recovery builds only five history families", () => {
  const input = fixture();
  const result = buildHistoryRecovery(input);
  const paths = Object.keys(result.updates);
  assert.strictEqual(paths.length, 7);
  assert.deepStrictEqual([...new Set(paths.map((pathValue) => pathValue.split("/")[0]))].sort(), [
    "completedGameDetails",
    "completedGamePlayerDetails",
    "completedGamePublicDetails",
    "completedGameSummaries",
    "historyPlayers",
  ]);
  assert.strictEqual(result.report.stageResultCount, 4);
  assert.strictEqual(result.report.stageSkillCount, 3);
  assert.strictEqual(JSON.stringify(result.updates[`completedGameSummaries/${input.gameId}`]).includes('"uuid"'), false);
  assert.strictEqual(JSON.stringify(result.updates[`completedGamePublicDetails/${input.gameId}`]).includes('"uuid"'), false);
  assert.deepStrictEqual(Object.keys(result.updates[`completedGamePlayerDetails/alice/${input.gameId}`].stageResults.s1.players), ["alice"]);
});

run("history recovery deterministically rebuilds tie rankings", () => {
  const rankings = rankStagePlayers([
    { uuid: "b", name: "Beta", score: 10, status: "success" },
    { uuid: "a", name: "Alpha", score: 10, status: "success" },
    { uuid: "c", name: "Gamma", score: 5, status: "forced_off" },
  ]);
  assert.deepStrictEqual(rankings.map((row) => [row.uuid, row.rank]), [["a", 1], ["b", 1], ["c", 3]]);
});

run("history recovery refuses conflicting existing targets", () => {
  const input = fixture();
  input.currentRoom.completedGameSummaries = { [input.gameId]: { gameId: input.gameId, title: "conflict" } };
  assert.throws(() => buildHistoryRecovery(input), (error) => error.code === "target_conflict");
});

run("history recovery refuses root Skill drift", () => {
  const input = fixture();
  input.rootPlayers.alice.currentSkill = 999;
  assert.throws(() => buildHistoryRecovery(input), (error) => error.code === "player_skill_mismatch");
});
