(() => {
  const Engine = window.ElevatorGameEngine;
  const BUILD_CONFIG = Object.assign(
    {
      GAS_API_BASE_URL: "",
      GAS_API_KEY: "",
      USE_GAS_API: false,
      POLL_INTERVAL_MS: 10000,
    },
    window.EVG_BUILD_CONFIG || {}
  );
  const QUERY = new URLSearchParams(location.search);
  const REQUESTED_ROLE = QUERY.get("view") || QUERY.get("v") || "player";
  const PLAYER_ENTRY_LOCKED = (!QUERY.has("view") && !QUERY.has("v")) || REQUESTED_ROLE === "player";
  const TEST_SLOT = String(QUERY.get("testSlot") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  const REMOTE_REVEAL_POLL_INTERVAL_MS = 15000;
  const STORAGE_KEYS = {
    room: "evg.room.v1",
    playerUuid: "evg.playerUuid.v1",
    hostAuthed: "evg.hostAuthed.v1",
    hostToken: "evg.hostToken.v1",
    logs: "evg.logs.v1",
    screenReady: "evg.screenReady.v1",
    screenLocalSync: "evg.screenLocalSync.v1",
    personalHistoryCache: "evg.personalHistoryCache.v1",
  };
  const LOCAL_SYNC_CHANNEL = "evg.local-room-sync.v1";
  const state = {
    role: REQUESTED_ROLE,
    room: null,
    playerUuid: localStorage.getItem(playerUuidStorageKey()) || "",
    hostAuthed: localStorage.getItem(STORAGE_KEYS.hostAuthed) === "true",
    hostToken: localStorage.getItem(STORAGE_KEYS.hostToken) || "",
    screenReady: localStorage.getItem(STORAGE_KEYS.screenReady) === "true",
    screenLocalSync: localStorage.getItem(STORAGE_KEYS.screenLocalSync) === "true" || QUERY.get("screenSync") === "local",
    logs: loadJson(STORAGE_KEYS.logs, []),
    toast: "",
    busyMessage: "",
    busyCount: 0,
    selectedHistoryUuid: "",
    personalHistoryCache: loadJson(STORAGE_KEYS.personalHistoryCache, {}),
    historyLoadingUuid: "",
    historyError: "",
    syncing: false,
    lastRevealPollAt: 0,
    revealCompletionCheckedFor: "",
    revealWasIncomplete: false,
    playerRankingHold: null,
    autoTallyKey: "",
    nextRemoteFetchAt: 0,
    playerNextDisabledUntil: 0,
    serverTimeOffsetMs: 0,
  };
  const localSyncChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(LOCAL_SYNC_CHANNEL) : null;

  const $ = (selector) => document.querySelector(selector);

  document.addEventListener("DOMContentLoaded", () => {
    state.room = loadRoom();
    bindGlobalEvents();
    render();
    setInterval(tick, 1000);
    if (isRemoteMode()) {
      startRemoteSync();
      ensureVisibleHistoryCache();
    }
    if (localSyncChannel) {
      localSyncChannel.addEventListener("message", (event) => {
        if (event.data && event.data.type === "room") applyLocalScreenRoom(event.data.room);
      });
    }
    window.addEventListener("storage", (event) => {
      if (!isRemoteMode() && event.key === STORAGE_KEYS.room) {
        if (isPlayerRankingHeld()) return;
        state.room = loadRoom();
        render();
      }
      if (isRemoteMode() && event.key === STORAGE_KEYS.room) {
        applyLocalScreenRoom(loadJson(STORAGE_KEYS.room, null));
      }
    });
  });

  function bindGlobalEvents() {
    $("#roleTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-role]");
      if (!button) return;
      if (isRoleBlocked(button.dataset.role)) return;
      state.role = button.dataset.role;
      restorePlayerRankingHoldIfNeeded();
      history.replaceState(null, "", `?view=${state.role}`);
      render();
      ensureVisibleHistoryCache();
    });
    $("#app").addEventListener("submit", handleSubmit);
    $("#app").addEventListener("click", handleClick);
    $("#app").addEventListener("change", handleChange);
    $("#app").addEventListener("input", handleInput);
  }

  function tick() {
    if (!state.room) return;
    let changed = false;
    if (!isRemoteMode() && state.room.phase === Engine.PHASES.COUNTDOWN && state.room.countdownEndsAt) {
      const remaining = new Date(state.room.countdownEndsAt).getTime() - Date.now();
      if (remaining <= 0) {
        state.room = Engine.deepClone(state.room);
        state.room.phase = Engine.PHASES.TALLYING;
        state.room.tallyingEndsAt = new Date(Date.now() + 3000).toISOString();
        logClient("state", "締切後の移動中フェーズに入りました。");
        saveRoom();
        changed = true;
      }
    }
    if (!isRemoteMode() && state.room.phase === Engine.PHASES.TALLYING && state.room.tallyingEndsAt) {
      const remaining = new Date(state.room.tallyingEndsAt).getTime() - Date.now();
      if (remaining <= 0) {
        const tallied = Engine.tallyCurrentStage(state.room);
        if (tallied.ok) {
          state.room = tallied.room;
          logClient("state", "移動中フェーズ後に自動集計しました。");
          saveRoom();
          changed = true;
        }
      }
    }
    const needsCountdownRefresh =
      [Engine.PHASES.COUNTDOWN, Engine.PHASES.TALLYING].includes(state.room.phase) &&
      (state.role === "screen" || (state.role === "player" && !isEditingPlayerText()));
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
    maybeAutoHostTally();
    if (needsRevealRefresh || revealJustCompleted) checkRevealCompletionRemoteState();
    if (changed || needsCountdownRefresh || needsRevealRefresh || revealJustCompleted) render();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (state.busyMessage) return;
    const form = event.target;
    if (form.id === "joinForm") {
      const name = form.elements.name.value;
      const carryUuid = form.elements.restoreUuid.value.trim();
      const result = await runMutation(
        () => Engine.registerPlayer(state.room, name, carryUuid || undefined),
        "/api/player/join",
        { name, uuid: carryUuid || undefined }
      );
      if (!result.ok) return showToast(result.error);
      state.room = result.room;
      state.playerUuid = result.player.uuid;
      localStorage.setItem(playerUuidStorageKey(), state.playerUuid);
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
      if (isRemoteMode()) {
        const result = await withBusy("認証中…", () => apiPost("/api/host/auth", { password }));
        if (!result.ok) return showToast(result.error || "パスワードが違います。");
        state.hostToken = result.hostToken || "";
        localStorage.setItem(STORAGE_KEYS.hostToken, state.hostToken);
      } else {
        const configured = getHostPassword(state.room);
        if (password !== configured) return showToast("パスワードが違います。");
      }
      state.hostAuthed = true;
      localStorage.setItem(STORAGE_KEYS.hostAuthed, "true");
      if (isRemoteMode()) await refreshRemoteState({ force: true, full: true, showLoading: true });
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
      if (isRemoteMode() && hostAction === "tally") {
        await commitHostTally("結果を保存中…");
        return;
      }
      const result = await runMutation(
        () => Engine.advancePhase(state.room, hostAction, "host"),
        remoteHostPath(hostAction),
        { hostName: "host" }
      );
      if (!result.ok) return showToast(result.error || "操作できません。");
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
      if (state.room.phase !== Engine.PHASES.RANKING) return showToast("ホストの操作待ちです。");
      state.playerRankingHold = null;
      const beforePhase = state.room.phase;
      const beforeVersion = state.room.roomVersion || 0;
      if (isRemoteMode()) await refreshRemoteState({ force: true, showLoading: true });
      else state.room = loadRoom();
      if (state.room.phase === beforePhase && (state.room.roomVersion || 0) === beforeVersion) showToast("ホストの操作待ちです。");
      render();
    }
    if (action === "screen-ready") {
      state.screenReady = true;
      localStorage.setItem(STORAGE_KEYS.screenReady, "true");
      startAudioContext();
      render();
    }
    if (action === "screen-local-sync") {
      state.screenLocalSync = !state.screenLocalSync;
      localStorage.setItem(STORAGE_KEYS.screenLocalSync, state.screenLocalSync ? "true" : "false");
      applyLocalScreenRoom(loadJson(STORAGE_KEYS.room, null));
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
        const nextRoom = state.room.players.length ? Engine.createNextGameRoom(state.room, config) : Engine.createInitialRoom(config);
        if (isRemoteMode()) {
          const result = await runMutation(
            () => ({ ok: true, room: nextRoom }),
            "/api/host/import-config",
            { config, preservePlayers: true }
          );
          if (!result.ok) return showToast(result.error);
          state.room = result.room;
        } else {
          state.room = nextRoom;
        }
        saveRoom("host.config.import", "host");
        showToast(state.room.players.length ? "参加者を保持して次のゲームを読み込みました。" : "設定を読み込みました。");
        render();
      } catch (error) {
        showToast(`JSONを読み込めません: ${error.message}`);
      }
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
    if (action === "reset-local") {
      if (!confirm("ローカルの進行中データをリセットしますか？")) return;
      state.room = Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
      saveRoom("local.reset", "host");
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
    if (event.target.id === "volumeRange") {
      state.room.volume = Number(event.target.value);
      saveRoom("screen.volume", "host");
    }
  }

  function render() {
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
    return `
      <section class="shell narrow">
        <header class="view-header">
          <div>
            <p class="eyebrow">Entry</p>
            <h1>参加登録</h1>
          </div>
        </header>
        <form id="joinForm" class="panel form-grid">
          <label>名前<input name="name" maxlength="24" autocomplete="name" required></label>
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
        <button data-action="player-next" ${playerNextDisabledAttr()}>次へ</button>
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
            <label>パスワード<input name="password" type="password" required></label>
            <button class="primary" type="submit">認証</button>
          </form>
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
          <section class="panel">
            <h2>進行</h2>
            <div class="button-grid">
              ${hostButton("start-stage", "説明", state.room.phase === Engine.PHASES.LOBBY)}
              ${hostButton("open-voting", "受付", state.room.phase === Engine.PHASES.STAGE_INTRO)}
              ${hostButton("close-voting", "締切", state.room.phase === Engine.PHASES.VOTING)}
              ${hostButton("tally", "集計", canTally())}
              ${hostButton("show-ranking", "順位", state.room.phase === Engine.PHASES.REVEAL)}
              ${hostButton("skip-animation", "Skip", state.room.phase === Engine.PHASES.REVEAL)}
              ${hostButton("next-stage", "次", state.room.phase === Engine.PHASES.RANKING)}
            </div>
          </section>
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
          <section class="panel wide">
            <h2>設定</h2>
            <div class="form-actions">
              <button type="button" data-action="export-config">Export</button>
              <button type="button" data-action="reset-local">Reset</button>
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
        </div>
      </section>
    `;
  }

  function renderScreenView() {
    const stage = Engine.getCurrentStage(state.room);
    const result = getCurrentStageResult();
    const reviewMode = state.room.phase === Engine.PHASES.REVEAL && stage && isRevealComplete(stage);
    return `
      <section class="screen-shell ${reviewMode ? "is-review" : ""}">
        ${!state.screenReady ? `<button class="ready-button" data-action="screen-ready">準備完了</button>` : ""}
        ${isRemoteMode() && state.role === "screen" ? `<button class="screen-sync-button" data-action="screen-local-sync">${state.screenLocalSync ? "同一端末同期中" : "同一端末同期"}</button>` : ""}
        <div class="screen-top">
          <p>${escapeHtml(state.room.config.gameMeta.title)}</p>
          <span>${phaseLabel(state.room.phase)}</span>
        </div>
        ${renderScreenMain(stage, result)}
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
        ${renderTicketProgress()}
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
    const purchased = tickets.filter((ticket) => ticket && !ticket.abstained).length;
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
    const key = `${state.room.gameId}:${stage ? stage.stageId : state.room.currentStageIndex}`;
    if (!state.playerRankingHold || state.playerRankingHold.key !== key) {
      state.playerRankingHold = { key, room: Engine.deepClone(state.room) };
    }
  }

  function hasPlayerRankingHold() {
    return Boolean(
      state.playerRankingHold &&
        state.playerRankingHold.room &&
        state.playerRankingHold.room.phase === Engine.PHASES.RANKING
    );
  }

  function restorePlayerRankingHoldIfNeeded() {
    if (state.role !== "player" || !hasPlayerRankingHold()) return;
    if (!state.room || state.room.phase !== Engine.PHASES.RANKING) {
      state.room = Engine.deepClone(state.playerRankingHold.room);
    }
  }

  function isPlayerRankingHeld() {
    return state.role === "player" && hasPlayerRankingHold();
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
    const selectedUuid = state.selectedHistoryUuid || state.playerUuid || (rankings[0] && rankings[0].uuid);
    const selected = state.room.players.find((player) => player.uuid === selectedUuid);
    const historyEntry = getPersonalHistoryCache(selectedUuid);
    return `
      <section class="shell">
        <header class="view-header"><div><p class="eyebrow">History</p><h1>戦歴</h1></div></header>
        <div class="history-grid">
          <section class="panel">
            <h2>ランキング</h2>
            ${rankings.map((row) => `
              <button class="ranking-row" data-action="select-history" data-uuid="${escapeAttr(row.uuid)}">
                <span>${row.rank}. ${escapeHtml(row.name)}</span><strong>${formatScore(row.score)}</strong>
              </button>
            `).join("") || `<p class="muted">なし</p>`}
          </section>
          <section class="panel">
            <h2>個人</h2>
            ${selected && selectedUuid === state.playerUuid && state.historyLoadingUuid === selectedUuid ? `<p class="muted">戦績を読み込み中…</p>` : ""}
            ${selected && historyEntry ? `<p class="muted">キャッシュ済み戦績 ${formatTime(historyEntry.fetchedAt)}</p>` : ""}
            ${state.historyError && selectedUuid === state.playerUuid ? `<p class="muted">${escapeHtml(state.historyError)}</p>` : ""}
            ${selected ? renderPlayerStats(selected, historyEntry ? historyEntry.data.summary : null) : `<p class="muted">なし</p>`}
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
            <div class="log-list">${state.logs.map((item) => `<p>${formatTime(item.at)} ${escapeHtml(item.kind)} ${escapeHtml(item.message)}</p>`).join("") || `<p class="muted">なし</p>`}</div>
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
        </tr>
      `;
    });
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>名前</th><th>UUID</th><th>入力</th><th>得点</th><th>現在Skill</th></tr></thead>
          <tbody>${rows.join("") || `<tr><td colspan="5">なし</td></tr>`}</tbody>
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

  function hostButton(hostAction, label, enabled) {
    return `<button type="button" data-action="host-action" data-host-action="${hostAction}" ${enabled ? "" : "disabled"}>${label}</button>`;
  }

  function getCurrentPlayer() {
    return state.room.players.find((player) => player.uuid === state.playerUuid) || null;
  }

  function getStageTickets() {
    const stage = Engine.getCurrentStage(state.room);
    return stage ? state.room.tickets[stage.stageId] || {} : {};
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
    return isRemoteMode() && state.room.phase === Engine.PHASES.COUNTDOWN && isRemoteMoving() && movingSeconds() <= 0;
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
    return loadJson(STORAGE_KEYS.room, null) || Engine.createInitialRoom(Engine.DEFAULT_CONFIG);
  }

  function playerUuidStorageKey() {
    return TEST_SLOT ? `${STORAGE_KEYS.playerUuid}.${TEST_SLOT}` : STORAGE_KEYS.playerUuid;
  }

  function saveRoom(kind, actor) {
    if (!isRemoteMode()) state.room.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.room, JSON.stringify(state.room));
    broadcastLocalRoom();
    if (kind) logClient(kind, actor || "");
  }

  function broadcastLocalRoom() {
    if (localSyncChannel && state.room) {
      localSyncChannel.postMessage({ type: "room", room: state.room });
    }
  }

  function applyLocalScreenRoom(room) {
    if (!isRemoteMode() || state.role !== "screen" || !state.screenLocalSync || !room) return;
    if (state.room && Number(room.roomVersion || 0) < Number(state.room.roomVersion || 0)) return;
    state.room = room;
    render();
  }

  function isRemoteMode() {
    return Boolean(BUILD_CONFIG.USE_GAS_API && BUILD_CONFIG.GAS_API_BASE_URL);
  }

  async function runMutation(localMutation, remotePath, payload) {
    if (!isRemoteMode()) return localMutation();
    try {
      const response = await withBusy("読み込み中…", () => apiPost(remotePath, payload));
      return normalizeMutationResponse(response);
    } catch (error) {
      logClient("api.error", error.message);
      return { ok: false, room: state.room, error: "通信に失敗しました。" };
    }
  }

  function pollRemoteState() {
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
        sinceVersion: options.full ? "" : (state.room ? state.room.roomVersion || 0 : 0),
      }));
      if (response.ok && response.unchanged) return;
      if (response.ok && response.room) {
        if (options.revealOnly && !shouldApplyRevealRemoteRoom(state.room, response.room)) return;
        state.room = response.room;
        localStorage.setItem(STORAGE_KEYS.room, JSON.stringify(state.room));
        broadcastLocalRoom();
        render();
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
    if (state.role === "player") await restoreRemotePlayer();
    if (shouldPollRemoteState()) await refreshRemoteState({ force: true, full: true });
    setInterval(pollRemoteState, Math.max(10000, Number(BUILD_CONFIG.POLL_INTERVAL_MS) || 10000));
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

  async function maybeAutoHostTally() {
    if (!isRemoteMode() || state.role !== "host" || !state.hostAuthed || !state.hostToken) return;
    if (state.busyMessage || state.syncing || !canTally()) return;
    const stage = Engine.getCurrentStage(state.room);
    if (!stage) return;
    const key = `${state.room.gameId}:${stage.stageId}:${state.room.countdownEndsAt || ""}:${state.room.tallyingEndsAt || ""}`;
    if (state.autoTallyKey === key) return;
    state.autoTallyKey = key;
    await commitHostTally("自動集計中…");
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
      localStorage.setItem(STORAGE_KEYS.room, JSON.stringify(state.room));
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
    const url = apiUrl(path, payload);
    const response = await fetch(url.toString(), { method: "GET", cache: "no-store" });
    return normalizePublicResponse(updateServerTime(await response.json()));
  }

  async function apiPost(path, payload) {
    const response = await fetch(apiUrl(path).toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(withApiMeta(payload || {})),
    });
    return normalizePublicResponse(updateServerTime(await response.json()));
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

  function remoteHostPath(action) {
    return {
      "start-stage": "/api/host/start-stage",
      "open-voting": "/api/host/open-voting",
      "close-voting": "/api/host/close-voting",
      tally: "/api/host/reveal-result",
      "show-ranking": "/api/host/show-ranking",
      "skip-animation": "/api/host/skip-animation",
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
    state.logs.unshift({ at: new Date().toISOString(), kind, message: String(message || "") });
    state.logs = state.logs.slice(0, 80);
    localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify(state.logs));
  }

  function showToast(message) {
    state.toast = message;
    render();
    setTimeout(() => {
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
      if (!AudioContext) return;
      const context = new AudioContext();
      context.resume();
    } catch (error) {
      logClient("audio.error", error.message);
    }
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
