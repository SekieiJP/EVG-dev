(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ElevatorGameEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const PHASES = {
    LOBBY: "lobby",
    STAGE_INTRO: "stage_intro",
    VOTING: "voting",
    COUNTDOWN: "countdown",
    TALLYING: "tallying",
    REVEAL: "reveal",
    RANKING: "ranking",
    FINAL: "final",
  };

  const DEFAULT_CONFIG = {
    schemaVersion: "1.0.0",
    gameMeta: {
      title: "エレベーターゲーム",
      description: "短時間パーティ版",
      createdAt: "2026-05-23T00:00:00+09:00",
    },
    stages: [
      {
        stageId: "stage-001",
        name: "ステージ1",
        params: { N: 10, X: 3, P: 10, Q: 4 },
        events: [
          {
            type: "E1_prediction",
            question: "強制下車は何回発生する？",
            answerFormat: "integer",
            metric: "forcedOffCount",
            scoreOnCorrect: 30,
            scoreOnWrong: 0,
            scoreOnNoAnswer: -5,
          },
          { type: "E2_forbidden", fromFloor: 4, toFloor: 4 },
          { type: "E3a_zone_multiplier", fromFloor: 7, toFloor: 10, multiplier: 2 },
        ],
      },
      {
        stageId: "stage-002",
        name: "ステージ2",
        params: { N: 14, X: 4, P: 8, Q: 3 },
        events: [
          {
            type: "E1_prediction",
            question: "全員が乗車成功する？",
            answerFormat: "yesno",
            metric: "allSucceeded",
            scoreOnCorrect: 25,
            scoreOnWrong: 0,
            scoreOnNoAnswer: -5,
          },
          {
            type: "E1_prediction",
            question: "乗車成功者数は？",
            answerFormat: "range",
            metric: "totalBoarded",
            ranges: [
              { value: "low", label: "0〜2人", min: 0, max: 2 },
              { value: "mid", label: "3〜4人", min: 3, max: 4 },
              { value: "high", label: "5人以上", min: 5 },
            ],
            scoreOnCorrect: 20,
            scoreOnWrong: 0,
            scoreOnNoAnswer: -5,
          },
          { type: "E4_special_floor", floor: 8, bonus: 25 },
          { type: "E5_occupancy_multiplier", threshold: 3, multiplier: 1.5 },
        ],
      },
      {
        stageId: "stage-003",
        name: "ステージ3",
        params: { N: 20, X: 5, P: 7, Q: 2 },
        events: [
          {
            type: "E1_prediction",
            question: "このステージの最高得点者は？",
            answerFormat: "player",
            metric: "topPlayer",
            scoreOnCorrect: 30,
            scoreOnWrong: 0,
            scoreOnNoAnswer: -5,
          },
          { type: "E3b_score_multiplier", fromFloor: 12, toFloor: 20, multiplier: 1.8 },
          { type: "E6_view_bonus", bonusPerExitFloor: 2 },
        ],
      },
    ],
  };

  const DEFAULT_PREDICTION_QUESTIONS = {
    forcedOffCount: "強制下車は何回発生する？",
    totalBoarded: "乗車成功者数は？",
    allSucceeded: "全員が乗車成功する？",
    topPlayer: "このステージの最高得点者は？",
  };

  function createInitialRoom(config) {
    return {
      roomId: "single-room",
      gameId: uniqueGameId(config && config.gameMeta ? config.gameMeta.title : "game"),
      config: normalizeConfig(config || DEFAULT_CONFIG),
      phase: PHASES.LOBBY,
      currentStageIndex: 0,
      players: [],
      tickets: {},
      stageResults: {},
      scores: {},
      completedGames: [],
      operations: [],
      countdownEndsAt: null,
      tallyingEndsAt: null,
      animationStartedAt: null,
      animationSkippedAt: null,
      revealEndsAt: null,
      roomVersion: 0,
      volume: 0.8,
      muted: false,
      hostLock: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  function createNextGameRoom(room, config) {
    const next = createInitialRoom(config);
    const archived = archiveCurrentGame(room);
    next.completedGames = archived ? (room.completedGames || []).concat(archived) : deepClone(room.completedGames || []);
    next.volume = room.volume !== undefined ? room.volume : next.volume;
    next.muted = Boolean(room.muted);
    next.operations.unshift({ at: nowIso(), actor: "host", action: "next-game" });
    next.updatedAt = nowIso();
    return next;
  }

  function removePlayerFromRoom(room, uuid, actor) {
    if (!uuid) return { room, ok: false, error: "退室させる参加者を選択してください。" };
    if (!room.players || !room.players.some((player) => player.uuid === uuid)) {
      return { room, ok: false, error: "現在ゲームの参加者ではありません。" };
    }
    const next = deepClone(room);
    next.players = (next.players || []).filter((player) => player.uuid !== uuid);
    delete next.scores[uuid];
    Object.keys(next.tickets || {}).forEach((stageId) => {
      if (next.tickets[stageId]) delete next.tickets[stageId][uuid];
    });
    Object.keys(next.ticketPresence || {}).forEach((stageId) => {
      if (next.ticketPresence[stageId]) delete next.ticketPresence[stageId][uuid];
    });
    Object.keys(next.stageResults || {}).forEach((stageId) => {
      const result = next.stageResults[stageId];
      if (!result || !result.players || !result.players[uuid]) return;
      delete result.players[uuid];
      result.timeline = (result.timeline || []).map((step) => removeUuidFromTimelineStep(step, uuid));
      result.rankings = rerankRows((result.rankings || []).filter((row) => row.uuid !== uuid));
      refreshResultStats(result);
    });
    next.operations.unshift({ at: nowIso(), actor: actor || "host", action: "remove-player", uuid });
    next.operations = next.operations.slice(0, 100);
    next.updatedAt = nowIso();
    return { room: next, ok: true };
  }

  function archiveCurrentGame(room) {
    if (!room || !room.stageResults || Object.keys(room.stageResults).length === 0) return null;
    if ((room.completedGames || []).some((game) => game.gameId === room.gameId)) return null;
    return {
      gameId: room.gameId,
      title: room.config && room.config.gameMeta ? room.config.gameMeta.title : "game",
      finishedAt: nowIso(),
      interrupted: room.phase !== PHASES.FINAL,
      finalPhase: room.phase,
      scores: deepClone(room.scores || {}),
      rankings: cumulativeRankings(room),
      stageResults: deepClone(room.stageResults || {}),
    };
  }

  function normalizeConfig(config) {
    const clone = deepClone(config || DEFAULT_CONFIG);
    clone.schemaVersion = clone.schemaVersion || "1.0.0";
    clone.gameMeta = clone.gameMeta || {};
    clone.gameMeta.title = clone.gameMeta.title || "エレベーターゲーム";
    clone.gameMeta.createdAt = clone.gameMeta.createdAt || nowIso();
    clone.stages = (clone.stages || []).map((stage, index) => {
      const params = stage.params || {};
      return {
        stageId: stage.stageId || `stage-${String(index + 1).padStart(3, "0")}`,
        name: stage.name || `ステージ${index + 1}`,
        params: {
          N: clampInt(params.N, 2, 999, 10),
          X: clampInt(params.X, 1, 999, 4),
          P: clampNumber(params.P, 0, 9999, 10),
          Q: clampNumber(params.Q, 0, 9999, 5),
        },
        events: (stage.events || []).slice(0, 10).map(normalizeEvent).filter(Boolean),
      };
    });
    if (clone.stages.length === 0) {
      clone.stages = deepClone(DEFAULT_CONFIG.stages);
    }
    return clone;
  }

  function normalizeEvent(event) {
    if (!event || !event.type) return null;
    const next = Object.assign({}, event);
    if (next.type === "E1_prediction") {
      const metric = next.metric || next.answerMetric || "";
      const defaultQuestion = DEFAULT_PREDICTION_QUESTIONS[metric] || "";
      if (defaultQuestion) next.question = defaultQuestion;
    }
    return next;
  }

  function getCurrentStage(room) {
    const config = room.config || DEFAULT_CONFIG;
    return config.stages[Math.min(room.currentStageIndex || 0, config.stages.length - 1)] || null;
  }

  function registerPlayer(room, name, uuid) {
    const cleanName = String(name || "").trim().slice(0, 24);
    if (!cleanName) {
      return { room, ok: false, error: "名前を入力してください。" };
    }
    const next = deepClone(room);
    const existingByUuid = uuid ? next.players.find((player) => player.uuid === uuid) : null;
    const duplicateName = next.players.find(
      (player) => player.name === cleanName && (!uuid || player.uuid !== uuid)
    );
    if (duplicateName) {
      return { room, ok: false, error: "この名前はすでに使われています。" };
    }
    if (existingByUuid) {
      existingByUuid.name = cleanName;
      existingByUuid.pendingName = null;
      existingByUuid.connected = true;
      existingByUuid.lastSeenAt = nowIso();
      next.updatedAt = nowIso();
      return { room: next, ok: true, player: existingByUuid };
    }
    const player = {
      uuid: uuid || createUuid(),
      name: cleanName,
      joinedAt: nowIso(),
      connected: true,
      lastSeenAt: nowIso(),
      skill: 0,
      stageSkillHistory: [],
    };
    next.players.push(player);
    next.scores[player.uuid] = next.scores[player.uuid] || 0;
    next.updatedAt = nowIso();
    return { room: next, ok: true, player };
  }

  function renamePlayer(room, uuid, nextName) {
    const cleanName = String(nextName || "").trim().slice(0, 24);
    if (!cleanName) return { room, ok: false, error: "名前を入力してください。" };
    const duplicate = room.players.find((player) => player.name === cleanName && player.uuid !== uuid);
    if (duplicate) return { room, ok: false, error: "この名前はすでに使われています。" };
    const next = deepClone(room);
    const player = next.players.find((item) => item.uuid === uuid);
    if (!player) return { room, ok: false, error: "プレイヤーが見つかりません。" };
    if ([PHASES.VOTING, PHASES.COUNTDOWN, PHASES.TALLYING, PHASES.REVEAL].includes(next.phase)) {
      player.pendingName = cleanName;
    } else {
      player.name = cleanName;
      player.pendingName = null;
    }
    player.lastSeenAt = nowIso();
    next.updatedAt = nowIso();
    return { room: next, ok: true, player };
  }

  function submitTicket(room, uuid, ticket) {
    const stage = getCurrentStage(room);
    if (!stage) return { room, ok: false, error: "ステージがありません。" };
    if (!canSubmitTicket(room)) {
      return { room, ok: false, error: "現在はチケット購入を受け付けていません。" };
    }
    const player = room.players.find((item) => item.uuid === uuid);
    if (!player) return { room, ok: false, error: "参加登録が必要です。" };
    const validation = validateTicket(stage, ticket);
    if (!validation.ok) return { room, ok: false, error: validation.error };
    const next = deepClone(room);
    const stageId = stage.stageId;
    next.tickets[stageId] = next.tickets[stageId] || {};
    next.tickets[stageId][uuid] = Object.assign({}, validation.ticket, {
      uuid,
      submittedAt: nowIso(),
      abstained: false,
    });
    next.updatedAt = nowIso();
    return { room: next, ok: true, ticket: next.tickets[stageId][uuid] };
  }

  function abstain(room, uuid) {
    const stage = getCurrentStage(room);
    if (!stage) return { room, ok: false, error: "ステージがありません。" };
    if (!canSubmitTicket(room)) {
      return { room, ok: false, error: "現在は棄権を受け付けていません。" };
    }
    const player = room.players.find((item) => item.uuid === uuid);
    if (!player) return { room, ok: false, error: "参加登録が必要です。" };
    const next = deepClone(room);
    next.tickets[stage.stageId] = next.tickets[stage.stageId] || {};
    next.tickets[stage.stageId][uuid] = {
      uuid,
      abstained: true,
      predictions: {},
      submittedAt: nowIso(),
    };
    next.updatedAt = nowIso();
    return { room: next, ok: true };
  }

  function validateTicket(stage, ticket) {
    const params = stage.params;
    const boardFloor = Number(ticket && ticket.boardFloor);
    const exitFloor = Number(ticket && ticket.exitFloor);
    if (!Number.isInteger(boardFloor) || boardFloor < 1 || boardFloor > params.N) {
      return { ok: false, error: `乗車階は1〜${params.N}階で入力してください。` };
    }
    if (!Number.isInteger(exitFloor) || exitFloor < boardFloor || exitFloor > params.N) {
      return { ok: false, error: `降車階は乗車階〜${params.N}階で入力してください。` };
    }
    const predictions = {};
    const predictionEvents = getPredictionEvents(stage);
    predictionEvents.forEach((event, index) => {
      const raw = ticket.predictions ? ticket.predictions[index] : "";
      predictions[index] = normalizePredictionAnswer(event, raw);
    });
    return { ok: true, ticket: { boardFloor, exitFloor, predictions } };
  }

  function getPredictionEvents(stage) {
    return (stage.events || []).filter((event) => event.type === "E1_prediction").slice(0, 2);
  }

  function normalizePredictionAnswer(event, raw) {
    if (raw === undefined || raw === null || raw === "") return "";
    if (event.answerFormat === "integer") return String(parseInt(raw, 10));
    if (event.answerFormat === "yesno") return String(raw).toLowerCase() === "yes" ? "yes" : "no";
    if (event.answerFormat === "range" || event.answerFormat === "select") return String(raw).trim().slice(0, 64);
    if (event.answerFormat === "player" || event.answerFormat === "player_uuid") return String(raw).trim().slice(0, 64);
    return String(raw).trim().slice(0, 64);
  }

  function tallyCurrentStage(room) {
    const stage = getCurrentStage(room);
    if (!stage) return { room, ok: false, error: "ステージがありません。" };
    if (![PHASES.COUNTDOWN, PHASES.TALLYING].includes(room.phase)) {
      return { room, ok: false, error: "現在は集計できません。" };
    }
    if (room.stageResults && room.stageResults[stage.stageId]) {
      return { room, ok: false, error: "このステージはすでに集計済みです。" };
    }
    const stageTickets = room.tickets[stage.stageId] || {};
    const result = calculateStage(stage, room.players, stageTickets);
    const next = deepClone(room);
    next.stageResults[stage.stageId] = result;
    next.phase = PHASES.REVEAL;
    next.animationStartedAt = nowIso();
    Object.values(result.players).forEach((playerResult) => {
      next.scores[playerResult.uuid] = (next.scores[playerResult.uuid] || 0) + playerResult.score;
    });
    applyStageSkills(next, result);
    next.updatedAt = nowIso();
    return { room: next, ok: true, result };
  }

  function calculateStage(stage, players, ticketsByUuid) {
    const params = stage.params;
    const playerMap = {};
    const validTickets = {};
    const forcedEvents = [];
    const timeline = [];
    const specialSuccess = {};
    const occupancyIntervals = {};
    const predictionEvents = getPredictionEvents(stage);
    const forbiddenEvents = (stage.events || []).filter((event) => event.type === "E2_forbidden");

    players.forEach((player) => {
      const ticket = ticketsByUuid[player.uuid];
      const base = {
        uuid: player.uuid,
        name: player.name,
        ticket: ticket || null,
        status: ticket ? "pending" : "absent",
        invalidReason: "",
        actualRise: 0,
        chargedDistance: 0,
        successPoint: 0,
        eventBonus: 0,
        penalty: 0,
        score: 0,
        forcedOff: false,
        boardedAt: null,
        exitedAt: null,
        successfulIntervals: [],
        predictionBreakdown: [],
        eventBreakdown: [],
        stageSkill: null,
      };
      if (!ticket || ticket.abstained) {
        base.status = ticket && ticket.abstained ? "abstained" : "absent";
        playerMap[player.uuid] = base;
        return;
      }
      base.chargedDistance = calculateTicketFloorUnits(ticket);
      const forbidden = findForbiddenUse(forbiddenEvents, ticket);
      if (forbidden) {
        base.status = "invalid";
        base.invalidReason = `${forbidden.fromFloor}〜${forbidden.toFloor}階は乗降禁止`;
      } else {
        validTickets[player.uuid] = ticket;
      }
      playerMap[player.uuid] = base;
    });

    let passengers = [];
    for (let floor = 1; floor <= params.N; floor += 1) {
      const boarding = Object.keys(validTickets)
        .filter((uuid) => validTickets[uuid].boardFloor === floor)
        .map((uuid) => ({
          uuid,
          boardFloor: validTickets[uuid].boardFloor,
          exitFloor: validTickets[uuid].exitFloor,
        }));
      const beforeCheck = passengers.concat(boarding);
      const step = {
        floor,
        boarding: boarding.map((item) => item.uuid),
        exiting: [],
        passengersBeforeCheck: passengers.map((item) => item.uuid),
        passengersAfterCheck: [],
        forcedOff: [],
      };

      if (beforeCheck.length > params.X) {
        beforeCheck.forEach((item) => {
          const result = playerMap[item.uuid];
          result.status = "forced_off";
          result.forcedOff = true;
          result.actualRise = calculateRiseFromIntervals(result.successfulIntervals);
        });
        step.forcedOff = beforeCheck.map((item) => item.uuid);
        forcedEvents.push({ floor, uuids: step.forcedOff });
        passengers = [];
        timeline.push(step);
        continue;
      }

      passengers = beforeCheck;
      step.passengersAfterCheck = passengers.map((item) => item.uuid);
      passengers.forEach((item) => {
        specialSuccess[item.uuid] = specialSuccess[item.uuid] || [];
        specialSuccess[item.uuid].push(floor);
        const result = playerMap[item.uuid];
        if (result.status === "pending") {
          result.status = "success";
          result.boardedAt = result.boardedAt || item.boardFloor;
        }
        if (!result.forcedOff) {
          result.successfulIntervals.push({ from: floor, to: floor, sameFloor: true, floorUnit: true, occupancy: passengers.length });
          occupancyIntervals[item.uuid] = occupancyIntervals[item.uuid] || [];
          occupancyIntervals[item.uuid].push({ from: floor, to: floor, sameFloor: true, floorUnit: true, occupancy: passengers.length });
        }
      });

      const exiting = passengers.filter((item) => item.exitFloor === floor);
      exiting.forEach((item) => {
        const result = playerMap[item.uuid];
        if (!result.forcedOff) {
          result.exitedAt = floor;
          result.status = "success";
        }
      });
      step.exiting = exiting.map((item) => item.uuid);
      passengers = passengers.filter((item) => item.exitFloor !== floor);
      timeline.push(step);
    }

    Object.values(playerMap).forEach((result) => {
      if (result.status === "pending") {
        result.status = "not_boarded";
      }
      if (["invalid", "not_boarded"].includes(result.status)) {
        result.actualRise = 0;
        result.successfulIntervals = [];
      }
      if (["success", "forced_off"].includes(result.status)) {
        result.actualRise = calculateRiseFromIntervals(result.successfulIntervals);
      }
      if (!result.ticket || result.ticket.abstained || result.status === "absent" || result.status === "abstained") {
        result.score = 0;
        return;
      }
      result.penalty = result.chargedDistance * params.Q;
      result.successPoint = calculateSuccessPoint(stage, result);
      result.eventBonus = calculateEventBonus(stage, result, specialSuccess[result.uuid] || [], occupancyIntervals[result.uuid] || []);
      result.score = roundScore(result.successPoint + result.eventBonus - result.penalty);
      result.eventBreakdown = buildEventBreakdown(stage, result, specialSuccess[result.uuid] || [], occupancyIntervals[result.uuid] || []);
    });

    const stats = {
      forcedOffCount: forcedEvents.length,
      allSucceeded: Object.values(playerMap).some((item) => item.ticket && !item.ticket.abstained)
        ? Object.values(playerMap).filter((item) => item.ticket && !item.ticket.abstained).every((item) => item.status === "success")
        : false,
      totalBoarded: Object.values(playerMap).filter((item) => item.status === "success").length,
    };
    const baseRankings = rankPlayers(Object.values(playerMap), {});
    const predictionContext = Object.assign({}, stats, {
      topPlayer: baseRankings[0] ? baseRankings[0].uuid : "",
    });

    Object.values(playerMap).forEach((result) => {
      if (!result.ticket || result.ticket.abstained || result.status === "absent" || result.status === "abstained") return;
      const predictionBonus = calculatePredictionBonus(predictionEvents, result, predictionContext);
      result.predictionBreakdown = predictionBonus.breakdown;
      result.eventBonus += predictionBonus.total;
      result.score = roundScore(result.successPoint + result.eventBonus - result.penalty);
    });

    const rankings = rankPlayers(Object.values(playerMap), {});

    return {
      stageId: stage.stageId,
      stageName: stage.name,
      params: deepClone(params),
      players: playerMap,
      rankings,
      timeline,
      stats,
      calculatedAt: nowIso(),
    };
  }

  function findForbiddenUse(events, ticket) {
    return events.find((event) => {
      const from = Number(event.fromFloor);
      const to = Number(event.toFloor);
      return isInRange(ticket.boardFloor, from, to) || isInRange(ticket.exitFloor, from, to);
    });
  }

  function calculateSuccessPoint(stage, result) {
    if (result.actualRise <= 0) return 0;
    const params = stage.params;
    const events = stage.events || [];
    let point = 0;
    result.successfulIntervals.forEach((interval) => {
      const distance = interval.sameFloor ? 1 : interval.to - interval.from;
      let multiplier = 1;
      events.forEach((event) => {
        if (event.type === "E3a_zone_multiplier" && intervalOverlapsZone(interval, event)) {
          multiplier *= Number(event.multiplier || 1);
        }
        if (event.type === "E5_occupancy_multiplier" && interval.occupancy >= Number(event.threshold || Infinity)) {
          multiplier *= Number(event.multiplier || 1);
        }
      });
      point += distance * params.P * multiplier;
    });
    events.forEach((event) => {
      if (event.type === "E3b_score_multiplier" && routeTouchesZone(result.ticket, event)) {
        point *= Number(event.multiplier || 1);
      }
    });
    return roundScore(point);
  }

  function calculateEventBonus(stage, result, successFloors) {
    let total = 0;
    (stage.events || []).forEach((event) => {
      if (event.type === "E7_entry_fee") {
        total += Number(event.score || 0);
      }
      if (result.actualRise <= 0) return;
      if (event.type === "E4_special_floor" && successFloors.includes(Number(event.floor))) {
        total += Number(event.bonus || event.score || 0);
      }
      if (event.type === "E6_view_bonus" && result.status === "success") {
        total += Number(result.ticket.exitFloor) * Number(event.bonusPerExitFloor || event.multiplier || 0);
      }
      if (event.type === "E8_completion_bonus" && result.status === "success") {
        total += Number(event.score || 0);
      }
    });
    return roundScore(total);
  }

  function calculatePredictionBonus(events, result, context) {
    if (!result.ticket || result.ticket.abstained) return { total: 0, breakdown: [] };
    let total = 0;
    const breakdown = events.map((event, index) => {
      const answer = result.ticket.predictions ? result.ticket.predictions[index] : "";
      const correct = resolveCorrectAnswer(event, context);
      const noAnswer = answer === undefined || answer === null || answer === "";
      const matched = !noAnswer && predictionMatches(event, answer, correct);
      const score = noAnswer
        ? Number(event.scoreOnNoAnswer || 0)
        : matched
          ? Number(event.scoreOnCorrect || 0)
          : Number(event.scoreOnWrong || 0);
      total += score;
      return {
        question: event.question,
        answerFormat: event.answerFormat,
        answer,
        correctAnswer: correct,
        matched,
        noAnswer,
        score,
      };
    });
    return { total, breakdown };
  }

  function resolveCorrectAnswer(event, context) {
    const metric = event.metric || event.answerMetric;
    if (metric === "forcedOffCount") return context.forcedOffCount;
    if (metric === "allSucceeded") return context.allSucceeded ? "yes" : "no";
    if (metric === "totalBoarded") return context.totalBoarded;
    if (metric === "topPlayer") return context.topPlayer || "";
    if (event.correctAnswer !== undefined) return event.correctAnswer;
    return "";
  }

  function predictionMatches(event, answer, correct) {
    if (event.answerFormat === "range") {
      const range = findPredictionRange(event, answer);
      const numericCorrect = Number(correct);
      if (range && Number.isFinite(numericCorrect)) {
        const min = Number(range.min ?? range.from ?? range.lower ?? -Infinity);
        const max = Number(range.max ?? range.to ?? range.upper ?? Infinity);
        return numericCorrect >= min && numericCorrect <= max;
      }
    }
    return String(answer).toLowerCase() === String(correct).toLowerCase();
  }

  function getPredictionOptions(event) {
    return event.options || event.choices || event.ranges || [];
  }

  function findPredictionRange(event, answer) {
    const target = String(answer);
    return getPredictionOptions(event).find((option, index) => {
      const value = option.value !== undefined ? option.value : String(index);
      return String(value) === target || String(option.label || "") === target;
    });
  }

  function buildEventBreakdown(stage, result, successFloors) {
    const items = [];
    (stage.events || []).forEach((event) => {
      if (event.type === "E2_forbidden" && result.status === "invalid" && result.invalidReason) {
        items.push({ label: "禁止階", value: result.invalidReason });
      }
      if (event.type === "E3a_zone_multiplier") {
        const hit = result.successfulIntervals.some((interval) => intervalOverlapsZone(interval, event));
        if (hit) items.push({ label: "区間倍率", value: `${event.fromFloor}〜${event.toFloor}階 x${event.multiplier}` });
      }
      if (event.type === "E3b_score_multiplier" && result.ticket && routeTouchesZone(result.ticket, event)) {
        items.push({ label: "得点倍率", value: `${event.fromFloor}〜${event.toFloor}階 x${event.multiplier}` });
      }
      if (event.type === "E4_special_floor" && successFloors.includes(Number(event.floor))) {
        items.push({ label: "特別階", value: `${event.floor}階 +${event.bonus || event.score || 0}` });
      }
      if (event.type === "E6_view_bonus" && result.status === "success") {
        items.push({ label: "眺望", value: `降車階${result.ticket.exitFloor} x${event.bonusPerExitFloor || event.multiplier || 0}` });
      }
      if (event.type === "E7_entry_fee") {
        items.push({ label: "入場料", value: formatSignedScore(Number(event.score || 0)) });
      }
      if (event.type === "E8_completion_bonus" && result.status === "success") {
        items.push({ label: "完乗ボーナス", value: formatSignedScore(Number(event.score || 0)) });
      }
    });
    return items;
  }

  function formatSignedScore(value) {
    return `${value >= 0 ? "+" : ""}${roundScore(value)}`;
  }

  function applyStageSkills(room, result) {
    const active = Object.values(result.players).filter((item) => item.ticket && !item.ticket.abstained);
    if (active.length <= 1) return;
    const scores = active.map((item) => item.score);
    const min = Math.min.apply(null, scores);
    const max = Math.max.apply(null, scores);
    const standardized = {};
    active.forEach((item) => {
      standardized[item.uuid] = min === max ? 55 : 10 + ((item.score - min) / (max - min)) * 90;
    });
    const standardizedAverage =
      active.reduce((sum, item) => sum + standardized[item.uuid], 0) / Math.max(active.length, 1);
    const denominator = result.params.N * result.params.X / active.length;
    active.forEach((item) => {
      const climbTerm = denominator > 0 ? (item.actualRise / denominator) * 60 : 0;
      const scoreTerm = standardizedAverage > 0 ? (standardized[item.uuid] / standardizedAverage) * 40 : 0;
      const stageSkill = Math.max(0, roundScore(climbTerm + scoreTerm));
      item.stageSkill = stageSkill;
      const player = room.players.find((entry) => entry.uuid === item.uuid);
      if (player) {
        player.stageSkillHistory = player.stageSkillHistory || [];
        item.skillBefore = calculateCurrentSkill(player.stageSkillHistory);
        player.stageSkillHistory.push(stageSkill);
        player.skill = calculateCurrentSkill(player.stageSkillHistory);
        item.skillAfter = player.skill;
        item.skillDelta = roundScore(item.skillAfter - item.skillBefore);
      }
    });
  }

  function calculateCurrentSkill(history) {
    const sorted = (history || []).slice().sort((a, b) => b - a);
    while (sorted.length < 5) sorted.push(0);
    return roundScore(sorted.slice(0, 5).reduce((sum, value) => sum + value, 0));
  }

  function calculateRiseFromIntervals(intervals) {
    return (intervals || []).reduce((sum, interval) => {
      return sum + (interval.sameFloor ? 1 : Math.max(0, Number(interval.to) - Number(interval.from)));
    }, 0);
  }

  function calculateTicketFloorUnits(ticket) {
    return Math.max(0, Number(ticket.exitFloor) - Number(ticket.boardFloor) + 1);
  }

  function rankPlayers(playerResults, cumulativeScores) {
    const sorted = playerResults
      .map((item) => ({
        uuid: item.uuid,
        name: item.name,
        score: roundScore(item.score || 0),
        totalScore: roundScore(cumulativeScores[item.uuid] || item.score || 0),
        status: item.status,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
    let previousScore = null;
    let previousRank = 0;
    return sorted.map((item, index) => {
      const rank = item.score === previousScore ? previousRank : index + 1;
      previousScore = item.score;
      previousRank = rank;
      return Object.assign({ rank }, item);
    });
  }

  function cumulativeRankings(room) {
    const rows = room.players
      .map((player) => ({
        uuid: player.uuid,
        name: player.name,
        score: roundScore(room.scores[player.uuid] || 0),
        skill: roundScore(player.skill || 0),
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
    let previousScore = null;
    let previousRank = 0;
    return rows.map((row, index) => {
      const rank = row.score === previousScore ? previousRank : index + 1;
      previousScore = row.score;
      previousRank = rank;
      return Object.assign({ rank }, row);
    });
  }

  function rerankRows(rows) {
    let previousScore = null;
    let previousRank = 0;
    return rows.map((row, index) => {
      const score = roundScore(row.score || 0);
      const rank = score === previousScore ? previousRank : index + 1;
      previousScore = score;
      previousRank = rank;
      return Object.assign({}, row, { rank, score });
    });
  }

  function removeUuidFromTimelineStep(step, uuid) {
    const next = Object.assign({}, step);
    ["boarding", "exiting", "passengersBeforeCheck", "passengersAfterCheck", "forcedOff"].forEach((key) => {
      next[key] = Array.isArray(next[key]) ? next[key].filter((item) => item !== uuid) : [];
    });
    return next;
  }

  function refreshResultStats(result) {
    const players = Object.values(result.players || {});
    const active = players.filter((player) => player.ticket && !player.ticket.abstained);
    result.stats = Object.assign({}, result.stats || {}, {
      forcedOffCount: (result.timeline || []).filter((step) => step.forcedOff && step.forcedOff.length).length,
      allSucceeded: active.length ? active.every((player) => player.status === "success") : false,
      totalBoarded: players.filter((player) => player.status === "success").length,
    });
  }

  function advancePhase(room, action, actor) {
    const next = deepClone(room);
    const stage = getCurrentStage(next);
    const label = actor || "host";
    const log = { at: nowIso(), actor: label, action };
    if (action === "start-stage") {
      if (next.phase !== PHASES.LOBBY) return { room, ok: false, error: "現在はステージ説明へ進めません。" };
      next.phase = PHASES.STAGE_INTRO;
      applyPendingNames(next);
    } else if (action === "open-voting") {
      if (next.phase !== PHASES.STAGE_INTRO) return { room, ok: false, error: "現在は受付を開始できません。" };
      next.phase = PHASES.VOTING;
    } else if (action === "close-voting") {
      if (next.phase !== PHASES.VOTING) return { room, ok: false, error: "現在は締切できません。" };
      next.phase = PHASES.COUNTDOWN;
      next.countdownEndsAt = new Date(Date.now() + 15000).toISOString();
      next.tallyingEndsAt = new Date(Date.now() + 18000).toISOString();
    } else if (action === "tally") {
      return tallyCurrentStage(next);
    } else if (action === "show-ranking") {
      if (next.phase !== PHASES.REVEAL) return { room, ok: false, error: "現在は順位発表へ進めません。" };
      next.phase = PHASES.RANKING;
    } else if (action === "skip-animation") {
      if (next.phase !== PHASES.REVEAL) return { room, ok: false, error: "現在はスキップできません。" };
      next.animationSkippedAt = nowIso();
      next.phase = PHASES.RANKING;
    } else if (action === "next-stage") {
      if (next.phase !== PHASES.RANKING) return { room, ok: false, error: "現在は次へ進めません。" };
      if (next.currentStageIndex < next.config.stages.length - 1) {
        next.currentStageIndex += 1;
        next.phase = PHASES.STAGE_INTRO;
        next.countdownEndsAt = null;
        next.tallyingEndsAt = null;
        next.animationStartedAt = null;
        next.animationSkippedAt = null;
        next.revealEndsAt = null;
        applyPendingNames(next);
      } else {
        next.phase = PHASES.FINAL;
      }
    } else if (action === "reset-room") {
      return { room: createInitialRoom(next.config), ok: true };
    }
    next.operations.unshift(log);
    next.operations = next.operations.slice(0, 100);
    next.updatedAt = nowIso();
    return { room: next, ok: true, stage };
  }

  function applyPendingNames(room) {
    room.players.forEach((player) => {
      if (player.pendingName) {
        player.name = player.pendingName;
        player.pendingName = null;
      }
    });
  }

  function warningsForTicket(stage, ticket) {
    const warnings = [];
    if (!stage || !ticket) return warnings;
    (stage.events || []).forEach((event) => {
      if (event.type === "E2_forbidden") {
        const board = Number(ticket.boardFloor);
        const exit = Number(ticket.exitFloor);
        if (isInRange(board, event.fromFloor, event.toFloor) || isInRange(exit, event.fromFloor, event.toFloor)) {
          warnings.push(`${event.fromFloor}〜${event.toFloor}階は乗降禁止です。このまま送ると乗車失敗扱いになります。`);
        }
      }
    });
    return warnings;
  }

  function canSubmitTicket(room) {
    if (room.phase === PHASES.VOTING) return true;
    if (room.phase !== PHASES.COUNTDOWN) return false;
    if (!room.countdownEndsAt) return false;
    return Date.now() <= new Date(room.countdownEndsAt).getTime();
  }

  function intervalOverlapsZone(interval, event) {
    const from = Number(event.fromFloor);
    const to = Number(event.toFloor);
    if (interval.sameFloor) return isInRange(interval.from, from, to);
    return interval.from >= from && interval.to <= to;
  }

  function routeTouchesZone(ticket, event) {
    if (!ticket) return false;
    const from = Number(event.fromFloor);
    const to = Number(event.toFloor);
    for (let floor = ticket.boardFloor; floor <= ticket.exitFloor; floor += 1) {
      if (isInRange(floor, from, to)) return true;
    }
    return false;
  }

  function isInRange(value, from, to) {
    const low = Math.min(Number(from), Number(to));
    const high = Math.max(Number(from), Number(to));
    return Number(value) >= low && Number(value) <= high;
  }

  function clampInt(value, min, max, fallback) {
    const number = parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function roundScore(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createUuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
      const random = Math.random() * 16 | 0;
      const value = char === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  function uniqueGameId(title) {
    const normalized = String(title || "game").trim().replace(/\s+/g, "-").slice(0, 32) || "game";
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    return `${normalized}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  return {
    PHASES,
    DEFAULT_CONFIG,
    createInitialRoom,
    createNextGameRoom,
    normalizeConfig,
    getCurrentStage,
    registerPlayer,
    removePlayerFromRoom,
    renamePlayer,
    submitTicket,
    abstain,
    validateTicket,
    warningsForTicket,
    getPredictionEvents,
    calculateStage,
    tallyCurrentStage,
    applyStageSkills,
    calculateCurrentSkill,
    cumulativeRankings,
    advancePhase,
    createUuid,
    deepClone,
    roundScore,
  };
});
