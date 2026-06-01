(function (root) {
  const MOCK_DB_KEY = "evg.firebase.mock.db.v1";
  const AUTH_KEY = "evg.firebase.auth.v1";
  const CHANNEL_NAME = "evg.firebase.mock.channel.v1";

  function createFirebaseAdapter(options) {
    return new FirebaseAdapter(options || {});
  }

  class FirebaseAdapter {
    constructor(options) {
      this.config = options.config || {};
      this.engine = options.engine;
      this.getRole = options.getRole || (() => "player");
      this.getUuid = options.getUuid || (() => "");
      this.log = options.log || (() => {});
      this.channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
      this.roomId = cleanKey(this.config.FIREBASE_ROOM_ID || "elevator-game-live");
      this.auth = loadJson(AUTH_KEY, null);
      this.mock = Boolean(this.config.FIREBASE_USE_LOCAL_MOCK || !this.config.FIREBASE_API_KEY || !this.config.FIREBASE_DATABASE_URL);
      this.readyPromise = null;
      this.unsubscribe = null;
    }

    async init() {
      if (!this.readyPromise) {
        this.readyPromise = this.mock ? this.initMock() : this.initRest();
      }
      return this.readyPromise;
    }

    async initMock() {
      if (!this.auth) {
        this.auth = {
          uid: this.getUuid() || this.engine.createUuid(),
          idToken: "mock-token",
          mock: true,
        };
        localStorage.setItem(AUTH_KEY, JSON.stringify(this.auth));
      }
      const room = this.readMockRoom();
      if (!room) this.writeMockRoom(this.engine.createInitialRoom(this.engine.DEFAULT_CONFIG));
      return { ok: true, mock: true, uid: this.auth.uid };
    }

    async initRest() {
      const sdk = await loadFirebaseSdk(this.config.FIREBASE_SDK_VERSION || "10.12.5");
      this.sdk = sdk;
      this.firebaseApp = sdk.initializeApp({
        apiKey: this.config.FIREBASE_API_KEY,
        authDomain: this.config.FIREBASE_AUTH_DOMAIN || `${this.config.FIREBASE_PROJECT_ID}.firebaseapp.com`,
        databaseURL: this.config.FIREBASE_DATABASE_URL,
        projectId: this.config.FIREBASE_PROJECT_ID,
      });
      this.firebaseAuth = sdk.getAuth(this.firebaseApp);
      const user = await currentOrAnonymousUser(sdk, this.firebaseAuth);
      this.auth = { uid: user.uid, idToken: await user.getIdToken(), mock: false };
      localStorage.setItem(AUTH_KEY, JSON.stringify(this.auth));
      this.firebaseDb = sdk.getDatabase(this.firebaseApp);
      const room = await this.readRestRoom();
      if (!room) await this.writeRestRoom(this.engine.createInitialRoom(this.engine.DEFAULT_CONFIG));
      return { ok: true, uid: this.auth.uid };
    }

    async listen(callback) {
      await this.init();
      if (this.mock) {
        const handler = (event) => {
          if (event.data && event.data.type === "room" && event.data.roomId === this.roomId) {
            callback(this.readMockRoom());
          }
        };
        if (this.channel) this.channel.addEventListener("message", handler);
        return () => this.channel && this.channel.removeEventListener("message", handler);
      }
      this.unsubscribe = this.listenRest(callback);
      return this.unsubscribe;
    }

    listenRest(callback) {
      const nodes = {};
      const unsubscribers = [];
      let stageUnsubscribers = [];
      let currentStageId = "";
      const attach = (path) => {
        const unsubscribe = this.sdk.onValue(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`), (snapshot) => {
          setNestedNode(nodes, path, snapshot.val());
          updateStageSubscriptions();
          callback(roomFromFirebaseNodes(nodes, this.engine));
        });
        unsubscribers.push(unsubscribe);
      };
      const attachStage = (path) => {
        const unsubscribe = this.sdk.onValue(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`), (snapshot) => {
          setNestedNode(nodes, path, snapshot.val());
          callback(roomFromFirebaseNodes(nodes, this.engine));
        });
        stageUnsubscribers.push(unsubscribe);
      };
      const updateStageSubscriptions = () => {
        const stageId = nodes.public && nodes.public.currentStageId ? nodes.public.currentStageId : "";
        if (stageId === currentStageId) return;
        stageUnsubscribers.forEach((unsubscribe) => unsubscribe());
        stageUnsubscribers = [];
        currentStageId = stageId;
        if (!stageId) return;
        firebaseStageSubscriptionPaths(this.getRole(), this.auth.uid, stageId).forEach(attachStage);
      };
      firebaseBaseSubscriptionPaths(this.getRole(), this.auth.uid).forEach(attach);
      return () => {
        stageUnsubscribers.forEach((unsubscribe) => unsubscribe());
        unsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    }

    async get(path, payload) {
      await this.init();
      const room = await this.readRoom();
      if (path === "/api/status" || path === "/api/room/state" || path === "/api/screen/state") {
        return this.publicStatus(room, payload || {});
      }
      if (path === "/api/host/game-configs") {
        return {
          ok: true,
          configs: [],
          serverTime: nowIso(),
          message: "Firebase版では次ゲーム候補の読み込みは未対応です。設定JSON Importを使用してください。",
        };
      }
      if (path === "/api/history/games") {
        return { ok: true, games: room.completedGames || [], players: publicPlayers(room.players || []) };
      }
      if (path.indexOf("/api/history/player/") === 0) {
        const uuid = path.split("/").pop();
        if (uuid !== (payload && payload.uuid)) return { ok: false, code: "forbidden", error: "自分自身の戦歴のみ取得できます。" };
        return this.playerHistory(room, uuid);
      }
      return { ok: false, code: "not_found", error: `Unknown endpoint: ${path}` };
    }

    async post(path, payload) {
      await this.init();
      payload = payload || {};
      if (path === "/api/host/auth") return this.authHost(payload.password);
      if (!this.mock && isPlayerWritePath(path)) return this.postRestPlayer(path, payload);
      if (!this.mock) return this.postRestTransaction(path, payload);
      const room = await this.readRoom();
      const result = this.applyMutation(path, payload, room);
      if (!result.ok) return result;
      await this.writeRoom(result.room);
      return Object.assign({}, result, { room: this.publicRoom(result.room, payload || {}) });
    }

    applyMutation(path, payload, room) {
      let result = null;
      if (path === "/api/player/join") {
        result = this.engine.registerPlayer(room, payload.name, payload.uuid || this.auth.uid);
      } else if (path === "/api/player/restore") {
        result = this.restorePlayer(room, payload.uuid);
      } else if (path === "/api/player/rename") {
        result = this.engine.renamePlayer(room, payload.uuid, payload.name);
      } else if (path === "/api/player/proceed-next") {
        result = this.touchPlayer(room, payload.uuid);
      } else if (path === "/api/ticket/submit") {
        result = this.engine.submitTicket(room, payload.uuid, payload.ticket || payload);
      } else if (path === "/api/ticket/abstain") {
        result = this.engine.abstain(room, payload.uuid);
      } else if (path === "/api/host/commit-result") {
        result = this.commitHostResult(room, payload.room, payload.baseVersion);
      } else if (path === "/api/host/import-config") {
        result = { ok: true, room: room.players.length || Object.keys(room.stageResults || {}).length ? this.engine.createNextGameRoom(room, payload.config) : this.engine.createInitialRoom(payload.config) };
      } else if (path === "/api/host/update-config") {
        const next = this.engine.deepClone(room);
        next.config = this.engine.normalizeConfig(payload.config);
        next.roomVersion = Number(next.roomVersion || 0) + 1;
        next.updatedAt = nowIso();
        result = { ok: true, room: next };
      } else if (path === "/api/host/start-game-config") {
        result = { ok: false, code: "not_supported", error: "Firebase Spark版では事前登録ゲーム設定の開始は未実装です。" };
      } else if (path.indexOf("/api/host/") === 0) {
        const hostAuth = this.verifyHost(payload.hostToken);
        if (!hostAuth.ok) return hostAuth;
        const hostAction = hostActionFromPath(path);
        if (!hostAction) return { ok: false, code: "not_found", error: `Unknown endpoint: ${path}` };
        result = this.engine.advancePhase(room, hostAction, payload.hostName || "host");
      } else {
        result = { ok: false, code: "not_found", error: `Unknown endpoint: ${path}` };
      }
      if (result.ok && result.room && path.indexOf("/api/host/") === 0) {
        result.room.hostUid = this.auth.uid;
      }
      return result;
    }

    async postRestTransaction(path, payload) {
      const roomRef = this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}`);
      let result = null;
      const transaction = await this.sdk.runTransaction(roomRef, (currentNodes) => {
        const room = roomFromFirebaseNodes(currentNodes, this.engine) || this.engine.createInitialRoom(this.engine.DEFAULT_CONFIG);
        result = this.applyMutation(path, payload, room);
        if (!result.ok) return;
        const nodes = roomToFirebaseNodes(result.room);
        const currentHostUid = currentNodes && currentNodes.meta && currentNodes.meta.hostUid;
        nodes.meta.hostUid = nodes.meta.hostUid || currentHostUid || this.auth.uid;
        return nodes;
      }, { applyLocally: false });
      if (!result) return { ok: false, code: "transaction", error: "更新を開始できませんでした。" };
      if (!result.ok) return result;
      if (!transaction.committed) return { ok: false, code: "version_conflict", error: "ルーム状態が更新されています。もう一度操作してください。" };
      const nextRoom = roomFromFirebaseNodes(transaction.snapshot.val(), this.engine) || result.room;
      return Object.assign({}, result, { room: this.publicRoom(nextRoom, payload) });
    }

    async postRestPlayer(path, payload) {
      const room = await this.readRoom();
      const playerPayload = Object.assign({}, payload, { uuid: this.auth.uid });
      const result = this.applyMutation(path, playerPayload, room);
      if (!result.ok) return result;
      const updates = playerUpdates(path, result.room, this.auth.uid);
      if (!Object.keys(updates).length) return { ok: false, code: "not_supported", error: "この操作はFirebase Player更新に未対応です。" };
      await this.sdk.update(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}`), updates);
      return Object.assign({}, result, { room: this.publicRoom(result.room, playerPayload) });
    }

    async authHost(password) {
      const expected = String(this.config.FIREBASE_HOST_PASSWORD || "host").trim();
      if (String(password || "").trim() !== expected) {
        return { ok: false, code: "auth", error: "パスワードが違います。" };
      }
      await this.claimHost();
      return {
        ok: true,
        hostToken: `firebase-host:${this.auth.uid}:${Date.now()}`,
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        serverTime: nowIso(),
      };
    }

    async claimHost() {
      const room = await this.readRoom();
      room.hostUid = this.auth.uid;
      room.updatedAt = nowIso();
      await this.writeRoom(room);
    }

    verifyHost(token) {
      if (!token || String(token).indexOf(`firebase-host:${this.auth.uid}:`) !== 0) {
        return { ok: false, code: "auth", error: "ホスト認証が必要です。" };
      }
      return { ok: true };
    }

    restorePlayer(room, uuid) {
      const player = (room.players || []).find((item) => item.uuid === uuid);
      if (!player) return { ok: false, code: "not_found", error: "UUIDが見つかりません。" };
      const next = this.engine.deepClone(room);
      const nextPlayer = next.players.find((item) => item.uuid === uuid);
      nextPlayer.connected = true;
      nextPlayer.lastSeenAt = nowIso();
      touch(next);
      return { ok: true, room: next, player: nextPlayer };
    }

    touchPlayer(room, uuid) {
      const next = this.engine.deepClone(room);
      const player = next.players.find((item) => item.uuid === uuid);
      if (!player) return { ok: false, code: "not_joined", error: "参加登録が必要です。" };
      player.lastSeenAt = nowIso();
      touch(next);
      return { ok: true, room: next, player };
    }

    commitHostResult(room, nextRoom, baseVersion) {
      if (String(baseVersion) !== String(room.roomVersion || 0)) {
        return { ok: false, code: "version_conflict", error: "ルーム状態が更新されています。再読み込みしてください。" };
      }
      const stage = this.engine.getCurrentStage(room);
      if (!stage || !nextRoom || !nextRoom.stageResults || !nextRoom.stageResults[stage.stageId]) {
        return { ok: false, code: "bad_result", error: "結果発表状態のルームを送信してください。" };
      }
      const next = this.engine.deepClone(nextRoom);
      next.roomId = room.roomId;
      next.gameId = room.gameId;
      next.config = room.config;
      next.players = room.players;
      next.tickets = room.tickets;
      next.completedGames = room.completedGames || [];
      next.operations = room.operations || [];
      next.operations.unshift({ at: nowIso(), actor: "host", action: "firebase-commit-result" });
      touch(next);
      return { ok: true, room: next, result: next.stageResults[stage.stageId] };
    }

    publicStatus(room, payload) {
      const sameVersion = String(payload.sinceVersion || "") === String(room.roomVersion || 0);
      const sameGame = !payload.sinceGameId || String(payload.sinceGameId) === String(room.gameId || "");
      if (sameVersion && sameGame) {
        return { ok: true, unchanged: true, serverTime: nowIso(), status: compactStatus(room) };
      }
      return Object.assign(this.publicRoom(room, payload), { status: compactStatus(room) });
    }

    publicRoom(room, payload) {
      return {
        ok: true,
        serverTime: nowIso(),
        room: sanitizeRoom(room, payload && payload.role, payload && payload.uuid, this.engine),
        me: payload && payload.uuid ? (room.players || []).find((player) => player.uuid === payload.uuid) || null : null,
      };
    }

    playerHistory(room, uuid) {
      const stages = Object.keys(room.stageResults || {})
        .map((stageId) => room.stageResults[stageId].players && room.stageResults[stageId].players[uuid])
        .filter(Boolean);
      return {
        ok: true,
        games: room.completedGames || [],
        stages,
        summary: {
          uuid,
          totalScore: Number(room.scores[uuid] || 0),
          stageCount: stages.length,
          currentSkill: ((room.players || []).find((player) => player.uuid === uuid) || {}).skill || 0,
        },
      };
    }

    async readRoom() {
      const room = this.mock ? this.readMockRoom() : await this.readRestRoom();
      return room || this.engine.createInitialRoom(this.engine.DEFAULT_CONFIG);
    }

    async writeRoom(room) {
      return this.mock ? this.writeMockRoom(room) : this.writeRestRoom(room);
    }

    readMockRoom() {
      const db = loadJson(MOCK_DB_KEY, {});
      const entry = db.rooms && db.rooms[this.roomId];
      return roomFromFirebaseNodes(entry, this.engine);
    }

    writeMockRoom(room) {
      const db = loadJson(MOCK_DB_KEY, {});
      db.rooms = db.rooms || {};
      db.rooms[this.roomId] = roomToFirebaseNodes(room);
      localStorage.setItem(MOCK_DB_KEY, JSON.stringify(db));
      if (this.channel) this.channel.postMessage({ type: "room", roomId: this.roomId, version: room.roomVersion || 0 });
      return { ok: true };
    }

    async readRestRoom() {
      const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}`));
      return snapshot.exists() ? roomFromFirebaseNodes(snapshot.val(), this.engine) : null;
    }

    async writeRestRoom(room) {
      const nodes = roomToFirebaseNodes(room);
      nodes.meta.hostUid = nodes.meta.hostUid || this.auth.uid;
      await this.sdk.set(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}`), nodes);
      return { ok: true };
    }
  }

  function roomToFirebaseNodes(room) {
    const stage = room.config && room.config.stages ? room.config.stages[room.currentStageIndex || 0] : null;
    return {
      meta: {
        roomId: room.roomId || "",
        title: room.config && room.config.gameMeta ? room.config.gameMeta.title : "エレベーターゲーム",
        schemaVersion: "firebase-spark-v1",
        activeGameId: room.gameId || "",
        hostUid: room.hostUid || "",
        status: room.phase === "final" ? "finished" : "active",
        updatedAt: room.updatedAt || nowIso(),
      },
      public: compactStatus(room),
      config: room.config || null,
      players: keyBy(room.players || [], "uuid", publicPlayerNode),
      playerStats: keyBy(room.players || [], "uuid", playerStatsNode),
      tickets: room.tickets || {},
      ticketPresence: ticketPresence(room, stage && stage.stageId),
      results: room.stageResults || {},
      completedGames: keyBy(room.completedGames || [], "gameId", (game) => game),
      scores: Object.keys(room.scores || {}).reduce((acc, uuid) => {
        acc[uuid] = { total: room.scores[uuid], updatedAt: room.updatedAt || nowIso() };
        return acc;
      }, {}),
      operations: keyOperations(room.operations || []),
      roomSettings: {
        volume: room.volume !== undefined ? room.volume : 0.8,
        muted: Boolean(room.muted),
      },
    };
  }

  function roomFromFirebaseNodes(nodes, engine) {
    if (!nodes) return null;
    if (nodes.snapshot && !nodes.public && !nodes.players) return normalizeRoomShape(nodes.snapshot, engine);
    const fallback = engine.createInitialRoom(nodes.config || engine.DEFAULT_CONFIG);
    const status = nodes.public || {};
    const players = Object.keys(nodes.players || {}).map((uuid) => {
      const player = nodes.players[uuid] || {};
      const stats = nodes.playerStats && nodes.playerStats[uuid] ? nodes.playerStats[uuid] : {};
      return {
        uuid,
        name: player.name || uuid,
        connected: player.connected !== false,
        joinedAt: player.joinedAt || fallback.createdAt,
        lastSeenAt: player.lastSeenAt || "",
        pendingName: player.pendingName || null,
        skill: Number(stats.currentSkill || 0),
        stageSkillHistory: Array.isArray(stats.stageSkillHistory) ? stats.stageSkillHistory : Object.values(stats.stageSkillHistory || {}),
      };
    });
    const scores = Object.keys(nodes.scores || {}).reduce((acc, uuid) => {
      const value = nodes.scores[uuid];
      acc[uuid] = typeof value === "number" ? value : Number(value && value.total || 0);
      return acc;
    }, {});
    const settings = nodes.roomSettings || {};
    return normalizeRoomShape({
      roomId: nodes.meta && nodes.meta.roomId || fallback.roomId,
      hostUid: nodes.meta && nodes.meta.hostUid || "",
      gameId: status.gameId || (nodes.meta && nodes.meta.activeGameId) || fallback.gameId,
      config: nodes.config || fallback.config,
      phase: status.phase || fallback.phase,
      currentStageIndex: Number(status.currentStageIndex || 0),
      players,
      tickets: nodes.tickets || {},
      stageResults: nodes.results || {},
      scores,
      completedGames: Object.values(nodes.completedGames || {}),
      operations: Object.values(nodes.operations || {}).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))),
      countdownEndsAt: status.countdownEndsAt || null,
      tallyingEndsAt: status.tallyingEndsAt || null,
      animationStartedAt: status.animationStartedAt || null,
      animationSkippedAt: status.animationSkippedAt || null,
      roomVersion: Number(status.roomVersion || 0),
      volume: settings.volume !== undefined ? Number(settings.volume) : fallback.volume,
      muted: Boolean(settings.muted),
      createdAt: nodes.meta && nodes.meta.createdAt || fallback.createdAt,
      updatedAt: nodes.meta && nodes.meta.updatedAt || fallback.updatedAt,
    }, engine);
  }

  function isPlayerWritePath(path) {
    return [
      "/api/player/join",
      "/api/player/restore",
      "/api/player/rename",
      "/api/player/proceed-next",
      "/api/ticket/submit",
      "/api/ticket/abstain",
    ].includes(path);
  }

  function firebaseBaseSubscriptionPaths(role, uid) {
    const common = ["meta", "public", "config", "roomSettings"];
    if (role === "host") {
      return common.concat(["players", "playerStats", "tickets", "ticketPresence", "results", "scores", "completedGames", "operations"]);
    }
    if (role === "screen") {
      return common.concat(["players", "playerStats", "tickets", "ticketPresence", "results", "scores"]);
    }
    if (role === "history") {
      return common.concat(["players", "playerStats", "results", "scores", "completedGames"]);
    }
    return common.concat(["players", `playerStats/${uid}`, `scores/${uid}`, "completedGames"]);
  }

  function firebaseStageSubscriptionPaths(role, uid, stageId) {
    if (role === "player") {
      return [`tickets/${stageId}/${uid}`, `results/${stageId}`];
    }
    return [];
  }

  function setNestedNode(target, path, value) {
    const parts = String(path || "").split("/").filter(Boolean);
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      cursor[parts[index]] = cursor[parts[index]] || {};
      cursor = cursor[parts[index]];
    }
    const key = parts[parts.length - 1];
    if (!key) return;
    if (value === null || value === undefined) delete cursor[key];
    else cursor[key] = value;
  }

  function playerUpdates(path, room, uid) {
    const nodes = roomToFirebaseNodes(room);
    const updates = {};
    if (path.indexOf("/api/player/") === 0 && nodes.players && nodes.players[uid]) {
      updates[`players/${uid}`] = nodes.players[uid];
    }
    if (path === "/api/ticket/submit" || path === "/api/ticket/abstain") {
      const stage = room.config && room.config.stages ? room.config.stages[room.currentStageIndex || 0] : null;
      const stageId = stage && stage.stageId;
      if (stageId && nodes.tickets && nodes.tickets[stageId] && nodes.tickets[stageId][uid]) {
        updates[`tickets/${stageId}/${uid}`] = nodes.tickets[stageId][uid];
      }
      if (stageId && nodes.ticketPresence && nodes.ticketPresence[stageId] && nodes.ticketPresence[stageId][uid]) {
        updates[`ticketPresence/${stageId}/${uid}`] = nodes.ticketPresence[stageId][uid];
      }
    }
    return updates;
  }

  function compactStatus(room) {
    const stage = room.config && room.config.stages ? room.config.stages[room.currentStageIndex || 0] : null;
    const stageId = stage ? stage.stageId : "";
    const tickets = stageId && room.tickets && room.tickets[stageId] ? room.tickets[stageId] : {};
    return {
      gameId: room.gameId || "",
      phase: room.phase,
      roomVersion: Number(room.roomVersion || 0),
      currentStageIndex: room.currentStageIndex || 0,
      currentStageId: stageId,
      playerCount: (room.players || []).length,
      submittedCount: Object.keys(tickets).filter((uuid) => tickets[uuid] && !tickets[uuid].abstained).length,
      abstainedCount: Object.keys(tickets).filter((uuid) => tickets[uuid] && tickets[uuid].abstained).length,
      countdownEndsAt: room.countdownEndsAt || null,
      tallyingEndsAt: room.tallyingEndsAt || null,
      animationStartedAt: room.animationStartedAt || null,
      animationSkippedAt: room.animationSkippedAt || null,
    };
  }

  function publicPlayerNode(player) {
    return {
      name: player.name,
      connected: player.connected !== false,
      joinedAt: player.joinedAt || "",
      lastSeenAt: player.lastSeenAt || "",
      pendingName: player.pendingName || null,
    };
  }

  function playerStatsNode(player) {
    return {
      currentSkill: Number(player.skill || 0),
      stageSkillHistory: player.stageSkillHistory || [],
      updatedAt: player.lastSeenAt || nowIso(),
    };
  }

  function operationNode(item, index) {
    return Object.assign({}, item, { id: item.id || `op-${String(index).padStart(4, "0")}` });
  }

  function keyOperations(items) {
    return (items || []).reduce((acc, item, index) => {
      const node = operationNode(item, index);
      acc[node.id] = node;
      return acc;
    }, {});
  }

  function ticketPresence(room, stageId) {
    const tickets = stageId && room.tickets && room.tickets[stageId] ? room.tickets[stageId] : {};
    return {
      [stageId || "none"]: Object.keys(tickets).reduce((acc, uuid) => {
        acc[uuid] = { status: tickets[uuid].abstained ? "abstained" : "submitted", updatedAt: tickets[uuid].submittedAt || nowIso() };
        return acc;
      }, {}),
    };
  }

  function sanitizeRoom(room, role, uuid, engine) {
    const copy = engine.deepClone(room);
    if (role !== "screen" && role !== "host") {
      copy.tickets = {};
      Object.keys(room.tickets || {}).forEach((stageId) => {
        copy.tickets[stageId] = {};
        if (uuid && room.tickets[stageId] && room.tickets[stageId][uuid]) copy.tickets[stageId][uuid] = room.tickets[stageId][uuid];
      });
    }
    if (role === "player" && uuid) {
      copy.players = (copy.players || []).map((player) => {
        if (player.uuid === uuid) return player;
        return { uuid: player.uuid, name: player.name, connected: player.connected !== false };
      });
    }
    return copy;
  }

  function normalizeRoomShape(room, engine) {
    if (!room) return null;
    const fallback = engine.createInitialRoom(engine.DEFAULT_CONFIG);
    room.config = room.config || fallback.config;
    room.phase = room.phase || fallback.phase;
    room.currentStageIndex = Number(room.currentStageIndex || 0);
    room.players = Array.isArray(room.players) ? room.players : Object.values(room.players || {});
    room.tickets = room.tickets || {};
    room.stageResults = room.stageResults || {};
    room.scores = room.scores || {};
    room.completedGames = Array.isArray(room.completedGames) ? room.completedGames : Object.values(room.completedGames || {});
    room.operations = Array.isArray(room.operations) ? room.operations : Object.values(room.operations || {});
    room.roomVersion = Number(room.roomVersion || 0);
    room.hostUid = room.hostUid || "";
    room.volume = room.volume !== undefined ? room.volume : fallback.volume;
    room.muted = Boolean(room.muted);
    return room;
  }

  function publicPlayers(players) {
    return (players || []).map((player) => ({ uuid: player.uuid, name: player.name }));
  }

  function keyBy(items, key, mapper) {
    return (items || []).reduce((acc, item, index) => {
      const id = item[key] || `item-${index}`;
      acc[id] = mapper(item, index);
      return acc;
    }, {});
  }

  function hostActionFromPath(path) {
    return {
      "/api/host/start-stage": "start-stage",
      "/api/host/open-voting": "open-voting",
      "/api/host/close-voting": "close-voting",
      "/api/host/reveal-result": "tally",
      "/api/host/show-ranking": "show-ranking",
      "/api/host/advance": "next-stage",
      "/api/host/recalculate": "tally",
    }[path] || "";
  }

  function touch(room) {
    room.roomVersion = Number(room.roomVersion || 0) + 1;
    room.updatedAt = nowIso();
  }

  function cleanKey(value) {
    return String(value || "elevator-game-live").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "elevator-game-live";
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  async function loadFirebaseSdk(version) {
    if (root.__evgFirebaseSdk) return root.__evgFirebaseSdk;
    const base = `https://www.gstatic.com/firebasejs/${version}`;
    const [app, auth, database] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-database.js`),
    ]);
    root.__evgFirebaseSdk = Object.assign({}, app, auth, database);
    return root.__evgFirebaseSdk;
  }

  async function currentOrAnonymousUser(sdk, firebaseAuth) {
    if (firebaseAuth.currentUser) return firebaseAuth.currentUser;
    const existing = await new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer = null;
      const finish = (user) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(user);
      };
      timer = setTimeout(() => finish(null), 1000);
      unsubscribe = sdk.onAuthStateChanged(firebaseAuth, finish, () => finish(null));
    });
    if (existing) return existing;
    const credential = await sdk.signInAnonymously(firebaseAuth);
    return credential.user;
  }

  root.EVGFirebaseAdapter = {
    createFirebaseAdapter,
    roomToFirebaseNodes,
    roomFromFirebaseNodes,
    firebaseBaseSubscriptionPaths,
    firebaseStageSubscriptionPaths,
  };
})(typeof self !== "undefined" ? self : this);
