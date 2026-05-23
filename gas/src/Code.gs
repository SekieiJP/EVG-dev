const EVG_SHEETS = {
  config: 'config',
  saveData: 'save_data',
  stageResults: 'stage_results',
  players: 'players',
  currentGame: 'current_game',
  stageSettings: 'stage_settings',
  gameHistory: 'game_history',
};

const EVG_PHASES = {
  LOBBY: 'lobby',
  STAGE_INTRO: 'stage_intro',
  VOTING: 'voting',
  COUNTDOWN: 'countdown',
  TALLYING: 'tallying',
  REVEAL: 'reveal',
  RANKING: 'ranking',
  FINAL: 'final',
};

const EVG_DEFAULT_CONFIG = {
  schemaVersion: '1.0.0',
  gameMeta: {
    title: 'エレベーターゲーム',
    description: '短時間パーティ版',
    createdAt: '2026-05-23T00:00:00+09:00',
  },
  stages: [
    {
      stageId: 'stage-001',
      name: 'ステージ1',
      params: { N: 10, X: 3, P: 10, Q: 4 },
      events: [
        {
          type: 'E1_prediction',
          question: '強制下車は何回発生する？',
          answerFormat: 'integer',
          correctAnswer: 1,
          scoreOnCorrect: 30,
          scoreOnWrong: 0,
          scoreOnNoAnswer: -5,
        },
        { type: 'E2_forbidden', fromFloor: 4, toFloor: 4 },
        { type: 'E3a_zone_multiplier', fromFloor: 7, toFloor: 10, multiplier: 2 },
      ],
    },
  ],
};

function doGet(e) {
  return route_(e, 'GET');
}

function doPost(e) {
  return route_(e, 'POST');
}

function setupElevatorGameSheets() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, EVG_SHEETS.config, ['key', 'value']);
  ensureSheet_(ss, EVG_SHEETS.saveData, ['uuid', 'gameId', 'nameSnapshot', 'summaryJson', 'createdAt']);
  ensureSheet_(ss, EVG_SHEETS.stageResults, ['uuid', 'gameId', 'stageId', 'resultJson', 'createdAt']);
  ensureSheet_(ss, EVG_SHEETS.players, ['uuid', 'name', 'skill', 'stageSkillHistoryJson', 'updatedAt']);
  ensureSheet_(ss, EVG_SHEETS.currentGame, ['key', 'json', 'updatedAt']);
  ensureSheet_(ss, EVG_SHEETS.stageSettings, ['gameId', 'stageId', 'stageJson', 'createdAt']);
  ensureSheet_(ss, EVG_SHEETS.gameHistory, ['gameId', 'summaryJson', 'createdAt']);
  const config = ss.getSheetByName(EVG_SHEETS.config);
  if (config.getLastRow() < 2) {
    config.appendRow(['hostPassword', 'host']);
    config.appendRow(['pollCacheSeconds', '2']);
  }
  if (!getRoom_()) {
    saveRoom_(createInitialRoom_(EVG_DEFAULT_CONFIG));
  }
}

function route_(e, method) {
  const startedAt = new Date();
  const path = normalizePath_(e);
  const payload = parsePayload_(e);
  try {
    setupElevatorGameSheets();
    let response;
    if (method === 'GET' && path === '/api/time') response = { serverTime: new Date().toISOString() };
    else if (method === 'GET' && (path === '/api/room/state' || path === '/api/screen/state')) response = publicRoom_(getRoom_(), payload.uuid);
    else if (method === 'GET' && path === '/api/history/games') response = getHistoryGames_();
    else if (method === 'GET' && path.indexOf('/api/history/player/') === 0) response = getPlayerHistory_(path.split('/').pop(), payload.uuid);
    else if (method === 'POST') response = mutateRoute_(path, payload);
    else response = error_('not_found', 'Unknown endpoint: ' + path, 404);
    console.log(JSON.stringify({ at: startedAt.toISOString(), path, method, uuid: payload.uuid || '', ok: response.ok !== false }));
    return json_(response);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_(error_('server_error', String(err), 500));
  }
}

function mutateRoute_(path, payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let room = getRoom_() || createInitialRoom_(EVG_DEFAULT_CONFIG);
    let result;
    if (path === '/api/player/join') result = registerPlayer_(room, payload.name, payload.uuid);
    else if (path === '/api/player/restore') result = restorePlayer_(room, payload.uuid);
    else if (path === '/api/player/rename') result = renamePlayer_(room, payload.uuid, payload.name);
    else if (path === '/api/player/proceed-next') result = advancePhase_(room, 'next-stage', payload.uuid || 'player');
    else if (path === '/api/ticket/submit') result = submitTicket_(room, payload.uuid, payload.ticket || payload);
    else if (path === '/api/ticket/abstain') result = abstain_(room, payload.uuid);
    else if (path === '/api/host/auth') return authHost_(payload.password);
    else if (path === '/api/host/start-stage') result = advancePhase_(room, 'start-stage', payload.hostName || 'host');
    else if (path === '/api/host/open-voting') result = advancePhase_(room, 'open-voting', payload.hostName || 'host');
    else if (path === '/api/host/close-voting') result = advancePhase_(room, 'close-voting', payload.hostName || 'host');
    else if (path === '/api/host/reveal-result') result = tallyCurrentStage_(room, payload.hostName || 'host');
    else if (path === '/api/host/show-ranking') result = advancePhase_(room, 'show-ranking', payload.hostName || 'host');
    else if (path === '/api/host/skip-animation') result = advancePhase_(room, 'skip-animation', payload.hostName || 'host');
    else if (path === '/api/host/advance') result = advancePhase_(room, 'next-stage', payload.hostName || 'host');
    else if (path === '/api/host/recalculate') result = recalculate_(room);
    else if (path === '/api/host/import-config') result = importConfig_(payload.config);
    else return error_('not_found', 'Unknown endpoint: ' + path, 404);
    if (result && result.room) {
      saveRoom_(result.room);
      syncPlayersSheet_(result.room);
      if (result.room.phase === EVG_PHASES.FINAL) persistGameHistory_(result.room);
    }
    return Object.assign({}, result, { room: result && result.room ? publicRoom_(result.room, payload.uuid) : undefined });
  } finally {
    lock.releaseLock();
  }
}

function createInitialRoom_(config) {
  const normalized = normalizeConfig_(config);
  return {
    roomId: 'single-room',
    gameId: uniqueGameId_(normalized.gameMeta.title),
    config: normalized,
    phase: EVG_PHASES.LOBBY,
    currentStageIndex: 0,
    players: [],
    tickets: {},
    stageResults: {},
    scores: {},
    operations: [],
    countdownEndsAt: null,
    tallyingEndsAt: null,
    animationStartedAt: null,
    animationSkippedAt: null,
    volume: 0.8,
    muted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeConfig_(config) {
  const source = config || EVG_DEFAULT_CONFIG;
  const stages = (source.stages || []).map(function(stage, index) {
    const params = stage.params || {};
    return {
      stageId: stage.stageId || 'stage-' + String(index + 1).padStart(3, '0'),
      name: stage.name || 'ステージ' + (index + 1),
      params: {
        N: clamp_(parseInt(params.N, 10), 2, 999, 10),
        X: clamp_(parseInt(params.X, 10), 1, 999, 4),
        P: clamp_(Number(params.P), 0, 9999, 10),
        Q: clamp_(Number(params.Q), 0, 9999, 5),
      },
      events: (stage.events || []).slice(0, 10),
    };
  });
  return {
    schemaVersion: source.schemaVersion || '1.0.0',
    gameMeta: {
      title: source.gameMeta && source.gameMeta.title ? source.gameMeta.title : 'エレベーターゲーム',
      description: source.gameMeta && source.gameMeta.description ? source.gameMeta.description : '',
      createdAt: source.gameMeta && source.gameMeta.createdAt ? source.gameMeta.createdAt : new Date().toISOString(),
    },
    settings: source.settings || {},
    stages: stages.length ? stages : EVG_DEFAULT_CONFIG.stages,
  };
}

function registerPlayer_(room, name, uuid) {
  const cleanName = String(name || '').trim().slice(0, 24);
  if (!cleanName) return error_('validation', '名前を入力してください。', 400);
  const duplicate = room.players.find(function(player) {
    return player.name === cleanName && (!uuid || player.uuid !== uuid);
  });
  if (duplicate) return error_('duplicate_name', 'この名前はすでに使われています。', 409);
  let player = uuid ? room.players.find(function(item) { return item.uuid === uuid; }) : null;
  if (player) {
    player.name = cleanName;
    player.connected = true;
    player.lastSeenAt = new Date().toISOString();
  } else {
    player = {
      uuid: uuid || Utilities.getUuid(),
      name: cleanName,
      joinedAt: new Date().toISOString(),
      connected: true,
      lastSeenAt: new Date().toISOString(),
      skill: 0,
      stageSkillHistory: [],
    };
    room.players.push(player);
    room.scores[player.uuid] = room.scores[player.uuid] || 0;
  }
  touchRoom_(room);
  return { ok: true, room, player };
}

function restorePlayer_(room, uuid) {
  const player = room.players.find(function(item) { return item.uuid === uuid; });
  if (!player) return error_('not_found', 'UUIDが見つかりません。', 404);
  player.connected = true;
  player.lastSeenAt = new Date().toISOString();
  touchRoom_(room);
  return { ok: true, room, player };
}

function renamePlayer_(room, uuid, name) {
  const player = room.players.find(function(item) { return item.uuid === uuid; });
  if (!player) return error_('not_found', 'プレイヤーが見つかりません。', 404);
  const cleanName = String(name || '').trim().slice(0, 24);
  if (!cleanName) return error_('validation', '名前を入力してください。', 400);
  const duplicate = room.players.find(function(item) { return item.name === cleanName && item.uuid !== uuid; });
  if (duplicate) return error_('duplicate_name', 'この名前はすでに使われています。', 409);
  if ([EVG_PHASES.VOTING, EVG_PHASES.COUNTDOWN, EVG_PHASES.REVEAL].indexOf(room.phase) >= 0) player.pendingName = cleanName;
  else {
    player.name = cleanName;
    player.pendingName = null;
  }
  touchRoom_(room);
  return { ok: true, room, player };
}

function submitTicket_(room, uuid, ticket) {
  const stage = getCurrentStage_(room);
  if (!stage) return error_('stage_missing', 'ステージがありません。', 400);
  if ([EVG_PHASES.VOTING, EVG_PHASES.COUNTDOWN].indexOf(room.phase) < 0) {
    return error_('phase', '現在はチケット購入を受け付けていません。', 409);
  }
  if (!room.players.some(function(player) { return player.uuid === uuid; })) {
    return error_('not_joined', '参加登録が必要です。', 403);
  }
  const validated = validateTicket_(stage, ticket);
  if (!validated.ok) return validated;
  room.tickets[stage.stageId] = room.tickets[stage.stageId] || {};
  room.tickets[stage.stageId][uuid] = Object.assign({}, validated.ticket, {
    uuid,
    submittedAt: new Date().toISOString(),
    abstained: false,
  });
  touchRoom_(room);
  return { ok: true, room, ticket: room.tickets[stage.stageId][uuid] };
}

function abstain_(room, uuid) {
  const stage = getCurrentStage_(room);
  if (!stage) return error_('stage_missing', 'ステージがありません。', 400);
  room.tickets[stage.stageId] = room.tickets[stage.stageId] || {};
  room.tickets[stage.stageId][uuid] = { uuid, abstained: true, predictions: {}, submittedAt: new Date().toISOString() };
  touchRoom_(room);
  return { ok: true, room };
}

function validateTicket_(stage, ticket) {
  const boardFloor = Number(ticket && ticket.boardFloor);
  const exitFloor = Number(ticket && ticket.exitFloor);
  if (Math.floor(boardFloor) !== boardFloor || boardFloor < 1 || boardFloor > stage.params.N) {
    return error_('validation', '乗車階が範囲外です。', 400);
  }
  if (Math.floor(exitFloor) !== exitFloor || exitFloor < boardFloor || exitFloor > stage.params.N) {
    return error_('validation', '降車階が範囲外です。', 400);
  }
  const predictions = {};
  getPredictionEvents_(stage).forEach(function(event, index) {
    const raw = ticket.predictions ? ticket.predictions[index] : '';
    predictions[index] = normalizePredictionAnswer_(event, raw);
  });
  return { ok: true, ticket: { boardFloor, exitFloor, predictions } };
}

function getPredictionEvents_(stage) {
  return (stage.events || []).filter(function(event) { return event.type === 'E1_prediction'; }).slice(0, 2);
}

function normalizePredictionAnswer_(event, raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (event.answerFormat === 'integer') return String(parseInt(raw, 10));
  if (event.answerFormat === 'yesno') return String(raw).toLowerCase() === 'yes' ? 'yes' : 'no';
  if (event.answerFormat === 'range' || event.answerFormat === 'select') return String(raw).trim().slice(0, 64);
  if (event.answerFormat === 'player' || event.answerFormat === 'player_uuid') return String(raw).trim().slice(0, 64);
  return String(raw).trim().slice(0, 64);
}

function advancePhase_(room, action, actor) {
  if (action === 'start-stage') {
    room.phase = EVG_PHASES.STAGE_INTRO;
    applyPendingNames_(room);
  } else if (action === 'open-voting') room.phase = EVG_PHASES.VOTING;
  else if (action === 'close-voting') {
    room.phase = EVG_PHASES.COUNTDOWN;
    room.countdownEndsAt = new Date(Date.now() + 15000).toISOString();
    room.tallyingEndsAt = new Date(Date.now() + 18000).toISOString();
  } else if (action === 'show-ranking') {
    room.phase = EVG_PHASES.RANKING;
  } else if (action === 'skip-animation') {
    room.animationSkippedAt = new Date().toISOString();
    room.phase = EVG_PHASES.RANKING;
  } else if (action === 'next-stage') {
    if (room.currentStageIndex < room.config.stages.length - 1) {
      room.currentStageIndex += 1;
      room.phase = EVG_PHASES.STAGE_INTRO;
      room.countdownEndsAt = null;
      room.tallyingEndsAt = null;
      room.animationStartedAt = null;
      room.animationSkippedAt = null;
      applyPendingNames_(room);
    } else {
      room.phase = EVG_PHASES.FINAL;
    }
  }
  addOperation_(room, actor, action);
  touchRoom_(room);
  return { ok: true, room };
}

function tallyCurrentStage_(room, actor) {
  const stage = getCurrentStage_(room);
  const result = calculateStage_(stage, room.players, room.tickets[stage.stageId] || {});
  room.stageResults[stage.stageId] = result;
  Object.keys(result.players).forEach(function(uuid) {
    room.scores[uuid] = round_(Number(room.scores[uuid] || 0) + result.players[uuid].score);
  });
  applyStageSkills_(room, result);
  room.phase = EVG_PHASES.REVEAL;
  room.animationStartedAt = new Date().toISOString();
  addOperation_(room, actor, 'reveal-result');
  touchRoom_(room);
  return { ok: true, room, result };
}

function calculateStage_(stage, players, ticketsByUuid) {
  const params = stage.params;
  const playerMap = {};
  const validTickets = {};
  const forcedEvents = [];
  const specialSuccess = {};
  const timeline = [];
  players.forEach(function(player) {
    const ticket = ticketsByUuid[player.uuid];
    const result = {
      uuid: player.uuid,
      name: player.name,
      ticket: ticket || null,
      status: ticket ? 'pending' : 'absent',
      actualRise: 0,
      chargedDistance: ticket && !ticket.abstained ? calculateTicketFloorUnits_(ticket) : 0,
      successPoint: 0,
      eventBonus: 0,
      penalty: 0,
      score: 0,
      forcedOff: false,
      successfulIntervals: [],
      predictionBreakdown: [],
      stageSkill: null,
    };
    if (!ticket || ticket.abstained) {
      result.status = ticket && ticket.abstained ? 'abstained' : 'absent';
      playerMap[player.uuid] = result;
      return;
    }
    const forbidden = (stage.events || []).find(function(event) {
      return event.type === 'E2_forbidden' &&
        (inRange_(ticket.boardFloor, event.fromFloor, event.toFloor) || inRange_(ticket.exitFloor, event.fromFloor, event.toFloor));
    });
    if (forbidden) result.status = 'invalid';
    else validTickets[player.uuid] = ticket;
    playerMap[player.uuid] = result;
  });

  let passengers = [];
  for (let floor = 1; floor <= params.N; floor += 1) {
    const boarding = Object.keys(validTickets)
      .filter(function(uuid) { return validTickets[uuid].boardFloor === floor; })
      .map(function(uuid) { return { uuid, boardFloor: validTickets[uuid].boardFloor, exitFloor: validTickets[uuid].exitFloor }; });
    const beforeCheck = passengers.concat(boarding);
    const step = { floor, boarding: boarding.map(prop_('uuid')), exiting: [], forcedOff: [], passengersAfterCheck: [] };
    if (beforeCheck.length > params.X) {
      beforeCheck.forEach(function(item) {
        playerMap[item.uuid].status = 'forced_off';
        playerMap[item.uuid].forcedOff = true;
        playerMap[item.uuid].actualRise = calculateRiseFromIntervals_(playerMap[item.uuid].successfulIntervals);
      });
      step.forcedOff = beforeCheck.map(prop_('uuid'));
      forcedEvents.push(step);
      passengers = [];
      timeline.push(step);
      continue;
    }
    passengers = beforeCheck;
    step.passengersAfterCheck = passengers.map(prop_('uuid'));
    passengers.forEach(function(item) {
      specialSuccess[item.uuid] = specialSuccess[item.uuid] || [];
      specialSuccess[item.uuid].push(floor);
      const result = playerMap[item.uuid];
      if (result.status === 'pending') result.status = 'success';
      if (!result.forcedOff) {
        result.successfulIntervals.push({ from: floor, to: floor, sameFloor: true, floorUnit: true, occupancy: passengers.length });
      }
    });
    const exiting = passengers.filter(function(item) { return item.exitFloor === floor; });
    exiting.forEach(function(item) {
      const result = playerMap[item.uuid];
      result.status = 'success';
    });
    step.exiting = exiting.map(prop_('uuid'));
    passengers = passengers.filter(function(item) { return item.exitFloor !== floor; });
    timeline.push(step);
  }

  Object.keys(playerMap).forEach(function(uuid) {
    const result = playerMap[uuid];
    if (result.status === 'pending') result.status = 'not_boarded';
    if (['invalid', 'not_boarded'].indexOf(result.status) >= 0) {
      result.actualRise = 0;
      result.successfulIntervals = [];
    }
    if (result.status === 'success' || result.status === 'forced_off') {
      result.actualRise = calculateRiseFromIntervals_(result.successfulIntervals);
    }
    if (!result.ticket || result.ticket.abstained || result.status === 'absent' || result.status === 'abstained') return;
    result.penalty = result.chargedDistance * params.Q;
    result.successPoint = calculateSuccessPoint_(stage, result);
    result.eventBonus = calculateEventBonus_(stage, result, specialSuccess[uuid] || [], forcedEvents);
    result.score = round_(result.successPoint + result.eventBonus - result.penalty);
  });

  const stats = {
    forcedOffCount: forcedEvents.length,
    allSucceeded: Object.keys(playerMap).some(function(uuid) {
      const item = playerMap[uuid];
      return item.ticket && !item.ticket.abstained;
    }) ? Object.keys(playerMap).filter(function(uuid) {
      const item = playerMap[uuid];
      return item.ticket && !item.ticket.abstained;
    }).every(function(uuid) {
      return playerMap[uuid].status === 'success';
    }) : false,
    totalBoarded: Object.keys(playerMap).filter(function(uuid) { return playerMap[uuid].status === 'success'; }).length,
  };
  const baseRankings = rankResults_(Object.keys(playerMap).map(function(uuid) { return playerMap[uuid]; }));
  const predictionContext = Object.assign({}, stats, {
    topPlayer: baseRankings[0] ? baseRankings[0].uuid : '',
  });

  Object.keys(playerMap).forEach(function(uuid) {
    const result = playerMap[uuid];
    if (!result.ticket || result.ticket.abstained || result.status === 'absent' || result.status === 'abstained') return;
    const predictionBonus = calculatePredictionBonus_(stage, result, predictionContext);
    result.predictionBreakdown = predictionBonus.breakdown;
    result.eventBonus = round_(result.eventBonus + predictionBonus.total);
    result.score = round_(result.successPoint + result.eventBonus - result.penalty);
  });

  return {
    stageId: stage.stageId,
    stageName: stage.name,
    params: stage.params,
    players: playerMap,
    rankings: rankResults_(Object.keys(playerMap).map(function(uuid) { return playerMap[uuid]; })),
    timeline,
    stats,
    calculatedAt: new Date().toISOString(),
  };
}

function calculateSuccessPoint_(stage, result) {
  if (result.actualRise <= 0) return 0;
  let point = 0;
  result.successfulIntervals.forEach(function(interval) {
    const distance = interval.sameFloor ? 1 : interval.to - interval.from;
    let multiplier = 1;
    (stage.events || []).forEach(function(event) {
      if (event.type === 'E3a_zone_multiplier' && interval.from >= Number(event.fromFloor) && interval.to <= Number(event.toFloor)) multiplier *= Number(event.multiplier || 1);
      if (event.type === 'E5_occupancy_multiplier' && interval.occupancy >= Number(event.threshold || 999999)) multiplier *= Number(event.multiplier || 1);
    });
    point += distance * stage.params.P * multiplier;
  });
  (stage.events || []).forEach(function(event) {
    if (event.type === 'E3b_score_multiplier' && routeTouchesZone_(result.ticket, event)) point *= Number(event.multiplier || 1);
  });
  return round_(point);
}

function calculateTicketFloorUnits_(ticket) {
  return Math.max(0, Number(ticket.exitFloor) - Number(ticket.boardFloor) + 1);
}

function calculateEventBonus_(stage, result, successFloors) {
  if (result.actualRise <= 0) return 0;
  let total = 0;
  (stage.events || []).forEach(function(event) {
    if (event.type === 'E4_special_floor' && successFloors.indexOf(Number(event.floor)) >= 0) {
      total += Number(event.bonus || event.score || 0);
    }
    if (event.type === 'E6_view_bonus' && result.status === 'success') {
      total += Number(result.ticket.exitFloor) * Number(event.bonusPerExitFloor || event.multiplier || 0);
    }
  });
  return round_(total);
}

function calculatePredictionBonus_(stage, result, context) {
  if (!result.ticket || result.ticket.abstained) return { total: 0, breakdown: [] };
  let total = 0;
  const breakdown = (stage.events || []).filter(function(event) { return event.type === 'E1_prediction'; }).slice(0, 2).map(function(event, index) {
    const answer = result.ticket.predictions ? result.ticket.predictions[index] : '';
    const correct = resolveCorrectAnswer_(event, context);
    const noAnswer = answer === undefined || answer === null || answer === '';
    const matched = !noAnswer && predictionMatches_(event, answer, correct);
    const score = noAnswer ? Number(event.scoreOnNoAnswer || 0) : (matched ? Number(event.scoreOnCorrect || 0) : Number(event.scoreOnWrong || 0));
    total += score;
    return { question: event.question, answer, correctAnswer: correct, matched, noAnswer, score };
  });
  return { total: round_(total), breakdown };
}

function resolveCorrectAnswer_(event, context) {
  if (event.correctAnswer !== undefined) return event.correctAnswer;
  const metric = event.metric || event.answerMetric;
  if (metric === 'forcedOffCount') return context.forcedOffCount;
  if (metric === 'allSucceeded') return context.allSucceeded ? 'yes' : 'no';
  if (metric === 'totalBoarded') return context.totalBoarded;
  if (metric === 'topPlayer') return context.topPlayer || '';
  return '';
}

function predictionMatches_(event, answer, correct) {
  if (event.answerFormat === 'range') {
    const range = findPredictionRange_(event, answer);
    const numericCorrect = Number(correct);
    if (range && isFinite(numericCorrect)) {
      const min = Number(range.min !== undefined ? range.min : (range.from !== undefined ? range.from : (range.lower !== undefined ? range.lower : -Infinity)));
      const max = Number(range.max !== undefined ? range.max : (range.to !== undefined ? range.to : (range.upper !== undefined ? range.upper : Infinity)));
      return numericCorrect >= min && numericCorrect <= max;
    }
  }
  return String(answer).toLowerCase() === String(correct).toLowerCase();
}

function getPredictionOptions_(event) {
  return event.options || event.choices || event.ranges || [];
}

function findPredictionRange_(event, answer) {
  const target = String(answer);
  return getPredictionOptions_(event).find(function(option, index) {
    const value = option.value !== undefined ? option.value : String(index);
    return String(value) === target || String(option.label || '') === target;
  });
}

function applyStageSkills_(room, result) {
  const active = Object.keys(result.players).map(function(uuid) { return result.players[uuid]; }).filter(function(item) {
    return item.ticket && !item.ticket.abstained;
  });
  if (active.length <= 1) return;
  const scores = active.map(prop_('score'));
  const min = Math.min.apply(null, scores);
  const max = Math.max.apply(null, scores);
  const standardized = {};
  active.forEach(function(item) {
    standardized[item.uuid] = min === max ? 55 : 10 + ((item.score - min) / (max - min)) * 90;
  });
  const averageStandardized = active.reduce(function(sum, item) { return sum + standardized[item.uuid]; }, 0) / active.length;
  const denominator = result.params.N * result.params.X / active.length;
  active.forEach(function(item) {
    const stageSkill = round_(Math.max(0, (denominator > 0 ? (item.actualRise / denominator) * 60 : 0) + (averageStandardized > 0 ? (standardized[item.uuid] / averageStandardized) * 40 : 0)));
    item.stageSkill = stageSkill;
    const player = room.players.find(function(entry) { return entry.uuid === item.uuid; });
    if (player) {
      player.stageSkillHistory = player.stageSkillHistory || [];
      player.stageSkillHistory.push(stageSkill);
      player.skill = currentSkill_(player.stageSkillHistory);
    }
  });
}

function currentSkill_(history) {
  const sorted = (history || []).slice().sort(function(a, b) { return b - a; });
  while (sorted.length < 5) sorted.push(0);
  return round_(sorted.slice(1, 5).reduce(function(sum, value) { return sum + value; }, 0));
}

function calculateRiseFromIntervals_(intervals) {
  return (intervals || []).reduce(function(sum, interval) {
    return sum + (interval.sameFloor ? 1 : Math.max(0, Number(interval.to) - Number(interval.from)));
  }, 0);
}

function recalculate_(room) {
  room.scores = {};
  room.players.forEach(function(player) {
    player.stageSkillHistory = [];
    player.skill = 0;
    room.scores[player.uuid] = 0;
  });
  room.config.stages.forEach(function(stage) {
    if (room.stageResults[stage.stageId]) {
      const result = calculateStage_(stage, room.players, room.tickets[stage.stageId] || {});
      room.stageResults[stage.stageId] = result;
      Object.keys(result.players).forEach(function(uuid) {
        room.scores[uuid] = round_(Number(room.scores[uuid] || 0) + result.players[uuid].score);
      });
      applyStageSkills_(room, result);
    }
  });
  touchRoom_(room);
  return { ok: true, room };
}

function importConfig_(config) {
  return { ok: true, room: createInitialRoom_(config) };
}

function authHost_(password) {
  return { ok: password === getConfigValue_('hostPassword', 'host') };
}

function publicRoom_(room, uuid) {
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    room,
    me: uuid ? room.players.find(function(player) { return player.uuid === uuid; }) || null : null,
  };
}

function getHistoryGames_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.gameHistory);
  return { ok: true, games: rowsAsObjects_(sheet) };
}

function getPlayerHistory_(targetUuid, requesterUuid) {
  if (targetUuid !== requesterUuid) return error_('forbidden', '自分自身の戦歴のみ取得できます。', 403);
  const rows = rowsAsObjects_(SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.stageResults))
    .filter(function(row) { return row.uuid === targetUuid; });
  return { ok: true, stages: rows };
}

function getCurrentStage_(room) {
  return room.config.stages[Math.min(room.currentStageIndex || 0, room.config.stages.length - 1)];
}

function getRoom_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.currentGame);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (values[i][0] === 'state') return JSON.parse(values[i][1]);
  }
  return null;
}

function saveRoom_(room) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.currentGame);
  const json = JSON.stringify(room);
  if (sheet.getLastRow() < 2) sheet.appendRow(['state', json, new Date().toISOString()]);
  else sheet.getRange(2, 1, 1, 3).setValues([['state', json, new Date().toISOString()]]);
}

function syncPlayersSheet_(room) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.players);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  if (!room.players.length) return;
  sheet.getRange(2, 1, room.players.length, 5).setValues(room.players.map(function(player) {
    return [player.uuid, player.name, player.skill || 0, JSON.stringify(player.stageSkillHistory || []), new Date().toISOString()];
  }));
}

function persistGameHistory_(room) {
  const history = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.gameHistory);
  const existing = rowsAsObjects_(history).some(function(row) { return row.gameId === room.gameId; });
  if (!existing) {
    history.appendRow([room.gameId, JSON.stringify({ rankings: rankCumulative_(room), finishedAt: new Date().toISOString() }), new Date().toISOString()]);
  }
  const saveData = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.saveData);
  const stageResults = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.stageResults);
  room.players.forEach(function(player) {
    saveData.appendRow([player.uuid, room.gameId, player.name, JSON.stringify({ score: room.scores[player.uuid] || 0, skill: player.skill || 0 }), new Date().toISOString()]);
  });
  Object.keys(room.stageResults).forEach(function(stageId) {
    const result = room.stageResults[stageId];
    Object.keys(result.players).forEach(function(uuid) {
      stageResults.appendRow([uuid, room.gameId, stageId, JSON.stringify(result.players[uuid]), new Date().toISOString()]);
    });
  });
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  return sheet;
}

function rowsAsObjects_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values.map(function(row) {
    const object = {};
    headers.forEach(function(header, index) { object[header] = row[index]; });
    return object;
  });
}

function getConfigValue_(key, fallback) {
  const config = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.config);
  const rows = rowsAsObjects_(config);
  const row = rows.find(function(item) { return item.key === key; });
  return row ? row.value : fallback;
}

function normalizePath_(e) {
  const path = e && e.pathInfo ? '/' + e.pathInfo : (e && e.parameter && e.parameter.path ? e.parameter.path : '/api/room/state');
  return path.charAt(0) === '/' ? path : '/' + path;
}

function parsePayload_(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      return {};
    }
  }
  return e && e.parameter ? Object.assign({}, e.parameter) : {};
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function error_(code, message, status) {
  return { ok: false, code, message, status: status || 400 };
}

function touchRoom_(room) {
  room.updatedAt = new Date().toISOString();
}

function addOperation_(room, actor, action) {
  room.operations.unshift({ at: new Date().toISOString(), actor: actor || 'host', action });
  room.operations = room.operations.slice(0, 100);
}

function applyPendingNames_(room) {
  room.players.forEach(function(player) {
    if (player.pendingName) {
      player.name = player.pendingName;
      player.pendingName = null;
    }
  });
}

function rankResults_(results) {
  return results.map(function(item) {
    return { uuid: item.uuid, name: item.name, score: item.score, status: item.status };
  }).sort(function(a, b) {
    return b.score - a.score || String(a.name).localeCompare(String(b.name), 'ja');
  }).map(withRank_);
}

function rankCumulative_(room) {
  return room.players.map(function(player) {
    return { uuid: player.uuid, name: player.name, score: room.scores[player.uuid] || 0, skill: player.skill || 0 };
  }).sort(function(a, b) {
    return b.score - a.score || String(a.name).localeCompare(String(b.name), 'ja');
  }).map(withRank_);
}

function withRank_(item, index, array) {
  const previous = array[index - 1];
  item.rank = previous && previous.score === item.score ? previous.rank : index + 1;
  return item;
}

function routeTouchesZone_(ticket, event) {
  if (!ticket) return false;
  for (let floor = ticket.boardFloor; floor <= ticket.exitFloor; floor += 1) {
    if (inRange_(floor, event.fromFloor, event.toFloor)) return true;
  }
  return false;
}

function inRange_(value, from, to) {
  return Number(value) >= Math.min(Number(from), Number(to)) && Number(value) <= Math.max(Number(from), Number(to));
}

function clamp_(value, min, max, fallback) {
  if (!isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function round_(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function prop_(key) {
  return function(object) {
    return object[key];
  };
}

function uniqueGameId_(title) {
  return String(title || 'game').trim().replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0, 10);
}
