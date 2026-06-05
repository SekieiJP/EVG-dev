(() => {
  const Engine = window.ElevatorGameEngine;
  const BUILD_CONFIG = Object.assign(
    {
      GAS_API_BASE_URL: "",
      GAS_API_KEY: "",
      USE_GAS_API: false,
      USE_FIREBASE_API: true,
      FIREBASE_USE_LOCAL_MOCK: false,
      FIREBASE_PROJECT_ID: "",
      FIREBASE_API_KEY: "",
      FIREBASE_DATABASE_URL: "",
      FIREBASE_ROOM_ID: "elevator-game-live",
      FIREBASE_HOST_PASSWORD: "host",
      FIREBASE_SDK_VERSION: "10.12.5",
      POLL_INTERVAL_MS: 10000,
    },
    window.EVG_BUILD_CONFIG || {}
  );
  const QUERY = new URLSearchParams(location.search);
  BUILD_CONFIG.USE_FIREBASE_API = true;
  BUILD_CONFIG.USE_GAS_API = false;
  BUILD_CONFIG.FIREBASE_USE_LOCAL_MOCK = QUERY.get("backend") === "firebase-mock" || BUILD_CONFIG.FIREBASE_USE_LOCAL_MOCK;
  if (QUERY.get("room") || QUERY.get("roomId")) {
    BUILD_CONFIG.FIREBASE_ROOM_ID = QUERY.get("room") || QUERY.get("roomId");
  }
  const REQUESTED_ROLE = QUERY.get("view") || QUERY.get("v") || "player";
  const PLAYER_ENTRY_LOCKED = (!QUERY.has("view") && !QUERY.has("v")) || REQUESTED_ROLE === "player";
  const TEST_SLOT = String(QUERY.get("testSlot") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const DEBUG_VIEW = QUERY.get("debug") === "1";
  const REMOTE_REVEAL_POLL_INTERVAL_MS = 15000;
  const AUDIO_BASE_PATH = "assets/audio/";
  const AUDIO_FILES = {
    bgm: {
      lobby: "bgm_lobby.mp3",
      stage_intro: "bgm_stage_intro.mp3",
      voting: "bgm_voting.mp3",
      countdown: "bgm_countdown.mp3",
      tallying: "bgm_tallying.mp3",
      reveal: "bgm_reveal.mp3",
      ranking: "bgm_ranking.mp3",
      final: "bgm_final.mp3",
    },
    se: {
      countdownStart: "se_countdown_start.mp3",
      countdownEnd: "se_countdown_end.mp3",
      board: "se_board.mp3",
      ride: "se_ride.mp3",
      exit: "se_exit.mp3",
      forcedOff: "se_forced_off.mp3",
    },
  };
  const STORAGE_KEYS = {
    room: "evg.room.v1",
    playerUuid: "evg.playerUuid.v1",
    hostAuthed: "evg.hostAuthed.v1",
    hostToken: "evg.hostToken.v1",
    hostTokenExpiresAt: "evg.hostTokenExpiresAt.v1",
    logs: "evg.logs.v1",
    screenReady: "evg.screenReady.v1",
    screenLocalSync: "evg.screenLocalSync.v1",
    personalHistoryCache: "evg.personalHistoryCache.v1",
    playerRankingHold: "evg.playerRankingHold.v1",
  };
  const LOCAL_SYNC_CHANNEL = "evg.local-room-sync.v1";
  const state = {
    role: REQUESTED_ROLE,
    room: null,
    playerUuid: localStorage.getItem(playerUuidStorageKey()) || "",
    hostAuthed: localStorage.getItem(STORAGE_KEYS.hostAuthed) === "true",
    hostToken: localStorage.getItem(STORAGE_KEYS.hostToken) || "",
    hostTokenExpiresAt: localStorage.getItem(STORAGE_KEYS.hostTokenExpiresAt) || "",
    screenReady: localStorage.getItem(STORAGE_KEYS.screenReady) === "true",
    screenLocalSync: localStorage.getItem(STORAGE_KEYS.screenLocalSync) === "true" || QUERY.get("screenSync") === "local",
    logs: loadJson(STORAGE_KEYS.logs, []),
    toast: "",
    toastId: 0,
    busyMessage: "",
    busyCount: 0,
    hostPasswordDraft: QUERY.get("password") || "",
    selectedHistoryUuid: "",
    personalHistoryCache: loadJson(STORAGE_KEYS.personalHistoryCache, {}),
    historyLoadingUuid: "",
    historyError: "",
    syncing: false,
    lastRevealPollAt: 0,
    revealCompletionCheckedFor: "",
    revealWasIncomplete: false,
    hostAutoTallyKey: "",
    hostAutoTallyInFlight: false,
    hostAutoTallyRetryAt: 0,
    playerRankingHold: null,
    nextGameConfigs: [],
    nextGameConfigsLoadedAt: "",
    nextGameConfigError: "",
    nextRemoteFetchAt: 0,
    playerNextDisabledUntil: 0,
    serverTimeOffsetMs: 0,
    firebaseUnsubscribe: null,
    firebaseStartedAt: "",
    lastRemoteRoomAt: "",
    lastRemoteSource: "",
    lastApi: null,
    lastHostAction: null,
    audio: {
      context: null,
      bgmKey: "",
      bgmElement: null,
      elements: {},
      missing: {},
      playErrors: {},
      triggered: {},
      revealKey: "",
      revealFloor: 0,
    },
  };
  const localSyncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(LOCAL_SYNC_CHANNEL) : null;
  const firebaseAdapter = window.EVGFirebaseAdapter
    ? window.EVGFirebaseAdapter.createFirebaseAdapter({
        config: BUILD_CONFIG,
        engine: Engine,
        getRole: () => state.role,
        getUuid: () => state.playerUuid,
        log: logClient,
      })
    : null;

  const $ = (selector) => document.querySelector(selector);

  document.addEventListener("DOMContentLoaded", () => {
    state.room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
    bindGlobalEvents();
    render();
    setInterval(tick, 1000);
    startRemoteSync();
    ensureVisibleHistoryCache();
    if (localSyncChannel) {
      localSyncChannel.addEventListener("message", (event) => {
        if (event.data && event.data.type === "room") applyLocalScreenRoom(event.data.room);
      });
    }
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEYS.room) {
        applyLocalScreenRoom(loadJson(STORAGE_KEYS.room, null));
      }
    });
  });

  function bindGlobalEvents() {
    $("#roleTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-role]");
      if (!button) return;
      if (isRoleBlocked(button.dataset.role)) return;
      const previousRole = state.role;
      state.role = button.dataset.role;
      if (state.role === "player") restorePlayerRankingHoldIfNeeded();
      history.replaceState(null, "", `?view=${state.role}`);
      render();
      ensureVisibleHistoryCache();
      if (isFirebaseMode() && previousRole !== state.role) restartFirebaseSync();
    });
    $("#app").addEventListener("submit", handleSubmit);
    $("#app").addEventListener("click", handleClick);
    $("#app").addEventListener("change", handleChange);
    $("#app").addEventListener("input", handleInput);
  }

  function tick() {
    if (!state.room) return;
    checkHostTokenExpiry();
    const needsCountdownRefresh =
      [Engine.PHASES.COUNTDOWN, Engine.PHASES.TALLYING].includes(state.room.phase) &&
      (state.role === "host" || state.role === "screen" || (state.role === "player" && !isEditingPlayerText()));
    const stage = Engine.getCurrentStage(state.room);
    const revealPlaybackIncomplete =
      stage &&
      state.room.animationStartedAt &&
      [Engine.PHASES.REVEAL, Engine.PHASES.RANKING].includes(state.room.phase) &&
      !isRevealPlaybackComplete(stage);
    const revealJustCompleted = stage && !revealPlaybackIncomplete && state.revealWasIncomplete;
    state.revealWasIncomplete = Boolean(revealPlaybackIncomplete);
    const needsRevealRefresh =
      Boolean(revealPlaybackIncomplete) &&
      ((state.role === "screen" && state.room.phase === Engine.PHASES.REVEAL) || state.role === "player");
    if (isRemoteMode()) maybeFetchRemoteAfterDeadline();
    maybeAutoCommitHostTally();
    if (needsRevealRefresh || revealJustCompleted) checkRevealCompletionRemoteState();
    syncScreenAudio();
    if (needsCountdownRefresh || needsRevealRefresh || revealJustCompleted) render();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busyMessage) return;
    const form = event.target;
    if (form.id === "joinForm") {
      const name = form.elements.name.value;
      const carryUuid = form.elements.restoreUuid.value.trim() || state.playerUuid;
      const result = await runMutation(
        () => Engine.registerPlayer(state.room, name, carryUuid || undefined),
        "/api/player/join",
        { name, uuid: carryUuid || undefined }
      );
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      state.playerUuid = result.player.uuid;
      localStorage.setItem(playerUuidStorageKey(), state.playerUuid);
      clearPlayerRankingHold();
      saveRoom("join", result.player.uuid);
      showToast("参加しました。");
      render();
    }
    if (form.id === "ticketForm") {
      const stage = Engine.getCurrentStage(state.room);
      const predictions = {};
      Engine.getPredictionEvents(stage).forEach((_, index) => {
        predictions[index] = form.elements[`prediction_${index}`]
          ? form.elements[`prediction_${index}`].value
          : "";
      });
      const ticket = {
        boardFloor: Number(form.elements.boardFloor.value),
        exitFloor: Number(form.elements.exitFloor.value),
        predictions,
      };
      const warnings = Engine.warningsForTicket(stage, ticket);
      if (warnings.length && !confirm(`${warnings.join("\n")}\n\n送信しますか？`)) return;
      const result = await runMutation(
        () => Engine.submitTicket(state.room, state.playerUuid, ticket),
        "/api/ticket/submit",
        { uuid: state.playerUuid, ticket }
      );
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      saveRoom("ticket.submit", state.playerUuid);
      showToast("チケットを更新しました。");
      render();
    }
    if (form.id === "hostAuthForm") {
      const password = form.elements.password.value;
      state.hostPasswordDraft = password;
      try {
        if (isRemoteMode()) {
          const result = await withBusy("認証中…", () => apiPost("/api/host/auth", { password }));
          if (!result.ok) return showToast(result.error || "パスワードが違います。");
          state.hostToken = result.hostToken || "";
          state.hostTokenExpiresAt = result.expiresAt || "";
          localStorage.setItem(STORAGE_KEYS.hostToken, state.hostToken);
          localStorage.setItem(STORAGE_KEYS.hostTokenExpiresAt, state.hostTokenExpiresAt);
        } else {
          const configured = getHostPassword(state.room);
          if (password !== configured) return showToast("パスワードが違います。");
        }
      } catch (error) {
        logClient("host.auth.error", error.message);
        return showToast(authErrorMessage(error));
      }
      state.hostAuthed = true;
      state.hostPasswordDraft = "";
      localStorage.setItem(STORAGE_KEYS.hostAuthed, "true");
      if (isFirebaseMode()) await restartFirebaseSync();
      else if (isRemoteMode()) await refreshRemoteState({ force: true, full: true, showLoading: true });
      render();
    }
    if (form.id === "renameForm") {
      const nextName = form.elements.nextName.value;
      const result = await runMutation(
        () => Engine.renamePlayer(state.room, state.playerUuid, nextName),
        "/api/player/rename",
        { uuid: state.playerUuid, name: nextName }
      );
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      saveRoom("player.rename", state.playerUuid);
      showToast(result.player.pendingName ? "次ステージから反映します。" : "名前を変更しました。");
      render();
    }
    if (form.id === "uuidImportForm") {
      const uuid = form.elements.importUuid.value.trim();
      if (!uuid) return showToast("UUIDを入力してください。");
      if (isRemoteMode()) {
        const result = await runMutation(
          () => ({ ok: true, room: state.room, player: getCurrentPlayer() }),
          "/api/player/restore",
          { uuid }
        );
        if (!result.ok) return showToast(result.error || "UUIDが見つかりません。");
        state.room = result.room;
      }
      state.playerUuid = uuid;
      localStorage.setItem(playerUuidStorageKey(), uuid);
      clearPlayerRankingHold();
      showToast("UUIDを設定しました。");
      render();
    }
  }

  async function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (button.disabled) return;
    if (state.busyMessage) return;
    if (action === "host-action") {
      const hostAction = button.dataset.hostAction;
      state.lastHostAction = hostDebugAction(hostAction, "start");
      logClient("host.action.start", state.lastHostAction);
      if (hostAction === "tally") {
        await commitHostTally("結果を保存中…");
        return;
      }
      const result = await runMutation(
        () => Engine.advancePhase(state.room, hostAction, "host"),
        remoteHostPath(hostAction),
        { hostName: "host" }
      );
      if (!result.ok) {
        state.lastHostAction = hostDebugAction(hostAction, "error", result);
        logClient("host.action.error", state.lastHostAction);
        await refreshRemoteState({ force: true, full: true, ignoreLocalVersion: true });
        return showToast(result.error || "操作できません。");
      }
      state.lastHostAction = hostDebugAction(hostAction, "ok", result);
      logClient("host.action.ok", state.lastHostAction);
      state.room = result.room;
      saveRoom(`host.${hostAction}`, "host");
      render();
    }
    if (action === "abstain") {
      const result = await runMutation(
        () => Engine.abstain(state.room, state.playerUuid),
        "/api/ticket/abstain",
        { uuid: state.playerUuid }
      );
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      saveRoom("ticket.abstain", state.playerUuid);
      showToast("棄権を送信しました。");
      render();
    }
    if (action === "player-next") {
      if (Date.now() < state.playerNextDisabledUntil) return;
      state.playerNextDisabledUntil = Date.now() + 5000;
      render();
      setTimeout(render, 5000);
      if (![Engine.PHASES.RANKING, Engine.PHASES.FINAL].includes(state.room.phase)) return showToast("ホストの操作待ちです。");
      const heldRoom = null;
      const beforeGameId = state.room.gameId;
      const beforePhase = state.room.phase;
      const beforeVersion = state.room.roomVersion || 0;
      if (isRemoteMode()) await refreshRemoteState({ force: true, showLoading: true });
      else state.room = loadRoom();
      if (state.room.gameId === beforeGameId && state.room.phase === beforePhase && (state.room.roomVersion || 0) === beforeVersion) {
        if (heldRoom) state.room = heldRoom;
        showToast("ホストの操作待ちです。");
      } else {
        clearPlayerRankingHold();
        if (state.room.gameId !== beforeGameId) showToast("次ゲームへ移動しました。");
      }
      render();
    }
    if (action === "screen-ready") {
      state.screenReady = true;
      localStorage.setItem(STORAGE_KEYS.screenReady, "true");
      startAudioContext();
      render();
    }
    if (action === "copy-uuid") {
      navigator.clipboard && navigator.clipboard.writeText(state.playerUuid);
      showToast("UUIDをコピーしました。");
    }
    if (action === "export-config") {
      downloadJson("elevator-game-config.json", state.room.config);
    }
    if (action === "import-config") {
      const textarea = $("#configJson");
      try {
        const config = Engine.normalizeConfig(JSON.parse(textarea.value));
        await startNextGameFromConfig(config, "host.config.import");
      } catch (error) {
        showToast(`JSONを読み込めません: ${error.message}`);
      }
    }
    if (action === "restart-current-config") {
      if (!confirm("現在のゲームJSONでもう一度ゲームを開始します。参加者は再アクセス後に表示されます。")) return;
      await startNextGameFromConfig(state.room.config, "host.config.restart");
    }
    if (action === "load-game-configs") {
      await loadGameConfigs(true);
    }
    if (action === "start-game-config") {
      const configId = button.dataset.configId || "";
      if (!configId) return;
      const interrupted = state.room.phase !== Engine.PHASES.FINAL;
      const completedStages = Object.keys(state.room.stageResults || {}).length;
      const message = interrupted
        ? `進行中のゲームを中断し、集計済み${completedStages}ステージ分を保存して次ゲームを開始します。未集計の投票や現在ステージの途中経過は破棄されます。`
        : "次ゲームを開始しますか？参加者は次ゲーム開始後にアクセスした端末だけ表示されます。";
      if (!confirm(message)) return;
      await startGameConfig(configId);
    }
    if (action === "import-stage") {
      const textarea = $("#stageJson");
      try {
        const stage = JSON.parse(textarea.value);
        const next = Engine.deepClone(state.room);
        next.config.stages.push(Engine.normalizeConfig({ stages: [stage] }).stages[0]);
        if (isRemoteMode()) {
          const result = await runMutation(
            () => ({ ok: true, room: next }),
            "/api/host/update-config",
            { config: next.config }
          );
          if (!result.ok) return showToast(result.error);
          state.room = result.room;
        } else {
          state.room = next;
        }
        saveRoom("host.stage.import", "host");
        showToast("ステージを追加しました。");
        render();
      } catch (error) {
        showToast(`JSONを読み込めません: ${error.message}`);
      }
    }
    if (action === "remove-player") {
      const uuid = button.dataset.uuid || "";
      const player = state.room.players.find((item) => item.uuid === uuid);
      if (!player) return showToast("現在ゲームの参加者ではありません。");
      if (!confirm(`${player.name} を現在ゲームから退室させます。保存済み履歴は削除しません。`)) return;
      const result = await runMutation(
        () => Engine.removePlayerFromRoom(state.room, uuid, "host"),
        "/api/host/remove-player",
        { uuid, hostName: "host" }
      );
      if (!result.ok) return showToast(result.error || "退室できませんでした。");
      state.room = result.room;
      saveRoom("host.player.remove", "host");
      showToast(`${player.name} を退室させました。`);
      render();
    }
    if (action === "select-history") {
      state.selectedHistoryUuid = button.dataset.uuid;
      render();
      ensureVisibleHistoryCache();
    }
  }

  function handleChange(event) {
    if (event.target.id === "muteToggle") {
      state.room.muted = event.target.checked;
      saveRoom("screen.mute", "host");
      render();
    }
  }

  function handleInput(event) {
    if (event.target.name === "password" && event.target.closest("#hostAuthForm")) {
      state.hostPasswordDraft = event.target.value;
    }
    if (event.target.id === "volumeRange") {
      state.room.volume = Number(event.target.value);
      saveRoom("screen.volume", "host");
    }
  }

  function render() {
    state.room = normalizeRoomShape(state.room) || Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
    restorePlayerRankingHoldIfNeeded();
    const app = $("#app");
    document.body.dataset.phase = state.room.phase;
    document.body.dataset.role = state.role;
    [...document.querySelectorAll("[data-role]")].forEach((button) => {
      button.classList.toggle("is-active", button.dataset.role === state.role);
      button.disabled = isRoleBlocked(button.dataset.role);
    });
    const views = {
      player: renderPlayerView,
      host: renderHostView,
      screen: renderScreenView,
      history: renderHistoryView,
      settings: renderSettingsView,
    };
    app.innerHTML = `
      ${state.toast ? `<div class="toast" role="status">${escapeHtml(state.toast)}</div>` : ""}
      ${views[state.role] ? views[state.role]() : renderPlayerView()}
      ${state.busyMessage ? `<div class="loading-overlay" role="status" aria-live="polite"><div class="loading-box"><span></span><strong>${escapeHtml(state.busyMessage)}</strong></div></div>` : ""}
    `;
    syncScreenAudio();
  }

  function isRoleBlocked(role) {
    return PLAYER_ENTRY_LOCKED && (role === "host" || role === "screen");
  }

  function renderPlayerView() {
    const player = getCurrentPlayer();
    if (!player) return renderJoin();
    const stage = Engine.getCurrentStage(state.room);
    const ticket = getStageTickets()[state.playerUuid];
    const result = getCurrentStageResult();
    return `
      <section class="shell player-shell">
        <header class="view-header">
          <div>
            <p class="eyebrow">Player</p>
            <h1>${escapeHtml(player.name)}</h1>
          </div>
          <div class="stat-strip">
            <span>合計 ${formatScore(state.room.scores[player.uuid] || 0)}</span>
            <span>Skill ${formatSkill(player.skill || 0)}</span>
          </div>
        </header>
        ${renderPhaseBanner()}
        ${stage ? renderStageSummary(stage) : ""}
        ${renderPlayerBody(stage, ticket, result)}
      </section>
    `;
  }

  function renderJoin() {
    const initialName = QUERY.get("name") || "";
    return `
      <section class="shell narrow">
        <header class="view-header">
          <div>
            <p class="eyebrow">Entry</p>
            <h1>参加登録</h1>
          </div>
        </header>
        <form id="joinForm" class="panel form-grid">
          <label>名前<input name="name" maxlength="24" autocomplete="name" value="${escapeAttr(initialName)}" required></label>
          <details class="carry-over">
            <summary>データを引き継いではじめる</summary>
            <label>過去のUUID<input name="restoreUuid" autocomplete="off" placeholder="UUIDを貼り付け"></label>
          </details>
          <button class="primary" type="submit">参加</button>
        </form>
      </section>
    `;
  }

  function renderPlayerBody(stage, ticket, result) {
    if (!stage) return `<div class="panel">ステージがありません。</div>`;
    if ([Engine.PHASES.VOTING, Engine.PHASES.COUNTDOWN].includes(state.room.phase)) {
      return renderTicketForm(stage, ticket);
    }
    if (
      state.room.animationStartedAt &&
      [Engine.PHASES.REVEAL, Engine.PHASES.RANKING].includes(state.room.phase) &&
      !isRevealPlaybackComplete(stage)
    ) {
      return `<div class="panel waiting-result"><h2>結果発表中</h2><p>スクリーンをご覧ください。</p></div>`;
    }
    if ([Engine.PHASES.REVEAL, Engine.PHASES.RANKING, Engine.PHASES.FINAL].includes(state.room.phase)) {
      if (state.room.phase === Engine.PHASES.RANKING) holdPlayerRanking();
      return renderPlayerResult(result);
    }
    return `
      <div class="panel split">
        <div>
          <h2>チケット</h2>
          <p class="muted">${renderTicketSummary(ticket)}</p>
        </div>
        <button data-action="player-next" ${playerNextDisabledAttr()}>${state.room.phase === Engine.PHASES.FINAL ? "次ゲームへ" : "次へ"}</button>
      </div>
    `;
  }

  function renderTicketForm(stage, ticket) {
    const predictionEvents = Engine.getPredictionEvents(stage);
    return `
      <form id="ticketForm" class="panel ticket-grid">
        ${renderPlayerInlineCountdown()}
        <label>乗車階
          <input name="boardFloor" type="number" min="1" max="${stage.params.N}" value="${ticket && !ticket.abstained ? ticket.boardFloor : 1}" required>
        </label>
        <label>降車階
          <input name="exitFloor" type="number" min="1" max="${stage.params.N}" value="${ticket && !ticket.abstained ? ticket.exitFloor : stage.params.N}" required>
        </label>
        ${predictionEvents.map((event, index) => renderPredictionInput(event, index, ticket)).join("")}
        <div class="form-actions">
          <button class="primary" type="submit">購入</button>
          <button type="button" data-action="abstain">棄権</button>
        </div>
      </form>
    `;
  }

  function renderPlayerInlineCountdown() {
    if (state.room.phase === Engine.PHASES.COUNTDOWN && !isRemoteMoving()) {
      return `<div class="inline-countdown"><span>締切まで</span><strong>${countdownSeconds()}秒</strong></div>`;
    }
    if (isRemoteMoving() || state.room.phase === Engine.PHASES.TALLYING) {
      return `<div class="inline-countdown"><span>移動中…</span><strong>${movingSeconds()}秒</strong></div>`;
    }
    return "";
  }

  function renderPredictionInput(event, index, ticket) {
    const value = ticket && ticket.predictions ? ticket.predictions[index] || "" : "";
    if (event.answerFormat === "yesno") {
      return `
        <label>${escapeHtml(event.question)}
          <select name="prediction_${index}">
            <option value="" ${value === "" ? "selected" : ""}>回答しない</option>
            <option value="yes" ${value === "yes" ? "selected" : ""}>Yes</option>
            <option value="no" ${value === "no" ? "selected" : ""}>No</option>
          </select>
        </label>
      `;
    }
    if (event.answerFormat === "range" || event.answerFormat === "select") {
      const options = getPredictionSelectOptions(event);
      return `
        <label>${escapeHtml(event.question)}
          <select name="prediction_${index}">
            <option value="" ${value === "" ? "selected" : ""}>回答しない</option>
            ${options.map((option) => `<option value="${escapeAttr(option.value)}" ${String(value) === String(option.value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
          </select>
        </label>
      `;
    }
    if (event.answerFormat === "player" || event.answerFormat === "player_uuid") {
      return `
        <label>${escapeHtml(event.question)}
          <select name="prediction_${index}">
            <option value="" ${value === "" ? "selected" : ""}>回答しない</option>
            ${state.room.players.map((player) => `<option value="${escapeAttr(player.uuid)}" ${value === player.uuid ? "selected" : ""}>${escapeHtml(player.name)}</option>`).join("")}
          </select>
        </label>
      `;
    }
    if (event.answerFormat === "integer") {
      return `<label>${escapeHtml(event.question)}<input name="prediction_${index}" type="number" value="${escapeAttr(value)}"></label>`;
    }
    return `<label>${escapeHtml(event.question)}<input name="prediction_${index}" value="${escapeAttr(value)}"></label>`;
  }

  function getPredictionSelectOptions(event) {
    return (event.options || event.choices || event.ranges || []).map((option, index) => ({
      value: option.value !== undefined ? String(option.value) : String(index),
      label: option.label || option.name || formatRangeLabel(option),
    }));
  }

  function formatRangeLabel(option) {
    const min = option.min ?? option.from ?? option.lower;
    const max = option.max ?? option.to ?? option.upper;
    if (min !== undefined && max !== undefined) return `${min}〜${max}`;
    if (min !== undefined) return `${min}以上`;
    if (max !== undefined) return `${max}以下`;
    return "選択肢";
  }

  function renderTicketSummary(ticket) {
    if (!ticket) return "未購入";
    if (ticket.abstained) return "棄権";
    return `${ticket.boardFloor}階 → ${ticket.exitFloor}階`;
  }

  function renderPlayerResult(result) {
    const myResult = result && result.players ? result.players[state.playerUuid] : null;
    if (!myResult) return `<div class="panel">結果待ち</div>`;
    return `
      <div class="result-layout">
        <section class="panel score-card">
          <p class="eyebrow">Stage Score</p>
          <strong>${formatScore(myResult.score)}</strong>
          <span>${statusLabel(myResult.status)}</span>
        </section>
        <section class="panel breakdown">
          <h2>内訳</h2>
          <dl>
            <div><dt>乗車成功点</dt><dd>${formatScore(myResult.successPoint)}</dd></div>
            <div><dt>イベント補正</dt><dd>${formatScore(myResult.eventBonus)}</dd></div>
            <div><dt>チケット代</dt><dd>-${formatScore(myResult.penalty)}</dd></div>
            <div><dt>成功階数</dt><dd>${formatScore(myResult.actualRise)}階</dd></div>
            <div><dt>StageSkill</dt><dd>${myResult.stageSkill === null ? "-" : formatSkill(myResult.stageSkill)}</dd></div>
          </dl>
        </section>
        <section class="panel">
          <h2>予想</h2>
          ${myResult.predictionBreakdown.length ? myResult.predictionBreakdown.map((item) => `
            <div class="mini-row">
              <span>${escapeHtml(item.question)}</span>
              <strong>${formatScore(item.score)}</strong>
            </div>
          `).join("") : `<p class="muted">なし</p>`}
        </section>
        <button data-action="player-next" ${playerNextDisabledAttr()}>次へ</button>
      </div>
    `;
  }

  function renderHostView() {
    if (!state.hostAuthed || (isRemoteMode() && !state.hostToken)) {
      return `
        <section class="shell narrow">
          <header class="view-header"><div><p class="eyebrow">Host</p><h1>認証</h1></div></header>
          <form id="hostAuthForm" class="panel form-grid">
            <label>パスワード<input name="password" type="password" value="${escapeAttr(state.hostPasswordDraft)}" required></label>
            <button class="primary" type="submit">認証</button>
          </form>
          ${renderHostAuthDebugPanel()}
        </section>
      `;
    }
    const stage = Engine.getCurrentStage(state.room);
    return `
      <section class="shell host-shell">
        <header class="view-header">
          <div>
            <p class="eyebrow">Host</p>
            <h1>${escapeHtml(state.room.config.gameMeta.title)}</h1>
          </div>
          <div class="stat-strip">
            <span>${stage ? `${state.room.currentStageIndex + 1}/${state.room.config.stages.length}, ${escapeHtml(stage.name)}` : "-"}</span>
            <span>${phaseLabel(state.room.phase)}</span>
            <span>${state.room.players.length}人</span>
          </div>
        </header>
        <div class="host-grid">
          ${renderHostFlowPanel()}
          ${renderHostNextPanel()}
          <section class="panel">
            <h2>音量</h2>
            <label class="inline"><input id="muteToggle" type="checkbox" ${state.room.muted ? "checked" : ""}>Mute</label>
            <input id="volumeRange" type="range" min="0" max="1" step="0.05" value="${state.room.volume}">
          </section>
          <section class="panel wide">
            <h2>現在ステージ</h2>
            ${stage ? renderStageSummary(stage) : ""}
          </section>
          <section class="panel wide">
            <h2>参加者</h2>
            ${renderParticipantsTable()}
          </section>
          ${renderInternalStatusPanel()}
          ${renderNextGamePanel()}
          <section class="panel wide">
            <h2>設定</h2>
            <div class="form-actions">
              <button type="button" data-action="export-config">Export</button>
              <button type="button" data-action="restart-current-config">同じJSONで再開始</button>
            </div>
            <textarea id="configJson" rows="8" spellcheck="false">${escapeHtml(JSON.stringify(state.room.config, null, 2))}</textarea>
            <button type="button" data-action="import-config">Import</button>
            <textarea id="stageJson" rows="5" spellcheck="false" placeholder="stage JSON"></textarea>
            <button type="button" data-action="import-stage">Stage Import</button>
          </section>
          <section class="panel">
            <h2>操作ログ</h2>
            <div class="log-list">${state.room.operations.map((item) => `<p>${formatTime(item.at)} ${escapeHtml(item.actor)} ${escapeHtml(item.action)}</p>`).join("") || `<p class="muted">なし</p>`}</div>
          </section>
          <section class="panel wide">
            <h2>通信ログ</h2>
            ${renderClientLogs(30)}
          </section>
        </div>
      </section>
    `;
  }

  function renderHostFlowPanel() {
    const steps = [
      ["lobby", "参加"],
      ["stage_intro", "説明"],
      ["voting", "投票"],
      ["countdown", "締切"],
      ["tallying", "移動"],
      ["reveal", "発表"],
      ["ranking", "順位"],
      ["final", "終了"],
    ];
    const currentIndex = Math.max(0, steps.findIndex(([phase]) => phase === state.room.phase));
    const nextAction = {
      lobby: "説明へ",
      stage_intro: "受付開始",
      voting: "締切",
      countdown: "移動完了待ち",
      tallying: "移動完了待ち",
      reveal: "順位発表へ",
      ranking: "次ステージへ",
      final: "次ゲーム準備",
    }[state.room.phase] || "-";
    return `
      <section class="panel wide flow-panel">
        <div class="flow-steps">
          ${steps.map(([phase, label], index) => `
            <div class="flow-step ${index < currentIndex ? "is-done" : ""} ${index === currentIndex ? "is-current" : ""}">
              <span>${index + 1}</span>
              <strong>${label}</strong>
            </div>
          `).join("")}
        </div>
        <div class="flow-next">
          <span>次の操作</span>
          <strong>${escapeHtml(nextAction)}</strong>
          <small>${remoteModeLabel()}</small>
        </div>
      </section>
    `;
  }

  function renderHostNextPanel() {
    const next = nextHostAction();
    return `
      <section class="panel host-next-panel">
        <h2>進行</h2>
        <button class="primary host-next-button" type="button" data-action="host-action" data-host-action="${escapeAttr(next.action || "")}" ${next.enabled ? "" : "disabled"}>次へ</button>
        <p class="muted">${escapeHtml(next.description)}</p>
      </section>
    `;
  }

  function renderInternalStatusPanel() {
    const stage = Engine.getCurrentStage(state.room);
    const ticketCount = stage && state.room.tickets[stage.stageId] ? Object.keys(state.room.tickets[stage.stageId]).length : 0;
    const resultCount = Object.keys(state.room.stageResults || {}).length;
    const firebaseInfo = firebaseAdapter && firebaseAdapter.getDebugInfo ? firebaseAdapter.getDebugInfo() : {};
    const rows = [
      ["role", state.role],
      ["backend", remoteModeLabel()],
      ["roomId", BUILD_CONFIG.FIREBASE_ROOM_ID],
      ["gameId", state.room.gameId],
      ["phase", state.room.phase],
      ["phaseLabel", phaseLabel(state.room.phase)],
      ["currentStageIndex", state.room.currentStageIndex],
      ["currentStageId", stage ? stage.stageId : ""],
      ["roomVersion", state.room.roomVersion || 0],
      ["players", state.room.players.length],
      ["currentStageTickets", ticketCount],
      ["stageResults", resultCount],
      ["hostAuthed", state.hostAuthed],
      ["hostToken", state.hostToken ? "present" : "empty"],
      ["hostTokenExpiresAt", state.hostTokenExpiresAt || ""],
      ["serverTimeOffsetMs", Math.round(state.serverTimeOffsetMs || 0)],
      ["syncing", state.syncing],
      ["busyMessage", state.busyMessage || ""],
      ["firebaseStartedAt", state.firebaseStartedAt || ""],
      ["lastRemoteRoomAt", state.lastRemoteRoomAt || ""],
      ["lastRemoteSource", state.lastRemoteSource || ""],
      ["firebaseUid", firebaseInfo.uid || ""],
      ["firebaseMock", Boolean(firebaseInfo.mock)],
      ["isHostAllowed", Boolean(firebaseInfo.isHostAllowed)],
      ["subscriptionRole", firebaseInfo.role || ""],
      ["baseSubscriptions", (firebaseInfo.basePaths || []).join(", ")],
      ["stageSubscriptions", (firebaseInfo.stagePaths || []).join(", ")],
      ["lastRulesError", firebaseInfo.lastRulesError || ""],
      ["lastTransactionPublic", firebaseInfo.lastTransactionPublic ? compactJson(firebaseInfo.lastTransactionPublic) : ""],
      ["lastApi", state.lastApi ? compactJson(state.lastApi) : ""],
      ["lastHostAction", state.lastHostAction ? compactJson(state.lastHostAction) : ""],
    ];
    return `
      <section id="internal-status" class="panel wide internal-status">
        <h2>internal-status</h2>
        <dl>
          ${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(formatDebugValue(value))}</dd></div>`).join("")}
        </dl>
      </section>
    `;
  }

  function renderHostAuthDebugPanel() {
    const firebaseInfo = firebaseAdapter && firebaseAdapter.getDebugInfo ? firebaseAdapter.getDebugInfo() : {};
    const rows = [
      ["backend", remoteModeLabel()],
      ["roomId", BUILD_CONFIG.FIREBASE_ROOM_ID],
      ["firebaseUid", firebaseInfo.uid || ""],
      ["isHostAllowed", Boolean(firebaseInfo.isHostAllowed)],
      ["baseSubscriptions", (firebaseInfo.basePaths || []).join(", ")],
      ["lastRulesError", firebaseInfo.lastRulesError || ""],
      ["lastApi", state.lastApi ? compactJson(state.lastApi) : ""],
    ];
    return `
      <section id="internal-status" class="panel internal-status">
        <h2>internal-status</h2>
        <dl>
          ${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(formatDebugValue(value))}</dd></div>`).join("")}
        </dl>
      </section>
    `;
  }

  function renderClientLogs(limit) {
    const rows = state.logs.slice(0, limit || 50);
    return `<div class="log-list debug-log-list">${rows.map((item) => `
      <p>
        <span>${formatTime(item.at)}</span>
        <strong>${escapeHtml(item.kind)}</strong>
        <code>${escapeHtml(item.message)}</code>
      </p>
    `).join("") || `<p class="muted">なし</p>`}</div>`;
  }

  function formatDebugValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return compactJson(value);
  }

  function compactJson(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  function renderNextGamePanel() {
    return `
      <section class="panel wide next-game-panel">
        <div class="panel-heading">
          <div>
            <h2>次ゲーム</h2>
            <p class="muted">Firebase版では、次ゲーム設定は当面JSON Importで開始します。</p>
          </div>
        </div>
        <p class="muted">設定JSON Importを使用してください。</p>
      </section>
    `;
  }

  function renderGameConfigOption(item) {
    const stageNames = (item.stageNames || []).slice(0, 6).join(" / ");
    const invalid = item.valid === false;
    const completedStages = Object.keys(state.room.stageResults || {}).length;
    const canStart = !invalid && (state.room.phase === Engine.PHASES.FINAL || completedStages > 0);
    const buttonLabel = state.room.phase === Engine.PHASES.FINAL ? "開始" : "中断して開始";
    return `
      <div class="game-config-item ${invalid ? "is-invalid" : ""}">
        <div>
          <strong>${escapeHtml(item.name || item.title || item.configId)}</strong>
          <span>${escapeHtml(item.configId)} ・ ${Number(item.stageCount || 0)}ステージ</span>
          <p>${escapeHtml(stageNames || item.notes || "ステージ名なし")}</p>
          ${item.notes && stageNames ? `<p class="muted">${escapeHtml(item.notes)}</p>` : ""}
          ${invalid ? `<p class="muted">JSONエラー: ${escapeHtml(item.error || "読み込み不可")}</p>` : ""}
        </div>
        <button type="button" class="primary" data-action="start-game-config" data-config-id="${escapeAttr(item.configId)}" ${canStart ? "" : "disabled"}>${buttonLabel}</button>
      </div>
    `;
  }

  function renderScreenView() {
    const stage = Engine.getCurrentStage(state.room);
    const result = getCurrentStageResult();
    const reviewMode = state.room.phase === Engine.PHASES.REVEAL && stage && isRevealComplete(stage);
    return `
      <section class="screen-shell ${reviewMode ? "is-review" : ""}">
        ${!state.screenReady ? `<button class="ready-button" data-action="screen-ready">準備完了</button>` : ""}
        ${isGasMode() && state.role === "screen" ? `<button class="screen-sync-button" data-action="screen-local-sync">${state.screenLocalSync ? "同一端末同期中" : "同一端末同期"}</button>` : ""}
        <div class="screen-top">
          <p>${escapeHtml(state.room.config.gameMeta.title)}</p>
          <span>${phaseLabel(state.room.phase)}</span>
        </div>
        ${renderScreenMain(stage, result)}
        ${DEBUG_VIEW ? `<div class="screen-debug-panel">${renderClientLogs(12)}</div>` : ""}
      </section>
    `;
  }

  function renderScreenMain(stage, result) {
    if (state.room.phase === Engine.PHASES.LOBBY) {
      const joinUrl = location.origin + location.pathname + "?view=player";
      return `
        <div class="screen-lobby">
          <h1>参加受付中</h1>
          <div class="join-panel">
            <div class="join-qr">${renderQrCode(joinUrl)}</div>
            <div class="join-url">${escapeHtml(joinUrl)}</div>
          </div>
          <div class="screen-players">${state.room.players.map((player) => `<span>${escapeHtml(player.name)}</span>`).join("")}</div>
        </div>
      `;
    }
    if (state.room.phase === Engine.PHASES.COUNTDOWN && isRemoteMoving()) {
      return `<div class="moving-screen"><span></span><h1>移動中…</h1></div>`;
    }
    if (state.room.phase === Engine.PHASES.COUNTDOWN) {
      return `<div class="countdown-number">${countdownSeconds()}</div>`;
    }
    if (state.room.phase === Engine.PHASES.TALLYING) {
      return `<div class="moving-screen"><span></span><h1>移動中…</h1></div>`;
    }
    if (state.room.phase === Engine.PHASES.REVEAL && result) {
      return renderElevatorAnimation(stage, result);
    }
    if ([Engine.PHASES.RANKING, Engine.PHASES.FINAL].includes(state.room.phase)) {
      return renderRankingBoard();
    }
    return `
      <div class="screen-stage">
        <h1>${escapeHtml(stage.name)}</h1>
        ${renderStageSummary(stage)}
        ${state.room.phase === Engine.PHASES.STAGE_INTRO ? "" : renderTicketProgress()}
      </div>
    `;
  }

  function renderElevatorAnimation(stage, result) {
    const floors = Array.from({ length: stage.params.N }, (_, index) => stage.params.N - index);
    const forcedFloors = new Set(result.timeline.filter((step) => step.forcedOff.length).map((step) => step.floor));
    const timelineByFloor = new Map(result.timeline.map((step) => [step.floor, step]));
    const tickets = state.room.tickets[result.stageId] || {};
    const duration = getRevealDuration(stage);
    const elapsed = getRevealElapsedSeconds();
    const currentFloor = getRevealFloor(stage, duration);
    const reviewMode = isRevealComplete(stage);
    const scoreRows = buildRevealScoreRows(stage, result, currentFloor);
    return `
      <div class="elevator-board">
        <div class="elevator-camera ${reviewMode ? "reveal-complete" : ""}" style="--floor-count:${stage.params.N}; --track-height:${stage.params.N * 84}px; --travel-shift:${Math.max(0, stage.params.N - 1) * 84}px; --travel-duration:${duration}s; --reveal-delay:-${Math.min(elapsed, duration)}s">
          <div class="shaft-track">
            ${floors.map((floor) => renderFloorEvent(floor, timelineByFloor.get(floor), result, tickets, forcedFloors.has(floor), currentFloor)).join("")}
          </div>
          <div class="car"><span>EV</span></div>
        </div>
        <div class="screen-result-list">
          ${result.rankings.slice(0, 8).map((row) => `<div><span>${row.rank}. ${escapeHtml(row.name)}</span><strong>${formatScore(row.score)}</strong></div>`).join("")}
        </div>
        <div class="reveal-scoreboard">
          ${scoreRows.map((row) => `
            <div class="score-tile ${row.delta > 0 ? "gain" : row.delta < 0 ? "loss" : ""}">
              <span>${escapeHtml(shortName(row.name))}</span>
              <strong>${formatScore(row.score)}</strong>
              <em>${row.reason}</em>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderFloorEvent(floor, step, result, tickets, danger, currentFloor) {
    const blocked = Object.values(tickets)
      .filter((ticket) => !ticket.abstained && ticket.boardFloor === floor)
      .map((ticket) => ticket.uuid)
      .filter((uuid) => ["invalid", "not_boarded"].includes(result.players[uuid] ? result.players[uuid].status : ""));
    const forced = step ? step.forcedOff : [];
    const boarding = step ? step.boarding.filter((uuid) => !forced.includes(uuid)) : [];
    const exiting = step ? step.exiting : [];
    const passengers = step ? step.passengersAfterCheck.filter((uuid) => !boarding.includes(uuid) && !exiting.includes(uuid)) : [];
    const visible = floor <= currentFloor;
    const revealedDanger = danger && visible;
    return `
      <div class="floor ${revealedDanger ? "danger" : ""} ${visible ? "is-revealed" : "is-future"}">
        <span class="floor-label">${floor}F</span>
        <div class="floor-activity">
          ${visible ? renderChipGroup("乗車", boarding, result, "boarding") : ""}
          ${visible ? renderChipGroup("乗車不可", blocked, result, "blocked") : ""}
          ${visible ? renderChipGroup("乗車中", passengers, result, "riding") : ""}
          ${visible ? renderChipGroup("下車", exiting, result, "exiting") : ""}
          ${visible ? renderChipGroup("強制下車", forced, result, "forced") : ""}
        </div>
      </div>
    `;
  }

  function renderChipGroup(label, uuids, result, kind) {
    if (!uuids || uuids.length === 0) return "";
    const chips = uuids.map((uuid) => {
      const name = result.players[uuid] ? result.players[uuid].name : uuid;
      return `<b class="player-chip ${kind}">${escapeHtml(shortName(name))}</b>`;
    }).join("");
    return `<div class="chip-group ${kind}"><em>${label}</em>${chips}</div>`;
  }

  function renderTicketProgress() {
    const tickets = Object.values(getStageTickets());
    const presence = getStageTicketPresence();
    const purchased = tickets.length
      ? tickets.filter((ticket) => ticket && !ticket.abstained).length
      : Object.values(presence).filter((item) => item && item.status === "submitted").length;
    const total = state.room.players.length;
    const degrees = total > 0 ? Math.round((purchased / total) * 360) : 0;
    return `
      <div class="progress-ring" style="--progress:${degrees}deg">
        <strong>${purchased}/${total}</strong>
        <span>購入</span>
      </div>
    `;
  }

  function renderQrCode(text) {
    if (typeof qrcode !== "function") {
      return `<span class="qr-fallback">QR</span>`;
    }
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      return qr.createSvgTag(5, 2);
    } catch (error) {
      logClient("qr.error", error.message);
      return `<span class="qr-fallback">QR</span>`;
    }
  }

  function getRevealDuration(stage) {
    return Math.max(12, stage.params.N * 1.6);
  }

  function getRevealElapsedSeconds() {
    if (state.room.animationSkippedAt) return Infinity;
    const started = state.room.animationStartedAt ? new Date(state.room.animationStartedAt).getTime() : serverNow();
    return Math.max(0, (serverNow() - started) / 1000);
  }

  function getRevealFloor(stage, duration) {
    if (state.room.animationSkippedAt) return stage.params.N;
    const elapsedSeconds = getRevealElapsedSeconds();
    const floor = Math.floor(elapsedSeconds / (duration / stage.params.N)) + 1;
    return Math.max(1, Math.min(stage.params.N, floor));
  }

  function isRevealComplete(stage) {
    if (!stage || state.room.phase !== Engine.PHASES.REVEAL) return false;
    return isRevealPlaybackComplete(stage);
  }

  function isRevealPlaybackComplete(stage) {
    if (!stage) return false;
    if (state.room.animationSkippedAt) return true;
    if (!state.room.animationStartedAt) return false;
    return getRevealElapsedSeconds() >= getRevealDuration(stage);
  }

  function holdPlayerRanking() {
    if (state.role !== "player" || !state.room || state.room.phase !== Engine.PHASES.RANKING) return;
    const stage = Engine.getCurrentStage(state.room);
    const key = playerRankingHoldKey(state.room, stage);
    if (!state.playerRankingHold || state.playerRankingHold.key !== key) {
      state.playerRankingHold = {
        key,
        uuid: state.playerUuid,
        gameId: state.room.gameId,
        stageId: stage ? stage.stageId : "",
        phase: state.room.phase,
        currentStageIndex: state.room.currentStageIndex || 0,
        savedAt: new Date().toISOString(),
      };
      persistPlayerRankingHold();
    }
  }

  function hasPlayerRankingHold() {
    return Boolean(
      state.playerRankingHold &&
        state.playerRankingHold.phase === Engine.PHASES.RANKING &&
        state.playerRankingHold.uuid === state.playerUuid
    );
  }

  function restorePlayerRankingHoldIfNeeded() {
    loadPlayerRankingHold();
    if (state.role !== "player" || !hasPlayerRankingHold()) return;
    if (shouldDiscardPlayerRankingHold()) {
      clearPlayerRankingHold();
      return;
    }
  }

  function isPlayerRankingHeld() {
    return false;
  }

  function playerRankingHoldKey(room, stage) {
    return [state.playerUuid || "", room.gameId || "", stage ? stage.stageId : "", room.currentStageIndex || 0].join(":");
  }

  function persistPlayerRankingHold() {
    if (!state.playerRankingHold) return;
    localStorage.setItem(STORAGE_KEYS.playerRankingHold, JSON.stringify(state.playerRankingHold));
  }

  function loadPlayerRankingHold() {
    if (state.playerRankingHold || state.role !== "player" || !state.playerUuid) return;
    const saved = loadJson(STORAGE_KEYS.playerRankingHold, null);
    if (saved && saved.uuid === state.playerUuid && saved.phase === Engine.PHASES.RANKING) {
      state.playerRankingHold = saved;
    }
  }

  function shouldDiscardPlayerRankingHold() {
    if (!state.playerRankingHold) return true;
    if (state.playerRankingHold.uuid !== state.playerUuid) return true;
    if (state.playerRankingHold.phase === Engine.PHASES.FINAL) return true;
    const expectedKey = [state.playerRankingHold.uuid || "", state.playerRankingHold.gameId || "", state.playerRankingHold.stageId || "", state.playerRankingHold.currentStageIndex || 0].join(":");
    return state.playerRankingHold.key !== expectedKey;
  }

  function clearPlayerRankingHold() {
    state.playerRankingHold = null;
    localStorage.removeItem(STORAGE_KEYS.playerRankingHold);
  }

  function buildRevealScoreRows(stage, result, currentFloor) {
    return Object.values(result.players)
      .map((playerResult) => calculateRevealScore(stage, result, playerResult, currentFloor))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ja"));
  }

  function calculateRevealScore(stage, result, playerResult, currentFloor) {
    if (!playerResult.ticket || playerResult.ticket.abstained) {
      return { uuid: playerResult.uuid, name: playerResult.name, score: 0, delta: 0, reason: "未参加" };
    }
    let score = -Number(playerResult.penalty || 0);
    let delta = score;
    let reason = "運賃";
    const e3bMultiplier = getScoreMultiplier(stage, playerResult.ticket);
    (playerResult.successfulIntervals || []).forEach((interval) => {
      const floor = interval.sameFloor ? interval.from : interval.to;
      if (floor > currentFloor) return;
      const gained = intervalScore(stage, interval, e3bMultiplier);
      score += gained;
      if (floor === currentFloor && gained) {
        delta += gained;
        reason = "上昇報酬";
      }
    });
    (stage.events || []).forEach((event) => {
      if (event.type === "E4_special_floor" && currentFloor >= Number(event.floor) && result.timeline.some((step) => step.floor === Number(event.floor) && step.passengersAfterCheck.includes(playerResult.uuid))) {
        const bonus = Number(event.bonus || event.score || 0);
        score += bonus;
        if (currentFloor === Number(event.floor)) {
          delta += bonus;
          reason = "特別階";
        }
      }
      if (event.type === "E6_view_bonus" && playerResult.status === "success" && currentFloor >= Number(playerResult.ticket.exitFloor)) {
        const bonus = Number(playerResult.ticket.exitFloor) * Number(event.bonusPerExitFloor || event.multiplier || 0);
        score += bonus;
        if (currentFloor === Number(playerResult.ticket.exitFloor)) {
          delta += bonus;
          reason = "眺望";
        }
      }
    });
    if (currentFloor >= stage.params.N) {
      const predictionBonus = (playerResult.predictionBreakdown || []).reduce((sum, item) => sum + Number(item.score || 0), 0);
      score += predictionBonus;
      if (predictionBonus) {
        delta += predictionBonus;
        reason = "予想";
      }
    }
    return { uuid: playerResult.uuid, name: playerResult.name, score, delta, reason };
  }

  function intervalScore(stage, interval, e3bMultiplier) {
    const distance = interval.sameFloor ? 1 : interval.to - interval.from;
    let multiplier = e3bMultiplier;
    (stage.events || []).forEach((event) => {
      if (event.type === "E3a_zone_multiplier" && intervalTouchesZone(interval, event)) {
        multiplier *= Number(event.multiplier || 1);
      }
      if (event.type === "E5_occupancy_multiplier" && interval.occupancy >= Number(event.threshold || Infinity)) {
        multiplier *= Number(event.multiplier || 1);
      }
    });
    return distance * Number(stage.params.P || 0) * multiplier;
  }

  function getScoreMultiplier(stage, ticket) {
    return (stage.events || []).reduce((multiplier, event) => {
      if (event.type === "E3b_score_multiplier" && routeTouchesZone(ticket, event)) {
        return multiplier * Number(event.multiplier || 1);
      }
      return multiplier;
    }, 1);
  }

  function intervalTouchesZone(interval, event) {
    const from = Number(event.fromFloor);
    const to = Number(event.toFloor);
    if (interval.sameFloor) return interval.from >= from && interval.from <= to;
    return interval.from >= from && interval.to <= to;
  }

  function routeTouchesZone(ticket, event) {
    if (!ticket) return false;
    for (let floor = ticket.boardFloor; floor <= ticket.exitFloor; floor += 1) {
      if (floor >= Number(event.fromFloor) && floor <= Number(event.toFloor)) return true;
    }
    return false;
  }

  function renderHistoryView() {
    const rankings = buildHistoryRankings();
    const selectedUuid = state.playerUuid || "";
    const selected = state.room.players.find((player) => player.uuid === selectedUuid);
    const historyEntry = getPersonalHistoryCache(selectedUuid);
    return `
      <section class="shell">
        <header class="view-header"><div><p class="eyebrow">History</p><h1>戦歴</h1></div></header>
        <div class="history-grid">
          <section class="panel">
            <h2>ランキング</h2>
            ${rankings.map((row) => `
              <button class="ranking-row ${row.uuid === state.playerUuid ? "is-self" : ""}" data-action="select-history" data-uuid="${escapeAttr(row.uuid)}" ${row.uuid === state.playerUuid ? "" : "disabled"}>
                <span>${row.rank}. ${escapeHtml(row.name)}</span><strong>${formatScore(row.score)}</strong>
              </button>
            `).join("") || `<p class="muted">なし</p>`}
          </section>
          <section class="panel">
            <h2>個人</h2>
            ${!state.playerUuid ? `<p class="muted">個人戦績は本人UUIDがある端末でのみ表示します。</p>` : ""}
            ${selected && state.historyLoadingUuid === selectedUuid ? `<p class="muted">戦績を読み込み中…</p>` : ""}
            ${selected && historyEntry ? `<p class="muted">キャッシュ済み戦績 ${formatTime(historyEntry.fetchedAt)}</p>` : ""}
            ${state.historyError ? `<p class="muted">${escapeHtml(state.historyError)}</p>` : ""}
            ${selected ? renderPlayerStats(selected, historyEntry ? historyEntry.data.summary : null) : `<p class="muted">なし</p>`}
          </section>
          <section class="panel wide">
            <h2>通信ログ</h2>
            ${renderClientLogs(20)}
          </section>
        </div>
      </section>
    `;
  }

  function renderSettingsView() {
    const player = getCurrentPlayer();
    return `
      <section class="shell">
        <header class="view-header"><div><p class="eyebrow">Settings</p><h1>設定</h1></div></header>
        <div class="settings-grid">
          <section class="panel">
            <h2>UUID</h2>
            <code class="uuid-box">${escapeHtml(state.playerUuid || "-")}</code>
            <button type="button" data-action="copy-uuid" ${state.playerUuid ? "" : "disabled"}>Copy</button>
            <form id="uuidImportForm" class="form-grid">
              <label>Import<input name="importUuid" value="${escapeAttr(state.playerUuid)}"></label>
              <button type="submit">Import</button>
            </form>
          </section>
          <section class="panel">
            <h2>名前</h2>
            <form id="renameForm" class="form-grid">
              <label>Name<input name="nextName" value="${escapeAttr(player ? player.pendingName || player.name : "")}"></label>
              <button type="submit" ${player ? "" : "disabled"}>Change</button>
            </form>
          </section>
          <section class="panel wide">
            <h2>通信ログ</h2>
            ${renderClientLogs(20)}
          </section>
        </div>
      </section>
    `;
  }

  function renderStageSummary(stage) {
    return `
      <div class="stage-summary">
        <div class="param-n"><span>総階数</span><strong>${stage.params.N}</strong></div>
        <div class="param-x"><span>定員</span><strong>${stage.params.X}</strong></div>
        <div class="param-p"><span>上昇報酬</span><strong>${stage.params.P}</strong></div>
        <div class="param-q"><span>運賃</span><strong>${stage.params.Q}</strong></div>
        <div class="event-list">
          ${(stage.events || []).map((event) => `<span>${eventLabel(event)}</span>`).join("") || `<span>イベントなし</span>`}
        </div>
      </div>
    `;
  }

  function renderPhaseBanner() {
    return `
      <div class="phase-banner">
        <span>${phaseLabel(state.room.phase)}</span>
        ${state.room.phase === Engine.PHASES.COUNTDOWN && !isRemoteMoving() ? `<strong>${countdownSeconds()}秒</strong>` : ""}
        ${isRemoteMoving() ? `<strong>移動中… ${movingSeconds()}秒</strong>` : ""}
        ${state.room.phase === Engine.PHASES.TALLYING ? `<strong>移動中… ${movingSeconds()}秒</strong>` : ""}
      </div>
    `;
  }

  function renderParticipantsTable() {
    const tickets = getStageTickets();
    const rows = state.room.players.map((player) => {
      const ticket = tickets[player.uuid];
      return `
        <tr>
          <td>${escapeHtml(player.name)}${player.pendingName ? `<small>→${escapeHtml(player.pendingName)}</small>` : ""}</td>
          <td><code>${escapeHtml(player.uuid)}</code></td>
          <td>${ticket ? ticket.abstained ? "棄権" : `${ticket.boardFloor}→${ticket.exitFloor}` : "未投票"}</td>
          <td>${formatScore(state.room.scores[player.uuid] || 0)}</td>
          <td>${formatSkill(player.skill || 0)}</td>
          <td><button type="button" class="danger" data-action="remove-player" data-uuid="${escapeAttr(player.uuid)}">退室</button></td>
        </tr>
      `;
    });
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>名前</th><th>UUID</th><th>入力</th><th>得点</th><th>現在Skill</th><th>操作</th></tr></thead>
          <tbody>${rows.join("") || `<tr><td colspan="6">なし</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

  function renderRankingBoard() {
    const rankings = Engine.cumulativeRankings(state.room);
    const result = getCurrentStageResult();
    return `
      <div class="ranking-board">
        <h1>${state.room.phase === Engine.PHASES.FINAL ? "最終結果" : "中間ランキング"}</h1>
        ${state.room.phase === Engine.PHASES.RANKING && result && state.room.currentStageIndex > 0 ? `
          <div class="dual-ranking">
            <section>
              <h2>今ステージ</h2>
              ${result.rankings.map((row) => renderRankRow(row)).join("")}
            </section>
            <section>
              <h2>総合</h2>
              ${rankings.map((row) => renderRankRow(row)).join("")}
            </section>
          </div>
        ` : rankings.map((row) => renderRankRow(row)).join("")}
      </div>
    `;
  }

  function renderRankRow(row) {
    return `
      <div class="screen-rank">
        <span>${row.rank}</span>
        <strong>${escapeHtml(row.name)}</strong>
        <em>${formatScore(row.score)}</em>
      </div>
    `;
  }

  function renderPlayerStats(player, remoteSummary) {
    const games = getHistoryGames();
    const stageResults = games
      .flatMap((game) => Object.values(game.stageResults || {}))
      .map((stageResult) => stageResult.players[player.uuid])
      .filter(Boolean);
    const scores = stageResults.map((item) => item.score);
    const forced = stageResults.filter((item) => item.forcedOff).length;
    const answered = stageResults.flatMap((item) => item.predictionBreakdown || []).filter((item) => !item.noAnswer);
    const correct = answered.filter((item) => item.matched).length;
    const playerGames = games.filter((game) => Object.values(game.stageResults || {}).some((stageResult) => stageResult.players[player.uuid]));
    const totalScore = games.reduce((sum, game) => sum + Number((game.scores || {})[player.uuid] || 0), 0);
    const wins = games.filter((game) => (game.rankings || []).some((row) => row.uuid === player.uuid && row.rank === 1)).length;
    const podiums = games.filter((game) => (game.rankings || []).some((row) => row.uuid === player.uuid && row.rank <= 3)).length;
    const summary = remoteSummary || {};
    const predictionAccuracy = summary.predictionAccuracy !== undefined && summary.predictionAccuracy !== null
      ? Number(summary.predictionAccuracy) * 100
      : (answered.length ? (correct / answered.length) * 100 : null);
    return `
      <dl class="stats-list">
        <div><dt>現在Skill値</dt><dd>${formatSkill(summary.currentSkill ?? player.skill ?? 0)}</dd></div>
        <div><dt>平均Skill値</dt><dd>${formatSkill(summary.averageSkill ?? average(player.stageSkillHistory || []))}</dd></div>
        <div><dt>合計Skill値</dt><dd>${formatSkill(summary.totalSkill ?? (player.stageSkillHistory || []).reduce((a, b) => a + b, 0))}</dd></div>
        <div><dt>累積得点</dt><dd>${formatScore(summary.totalScore ?? totalScore)}</dd></div>
        <div><dt>平均得点</dt><dd>${formatScore(summary.averageScore ?? average(scores))}</dd></div>
        <div><dt>最高得点</dt><dd>${formatScore(summary.bestScore ?? (scores.length ? Math.max(...scores) : 0))}</dd></div>
        <div><dt>参加ゲーム数</dt><dd>${formatScore(summary.gameCount ?? playerGames.length)}</dd></div>
        <div><dt>参加ステージ数</dt><dd>${formatScore(summary.stageCount ?? stageResults.length)}</dd></div>
        <div><dt>強制下車回数</dt><dd>${formatScore(summary.forcedOffCount ?? forced)}</dd></div>
        <div><dt>予想イベント正解率</dt><dd>${predictionAccuracy === null ? "-" : formatSkill(predictionAccuracy) + "%"}</dd></div>
        <div><dt>優勝回数</dt><dd>${formatScore(summary.wins ?? wins)}</dd></div>
        <div><dt>表彰台回数</dt><dd>${formatScore(summary.podiums ?? podiums)}</dd></div>
      </dl>
    `;
  }

  function nextHostAction() {
    const stage = Engine.getCurrentStage(state.room);
    const isLastStage = state.room.currentStageIndex >= (state.room.config.stages.length - 1);
    if (!state.lastRemoteRoomAt) return { action: "", enabled: false, description: "Firebaseの状態同期を待っています。" };
    if (state.room.phase === Engine.PHASES.LOBBY) return { action: "start-stage", enabled: true, description: "ステージ説明へ進みます。" };
    if (state.room.phase === Engine.PHASES.STAGE_INTRO) return { action: "open-voting", enabled: true, description: "チケット購入受付を開始します。" };
    if (state.room.phase === Engine.PHASES.VOTING) return { action: "close-voting", enabled: true, description: "受付を締め切り、カウントダウンを開始します。" };
    if (state.room.phase === Engine.PHASES.COUNTDOWN || state.room.phase === Engine.PHASES.TALLYING) {
      return {
        action: "tally",
        enabled: canTally(),
        description: canTally() ? "集計して結果発表へ進みます。" : `移動中です。あと${movingSeconds()}秒で結果発表へ進めます。`,
      };
    }
    if (state.room.phase === Engine.PHASES.REVEAL) return { action: "show-ranking", enabled: true, description: "順位表示へ進みます。" };
    if (state.room.phase === Engine.PHASES.RANKING) {
      return {
        action: "next-stage",
        enabled: true,
        description: isLastStage ? "最終結果へ進みます。" : `${stage ? "次ステージ" : "次"}へ進みます。`,
      };
    }
    return { action: "", enabled: false, description: "次ゲームを準備してください。" };
  }

  function hostDebugAction(hostAction, status, result) {
    const stage = Engine.getCurrentStage(state.room);
    return {
      at: new Date().toISOString(),
      status,
      action: hostAction,
      path: remoteHostPath(hostAction),
      uiPhase: state.room ? state.room.phase : "",
      uiPhaseLabel: state.room ? phaseLabel(state.room.phase) : "",
      uiStageIndex: state.room ? state.room.currentStageIndex : "",
      uiStageId: stage ? stage.stageId : "",
      uiVersion: state.room ? Number(state.room.roomVersion || 0) : "",
      responseOk: result ? result.ok !== false : "",
      responseError: result ? result.error || "" : "",
      responsePhase: result && result.room ? result.room.phase : "",
      responseVersion: result && result.room ? Number(result.room.roomVersion || 0) : "",
    };
  }

  function getCurrentPlayer() {
    return state.room.players.find((player) => player.uuid === state.playerUuid) || null;
  }

  function getStageTickets() {
    const stage = Engine.getCurrentStage(state.room);
    return stage ? state.room.tickets[stage.stageId] || {} : {};
  }

  function getStageTicketPresence() {
    const stage = Engine.getCurrentStage(state.room);
    return stage ? (state.room.ticketPresence || {})[stage.stageId] || {} : {};
  }

  function getCurrentStageResult() {
    const stage = Engine.getCurrentStage(state.room);
    return stage ? state.room.stageResults[stage.stageId] : null;
  }

  function getHostPassword(room) {
    return (room.config.settings && room.config.settings.hostPassword) || "host";
  }

  function canTally() {
    if (state.room.phase === Engine.PHASES.TALLYING) return movingSeconds() <= 0;
    return state.room.phase === Engine.PHASES.COUNTDOWN && isRemoteMoving() && movingSeconds() <= 0;
  }

  function countdownSeconds() {
    if (!state.room.countdownEndsAt) return 0;
    return Math.max(0, Math.ceil((new Date(state.room.countdownEndsAt).getTime() - serverNow()) / 1000));
  }

  function movingSeconds() {
    const endAt = state.room.tallyingEndsAt ||
      (isRemoteMode() && state.room.countdownEndsAt
        ? new Date(new Date(state.room.countdownEndsAt).getTime() + 3000).toISOString()
        : "");
    if (!endAt) return 0;
    return Math.max(0, Math.ceil((new Date(endAt).getTime() - serverNow()) / 1000));
  }

  function isRemoteMoving() {
    return isRemoteMode() &&
      state.room.phase === Engine.PHASES.COUNTDOWN &&
      state.room.countdownEndsAt &&
      new Date(state.room.countdownEndsAt).getTime() <= serverNow();
  }

  function eventLabel(event) {
    const labels = {
      E1_prediction: `予想: ${event.question || ""}`,
      E2_forbidden: `禁止 ${event.fromFloor}-${event.toFloor}F`,
      E3a_zone_multiplier: `区間ボーナス倍率 ${event.fromFloor}-${event.toFloor}F x${event.multiplier}`,
      E3b_score_multiplier: `得点ボーナス倍率 ${event.fromFloor}-${event.toFloor}F x${event.multiplier}`,
      E4_special_floor: `特別階 ${event.floor}F +${event.bonus || event.score || 0}`,
      E5_occupancy_multiplier: `${event.threshold}人以上でボーナス倍率 x${event.multiplier}`,
      E6_view_bonus: `眺望: 乗車成功時、降車階で得点+階数x${event.bonusPerExitFloor || event.multiplier || 0}`,
    };
    return labels[event.type] || event.type;
  }

  function phaseLabel(phase) {
    return {
      lobby: "参加者受付中",
      stage_intro: "ステージ説明",
      voting: "チケット購入受付中",
      countdown: "締切カウントダウン",
      tallying: "移動中…",
      reveal: "結果発表",
      ranking: "ランキング",
      final: "最終結果",
    }[phase] || phase;
  }

  function statusLabel(status) {
    return {
      success: "乗車成功",
      forced_off: "強制下車",
      invalid: "禁止階",
      not_boarded: "乗車失敗",
      abstained: "棄権",
      absent: "未参加",
    }[status] || status;
  }

  function playerNextDisabledAttr() {
    return Date.now() < state.playerNextDisabledUntil ? "disabled" : "";
  }

  function loadRoom() {
    return normalizeRoomShape(loadJson(STORAGE_KEYS.room, null)) || Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  }

  function normalizeRoomShape(room) {
    if (!room) return null;
    room.config = room.config || Engine.DEFAULT_CONFIG;
    room.players = Array.isArray(room.players) ? room.players : Object.values(room.players || {});
    room.tickets = room.tickets || {};
    room.stageResults = room.stageResults || {};
    room.scores = room.scores || {};
    room.completedGames = Array.isArray(room.completedGames) ? room.completedGames : Object.values(room.completedGames || {});
    room.operations = Array.isArray(room.operations) ? room.operations : Object.values(room.operations || {});
    room.ticketPresence = room.ticketPresence || {};
    room.archive = room.archive || null;
    room.phase = room.phase || Engine.PHASES.LOBBY;
    room.currentStageIndex = Number(room.currentStageIndex || 0);
    room.roomVersion = Number(room.roomVersion || 0);
    room.volume = room.volume !== undefined ? room.volume : 0.8;
    room.muted = Boolean(room.muted);
    return room;
  }

  function playerUuidStorageKey() {
    return TEST_SLOT ? `${STORAGE_KEYS.playerUuid}.${TEST_SLOT}` : STORAGE_KEYS.playerUuid;
  }

  function saveRoom(kind, actor) {
    if (!isRemoteMode()) state.room.updatedAt = new Date().toISOString();
    if (kind) logClient(kind, actor || "");
  }

  function broadcastLocalRoom() {
    if (localSyncChannel && state.room) {
      localSyncChannel.postMessage({ type: "room", room: state.room });
    }
  }

  function applyLocalScreenRoom(room) {
    if (isFirebaseMode()) return;
    if (!isRemoteMode() || state.role !== "screen" || !state.screenLocalSync || !room) return;
    if (
      state.room &&
      room.gameId === state.room.gameId &&
      Number(room.roomVersion || 0) < Number(state.room.roomVersion || 0)
    ) return;
    state.room = room;
    render();
  }

  function isRemoteMode() {
    return true;
  }

  function isGasMode() {
    return false;
  }

  function isFirebaseMode() {
    return true;
  }

  function remoteModeLabel() {
    return BUILD_CONFIG.FIREBASE_USE_LOCAL_MOCK ? "Firebase mock" : "Firebase RTDB";
  }

  async function runMutation(localMutation, remotePath, payload) {
    try {
      const response = await apiPost(remotePath, payload);
      const result = normalizeMutationResponse(response);
      if (!result.ok) await refreshRemoteState({ force: true, full: true, ignoreLocalVersion: true });
      return result;
    } catch (error) {
      logClient("api.error", error.message);
      await refreshRemoteState({ force: true, full: true, ignoreLocalVersion: true });
      return { ok: false, room: state.room, error: "通信に失敗しました。" };
    }
  }

  function pollRemoteState() {
    if (isFirebaseMode()) return;
    if (!isRemoteMode() || !state.room) return;
    if (!shouldPollRemoteState()) return;
    if (isPlayerRankingHeld()) return;
    if (state.room.phase === Engine.PHASES.REVEAL) {
      if (state.role !== "screen" && state.role !== "player") return;
      const now = Date.now();
      if (now - state.lastRevealPollAt < REMOTE_REVEAL_POLL_INTERVAL_MS) return;
      state.lastRevealPollAt = now;
      refreshRemoteState({ revealOnly: true });
      return;
    }
    state.lastRevealPollAt = 0;
    state.revealCompletionCheckedFor = "";
    refreshRemoteState();
  }

  function checkRevealCompletionRemoteState() {
    if (!isRemoteMode() || state.syncing || state.room.phase !== Engine.PHASES.REVEAL) return;
    const stage = Engine.getCurrentStage(state.room);
    if (!stage || getRevealFloor(stage, getRevealDuration(stage)) < stage.params.N) return;
    const checkKey = `${stage.stageId}:${state.room.animationStartedAt || ""}`;
    if (state.revealCompletionCheckedFor === checkKey) return;
    state.revealCompletionCheckedFor = checkKey;
    state.lastRevealPollAt = Date.now();
    refreshRemoteState({ revealOnly: true, full: true });
  }

  async function refreshRemoteState(options = {}) {
    if (!isRemoteMode() || state.syncing) return;
    if (!options.force && !shouldPollRemoteState()) return;
    if (!options.force && isPlayerRankingHeld()) return;
    try {
      state.syncing = true;
      const response = await maybeBusy(options.showLoading ? "読み込み中…" : "", () => apiGet("/api/status", {
        uuid: state.playerUuid,
        sinceGameId: state.room ? state.room.gameId || "" : "",
        sinceVersion: options.full ? "" : (state.room ? state.room.roomVersion || 0 : 0),
      }));
      if (response.ok && response.unchanged) return;
      if (response.ok && response.room) {
        if (options.revealOnly && !shouldApplyRevealRemoteRoom(state.room, response.room)) return;
        if (!options.force && isPlayerRankingHeld()) return;
        applyRemoteRoom(response.room, Object.assign({ source: "fetch" }, options));
      } else if (!response.ok) {
        logClient("api.state", response.error || response.message || "状態取得に失敗しました。");
      }
    } catch (error) {
      logClient("api.state", error.message);
    } finally {
      state.syncing = false;
    }
  }

  function shouldApplyRevealRemoteRoom(currentRoom, nextRoom) {
    if (!currentRoom || !nextRoom) return true;
    if (currentRoom.phase !== Engine.PHASES.REVEAL) return true;
    if (nextRoom.phase !== Engine.PHASES.REVEAL) return true;
    if (currentRoom.currentStageIndex !== nextRoom.currentStageIndex) return true;
    if ((currentRoom.animationStartedAt || "") !== (nextRoom.animationStartedAt || "")) return true;
    if ((currentRoom.animationSkippedAt || "") !== (nextRoom.animationSkippedAt || "")) return true;
    const currentStage = getRoomCurrentStage(currentRoom);
    const nextStage = getRoomCurrentStage(nextRoom);
    if ((currentStage && currentStage.stageId) !== (nextStage && nextStage.stageId)) return true;
    const currentResult = currentStage ? (currentRoom.stageResults || {})[currentStage.stageId] : null;
    const nextResult = nextStage ? (nextRoom.stageResults || {})[nextStage.stageId] : null;
    return !currentResult && Boolean(nextResult);
  }

  function getRoomCurrentStage(room) {
    return room && room.config && room.config.stages ? room.config.stages[room.currentStageIndex] || null : null;
  }

  async function startRemoteSync() {
    await startFirebaseSync();
  }

  async function startFirebaseSync() {
    if (!firebaseAdapter) {
      logClient("firebase.error", "Firebase adapterが読み込まれていません。");
      return;
    }
    try {
      state.firebaseStartedAt = new Date().toISOString();
      const init = await firebaseAdapter.init();
      if (state.role === "player" && init && init.uid && state.playerUuid !== init.uid) {
        state.playerUuid = init.uid;
        localStorage.setItem(playerUuidStorageKey(), state.playerUuid);
      }
      render();
      state.firebaseUnsubscribe = await firebaseAdapter.listen((room) => {
        if (!room) return;
        if (isPlayerRankingHeld()) return;
        applyRemoteRoom(room);
      });
      await refreshRemoteState({ force: true, full: true, ignoreLocalVersion: true, source: "startup-fetch" });
      if (state.role === "player") await restoreRemotePlayer();
      logClient("firebase.ready", `${BUILD_CONFIG.FIREBASE_USE_LOCAL_MOCK ? "mock" : "rtdb"}:${BUILD_CONFIG.FIREBASE_ROOM_ID}`);
    } catch (error) {
      logClient("firebase.error", error.message);
      showToast("Firebase接続に失敗しました。設定を確認してください。");
    }
  }

  async function restartFirebaseSync() {
    if (!isFirebaseMode()) return;
    if (state.firebaseUnsubscribe) {
      state.firebaseUnsubscribe();
      state.firebaseUnsubscribe = null;
    }
    await startFirebaseSync();
    await refreshRemoteState({ force: true, full: true, ignoreLocalVersion: true });
  }

  function applyRemoteRoom(room, options = {}) {
    if (!room) return;
    if (
      !options.ignoreLocalVersion &&
      state.room &&
      room.gameId === state.room.gameId &&
      Number(room.roomVersion || 0) < Number(state.room.roomVersion || 0)
    ) return;
    state.lastRemoteRoomAt = new Date().toISOString();
    state.lastRemoteSource = options.source || (options.ignoreLocalVersion ? "forced-fetch" : "subscription");
    logClient("room.apply", {
      source: state.lastRemoteSource,
      gameId: room.gameId || "",
      phase: room.phase || "",
      version: Number(room.roomVersion || 0),
      role: state.role,
    });
    state.room = room;
    render();
  }

  function shouldPollRemoteState() {
    if (!isRemoteMode() || !state.room) return false;
    if (state.role === "player") return Boolean(state.playerUuid) && state.room.phase === Engine.PHASES.VOTING && !isPlayerRankingHeld() && !isEditingPlayerText();
    if (state.role === "host") return Boolean(state.hostAuthed && state.hostToken) && [Engine.PHASES.LOBBY, Engine.PHASES.VOTING].includes(state.room.phase);
    if (state.role === "screen") return !state.screenLocalSync && Boolean(state.screenReady || state.room.phase !== Engine.PHASES.LOBBY);
    return false;
  }

  function maybeFetchRemoteAfterDeadline() {
    if (state.role !== "player" || !state.playerUuid || state.syncing) return;
    if (![Engine.PHASES.COUNTDOWN, Engine.PHASES.TALLYING].includes(state.room.phase)) return;
    const targetAt = state.room.tallyingEndsAt || state.room.countdownEndsAt;
    if (!targetAt || serverNow() < new Date(targetAt).getTime()) return;
    if (Date.now() < state.nextRemoteFetchAt) return;
    state.nextRemoteFetchAt = Date.now() + 10000;
    refreshRemoteState({ force: true });
  }

  function maybeAutoCommitHostTally() {
    if (state.role !== "host" || !state.hostAuthed || !state.hostToken) return;
    if (state.busyMessage || state.hostAutoTallyInFlight) return;
    if (Date.now() < state.hostAutoTallyRetryAt) return;
    if (!canTally()) return;
    const stage = Engine.getCurrentStage(state.room);
    if (!stage || state.room.stageResults[stage.stageId]) return;
    const key = [
      state.room.gameId || "",
      stage.stageId || "",
      state.room.roomVersion || 0,
      state.room.tallyingEndsAt || state.room.countdownEndsAt || "",
    ].join(":");
    if (state.hostAutoTallyKey === key) return;
    state.hostAutoTallyKey = key;
    state.hostAutoTallyInFlight = true;
    logClient("host.auto-tally.start", { stageId: stage.stageId, roomVersion: state.room.roomVersion || 0 });
    commitHostTally("自動集計中…")
      .then((ok) => {
        logClient(ok ? "host.auto-tally.ok" : "host.auto-tally.failed", { stageId: stage.stageId, roomVersion: state.room.roomVersion || 0 });
        if (!ok) {
          state.hostAutoTallyKey = "";
          state.hostAutoTallyRetryAt = Date.now() + 10000;
        }
      })
      .finally(() => {
        state.hostAutoTallyInFlight = false;
      });
  }

  async function commitHostTally(message) {
    try {
      const baseVersion = Number(state.room.roomVersion || 0);
      const localResult = Engine.advancePhase(state.room, "tally", "host");
      if (!localResult.ok) {
        showToast(localResult.error || "操作できません。");
        return false;
      }
      const response = await withBusy(message || "結果を保存中…", () => apiPost("/api/host/commit-result", {
        hostName: "host",
        baseVersion,
        room: localResult.room,
      }));
      const result = normalizeMutationResponse(response);
      if (!result.ok) {
        showToast(result.error || "操作できません。");
        return false;
      }
      state.room = result.room;
      saveRoom("host.commit-result", "host");
      render();
      return true;
    } catch (error) {
      logClient("host.tally.error", error.message);
      showToast("集計の通信に失敗しました。");
      return false;
    }
  }

  async function loadGameConfigs(showLoading) {
    state.nextGameConfigs = [];
    state.nextGameConfigsLoadedAt = "";
    state.nextGameConfigError = "Firebase版では次ゲーム候補の読み込みは未対応です。設定JSON Importを使用してください。";
    if (showLoading) showToast(state.nextGameConfigError);
    render();
  }

  async function startNextGameFromConfig(config, logKind) {
    const normalizedConfig = Engine.normalizeConfig(config);
    const hasCurrentGameProgress = state.room.players.length || Object.keys(state.room.stageResults || {}).length;
    const nextRoom = hasCurrentGameProgress ? Engine.createNextGameRoom(state.room, normalizedConfig) : Engine.createInitialRoom(normalizedConfig);
    if (isRemoteMode()) {
      const result = await runMutation(
        () => ({ ok: true, room: nextRoom }),
        "/api/host/import-config",
        { config: normalizedConfig, preservePlayers: true }
      );
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
    } else {
      state.room = nextRoom;
    }
    saveRoom(logKind || "host.config.import", "host");
    clearPlayerRankingHold();
    showToast("次ゲームを開始しました。参加者はアクセス後に表示されます。");
    render();
  }

  async function startGameConfig(configId) {
    const beforeGameId = state.room.gameId;
    const result = await runMutation(
      () => ({ ok: false, room: state.room, error: "Firebase版では使用できません。" }),
      "/api/host/start-game-config",
      { configId }
    );
    if (!result.ok) return showToast(result.error || "次ゲームを開始できません。");
    state.room = result.room;
    clearPlayerRankingHold();
    state.nextGameConfigsLoadedAt = "";
    saveRoom("host.game-config.start", "host");
    showToast(state.room.gameId !== beforeGameId ? "次ゲームを開始しました。" : "設定を読み込みました。");
    render();
  }

  function isEditingPlayerText() {
    if (state.role !== "player") return false;
    const element = document.activeElement;
    return Boolean(element && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
  }

  async function restoreRemotePlayer() {
    if (!state.playerUuid) return;
    const response = await runMutation(
      () => ({ ok: true, room: state.room, player: getCurrentPlayer() }),
      "/api/player/restore",
      { uuid: state.playerUuid }
    );
    if (response.ok && response.room) {
      state.room = response.room;
      render();
    }
  }

  function historyStageCacheKey(uuid) {
    return [uuid || "", state.room.gameId || "", state.room.currentStageIndex || 0, Object.keys(state.room.stageResults || {}).length].join(":");
  }

  function getPersonalHistoryCache(uuid) {
    if (!uuid) return null;
    return state.personalHistoryCache[historyStageCacheKey(uuid)] || null;
  }

  function savePersonalHistoryCache(uuid, data) {
    if (!uuid || !data) return;
    state.personalHistoryCache[historyStageCacheKey(uuid)] = {
      fetchedAt: new Date().toISOString(),
      data,
    };
    localStorage.setItem(STORAGE_KEYS.personalHistoryCache, JSON.stringify(state.personalHistoryCache));
  }

  function ensureVisibleHistoryCache() {
    if (state.role !== "history") return;
    const uuid = state.selectedHistoryUuid || state.playerUuid;
    ensurePersonalHistoryCache(uuid);
  }

  async function ensurePersonalHistoryCache(uuid) {
    if (!isRemoteMode() || !uuid || uuid !== state.playerUuid) return;
    if (getPersonalHistoryCache(uuid) || state.historyLoadingUuid === uuid) return;
    state.historyLoadingUuid = uuid;
    state.historyError = "";
    render();
    try {
      const response = await withBusy("戦績を読み込み中…", () => apiGet(`/api/history/player/${encodeURIComponent(uuid)}`, { uuid }));
      if (response.ok) {
        savePersonalHistoryCache(uuid, response);
      } else {
        state.historyError = response.error || response.message || "戦績を取得できませんでした。";
      }
    } catch (error) {
      state.historyError = "戦績の通信に失敗しました。";
      logClient("history.error", error.message);
    } finally {
      state.historyLoadingUuid = "";
      render();
    }
  }

  async function apiGet(path, payload) {
    const startedAt = Date.now();
    try {
      const response = handleHostAuthResponse(path, await firebaseAdapter.get(path, withApiMeta(payload || {})));
      recordApiDebug("GET", path, payload, response, startedAt);
      return response;
    } catch (error) {
      recordApiDebug("GET", path, payload, { ok: false, error: error.message }, startedAt);
      throw error;
    }
  }

  async function apiPost(path, payload) {
    const startedAt = Date.now();
    try {
      const response = handleHostAuthResponse(path, await firebaseAdapter.post(path, withApiMeta(payload || {})));
      recordApiDebug("POST", path, payload, response, startedAt);
      return response;
    } catch (error) {
      recordApiDebug("POST", path, payload, { ok: false, error: error.message }, startedAt);
      throw error;
    }
  }

  async function fetchJsonWithRetry(url, options, attempt = 0) {
    try {
      const response = await fetch(url, options);
      if (!response.ok && response.status >= 500 && attempt < 2) {
        throw new Error(`HTTP ${response.status}`);
      }
      return normalizePublicResponse(updateServerTime(await response.json()));
    } catch (error) {
      if (attempt >= 2) throw error;
      const delay = 400 * Math.pow(2, attempt);
      logClient("api.retry", `${attempt + 1}/3 ${error.message}`);
      await sleep(delay);
      return fetchJsonWithRetry(url, options, attempt + 1);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function apiUrl(path, payload) {
    const url = new URL(BUILD_CONFIG.GAS_API_BASE_URL);
    url.searchParams.set("path", path);
    Object.entries(withApiMeta(payload || {})).forEach(([key, value]) => {
      if (value !== undefined && value !== null && typeof value !== "object") {
        url.searchParams.set(key, String(value));
      }
    });
    return url;
  }

  function withApiMeta(payload) {
    const meta = {
      role: state.role,
      uuid: state.playerUuid || payload.uuid || "",
    };
    if (BUILD_CONFIG.GAS_API_KEY) meta.apiKey = BUILD_CONFIG.GAS_API_KEY;
    if (state.hostToken) meta.hostToken = state.hostToken;
    return Object.assign({}, payload, meta);
  }

  async function maybeBusy(message, task) {
    if (!message) return task();
    return withBusy(message, task);
  }

  async function withBusy(message, task) {
    state.busyCount += 1;
    state.busyMessage = message || "読み込み中…";
    render();
    try {
      return await task();
    } finally {
      state.busyCount = Math.max(0, state.busyCount - 1);
      if (state.busyCount === 0) state.busyMessage = "";
      render();
    }
  }

  function updateServerTime(response) {
    if (response && response.serverTime) {
      state.serverTimeOffsetMs = new Date(response.serverTime).getTime() - Date.now();
    }
    return response;
  }

  function serverNow() {
    return Date.now() + (state.serverTimeOffsetMs || 0);
  }

  function normalizePublicResponse(response) {
    if (response && response.room && response.room.room) {
      return Object.assign({}, response, response.room, {
        player: response.player || response.room.me || response.player,
      });
    }
    return response || { ok: false, error: "空のレスポンスです。" };
  }

  function normalizeMutationResponse(response) {
    const normalized = normalizePublicResponse(response);
    return {
      ok: normalized.ok !== false,
      room: normalized.room || state.room,
      player: normalized.player || normalized.me,
      ticket: normalized.ticket,
      error: normalized.error || normalized.message,
    };
  }

  function recordApiDebug(method, path, payload, response, startedAt) {
    const room = response && response.room;
    state.lastApi = {
      at: new Date().toISOString(),
      method,
      path,
      ok: response ? response.ok !== false : false,
      code: response && response.code || "",
      error: response && (response.error || response.message) || "",
      elapsedMs: Date.now() - startedAt,
      requestRole: state.role,
      requestPhase: state.room ? state.room.phase : "",
      requestVersion: state.room ? Number(state.room.roomVersion || 0) : 0,
      responsePhase: room ? room.phase : "",
      responseVersion: room ? Number(room.roomVersion || 0) : "",
      hostAction: payload && payload.hostName ? path : "",
    };
    logClient(response && response.ok === false ? "api.response.error" : "api.response", state.lastApi);
  }

  function handleHostAuthResponse(path, response) {
    if (
      path !== "/api/host/auth" &&
      response &&
      response.ok === false &&
      response.code === "auth" &&
      state.role === "host"
    ) {
      clearHostAuth(response.message || "ホスト認証の有効期限が切れました。再認証してください。");
    }
    return response;
  }

  function authErrorMessage(error) {
    const message = String(error && error.message || "");
    if (/permission|denied|PERMISSION_DENIED/i.test(message)) {
      return "FirebaseでHost権限を取得できませんでした。Rulesの更新後に再試行してください。";
    }
    return "認証に失敗しました。通信状態を確認してください。";
  }

  function checkHostTokenExpiry() {
    if (!isRemoteMode() || state.role !== "host" || !state.hostAuthed || !state.hostTokenExpiresAt) return;
    const expiresAt = new Date(state.hostTokenExpiresAt).getTime();
    if (Number.isFinite(expiresAt) && serverNow() >= expiresAt) {
      clearHostAuth("ホスト認証の有効期限が切れました。再認証してください。");
    }
  }

  function clearHostAuth(message) {
    if (!state.hostAuthed && !state.hostToken) return;
    state.hostAuthed = false;
    state.hostToken = "";
    state.hostTokenExpiresAt = "";
    state.nextGameConfigs = [];
    state.nextGameConfigsLoadedAt = "";
    localStorage.removeItem(STORAGE_KEYS.hostAuthed);
    localStorage.removeItem(STORAGE_KEYS.hostToken);
    localStorage.removeItem(STORAGE_KEYS.hostTokenExpiresAt);
    showToast(message || "ホスト認証が必要です。");
  }

  function remoteHostPath(action) {
    return {
      "start-stage": "/api/host/start-stage",
      "open-voting": "/api/host/open-voting",
      "close-voting": "/api/host/close-voting",
      tally: "/api/host/reveal-result",
      "show-ranking": "/api/host/show-ranking",
      "next-stage": "/api/host/advance",
    }[action] || "/api/room/state";
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function logClient(kind, message) {
    state.logs.unshift({ at: new Date().toISOString(), kind, message: typeof message === "string" ? message : compactJson(message || "") });
    state.logs = state.logs.slice(0, 200);
    localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify(state.logs));
  }

  function showToast(message) {
    const toastId = state.toastId + 1;
    state.toastId = toastId;
    state.toast = message;
    render();
    setTimeout(() => {
      if (state.toastId !== toastId) return;
      state.toast = "";
      render();
    }, 2200);
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function startAudioContext() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext && !state.audio.context) state.audio.context = new AudioContext();
      if (state.audio.context) state.audio.context.resume();
      syncScreenAudio();
    } catch (error) {
      logClient("audio.error", error.message);
    }
  }

  function syncScreenAudio() {
    if (!state.room || state.role !== "screen" || !state.screenReady) return;
    syncPhaseBgm();
    triggerPhaseSoundEffects();
    triggerRevealSoundEffects();
  }

  function syncPhaseBgm() {
    const phase = state.room.phase;
    const filename = AUDIO_FILES.bgm[phase];
    if (!filename) return;
    const key = `bgm:${phase}`;
    if (state.room.muted) {
      if (state.audio.bgmElement) state.audio.bgmElement.pause();
      return;
    }
    if (state.audio.bgmKey !== key) {
      if (state.audio.bgmElement) state.audio.bgmElement.pause();
      const element = getAudioElement(key, filename, true);
      state.audio.bgmKey = key;
      state.audio.bgmElement = element;
      playAudioElement(element, key, true);
      return;
    }
    if (state.audio.bgmElement) {
      state.audio.bgmElement.volume = currentAudioVolume();
      if (state.audio.bgmElement.paused) playAudioElement(state.audio.bgmElement, key, false);
    }
  }

  function triggerPhaseSoundEffects() {
    const stage = Engine.getCurrentStage(state.room);
    const stageId = stage ? stage.stageId : "";
    const base = `${state.room.gameId}:${stageId}`;
    if (state.room.phase === Engine.PHASES.COUNTDOWN && state.room.countdownEndsAt && !isRemoteMoving()) {
      triggerSoundOnce(`countdown-start:${base}:${state.room.countdownEndsAt}`, "countdownStart");
    }
    if (
      state.room.countdownEndsAt &&
      (state.room.phase === Engine.PHASES.TALLYING || (state.room.phase === Engine.PHASES.COUNTDOWN && isRemoteMoving()))
    ) {
      triggerSoundOnce(`countdown-end:${base}:${state.room.countdownEndsAt}`, "countdownEnd");
    }
  }

  function triggerRevealSoundEffects() {
    if (state.room.phase !== Engine.PHASES.REVEAL || state.room.animationSkippedAt) return;
    const stage = Engine.getCurrentStage(state.room);
    const result = getCurrentStageResult();
    if (!stage || !result || !result.timeline) return;
    const revealKey = `${state.room.gameId}:${stage.stageId}:${state.room.animationStartedAt || ""}`;
    const currentFloor = getRevealFloor(stage, getRevealDuration(stage));
    if (state.audio.revealKey !== revealKey) {
      state.audio.revealKey = revealKey;
      state.audio.revealFloor = Math.max(0, currentFloor - 1);
    }
    if (currentFloor <= state.audio.revealFloor) return;
    const timelineByFloor = new Map(result.timeline.map((step) => [step.floor, step]));
    for (let floor = state.audio.revealFloor + 1; floor <= currentFloor; floor += 1) {
      const step = timelineByFloor.get(floor);
      if (step) triggerFloorSoundEffects(revealKey, floor, step, result);
    }
    state.audio.revealFloor = currentFloor;
  }

  function triggerFloorSoundEffects(revealKey, floor, step, result) {
    const forced = step.forcedOff || [];
    const exiting = step.exiting || [];
    const successfulBoarding = (step.boarding || []).filter((uuid) => {
      const playerResult = result.players ? result.players[uuid] : null;
      return !forced.includes(uuid) && playerResult && !["invalid", "not_boarded"].includes(playerResult.status);
    });
    if (successfulBoarding.length) triggerSoundOnce(`board:${revealKey}:${floor}`, "board");
    if ((step.passengersAfterCheck || []).length && !successfulBoarding.length && !exiting.length && !forced.length) {
      triggerSoundOnce(`ride:${revealKey}:${floor}`, "ride");
    }
    if (exiting.length) triggerSoundOnce(`exit:${revealKey}:${floor}`, "exit");
    if (forced.length) triggerSoundOnce(`forced:${revealKey}:${floor}`, "forcedOff");
  }

  function triggerSoundOnce(triggerKey, soundKey) {
    if (state.audio.triggered[triggerKey]) return;
    state.audio.triggered[triggerKey] = true;
    const filename = AUDIO_FILES.se[soundKey];
    if (!filename || state.room.muted) return;
    const element = getAudioElement(`se:${soundKey}`, filename, false);
    playAudioElement(element, `se:${soundKey}`, true);
  }

  function getAudioElement(key, filename, loop) {
    if (!state.audio.elements[key]) {
      const element = new Audio(AUDIO_BASE_PATH + filename);
      element.preload = "auto";
      element.loop = loop;
      element.addEventListener("error", () => {
        if (!state.audio.missing[key]) {
          state.audio.missing[key] = true;
          logClient("audio.missing", filename);
        }
      });
      state.audio.elements[key] = element;
    }
    const element = state.audio.elements[key];
    element.loop = loop;
    element.volume = currentAudioVolume();
    return element;
  }

  function playAudioElement(element, key, restart) {
    if (!element || state.room.muted) return;
    try {
      element.volume = currentAudioVolume();
      if (restart) element.currentTime = 0;
      const played = element.play();
      if (played && typeof played.catch === "function") {
        played.catch((error) => {
          if (!state.audio.playErrors[key]) {
            state.audio.playErrors[key] = true;
            logClient("audio.play", error.message || "再生できませんでした。");
          }
        });
      }
    } catch (error) {
      if (!state.audio.playErrors[key]) {
        state.audio.playErrors[key] = true;
        logClient("audio.play", error.message);
      }
    }
  }

  function currentAudioVolume() {
    return Math.max(0, Math.min(1, Number(state.room.volume ?? 0.8)));
  }

  function getHistoryGames() {
    const games = (state.room.completedGames || []).map((game) => Engine.deepClone(game));
    if (Object.keys(state.room.stageResults || {}).length) {
      games.push({
        gameId: state.room.gameId,
        title: state.room.config.gameMeta.title,
        scores: Engine.deepClone(state.room.scores || {}),
        rankings: Engine.cumulativeRankings(state.room),
        stageResults: Engine.deepClone(state.room.stageResults || {}),
      });
    }
    return games;
  }

  function buildHistoryRankings() {
    const games = getHistoryGames();
    const rows = state.room.players
      .map((player) => ({
        uuid: player.uuid,
        name: player.name,
        score: games.reduce((sum, game) => sum + Number((game.scores || {})[player.uuid] || 0), 0),
        skill: player.skill || 0,
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

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function formatScore(value) {
    return String(Math.round(Number(value) || 0));
  }

  function formatSkill(value) {
    return Engine.roundScore(value).toFixed(2);
  }

  function shortName(name) {
    return Array.from(String(name || "")).slice(0, 5).join("");
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
