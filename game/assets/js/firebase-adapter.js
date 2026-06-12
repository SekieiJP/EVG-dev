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
      this.mock = Boolean(this.config.FIREBASE_USE_LOCAL_MOCK);
      this.readyPromise = null;
      this.unsubscribe = null;
      this.debug = {
        basePaths: [],
        stagePaths: [],
        role: this.getRole(),
        currentStageId: "",
        isHostAllowed: false,
        lastRulesError: "",
        lastTransactionPublic: null,
        subscriptionErrors: {},
      };
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
      if (this.getRole() === "host") {
        this.debug.isHostAllowed = await this.isHostAllowed();
      }
      return { ok: true, uid: this.auth.uid };
    }

    async listen(callback) {
      await this.init();
      if (this.mock) {
        this.debug = {
          basePaths: ["mock-room"],
          stagePaths: [],
          role: this.getRole(),
          currentStageId: "",
          subscriptionErrors: {},
        };
        const handler = (event) => {
          if (event.data && event.data.type === "room" && event.data.roomId === this.roomId) {
            callback(this.readMockRoom());
          }
        };
        if (this.channel) this.channel.addEventListener("message", handler);
        callback(this.readMockRoom());
        return () => this.channel && this.channel.removeEventListener("message", handler);
      }
      this.unsubscribe = this.listenRest(callback);
      return this.unsubscribe;
    }

    listenRest(callback) {
      const nodes = {};
      const unsubscribers = [];
      const initializedBasePaths = new Set();
      let stageUnsubscribers = [];
      let currentStageId = "";
      this.debug = {
        basePaths: firebaseBaseSubscriptionPaths(this.getRole(), this.auth.uid, this.mock || this.getRole() !== "host" || this.debug.isHostAllowed),
        stagePaths: [],
        role: this.getRole(),
        currentStageId: "",
        isHostAllowed: Boolean(this.debug.isHostAllowed),
        lastRulesError: this.debug.lastRulesError || "",
        lastTransactionPublic: this.debug.lastTransactionPublic || null,
        subscriptionErrors: Object.assign({}, this.debug.subscriptionErrors || {}),
      };
      const handleSubscriptionError = (path, error) => {
        const message = error && error.message ? error.message : String(error || "subscription failed");
        this.debug.subscriptionErrors[path] = message;
        this.debug.lastRulesError = message;
        this.log("firebase.subscribe.error", { path, message });
      };
      const emit = () => {
        if (!initializedBasePaths.has("public") || !nodes.public) return;
        callback(roomFromFirebaseNodes(nodes, this.engine));
      };
      const attach = (path) => {
        const unsubscribe = this.sdk.onValue(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`), (snapshot) => {
          setNestedNode(nodes, path, snapshot.val());
          if (path === `roles/hosts/${this.auth.uid}`) this.debug.isHostAllowed = snapshot.val() === true;
          initializedBasePaths.add(path);
          updateStageSubscriptions();
          emit();
        }, (error) => handleSubscriptionError(path, error));
        unsubscribers.push(unsubscribe);
      };
      const attachStage = (path) => {
        const unsubscribe = this.sdk.onValue(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`), (snapshot) => {
          setNestedNode(nodes, path, snapshot.val());
          emit();
        }, (error) => handleSubscriptionError(path, error));
        stageUnsubscribers.push(unsubscribe);
      };
      const updateStageSubscriptions = () => {
        const stageId = nodes.public && nodes.public.currentStageId ? nodes.public.currentStageId : "";
        if (stageId === currentStageId) return;
        stageUnsubscribers.forEach((unsubscribe) => unsubscribe());
        stageUnsubscribers = [];
        currentStageId = stageId;
        this.debug.currentStageId = stageId;
        this.debug.stagePaths = [];
        if (!stageId) return;
        this.debug.stagePaths = firebaseStageSubscriptionPaths(
          this.getRole(),
          this.auth.uid,
          stageId,
          this.mock || this.getRole() !== "host" || this.debug.isHostAllowed
        );
        this.debug.stagePaths.forEach(attachStage);
      };
      this.debug.basePaths.forEach(attach);
      return () => {
        stageUnsubscribers.forEach((unsubscribe) => unsubscribe());
        unsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    }

    getDebugInfo() {
      return {
        uid: this.auth && this.auth.uid || "",
        mock: this.mock,
        roomId: this.roomId,
        role: this.debug.role || this.getRole(),
        basePaths: this.debug.basePaths || [],
        stagePaths: this.debug.stagePaths || [],
        currentStageId: this.debug.currentStageId || "",
        isHostAllowed: Boolean(this.debug.isHostAllowed),
        lastRulesError: this.debug.lastRulesError || "",
        lastTransactionPublic: this.debug.lastTransactionPublic || null,
        subscriptionErrors: Object.assign({}, this.debug.subscriptionErrors || {}),
      };
    }

    async get(path, payload) {
      await this.init();
      const room = await this.readRoom();
      if (!room) {
        return { ok: false, code: "not_initialized", error: "ゲームルームがまだ初期化されていません。Hostで認証してください。" };
      }
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
        return this.historyGames(room, payload || {});
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
      if (!this.mock) return this.postRestHost(path, payload);
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
      } else if (path === "/api/ticket/submit") {
        result = this.engine.submitTicket(room, payload.uuid, payload.ticket || payload);
      } else if (path === "/api/ticket/abstain") {
        result = this.engine.abstain(room, payload.uuid);
      } else if (path === "/api/host/commit-result") {
        result = this.commitHostResult(room, payload.room, payload.baseVersion);
      } else if (path === "/api/host/remove-player") {
        result = this.engine.removePlayerFromRoom(room, payload.uuid, payload.hostName || "host");
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
      return result;
    }

    async postRestHost(path, payload) {
      const hostAuth = this.verifyHost(payload.hostToken);
      if (!hostAuth.ok) return hostAuth;
      if (!(await this.isHostAllowed())) {
        return { ok: false, code: "auth", error: "このFirebase uidはHost allowlistに登録されていません。" };
      }
      const room = await this.readRoom();
      if (!room && path !== "/api/host/import-config" && path !== "/api/host/update-config") {
        return { ok: false, code: "not_initialized", error: "ゲームルームがまだ初期化されていません。Host認証をやり直してください。" };
      }
      const currentRoom = room || initializedRoom(this.engine, this.roomId, payload.config);
      const result = this.applyMutation(path, payload, currentRoom);
      if (!result.ok) return result;

      if (path === "/api/host/import-config" || path === "/api/host/update-config") {
        const nextRoom = stampHostRoom(result.room, this.roomId, currentRoom);
        await this.writeRestRoomChildren(nextRoom, {
          previousRoom: currentRoom,
          clearVolatile: path === "/api/host/import-config",
        });
        return Object.assign({}, result, { room: this.publicRoom(nextRoom, payload).room });
      }

      const nextRoom = stampHostRoom(result.room, this.roomId, currentRoom);
      const transition = await this.commitPublicTransition(currentRoom, nextRoom);
      if (!transition.ok) return transition;
      await this.writeHostSideEffects(path, currentRoom, nextRoom);
      const refreshed = await this.readRoom();
      return Object.assign({}, result, { room: this.publicRoom(refreshed || nextRoom, payload).room });
    }

    async postRestPlayer(path, payload) {
      const room = await this.readRoom();
      if (!room) return { ok: false, code: "not_initialized", error: "ゲームルームがまだ初期化されていません。" };
      const requestedUuid = String(payload && payload.uuid || this.auth.uid || "").trim();
      if (requestedUuid && requestedUuid !== this.auth.uid) {
        return {
          ok: false,
          code: "uid_mismatch",
          error: "この端末のFirebase uidと復元UUIDが一致しません。同じ端末または同じ認証状態で開き直してください。",
        };
      }
      const playerPayload = Object.assign({}, payload, { uuid: this.auth.uid });
      let result = null;
      if (path === "/api/player/restore") {
        const masterPlayer = await this.readRootPlayer(this.auth.uid);
        result = restorePlayerFromMaster(this.engine, room, this.auth.uid, masterPlayer);
      } else {
        result = this.applyMutation(path, playerPayload, room);
        if (result.ok && path === "/api/player/join") {
          const masterPlayer = await this.readRootPlayer(this.auth.uid);
          if (masterPlayer) {
            result = mergeMasterStatsIntoResult(this.engine, result, this.auth.uid, masterPlayer);
          }
        }
      }
      if (!result.ok) return result;
      const updates = playerUpdates(path, result.room, this.auth.uid);
      if (!Object.keys(updates).length) return { ok: false, code: "not_supported", error: "この操作はFirebase Player更新に未対応です。" };
      await this.writeRestChildUpdates(updates);
      if (["/api/player/join", "/api/player/restore", "/api/player/rename"].includes(path) && result.player) {
        await this.writeRootPlayer(result.player);
      }
      return Object.assign({}, result, { room: this.publicRoom(result.room, playerPayload) });
    }

    async authHost(password) {
      const expected = String(this.config.FIREBASE_HOST_PASSWORD || "host").trim();
      if (String(password || "").trim() !== expected) {
        return { ok: false, code: "auth", error: "パスワードが違います。" };
      }
      try {
        await this.claimHost();
      } catch (error) {
        return {
          ok: false,
          code: error.code || "auth",
          error: error.message === "HOST_UID_NOT_ALLOWED"
            ? "このFirebase uidはHost allowlistに登録されていません。"
            : (error.message || "Host権限を確認できませんでした。"),
        };
      }
      return {
        ok: true,
        hostToken: `firebase-host:${this.auth.uid}:${Date.now()}`,
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        serverTime: nowIso(),
      };
    }

    async claimHost() {
      if (!this.mock) {
        const allowed = await this.isHostAllowed();
        if (!allowed) {
          const error = new Error("HOST_UID_NOT_ALLOWED");
          error.code = "auth";
          throw error;
        }
        const publicSnapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/public`));
        if (!publicSnapshot.exists()) {
          await this.writeRestRoomChildren(initializedRoom(this.engine, this.roomId));
        } else {
          await this.sdk.set(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/meta/updatedAt`), nowIso());
        }
        return;
      }
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
      const completedGames = (room.completedGames || []).filter((game) => playerParticipatedInGame(game, uuid));
      const completedStages = completedGames
        .flatMap((game) => Object.values(game.stageResults || {}))
        .map((stageResult) => stageResult.players && stageResult.players[uuid])
        .filter(Boolean);
      const allStages = completedStages.concat(stages);
      const roomPlayer = (room.players || []).find((player) => player.uuid === uuid) || {};
      const historySkills = Array.isArray(roomPlayer.stageSkillHistory) ? roomPlayer.stageSkillHistory : Object.values(roomPlayer.stageSkillHistory || {});
      const fallbackSkills = allStages.map((stage) => stage.stageSkill).filter((value) => value !== null && value !== undefined);
      const stageSkills = (historySkills.length ? historySkills : fallbackSkills)
        .map((value) => Number(value || 0))
        .filter((value) => Number.isFinite(value));
      return {
        ok: true,
        games: completedGames,
        stages: allStages,
        summary: {
          uuid,
          currentSkill: Number(roomPlayer.skill || 0),
          averageSkill: stageSkills.length ? stageSkills.reduce((sum, value) => sum + value, 0) / stageSkills.length : 0,
          totalSkill: stageSkills.reduce((sum, value) => sum + value, 0),
          bestScore: allStages.length ? Math.max(...allStages.map((stage) => Number(stage.score || 0))) : 0,
          gameCount: completedGames.length + (stages.length ? 1 : 0),
          stageCount: allStages.length,
          forcedOffCount: allStages.filter((stage) => stage.forcedOff).length,
          predictionAccuracy: predictionAccuracy(allStages),
          wins: completedGames.filter((game) => (game.rankings || []).some((row) => row.uuid === uuid && row.rank === 1)).length,
        },
      };
    }

    historyGames(room, payload) {
      const summaries = room.completedGameSummaries || completedGameSummaries(room.completedGames || []);
      const isHost = payload && payload.role === "host" && this.debug.isHostAllowed;
      const uuid = payload && payload.uuid || "";
      return {
        ok: true,
        summaries,
        games: isHost ? (room.completedGames || []) : (room.completedGames || []).filter((game) => uuid && playerParticipatedInGame(game, uuid)),
        players: publicPlayers(room.players || []),
      };
    }

    async readRoom() {
      const room = this.mock ? this.readMockRoom() : await this.readRestRoom();
      return room || (this.mock ? this.engine.createInitialRoom(this.engine.DEFAULT_CONFIG) : null);
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
      const base = await this.readRestNodes(restBaseReadPaths(this.getRole(), this.auth.uid, this.mock || this.getRole() !== "host" || this.debug.isHostAllowed));
      if (!base.public) return null;
      if (base.roles && base.roles.hosts && base.roles.hosts[this.auth.uid]) this.debug.isHostAllowed = true;
      const stageId = currentStageIdFromNodes(base);
      if (stageId) {
        const stage = await this.readRestNodes(firebaseStageSubscriptionPaths(
          this.getRole(),
          this.auth.uid,
          stageId,
          this.mock || this.getRole() !== "host" || this.debug.isHostAllowed
        ));
        mergeNodes(base, stage);
      }
      return roomFromFirebaseNodes(base, this.engine);
    }

    async readRestNodes(paths) {
      const pairs = await Promise.all(paths.map(async (path) => {
        try {
          const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`));
          return [path, snapshot.exists() ? snapshot.val() : null];
        } catch (error) {
          const message = `${error && error.message ? error.message : String(error)} at ${path}`;
          const nextError = new Error(message);
          nextError.code = error && error.code;
          this.debug.lastRulesError = message;
          throw nextError;
        }
      }));
      const nodes = {};
      pairs.forEach(([path, value]) => setNestedNode(nodes, path, value));
      return nodes;
    }

    async writeRestRoom(room) {
      await this.writeRestRoomChildren(room);
      return { ok: true };
    }

    async writeRestRoomChildren(room, options = {}) {
      room.roomId = this.roomId;
      const nodes = roomToFirebaseNodes(room);
      delete nodes.roles;
      const writes = [];
      const publicNode = nodes.public;
      delete nodes.public;
      delete nodes.tickets;
      delete nodes.ticketPresence;
      delete nodes.results;
      if (options.clearVolatile && options.previousRoom) {
        volatileStageIds(options.previousRoom).forEach((stageId) => {
          writes.push([`tickets/${stageId}`, null]);
          writes.push([`ticketPresence/${stageId}`, null]);
          writes.push([`results/${stageId}`, null]);
        });
      }
      Object.keys(nodes).forEach((key) => {
        writes.push([key, emptyObjectToNull(nodes[key])]);
      });
      if (publicNode) writes.push(["public", publicNode]);
      if (this.sdk.update) {
        const updates = writes.reduce((acc, [path, value]) => {
          acc[path] = value;
          return acc;
        }, {});
        await this.sdk.update(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}`), updates);
        return { ok: true };
      }
      for (const [path, value] of writes) {
        await this.sdk.set(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`), value);
      }
      return { ok: true };
    }

    async writeRestChildUpdates(updates) {
      await Promise.all(Object.keys(updates).map((path) => {
        return this.sdk.set(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}`), emptyObjectToNull(updates[path]));
      }));
    }

    async readRootPlayer(uid) {
      if (!uid) return null;
      const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/players/${uid}`));
      return snapshot.exists() ? snapshot.val() : null;
    }

    async writeRootPlayer(player) {
      if (!player || !player.uuid) return;
      await this.sdk.set(this.sdk.ref(this.firebaseDb, `/players/${player.uuid}`), rootPlayerNode(player, this.roomId));
    }

    async writeRootPlayersFromRoom(room) {
      const players = (room && room.players || []).filter((player) => player && player.uuid);
      if (!players.length) return;
      if (this.sdk.update) {
        const updates = players.reduce((acc, player) => {
          acc[`players/${player.uuid}`] = rootPlayerNode(player, this.roomId);
          return acc;
        }, {});
        await this.sdk.update(this.sdk.ref(this.firebaseDb), updates);
        return;
      }
      await Promise.all(players.map((player) => this.writeRootPlayer(player)));
    }

    async isHostAllowed() {
      if (this.mock) return true;
      const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/roles/hosts/${this.auth.uid}`));
      const allowed = snapshot.exists() && snapshot.val() === true;
      this.debug.isHostAllowed = allowed;
      return allowed;
    }

    async commitPublicTransition(currentRoom, nextRoom) {
      const expected = compactStatus(currentRoom);
      const nextPublic = compactStatus(nextRoom);
      let transactionPublic = null;
      try {
        const transaction = await this.sdk.runTransaction(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/public`), (currentPublic) => {
          transactionPublic = currentPublic;
          this.debug.lastTransactionPublic = currentPublic || null;
          if (!publicMatches(currentPublic, expected)) return;
          return nextPublic;
        }, { applyLocally: false });
        if (!transaction.committed) {
          return {
            ok: false,
            code: "version_conflict",
            error: "DB上のフェーズまたはバージョンが更新されています。再読み込みしてください。",
            debug: { expectedPublic: expected, transactionPublic },
          };
        }
        return { ok: true };
      } catch (error) {
        this.debug.lastRulesError = error.message || String(error);
        return { ok: false, code: "rules", error: error.message || "Firebase Rulesにより更新が拒否されました。" };
      }
    }

    async writeHostSideEffects(path, currentRoom, nextRoom) {
      const updates = {};
      const nodes = roomToFirebaseNodes(nextRoom);
      updates["meta"] = nodes.meta;
      updates["operations"] = nodes.operations;
      if (path === "/api/host/commit-result") {
        const stage = this.engine.getCurrentStage(currentRoom);
        const stageId = stage && stage.stageId;
        if (stageId) updates[`results/${stageId}`] = nodes.results && nodes.results[stageId] || null;
        updates["scores"] = nodes.scores;
        updates["playerStats"] = nodes.playerStats;
      }
      if (path === "/api/host/start-stage" || path === "/api/host/advance") {
        updates["players"] = nodes.players;
        updates["playerStats"] = nodes.playerStats;
      }
      if (path === "/api/host/remove-player") {
        removedPlayerUids(currentRoom, nextRoom).forEach((uid) => {
          updates[`players/${uid}`] = null;
          updates[`playerStats/${uid}`] = null;
          updates[`scores/${uid}`] = null;
          Object.keys(currentRoom.tickets || {}).forEach((stageId) => {
            if (currentRoom.tickets[stageId] && currentRoom.tickets[stageId][uid]) updates[`tickets/${stageId}/${uid}`] = null;
          });
          Object.keys(currentRoom.ticketPresence || {}).forEach((stageId) => {
            if (currentRoom.ticketPresence[stageId] && currentRoom.ticketPresence[stageId][uid]) updates[`ticketPresence/${stageId}/${uid}`] = null;
          });
          Object.keys(currentRoom.stageResults || {}).forEach((stageId) => {
            const currentResult = currentRoom.stageResults[stageId];
            if (!currentResult || !currentResult.players || !currentResult.players[uid]) return;
            const nextResult = nextRoom.stageResults && nextRoom.stageResults[stageId] || {};
            updates[`results/${stageId}/players/${uid}`] = null;
            updates[`results/${stageId}/rankings`] = nextResult.rankings || [];
            updates[`results/${stageId}/timeline`] = nextResult.timeline || [];
            updates[`results/${stageId}/stats`] = nextResult.stats || {};
          });
        });
      }
      await this.writeRestChildUpdates(updates);
      if (["/api/host/commit-result", "/api/host/start-stage", "/api/host/advance"].includes(path)) {
        await this.writeRootPlayersFromRoom(nextRoom);
      }
    }
  }

  function roomToFirebaseNodes(room) {
    const stage = room.config && room.config.stages ? room.config.stages[room.currentStageIndex || 0] : null;
    return {
      meta: {
        roomId: room.roomId || "",
        title: room.config && room.config.gameMeta ? room.config.gameMeta.title : "エレベーターゲーム",
        schemaVersion: "firebase-rtdb-v2",
        activeGameId: room.gameId || "",
        status: room.phase === "final" ? "finished" : "active",
        createdAt: room.createdAt || nowIso(),
        updatedAt: room.updatedAt || nowIso(),
      },
      public: compactStatus(room),
      config: room.config || null,
      players: keyBy(room.players || [], "uuid", publicPlayerNode),
      playerStats: keyBy(room.players || [], "uuid", playerStatsNode),
      tickets: room.tickets || {},
      ticketPresence: ticketPresence(room, stage && stage.stageId),
      results: room.stageResults || {},
      completedGameSummaries: keyBy(completedGameSummaries(room.completedGames || []), "gameId", (summary) => summary),
      completedGameDetails: keyBy(room.completedGames || [], "gameId", completedGameDetailNode),
      completedGamePlayerDetails: completedGamePlayerDetails(room.completedGames || []),
      scores: Object.keys(room.scores || {}).reduce((acc, uuid) => {
        acc[uuid] = { total: room.scores[uuid], updatedAt: room.updatedAt || nowIso() };
        return acc;
      }, {}),
      operations: keyOperations(room.operations || []),
      roomSettings: {
        volume: room.volume !== undefined ? room.volume : 0.8,
        bgmVolume: room.bgmVolume !== undefined ? room.bgmVolume : (room.volume !== undefined ? room.volume : 0.8),
        seVolume: room.seVolume !== undefined ? room.seVolume : (room.volume !== undefined ? room.volume : 0.8),
        muted: Boolean(room.muted),
        bgmMuted: room.bgmMuted !== undefined ? Boolean(room.bgmMuted) : Boolean(room.muted),
        seMuted: room.seMuted !== undefined ? Boolean(room.seMuted) : Boolean(room.muted),
      },
      archive: room.archive || null,
    };
  }

  function roomFromFirebaseNodes(nodes, engine) {
    if (!nodes) return null;
    if (nodes.snapshot && !nodes.public && !nodes.players) return normalizeRoomShape(nodes.snapshot, engine);
    if (isLegacyRoomNodes(nodes)) {
      return normalizeRoomShape(nodes, engine);
    }
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
    const completedGameDetails = normalizeCompletedGames(nodes.completedGameDetails || nodes.completedGames || {});
    const completedGameSummariesValue = normalizeCompletedGameSummaries(
      nodes.completedGameSummaries || keyBy(completedGameSummaries(completedGameDetails), "gameId", (summary) => summary)
    );
    const uid = firstPlayerDetailUid(nodes.completedGamePlayerDetails);
    const personalCompletedGames = uid
      ? normalizeCompletedGames(nodes.completedGamePlayerDetails[uid] || {})
      : [];
    const completedGames = completedGameDetails.length ? completedGameDetails : mergePersonalGamesWithSummaries(personalCompletedGames, completedGameSummariesValue);
    return normalizeRoomShape({
      roomId: nodes.meta && nodes.meta.roomId || fallback.roomId,
      hostUid: firstHostUid(nodes.roles) || (nodes.meta && nodes.meta.hostUid) || "",
      gameId: status.gameId || (nodes.meta && nodes.meta.activeGameId) || fallback.gameId,
      config: nodes.config || fallback.config,
      phase: status.phase || fallback.phase,
      currentStageIndex: Number(status.currentStageIndex || 0),
      players,
      tickets: nodes.tickets || {},
      stageResults: normalizeStageResults(nodes.results || {}),
      scores,
      completedGames,
      completedGameSummaries: completedGameSummariesValue,
      operations: Object.values(nodes.operations || {}).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))),
      countdownEndsAt: status.countdownEndsAt || null,
      tallyingEndsAt: status.tallyingEndsAt || null,
      animationStartedAt: status.animationStartedAt || null,
      animationSkippedAt: status.animationSkippedAt || null,
      revealEndsAt: status.revealEndsAt || null,
      roomVersion: Number(status.roomVersion || 0),
      ticketPresence: nodes.ticketPresence || {},
      archive: nodes.archive || null,
      volume: settings.volume !== undefined ? Number(settings.volume) : fallback.volume,
      bgmVolume: settings.bgmVolume !== undefined ? Number(settings.bgmVolume) : (settings.volume !== undefined ? Number(settings.volume) : fallback.bgmVolume),
      seVolume: settings.seVolume !== undefined ? Number(settings.seVolume) : (settings.volume !== undefined ? Number(settings.volume) : fallback.seVolume),
      muted: Boolean(settings.muted),
      bgmMuted: settings.bgmMuted !== undefined ? Boolean(settings.bgmMuted) : Boolean(settings.muted),
      seMuted: settings.seMuted !== undefined ? Boolean(settings.seMuted) : Boolean(settings.muted),
      createdAt: nodes.meta && nodes.meta.createdAt || fallback.createdAt,
      updatedAt: nodes.meta && nodes.meta.updatedAt || fallback.updatedAt,
    }, engine);
  }

  function isPlayerWritePath(path) {
    return [
      "/api/player/join",
      "/api/player/restore",
      "/api/player/rename",
      "/api/ticket/submit",
      "/api/ticket/abstain",
    ].includes(path);
  }

  function isLegacyRoomNodes(nodes) {
    return Boolean(nodes && !nodes.public && (nodes.phase || Array.isArray(nodes.players) || nodes.stageResults || nodes.currentStageIndex !== undefined));
  }

  function firebaseBaseSubscriptionPaths(role, uid, hostAllowed = true) {
    const common = ["meta", "public", "config", "roomSettings"];
    if (role === "host") {
      if (!hostAllowed) return common.concat([`roles/hosts/${uid}`]);
      return common.concat([`roles/hosts/${uid}`, "players", "playerStats", "scores", "completedGameSummaries", "completedGameDetails", "operations", "archive"]);
    }
    if (role === "screen") {
      return common.concat(["players", "scores"]);
    }
    if (role === "history") {
      return common.concat(["players", `playerStats/${uid}`, "scores", "completedGameSummaries", `completedGamePlayerDetails/${uid}`]);
    }
    return common.concat(["players", `players/${uid}`, `playerStats/${uid}`, `scores/${uid}`, "completedGameSummaries", `completedGamePlayerDetails/${uid}`]);
  }

  function firebaseStageSubscriptionPaths(role, uid, stageId, hostAllowed = true) {
    if (role === "host") {
      if (!hostAllowed) return [];
      return [`ticketPresence/${stageId}`, `tickets/${stageId}`, `results/${stageId}`];
    }
    if (role === "screen") {
      return [`ticketPresence/${stageId}`, `results/${stageId}`];
    }
    if (role === "player") {
      return [`ticketPresence/${stageId}/${uid}`, `tickets/${stageId}/${uid}`, `results/${stageId}/players/${uid}`, `results/${stageId}/rankings`];
    }
    return [];
  }

  function restBaseReadPaths(role, uid, hostAllowed) {
    return firebaseBaseSubscriptionPaths(role, uid, hostAllowed);
  }

  function volatileStageIds(room) {
    const ids = new Set(Object.keys(room.tickets || {}));
    Object.keys(room.ticketPresence || {}).forEach((stageId) => ids.add(stageId));
    Object.keys(room.stageResults || {}).forEach((stageId) => ids.add(stageId));
    const stages = room.config && room.config.stages ? room.config.stages : [];
    stages.forEach((stage) => {
      if (stage && stage.stageId) ids.add(stage.stageId);
    });
    return Array.from(ids).filter(Boolean);
  }

  function removedPlayerUids(currentRoom, nextRoom) {
    const nextUids = new Set((nextRoom.players || []).map((player) => player.uuid));
    return (currentRoom.players || [])
      .map((player) => player.uuid)
      .filter((uuid) => uuid && !nextUids.has(uuid));
  }

  function normalizeStageResults(results) {
    return Object.keys(results || {}).reduce((acc, stageId) => {
      acc[stageId] = normalizeStageResult(results[stageId]);
      return acc;
    }, {});
  }

  function normalizeCompletedGames(games) {
    return Object.values(games || {}).map((game) => {
      if (!game || typeof game !== "object") return game;
      const next = Object.assign({}, game);
      next.rankings = arrayFromFirebase(next.rankings);
      next.stageResults = normalizeStageResults(next.stageResults || {});
      return next;
    });
  }

  function normalizeCompletedGameSummaries(summaries) {
    return Object.values(summaries || {}).map((summary) => {
      if (!summary || typeof summary !== "object") return summary;
      const next = Object.assign({}, summary);
      next.rankings = arrayFromFirebase(next.rankings);
      next.stages = arrayFromFirebase(next.stages);
      return next;
    });
  }

  function completedGameSummaries(games) {
    return (games || []).map(completedGameSummaryNode);
  }

  function completedGameSummaryNode(game) {
    const stageResults = game && game.stageResults || {};
    return {
      gameId: game.gameId || "",
      title: game.title || "game",
      finishedAt: game.finishedAt || "",
      interrupted: Boolean(game.interrupted),
      finalPhase: game.finalPhase || "",
      rankings: game.rankings || [],
      playerCount: Object.keys(game.scores || {}).length,
      stageCount: Object.keys(stageResults).length,
      stages: Object.keys(stageResults).map((stageId) => ({
        stageId,
        name: stageResults[stageId] && stageResults[stageId].stageName || stageId,
      })),
    };
  }

  function completedGameDetailNode(game) {
    return game || null;
  }

  function completedGamePlayerDetails(games) {
    return (games || []).reduce((acc, game) => {
      const uuids = new Set(Object.keys(game.scores || {}));
      Object.values(game.stageResults || {}).forEach((stageResult) => {
        Object.keys(stageResult.players || {}).forEach((uuid) => uuids.add(uuid));
      });
      uuids.forEach((uuid) => {
        acc[uuid] = acc[uuid] || {};
        acc[uuid][game.gameId] = completedGameForPlayer(game, uuid);
      });
      return acc;
    }, {});
  }

  function completedGameForPlayer(game, uuid) {
    const stageResults = Object.keys(game.stageResults || {}).reduce((acc, stageId) => {
      const stageResult = game.stageResults[stageId] || {};
      const playerResult = stageResult.players && stageResult.players[uuid];
      if (!playerResult) return acc;
      acc[stageId] = {
        stageId: stageResult.stageId || stageId,
        params: stageResult.params || null,
        rankings: stageResult.rankings || [],
        players: { [uuid]: playerResult },
      };
      return acc;
    }, {});
    return {
      gameId: game.gameId || "",
      title: game.title || "game",
      finishedAt: game.finishedAt || "",
      interrupted: Boolean(game.interrupted),
      finalPhase: game.finalPhase || "",
      scores: { [uuid]: Number((game.scores || {})[uuid] || 0) },
      rankings: game.rankings || [],
      stageResults,
    };
  }

  function firstPlayerDetailUid(details) {
    return Object.keys(details || {})[0] || "";
  }

  function mergePersonalGamesWithSummaries(personalGames, summaries) {
    const summaryById = keyBy(summaries || [], "gameId", (summary) => summary);
    return (personalGames || []).map((game) => {
      const summary = summaryById[game.gameId] || {};
      return Object.assign({}, summary, game, {
        rankings: summary.rankings || game.rankings || [],
      });
    });
  }

  function normalizeStageResult(result) {
    if (!result || typeof result !== "object") return result;
    const next = Object.assign({}, result);
    next.timeline = arrayFromFirebase(next.timeline).map(normalizeTimelineStep);
    next.rankings = arrayFromFirebase(next.rankings);
    next.players = Object.keys(next.players || {}).reduce((acc, uuid) => {
      const player = Object.assign({}, next.players[uuid]);
      player.successfulIntervals = arrayFromFirebase(player.successfulIntervals);
      player.predictionBreakdown = arrayFromFirebase(player.predictionBreakdown);
      player.eventBreakdown = arrayFromFirebase(player.eventBreakdown);
      acc[uuid] = player;
      return acc;
    }, {});
    return next;
  }

  function normalizeTimelineStep(step) {
    if (!step || typeof step !== "object") return step;
    const next = Object.assign({}, step);
    ["boarding", "exiting", "passengersBeforeCheck", "passengersAfterCheck", "forcedOff"].forEach((key) => {
      next[key] = arrayFromFirebase(next[key]);
    });
    return next;
  }

  function arrayFromFirebase(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return [];
    return Object.keys(value)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => value[key]);
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

  function mergeNodes(target, source) {
    Object.keys(source || {}).forEach((key) => {
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        target[key] = target[key] || {};
        mergeNodes(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    });
    return target;
  }

  function currentStageIdFromNodes(nodes) {
    if (nodes.public && nodes.public.currentStageId) return nodes.public.currentStageId;
    const index = nodes.public ? Number(nodes.public.currentStageIndex || 0) : 0;
    const stages = nodes.config && nodes.config.stages ? nodes.config.stages : [];
    const stage = stages[index] || null;
    return stage && stage.stageId || "";
  }

  function initializedRoom(engine, roomId, config) {
    const room = engine.createInitialRoom(config || engine.DEFAULT_CONFIG);
    room.roomId = roomId;
    room.updatedAt = nowIso();
    return room;
  }

  function stampHostRoom(room, roomId, previousRoom) {
    const next = room || {};
    next.roomId = roomId;
    if (previousRoom && next.gameId === previousRoom.gameId) {
      next.roomVersion = Number(previousRoom.roomVersion || 0) + 1;
      next.createdAt = previousRoom.createdAt || next.createdAt;
    } else {
      next.roomVersion = Number(next.roomVersion || 0);
    }
    next.updatedAt = nowIso();
    return next;
  }

  function publicMatches(actual, expected) {
    if (!actual || !expected) return false;
    return String(actual.gameId || "") === String(expected.gameId || "") &&
      String(actual.phase || "") === String(expected.phase || "") &&
      String(actual.currentStageId || "") === String(expected.currentStageId || "") &&
      Number(actual.currentStageIndex || 0) === Number(expected.currentStageIndex || 0) &&
      Number(actual.roomVersion || 0) === Number(expected.roomVersion || 0);
  }

  function emptyObjectToNull(value) {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return null;
    return value;
  }

  function firstHostUid(roles) {
    const hosts = roles && roles.hosts ? roles.hosts : {};
    return Object.keys(hosts).find((uid) => hosts[uid] === true) || "";
  }

  function playerUpdates(path, room, uid) {
    const nodes = roomToFirebaseNodes(room);
    const updates = {};
    if (path.indexOf("/api/player/") === 0 && nodes.players && nodes.players[uid]) {
      updates[`players/${uid}`] = nodes.players[uid];
      if (nodes.playerStats && nodes.playerStats[uid]) updates[`playerStats/${uid}`] = nodes.playerStats[uid];
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

  function rootPlayerNode(player, roomId) {
    return {
      name: player.name || player.uuid,
      currentSkill: Number(player.skill || 0),
      stageSkillHistory: player.stageSkillHistory || [],
      joinedAt: player.joinedAt || "",
      lastSeenAt: player.lastSeenAt || nowIso(),
      updatedAt: nowIso(),
      roomId: roomId || "",
    };
  }

  function restorePlayerFromMaster(engine, room, uid, masterPlayer) {
    if (!masterPlayer) return { ok: false, code: "not_found", error: "UUIDが見つかりません。" };
    const cleanName = String(masterPlayer.name || uid || "").trim().slice(0, 24);
    if (!cleanName) return { ok: false, code: "bad_player", error: "保存データに名前がありません。" };
    const duplicateName = (room.players || []).find((player) => player.uuid !== uid && player.name === cleanName);
    if (duplicateName) return { ok: false, code: "duplicate_name", error: "保存名が現在ゲーム内で使われています。Hostに確認してください。" };
    const next = engine.deepClone(room);
    let player = (next.players || []).find((item) => item.uuid === uid);
    if (!player) {
      player = {
        uuid: uid,
        name: cleanName,
        joinedAt: nowIso(),
        connected: true,
        lastSeenAt: nowIso(),
        skill: Number(masterPlayer.currentSkill || masterPlayer.skill || 0),
        stageSkillHistory: normalizeSkillHistory(masterPlayer.stageSkillHistory),
      };
      next.players.push(player);
      next.scores[uid] = next.scores[uid] || 0;
    } else {
      player.name = cleanName;
      player.pendingName = null;
      player.connected = true;
      player.lastSeenAt = nowIso();
      player.skill = Number(masterPlayer.currentSkill || masterPlayer.skill || 0);
      player.stageSkillHistory = normalizeSkillHistory(masterPlayer.stageSkillHistory);
    }
    next.updatedAt = nowIso();
    return { ok: true, room: next, player };
  }

  function mergeMasterStatsIntoResult(engine, result, uid, masterPlayer) {
    if (!result || !result.ok || !masterPlayer) return result;
    const next = engine.deepClone(result.room);
    const player = (next.players || []).find((item) => item.uuid === uid);
    if (!player) return result;
    player.skill = Number(masterPlayer.currentSkill || masterPlayer.skill || 0);
    player.stageSkillHistory = normalizeSkillHistory(masterPlayer.stageSkillHistory);
    player.lastSeenAt = nowIso();
    return Object.assign({}, result, { room: next, player });
  }

  function normalizeSkillHistory(value) {
    return arrayFromFirebase(value).map((item) => Number(item || 0)).filter((item) => Number.isFinite(item));
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
      revealEndsAt: room.revealEndsAt || null,
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
    return Object.assign({}, item, { id: item.id || createOperationId(item, index) });
  }

  function createOperationId(item, index) {
    const time = Date.parse(item && item.at || "");
    const stamp = Number.isFinite(time) ? time.toString(36) : Date.now().toString(36);
    const seed = [
      item && item.at || "",
      item && (item.actorUid || item.actor) || "",
      item && item.action || "",
      item && item.uuid || "",
      index,
    ].join("|");
    return `op-${stamp}-${shortHash(seed)}`;
  }

  function shortHash(value) {
    let hash = 0;
    String(value || "").split("").forEach((char) => {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    });
    return Math.abs(hash).toString(36).slice(0, 4).padStart(4, "0");
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
    room.completedGameSummaries = Array.isArray(room.completedGameSummaries) ? room.completedGameSummaries : Object.values(room.completedGameSummaries || {});
    room.operations = Array.isArray(room.operations) ? room.operations : Object.values(room.operations || {});
    room.roomVersion = Number(room.roomVersion || 0);
    room.hostUid = room.hostUid || "";
    room.ticketPresence = room.ticketPresence || {};
    room.archive = room.archive || null;
    room.revealEndsAt = room.revealEndsAt || null;
    room.volume = room.volume !== undefined ? room.volume : fallback.volume;
    room.muted = Boolean(room.muted);
    room.bgmVolume = room.bgmVolume !== undefined ? room.bgmVolume : room.volume;
    room.seVolume = room.seVolume !== undefined ? room.seVolume : room.volume;
    room.bgmMuted = room.bgmMuted !== undefined ? Boolean(room.bgmMuted) : room.muted;
    room.seMuted = room.seMuted !== undefined ? Boolean(room.seMuted) : room.muted;
    return room;
  }

  function publicPlayers(players) {
    return (players || []).map((player) => ({ uuid: player.uuid, name: player.name }));
  }

  function playerParticipatedInGame(game, uuid) {
    if (!game || !uuid) return false;
    if ((game.scores || {})[uuid] !== undefined) return true;
    return Object.values(game.stageResults || {}).some((stageResult) => stageResult.players && stageResult.players[uuid]);
  }

  function predictionAccuracy(stageResults) {
    const answers = (stageResults || [])
      .flatMap((stageResult) => stageResult.predictionBreakdown || [])
      .filter((item) => !item.noAnswer);
    if (!answers.length) return null;
    return answers.filter((item) => item.matched).length / answers.length;
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
    playerUpdates,
    rootPlayerNode,
    restorePlayerFromMaster,
  };
})(typeof self !== "undefined" ? self : this);
