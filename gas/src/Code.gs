const EVG_SHEETS = {
  config: 'config',
  saveData: 'save_data',
  stageResults: 'stage_results',
  players: 'players',
  currentGame: 'current_game',
  stageSettings: 'stage_settings',
  gameHistory: 'game_history',
  gameConfigs: 'game_configs',
};

const EVG_CURRENT_GAME_CHUNK_SIZE = 45000;
const EVG_ROOM_CACHE_KEY = 'evg-current-room-json';
const EVG_HOST_TOKEN_PREFIX = 'host-token:';
const EVG_DEFAULT_HOST_SESSION_MINUTES = 240;
const EVG_DEPLOYMENT_ID = 'AKfycbyDZPVfLF2c3fswxmq3pVVmmTanMB-m7p3kwA3vuWJdX8gm7BtnunKqj-Z6g7HsAygO';
const EVG_DEPLOYED_WEB_APP_URL = 'https://script.google.com/macros/s/' + EVG_DEPLOYMENT_ID + '/exec';

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
          metric: 'forcedOffCount',
          scoreOnCorrect: 30,
          scoreOnWrong: 0,
          scoreOnNoAnswer: -5,
        },
        { type: 'E2_forbidden', fromFloor: 4, toFloor: 4 },
        { type: 'E3a_zone_multiplier', fromFloor: 7, toFloor: 10, multiplier: 2 },
      ],
    },
    {
      stageId: 'stage-002',
      name: 'ステージ2',
      params: { N: 14, X: 4, P: 8, Q: 3 },
      events: [
        {
          type: 'E1_prediction',
          question: '全員が乗車成功する？',
          answerFormat: 'yesno',
          metric: 'allSucceeded',
          scoreOnCorrect: 25,
          scoreOnWrong: 0,
          scoreOnNoAnswer: -5,
        },
        {
          type: 'E1_prediction',
          question: '乗車成功者数は？',
          answerFormat: 'range',
          metric: 'totalBoarded',
          ranges: [
            { value: 'low', label: '0〜2人', min: 0, max: 2 },
            { value: 'mid', label: '3〜4人', min: 3, max: 4 },
            { value: 'high', label: '5人以上', min: 5 },
          ],
          scoreOnCorrect: 20,
          scoreOnWrong: 0,
          scoreOnNoAnswer: -5,
        },
        { type: 'E4_special_floor', floor: 8, bonus: 25 },
        { type: 'E5_occupancy_multiplier', threshold: 3, multiplier: 1.5 },
      ],
    },
    {
      stageId: 'stage-003',
      name: 'ステージ3',
      params: { N: 20, X: 5, P: 7, Q: 2 },
      events: [
        {
          type: 'E1_prediction',
          question: 'このステージの最高得点者は？',
          answerFormat: 'player',
          metric: 'topPlayer',
          scoreOnCorrect: 30,
          scoreOnWrong: 0,
          scoreOnNoAnswer: -5,
        },
        { type: 'E3b_score_multiplier', fromFloor: 12, toFloor: 20, multiplier: 1.8 },
        { type: 'E6_view_bonus', bonusPerExitFloor: 2 },
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
  ensureSheet_(ss, EVG_SHEETS.stageResults, ['uuid', 'gameId', 'stageId', 'stageSkill', 'score', 'status', 'resultJson', 'createdAt']);
  ensureSheet_(ss, EVG_SHEETS.players, ['uuid', 'name', 'skill', 'stageSkillHistoryJson', 'updatedAt']);
  ensureSheet_(ss, EVG_SHEETS.currentGame, ['key', 'chunkIndex', 'json', 'updatedAt']);
  ensureSheet_(ss, EVG_SHEETS.stageSettings, ['gameId', 'stageId', 'stageJson', 'createdAt']);
  ensureSheet_(ss, EVG_SHEETS.gameHistory, ['gameId', 'summaryJson', 'createdAt']);
  ensureSheet_(ss, EVG_SHEETS.gameConfigs, ['configId', 'name', 'status', 'sortOrder', 'configJson', 'notes', 'createdAt', 'updatedAt']);
  ensureConfigDefaults_(ss.getSheetByName(EVG_SHEETS.config));
  ensureGameConfigDefaults_(ss.getSheetByName(EVG_SHEETS.gameConfigs));
  if (!getRoom_()) {
    saveRoom_(createInitialRoom_(EVG_DEFAULT_CONFIG));
  }
}

function ensureRuntimeReady_() {
  const ss = SpreadsheetApp.getActive();
  const missing = Object.keys(EVG_SHEETS).map(function(key) { return EVG_SHEETS[key]; })
    .filter(function(sheetName) { return !ss.getSheetByName(sheetName); });
  if (missing.length) {
    return error_('setup_required', 'setupElevatorGameSheets()を先に実行してください: ' + missing.join(', '), 500);
  }
  return { ok: true };
}

function logRequest_(startedAt, path, method, payload, response) {
  const durationMs = Date.now() - startedAt.getTime();
  const log = {
    at: startedAt.toISOString(),
    durationMs: durationMs,
    path: path,
    method: method,
    role: payload && payload.role ? payload.role : '',
    uuid: payload && payload.uuid ? payload.uuid : '',
    ok: response ? response.ok !== false : false,
    error: response && response.ok === false ? (response.code || response.error || response.message || '') : '',
  };
  console.log(JSON.stringify(log));
}

function route_(e, method) {
  const startedAt = new Date();
  const path = normalizePath_(e);
  const payload = parsePayload_(e);
  let response = null;
  try {
    const runtime = ensureRuntimeReady_();
    if (!runtime.ok) {
      response = runtime;
      return json_(response);
    }
    const apiAuth = verifyApiKey_(payload);
    if (!apiAuth.ok) {
      response = apiAuth;
      return json_(response);
    }
    if (method === 'GET' && path === '/api/time') response = { serverTime: new Date().toISOString() };
    else if (method === 'GET' && path === '/api/status') response = publicStatus_(getRoom_() || createInitialRoom_(EVG_DEFAULT_CONFIG), payload);
    else if (method === 'GET' && (path === '/api/room/state' || path === '/api/screen/state')) response = publicRoom_(getRoom_() || createInitialRoom_(EVG_DEFAULT_CONFIG), payload);
    else if (method === 'GET' && path === '/api/host/game-configs') response = listGameConfigs_(payload);
    else if (method === 'GET' && path === '/api/history/games') response = getHistoryGames_();
    else if (method === 'GET' && path.indexOf('/api/history/player/') === 0) response = getPlayerHistory_(path.split('/').pop(), payload.uuid);
    else if (method === 'POST') response = mutateRoute_(path, payload);
    else response = error_('not_found', 'Unknown endpoint: ' + path, 404);
    return json_(response);
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    response = error_('server_error', String(err), 500);
    return json_(response);
  } finally {
    logRequest_(startedAt, path, method, payload, response);
  }
}

function mutateRoute_(path, payload) {
  if (path === '/api/host/auth') return authHost_(payload.password);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let room = getRoom_() || createInitialRoom_(EVG_DEFAULT_CONFIG);
    let result;
    if (path === '/api/player/join') result = registerPlayer_(room, payload.name, payload.uuid);
    else if (path === '/api/player/restore') result = restorePlayer_(room, payload.uuid);
    else if (path === '/api/player/rename') result = renamePlayer_(room, payload.uuid, payload.name);
    else if (path === '/api/player/proceed-next') result = acknowledgePlayerNext_(room, payload.uuid);
    else if (path === '/api/ticket/submit') result = submitTicket_(room, payload.uuid, payload.ticket || payload);
    else if (path === '/api/ticket/abstain') result = abstain_(room, payload.uuid);
    else if (path.indexOf('/api/host/') === 0) {
      const hostAuth = verifyHostToken_(payload.hostToken);
      if (!hostAuth.ok) return hostAuth;
      if (path === '/api/host/start-stage') result = advancePhase_(room, 'start-stage', payload.hostName || 'host');
      else if (path === '/api/host/open-voting') result = advancePhase_(room, 'open-voting', payload.hostName || 'host');
      else if (path === '/api/host/close-voting') result = advancePhase_(room, 'close-voting', payload.hostName || 'host');
      else if (path === '/api/host/reveal-result') result = tallyCurrentStage_(room, payload.hostName || 'host');
      else if (path === '/api/host/commit-result') result = commitHostResult_(room, payload.room, payload.baseVersion, payload.hostName || 'host');
      else if (path === '/api/host/show-ranking') result = advancePhase_(room, 'show-ranking', payload.hostName || 'host');
      else if (path === '/api/host/skip-animation') result = advancePhase_(room, 'skip-animation', payload.hostName || 'host');
      else if (path === '/api/host/advance') result = advancePhase_(room, 'next-stage', payload.hostName || 'host');
      else if (path === '/api/host/recalculate') result = recalculate_(room);
      else if (path === '/api/host/import-config') result = importConfig_(room, payload.config, payload.preservePlayers !== false);
      else if (path === '/api/host/start-game-config') result = startGameConfig_(room, payload.configId);
      else if (path === '/api/host/update-config') result = updateConfig_(room, payload.config);
      else return error_('not_found', 'Unknown endpoint: ' + path, 404);
    }
    else return error_('not_found', 'Unknown endpoint: ' + path, 404);
    if (result && result.room) {
      saveRoom_(result.room);
      syncPlayersSheet_(result.room);
      syncStageSettingsSheet_(result.room);
      if (result.room.phase === EVG_PHASES.FINAL) persistGameHistory_(result.room);
    }
    return Object.assign({}, result, { room: result && result.room ? publicRoom_(result.room, payload) : undefined });
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
    completedGames: [],
    operations: [],
    countdownEndsAt: null,
    tallyingEndsAt: null,
    animationStartedAt: null,
    animationSkippedAt: null,
    roomVersion: 0,
    volume: 0.8,
    muted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createNextGameRoom_(room, config) {
  const next = createInitialRoom_(config);
  const archived = archiveCurrentGame_(room);
  next.completedGames = archived ? (room.completedGames || []).concat([archived]) : clone_(room.completedGames || []);
  next.players = (room.players || []).map(function(player) {
    return {
      uuid: player.uuid,
      name: player.pendingName || player.name,
      joinedAt: player.joinedAt || new Date().toISOString(),
      connected: player.connected !== false,
      lastSeenAt: new Date().toISOString(),
      skill: Number(player.skill || 0),
      stageSkillHistory: clone_(player.stageSkillHistory || []),
      pendingName: null,
    };
  });
  next.players.forEach(function(player) {
    next.scores[player.uuid] = 0;
  });
  next.volume = room.volume !== undefined ? room.volume : next.volume;
  next.muted = Boolean(room.muted);
  addOperation_(next, 'host', 'next-game');
  touchRoom_(next);
  return next;
}

function archiveCurrentGame_(room) {
  if (!room || !room.stageResults || Object.keys(room.stageResults).length === 0) return null;
  if ((room.completedGames || []).some(function(game) { return game.gameId === room.gameId; })) return null;
  return {
    gameId: room.gameId,
    title: room.config && room.config.gameMeta ? room.config.gameMeta.title : 'game',
    finishedAt: new Date().toISOString(),
    scores: clone_(room.scores || {}),
    rankings: rankCumulative_(room),
    stageResults: clone_(room.stageResults || {}),
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
    const saved = uuid ? findSavedPlayer_(uuid) : null;
    player = {
      uuid: uuid || createUuid_(),
      name: cleanName,
      joinedAt: saved && saved.joinedAt ? saved.joinedAt : new Date().toISOString(),
      connected: true,
      lastSeenAt: new Date().toISOString(),
      skill: saved ? Number(saved.skill || 0) : 0,
      stageSkillHistory: saved ? clone_(saved.stageSkillHistory || []) : [],
    };
    room.players.push(player);
    room.scores[player.uuid] = room.scores[player.uuid] || 0;
  }
  touchRoom_(room);
  return { ok: true, room, player };
}

function restorePlayer_(room, uuid) {
  let player = room.players.find(function(item) { return item.uuid === uuid; });
  if (!player) {
    const saved = findSavedPlayer_(uuid);
    if (!saved) return error_('not_found', 'UUIDが見つかりません。', 404);
    player = {
      uuid: saved.uuid,
      name: saved.name,
      joinedAt: saved.joinedAt || new Date().toISOString(),
      connected: true,
      lastSeenAt: new Date().toISOString(),
      skill: Number(saved.skill || 0),
      stageSkillHistory: clone_(saved.stageSkillHistory || []),
      pendingName: null,
    };
    room.players.push(player);
    room.scores[player.uuid] = room.scores[player.uuid] || 0;
  }
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
  if (!canSubmitTicket_(room)) {
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
  if (!canSubmitTicket_(room)) {
    return error_('phase', '現在は棄権を受け付けていません。', 409);
  }
  if (!room.players.some(function(player) { return player.uuid === uuid; })) {
    return error_('not_joined', '参加登録が必要です。', 403);
  }
  room.tickets[stage.stageId] = room.tickets[stage.stageId] || {};
  room.tickets[stage.stageId][uuid] = { uuid, abstained: true, predictions: {}, submittedAt: new Date().toISOString() };
  touchRoom_(room);
  return { ok: true, room };
}

function acknowledgePlayerNext_(room, uuid) {
  const player = room.players.find(function(item) { return item.uuid === uuid; });
  if (!player) return error_('not_joined', '参加登録が必要です。', 403);
  player.lastSeenAt = new Date().toISOString();
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

function canSubmitTicket_(room) {
  if (room.phase === EVG_PHASES.VOTING) return true;
  if (room.phase !== EVG_PHASES.COUNTDOWN) return false;
  if (!room.countdownEndsAt) return false;
  return Date.now() <= new Date(room.countdownEndsAt).getTime();
}

function advancePhase_(room, action, actor) {
  if (action === 'start-stage') {
    if (room.phase !== EVG_PHASES.LOBBY) return error_('phase', '現在はステージ説明へ進めません。', 409);
    room.phase = EVG_PHASES.STAGE_INTRO;
    applyPendingNames_(room);
  } else if (action === 'open-voting') {
    if (room.phase !== EVG_PHASES.STAGE_INTRO) return error_('phase', '現在は受付を開始できません。', 409);
    room.phase = EVG_PHASES.VOTING;
  }
  else if (action === 'close-voting') {
    if (room.phase !== EVG_PHASES.VOTING) return error_('phase', '現在は締切できません。', 409);
    room.phase = EVG_PHASES.COUNTDOWN;
    room.countdownEndsAt = new Date(Date.now() + 15000).toISOString();
    room.tallyingEndsAt = new Date(Date.now() + 18000).toISOString();
  } else if (action === 'show-ranking') {
    if (room.phase !== EVG_PHASES.REVEAL) return error_('phase', '現在は順位発表へ進めません。', 409);
    room.phase = EVG_PHASES.RANKING;
  } else if (action === 'skip-animation') {
    if (room.phase !== EVG_PHASES.REVEAL) return error_('phase', '現在はスキップできません。', 409);
    room.animationSkippedAt = new Date().toISOString();
    room.phase = EVG_PHASES.RANKING;
  } else if (action === 'next-stage') {
    if (room.phase !== EVG_PHASES.RANKING) return error_('phase', '現在は次へ進めません。', 409);
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
  if (!stage) return error_('stage_missing', 'ステージがありません。', 400);
  if ([EVG_PHASES.COUNTDOWN, EVG_PHASES.TALLYING].indexOf(room.phase) < 0) {
    return error_('phase', '現在は集計できません。', 409);
  }
  if (room.stageResults && room.stageResults[stage.stageId]) {
    return error_('already_tallied', 'このステージはすでに集計済みです。', 409);
  }
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

function commitHostResult_(room, nextRoom, baseVersion, actor) {
  if (!nextRoom || typeof nextRoom !== 'object') return error_('bad_request', '保存する結果がありません。', 400);
  const stage = getCurrentStage_(room);
  const nextStage = getCurrentStage_(nextRoom);
  if (!stage || !nextStage || stage.stageId !== nextStage.stageId) return error_('stage_mismatch', 'ステージが一致しません。', 409);
  if ([EVG_PHASES.COUNTDOWN, EVG_PHASES.TALLYING].indexOf(room.phase) < 0) return error_('phase', '現在は集計できません。', 409);
  if (room.stageResults && room.stageResults[stage.stageId]) return error_('already_tallied', 'このステージはすでに集計済みです。', 409);
  if (baseVersion !== undefined && String(baseVersion) !== String(room.roomVersion || 0)) return error_('version_conflict', 'ルーム状態が更新されています。再読み込みしてください。', 409);
  if (nextRoom.phase !== EVG_PHASES.REVEAL || !nextRoom.stageResults || !nextRoom.stageResults[stage.stageId]) {
    return error_('bad_result', '結果発表状態のルームを送信してください。', 400);
  }
  nextRoom.roomId = room.roomId;
  nextRoom.gameId = room.gameId;
  nextRoom.config = room.config;
  nextRoom.players = room.players;
  nextRoom.tickets = room.tickets;
  nextRoom.completedGames = room.completedGames || [];
  nextRoom.operations = room.operations || [];
  addOperation_(nextRoom, actor, 'commit-result');
  touchRoom_(nextRoom);
  return { ok: true, room: nextRoom, result: nextRoom.stageResults[stage.stageId] };
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
  const metric = event.metric || event.answerMetric;
  if (metric === 'forcedOffCount') return context.forcedOffCount;
  if (metric === 'allSucceeded') return context.allSucceeded ? 'yes' : 'no';
  if (metric === 'totalBoarded') return context.totalBoarded;
  if (metric === 'topPlayer') return context.topPlayer || '';
  if (event.correctAnswer !== undefined) return event.correctAnswer;
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

function importConfig_(room, config, preservePlayers) {
  return { ok: true, room: preservePlayers && room.players && room.players.length ? createNextGameRoom_(room, config) : createInitialRoom_(config) };
}

function listGameConfigs_(payload) {
  const hostAuth = verifyHostToken_(payload.hostToken);
  if (!hostAuth.ok) return hostAuth;
  const configs = readActiveGameConfigs_().map(function(item) {
    return {
      configId: item.configId,
      name: item.name,
      status: item.status,
      sortOrder: item.sortOrder,
      notes: item.notes,
      updatedAt: item.updatedAt,
      valid: item.valid,
      error: item.error || '',
      stageCount: item.config ? item.config.stages.length : 0,
      stageNames: item.config ? item.config.stages.map(function(stage) { return stage.name; }) : [],
      title: item.config && item.config.gameMeta ? item.config.gameMeta.title : item.name,
    };
  });
  return { ok: true, serverTime: new Date().toISOString(), configs };
}

function startGameConfig_(room, configId) {
  if (room.phase !== EVG_PHASES.FINAL) return error_('phase', '最終結果後に次ゲームを開始してください。', 409);
  const item = findActiveGameConfig_(configId);
  if (!item) return error_('not_found', '次ゲーム設定が見つかりません。', 404);
  if (!item.valid) return error_('validation', '次ゲーム設定JSONを読み込めません: ' + item.error, 400);
  if (Object.keys(room.stageResults || {}).length) persistGameHistory_(room);
  return { ok: true, room: createNextGameRoom_(room, item.config), gameConfig: { configId: item.configId, name: item.name } };
}

function updateConfig_(room, config) {
  room.config = normalizeConfig_(config);
  touchRoom_(room);
  return { ok: true, room };
}

function authHost_(password) {
  if (String(password || '').trim() !== String(getConfigValue_('hostPassword', 'host')).trim()) return error_('auth', 'パスワードが違います。', 403);
  const issued = issueHostToken_();
  return { ok: true, hostToken: issued.token, expiresAt: issued.expiresAt, serverTime: new Date().toISOString() };
}

function publicRoom_(room, payload) {
  payload = payload || {};
  const uuid = payload.uuid || '';
  const role = payload.role || '';
  const hostAuthed = role === 'host' && verifyHostToken_(payload.hostToken).ok;
  const publicRoom = hostAuthed ? clone_(room) : sanitizeRoomForRole_(room, role, uuid);
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    room: publicRoom,
    me: uuid ? (room.players.find(function(player) { return player.uuid === uuid; }) || null) : null,
  };
}

function publicStatus_(room, payload) {
  payload = payload || {};
  const summary = compactRoomStatus_(room);
  const sameVersion = String(payload.sinceVersion || '') === String(room.roomVersion || 0);
  const sameGame = !payload.sinceGameId || String(payload.sinceGameId || '') === String(room.gameId || '');
  if (sameVersion && sameGame) {
    return { ok: true, unchanged: true, serverTime: new Date().toISOString(), status: summary };
  }
  return Object.assign(publicRoom_(room, payload), { status: summary });
}

function compactRoomStatus_(room) {
  const stage = getCurrentStage_(room);
  const stageId = stage ? stage.stageId : '';
  const tickets = stageId && room.tickets && room.tickets[stageId] ? room.tickets[stageId] : {};
  const submitted = Object.keys(tickets).filter(function(uuid) { return tickets[uuid] && !tickets[uuid].abstained; }).length;
  const abstained = Object.keys(tickets).filter(function(uuid) { return tickets[uuid] && tickets[uuid].abstained; }).length;
  return {
    gameId: room.gameId || '',
    roomVersion: Number(room.roomVersion || 0),
    phase: room.phase,
    currentStageIndex: room.currentStageIndex || 0,
    stageId: stageId,
    playerCount: (room.players || []).length,
    ticketCount: submitted,
    abstainCount: abstained,
    countdownEndsAt: room.countdownEndsAt || null,
    tallyingEndsAt: room.tallyingEndsAt || null,
    animationStartedAt: room.animationStartedAt || null,
    animationSkippedAt: room.animationSkippedAt || null,
  };
}

function getHistoryGames_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.gameHistory);
  const games = rowsAsObjects_(sheet).map(function(row) {
    const summary = parseJson_(row.summaryJson, {});
    return Object.assign({ gameId: row.gameId, createdAt: row.createdAt }, summary);
  });
  return { ok: true, games, players: getPublicPlayers_() };
}

function getPlayerHistory_(targetUuid, requesterUuid) {
  if (targetUuid !== requesterUuid) return error_('forbidden', '自分自身の戦歴のみ取得できます。', 403);
  const ss = SpreadsheetApp.getActive();
  const saves = rowsAsObjects_(ss.getSheetByName(EVG_SHEETS.saveData))
    .filter(function(row) { return row.uuid === targetUuid; })
    .map(function(row) { return Object.assign({}, row, { summary: parseJson_(row.summaryJson, {}) }); });
  const stages = rowsAsObjects_(ss.getSheetByName(EVG_SHEETS.stageResults))
    .filter(function(row) { return row.uuid === targetUuid; })
    .map(function(row) { return Object.assign({}, row, { result: parseJson_(row.resultJson, {}) }); });
  return { ok: true, games: saves, stages, summary: aggregatePlayerHistory_(targetUuid, saves, stages) };
}

function getCurrentStage_(room) {
  return room.config.stages[Math.min(room.currentStageIndex || 0, room.config.stages.length - 1)];
}

function getRoom_() {
  try {
    const cached = CacheService.getScriptCache().get(EVG_ROOM_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (err) {
    console.warn('room cache read failed: ' + err);
  }
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.currentGame);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const values = sheet.getDataRange().getValues();
  const chunks = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i][0] === 'state' && String(values[i][1] || '').charAt(0) === '{') {
      const legacyRoom = JSON.parse(values[i][1]);
      cacheRoom_(legacyRoom);
      return legacyRoom;
    }
    if (values[i][0] === 'state') chunks.push({ index: Number(values[i][1] || 0), json: values[i][2] || '' });
  }
  if (chunks.length) {
    chunks.sort(function(a, b) { return a.index - b.index; });
    const room = JSON.parse(chunks.map(function(chunk) { return chunk.json; }).join(''));
    cacheRoom_(room);
    return room;
  }
  return null;
}

function saveRoom_(room) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.currentGame);
  const json = JSON.stringify(room);
  const chunks = chunkString_(json, EVG_CURRENT_GAME_CHUNK_SIZE);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  sheet.getRange(2, 1, chunks.length, 4).setValues(chunks.map(function(chunk, index) {
    return ['state', index, chunk, new Date().toISOString()];
  }));
  cacheRoom_(room);
}

function cacheRoom_(room) {
  try {
    const json = JSON.stringify(room);
    if (json.length < 95000) CacheService.getScriptCache().put(EVG_ROOM_CACHE_KEY, json, 30);
  } catch (err) {
    console.warn('room cache write failed: ' + err);
  }
}

function syncPlayersSheet_(room) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.players);
  const byUuid = {};
  rowsAsObjects_(sheet).forEach(function(row) {
    if (row.uuid) byUuid[row.uuid] = {
      uuid: row.uuid,
      name: row.name,
      skill: Number(row.skill || 0),
      stageSkillHistory: parseJson_(row.stageSkillHistoryJson, []),
      updatedAt: row.updatedAt,
    };
  });
  (room.players || []).forEach(function(player) {
    byUuid[player.uuid] = {
      uuid: player.uuid,
      name: player.name,
      skill: Number(player.skill || 0),
      stageSkillHistory: clone_(player.stageSkillHistory || []),
      updatedAt: new Date().toISOString(),
    };
  });
  const rows = Object.keys(byUuid).sort().map(function(uuid) {
    const player = byUuid[uuid];
    return [player.uuid, player.name, player.skill || 0, JSON.stringify(player.stageSkillHistory || []), player.updatedAt || new Date().toISOString()];
  });
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);
}

function syncStageSettingsSheet_(room) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.stageSettings);
  const existing = rowsAsObjects_(sheet).filter(function(row) { return row.gameId !== room.gameId; });
  const rows = existing.map(function(row) { return [row.gameId, row.stageId, row.stageJson, row.createdAt]; });
  (room.config.stages || []).forEach(function(stage) {
    rows.push([room.gameId, stage.stageId, JSON.stringify(stage), new Date().toISOString()]);
  });
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 4).setValues(rows);
}

function persistGameHistory_(room) {
  const history = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.gameHistory);
  const existing = rowsAsObjects_(history).some(function(row) { return row.gameId === room.gameId; });
  if (!existing) {
    history.appendRow([room.gameId, JSON.stringify(buildGameSummary_(room)), new Date().toISOString()]);
  }
  const saveData = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.saveData);
  const stageResults = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.stageResults);
  room.players.forEach(function(player) {
    if (!saveDataRowExists_(player.uuid, room.gameId)) {
      saveData.appendRow([player.uuid, room.gameId, player.name, JSON.stringify(buildPlayerGameSummary_(room, player)), new Date().toISOString()]);
    }
  });
  Object.keys(room.stageResults).forEach(function(stageId) {
    const result = room.stageResults[stageId];
    Object.keys(result.players).forEach(function(uuid) {
      if (!stageResultRowExists_(uuid, room.gameId, stageId)) {
        const playerResult = result.players[uuid];
        stageResults.appendRow([
          uuid,
          room.gameId,
          stageId,
          playerResult.stageSkill === null || playerResult.stageSkill === undefined ? '' : playerResult.stageSkill,
          playerResult.score || 0,
          playerResult.status || '',
          JSON.stringify(playerResult),
          new Date().toISOString(),
        ]);
      }
    });
  });
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  const width = Math.max(sheet.getLastColumn(), headers.length);
  const currentHeaders = sheet.getRange(1, 1, 1, width).getValues()[0];
  headers.forEach(function(header, index) {
    if (currentHeaders[index] !== header) sheet.getRange(1, index + 1).setValue(header);
  });
  return sheet;
}

function ensureConfigDefaults_(sheet) {
  const defaults = {
    apiKey: EVG_DEPLOYMENT_ID,
    hostPassword: 'host',
    hostSessionMinutes: String(EVG_DEFAULT_HOST_SESSION_MINUTES),
    pollCacheSeconds: '2',
    webAppUrl: EVG_DEPLOYED_WEB_APP_URL,
  };
  const rows = rowsAsObjects_(sheet);
  Object.keys(defaults).forEach(function(key) {
    if (!rows.some(function(row) { return row.key === key; })) sheet.appendRow([key, defaults[key]]);
  });
  const apiKeyRow = rows.find(function(row) { return row.key === 'apiKey'; });
  if (apiKeyRow && !apiKeyRow.value) {
    setConfigValue_('apiKey', defaults.apiKey);
  } else if (apiKeyRow && String(apiKeyRow.value).indexOf('evg-') === 0) {
    setConfigValue_('apiKey', defaults.apiKey);
  }
}

function ensureGameConfigDefaults_(sheet) {
  const rows = rowsAsObjects_(sheet);
  if (rows.some(function(row) { return row.configId; })) return;
  const now = new Date().toISOString();
  sheet.appendRow([
    'default-party',
    '短時間パーティ版',
    'ACTIVE',
    1,
    JSON.stringify(EVG_DEFAULT_CONFIG),
    '初期サンプル。不要ならstatusをARCHIVEDに変更してください。',
    now,
    now,
  ]);
}

function readActiveGameConfigs_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.gameConfigs);
  return rowsAsObjects_(sheet)
    .filter(function(row) { return row.configId && String(row.status || 'ACTIVE').toUpperCase() === 'ACTIVE'; })
    .map(normalizeGameConfigRow_)
    .sort(function(a, b) {
      return Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(a.name).localeCompare(String(b.name), 'ja');
    });
}

function findActiveGameConfig_(configId) {
  const target = String(configId || '').trim();
  if (!target) return null;
  return readActiveGameConfigs_().find(function(item) { return item.configId === target; }) || null;
}

function normalizeGameConfigRow_(row) {
  const item = {
    configId: String(row.configId || '').trim(),
    name: String(row.name || row.configId || '').trim(),
    status: String(row.status || 'ACTIVE').toUpperCase(),
    sortOrder: Number(row.sortOrder || 0),
    notes: String(row.notes || ''),
    updatedAt: row.updatedAt || row.createdAt || '',
    valid: false,
    config: null,
    error: '',
  };
  try {
    item.config = normalizeConfig_(JSON.parse(String(row.configJson || '')));
    item.valid = true;
    if (!item.name) item.name = item.config.gameMeta.title;
  } catch (err) {
    item.error = String(err && err.message ? err.message : err);
  }
  return item;
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

function verifyApiKey_(payload) {
  return verifyApiKeyValue_(payload, getConfigValue_('apiKey', ''));
}

function verifyApiKeyValue_(payload, configured) {
  if (String(payload.apiKey || '') === EVG_DEPLOYMENT_ID) return { ok: true };
  if (!configured) return { ok: true };
  if (String(payload.apiKey || '') === String(configured)) return { ok: true };
  return error_('auth', 'APIキーが一致しません。', 403);
}

function issueHostToken_() {
  const minutes = clamp_(Number(getConfigValue_('hostSessionMinutes', EVG_DEFAULT_HOST_SESSION_MINUTES)), 1, 1440, EVG_DEFAULT_HOST_SESSION_MINUTES);
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const token = EVG_HOST_TOKEN_PREFIX + createUuid_();
  CacheService.getScriptCache().put(token, expiresAt, Math.min(minutes * 60, 21600));
  return { token, expiresAt };
}

function verifyHostToken_(token) {
  if (!token) return error_('auth', 'ホスト認証が必要です。', 403);
  const cached = CacheService.getScriptCache().get(token);
  if (!cached) return error_('auth', 'ホスト認証の有効期限が切れました。', 403);
  if (new Date(cached).getTime() <= Date.now()) return error_('auth', 'ホスト認証の有効期限が切れました。', 403);
  return { ok: true, expiresAt: cached };
}

function storeHostTokenForTest_(token, expiresAt) {
  CacheService.getScriptCache().put(token, expiresAt, 60);
  return token;
}

function sanitizeRoomForRole_(room, role, uuid) {
  const copy = clone_(room);
  if (role !== 'screen') {
    copy.tickets = filterTicketsForPlayer_(copy.tickets || {}, uuid);
  }
  if (role === 'player' && uuid) {
    copy.players = (copy.players || []).map(function(player) {
      if (player.uuid === uuid) return player;
      return { uuid: player.uuid, name: player.name, connected: player.connected !== false, skill: player.skill || 0 };
    });
  }
  if (role === 'player' && !isCurrentRevealComplete_(copy)) {
    const stage = getCurrentStage_(copy);
    if (stage && copy.stageResults) delete copy.stageResults[stage.stageId];
  }
  return copy;
}

function filterTicketsForPlayer_(tickets, uuid) {
  const filtered = {};
  Object.keys(tickets || {}).forEach(function(stageId) {
    filtered[stageId] = {};
    if (uuid && tickets[stageId] && tickets[stageId][uuid]) filtered[stageId][uuid] = tickets[stageId][uuid];
  });
  return filtered;
}

function isCurrentRevealComplete_(room) {
  if (room.phase !== EVG_PHASES.REVEAL && room.phase !== EVG_PHASES.RANKING) return true;
  if (room.animationSkippedAt) return true;
  if (!room.animationStartedAt) return true;
  const stage = getCurrentStage_(room);
  if (!stage) return true;
  return Date.now() - new Date(room.animationStartedAt).getTime() >= getRevealDurationMs_(stage);
}

function getRevealDurationMs_(stage) {
  return Math.max(12, Number(stage.params.N || 0) * 1.6) * 1000;
}

function getPublicPlayers_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.players);
  return rowsAsObjects_(sheet).map(function(row) {
    return { uuid: row.uuid, name: row.name, skill: Number(row.skill || 0) };
  });
}

function findSavedPlayer_(uuid) {
  if (!uuid || typeof SpreadsheetApp === 'undefined') return null;
  const playersSheet = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.players);
  const playerRow = rowsAsObjects_(playersSheet).find(function(row) { return row.uuid === uuid; });
  if (playerRow) {
    return {
      uuid: playerRow.uuid,
      name: playerRow.name,
      skill: Number(playerRow.skill || 0),
      stageSkillHistory: parseJson_(playerRow.stageSkillHistoryJson, []),
    };
  }
  const stageRows = rowsAsObjects_(SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.stageResults))
    .filter(function(row) { return row.uuid === uuid && row.stageSkill !== ''; });
  const saveRows = rowsAsObjects_(SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.saveData))
    .filter(function(row) { return row.uuid === uuid; });
  if (!stageRows.length && !saveRows.length) return null;
  const history = stageRows.map(function(row) { return Number(row.stageSkill || 0); }).filter(function(value) { return value > 0; });
  const latestSave = saveRows[saveRows.length - 1] || {};
  return {
    uuid,
    name: latestSave.nameSnapshot || uuid,
    skill: currentSkill_(history),
    stageSkillHistory: history,
  };
}

function buildGameSummary_(room) {
  return {
    title: room.config && room.config.gameMeta ? room.config.gameMeta.title : room.gameId,
    rankings: rankCumulative_(room),
    scores: clone_(room.scores || {}),
    finishedAt: new Date().toISOString(),
    stageCount: Object.keys(room.stageResults || {}).length,
  };
}

function buildPlayerGameSummary_(room, player) {
  const stages = Object.keys(room.stageResults || {}).map(function(stageId) {
    return room.stageResults[stageId].players[player.uuid];
  }).filter(Boolean);
  const stageScores = stages.map(function(result) { return Number(result.score || 0); });
  const answeredPredictions = [];
  stages.forEach(function(result) {
    (result.predictionBreakdown || []).forEach(function(item) {
      if (!item.noAnswer) answeredPredictions.push(item);
    });
  });
  const ranking = rankCumulative_(room).find(function(row) { return row.uuid === player.uuid; }) || {};
  return {
    currentSkill: Number(player.skill || 0),
    averageSkill: average_(player.stageSkillHistory || []),
    totalSkill: round_((player.stageSkillHistory || []).reduce(function(sum, value) { return sum + Number(value || 0); }, 0)),
    totalScore: Number(room.scores[player.uuid] || 0),
    averageScore: average_(stageScores),
    bestScore: stageScores.length ? Math.max.apply(null, stageScores) : 0,
    gameCount: 1,
    stageCount: stages.filter(function(result) { return result.ticket && !result.ticket.abstained; }).length,
    forcedOffCount: stages.filter(function(result) { return result.status === 'forced_off'; }).length,
    predictionAccuracy: answeredPredictions.length ? round_(answeredPredictions.filter(function(item) { return item.matched; }).length / answeredPredictions.length) : null,
    wins: ranking.rank === 1 ? 1 : 0,
    podiums: ranking.rank <= 3 ? 1 : 0,
    rank: ranking.rank || null,
  };
}

function aggregatePlayerHistory_(uuid, saveRows, stageRows) {
  const summaries = (saveRows || []).map(function(row) { return row.summary || parseJson_(row.summaryJson, {}); });
  const stageSkills = (stageRows || []).map(function(row) { return Number(row.stageSkill || 0); }).filter(function(value) { return value > 0; });
  const scores = (stageRows || []).map(function(row) { return Number(row.score || 0); });
  const totals = summaries.reduce(function(acc, summary) {
    acc.totalScore += Number(summary.totalScore || 0);
    acc.gameCount += Number(summary.gameCount || 0);
    acc.wins += Number(summary.wins || 0);
    acc.podiums += Number(summary.podiums || 0);
    acc.forcedOffCount += Number(summary.forcedOffCount || 0);
    return acc;
  }, { totalScore: 0, gameCount: 0, wins: 0, podiums: 0, forcedOffCount: 0 });
  return Object.assign(totals, {
    uuid,
    currentSkill: currentSkill_(stageSkills),
    averageSkill: average_(stageSkills),
    totalSkill: round_(stageSkills.reduce(function(sum, value) { return sum + value; }, 0)),
    averageScore: average_(scores),
    bestScore: scores.length ? Math.max.apply(null, scores) : 0,
    stageCount: scores.length,
  });
}

function saveDataRowExists_(uuid, gameId) {
  return rowsAsObjects_(SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.saveData)).some(function(row) {
    return row.uuid === uuid && row.gameId === gameId;
  });
}

function stageResultRowExists_(uuid, gameId, stageId) {
  return rowsAsObjects_(SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.stageResults)).some(function(row) {
    return row.uuid === uuid && row.gameId === gameId && row.stageId === stageId;
  });
}

function chunkString_(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function parseJson_(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch (err) {
    return fallback;
  }
}

function average_(values) {
  const filtered = (values || []).map(Number).filter(function(value) { return isFinite(value); });
  if (!filtered.length) return 0;
  return round_(filtered.reduce(function(sum, value) { return sum + value; }, 0) / filtered.length);
}

function clone_(value) {
  return JSON.parse(JSON.stringify(value));
}

function getConfigValue_(key, fallback) {
  const config = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.config);
  const rows = rowsAsObjects_(config);
  const row = rows.find(function(item) { return item.key === key; });
  return row ? row.value : fallback;
}

function setConfigValue_(key, value) {
  const config = SpreadsheetApp.getActive().getSheetByName(EVG_SHEETS.config);
  const values = config.getDataRange().getValues();
  for (let i = 1; i < values.length; i += 1) {
    if (values[i][0] === key) {
      config.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  config.appendRow([key, value]);
}

function getClientConfigSnippet() {
  setupElevatorGameSheets();
  const url = getConfigValue_('webAppUrl', EVG_DEPLOYED_WEB_APP_URL);
  const apiKey = EVG_DEPLOYMENT_ID;
  return buildClientConfigSnippet_(url, apiKey);
}

function buildClientConfigSnippet_(url, apiKey) {
  return [
    '(function (root) {',
    '  root.EVG_BUILD_CONFIG = {',
    '    GAS_API_BASE_URL: "' + url + '",',
    '    GAS_API_KEY: "' + apiKey + '",',
    '    USE_GAS_API: true,',
    '    POLL_INTERVAL_MS: 10000,',
    '  };',
    '})(typeof self !== "undefined" ? self : this);',
  ].join('\n');
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
  room.roomVersion = Number(room.roomVersion || 0) + 1;
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

function createUuid_() {
  if (typeof Utilities !== 'undefined' && Utilities.getUuid) return Utilities.getUuid();
  return 'uuid-' + Math.random().toString(36).slice(2) + '-' + Date.now();
}

function uniqueGameId_(title) {
  const base = String(title || 'game').trim().replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0, 10);
  return nextAvailableGameId_(base, existingGameIds_());
}

function nextAvailableGameId_(base, existingIds) {
  const used = {};
  (existingIds || []).forEach(function(id) { used[String(id)] = true; });
  if (!used[base]) return base;
  let suffix = 2;
  while (used[base + '_' + suffix]) suffix += 1;
  return base + '_' + suffix;
}

function existingGameIds_() {
  if (typeof SpreadsheetApp === 'undefined') return [];
  const ss = SpreadsheetApp.getActive();
  const ids = [];
  [EVG_SHEETS.gameHistory, EVG_SHEETS.saveData, EVG_SHEETS.stageSettings].forEach(function(sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    rowsAsObjects_(sheet).forEach(function(row) {
      if (row.gameId) ids.push(row.gameId);
    });
  });
  return ids;
}
