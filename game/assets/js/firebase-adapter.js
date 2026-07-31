(function (root) {
  const MOCK_DB_KEY = "evg.firebase.mock.db.v1";
  const AUTH_KEY = "evg.firebase.auth.v1";
  const CHANNEL_NAME = "evg.firebase.mock.channel.v1";
  const FIREBASE_SCHEMA_VERSION = "firebase-rtdb-v3-skill-history";

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
      this.onServerTimeOffset = options.onServerTimeOffset || (() => {});
      this.channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
      this.roomId = cleanKey(this.config.FIREBASE_ROOM_ID || "elevator-game-live");
      this.authStorageKey = mockAuthStorageKey();
      this.auth = loadJson(this.authStorageKey, null);
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
        serverTimeOffsetMs: 0,
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
        localStorage.setItem(this.authStorageKey, JSON.stringify(this.auth));
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
      localStorage.setItem(this.authStorageKey, JSON.stringify(this.auth));
      this.firebaseDb = sdk.getDatabase(this.firebaseApp);
      this.serverTimeOffsetUnsubscribe = sdk.onValue(
        sdk.ref(this.firebaseDb, "/.info/serverTimeOffset"),
        (snapshot) => {
          const offset = Number(snapshot.val() || 0);
          this.debug.serverTimeOffsetMs = Number.isFinite(offset) ? offset : 0;
          this.onServerTimeOffset(this.debug.serverTimeOffsetMs);
        },
        (error) => {
          const message = error && error.message ? error.message : String(error || "server time offset subscription failed");
          this.debug.subscriptionErrors[".info/serverTimeOffset"] = message;
          this.log("firebase.server-time.error", { message });
        }
      );
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
      let lobbyHistoryUnsubscribe = null;
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
        serverTimeOffsetMs: Number(this.debug.serverTimeOffsetMs || 0),
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
          updateLobbyHistorySubscription();
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
      const updateLobbyHistorySubscription = () => {
        if (this.getRole() !== "player") return;
        const shouldListen = Boolean(nodes.public && nodes.public.phase === "lobby");
        if (shouldListen && !lobbyHistoryUnsubscribe) {
          lobbyHistoryUnsubscribe = this.sdk.onValue(
            this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/historyPlayers`),
            (snapshot) => {
              nodes.historyPlayers = snapshot.val();
              emit();
            },
            (error) => handleSubscriptionError("historyPlayers", error)
          );
        } else if (!shouldListen && lobbyHistoryUnsubscribe) {
          lobbyHistoryUnsubscribe();
          lobbyHistoryUnsubscribe = null;
          delete nodes.historyPlayers;
        }
      };
      this.debug.basePaths.forEach(attach);
      return () => {
        if (lobbyHistoryUnsubscribe) lobbyHistoryUnsubscribe();
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
        serverTimeOffsetMs: Number(this.debug.serverTimeOffsetMs || 0),
      };
    }

    serverNowIso() {
      return new Date(Date.now() + Number(this.debug.serverTimeOffsetMs || 0)).toISOString();
    }

    async get(path, payload) {
      await this.init();
      payload = payload || {};
      if (path === "/api/host/game-configs") {
        const hostAuth = this.verifyHost(payload.hostToken);
        if (!hostAuth.ok) return hostAuth;
        if (!(await this.isHostAllowed())) return { ok: false, code: "auth", error: "このFirebase uidはHost allowlistに登録されていません。" };
        return {
          ok: true,
          configs: await this.readGameConfigs(),
          serverTime: nowIso(),
        };
      }
      if (path.indexOf("/api/history/game/") === 0) {
        const gameId = decodedFirebaseExistingKey(path.split("/").pop());
        if (!gameId) return { ok: false, code: "bad_request", error: "gameIdを指定してください。" };
        const hostAuth = this.verifyHost(payload.hostToken);
        const canReadHostDetail = hostAuth.ok && await this.isHostAllowed();
        const game = await this.readCompletedGameDetail(gameId, canReadHostDetail);
        return game
          ? { ok: true, game, detailScope: canReadHostDetail ? "host" : "public" }
          : { ok: false, code: "not_found", error: "ゲーム履歴が見つかりません。" };
      }
      if (path.indexOf("/api/history/player-master/") === 0) {
        const uuid = path.split("/").pop();
        if (!uuid || uuid !== this.auth.uid || uuid !== payload.uuid) {
          return { ok: false, code: "forbidden", error: "自分自身の戦績のみ取得できます。" };
        }
        const player = await this.readRootPlayer(uuid);
        return player ? { ok: true, player: masterPlayerForHistory(uuid, player) } : { ok: false, code: "not_found", error: "UUIDが見つかりません。" };
      }
      if (path === "/api/history/games" && payload.includeDetail && (payload.detailGameId || payload.gameId)) {
        const gameId = firebaseExistingKey(payload.detailGameId || payload.gameId);
        if (!gameId) return { ok: false, code: "bad_request", error: "gameIdが不正です。" };
        const hostAuth = this.verifyHost(payload.hostToken);
        const canReadHostDetail = hostAuth.ok && await this.isHostAllowed();
        const detail = await this.readCompletedGameDetail(gameId, canReadHostDetail);
        return detail
          ? { ok: true, detail, game: detail, detailScope: canReadHostDetail ? "host" : "public" }
          : { ok: false, code: "not_found", error: "ゲーム履歴が見つかりません。" };
      }
      const room = await this.readRoom();
      if (!room) {
        return { ok: false, code: "not_initialized", error: "ゲームルームがまだ初期化されていません。Hostで認証してください。" };
      }
      if (path === "/api/status" || path === "/api/room/state" || path === "/api/screen/state") {
        return this.publicStatus(room, payload || {});
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
        result = this.engine.submitTicket(room, payload.uuid, payload.ticket || payload, this.serverNowIso());
      } else if (path === "/api/ticket/abstain") {
        result = this.engine.abstain(room, payload.uuid, this.serverNowIso());
      } else if (path === "/api/host/commit-result") {
        result = this.commitHostResult(room, payload.room, payload.baseVersion);
      } else if (path === "/api/host/remove-player") {
        result = this.engine.removePlayerFromRoom(room, payload.uuid, payload.hostName || "host");
      } else if (path === "/api/host/update-room-settings") {
        result = this.engine.updateRoomSettings(room, payload, payload.hostName || "host", this.serverNowIso());
      } else if (path === "/api/host/import-config") {
        const nextRoom = room.players.length || Object.keys(room.stageResults || {}).length
          ? this.engine.createNextGameRoom(room, payload.config, this.serverNowIso())
          : this.engine.createInitialRoom(payload.config);
        nextRoom.countdownSeconds = room.countdownSeconds;
        result = { ok: true, room: nextRoom };
      } else if (path === "/api/host/update-config") {
        const next = this.engine.deepClone(room);
        next.config = this.engine.normalizeConfig(payload.config);
        next.roomVersion = Number(next.roomVersion || 0) + 1;
        next.updatedAt = nowIso();
        result = { ok: true, room: next };
      } else if (path === "/api/host/start-game-config") {
        if (payload.config) {
          const nextRoom = room.players.length || Object.keys(room.stageResults || {}).length
            ? this.engine.createNextGameRoom(room, payload.config, this.serverNowIso())
            : this.engine.createInitialRoom(payload.config);
          nextRoom.countdownSeconds = room.countdownSeconds;
          result = { ok: true, room: nextRoom };
        } else {
          result = { ok: false, code: "not_found", error: "次ゲーム設定が見つかりません。" };
        }
      } else if (path.indexOf("/api/host/") === 0) {
        const hostAuth = this.verifyHost(payload.hostToken);
        if (!hostAuth.ok) return hostAuth;
        const hostAction = hostActionFromPath(path);
        if (!hostAction) return { ok: false, code: "not_found", error: `Unknown endpoint: ${path}` };
        result = this.engine.advancePhase(room, hostAction, payload.hostName || "host", this.serverNowIso());
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
      if (path === "/api/host/save-game-config") {
        const config = this.engine.normalizeConfig(payload.config || this.engine.DEFAULT_CONFIG);
        const configId = cleanKey(payload.configId || config.gameMeta && (config.gameMeta.configId || config.gameMeta.title) || `config-${Date.now()}`);
        const node = {
          configId,
          name: String(payload.name || config.gameMeta && config.gameMeta.title || configId).slice(0, 80),
          status: payload.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
          stageCount: (config.stages || []).length,
          updatedAt: nowIso(),
          config,
        };
        await this.sdk.set(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/nextGameConfigs/${configId}`), node);
        return { ok: true, config: node, configs: await this.readGameConfigs() };
      }
      if (path === "/api/host/delete-game-config") {
        const configId = cleanKey(payload.configId);
        if (!configId) return { ok: false, code: "bad_request", error: "configIdを指定してください。" };
        await this.sdk.set(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/nextGameConfigs/${configId}`), null);
        return { ok: true, configs: await this.readGameConfigs() };
      }
      if (path === "/api/host/archive-current") {
        const archiveRoom = await this.readRestRoom({ purpose: "mutation", includeCompletedGames: true });
        if (!archiveRoom) return { ok: false, code: "not_initialized", error: "ゲームルームがまだ初期化されていません。" };
        if (archiveRoom.phase !== this.engine.PHASES.FINAL) {
          return { ok: false, code: "not_ready", error: "現在ゲームの手動保存は最終結果の確定後に実行してください。" };
        }
        const resultsSnapshot = await this.sdk.get(
          this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/results`)
        );
        archiveRoom.stageResults = normalizeStageResults(
          resultsSnapshot.exists() ? resultsSnapshot.val() || {} : {}
        );
        const game = archiveGameForCurrentRoom(archiveRoom, this.engine);
        if (!game) return { ok: false, code: "not_ready", error: "アーカイブできる集計済みステージがありません。" };
        const archiveState = archiveRoom.archive || {};
        if (
          ["queued", "failed"].includes(archiveState.status) &&
          archiveState.gameId &&
          archiveState.gameId !== game.gameId
        ) {
          return {
            ok: false,
            code: "archive_pending",
            error: "別ゲームの未完了アーカイブがあります。先に「未完了を再送」を完了してください。",
          };
        }
        const archiveId = archiveState.gameId === game.gameId ? archiveState.archiveId : "";
        const nextRoom = this.engine.deepClone(archiveRoom);
        const completedIndex = (nextRoom.completedGames || []).findIndex((item) => {
          return item && item.gameId === game.gameId;
        });
        if (completedIndex >= 0) nextRoom.completedGames[completedIndex] = game;
        else nextRoom.completedGames = (nextRoom.completedGames || []).concat(game);
        nextRoom.roomVersion = Number(archiveRoom.roomVersion || 0) + 1;
        nextRoom.updatedAt = this.serverNowIso();
        queueArchiveForGame(nextRoom, archiveState, game, this.roomId);
        nextRoom.operations = nextRoom.operations || [];
        nextRoom.operations.unshift({
          at: nextRoom.updatedAt,
          actor: "host",
          action: "archive-current",
          gameId: game.gameId,
        });
        nextRoom.operations = nextRoom.operations.slice(0, 100);
        const transition = await this.commitHostAtomicUpdate(
          "/api/host/archive-current",
          archiveRoom,
          nextRoom
        );
        if (!transition.ok) return transition;
        return this.exportArchiveGame(
          game,
          nextRoom,
          archiveId || nextRoom.archive.archiveId,
          nextRoom.archive
        );
      }
      if (path === "/api/host/archive-retry") {
        const archiveSnapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/archive`));
        const archiveState = archiveSnapshot.exists() ? archiveSnapshot.val() || {} : {};
        const requestedGameId = cleanKey(payload.gameId);
        const gameId = cleanKey(archiveState.gameId);
        if (!gameId) return { ok: false, code: "not_found", error: "再送対象のgameIdがありません。" };
        if (requestedGameId && requestedGameId !== gameId) {
          return { ok: false, code: "archive_mismatch", error: "再送対象のgameIdが現在の未完了アーカイブと一致しません。" };
        }
        const gameSnapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/completedGameDetails/${gameId}`));
        if (!gameSnapshot.exists()) return { ok: false, code: "not_found", error: "再送対象の完了ゲームが見つかりません。" };
        return this.exportArchiveGame(
          normalizeCompletedGame(gameSnapshot.val()),
          null,
          archiveState.archiveId,
          archiveState
        );
      }
      if (path === "/api/host/archive-recalculate") {
        return this.callArchiveApi("/api/archive/recalculate", {
          gameId: payload.gameId || "",
        });
      }
      if (path === "/api/host/start-game-config") {
        const configId = cleanKey(payload.configId);
        const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/nextGameConfigs/${configId}`));
        if (!snapshot.exists() || !snapshot.val() || snapshot.val().status !== "ACTIVE") {
          return { ok: false, code: "not_found", error: "有効な次ゲーム設定が見つかりません。" };
        }
        payload = Object.assign({}, payload, { config: snapshot.val().config });
      }
      const room = await this.readRestRoom({
        purpose: "mutation",
        includeCompletedGames: ["/api/host/import-config", "/api/host/start-game-config", "/api/host/advance"].includes(path),
      });
      if (!room && path !== "/api/host/import-config" && path !== "/api/host/update-config") {
        return { ok: false, code: "not_initialized", error: "ゲームルームがまだ初期化されていません。Host認証をやり直してください。" };
      }
      const currentRoom = room || initializedRoom(this.engine, this.roomId, payload.config);
      const result = this.applyMutation(path, payload, currentRoom);
      if (!result.ok) return result;

      if (path === "/api/host/import-config" || path === "/api/host/start-game-config" || path === "/api/host/update-config") {
        const nextRoom = stampHostRoom(result.room, this.roomId, currentRoom, this.serverNowIso());
        const currentGameAlreadyArchived = (currentRoom.completedGames || []).some((game) => game.gameId === currentRoom.gameId);
        const archivedGame = !currentGameAlreadyArchived && (path === "/api/host/import-config" || path === "/api/host/start-game-config")
          ? (nextRoom.completedGames || []).find((game) => game.gameId === currentRoom.gameId)
          : null;
        const shouldExportArchivedGame = archivedGame
          ? queueArchiveForGame(nextRoom, currentRoom.archive, archivedGame, this.roomId)
          : false;
        await this.writeRestRoomChildren(nextRoom, {
          previousRoom: currentRoom,
          clearVolatile: path === "/api/host/import-config" || path === "/api/host/start-game-config",
          includeRootPlayers: true,
        });
        if (archivedGame && shouldExportArchivedGame) {
          const archiveResult = await this.exportArchiveGame(
            archivedGame,
            currentRoom,
            nextRoom.archive.archiveId,
            nextRoom.archive
          );
          nextRoom.archive = archiveResult.archive || nextRoom.archive;
        }
        return Object.assign({}, result, { room: this.publicRoom(nextRoom, payload).room });
      }

      const nextRoom = stampHostRoom(result.room, this.roomId, currentRoom, this.serverNowIso());
      const finalizedGame = path === "/api/host/advance" &&
        currentRoom.phase !== this.engine.PHASES.FINAL &&
        nextRoom.phase === this.engine.PHASES.FINAL
        ? this.engine.archiveCurrentGame(nextRoom, this.serverNowIso())
        : null;
      if (finalizedGame) {
        nextRoom.completedGames = (nextRoom.completedGames || []).concat(finalizedGame);
      }
      const shouldExportFinalizedGame = finalizedGame
        ? queueArchiveForGame(nextRoom, currentRoom.archive, finalizedGame, this.roomId)
        : false;
      const transition = await this.commitHostAtomicUpdate(path, currentRoom, nextRoom);
      if (!transition.ok) return transition;
      if (finalizedGame && shouldExportFinalizedGame) {
        const archiveResult = await this.exportArchiveGame(
          finalizedGame,
          nextRoom,
          nextRoom.archive.archiveId,
          nextRoom.archive
        );
        nextRoom.archive = archiveResult.archive || nextRoom.archive;
      }
      return Object.assign({}, result, { room: this.publicRoom(nextRoom, payload).room });
    }

    async postRestPlayer(path, payload) {
      const room = await this.readRestRoom({ purpose: "mutation" });
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
      if (["/api/player/join", "/api/player/restore", "/api/player/rename"].includes(path) && result.player) {
        await this.writeRootPlayer(result.player);
      }
      await this.writeRestChildUpdates(updates);
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
          await this.backfillHistoryIndexes();
          await this.ensureCountdownRoomSetting();
        }
        return;
      }
      const room = await this.readRoom();
      room.hostUid = this.auth.uid;
      room.updatedAt = nowIso();
      await this.writeRoom(room);
    }

    async ensureCountdownRoomSetting() {
      const settingRef = this.sdk.ref(
        this.firebaseDb,
        `/rooms/${this.roomId}/roomSettings/countdownSeconds`
      );
      const snapshot = await this.sdk.get(settingRef);
      const value = Number(snapshot.exists() ? snapshot.val() : NaN);
      if (
        Number.isInteger(value) &&
        value >= this.engine.MIN_COUNTDOWN_SECONDS &&
        value <= this.engine.MAX_COUNTDOWN_SECONDS
      ) {
        return value;
      }
      await this.sdk.set(settingRef, this.engine.DEFAULT_COUNTDOWN_SECONDS);
      return this.engine.DEFAULT_COUNTDOWN_SECONDS;
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
      next.tickets = room.tickets;
      next.completedGames = room.completedGames || [];
      next.operations = room.operations || [];
      next.operations.unshift({ at: this.serverNowIso(), actor: "host", action: "firebase-commit-result" });
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

    async readRestRoom(options = {}) {
      const hostAllowed = this.mock || this.getRole() !== "host" || this.debug.isHostAllowed;
      const paths = options.purpose === "mutation"
        ? restMutationBaseReadPaths(this.getRole(), this.auth.uid, hostAllowed, Boolean(options.includeCompletedGames))
        : restBaseReadPaths(this.getRole(), this.auth.uid, hostAllowed);
      const base = await this.readRestNodes(paths);
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

    async readGameConfigs() {
      const normalize = (item) => Object.assign({}, item, {
        title: item && item.config && item.config.gameMeta && item.config.gameMeta.title || item && item.name || "",
        stageCount: Number(item && item.stageCount || item && item.config && item.config.stages && item.config.stages.length || 0),
        stageNames: (item && item.config && item.config.stages || []).map((stage) => stage.name || stage.stageId),
        valid: Boolean(item && item.config && item.config.stages && item.config.stages.length),
      });
      if (this.mock) {
        const room = this.readMockRoom();
        return Object.values(room && room.nextGameConfigs || {}).filter((item) => item && item.status !== "INACTIVE").map(normalize);
      }
      const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/nextGameConfigs`));
      return Object.values(snapshot.exists() ? snapshot.val() || {} : {})
        .filter((item) => item && item.status !== "INACTIVE")
        .map(normalize)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    }

    async readCompletedGameDetail(gameId, hostDetail) {
      if (this.mock) {
        const room = this.readMockRoom();
        const game = (room && room.completedGames || []).find((item) => item.gameId === gameId);
        return hostDetail ? game || null : completedGamePublicDetailNode(game);
      }
      const path = hostDetail ? "completedGameDetails" : "completedGamePublicDetails";
      const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/${path}/${gameId}`));
      return snapshot.exists() ? normalizeCompletedGame(snapshot.val()) : null;
    }

    async exportArchiveGame(game, sourceRoom, archiveId, archiveState) {
      const requestedPendingGameIds = pendingArchiveGameIds(
        archiveState || sourceRoom && sourceRoom.archive
      ).filter((gameId) => gameId !== game.gameId);
      const queuedTransition = await this.transitionArchiveState((currentArchive) => {
        const current = currentArchive || {};
        if (
          ["queued", "failed"].includes(current.status) &&
          current.gameId &&
          current.gameId !== game.gameId
        ) {
          return undefined;
        }
        return queuedArchiveState(
          this.roomId,
          game.gameId,
          current.gameId === game.gameId
            ? current.archiveId || archiveId
            : archiveId,
          uniqueArchiveGameIds(
            requestedPendingGameIds.concat(pendingArchiveGameIds(current))
          )
        );
      });
      if (!queuedTransition.committed) {
        return {
          ok: false,
          status: "failed",
          code: "archive_pending",
          error: "別ゲームの未完了アーカイブがあります。先にそのゲームを再送してください。",
          archive: queuedTransition.archive,
        };
      }
      const queued = queuedTransition.archive;
      const archive = buildArchivePayload(game, sourceRoom, queued.archiveId);
      const response = await this.callArchiveApi("/api/archive/export", { archive });
      const exported = Boolean(response && response.ok && response.status === "exported");
      const completedAt = nowIso();
      const completedTransition = await this.transitionArchiveState((currentArchive) => {
        const current = currentArchive || {};
        if (
          current.gameId !== game.gameId ||
          current.archiveId !== queued.archiveId
        ) {
          return undefined;
        }
        const livePendingGameIds = uniqueArchiveGameIds(
          pendingArchiveGameIds(queued).concat(pendingArchiveGameIds(current))
        ).filter((gameId) => gameId !== game.gameId);
        if (exported && livePendingGameIds.length) {
          return queuedArchiveState(
            this.roomId,
            livePendingGameIds[0],
            "",
            livePendingGameIds.slice(1)
          );
        }
        const status = {
          requestedAt: queued.requestedAt,
          completedAt,
          status: exported ? "exported" : "failed",
          archiveId: queued.archiveId,
          gameId: game.gameId,
          error: exported ? "" : response && (response.error || response.message) || "アーカイブ送信に失敗しました。",
          pendingGameIdsJson: JSON.stringify(livePendingGameIds),
        };
        if (response && response.exportedAt) status.exportedAt = response.exportedAt;
        return status;
      });
      if (!completedTransition.committed) {
        return Object.assign({}, response, {
          ok: exported,
          code: exported ? "archive_state_advanced" : "archive_state_changed",
          archive: completedTransition.archive,
        });
      }
      const completedArchive = completedTransition.archive;
      if (
        exported &&
        completedArchive.status === "queued" &&
        completedArchive.gameId !== game.gameId
      ) {
        const nextGameId = completedArchive.gameId;
        const nextSnapshot = await this.sdk.get(
          this.sdk.ref(
            this.firebaseDb,
            `/rooms/${this.roomId}/completedGameDetails/${nextGameId}`
          )
        );
        if (!nextSnapshot.exists()) {
          const missingTransition = await this.transitionArchiveState((currentArchive) => {
            const current = currentArchive || {};
            if (
              current.gameId !== nextGameId ||
              current.archiveId !== completedArchive.archiveId
            ) {
              return undefined;
            }
            return Object.assign({}, current, {
              completedAt: nowIso(),
              status: "failed",
              error: `後続アーカイブ ${nextGameId} の完了詳細が見つかりません。`,
            });
          });
          const missing = missingTransition.archive || completedArchive;
          return {
            ok: false,
            status: "failed",
            code: "archive_detail_missing",
            error: missing.error,
            archive: missing,
          };
        }
        return this.exportArchiveGame(
          normalizeCompletedGame(nextSnapshot.val()),
          null,
          completedArchive.archiveId,
          completedArchive
        );
      }
      return Object.assign({}, response, {
        ok: completedArchive.status === "exported",
        archive: completedArchive,
      });
    }

    async transitionArchiveState(updater) {
      const archiveRef = this.sdk.ref(
        this.firebaseDb,
        `/rooms/${this.roomId}/archive`
      );
      if (typeof this.sdk.runTransaction === "function") {
        const result = await this.sdk.runTransaction(
          archiveRef,
          (currentArchive) => updater(currentArchive || null),
          { applyLocally: false }
        );
        return {
          committed: Boolean(result && result.committed),
          archive: result && result.snapshot && result.snapshot.exists()
            ? result.snapshot.val()
            : null,
        };
      }
      const snapshot = await this.sdk.get(archiveRef);
      const currentArchive = snapshot.exists() ? snapshot.val() : null;
      const nextArchive = updater(currentArchive);
      if (nextArchive === undefined) {
        return { committed: false, archive: currentArchive };
      }
      await this.sdk.set(archiveRef, nextArchive);
      return { committed: true, archive: nextArchive };
    }

    async callArchiveApi(path, payload) {
      const url = String(this.config.FIREBASE_ARCHIVE_GAS_URL || "").trim();
      if (!url) {
        return { ok: false, status: "failed", error: "FIREBASE_ARCHIVE_GAS_URLが未設定です。" };
      }
      if (!this.mock && this.firebaseAuth && this.firebaseAuth.currentUser) {
        try {
          this.auth.idToken = await this.firebaseAuth.currentUser.getIdToken(true);
        } catch (error) {
          return { ok: false, status: "failed", error: `Firebase ID tokenを更新できません: ${error.message}` };
        }
      }
      const request = Object.assign({}, payload || {}, {
        path,
        apiKey: this.config.FIREBASE_ARCHIVE_API_KEY || "",
        firebaseIdToken: this.auth && this.auth.idToken || "",
        roomId: this.roomId,
      });
      try {
        const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}path=${encodeURIComponent(path)}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(request),
        });
        if (!response.ok) return { ok: false, status: "failed", error: `Archive HTTP ${response.status}` };
        return await response.json();
      } catch (error) {
        return { ok: false, status: "failed", error: error && error.message ? error.message : String(error) };
      }
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
        const rootUpdate = Boolean(options.includeRootPlayers);
        const updates = writes.reduce((acc, [path, value]) => {
          acc[rootUpdate ? `rooms/${this.roomId}/${path}` : path] = value;
          return acc;
        }, {});
        if (rootUpdate) {
          (room.players || []).filter((player) => player && player.uuid).forEach((player) => {
            updates[`players/${player.uuid}`] = rootPlayerNode(player, this.roomId);
          });
        }
        await this.sdk.update(this.sdk.ref(this.firebaseDb, rootUpdate ? "/" : `/rooms/${this.roomId}`), updates);
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
      const path = `/players/${uid}`;
      try {
        const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, path));
        return snapshot.exists() ? snapshot.val() : null;
      } catch (error) {
        const message = `${error && error.message ? error.message : String(error)} at ${path}`;
        const nextError = new Error(message);
        nextError.code = error && error.code;
        this.debug.lastRulesError = message;
        this.log("firebase.root-player.read.error", { path, message });
        throw nextError;
      }
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

    async backfillHistoryIndexes() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const room = await this.readRestRoom({ purpose: "mutation", includeCompletedGames: true });
        if (!room) return;
        if (room.firebaseSchemaVersion === FIREBASE_SCHEMA_VERSION) return room;
        const resultsSnapshot = await this.sdk.get(
          this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/results`)
        );
        room.stageResults = normalizeStageResults(resultsSnapshot.exists() ? resultsSnapshot.val() || {} : {});
        const rootPlayers = {};
        await Promise.all((room.players || []).map(async (player) => {
          const master = await this.readRootPlayer(player.uuid);
          if (master) rootPlayers[player.uuid] = master;
        }));
        const nextRoom = recoverCareerSkillState(room, rootPlayers, this.engine);
        nextRoom.firebaseSchemaVersion = FIREBASE_SCHEMA_VERSION;
        nextRoom.roomVersion = Number(room.roomVersion || 0) + 1;
        nextRoom.updatedAt = this.serverNowIso();
        nextRoom.operations = nextRoom.operations || [];
        nextRoom.operations.unshift({
          at: nextRoom.updatedAt,
          actor: "host",
          action: "firebase-backfill-skill-history",
        });
        nextRoom.operations = nextRoom.operations.slice(0, 100);
        const nodes = roomToFirebaseNodes(nextRoom);
        const updates = {
          [`rooms/${this.roomId}/public`]: nodes.public,
          [`rooms/${this.roomId}/meta`]: nodes.meta,
          [`rooms/${this.roomId}/operations`]: emptyObjectToNull(nodes.operations),
          [`rooms/${this.roomId}/historyPlayers`]: emptyObjectToNull(nodes.historyPlayers),
          [`rooms/${this.roomId}/completedGameSummaries`]: emptyObjectToNull(nodes.completedGameSummaries),
          [`rooms/${this.roomId}/completedGamePublicDetails`]: emptyObjectToNull(nodes.completedGamePublicDetails),
          [`rooms/${this.roomId}/completedGameDetails`]: emptyObjectToNull(nodes.completedGameDetails),
          [`rooms/${this.roomId}/completedGamePlayerDetails`]: emptyObjectToNull(nodes.completedGamePlayerDetails),
        };
        (nextRoom.players || []).forEach((player) => {
          updates[`rooms/${this.roomId}/playerStats/${player.uuid}`] = nodes.playerStats[player.uuid];
          const master = rootPlayers[player.uuid];
          const masterHistory = normalizeSkillHistory(
            master && (master.stageSkillHistoryJson ?? master.stageSkillHistory)
          );
          if (!masterHistory.length) {
            updates[`players/${player.uuid}`] = rootPlayerNode(player, this.roomId);
          }
        });
        try {
          await this.sdk.update(this.sdk.ref(this.firebaseDb, "/"), updates);
          return nextRoom;
        } catch (error) {
          this.debug.lastRulesError = error && error.message ? error.message : String(error);
          if (attempt === 2) throw error;
        }
      }
      return null;
    }

    async isHostAllowed() {
      if (this.mock) return true;
      const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/roles/hosts/${this.auth.uid}`));
      const allowed = snapshot.exists() && snapshot.val() === true;
      this.debug.isHostAllowed = allowed;
      return allowed;
    }

    async commitHostAtomicUpdate(path, currentRoom, nextRoom) {
      const updates = hostAtomicUpdates(path, currentRoom, nextRoom, this.roomId, this.engine);
      try {
        await this.sdk.update(this.sdk.ref(this.firebaseDb, "/"), updates);
        this.debug.lastTransactionPublic = compactStatus(nextRoom);
        return { ok: true };
      } catch (error) {
        this.debug.lastRulesError = error && error.message ? error.message : String(error);
        let actualPublic = null;
        try {
          const snapshot = await this.sdk.get(this.sdk.ref(this.firebaseDb, `/rooms/${this.roomId}/public`));
          actualPublic = snapshot.exists() ? snapshot.val() : null;
          this.debug.lastTransactionPublic = actualPublic;
        } catch (readError) {
          this.log("firebase.atomic-refresh.error", { message: readError && readError.message ? readError.message : String(readError) });
        }
        const conflict = actualPublic && !publicMatches(actualPublic, compactStatus(currentRoom));
        return {
          ok: false,
          code: conflict ? "version_conflict" : "rules_or_conflict",
          error: conflict
            ? "DB上のフェーズまたはバージョンが更新されています。再読み込みしてください。"
            : (this.debug.lastRulesError || "Firebase Rulesにより原子的更新が拒否されました。"),
          debug: {
            expectedPublic: compactStatus(currentRoom),
            attemptedPublic: compactStatus(nextRoom),
            actualPublic,
          },
        };
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
        schemaVersion: room.firebaseSchemaVersion || FIREBASE_SCHEMA_VERSION,
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
      completedGamePublicDetails: keyBy(room.completedGames || [], "gameId", completedGamePublicDetailNode),
      completedGameDetails: keyBy(room.completedGames || [], "gameId", completedGameDetailNode),
      completedGamePlayerDetails: completedGamePlayerDetails(room.completedGames || []),
      historyPlayers: keyBy(historyPlayers(room), "profileId", (player) => player),
      scores: Object.keys(room.scores || {}).reduce((acc, uuid) => {
        acc[uuid] = { total: room.scores[uuid], updatedAt: room.updatedAt || nowIso() };
        return acc;
      }, {}),
      operations: keyOperations(room.operations || []),
      roomSettings: {
        countdownSeconds: room.countdownSeconds !== undefined
          ? Number(room.countdownSeconds)
          : 10,
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
        stageSkillHistory: storedArray(stats.stageSkillHistoryJson, stats.stageSkillHistory).map(Number).filter(Number.isFinite),
        appliedSkillStageIds: storedArray(stats.appliedSkillStageIdsJson, stats.appliedSkillStageIds).map(String),
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
    const historyPlayersValue = Object.keys(nodes.historyPlayers || {}).map((uuid) => {
      const player = nodes.historyPlayers[uuid] || {};
      return {
        profileId: uuid,
        name: player.name || uuid,
        skill: Number(player.currentSkill ?? player.skill ?? 0),
        currentSkill: Number(player.currentSkill ?? player.skill ?? 0),
        updatedAt: player.updatedAt || "",
      };
    });
    return normalizeRoomShape({
      roomId: nodes.meta && nodes.meta.roomId || fallback.roomId,
      firebaseSchemaVersion: nodes.meta && nodes.meta.schemaVersion || "",
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
      historyPlayers: historyPlayersValue,
      operations: Object.values(nodes.operations || {}).sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))),
      countdownEndsAt: status.countdownEndsAt || null,
      tallyingEndsAt: status.tallyingEndsAt || null,
      animationStartedAt: status.animationStartedAt || null,
      animationSkippedAt: status.animationSkippedAt || null,
      revealEndsAt: status.revealEndsAt || null,
      roomVersion: Number(status.roomVersion || 0),
      ticketPresence: nodes.ticketPresence || {},
      archive: nodes.archive || null,
      countdownSeconds: settings.countdownSeconds !== undefined
        ? Number(settings.countdownSeconds)
        : fallback.countdownSeconds,
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
      return common.concat([`roles/hosts/${uid}`, "players", "playerStats", "scores", "completedGameSummaries", "historyPlayers", "operations", "archive"]);
    }
    if (role === "screen") {
      return common.concat(["players", "scores"]);
    }
    if (role === "history") {
      return common.concat(["players", `playerStats/${uid}`, "scores", "completedGameSummaries", "historyPlayers", `completedGamePlayerDetails/${uid}`]);
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

  function restMutationBaseReadPaths(role, uid, hostAllowed, includeCompletedGames) {
    const common = ["meta", "public", "config", "roomSettings"];
    if (role === "host") {
      if (!hostAllowed) return common.concat([`roles/hosts/${uid}`]);
      const paths = common.concat([`roles/hosts/${uid}`, "players", "playerStats", "scores", "historyPlayers", "operations", "archive"]);
      if (includeCompletedGames) paths.push("completedGameSummaries", "completedGameDetails");
      return paths;
    }
    return common.concat(["players", `playerStats/${uid}`, `scores/${uid}`]);
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

  function hostAtomicUpdates(path, currentRoom, nextRoom, roomId, engine) {
    const updates = {};
    const nodes = roomToFirebaseNodes(nextRoom);
    const roomPath = (childPath) => `rooms/${roomId}/${childPath}`;
    updates[roomPath("public")] = nodes.public;
    updates[roomPath("meta")] = nodes.meta;
    updates[roomPath("operations")] = emptyObjectToNull(nodes.operations);

    if (path === "/api/host/commit-result") {
      const stage = engine.getCurrentStage(currentRoom);
      const stageId = stage && stage.stageId;
      if (stageId) updates[roomPath(`results/${stageId}`)] = nodes.results && nodes.results[stageId] || null;
      updates[roomPath("scores")] = emptyObjectToNull(nodes.scores);
      updates[roomPath("playerStats")] = emptyObjectToNull(nodes.playerStats);
      updates[roomPath("historyPlayers")] = emptyObjectToNull(nodes.historyPlayers);
    }

    if (path === "/api/host/start-stage" || path === "/api/host/advance") {
      updates[roomPath("players")] = emptyObjectToNull(nodes.players);
      updates[roomPath("playerStats")] = emptyObjectToNull(nodes.playerStats);
      updates[roomPath("historyPlayers")] = emptyObjectToNull(nodes.historyPlayers);
    }

    if (path === "/api/host/update-room-settings") {
      updates[roomPath("roomSettings/countdownSeconds")] = nodes.roomSettings.countdownSeconds;
    }

    const completedGameChanged =
      (nextRoom.completedGames || []).length > (currentRoom.completedGames || []).length ||
      path === "/api/host/archive-current";
    if (completedGameChanged) {
      updates[roomPath("completedGameSummaries")] = emptyObjectToNull(nodes.completedGameSummaries);
      updates[roomPath("completedGamePublicDetails")] = emptyObjectToNull(nodes.completedGamePublicDetails);
      updates[roomPath("completedGameDetails")] = emptyObjectToNull(nodes.completedGameDetails);
      updates[roomPath("completedGamePlayerDetails")] = emptyObjectToNull(nodes.completedGamePlayerDetails);
      updates[roomPath("historyPlayers")] = emptyObjectToNull(nodes.historyPlayers);
      updates[roomPath("archive")] = emptyObjectToNull(nodes.archive);
    }

    if (path === "/api/host/remove-player") {
      removedPlayerUids(currentRoom, nextRoom).forEach((uid) => {
        updates[roomPath(`players/${uid}`)] = null;
        updates[roomPath(`playerStats/${uid}`)] = null;
        updates[roomPath(`scores/${uid}`)] = null;
        Object.keys(currentRoom.tickets || {}).forEach((stageId) => {
          if (currentRoom.tickets[stageId] && currentRoom.tickets[stageId][uid]) updates[roomPath(`tickets/${stageId}/${uid}`)] = null;
        });
        Object.keys(currentRoom.ticketPresence || {}).forEach((stageId) => {
          if (currentRoom.ticketPresence[stageId] && currentRoom.ticketPresence[stageId][uid]) updates[roomPath(`ticketPresence/${stageId}/${uid}`)] = null;
        });
        Object.keys(currentRoom.stageResults || {}).forEach((stageId) => {
          const currentResult = currentRoom.stageResults[stageId];
          if (!currentResult || !currentResult.players || !currentResult.players[uid]) return;
          const nextResult = nextRoom.stageResults && nextRoom.stageResults[stageId] || {};
          updates[roomPath(`results/${stageId}/players/${uid}`)] = null;
          updates[roomPath(`results/${stageId}/rankings`)] = nextResult.rankings || [];
          updates[roomPath(`results/${stageId}/timeline`)] = nextResult.timeline || [];
          updates[roomPath(`results/${stageId}/stats`)] = nextResult.stats || {};
        });
      });
    }

    if (["/api/host/commit-result", "/api/host/start-stage", "/api/host/advance"].includes(path)) {
      (nextRoom.players || []).filter((player) => player && player.uuid).forEach((player) => {
        updates[`players/${player.uuid}`] = rootPlayerNode(player, roomId);
      });
    }
    return updates;
  }

  function recoverCareerSkillState(room, rootPlayers, engine) {
    const next = engine.deepClone(room);
    const occurrences = collectCareerSkillOccurrences(next, engine);
    const occurrencesByPlayer = occurrences.reduce((acc, occurrence) => {
      Object.keys(occurrence.result.players || {}).forEach((uid) => {
        const playerResult = occurrence.result.players[uid];
        if (!playerResult || playerResult.stageSkill === null || playerResult.stageSkill === undefined) return;
        const stageSkill = Number(playerResult.stageSkill);
        if (!Number.isFinite(stageSkill)) return;
        acc[uid] = acc[uid] || [];
        acc[uid].push({
          applicationId: occurrence.applicationId,
          stageSkill: engine.roundScore(stageSkill),
        });
      });
      return acc;
    }, {});

    (next.players || []).forEach((player) => {
      const master = rootPlayers && rootPlayers[player.uuid] || null;
      const masterHistory = normalizeSkillHistory(master && (master.stageSkillHistoryJson ?? master.stageSkillHistory));
      const masterIds = storedArray(
        master && master.appliedSkillStageIdsJson,
        master && master.appliedSkillStageIds
      ).map(String);
      if (masterHistory.length) {
        player.stageSkillHistory = masterHistory;
        player.appliedSkillStageIds = [...new Set(masterIds)];
        const masterSkill = Number(master && (master.currentSkill ?? master.skill));
        player.skill = Number.isFinite(masterSkill)
          ? masterSkill
          : engine.calculateCurrentSkill(masterHistory);
        return;
      }

      const roomHistory = normalizeSkillHistory(player.stageSkillHistory);
      const roomIds = storedArray(player.appliedSkillStageIds).map(String);
      const recovered = mergeCareerSkillOccurrences(
        roomHistory,
        masterIds.length ? masterIds : roomIds,
        occurrencesByPlayer[player.uuid] || [],
        engine
      );
      player.stageSkillHistory = recovered.history;
      player.appliedSkillStageIds = recovered.applicationIds;
      player.skill = engine.calculateCurrentSkill(recovered.history);
    });

    repairCurrentFinalGame(next, engine);
    return next;
  }

  function collectCareerSkillOccurrences(room, engine) {
    const byApplicationId = new Map();
    let order = 0;
    const addStageResults = (gameId, stageResults, fallbackAt, sourcePriority) => {
      Object.keys(stageResults || {}).forEach((stageId) => {
        const result = normalizeStageResult(stageResults[stageId]);
        if (!result) return;
        const applicationId = engine.skillStageApplicationId(gameId, stageId);
        const candidate = {
          applicationId,
          gameId,
          stageId,
          at: result.calculatedAt || fallbackAt || "",
          order: order += 1,
          sourcePriority,
          result,
        };
        const existing = byApplicationId.get(applicationId);
        if (!existing) {
          byApplicationId.set(applicationId, candidate);
          return;
        }
        assertCompatibleStageSkills(existing, candidate, engine);
        const existingCount = finiteStageSkillCount(existing.result);
        const candidateCount = finiteStageSkillCount(candidate.result);
        if (
          candidateCount > existingCount ||
          (candidateCount === existingCount && candidate.sourcePriority > existing.sourcePriority)
        ) {
          byApplicationId.set(applicationId, candidate);
        }
      });
    };

    (room.completedGames || []).forEach((game) => {
      if (!game || !game.gameId) return;
      addStageResults(game.gameId, game.stageResults, game.finishedAt, 1);
    });
    addStageResults(room.gameId || "legacy-game", room.stageResults, room.updatedAt, 2);
    return [...byApplicationId.values()].sort((a, b) => {
      const timeA = Number.isFinite(new Date(a.at).getTime()) ? new Date(a.at).getTime() : Number.MAX_SAFE_INTEGER;
      const timeB = Number.isFinite(new Date(b.at).getTime()) ? new Date(b.at).getTime() : Number.MAX_SAFE_INTEGER;
      return timeA - timeB || a.order - b.order || a.applicationId.localeCompare(b.applicationId);
    });
  }

  function assertCompatibleStageSkills(existing, candidate, engine) {
    const existingPlayers = existing.result.players || {};
    const candidatePlayers = candidate.result.players || {};
    Object.keys(existingPlayers).forEach((uid) => {
      if (!candidatePlayers[uid]) return;
      const left = existingPlayers[uid].stageSkill;
      const right = candidatePlayers[uid].stageSkill;
      if (left === null || left === undefined || right === null || right === undefined) return;
      if (!Number.isFinite(Number(left)) || !Number.isFinite(Number(right))) return;
      if (engine.roundScore(left) !== engine.roundScore(right)) {
        throw new Error(`SKILL_HISTORY_CONFLICT:${existing.applicationId}`);
      }
    });
  }

  function finiteStageSkillCount(result) {
    return Object.values(result && result.players || {}).filter((playerResult) => {
      return playerResult &&
        playerResult.stageSkill !== null &&
        playerResult.stageSkill !== undefined &&
        Number.isFinite(Number(playerResult.stageSkill));
    }).length;
  }

  function mergeCareerSkillOccurrences(history, applicationIds, occurrences, engine) {
    const recoveredHistory = (history || [])
      .map((value) => Number(value))
      .filter(Number.isFinite)
      .map(engine.roundScore);
    const recoveredIds = [...new Set((applicationIds || []).filter(Boolean).map(String))];
    const idSet = new Set(recoveredIds);
    const scopedIdCount = recoveredIds.filter(isScopedSkillApplicationId).length;
    if (
      recoveredHistory.length &&
      (occurrences || []).length &&
      scopedIdCount !== recoveredHistory.length
    ) {
      throw new Error("SKILL_HISTORY_AMBIGUOUS");
    }

    (occurrences || []).forEach((occurrence) => {
      const alreadyMarked = idSet.has(occurrence.applicationId);
      if (alreadyMarked) return;
      recoveredHistory.push(engine.roundScore(occurrence.stageSkill));
      recoveredIds.push(occurrence.applicationId);
      idSet.add(occurrence.applicationId);
    });
    return {
      history: recoveredHistory,
      applicationIds: recoveredIds,
    };
  }

  function isScopedSkillApplicationId(value) {
    try {
      const parsed = JSON.parse(String(value || ""));
      return Array.isArray(parsed) &&
        parsed.length === 2 &&
        parsed.every((item) => typeof item === "string");
    } catch (error) {
      return false;
    }
  }

  function repairCurrentFinalGame(room, engine) {
    if (
      room.phase !== engine.PHASES.FINAL ||
      !room.gameId ||
      !Object.keys(room.stageResults || {}).length
    ) {
      return;
    }
    const games = room.completedGames || [];
    const existingIndex = games.findIndex((game) => game && game.gameId === room.gameId);
    const existing = existingIndex >= 0 ? games[existingIndex] : null;
    const resultTimes = Object.values(room.stageResults || {})
      .map((result) => result && result.calculatedAt)
      .filter((value) => value && Number.isFinite(new Date(value).getTime()))
      .sort();
    const archivedAt = existing && existing.finishedAt ||
      resultTimes[resultTimes.length - 1] ||
      room.updatedAt;
    const source = engine.deepClone(room);
    source.completedGames = games.filter((game) => !game || game.gameId !== room.gameId);
    const repaired = engine.archiveCurrentGame(source, archivedAt);
    if (!repaired) return;
    const merged = Object.assign({}, existing || {}, repaired);
    if (existingIndex >= 0) room.completedGames[existingIndex] = merged;
    else room.completedGames.push(merged);
  }

  function normalizeStageResults(results) {
    return Object.keys(results || {}).reduce((acc, stageId) => {
      acc[stageId] = normalizeStageResult(results[stageId]);
      return acc;
    }, {});
  }

  function normalizeCompletedGames(games) {
    return Object.values(games || {}).map(normalizeCompletedGame);
  }

  function normalizeCompletedGame(game) {
    if (!game || typeof game !== "object") return game;
    const next = Object.assign({}, game);
    next.rankings = arrayFromFirebase(next.rankings);
    next.stageResults = normalizeStageResults(next.stageResults || {});
    return next;
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
      rankings: publicRankingRows(game.rankings || []),
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

  function completedGamePublicDetailNode(game) {
    if (!game) return null;
    const stageResults = Object.keys(game.stageResults || {}).reduce((acc, stageId) => {
      const stage = game.stageResults[stageId] || {};
      const rankings = arrayFromFirebase(stage.rankings).length
        ? arrayFromFirebase(stage.rankings)
        : Object.values(stage.players || {})
          .map((player) => ({
            uuid: player.uuid,
            name: player.name || player.uuid,
            score: Number(player.score || 0),
          }))
          .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"))
          .map((player, index) => Object.assign({ rank: index + 1 }, player));
      acc[stageId] = {
        stageId: stage.stageId || stageId,
        stageName: stage.stageName || stage.name || stageId,
        calculatedAt: stage.calculatedAt || "",
        participantCount: rankings.length,
        rankings: publicRankingRows(rankings),
      };
      return acc;
    }, {});
    return {
      gameId: game.gameId || "",
      title: game.title || "game",
      finishedAt: game.finishedAt || "",
      interrupted: Boolean(game.interrupted),
      finalPhase: game.finalPhase || "",
      rankings: publicRankingRows(game.rankings || []),
      stageResults,
    };
  }

  function publicRankingRows(rankings) {
    return arrayFromFirebase(rankings).map((row) => ({
      profileId: publicProfileId(row && (row.uuid || row.uid || row.profileId) || ""),
      name: String(row && row.name || "プレイヤー").slice(0, 24),
      rank: Number(row && row.rank || 0),
      score: Number(row && (row.score ?? row.totalScore) || 0),
    }));
  }

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

  function queuedArchiveState(roomId, gameId, archiveId, pendingGameIds) {
    return {
      requestedAt: nowIso(),
      status: "queued",
      archiveId: archiveId || cleanKey(`archive-${roomId}-${gameId}`),
      gameId: gameId || "",
      error: "",
      pendingGameIdsJson: JSON.stringify(uniqueArchiveGameIds(pendingGameIds)),
    };
  }

  function queueArchiveForGame(room, currentArchive, game, roomId) {
    if (!room || !game || !game.gameId) return false;
    const existing = currentArchive || {};
    const pendingGameIds = pendingArchiveGameIds(existing);
    if (
      ["queued", "failed"].includes(existing.status) &&
      existing.gameId &&
      existing.gameId !== game.gameId
    ) {
      room.archive = Object.assign({}, existing, {
        pendingGameIdsJson: JSON.stringify(
          uniqueArchiveGameIds(pendingGameIds.concat(game.gameId))
        ),
      });
      return false;
    }
    room.archive = queuedArchiveState(
      roomId,
      game.gameId,
      existing.gameId === game.gameId ? existing.archiveId : "",
      pendingGameIds
    );
    return true;
  }

  function pendingArchiveGameIds(archive) {
    if (!archive) return [];
    const source = archive.pendingGameIdsJson !== undefined
      ? archive.pendingGameIdsJson
      : archive.pendingGameIds;
    if (Array.isArray(source)) return uniqueArchiveGameIds(source);
    if (typeof source !== "string" || !source.trim()) return [];
    try {
      const parsed = JSON.parse(source);
      return Array.isArray(parsed) ? uniqueArchiveGameIds(parsed) : [];
    } catch (_error) {
      return [];
    }
  }

  function uniqueArchiveGameIds(gameIds) {
    return Array.from(new Set((gameIds || []).map(cleanKey).filter(Boolean)));
  }

  function archiveGameForCurrentRoom(room, engine) {
    if (!room) return null;
    const existing = (room.completedGames || []).find((game) => {
      return game && game.gameId === room.gameId;
    });
    if (!Object.keys(room.stageResults || {}).length) return existing || null;
    const source = engine.deepClone(room);
    source.completedGames = (source.completedGames || []).filter((game) => {
      return !game || game.gameId !== room.gameId;
    });
    const complete = engine.archiveCurrentGame(
      source,
      existing && existing.finishedAt || room.updatedAt
    );
    if (!complete) return existing || null;
    return Object.assign({}, existing || {}, complete);
  }

  function buildArchivePayload(game, room, archiveId) {
    const roomPlayers = room && room.players || [];
    const savedPlayers = arrayFromFirebase(game.playerSnapshots);
    const rankingPlayers = (game.rankings || []).map((ranking) => ({
      uuid: ranking.uuid,
      name: ranking.name || ranking.uuid,
      skill: Number(ranking.currentSkill ?? ranking.skill ?? 0),
      stageSkillHistory: [],
    }));
    const players = (
      savedPlayers.length ? savedPlayers : roomPlayers.length ? roomPlayers : rankingPlayers
    ).map((player) => ({
      uuid: player.uuid,
      name: player.name || player.uuid,
      currentSkill: Number(player.skill ?? player.currentSkill ?? 0),
      stageSkillHistory: player.stageSkillHistory || [],
    }));
    const stageResults = game.stageResults || {};
    const playerSaveData = players.map((player) => {
      const stages = Object.values(stageResults)
        .map((stage) => stage.players && stage.players[player.uuid])
        .filter(Boolean);
      const answered = stages.flatMap((stage) => stage.predictionBreakdown || []).filter((item) => !item.noAnswer);
      return {
        uuid: player.uuid,
        nameSnapshot: player.name,
        summary: {
          currentSkill: player.currentSkill,
          averageSkill: averageNumbers(player.stageSkillHistory || []),
          totalSkill: (player.stageSkillHistory || []).reduce((sum, value) => sum + Number(value || 0), 0),
          bestScore: stages.length ? Math.max(...stages.map((stage) => Number(stage.score || 0))) : 0,
          gameCount: stages.length ? 1 : 0,
          stageCount: stages.length,
          forcedOffCount: stages.filter((stage) => stage.forcedOff).length,
          predictionAccuracy: answered.length ? answered.filter((item) => item.matched).length / answered.length : null,
          wins: (game.rankings || []).some((ranking) => ranking.uuid === player.uuid && ranking.rank === 1) ? 1 : 0,
        },
      };
    });
    return {
      archiveId: archiveId || cleanKey(`archive-${game.gameId}`),
      gameId: game.gameId || "",
      requestedAt: nowIso(),
      finishedAt: game.finishedAt || "",
      interrupted: Boolean(game.interrupted),
      finalPhase: game.finalPhase || "",
      players,
      playerSaveData,
      stageResults,
      stageSettings: game.config && game.config.stages || room && room.config && room.config.stages || [],
      gameSummary: completedGameSummaryNode(game),
      finalRankings: game.rankings || [],
    };
  }

  function averageNumbers(values) {
    const numbers = (values || []).map((value) => Number(value || 0)).filter(Number.isFinite);
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
  }

  function historyPlayers(room) {
    const players = {};
    const existing = Array.isArray(room.historyPlayers) ? room.historyPlayers : Object.values(room.historyPlayers || {});
    existing.forEach((player) => {
      if (!player) return;
      const profileId = player.profileId || (player.uuid ? publicProfileId(player.uuid) : "");
      if (!profileId) return;
      players[profileId] = {
        profileId,
        name: player.name || "プレイヤー",
        currentSkill: Number(player.currentSkill ?? player.skill ?? 0),
        updatedAt: player.updatedAt || "",
      };
    });
    (room.completedGames || []).forEach((game) => {
      (game.rankings || []).forEach((ranking) => {
        if (!ranking || !ranking.uuid) return;
        const profileId = publicProfileId(ranking.uuid);
        players[profileId] = {
          profileId,
          name: ranking.name || players[profileId] && players[profileId].name || "プレイヤー",
          currentSkill: Number(ranking.currentSkill ?? ranking.skill ?? (players[profileId] ? players[profileId].currentSkill : 0)),
          updatedAt: game.finishedAt || players[profileId] && players[profileId].updatedAt || "",
        };
      });
    });
    (room.players || []).forEach((player) => {
      if (!player || !player.uuid) return;
      const profileId = publicProfileId(player.uuid);
      players[profileId] = {
        profileId,
        name: player.name || player.uuid,
        currentSkill: Number(player.skill || 0),
        updatedAt: room.updatedAt || player.lastSeenAt || "",
      };
    });
    return Object.values(players);
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
        rankings: publicRankingRows(stageResult.rankings || []),
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
      rankings: publicRankingRows(game.rankings || []),
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

  function storedArray(primary, legacyValue) {
    const value = primary !== undefined && primary !== null ? primary : legacyValue;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return [];
      }
    }
    return arrayFromFirebase(value);
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

  function stampHostRoom(room, roomId, previousRoom, updatedAt) {
    const next = room || {};
    next.roomId = roomId;
    if (previousRoom && next.gameId === previousRoom.gameId) {
      next.roomVersion = Number(previousRoom.roomVersion || 0) + 1;
      next.createdAt = previousRoom.createdAt || next.createdAt;
    } else {
      next.roomVersion = Number(next.roomVersion || 0);
    }
    next.updatedAt = updatedAt || nowIso();
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
      stageSkillHistoryJson: JSON.stringify(player.stageSkillHistory || []),
      appliedSkillStageIdsJson: JSON.stringify(player.appliedSkillStageIds || []),
      joinedAt: player.joinedAt || "",
      lastSeenAt: player.lastSeenAt || nowIso(),
      updatedAt: nowIso(),
      roomId: roomId || "",
    };
  }

  function masterPlayerForHistory(uuid, player) {
    return {
      uuid,
      name: player && player.name || uuid,
      skill: Number(player && (player.currentSkill ?? player.skill) || 0),
      currentSkill: Number(player && (player.currentSkill ?? player.skill) || 0),
      stageSkillHistory: normalizeSkillHistory(player && (player.stageSkillHistoryJson ?? player.stageSkillHistory)),
      appliedSkillStageIds: storedArray(player && player.appliedSkillStageIdsJson, player && player.appliedSkillStageIds).map(String),
      updatedAt: player && player.updatedAt || "",
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
        stageSkillHistory: normalizeSkillHistory(masterPlayer.stageSkillHistoryJson ?? masterPlayer.stageSkillHistory),
        appliedSkillStageIds: storedArray(masterPlayer.appliedSkillStageIdsJson, masterPlayer.appliedSkillStageIds).map(String),
      };
      next.players.push(player);
      next.scores[uid] = next.scores[uid] || 0;
    } else {
      player.name = cleanName;
      player.pendingName = null;
      player.connected = true;
      player.lastSeenAt = nowIso();
      player.skill = Number(masterPlayer.currentSkill || masterPlayer.skill || 0);
      player.stageSkillHistory = normalizeSkillHistory(masterPlayer.stageSkillHistoryJson ?? masterPlayer.stageSkillHistory);
      player.appliedSkillStageIds = storedArray(masterPlayer.appliedSkillStageIdsJson, masterPlayer.appliedSkillStageIds).map(String);
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
    player.stageSkillHistory = normalizeSkillHistory(masterPlayer.stageSkillHistoryJson ?? masterPlayer.stageSkillHistory);
    player.appliedSkillStageIds = storedArray(masterPlayer.appliedSkillStageIdsJson, masterPlayer.appliedSkillStageIds).map(String);
    player.lastSeenAt = nowIso();
    return Object.assign({}, result, { room: next, player });
  }

  function normalizeSkillHistory(value) {
    return storedArray(value).map((item) => Number(item || 0)).filter((item) => Number.isFinite(item));
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
      stageSkillHistoryJson: JSON.stringify(player.stageSkillHistory || []),
      appliedSkillStageIdsJson: JSON.stringify(player.appliedSkillStageIds || []),
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
    room.historyPlayers = Array.isArray(room.historyPlayers) ? room.historyPlayers : Object.values(room.historyPlayers || {});
    room.operations = Array.isArray(room.operations) ? room.operations : Object.values(room.operations || {});
    room.roomVersion = Number(room.roomVersion || 0);
    room.hostUid = room.hostUid || "";
    room.ticketPresence = room.ticketPresence || {};
    room.archive = room.archive || null;
    room.revealEndsAt = room.revealEndsAt || null;
    room.countdownSeconds = Number.isInteger(Number(room.countdownSeconds)) &&
      Number(room.countdownSeconds) >= 1 &&
      Number(room.countdownSeconds) <= 60
      ? Number(room.countdownSeconds)
      : fallback.countdownSeconds;
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

  function firebaseExistingKey(value) {
    const key = Array.from(String(value || "")).slice(0, 160).join("");
    return key && !/[.#$\/\[\]]/.test(key) ? key : "";
  }

  function decodedFirebaseExistingKey(value) {
    try {
      return firebaseExistingKey(decodeURIComponent(String(value || "")));
    } catch (error) {
      return "";
    }
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function mockAuthStorageKey() {
    if (typeof location === "undefined" || !location.search) return AUTH_KEY;
    const slot = new URLSearchParams(location.search).get("testSlot");
    const cleanSlot = String(slot || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
    return cleanSlot ? `${AUTH_KEY}.${cleanSlot}` : AUTH_KEY;
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
    restMutationBaseReadPaths,
    hostAtomicUpdates,
    recoverCareerSkillState,
    archiveGameForCurrentRoom,
    pendingArchiveGameIds,
    queueArchiveForGame,
    completedGamePublicDetailNode,
    publicProfileId,
    firebaseExistingKey,
    playerUpdates,
    rootPlayerNode,
    restorePlayerFromMaster,
  };
})(typeof self !== "undefined" ? self : this);
