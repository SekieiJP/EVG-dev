#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { EVGFirebaseAdapter } = require("../game/assets/js/firebase-adapter");

const SHEET_COLUMNS = Object.freeze({
  archive_log: ["archiveId", "gameId", "requestedAt", "completedAt", "status", "error"],
  save_data: ["uuid", "gameId", "nameSnapshot", "summaryJson", "createdAt", "archiveId"],
  players: ["uuid", "name", "skill", "stageSkillHistoryJson", "updatedAt", "archiveId", "gameId"],
  stage_results: ["uuid", "gameId", "stageId", "stageSkill", "score", "status", "resultJson", "createdAt", "archiveId"],
  stage_settings: ["gameId", "stageId", "stageJson", "createdAt", "archiveId"],
  game_history: ["gameId", "summaryJson", "createdAt", "archiveId"],
});

function fail(code, message, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  throw error;
}

function requireValue(condition, code, message, detail) {
  if (!condition) fail(code, message, detail);
}

function sheetRows(source, sheetName) {
  const columns = SHEET_COLUMNS[sheetName];
  const values = source && source.sheets && source.sheets[sheetName] && source.sheets[sheetName].values;
  requireValue(columns && Array.isArray(values), "source_missing", `${sheetName} の読取り値がありません。`);
  return values.map((row, index) => columns.reduce((record, column, columnIndex) => {
    record[column] = row[columnIndex] === undefined || row[columnIndex] === null ? "" : row[columnIndex];
    record.__row = index + 1;
    return record;
  }, {}));
}

function parseJson(value, code, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    fail(code, `${label} のJSONを解析できません。`, error.message);
  }
}

function numberOrFail(value, code, label) {
  const number = Number(value);
  requireValue(Number.isFinite(number), code, `${label} が有限数ではありません。`, value);
  return number;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonical(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function getPath(source, pathValue) {
  return String(pathValue || "").split("/").filter(Boolean).reduce((value, key) => {
    return value && typeof value === "object" ? value[key] : undefined;
  }, source);
}

function sameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return stableJson(a) === stableJson(b);
}

function rankStagePlayers(players) {
  const sorted = players.map((player) => ({
    uuid: player.uuid,
    name: player.name,
    score: Number(player.score || 0),
    totalScore: Number(player.score || 0),
    status: player.status || "",
  })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
  let previousScore = null;
  let previousRank = 0;
  return sorted.map((player, index) => {
    const rank = player.score === previousScore ? previousRank : index + 1;
    previousScore = player.score;
    previousRank = rank;
    return Object.assign({ rank }, player);
  });
}

function rootPlayerRecord(rootPlayers, uuid) {
  const player = rootPlayers && rootPlayers[uuid];
  requireValue(player && typeof player === "object", "root_player_missing", `root players/${uuid} がありません。`);
  const history = parseJson(player.stageSkillHistoryJson || "[]", "root_history_invalid", `root players/${uuid}/stageSkillHistoryJson`);
  const appliedIds = parseJson(player.appliedSkillStageIdsJson || "[]", "root_markers_invalid", `root players/${uuid}/appliedSkillStageIdsJson`);
  requireValue(Array.isArray(history) && history.every(Number.isFinite), "root_history_invalid", `root players/${uuid} のSkill履歴が不正です。`);
  requireValue(Array.isArray(appliedIds) && appliedIds.every((item) => typeof item === "string"), "root_markers_invalid", `root players/${uuid} の適用済みIDが不正です。`);
  return {
    uuid,
    name: String(player.name || ""),
    currentSkill: numberOrFail(player.currentSkill, "root_skill_invalid", `root players/${uuid}/currentSkill`),
    history,
    appliedIds,
    updatedAt: String(player.updatedAt || player.lastSeenAt || ""),
  };
}

function buildHistoryRecovery({ source, rootPlayers, currentRoom, generatedAt }) {
  requireValue(EVGFirebaseAdapter && EVGFirebaseAdapter.roomToFirebaseNodes, "adapter_missing", "Firebase serializerを読み込めません。 ");
  const archiveRows = sheetRows(source, "archive_log");
  const saveRows = sheetRows(source, "save_data");
  const playerRows = sheetRows(source, "players");
  const resultRows = sheetRows(source, "stage_results");
  const settingRows = sheetRows(source, "stage_settings");
  const historyRows = sheetRows(source, "game_history");

  requireValue(archiveRows.length === 1, "archive_row_count", "archive_log は対象1件である必要があります。", archiveRows.length);
  requireValue(historyRows.length === 1, "history_row_count", "game_history は対象1件である必要があります。", historyRows.length);
  const archive = archiveRows[0];
  const historyRow = historyRows[0];
  const summary = parseJson(historyRow.summaryJson, "game_summary_invalid", "game_history/summaryJson");
  const gameId = String(summary.gameId || historyRow.gameId || "");
  const archiveId = String(archive.archiveId || "");
  requireValue(gameId && EVGFirebaseAdapter.firebaseExistingKey(gameId) === gameId, "game_id_invalid", "gameIdをRTDB keyとして使用できません。", gameId);
  requireValue(archive.status === "exported" && !archive.error, "archive_not_exported", "archive_log が正常完了ではありません。", archive.status);

  const allGameIds = [archive.gameId, historyRow.gameId]
    .concat(saveRows.map((row) => row.gameId), playerRows.map((row) => row.gameId), resultRows.map((row) => row.gameId), settingRows.map((row) => row.gameId));
  const allArchiveIds = [archiveId, historyRow.archiveId]
    .concat(saveRows.map((row) => row.archiveId), playerRows.map((row) => row.archiveId), resultRows.map((row) => row.archiveId), settingRows.map((row) => row.archiveId));
  requireValue(allGameIds.every((value) => value === gameId), "game_id_mismatch", "GAS行のgameIdが一致しません。", [...new Set(allGameIds)]);
  requireValue(allArchiveIds.every((value) => value === archiveId), "archive_id_mismatch", "GAS行のarchiveIdが一致しません。", [...new Set(allArchiveIds)]);

  const stages = settingRows.map((row) => {
    const stage = parseJson(row.stageJson, "stage_setting_invalid", `stage_settings row ${row.__row}`);
    requireValue(stage.stageId === row.stageId, "stage_id_mismatch", "stage_settingsのstageIdが一致しません。", row.stageId);
    return stage;
  });
  const stageIds = stages.map((stage) => String(stage.stageId || ""));
  const summaryStageIds = (summary.stages || []).map((stage) => String(stage.stageId || ""));
  requireValue(stageIds.length > 0 && new Set(stageIds).size === stageIds.length, "stage_settings_duplicate", "stage_settingsに重複があります。", stageIds);
  requireValue(sameSet(stageIds, summaryStageIds), "summary_stage_mismatch", "game_historyとstage_settingsのステージが一致しません。", { stageIds, summaryStageIds });

  const playerIds = playerRows.map((row) => String(row.uuid || ""));
  requireValue(playerIds.length > 0 && new Set(playerIds).size === playerIds.length, "player_duplicate", "playersに重複または空UUIDがあります。", playerIds);
  const saveIds = saveRows.map((row) => String(row.uuid || ""));
  const rankingIds = (summary.rankings || []).map((row) => String(row.uuid || ""));
  requireValue(sameSet(playerIds, saveIds) && sameSet(playerIds, rankingIds), "player_set_mismatch", "players/save_data/game_historyの参加者集合が一致しません。 ");
  requireValue(Number(summary.playerCount) === playerIds.length, "player_count_mismatch", "game_historyのplayerCountが一致しません。", summary.playerCount);
  requireValue(Number(summary.stageCount) === stageIds.length, "stage_count_mismatch", "game_historyのstageCountが一致しません。", summary.stageCount);

  const rootByUid = {};
  const playerSheetByUid = Object.fromEntries(playerRows.map((row) => [row.uuid, row]));
  const saveByUid = Object.fromEntries(saveRows.map((row) => [row.uuid, row]));
  playerIds.forEach((uuid) => {
    const root = rootPlayerRecord(rootPlayers, uuid);
    const sheet = playerSheetByUid[uuid];
    const sheetHistory = parseJson(sheet.stageSkillHistoryJson || "[]", "sheet_history_invalid", `players/${uuid}/stageSkillHistoryJson`);
    const saveSummary = parseJson(saveByUid[uuid].summaryJson, "save_summary_invalid", `save_data/${uuid}/summaryJson`);
    requireValue(root.name === sheet.name, "player_name_mismatch", `rootとGAS playersの名前が一致しません: ${uuid}`);
    requireValue(Math.abs(root.currentSkill - Number(sheet.skill)) < 0.000001, "player_skill_mismatch", `rootとGAS playersのSkillが一致しません: ${uuid}`);
    requireValue(stableJson(root.history) === stableJson(sheetHistory), "player_history_mismatch", `rootとGAS playersのSkill履歴が一致しません: ${uuid}`);
    requireValue(Math.abs(root.currentSkill - Number(saveSummary.currentSkill)) < 0.000001, "save_skill_mismatch", `rootとsave_dataのSkillが一致しません: ${uuid}`);
    requireValue(Number(saveSummary.stageCount) === stageIds.length, "save_stage_count_mismatch", `save_dataのstageCountが一致しません: ${uuid}`);
    rootByUid[uuid] = root;
  });

  const resultsByStage = Object.fromEntries(stageIds.map((stageId) => [stageId, []]));
  const compositeKeys = new Set();
  resultRows.forEach((row) => {
    requireValue(resultsByStage[row.stageId], "result_stage_unknown", "stage_resultsに未知のstageIdがあります。", row.stageId);
    requireValue(playerIds.includes(row.uuid), "result_player_unknown", "stage_resultsに未知のuuidがあります。", row.uuid);
    const key = `${row.uuid}\u0000${row.stageId}`;
    requireValue(!compositeKeys.has(key), "result_duplicate", "stage_resultsに複合キー重複があります。", key);
    compositeKeys.add(key);
    const result = parseJson(row.resultJson, "result_json_invalid", `stage_results row ${row.__row}`);
    requireValue(result.uuid === row.uuid, "result_uuid_mismatch", "resultJsonのuuidが列値と一致しません。", key);
    requireValue(Number(result.score) === Number(row.score), "result_score_mismatch", "resultJsonのscoreが列値と一致しません。", key);
    requireValue(String(result.status || "") === String(row.status || ""), "result_status_mismatch", "resultJsonのstatusが列値と一致しません。", key);
    const columnStageSkill = row.stageSkill === "" ? null : numberOrFail(row.stageSkill, "stage_skill_invalid", `${key}/stageSkill`);
    const resultStageSkill = result.stageSkill === null || result.stageSkill === undefined ? null : numberOrFail(result.stageSkill, "stage_skill_invalid", `${key}/resultJson.stageSkill`);
    requireValue(columnStageSkill === resultStageSkill, "stage_skill_mismatch", "stageSkill列とresultJsonが一致しません。", key);
    resultsByStage[row.stageId].push(result);
  });
  requireValue(compositeKeys.size === stageIds.length * playerIds.length, "result_matrix_incomplete", "stage_resultsが参加者×ステージの完全行列ではありません。 ", compositeKeys.size);

  playerIds.forEach((uuid) => {
    const expectedSkills = stageIds.map((stageId) => {
      const result = resultsByStage[stageId].find((item) => item.uuid === uuid);
      return result && Number.isFinite(result.stageSkill) ? result.stageSkill : null;
    }).filter(Number.isFinite);
    const expectedMarkers = stageIds.map((stageId) => {
      const result = resultsByStage[stageId].find((item) => item.uuid === uuid);
      return result && Number.isFinite(result.stageSkill) ? JSON.stringify([gameId, stageId]) : null;
    }).filter(Boolean);
    requireValue(stableJson(expectedSkills) === stableJson(rootByUid[uuid].history), "root_skill_sequence_mismatch", `root Skill履歴とstage_resultsの順序が一致しません: ${uuid}`);
    requireValue(expectedMarkers.every((marker) => rootByUid[uuid].appliedIds.includes(marker)), "root_marker_missing", `root適用済みSkill markerが不足しています: ${uuid}`);
  });

  const finalRankings = (summary.rankings || []).map((ranking) => {
    const uuid = String(ranking.uuid || "");
    const root = rootByUid[uuid];
    requireValue(root, "ranking_player_unknown", "最終ランキングに未知のuuidがあります。", uuid);
    return {
      rank: numberOrFail(ranking.rank, "ranking_invalid", `${uuid}/rank`),
      uuid,
      name: String(ranking.name || root.name),
      score: numberOrFail(ranking.score, "ranking_invalid", `${uuid}/score`),
      skill: root.currentSkill,
    };
  });
  const scores = Object.fromEntries(finalRankings.map((ranking) => [ranking.uuid, ranking.score]));
  playerIds.forEach((uuid) => {
    const scoreSum = stageIds.reduce((total, stageId) => {
      const result = resultsByStage[stageId].find((item) => item.uuid === uuid);
      return total + Number(result && result.score || 0);
    }, 0);
    requireValue(Math.abs(scoreSum - scores[uuid]) < 0.000001, "final_score_mismatch", `最終得点とstage_results合計が一致しません: ${uuid}`, { scoreSum, final: scores[uuid] });
  });

  const stageResults = Object.fromEntries(stages.map((stage) => {
    const players = Object.fromEntries(resultsByStage[stage.stageId].map((result) => [result.uuid, result]));
    return [stage.stageId, {
      stageId: stage.stageId,
      stageName: stage.name || stage.stageId,
      params: stage.params || null,
      players,
      rankings: rankStagePlayers(Object.values(players)),
    }];
  }));
  const game = {
    gameId,
    title: String(summary.title || "game"),
    finishedAt: String(summary.finishedAt || ""),
    interrupted: Boolean(summary.interrupted),
    finalPhase: String(summary.finalPhase || ""),
    config: {
      gameMeta: { title: String(summary.title || "game") },
      stages,
    },
    scores,
    rankings: finalRankings,
    stageResults,
    playerSnapshots: playerIds.map((uuid) => ({
      uuid,
      name: rootByUid[uuid].name,
      skill: rootByUid[uuid].currentSkill,
      stageSkillHistory: rootByUid[uuid].history,
    })),
  };

  const nodes = EVGFirebaseAdapter.roomToFirebaseNodes({
    roomId: "elevator-game-live",
    gameId,
    phase: "final",
    config: game.config,
    currentStageIndex: Math.max(0, stages.length - 1),
    players: [],
    scores: {},
    tickets: {},
    ticketPresence: {},
    stageResults: {},
    completedGames: [game],
    historyPlayers: [],
    operations: [],
  });
  const updates = {
    [`completedGameSummaries/${gameId}`]: nodes.completedGameSummaries[gameId],
    [`completedGamePublicDetails/${gameId}`]: nodes.completedGamePublicDetails[gameId],
    [`completedGameDetails/${gameId}`]: nodes.completedGameDetails[gameId],
  };
  playerIds.forEach((uuid) => {
    updates[`completedGamePlayerDetails/${uuid}/${gameId}`] = nodes.completedGamePlayerDetails[uuid][gameId];
    const profileId = EVGFirebaseAdapter.publicProfileId(uuid);
    const root = rootByUid[uuid];
    updates[`historyPlayers/${profileId}`] = {
      profileId,
      name: root.name,
      currentSkill: root.currentSkill,
      updatedAt: root.updatedAt || game.finishedAt,
    };
  });

  requireValue(!JSON.stringify(updates[`completedGameSummaries/${gameId}`]).includes('"uuid"'), "public_uuid_leak", "公開summaryにuuidが含まれます。 ");
  requireValue(!JSON.stringify(updates[`completedGamePublicDetails/${gameId}`]).includes('"uuid"'), "public_uuid_leak", "公開detailにuuidが含まれます。 ");
  requireValue(Object.values(updates).every((value) => value !== null && value !== undefined), "null_update", "復旧updateにnullがあります。 ");

  const existing = [];
  Object.entries(updates).forEach(([pathValue, value]) => {
    const current = getPath(currentRoom || {}, pathValue);
    if (current === undefined || current === null) return;
    requireValue(stableJson(current) === stableJson(value), "target_conflict", `復旧先に異なる既存値があります: ${pathValue}`);
    existing.push(pathValue);
  });

  const generated = generatedAt || new Date().toISOString();
  const stageSkillCount = resultRows.filter((row) => row.stageSkill !== "").length;
  return {
    updates,
    report: {
      schemaVersion: "evg-history-recovery-v1",
      generatedAt: generated,
      roomPath: "/rooms/elevator-game-live",
      gameId,
      archiveId,
      sourceFinishedAt: game.finishedAt,
      playerCount: playerIds.length,
      stageCount: stageIds.length,
      stageResultCount: resultRows.length,
      stageSkillCount,
      updatePathCount: Object.keys(updates).length,
      existingIdenticalPathCount: existing.length,
      updateSha256: sha256(updates),
      sourceSha256: sha256(source),
      limitations: [
        "GASに保存されていないstageResults.timelineは復元しない",
        "GASに保存されていない元のstageResults.calculatedAtは復元しない",
        "GASに保存されていない元のstageResults.statsは復元しない",
        "ステージ順位は保存済みscoreと現行の同点順位規則から決定的に再生成する",
      ],
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) continue;
    options[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function readJson(filePath, label) {
  requireValue(filePath, "argument_missing", `${label} のパスが必要です。`);
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = readJson(args.source, "--source");
  const rootPlayers = readJson(args["root-players"], "--root-players");
  const currentRoom = readJson(args.room, "--room");
  const result = buildHistoryRecovery({ source, rootPlayers, currentRoom });
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(result.updates, null, 2)}\n`);
  if (args.report) fs.writeFileSync(path.resolve(args.report), `${JSON.stringify(result.report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error.code || "recovery_build_failed", error: error.message, detail: error.detail || null }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildHistoryRecovery,
  rankStagePlayers,
  stableJson,
};
