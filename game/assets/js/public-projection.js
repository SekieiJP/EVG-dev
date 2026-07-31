(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EVGPublicProjection = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PUBLIC_EVENT_FIELDS = {
    E1_prediction: [
      "type",
      "question",
      "answerFormat",
      "metric",
      "answerMetric",
      "scoreOnCorrect",
      "scoreOnWrong",
      "scoreOnNoAnswer",
      "options",
      "choices",
      "ranges",
    ],
    E2_forbidden: ["type", "fromFloor", "toFloor"],
    E3a_zone_multiplier: ["type", "fromFloor", "toFloor", "multiplier"],
    E3b_score_multiplier: ["type", "fromFloor", "toFloor", "multiplier"],
    E4_special_floor: ["type", "floor", "bonus", "score"],
    E5_occupancy_multiplier: ["type", "threshold", "multiplier"],
    E6_view_bonus: ["type", "bonusPerExitFloor", "multiplier"],
    E7_entry_fee: ["type", "score"],
    E8_completion_bonus: ["type", "score"],
  };
  const PUBLIC_OPTION_FIELDS = ["value", "label", "min", "max", "from", "to", "lower", "upper"];
  const TIMELINE_ID_FIELDS = [
    "boarding",
    "exiting",
    "passengersBeforeCheck",
    "passengersAfterCheck",
    "forcedOff",
  ];
  const VALID_PRESENCE_STATUSES = new Set(["none", "submitted", "abstained", "error"]);

  function publicProfileId(uid) {
    const value = String(uid || "");
    let first = 2166136261;
    let second = 3339675911;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ (code + index + 97), 2246822519);
    }
    return `p_${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
  }

  function buildPublicProjection(room) {
    const source = room || {};
    const identities = buildIdentityContext(source);
    const publicNodes = {
      publicConfig: buildPublicConfig(source, identities),
      publicPlayers: buildPublicPlayers(source, identities),
      publicTicketPresence: buildPublicTicketPresence(source, identities),
      publicResults: buildPublicResults(source, identities),
      publicScores: buildPublicScores(source, identities),
    };
    Object.keys(publicNodes).forEach((key) => {
      publicNodes[key] = scrubKnownRawIds(publicNodes[key], identities);
    });
    publicNodes.publicProfileOwners = buildPublicProfileOwners(source, identities);
    return publicNodes;
  }

  function buildPublicConfig(roomOrConfig, existingIdentities) {
    const source = roomOrConfig || {};
    const config = source.config || source;
    const identities = existingIdentities || buildIdentityContext(source.config ? source : {});
    const gameMeta = config.gameMeta || {};
    const result = {
      schemaVersion: publicString(config.schemaVersion || "1.0.0", identities),
      gameMeta: {
        title: publicString(gameMeta.title || "エレベーターゲーム", identities).slice(0, 80),
      },
      stages: asArray(config.stages).map((stage, index) => buildPublicStageConfig(stage, index, identities)),
    };
    if (gameMeta.description !== undefined) {
      result.gameMeta.description = publicString(gameMeta.description, identities).slice(0, 500);
    }
    if (gameMeta.createdAt !== undefined) {
      result.gameMeta.createdAt = publicString(gameMeta.createdAt, identities).slice(0, 64);
    }
    if (gameMeta.configId !== undefined) {
      result.gameMeta.configId = publicString(gameMeta.configId, identities).slice(0, 80);
    }
    return scrubKnownRawIds(result, identities);
  }

  function buildPublicStageConfig(stage, index, identities) {
    const source = stage || {};
    const params = source.params || {};
    return {
      stageId: publicString(source.stageId || `stage-${String(index + 1).padStart(3, "0")}`, identities).slice(0, 120),
      name: publicString(source.name || `ステージ${index + 1}`, identities).slice(0, 80),
      params: {
        N: finiteNumber(params.N, 1),
        X: finiteNumber(params.X, 1),
        P: finiteNumber(params.P, 0),
        Q: finiteNumber(params.Q, 0),
      },
      events: asArray(source.events)
        .slice(0, 10)
        .map((event) => buildPublicEvent(event, identities))
        .filter(Boolean),
    };
  }

  function buildPublicEvent(event, identities) {
    if (!event || !PUBLIC_EVENT_FIELDS[event.type]) return null;
    const result = {};
    PUBLIC_EVENT_FIELDS[event.type].forEach((key) => {
      if (event[key] === undefined || event[key] === null) return;
      if (["options", "choices", "ranges"].includes(key)) {
        result[key] = asArray(event[key]).map((option) => buildPublicOption(option, identities));
        return;
      }
      result[key] = sanitizeAllowedScalar(event[key], identities);
    });
    return result;
  }

  function buildPublicOption(option, identities) {
    if (option === null || option === undefined) return {};
    if (typeof option !== "object") {
      return { value: sanitizeAllowedScalar(option, identities) };
    }
    return PUBLIC_OPTION_FIELDS.reduce((result, key) => {
      if (option[key] !== undefined && option[key] !== null) {
        result[key] = sanitizeAllowedScalar(option[key], identities);
      }
      return result;
    }, {});
  }

  function buildPublicPlayers(room, existingIdentities) {
    const source = room || {};
    const identities = existingIdentities || buildIdentityContext(source);
    return (source.players || []).reduce((result, player, index) => {
      const rawUid = rawPlayerId(player);
      if (!rawUid) return result;
      const profileId = profileFor(rawUid, identities);
      if (result[profileId]) throw profileCollision(profileId);
      result[profileId] = {
        profileId,
        name: publicPlayerName(player && player.name, identities),
        connected: !player || player.connected !== false,
        order: index,
      };
      return result;
    }, {});
  }

  function buildPublicProfileOwners(room, existingIdentities) {
    const source = room || {};
    const identities = existingIdentities || buildIdentityContext(source);
    return (source.players || []).reduce((result, player) => {
      const rawUid = rawPlayerId(player);
      if (!rawUid) return result;
      const profileId = profileFor(rawUid, identities);
      if (result[profileId] && result[profileId] !== rawUid) throw profileCollision(profileId);
      result[profileId] = rawUid;
      return result;
    }, {});
  }

  function buildPublicTicketPresence(room, existingIdentities) {
    const source = room || {};
    const identities = existingIdentities || buildIdentityContext(source);
    const presence = Object.assign({}, source.ticketPresence || {});
    Object.keys(source.tickets || {}).forEach((stageId) => {
      if (presence[stageId] && Object.keys(presence[stageId]).length) return;
      presence[stageId] = Object.keys(source.tickets[stageId] || {}).reduce((result, rawUid) => {
        const ticket = source.tickets[stageId][rawUid] || {};
        result[rawUid] = { status: ticket.abstained ? "abstained" : "submitted" };
        return result;
      }, {});
    });
    return Object.keys(presence).reduce((stages, stageId) => {
      const publicStageId = publicString(stageId, identities);
      stages[publicStageId] = Object.keys(presence[stageId] || {}).reduce((entries, rawUid) => {
        const profileId = profileFor(rawUid, identities);
        const item = presence[stageId][rawUid] || {};
        const status = VALID_PRESENCE_STATUSES.has(item.status) ? item.status : "none";
        entries[profileId] = { profileId, status };
        return entries;
      }, {});
      return stages;
    }, {});
  }

  function buildPublicScores(room, existingIdentities) {
    const source = room || {};
    const identities = existingIdentities || buildIdentityContext(source);
    const playerByUid = new Map((source.players || []).map((player, index) => {
      return [rawPlayerId(player), { player, index }];
    }));
    return Object.keys(source.scores || {}).reduce((result, rawUid) => {
      const profileId = profileFor(rawUid, identities);
      const playerEntry = playerByUid.get(rawUid);
      const rawScore = source.scores[rawUid];
      result[profileId] = {
        profileId,
        name: publicPlayerName(playerEntry && playerEntry.player && playerEntry.player.name, identities),
        total: roundScore(typeof rawScore === "number" ? rawScore : rawScore && rawScore.total),
        order: playerEntry ? playerEntry.index : Number.MAX_SAFE_INTEGER,
      };
      return result;
    }, {});
  }

  function buildPublicResults(room, existingIdentities) {
    const source = room || {};
    const identities = existingIdentities || buildIdentityContext(source);
    return Object.keys(source.stageResults || {}).reduce((result, stageId) => {
      const privateResult = source.stageResults[stageId];
      if (!privateResult) return result;
      const publicStageId = publicString(stageId, identities);
      result[publicStageId] = buildPublicStageResult(source, privateResult, stageId, identities);
      return result;
    }, {});
  }

  function buildPublicStageResult(room, privateResult, fallbackStageId, existingIdentities) {
    const source = room || {};
    const result = privateResult || {};
    const identities = existingIdentities || buildIdentityContext(source);
    const rawStageId = String(result.stageId || fallbackStageId || "");
    const stage = findStage(source.config, rawStageId) || {
      stageId: rawStageId,
      name: result.stageName || rawStageId,
      params: result.params || {},
      events: [],
    };
    const floorCount = Math.max(1, Math.floor(finiteNumber(stage.params && stage.params.N, 1)));
    const orderByUid = new Map((source.players || []).map((player, index) => [rawPlayerId(player), index]));
    const players = {};
    Object.keys(result.players || {}).forEach((key, index) => {
      const privatePlayer = result.players[key] || {};
      const rawUid = String(privatePlayer.uuid || key || "");
      if (!rawUid) return;
      const profileId = profileFor(rawUid, identities);
      if (players[profileId]) throw profileCollision(profileId);
      players[profileId] = {
        profileId,
        name: publicPlayerName(privatePlayer.name, identities),
        order: orderByUid.has(rawUid) ? orderByUid.get(rawUid) : index,
      };
    });
    const scoreCheckpoints = buildScoreCheckpoints(stage, result, identities);
    const checkpointByFloor = new Map(scoreCheckpoints.map((checkpoint) => [checkpoint.floor, checkpoint]));
    const rawTimeline = asArray(result.timeline);
    const rawTimelineByFloor = new Map(rawTimeline.map((step) => [Number(step && step.floor), step || {}]));
    const timeline = Array.from({ length: floorCount }, (_, index) => {
      const floor = index + 1;
      const step = rawTimelineByFloor.get(floor) || { floor };
      const projected = { floor };
      TIMELINE_ID_FIELDS.forEach((key) => {
        projected[key] = uniqueStrings(asArray(step[key]).map((rawUid) => profileFor(rawUid, identities)));
      });
      projected.blocked = blockedAtFloor(result, floor).map((rawUid) => profileFor(rawUid, identities));
      projected.danger = projected.forcedOff.length > 0;
      const checkpoint = checkpointByFloor.get(floor);
      projected.scoreChanged = Boolean(checkpoint && Object.values(checkpoint.scores).some((row) => Number(row.delta) !== 0));
      return projected;
    });
    return scrubKnownRawIds({
      gameId: publicString(result.gameId || source.gameId || "", identities),
      stageId: publicString(rawStageId, identities),
      stageName: publicString(result.stageName || stage.name || rawStageId, identities).slice(0, 80),
      calculatedAt: publicString(result.calculatedAt || "", identities).slice(0, 64),
      floorCount,
      players,
      timeline,
      scoreCheckpoints,
      rankings: buildPublicRankings(result, identities),
    }, identities);
  }

  function buildPublicRankings(result, identities) {
    let rankings = asArray(result && result.rankings);
    if (!rankings.length) {
      rankings = Object.keys(result && result.players || {}).map((key) => {
        const player = result.players[key] || {};
        return {
          uuid: player.uuid || key,
          name: player.name,
          score: roundScore(player.score),
        };
      }).sort((a, b) => Number(b.score) - Number(a.score) || String(a.name || "").localeCompare(String(b.name || ""), "ja"));
      let previousScore = null;
      let previousRank = 0;
      rankings = rankings.map((row, index) => {
        const rank = row.score === previousScore ? previousRank : index + 1;
        previousScore = row.score;
        previousRank = rank;
        return Object.assign({ rank }, row);
      });
    }
    return rankings.map((row, index) => {
      const rawIdentity = row && (row.uuid || row.uid || row.profileId) || "";
      const profileId = profileFor(rawIdentity, identities);
      return {
        profileId,
        name: publicPlayerName(row && row.name, identities),
        rank: finiteNumber(row && row.rank, index + 1),
        score: roundScore(row && (row.score !== undefined ? row.score : row.totalScore)),
      };
    });
  }

  function buildScoreCheckpoints(stage, result, identities) {
    const floorCount = Math.max(1, Math.floor(finiteNumber(stage && stage.params && stage.params.N, 1)));
    const privatePlayers = Object.keys(result && result.players || {}).map((key) => {
      const player = result.players[key] || {};
      return { key, rawUid: String(player.uuid || key || ""), player };
    }).filter((entry) => entry.rawUid);
    const changesByUid = new Map(privatePlayers.map((entry) => {
      return [entry.rawUid, scoreChangesForPlayer(stage, result, entry.player, entry.rawUid, floorCount)];
    }));
    const runningScores = new Map(privatePlayers.map((entry) => [entry.rawUid, 0]));
    return Array.from({ length: floorCount + 1 }, (_, floor) => {
      const scores = {};
      privatePlayers.forEach((entry) => {
        const changes = changesByUid.get(entry.rawUid);
        const change = changes.byFloor.get(floor) || { delta: 0, labels: [] };
        let nextScore = roundScore((runningScores.get(entry.rawUid) || 0) + change.delta);
        if (floor === floorCount && Number.isFinite(Number(entry.player.score))) {
          nextScore = roundScore(entry.player.score);
        }
        const delta = roundScore(nextScore - (runningScores.get(entry.rawUid) || 0));
        runningScores.set(entry.rawUid, nextScore);
        const profileId = profileFor(entry.rawUid, identities);
        scores[profileId] = {
          profileId,
          score: nextScore,
          delta,
          reason: checkpointReason(entry.player, floor, delta, change.labels),
        };
      });
      return { floor, scores };
    });
  }

  function scoreChangesForPlayer(stage, result, player, rawUid, floorCount) {
    const byFloor = new Map();
    const add = (floor, delta, label) => {
      const target = Math.max(0, Math.min(floorCount, Math.floor(finiteNumber(floor, floorCount))));
      const current = byFloor.get(target) || { delta: 0, labels: [] };
      current.delta += finiteNumber(delta, 0);
      if (finiteNumber(delta, 0) !== 0 && label) current.labels.push(label);
      byFloor.set(target, current);
    };
    const ticket = player && player.ticket;
    if (!ticket || ticket.abstained) return { byFloor };
    add(0, -finiteNumber(player.penalty, 0), "運賃");
    const wholeRouteMultiplier = scoreMultiplierForTicket(stage, ticket);
    asArray(player.successfulIntervals).forEach((interval) => {
      const floor = interval && interval.sameFloor ? interval.from : interval && interval.to;
      add(floor, intervalScore(stage, interval || {}, wholeRouteMultiplier), "上昇報酬");
    });
    asArray(stage && stage.events).forEach((event) => {
      if (!event) return;
      if (event.type === "E4_special_floor") {
        const floor = finiteNumber(event.floor, 0);
        const step = asArray(result && result.timeline).find((item) => Number(item && item.floor) === floor);
        if (step && asArray(step.passengersAfterCheck).map(String).includes(rawUid)) {
          add(floor, finiteNumber(event.bonus !== undefined ? event.bonus : event.score, 0), "特別階");
        }
      }
      if (event.type === "E6_view_bonus" && player.status === "success") {
        add(ticket.exitFloor, finiteNumber(ticket.exitFloor, 0) * finiteNumber(event.bonusPerExitFloor !== undefined ? event.bonusPerExitFloor : event.multiplier, 0), "眺望");
      }
      if (event.type === "E7_entry_fee") {
        add(ticket.boardFloor, finiteNumber(event.score, 0), "入場料");
      }
      if (event.type === "E8_completion_bonus" && player.status === "success") {
        add(ticket.exitFloor, finiteNumber(event.score, 0), "完乗");
      }
    });
    const predictionDelta = asArray(player.predictionBreakdown)
      .reduce((sum, item) => sum + finiteNumber(item && item.score, 0), 0);
    add(floorCount, predictionDelta, "予想");
    return { byFloor };
  }

  function checkpointReason(player, floor, delta, labels) {
    if (!player || !player.ticket || player.ticket.abstained) return "未参加";
    if (labels && labels.length) return labels[labels.length - 1];
    if (floor === 0 && delta !== 0) return "運賃";
    if (delta !== 0) return "確定";
    return "変動なし";
  }

  function blockedAtFloor(result, floor) {
    return Object.keys(result && result.players || {}).reduce((blocked, key) => {
      const player = result.players[key] || {};
      const rawUid = String(player.uuid || key || "");
      if (
        rawUid &&
        player.ticket &&
        !player.ticket.abstained &&
        Number(player.ticket.boardFloor) === Number(floor) &&
        ["invalid", "not_boarded"].includes(player.status)
      ) {
        blocked.push(rawUid);
      }
      return blocked;
    }, []);
  }

  function intervalScore(stage, interval, wholeRouteMultiplier) {
    const distance = interval.sameFloor ? 1 : finiteNumber(interval.to, 0) - finiteNumber(interval.from, 0);
    let multiplier = wholeRouteMultiplier;
    asArray(stage && stage.events).forEach((event) => {
      if (event.type === "E3a_zone_multiplier" && intervalTouchesZone(interval, event)) {
        multiplier *= finiteNumber(event.multiplier, 1);
      }
      if (event.type === "E5_occupancy_multiplier" && finiteNumber(interval.occupancy, 0) >= finiteNumber(event.threshold, Infinity)) {
        multiplier *= finiteNumber(event.multiplier, 1);
      }
    });
    return distance * finiteNumber(stage && stage.params && stage.params.P, 0) * multiplier;
  }

  function scoreMultiplierForTicket(stage, ticket) {
    return asArray(stage && stage.events).reduce((multiplier, event) => {
      if (event.type === "E3b_score_multiplier" && routeTouchesZone(ticket, event)) {
        return multiplier * finiteNumber(event.multiplier, 1);
      }
      return multiplier;
    }, 1);
  }

  function intervalTouchesZone(interval, event) {
    const from = finiteNumber(event.fromFloor, 0);
    const to = finiteNumber(event.toFloor, 0);
    if (interval.sameFloor) return finiteNumber(interval.from, 0) >= from && finiteNumber(interval.from, 0) <= to;
    return finiteNumber(interval.from, 0) >= from && finiteNumber(interval.to, 0) <= to;
  }

  function routeTouchesZone(ticket, event) {
    const from = finiteNumber(event.fromFloor, 0);
    const to = finiteNumber(event.toFloor, 0);
    for (let floor = finiteNumber(ticket.boardFloor, 0); floor <= finiteNumber(ticket.exitFloor, -1); floor += 1) {
      if (floor >= from && floor <= to) return true;
    }
    return false;
  }

  function findStage(config, stageId) {
    return asArray(config && config.stages).find((stage) => String(stage && stage.stageId || "") === String(stageId || "")) || null;
  }

  function buildIdentityContext(room) {
    const rawIds = collectRawIds(room);
    const rawToProfile = new Map();
    const profileToRaw = new Map();
    rawIds.forEach((rawUid) => {
      const profileId = publicProfileId(rawUid);
      if (profileToRaw.has(profileId) && profileToRaw.get(profileId) !== rawUid) {
        throw profileCollision(profileId);
      }
      rawToProfile.set(rawUid, profileId);
      profileToRaw.set(profileId, rawUid);
    });
    return {
      rawIds: Array.from(rawToProfile.keys()).sort((a, b) => b.length - a.length),
      rawToProfile,
      profileToRaw,
    };
  }

  function collectRawIds(room) {
    const ids = new Set();
    const add = (value) => {
      const text = String(value || "");
      if (text) ids.add(text);
    };
    (room && room.players || []).forEach((player) => add(rawPlayerId(player)));
    Object.keys(room && room.scores || {}).forEach(add);
    [room && room.tickets, room && room.ticketPresence].forEach((stages) => {
      Object.keys(stages || {}).forEach((stageId) => Object.keys(stages[stageId] || {}).forEach(add));
    });
    Object.keys(room && room.stageResults || {}).forEach((stageId) => {
      collectStageResultRawIds(room.stageResults[stageId], add);
    });
    asArray(room && room.completedGames).forEach((game) => {
      Object.keys(game && game.scores || {}).forEach(add);
      asArray(game && game.playerSnapshots).forEach((player) => add(rawPlayerId(player)));
      asArray(game && game.rankings).forEach((row) => add(row && (row.uuid || row.uid)));
      Object.keys(game && game.stageResults || {}).forEach((stageId) => {
        collectStageResultRawIds(game.stageResults[stageId], add);
      });
    });
    asArray(room && room.historyPlayers).forEach((player) => add(player && (player.uuid || player.uid)));
    return Array.from(ids);
  }

  function collectStageResultRawIds(stageResult, add) {
      const result = stageResult || {};
      Object.keys(result.players || {}).forEach((key) => {
        add(key);
        add(result.players[key] && result.players[key].uuid);
      });
      asArray(result.rankings).forEach((row) => add(row && (row.uuid || row.uid)));
      asArray(result.timeline).forEach((step) => {
        TIMELINE_ID_FIELDS.forEach((key) => asArray(step && step[key]).forEach(add));
      });
  }

  function scrubPublicValue(value, room) {
    return scrubKnownRawIds(value, buildIdentityContext(room || {}));
  }

  function profileFor(rawIdentity, identities) {
    const value = String(rawIdentity || "");
    if (!value) return publicProfileId("");
    if (identities && identities.rawToProfile.has(value)) return identities.rawToProfile.get(value);
    if (/^p_[a-z0-9]+$/.test(value) && (!identities || !identities.profileToRaw.has(value))) return value;
    return publicProfileId(value);
  }

  function rawPlayerId(player) {
    return String(player && (player.uuid || player.uid) || "");
  }

  function publicPlayerName(value, identities) {
    const name = publicString(value || "プレイヤー", identities).trim();
    return (name || "プレイヤー").slice(0, 24);
  }

  function publicString(value, identities) {
    let output = String(value === undefined || value === null ? "" : value);
    if (!identities) return output;
    identities.rawIds.forEach((rawUid) => {
      if (output.includes(rawUid)) output = output.split(rawUid).join(identities.rawToProfile.get(rawUid));
    });
    return output;
  }

  function scrubKnownRawIds(value, identities) {
    if (Array.isArray(value)) return value.map((item) => scrubKnownRawIds(item, identities));
    if (value && typeof value === "object") {
      return Object.keys(value).reduce((result, key) => {
        const publicKey = publicString(key, identities);
        if (Object.prototype.hasOwnProperty.call(result, publicKey)) {
          throw new Error(`PUBLIC_PROJECTION_KEY_COLLISION:${publicKey}`);
        }
        result[publicKey] = scrubKnownRawIds(value[key], identities);
        return result;
      }, {});
    }
    return typeof value === "string" ? publicString(value, identities) : value;
  }

  function sanitizeAllowedScalar(value, identities) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "boolean") return value;
    return publicString(value, identities).slice(0, 500);
  }

  function asArray(value) {
    if (Array.isArray(value)) return value.slice();
    if (!value || typeof value !== "object") return [];
    return Object.keys(value)
      .sort((a, b) => {
        const numericA = /^\d+$/.test(a) ? Number(a) : Number.MAX_SAFE_INTEGER;
        const numericB = /^\d+$/.test(b) ? Number(b) : Number.MAX_SAFE_INTEGER;
        return numericA - numericB || a.localeCompare(b);
      })
      .map((key) => value[key]);
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(String).filter(Boolean)));
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function roundScore(value) {
    return Math.round(finiteNumber(value, 0) * 100) / 100;
  }

  function profileCollision(profileId) {
    const error = new Error(`公開profileIdが衝突しました: ${profileId}`);
    error.code = "public_profile_collision";
    return error;
  }

  return {
    publicProfileId,
    buildPublicConfig,
    buildPublicPlayers,
    buildPublicTicketPresence,
    buildPublicResults,
    buildPublicScores,
    buildPublicProfileOwners,
    buildPublicStageResult,
    buildScoreCheckpoints,
    buildPublicProjection,
    scrubPublicValue,
  };
});
