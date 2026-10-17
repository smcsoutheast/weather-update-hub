"use strict";

const FIREBASE_ROOT = "southeast-weather-hub-v2";
const DEVICE_ID_KEY = "smcSoutheastCommandDeviceId";
const HEARTBEAT_INTERVAL_MS = 10000;
const COMMAND_LOCK_STALE_MS = 45000;
const PUBLIC_POLL_NORMAL_MS = 30000;
const PUBLIC_POLL_ACTIVE_MS = 10000;
const LIGHTNING_CLEAR_MINUTES = 30;
const MAX_HISTORY_ITEMS = 150;
const MAX_TIMELINE_ITEMS = 250;
const MAX_INCIDENT_ITEMS = 150;
const MAX_INCIDENT_FILE_BYTES = 300000;

const admins = [
  { name: "Justin", role: "Tournament Director", password: "justin2026$" },
  { name: "Ashley", role: "Tournament Operations", password: "ashley2026$" }
];

const templates = {
  allClear: "All active venues are operating as scheduled. SMC staff will continue monitoring weather conditions.",
  monitoring: "SMC staff are monitoring weather conditions. Games remain scheduled unless a venue update states otherwise.",
  lightningDelay: "Lightning has been detected near one or more venues. Follow the venue-specific instructions below.",
  heatAdvisory: "SMC staff are monitoring heat conditions. Teams should follow hydration and rest instructions from tournament staff.",
  fieldClosure: "One or more fields are closed or under review. Check the venue and field status sections for current information.",
  resumePlay: "SMC staff have issued an all clear for the affected venue. Follow venue-specific restart instructions."
};

const elements = Object.fromEntries([
  "stickyStatus","stickyStatusText","stickyUpdateText","globalStatus","lastUpdated","publicConnectionNotice","globalNote","refreshBtn",
  "publicLightningBadge","publicLightningPanel","publicLightningList","venueGrid","fieldStatusPanel","fieldStatusBoard","historyList",
  "adminShieldBtn","adminDrawer","adminSessionText","minimizeAdminBtn","loginBox","passwordInput","verifyBtn","commandCenter",
  "commandReadOnlyBanner","fullScreenBtn","lockBtn","stateFilter","firebaseStatusText","firebaseStatusBadge","commandDeviceStatusText",
  "takeoverCommandBtn","releaseCommandBtn","allGreenBtn","allYellowBtn","allRedBtn","seedBtn","globalForm","globalTemplateSelect","globalNoteInput",
  "lightningForm","lightningVenueSelect","lightningDistanceInput","lightningMinutesInput","lightningSourceSelect","lightningNotesInput","lightningAlertList",
  "aiUpdateForm","aiVenueSelect","aiAlertTypeSelect","aiSeveritySelect","aiWeatherDetailsInput","aiGeneratedOutput","aiApplyVenueBtn","aiApplyGlobalBtn",
  "fieldStatusForm","fieldVenueSelect","fieldNameInput","fieldStatusSelect","fieldNoteInput","clearFieldBoardBtn","fieldBoardAdminList",
  "venueForm","newVenueName","newVenueState","newVenueAddress","newVenueMap","newVenueMedical","newVenueShelter","newVenueParking","adminVenueList",
  "timelineForm","timelineTitleInput","timelineBodyInput","clearHistoryBtn","timelineList","incidentForm","incidentVenueSelect","incidentTypeSelect",
  "incidentNoteInput","incidentFileInput","clearIncidentsBtn","incidentList"
].map(id => [id, document.getElementById(id)]));

let firebaseDb = null;
let rootRef = null;
let firebaseReady = false;
let firebaseConnected = false;
let serverTimeOffset = 0;
let publicData = blankPublicData();
let publicDataLoaded = false;
let adminData = { timeline: {}, incidents: {} };
let loggedInAdmin = null;
let commandLock = null;
let commandLockListener = null;
let adminListenersActive = false;
let commandHeartbeatTimer = null;
let publicPollTimer = null;
let lightningUiTimer = null;
let allClearPanelExpanded = false;
let writeInProgress = false;
let currentTab = "overview";

const deviceId = getOrCreateDeviceId();

function blankPublicData() {
  return {
    version: 2,
    globalNote: "No active weather updates have been published.",
    updatedAt: 0,
    venues: {},
    history: {}
  };
}

function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function nowMs() {
  return Date.now() + serverTimeOffset;
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function normalizeStatus(value) {
  const status = String(value || "green").toLowerCase();
  return ["green", "yellow", "red"].includes(status) ? status : "green";
}

function titleCaseStatus(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function normalizeVenue(id, raw = {}) {
  const fields = raw.fields && typeof raw.fields === "object" ? raw.fields : {};
  const lightning = raw.lightning && typeof raw.lightning === "object" ? raw.lightning : null;
  return {
    id: raw.id || id,
    name: raw.name || "Unnamed Venue",
    state: raw.state || "Florida",
    address: raw.address || "",
    map: raw.map || "",
    medical: raw.medical || "",
    shelter: raw.shelter || "",
    parking: raw.parking || "",
    status: normalizeStatus(raw.status),
    statusSource: raw.statusSource || "manual",
    note: raw.note || "Normal operations.",
    updatedAt: Number(raw.updatedAt || 0),
    fields,
    lightning
  };
}

function normalizePublicData(raw) {
  if (!raw || typeof raw !== "object") return blankPublicData();
  const venues = {};
  const rawVenues = raw.venues && typeof raw.venues === "object" ? raw.venues : {};
  Object.entries(rawVenues).forEach(([id, venue]) => {
    if (venue && typeof venue === "object") venues[id] = normalizeVenue(id, venue);
  });
  return {
    version: 2,
    globalNote: raw.globalNote || "No active weather updates have been published.",
    updatedAt: Number(raw.updatedAt || 0),
    venues,
    history: raw.history && typeof raw.history === "object" ? raw.history : {}
  };
}

function getVenues() {
  return Object.values(publicData.venues || {}).sort((a, b) => a.name.localeCompare(b.name));
}

function deriveGlobalStatus() {
  const venues = getVenues();
  if (!venues.length) return "unavailable";
  if (venues.some(venue => venue.status === "red")) return "red";
  if (venues.some(venue => venue.status === "yellow")) return "yellow";
  return "green";
}

function latestPublishedTime() {
  let latest = Number(publicData.updatedAt || 0);
  getVenues().forEach(venue => {
    latest = Math.max(latest, Number(venue.updatedAt || 0));
    if (venue.lightning) latest = Math.max(latest, Number(venue.lightning.updatedAt || 0));
    Object.values(venue.fields || {}).forEach(field => {
      latest = Math.max(latest, Number(field.updatedAt || 0));
    });
  });
  return latest;
}

function formatDateTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "Not yet updated";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "Not recorded";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatCountdown(clearAt) {
  const remainingMs = Math.max(0, Number(clearAt || 0) - nowMs());
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    remainingMs,
    clock: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    complete: remainingMs <= 0
  };
}

function fieldColor(status) {
  if (status === "Closed") return "red";
  if (["Delayed", "Under Review", "Maintenance"].includes(status)) return "yellow";
  return "green";
}

function isLightningRelevant(venue) {
  const lightning = venue.lightning;
  if (!lightning) return false;
  if (lightning.active || lightning.monitoring || lightning.awaitingAllClear) return true;
  return venue.statusSource === "lightning" && venue.status !== "green";
}

function hasActiveWeather() {
  return getVenues().some(venue => venue.status !== "green" || isLightningRelevant(venue));
}

function updateStatusClass(node, status) {
  if (!node) return;
  node.classList.remove("green", "yellow", "red", "unavailable");
  node.classList.add(status);
}

function renderPublic() {
  const globalStatus = deriveGlobalStatus();
  const statusLabel = globalStatus === "unavailable" ? "NO ACTIVE VENUES" : `${globalStatus.toUpperCase()} STATUS`;
  updateStatusClass(elements.stickyStatus, globalStatus);
  updateStatusClass(elements.globalStatus, globalStatus);
  elements.stickyStatusText.textContent = statusLabel;
  elements.globalStatus.textContent = statusLabel;

  const latest = latestPublishedTime();
  const updatedText = latest ? `Last updated: ${formatDateTime(latest)}` : "No published update yet";
  elements.stickyUpdateText.textContent = updatedText;
  elements.lastUpdated.textContent = updatedText;
  elements.globalNote.textContent = publicData.globalNote || "No active weather updates have been published.";

  renderVenueCards();
  renderFieldBoard();
  renderPublicLightning();
  renderHistory();
  updateVenueSelects();
  if (loggedInAdmin) renderAdminVenueList();
}

function renderVenueCards() {
  const venues = getVenues();
  if (!venues.length) {
    elements.venueGrid.innerHTML = `
      <article class="venue-card empty-card">
        <h2>No Active Venues</h2>
        <p class="venue-note">SMC has not published an active venue roster for the current weekend.</p>
      </article>`;
    return;
  }
  elements.venueGrid.innerHTML = venues.map(venue => `
    <article class="venue-card ${escapeAttr(venue.status)}-card">
      <h2>${escapeHtml(venue.name.toUpperCase())}</h2>
      <div class="venue-status-pill">${escapeHtml(venue.status.toUpperCase())}</div>
      <p class="venue-note">${escapeHtml(venue.note || "No public note posted.")}</p>
    </article>`).join("");
}

function renderFieldBoard() {
  const records = [];
  getVenues().forEach(venue => {
    Object.entries(venue.fields || {}).forEach(([id, field]) => {
      if (!field || typeof field !== "object") return;
      records.push({ id, venueId: venue.id, venueName: venue.name, ...field });
    });
  });
  records.sort((a, b) => a.venueName.localeCompare(b.venueName) || String(a.name).localeCompare(String(b.name)));
  elements.fieldStatusPanel.classList.toggle("hidden", records.length === 0);
  elements.fieldStatusBoard.innerHTML = records.map(field => {
    const color = fieldColor(field.status);
    return `
      <article class="field-status-card ${color}-field-card">
        <h3>${escapeHtml(field.venueName)} | ${escapeHtml(field.name || "Field")}</h3>
        <span class="field-status-pill ${color}">${escapeHtml(field.status || "Open")}</span>
        <p>${escapeHtml(field.note || "No field note posted.")}</p>
        <small>Updated: ${escapeHtml(formatDateTime(field.updatedAt))}</small>
      </article>`;
  }).join("");
  renderAdminFieldList(records);
}

function renderPublicLightning() {
  const relevant = getVenues().filter(isLightningRelevant);
  if (!relevant.length) {
    elements.publicLightningBadge.classList.remove("hidden");
    elements.publicLightningBadge.setAttribute("aria-expanded", String(allClearPanelExpanded));
    elements.publicLightningPanel.classList.toggle("hidden", !allClearPanelExpanded);
    elements.publicLightningList.innerHTML = allClearPanelExpanded ? `
      <article class="public-lightning-card green-lightning-card all-clear-lightning-card">
        <div class="public-lightning-header"><h3>Lightning All Clear</h3></div>
        <div class="lightning-public-grid">
          <div class="lightning-stat-box"><span>Active lightning delays</span><strong>NONE</strong></div>
          <div class="lightning-stat-box countdown-box"><span>Countdown</span><strong class="lightning-countdown-clock">00:00</strong></div>
        </div>
        <p class="lightning-public-note">No active lightning delay is posted. Continue checking the Hub for updates.</p>
      </article>` : "";
    return;
  }

  allClearPanelExpanded = false;
  elements.publicLightningBadge.classList.add("hidden");
  elements.publicLightningPanel.classList.remove("hidden");
  elements.publicLightningList.innerHTML = relevant.map(venue => {
    const lightning = venue.lightning || {};
    const countdown = lightning.active && lightning.clearAt ? formatCountdown(lightning.clearAt) : null;
    let status = venue.status;
    let countdownLabel = "Monitoring";
    let detail = "SMC staff are monitoring lightning conditions.";
    if (countdown) {
      countdownLabel = countdown.clock;
      detail = countdown.complete
        ? "Lightning timer complete. Awaiting manual SMC all clear before play resumes."
        : "Lightning delay is active. The timer restarts only when a new qualifying strike is entered for this venue.";
      status = "red";
    } else if (lightning.awaitingAllClear) {
      countdownLabel = "AWAITING ALL CLEAR";
      detail = "SMC staff are reviewing conditions before returning the venue to normal operations.";
    }
    return `
      <article class="public-lightning-card ${escapeAttr(status)}-lightning-card">
        <div class="public-lightning-header"><h3>${escapeHtml(venue.name)}</h3></div>
        <div class="lightning-public-grid">
          <div class="lightning-stat-box">
            <span>Closest lightning strike</span>
            <strong>${Number.isFinite(Number(lightning.distance)) ? `${Number(lightning.distance).toFixed(1)} miles` : "Not listed"}</strong>
          </div>
          <div class="lightning-stat-box countdown-box">
            <span>${countdown && countdown.complete ? "Status" : "Return-to-play timer"}</span>
            <strong class="lightning-countdown-clock">${escapeHtml(countdownLabel)}</strong>
          </div>
        </div>
        <p class="lightning-public-note">${escapeHtml(lightning.publicNote || detail)}</p>
        <div class="public-lightning-meta">Last strike: ${escapeHtml(formatDateTime(lightning.lastStrikeAt))} | Source: ${escapeHtml(lightning.source || "Not listed")}</div>
      </article>`;
  }).join("");
}

function renderHistory() {
  const cutoff = nowMs() - 72 * 60 * 60 * 1000;
  const entries = Object.entries(publicData.history || {})
    .map(([id, entry]) => ({ id, ...entry }))
    .filter(entry => ["green", "yellow", "red"].includes(entry.status) && Number(entry.timestamp || 0) >= cutoff)
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MAX_HISTORY_ITEMS);

  elements.historyList.innerHTML = entries.length ? entries.map(entry => `
    <article class="status-history-item ${escapeAttr(entry.status)}-history">
      <div class="history-title-row">
        <strong>${escapeHtml(entry.title || "Status update")}</strong>
        <span class="history-status-pill ${escapeAttr(entry.status)}">${escapeHtml(entry.status)}</span>
      </div>
      <p>${escapeHtml(entry.note || "")}</p>
      <span>${escapeHtml(formatDateTime(entry.timestamp))}</span>
    </article>`).join("") : `<p class="muted">No public status updates from the last 72 hours.</p>`;
}

function setPublicConnectionState(type, text) {
  if (!elements.publicConnectionNotice) return;
  if (type === "connected") {
    elements.publicConnectionNotice.textContent = "";
    elements.publicConnectionNotice.className = "connection-notice hidden";
    return;
  }
  elements.publicConnectionNotice.textContent = text;
  elements.publicConnectionNotice.className = `connection-notice ${type}`;
}

function publicDatabaseUrl() {
  const config = window.SMC_FIREBASE_CONFIG || {};
  const base = String(config.databaseURL || "").replace(/\/$/, "");
  return base ? `${base}/${FIREBASE_ROOT}/public.json` : "";
}

async function refreshPublicData(options = {}) {
  const url = publicDatabaseUrl();
  if (!url) {
    publicDataLoaded = false;
    publicData = blankPublicData();
    renderPublic();
    setPublicConnectionState("error", "Weather status feed is unavailable. Firebase configuration is missing.");
    schedulePublicPoll(PUBLIC_POLL_NORMAL_MS);
    return;
  }

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    if (raw && typeof raw === "object") {
      publicData = normalizePublicData(raw);
      publicDataLoaded = true;
      renderPublic();
      setPublicConnectionState("connected", "");
    } else {
      publicData = blankPublicData();
      publicDataLoaded = true;
      renderPublic();
      setPublicConnectionState("connected", "");
    }
  } catch (error) {
    if (publicDataLoaded) {
      setPublicConnectionState("warning", "Unable to refresh right now. Showing the last valid published update.");
    } else {
      publicData = blankPublicData();
      renderPublic();
      setPublicConnectionState("error", "Status temporarily unavailable. No default Green status has been substituted.");
    }
  }
  if (!options.noSchedule) schedulePublicPoll(hasActiveWeather() ? PUBLIC_POLL_ACTIVE_MS : PUBLIC_POLL_NORMAL_MS);
}

function schedulePublicPoll(delay) {
  clearTimeout(publicPollTimer);
  publicPollTimer = setTimeout(() => refreshPublicData(), delay);
}

function getFirebaseConfig() {
  const config = window.SMC_FIREBASE_CONFIG || {};
  if (!config.enabled) return null;
  const required = ["apiKey", "authDomain", "databaseURL", "projectId", "appId"];
  if (required.some(key => !config[key] || String(config[key]).includes("PASTE_"))) return null;
  return config;
}

function updateFirebaseStatus(status, message) {
  if (!elements.firebaseStatusText || !elements.firebaseStatusBadge) return;
  elements.firebaseStatusText.textContent = message;
  elements.firebaseStatusBadge.textContent = status;
  elements.firebaseStatusBadge.className = `sync-badge ${String(status).toLowerCase().replace(/\s+/g, "-")}`;
}

function initFirebase() {
  const config = getFirebaseConfig();
  if (!config) {
    updateFirebaseStatus("Error", "Firebase is not configured or is disabled.");
    return;
  }
  if (!window.firebase || !window.firebase.database) {
    updateFirebaseStatus("Error", "Firebase library did not load.");
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(config);
    firebaseDb = firebase.database();
    rootRef = firebaseDb.ref(FIREBASE_ROOT);
    firebaseReady = true;
    firebaseDb.ref(".info/serverTimeOffset").on("value", snapshot => {
      serverTimeOffset = Number(snapshot.val() || 0);
    });
    firebaseDb.ref(".info/connected").on("value", snapshot => {
      firebaseConnected = snapshot.val() === true;
      if (firebaseConnected) updateFirebaseStatus("Connected", "Firebase connected. Waiting for Command Device ownership.");
      else updateFirebaseStatus("Offline", "Firebase connection lost. Operational writes are blocked until connection returns.");
      updateCommandDeviceUI();
    });
  } catch (error) {
    firebaseReady = false;
    updateFirebaseStatus("Error", "Firebase setup failed. Check firebase-config.js and Realtime Database rules.");
  }
}

function commandLockIsStale(lock) {
  if (!lock || !lock.heartbeatAt) return true;
  return nowMs() - Number(lock.heartbeatAt) > COMMAND_LOCK_STALE_MS;
}

function isCommandDevice() {
  return Boolean(
    loggedInAdmin &&
    firebaseReady &&
    firebaseConnected &&
    commandLock &&
    commandLock.deviceId === deviceId &&
    !commandLockIsStale(commandLock)
  );
}

function startCommandLockListener() {
  if (!rootRef || commandLockListener) return;
  commandLockListener = rootRef.child("system/commandDevice");
  commandLockListener.on("value", snapshot => {
    commandLock = snapshot.val() || null;
    updateCommandDeviceUI();
    if (commandLock && commandLock.deviceId === deviceId) startHeartbeat();
    else stopHeartbeat();
    if (loggedInAdmin && (!commandLock || commandLockIsStale(commandLock))) attemptClaimCommand(false);
  });
}

function startHeartbeat() {
  if (commandHeartbeatTimer) return;
  const beat = () => {
    if (!rootRef || !loggedInAdmin || !commandLock || commandLock.deviceId !== deviceId) return;
    rootRef.child("system/commandDevice").transaction(current => {
      if (!current || current.deviceId !== deviceId) return;
      return {
        ...current,
        heartbeatAt: nowMs(),
        adminName: loggedInAdmin.name,
        role: loggedInAdmin.role
      };
    }, () => {}, false);
  };
  beat();
  commandHeartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (commandHeartbeatTimer) clearInterval(commandHeartbeatTimer);
  commandHeartbeatTimer = null;
}

function attemptClaimCommand(force) {
  if (!loggedInAdmin || !rootRef || !firebaseConnected) return;
  const ref = rootRef.child("system/commandDevice");
  ref.transaction(current => {
    const stale = !current || !current.heartbeatAt || nowMs() - Number(current.heartbeatAt) > COMMAND_LOCK_STALE_MS;
    const sameDevice = current && current.deviceId === deviceId;
    if (force || stale || sameDevice) {
      return {
        deviceId,
        adminName: loggedInAdmin.name,
        role: loggedInAdmin.role,
        claimedAt: sameDevice && current.claimedAt ? current.claimedAt : nowMs(),
        heartbeatAt: nowMs()
      };
    }
    return;
  }, (error, committed, snapshot) => {
    if (error) {
      updateFirebaseStatus("Error", "Command Device lock failed. No operational write was made.");
      return;
    }
    commandLock = snapshot.val() || commandLock;
    updateCommandDeviceUI();
    if (committed && commandLock && commandLock.deviceId === deviceId) startHeartbeat();
  });
}

function updateCommandDeviceUI() {
  if (!loggedInAdmin) return;
  const active = isCommandDevice();
  const otherActive = commandLock && commandLock.deviceId !== deviceId && !commandLockIsStale(commandLock);
  const stale = commandLock && commandLockIsStale(commandLock);

  if (active) {
    elements.commandDeviceStatusText.textContent = `ACTIVE COMMAND DEVICE | ${loggedInAdmin.name}, ${loggedInAdmin.role}`;
    elements.takeoverCommandBtn.classList.add("hidden");
    elements.releaseCommandBtn.classList.remove("hidden");
    elements.commandReadOnlyBanner.classList.add("hidden");
    if (firebaseConnected) updateFirebaseStatus("Synced", "This device owns the Command Center. Operational writes are enabled.");
  } else if (otherActive) {
    elements.commandDeviceStatusText.textContent = `READ ONLY | Command Center owned by ${commandLock.adminName || "another SMC user"} on another device.`;
    elements.takeoverCommandBtn.classList.remove("hidden");
    elements.releaseCommandBtn.classList.add("hidden");
    elements.commandReadOnlyBanner.classList.remove("hidden");
    if (firebaseConnected) updateFirebaseStatus("Connected", "Firebase connected. This device is read only until takeover.");
  } else {
    elements.commandDeviceStatusText.textContent = stale ? "Command Device lock expired. Attempting to claim control." : "No active Command Device. Attempting to claim control.";
    elements.takeoverCommandBtn.classList.remove("hidden");
    elements.releaseCommandBtn.classList.add("hidden");
    elements.commandReadOnlyBanner.classList.remove("hidden");
  }
}

async function releaseCommandDevice() {
  if (!rootRef || !commandLock || commandLock.deviceId !== deviceId) return;
  await rootRef.child("system/commandDevice").transaction(current => {
    if (current && current.deviceId === deviceId) return null;
    return;
  });
  stopHeartbeat();
}

function requireWriteAccess() {
  if (writeInProgress) {
    alert("Another Command Center update is still being published. Try again after it finishes.");
    return false;
  }
  if (!loggedInAdmin) {
    alert("Admin login required.");
    return false;
  }
  if (!firebaseReady || !firebaseConnected) {
    alert("Firebase is offline. The Hub will not change until the Command Device reconnects.");
    return false;
  }
  if (!isCommandDevice()) {
    alert("This device is read only. Use Take Over Command Center before publishing changes.");
    return false;
  }
  return true;
}

async function publishUpdates(updates, successMessage = "") {
  if (!requireWriteAccess()) return false;
  writeInProgress = true;
  try {
    updates["public/updatedAt"] = firebase.database.ServerValue.TIMESTAMP;
    await rootRef.update(updates);
    if (successMessage) updateFirebaseStatus("Synced", successMessage);
    await refreshPublicData({ noSchedule: true });
    schedulePublicPoll(hasActiveWeather() ? PUBLIC_POLL_ACTIVE_MS : PUBLIC_POLL_NORMAL_MS);
    return true;
  } catch (error) {
    updateFirebaseStatus("Error", "Publish failed. Existing public data was left unchanged.");
    alert("Firebase publish failed. No local fallback was uploaded.");
    return false;
  } finally {
    writeInProgress = false;
  }
}

function historyUpdate(updates, title, note, status) {
  if (!["green", "yellow", "red"].includes(status)) return;
  const id = uid("history");
  updates[`public/history/${id}`] = {
    title,
    note,
    status,
    timestamp: firebase.database.ServerValue.TIMESTAMP
  };
}

function timelineUpdate(updates, title, note) {
  const id = uid("timeline");
  updates[`admin/timeline/${id}`] = {
    title,
    note,
    admin: loggedInAdmin ? `${loggedInAdmin.name}, ${loggedInAdmin.role}` : "SMC Staff",
    timestamp: firebase.database.ServerValue.TIMESTAMP
  };
}

function updateVenueSelect(select) {
  if (!select) return;
  const previous = select.value;
  const venues = getVenues();
  select.innerHTML = venues.length
    ? venues.map(venue => `<option value="${escapeAttr(venue.id)}">${escapeHtml(venue.name)}</option>`).join("")
    : `<option value="">No active venues</option>`;
  if (venues.some(venue => venue.id === previous)) select.value = previous;
}

function updateVenueSelects() {
  [elements.lightningVenueSelect, elements.aiVenueSelect, elements.fieldVenueSelect, elements.incidentVenueSelect].forEach(updateVenueSelect);
}

function renderAdminVenueList() {
  if (!loggedInAdmin || !elements.adminVenueList) return;
  const state = elements.stateFilter ? elements.stateFilter.value : "all";
  const venues = getVenues().filter(venue => state === "all" || venue.state === state);
  elements.adminVenueList.innerHTML = venues.length ? venues.map(venue => `
    <article class="admin-venue-card" data-venue-id="${escapeAttr(venue.id)}">
      <h3>${escapeHtml(venue.name)}</h3>
      <label>Venue name</label>
      <input data-field="name" type="text" value="${escapeAttr(venue.name)}" />
      <label>Region</label>
      <select data-field="state">
        ${["Florida","North Carolina","South Carolina","Alabama","Georgia"].map(stateName => `<option value="${escapeAttr(stateName)}" ${venue.state === stateName ? "selected" : ""}>${escapeHtml(stateName)}</option>`).join("")}
      </select>
      <label>Status</label>
      <select data-field="status">
        ${["green","yellow","red"].map(status => `<option value="${status}" ${venue.status === status ? "selected" : ""}>${titleCaseStatus(status)}</option>`).join("")}
      </select>
      <label>Public note</label>
      <textarea data-field="note" rows="3">${escapeHtml(venue.note)}</textarea>
      <label>Venue address or details</label>
      <input data-field="address" type="text" value="${escapeAttr(venue.address)}" />
      <label>GPS or map link</label>
      <input data-field="map" type="url" value="${escapeAttr(venue.map)}" />
      <label>Medical location or note</label>
      <input data-field="medical" type="text" value="${escapeAttr(venue.medical)}" />
      <label>Weather shelter location or note</label>
      <input data-field="shelter" type="text" value="${escapeAttr(venue.shelter)}" />
      <label>Parking or access note</label>
      <input data-field="parking" type="text" value="${escapeAttr(venue.parking)}" />
      <div class="admin-actions">
        <button data-action="save-venue" type="button">Save Venue</button>
        <button data-action="delete-venue" class="danger" type="button">Remove Active Venue</button>
      </div>
    </article>`).join("") : `<p class="muted">No active venues match this region.</p>`;
}

function renderAdminFieldList(records = null) {
  if (!loggedInAdmin || !elements.fieldBoardAdminList) return;
  const list = records || getVenues().flatMap(venue => Object.entries(venue.fields || {}).map(([id, field]) => ({ id, venueId: venue.id, venueName: venue.name, ...field })));
  elements.fieldBoardAdminList.innerHTML = list.length ? list.map(field => `
    <article class="incident-item">
      <strong>${escapeHtml(field.venueName)} | ${escapeHtml(field.name || "Field")}</strong>
      <span>${escapeHtml(field.status || "Open")} | ${escapeHtml(formatDateTime(field.updatedAt))}</span>
      <p>${escapeHtml(field.note || "")}</p>
      <button class="secondary small-btn" data-action="delete-field" data-venue-id="${escapeAttr(field.venueId)}" data-field-id="${escapeAttr(field.id)}" type="button">Remove Field Status</button>
    </article>`).join("") : `<p class="muted">No field status records.</p>`;
}

function renderAdminLightning() {
  if (!loggedInAdmin || !elements.lightningAlertList) return;
  const venues = getVenues().filter(venue => venue.lightning || venue.statusSource === "lightning");
  elements.lightningAlertList.innerHTML = venues.length ? venues.map(venue => {
    const lightning = venue.lightning || {};
    const countdown = lightning.active && lightning.clearAt ? formatCountdown(lightning.clearAt) : null;
    const timerText = countdown ? (countdown.complete ? "TIMER COMPLETE | AWAITING SMC ALL CLEAR" : `${countdown.clock} remaining`) : (lightning.monitoring ? "Monitoring" : "No active timer");
    return `
      <article class="incident-item">
        <strong>${escapeHtml(venue.name)} | ${escapeHtml(venue.status.toUpperCase())}</strong>
        <span>${Number.isFinite(Number(lightning.distance)) ? `${Number(lightning.distance).toFixed(1)} miles` : "Distance not listed"} | ${escapeHtml(timerText)}</span>
        <p>${escapeHtml(lightning.publicNote || venue.note || "")}</p>
        ${venue.statusSource === "lightning" ? `<button class="manual-clear-btn" data-action="manual-all-clear" data-venue-id="${escapeAttr(venue.id)}" type="button">Manual All Clear</button>` : ""}
      </article>`;
  }).join("") : `<p class="muted">No lightning records for active venues.</p>`;
}

function startAdminListeners() {
  if (!rootRef || adminListenersActive) return;
  adminListenersActive = true;
  rootRef.child("admin/timeline").on("value", snapshot => {
    adminData.timeline = snapshot.val() || {};
    renderTimeline();
  });
  rootRef.child("admin/incidents").on("value", snapshot => {
    adminData.incidents = snapshot.val() || {};
    renderIncidents();
  });
}

function renderTimeline() {
  if (!elements.timelineList) return;
  const entries = Object.entries(adminData.timeline || {})
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MAX_TIMELINE_ITEMS);
  elements.timelineList.innerHTML = entries.length ? entries.map(entry => `
    <article class="history-item">
      <strong>${escapeHtml(entry.title || "Operations update")}</strong>
      <span>${escapeHtml(formatDateTime(entry.timestamp))} | ${escapeHtml(entry.admin || "SMC Staff")}</span>
      <p>${escapeHtml(entry.note || "")}</p>
    </article>`).join("") : `<p class="muted">No private operations timeline entries.</p>`;
}

function renderIncidents() {
  if (!elements.incidentList) return;
  const entries = Object.entries(adminData.incidents || {})
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
    .slice(0, MAX_INCIDENT_ITEMS);
  elements.incidentList.innerHTML = entries.length ? entries.map(entry => `
    <article class="incident-item">
      <strong>${escapeHtml(entry.type || "Incident")} | ${escapeHtml(entry.venueName || "General")}</strong>
      <span>${escapeHtml(formatDateTime(entry.timestamp))} | ${escapeHtml(entry.admin || "SMC Staff")}</span>
      <p>${escapeHtml(entry.note || "")}</p>
      ${(entry.files || []).map(file => `<a class="file-link" href="${escapeAttr(file.dataUrl)}" download="${escapeAttr(file.name)}">${escapeHtml(file.name)}</a>`).join(" ")}
    </article>`).join("") : `<p class="muted">No private incident records.</p>`;
}

function renderAdmin() {
  renderAdminVenueList();
  renderAdminLightning();
  renderAdminFieldList();
  renderTimeline();
  renderIncidents();
  updateVenueSelects();
  if (elements.globalNoteInput) elements.globalNoteInput.value = publicData.globalNote || "";
}

function activateTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll(".tab-btn").forEach(button => button.classList.toggle("active", button.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.tabPanel === tabName));
}

function openAdminDrawer() {
  elements.adminDrawer.classList.remove("hidden");
  if (loggedInAdmin) elements.adminDrawer.classList.add("admin-fullscreen");
  elements.passwordInput.focus();
}

function closeAdminDrawer() {
  elements.adminDrawer.classList.add("hidden");
  document.body.classList.remove("command-mode");
}

function login() {
  const password = elements.passwordInput.value;
  const match = admins.find(admin => admin.password === password);
  if (!match) {
    alert("Incorrect command center password.");
    return;
  }
  loggedInAdmin = { name: match.name, role: match.role };
  elements.passwordInput.value = "";
  elements.loginBox.classList.add("hidden");
  elements.commandCenter.classList.remove("hidden");
  elements.adminDrawer.classList.add("admin-fullscreen");
  elements.adminSessionText.textContent = `${match.name} | ${match.role}`;
  startCommandLockListener();
  startAdminListeners();
  renderAdmin();
  activateTab(currentTab);
  attemptClaimCommand(false);
}

async function lockAdmin() {
  loggedInAdmin = null;
  stopHeartbeat();
  elements.commandCenter.classList.add("hidden");
  elements.loginBox.classList.remove("hidden");
  elements.adminDrawer.classList.remove("admin-fullscreen");
  elements.adminSessionText.textContent = "Protected command center";
  document.body.classList.remove("command-mode");
}

function statusTemplateFor(status) {
  if (status === "red") return templates.lightningDelay;
  if (status === "yellow") return templates.monitoring;
  return templates.allClear;
}

async function applyAllStatus(status) {
  if (!requireWriteAccess()) return;
  const venues = getVenues();
  if (!venues.length) return alert("Add an active venue first.");
  if ((status === "green" || status === "yellow") && venues.some(venue => venue.lightning && (venue.lightning.active || venue.lightning.monitoring || venue.lightning.awaitingAllClear || venue.statusSource === "lightning"))) {
    alert("One or more venues have a lightning status. Use Manual All Clear for each lightning venue before lowering its status.");
    return;
  }
  if (!confirm(`Set every active venue to ${status.toUpperCase()}?`)) return;
  const updates = {};
  const note = statusTemplateFor(status);
  venues.forEach(venue => {
    updates[`public/venues/${venue.id}/status`] = status;
    updates[`public/venues/${venue.id}/statusSource`] = "manual";
    updates[`public/venues/${venue.id}/note`] = note;
    updates[`public/venues/${venue.id}/updatedAt`] = firebase.database.ServerValue.TIMESTAMP;
    historyUpdate(updates, `${venue.name} ${titleCaseStatus(status)}`, note, status);
  });
  timelineUpdate(updates, `All active venues set ${titleCaseStatus(status)}`, note);
  await publishUpdates(updates, `All active venues published as ${titleCaseStatus(status)}.`);
}

async function saveGlobalNote() {
  if (!requireWriteAccess()) return;
  const note = elements.globalNoteInput.value.trim();
  if (!note) return alert("Enter a public operations note.");
  const updates = { "public/globalNote": note };
  timelineUpdate(updates, "Global public note updated", note);
  await publishUpdates(updates, "Global public note published.");
}

async function addVenue() {
  if (!requireWriteAccess()) return;
  const name = elements.newVenueName.value.trim();
  if (!name) return alert("Enter a venue name.");
  const id = uid("venue");
  const venue = {
    id,
    name,
    state: elements.newVenueState.value,
    address: elements.newVenueAddress.value.trim(),
    map: elements.newVenueMap.value.trim(),
    medical: elements.newVenueMedical.value.trim(),
    shelter: elements.newVenueShelter.value.trim(),
    parking: elements.newVenueParking.value.trim(),
    status: "green",
    statusSource: "manual",
    note: "Normal operations.",
    updatedAt: firebase.database.ServerValue.TIMESTAMP,
    fields: {}
  };
  const updates = { [`public/venues/${id}`]: venue };
  historyUpdate(updates, `${name} Green`, "Normal operations.", "green");
  timelineUpdate(updates, "Active venue added", `${name} added to the current weekend Hub.`);
  if (await publishUpdates(updates, `${name} added to the active venue roster.`)) elements.venueForm.reset();
}

async function saveVenueFromCard(card) {
  if (!requireWriteAccess()) return;
  const id = card.dataset.venueId;
  const current = publicData.venues[id];
  if (!current) return;
  const value = field => card.querySelector(`[data-field="${field}"]`).value.trim();
  const nextStatus = card.querySelector('[data-field="status"]').value;
  if (nextStatus !== "red" && current.lightning && (current.lightning.active || current.lightning.monitoring || current.lightning.awaitingAllClear || current.statusSource === "lightning")) {
    alert("This venue has a lightning status. Use Manual All Clear before lowering the venue status.");
    return;
  }
  const next = {
    ...current,
    name: value("name") || current.name,
    state: card.querySelector('[data-field="state"]').value,
    status: nextStatus,
    statusSource: "manual",
    note: value("note") || statusTemplateFor(nextStatus),
    address: value("address"),
    map: value("map"),
    medical: value("medical"),
    shelter: value("shelter"),
    parking: value("parking"),
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  };
  const updates = { [`public/venues/${id}`]: next };
  if (nextStatus !== current.status || next.note !== current.note) historyUpdate(updates, `${next.name} ${titleCaseStatus(nextStatus)}`, next.note, nextStatus);
  timelineUpdate(updates, "Venue updated", `${next.name} updated by ${loggedInAdmin.name}.`);
  await publishUpdates(updates, `${next.name} published.`);
}

async function deleteVenue(id) {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[id];
  if (!venue) return;
  if (!confirm(`Remove ${venue.name} from the active weekend Hub?`)) return;
  const updates = { [`public/venues/${id}`]: null };
  timelineUpdate(updates, "Active venue removed", `${venue.name} removed from the current weekend Hub.`);
  await publishUpdates(updates, `${venue.name} removed from the active venue roster.`);
}

async function clearWeekendHub() {
  if (!requireWriteAccess()) return;
  if (!confirm("Clear every active venue, field status, lightning status, public note, and public status history for the weekend Hub? Private operations logs will remain.")) return;
  const updates = {
    "public/venues": null,
    "public/history": null,
    "public/globalNote": "No active weather updates have been published."
  };
  timelineUpdate(updates, "Weekend Hub cleared", "Active public venue and weather data cleared for a new weekend setup.");
  await publishUpdates(updates, "Weekend Hub cleared. Add active venues before publishing event updates.");
}

function lightningPublicNote(venue, distance, countdown, source) {
  if (countdown && !countdown.complete) {
    return `Lightning detected ${distance.toFixed(1)} miles from ${venue.name}. Games are suspended. The 30-minute timer is running from the latest qualifying strike. Manual SMC all clear is required before play resumes.`;
  }
  if (countdown && countdown.complete) {
    return `The lightning timer for ${venue.name} has reached 00:00. Play remains suspended until SMC staff issue a manual all clear.`;
  }
  if (distance <= 15) {
    return `Lightning is being monitored ${distance.toFixed(1)} miles from ${venue.name}. SMC staff are monitoring conditions and will post additional instructions if needed.`;
  }
  return `Lightning is currently beyond 15 miles from ${venue.name}. SMC staff continue monitoring conditions. A manual all clear is required to clear a lightning-related venue status.`;
}

async function applyLightningCheck() {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[elements.lightningVenueSelect.value];
  if (!venue) return alert("Select an active venue.");
  const distance = Number.parseFloat(elements.lightningDistanceInput.value);
  const minutesSince = Number.parseInt(elements.lightningMinutesInput.value || "0", 10);
  if (!Number.isFinite(distance) || distance < 0) return alert("Enter a valid lightning distance.");
  if (!Number.isFinite(minutesSince) || minutesSince < 0) return alert("Enter valid minutes since the last strike.");
  const source = elements.lightningSourceSelect.value;
  const privateNote = elements.lightningNotesInput.value.trim();
  const current = venue.lightning || {};
  const strikeAt = nowMs() - minutesSince * 60000;
  const updates = {};
  let lightning;
  let nextStatus = venue.status;
  let statusSource = venue.statusSource;
  let publicNote = venue.note;
  let historyStatus = null;
  const carryPreviousStatus = Boolean(current.active || current.monitoring || current.awaitingAllClear || venue.statusSource === "lightning");
  const preStatus = carryPreviousStatus && current.preStatus ? current.preStatus : venue.status;
  const preStatusSource = carryPreviousStatus && current.preStatusSource ? current.preStatusSource : venue.statusSource;
  const preNote = carryPreviousStatus && current.preNote ? current.preNote : venue.note;

  if (distance <= 10) {
    const clearAt = strikeAt + LIGHTNING_CLEAR_MINUTES * 60000;
    const countdown = formatCountdown(clearAt);
    lightning = {
      active: true,
      monitoring: true,
      awaitingAllClear: countdown.complete,
      distance,
      lastStrikeAt: strikeAt,
      clearAt,
      source,
      privateNote,
      publicNote: "",
      preStatus,
      preStatusSource,
      preNote,
      updatedAt: nowMs()
    };
    publicNote = lightningPublicNote(venue, distance, countdown, source);
    lightning.publicNote = publicNote;
    nextStatus = "red";
    statusSource = "lightning";
    historyStatus = "red";
  } else if (distance <= 15) {
    if (current.active) {
      lightning = { ...current, distance, source, privateNote, monitoring: true, updatedAt: nowMs() };
      const countdown = current.clearAt ? formatCountdown(current.clearAt) : null;
      publicNote = lightningPublicNote(venue, distance, countdown, source);
      lightning.publicNote = publicNote;
      nextStatus = "red";
      statusSource = "lightning";
      historyStatus = "red";
    } else {
      lightning = {
        active: false,
        monitoring: true,
        awaitingAllClear: false,
        distance,
        lastStrikeAt: strikeAt,
        clearAt: null,
        source,
        privateNote,
        publicNote: "",
        preStatus,
        preStatusSource,
        preNote,
        updatedAt: nowMs()
      };
      publicNote = lightningPublicNote(venue, distance, null, source);
      lightning.publicNote = publicNote;
      nextStatus = venue.status === "red" && venue.statusSource !== "lightning" ? "red" : "yellow";
      statusSource = nextStatus === "red" ? venue.statusSource : "lightning";
      historyStatus = nextStatus;
    }
  } else {
    lightning = {
      ...current,
      distance,
      source,
      privateNote,
      monitoring: false,
      awaitingAllClear: current.active ? current.awaitingAllClear : venue.statusSource === "lightning",
      updatedAt: nowMs()
    };
    if (current.active) {
      const countdown = current.clearAt ? formatCountdown(current.clearAt) : null;
      publicNote = lightningPublicNote(venue, distance, countdown, source);
      lightning.publicNote = publicNote;
      nextStatus = "red";
      statusSource = "lightning";
      historyStatus = "red";
    } else if (venue.statusSource === "lightning") {
      publicNote = lightningPublicNote(venue, distance, null, source);
      lightning.publicNote = publicNote;
      nextStatus = venue.status;
      statusSource = "lightning";
      historyStatus = nextStatus;
    }
  }

  updates[`public/venues/${venue.id}/lightning`] = lightning;
  updates[`public/venues/${venue.id}/status`] = nextStatus;
  updates[`public/venues/${venue.id}/statusSource`] = statusSource;
  updates[`public/venues/${venue.id}/note`] = publicNote;
  updates[`public/venues/${venue.id}/updatedAt`] = firebase.database.ServerValue.TIMESTAMP;
  if (historyStatus) historyUpdate(updates, `${venue.name} Lightning ${titleCaseStatus(historyStatus)}`, publicNote, historyStatus);
  timelineUpdate(updates, `${venue.name} lightning check`, `${distance.toFixed(1)} miles. Source: ${source}. ${privateNote}`.trim());
  if (await publishUpdates(updates, `${venue.name} lightning status published.`)) elements.lightningForm.reset();
}

async function manualAllClear(venueId) {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[venueId];
  if (!venue) return;
  if (!confirm(`Issue Manual All Clear for ${venue.name}?`)) return;
  const previousLightning = venue.lightning || {};
  const restoreStatus = normalizeStatus(previousLightning.preStatus || "green");
  const restoreSource = previousLightning.preStatusSource || "manual";
  const restoreNote = previousLightning.preNote || "Normal operations.";
  const allClearNote = `SMC staff have issued a lightning all clear for ${venue.name}.`;
  const finalNote = restoreStatus === "green"
    ? `${allClearNote} Normal operations may resume unless tournament staff provide different instructions.`
    : `${allClearNote} The venue remains ${restoreStatus.toUpperCase()} for a separate condition. ${restoreNote}`;
  const lightning = {
    ...previousLightning,
    active: false,
    monitoring: false,
    awaitingAllClear: false,
    clearAt: null,
    clearedAt: nowMs(),
    publicNote: finalNote,
    updatedAt: nowMs()
  };
  const updates = {
    [`public/venues/${venueId}/lightning`]: lightning,
    [`public/venues/${venueId}/updatedAt`]: firebase.database.ServerValue.TIMESTAMP
  };
  if (venue.statusSource === "lightning") {
    updates[`public/venues/${venueId}/status`] = restoreStatus;
    updates[`public/venues/${venueId}/statusSource`] = restoreStatus === "green" ? "lightning-clear" : restoreSource;
    updates[`public/venues/${venueId}/note`] = finalNote;
    historyUpdate(updates, `${venue.name} Lightning All Clear`, finalNote, restoreStatus);
  }
  timelineUpdate(updates, `${venue.name} manual lightning all clear`, finalNote);
  await publishUpdates(updates, `${venue.name} manual all clear published.`);
}

async function saveFieldStatus() {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[elements.fieldVenueSelect.value];
  if (!venue) return alert("Select an active venue.");
  const name = elements.fieldNameInput.value.trim();
  if (!name) return alert("Enter a field name or number.");
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || uid("field");
  const field = {
    name,
    status: elements.fieldStatusSelect.value,
    note: elements.fieldNoteInput.value.trim(),
    updatedAt: firebase.database.ServerValue.TIMESTAMP
  };
  const updates = { [`public/venues/${venue.id}/fields/${id}`]: field };
  timelineUpdate(updates, `${venue.name} field status updated`, `${name}: ${field.status}. ${field.note}`.trim());
  if (await publishUpdates(updates, `${venue.name} ${name} field status published.`)) elements.fieldStatusForm.reset();
}

async function deleteFieldStatus(venueId, fieldId) {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[venueId];
  if (!venue) return;
  const field = venue.fields && venue.fields[fieldId];
  if (!field) return;
  if (!confirm(`Remove ${field.name || "field"} status from ${venue.name}?`)) return;
  const updates = { [`public/venues/${venueId}/fields/${fieldId}`]: null };
  timelineUpdate(updates, `${venue.name} field status removed`, field.name || fieldId);
  await publishUpdates(updates, "Field status removed.");
}

async function clearFieldBoard() {
  if (!requireWriteAccess()) return;
  if (!confirm("Clear every public field status record for all active venues?")) return;
  const updates = {};
  getVenues().forEach(venue => { updates[`public/venues/${venue.id}/fields`] = null; });
  timelineUpdate(updates, "Field status board cleared", "All public field status records were removed.");
  await publishUpdates(updates, "Field status board cleared.");
}

function generateAiUpdate() {
  const venue = publicData.venues[elements.aiVenueSelect.value];
  const venueName = venue ? venue.name : "the selected venue";
  const alertType = elements.aiAlertTypeSelect.value;
  const severity = elements.aiSeveritySelect.value;
  const details = elements.aiWeatherDetailsInput.value.trim();
  const action = {
    Monitoring: "SMC staff are monitoring conditions. Games remain scheduled unless another update is posted.",
    Delay: "Games are temporarily delayed. Teams should remain clear of the fields and monitor the Hub for updates.",
    Suspended: "Games are suspended. Teams should leave the fields and follow instructions from SMC staff.",
    "All Clear": "SMC staff have issued an all clear. Normal operations may resume unless venue staff provide different instructions."
  }[severity];
  elements.aiGeneratedOutput.value = `${alertType} update for ${venueName}. ${details ? `${details} ` : ""}${action}`.trim();
}

async function applyAiToVenue() {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[elements.aiVenueSelect.value];
  if (!venue) return alert("Select an active venue.");
  const note = elements.aiGeneratedOutput.value.trim();
  if (!note) return alert("Generate or enter an update first.");
  const severity = elements.aiSeveritySelect.value;
  const status = severity === "Monitoring" ? "yellow" : severity === "All Clear" ? "green" : "red";
  if (status !== "red" && venue.lightning && (venue.lightning.active || venue.lightning.monitoring || venue.statusSource === "lightning")) {
    alert("This venue has a lightning status. Use Manual All Clear instead of an AI-generated All Clear.");
    return;
  }
  const updates = {
    [`public/venues/${venue.id}/status`]: status,
    [`public/venues/${venue.id}/statusSource`]: "manual",
    [`public/venues/${venue.id}/note`]: note,
    [`public/venues/${venue.id}/updatedAt`]: firebase.database.ServerValue.TIMESTAMP
  };
  historyUpdate(updates, `${venue.name} ${titleCaseStatus(status)}`, note, status);
  timelineUpdate(updates, `${venue.name} generated weather update`, note);
  await publishUpdates(updates, `${venue.name} update published.`);
}

async function applyAiGlobal() {
  if (!requireWriteAccess()) return;
  const note = elements.aiGeneratedOutput.value.trim();
  if (!note) return alert("Generate or enter an update first.");
  const updates = { "public/globalNote": note };
  timelineUpdate(updates, "Generated global weather note", note);
  await publishUpdates(updates, "Global weather note published.");
}

async function addTimelineEntry() {
  if (!requireWriteAccess()) return;
  const title = elements.timelineTitleInput.value.trim();
  const note = elements.timelineBodyInput.value.trim();
  if (!title || !note) return alert("Enter a timeline title and note.");
  const id = uid("timeline");
  writeInProgress = true;
  try {
    await rootRef.child(`admin/timeline/${id}`).set({
      title,
      note,
      admin: `${loggedInAdmin.name}, ${loggedInAdmin.role}`,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    elements.timelineForm.reset();
  } catch (error) {
    alert("Timeline save failed.");
  } finally {
    writeInProgress = false;
  }
}

function readFiles(files) {
  const selected = Array.from(files || []).slice(0, 3);
  const total = selected.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_INCIDENT_FILE_BYTES) return Promise.reject(new Error("Files too large"));
  return Promise.all(selected.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, dataUrl: reader.result });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })));
}

async function addIncident() {
  if (!requireWriteAccess()) return;
  const venue = publicData.venues[elements.incidentVenueSelect.value];
  const note = elements.incidentNoteInput.value.trim();
  if (!note) return alert("Enter an incident note.");
  let files = [];
  try {
    files = await readFiles(elements.incidentFileInput.files);
  } catch (error) {
    return alert("Incident attachments are limited to 300 KB total and three files.");
  }
  const id = uid("incident");
  writeInProgress = true;
  try {
    await rootRef.child(`admin/incidents/${id}`).set({
      venueId: venue ? venue.id : "",
      venueName: venue ? venue.name : "General",
      type: elements.incidentTypeSelect.value,
      note,
      files,
      admin: `${loggedInAdmin.name}, ${loggedInAdmin.role}`,
      timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    elements.incidentForm.reset();
  } catch (error) {
    alert("Incident save failed.");
  } finally {
    writeInProgress = false;
  }
}

async function clearPublicHistory() {
  if (!requireWriteAccess()) return;
  if (!confirm("Clear public status history only? Active venue statuses and notes will remain.")) return;
  const updates = { "public/history": null };
  timelineUpdate(updates, "Public status history cleared", "Public Green, Yellow, and Red history entries were cleared.");
  await publishUpdates(updates, "Public status history cleared.");
}

async function clearIncidents() {
  if (!requireWriteAccess()) return;
  if (!confirm("Clear every private incident record?")) return;
  writeInProgress = true;
  try {
    await rootRef.child("admin/incidents").remove();
  } catch (error) {
    alert("Incident clear failed.");
  } finally {
    writeInProgress = false;
  }
}

function bindEvents() {
  elements.refreshBtn.addEventListener("click", () => refreshPublicData());
  elements.publicLightningBadge.addEventListener("click", () => {
    allClearPanelExpanded = !allClearPanelExpanded;
    renderPublicLightning();
  });

  elements.adminShieldBtn.addEventListener("click", openAdminDrawer);
  elements.minimizeAdminBtn.addEventListener("click", closeAdminDrawer);
  elements.verifyBtn.addEventListener("click", login);
  elements.passwordInput.addEventListener("keydown", event => { if (event.key === "Enter") login(); });
  elements.lockBtn.addEventListener("click", lockAdmin);
  elements.fullScreenBtn.addEventListener("click", () => {
    const isFull = elements.adminDrawer.classList.toggle("admin-fullscreen");
    elements.fullScreenBtn.textContent = isFull ? "Exit Full Screen" : "Full Screen";
  });

  document.querySelectorAll(".tab-btn").forEach(button => button.addEventListener("click", () => activateTab(button.dataset.tab)));
  elements.stateFilter.addEventListener("change", renderAdminVenueList);

  elements.takeoverCommandBtn.addEventListener("click", () => {
    if (confirm("Take over the Command Center? The current Command Device will immediately become read only.")) attemptClaimCommand(true);
  });
  elements.releaseCommandBtn.addEventListener("click", () => {
    if (confirm("Release this device as the active Command Device?")) releaseCommandDevice();
  });

  elements.allGreenBtn.addEventListener("click", () => applyAllStatus("green"));
  elements.allYellowBtn.addEventListener("click", () => applyAllStatus("yellow"));
  elements.allRedBtn.addEventListener("click", () => applyAllStatus("red"));
  elements.seedBtn.addEventListener("click", clearWeekendHub);

  elements.globalTemplateSelect.addEventListener("change", () => {
    const key = elements.globalTemplateSelect.value;
    if (key && templates[key]) elements.globalNoteInput.value = templates[key];
  });
  elements.globalForm.addEventListener("submit", event => { event.preventDefault(); saveGlobalNote(); });

  elements.venueForm.addEventListener("submit", event => { event.preventDefault(); addVenue(); });
  elements.adminVenueList.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const card = button.closest("[data-venue-id]");
    if (!card) return;
    if (button.dataset.action === "save-venue") saveVenueFromCard(card);
    if (button.dataset.action === "delete-venue") deleteVenue(card.dataset.venueId);
  });

  elements.lightningForm.addEventListener("submit", event => { event.preventDefault(); applyLightningCheck(); });
  elements.lightningAlertList.addEventListener("click", event => {
    const button = event.target.closest('button[data-action="manual-all-clear"]');
    if (button) manualAllClear(button.dataset.venueId);
  });

  elements.fieldStatusForm.addEventListener("submit", event => { event.preventDefault(); saveFieldStatus(); });
  elements.fieldBoardAdminList.addEventListener("click", event => {
    const button = event.target.closest('button[data-action="delete-field"]');
    if (button) deleteFieldStatus(button.dataset.venueId, button.dataset.fieldId);
  });
  elements.clearFieldBoardBtn.addEventListener("click", clearFieldBoard);

  elements.aiUpdateForm.addEventListener("submit", event => { event.preventDefault(); generateAiUpdate(); });
  elements.aiApplyVenueBtn.addEventListener("click", applyAiToVenue);
  elements.aiApplyGlobalBtn.addEventListener("click", applyAiGlobal);

  elements.timelineForm.addEventListener("submit", event => { event.preventDefault(); addTimelineEntry(); });
  elements.clearHistoryBtn.addEventListener("click", clearPublicHistory);
  elements.incidentForm.addEventListener("submit", event => { event.preventDefault(); addIncident(); });
  elements.clearIncidentsBtn.addEventListener("click", clearIncidents);
}

function installImageFallbacks() {
  document.querySelectorAll("img[data-fallback]").forEach(img => {
    const showFallback = () => {
      if (img.dataset.fallbackShown === "true") return;
      img.dataset.fallbackShown = "true";
      img.classList.add("image-load-failed");
      const fallback = document.createElement("span");
      fallback.className = img.classList.contains("footer-logo") ? "image-fallback footer-image-fallback" : "image-fallback";
      fallback.textContent = img.dataset.fallback || img.alt || "Image";
      fallback.setAttribute("role", "img");
      fallback.setAttribute("aria-label", img.alt || fallback.textContent);
      img.insertAdjacentElement("afterend", fallback);
    };

    img.addEventListener("error", showFallback, { once: true });

    if (img.complete && img.naturalWidth === 0) {
      showFallback();
    }
  });
}

function addStyleSupport() {
  // Styling is kept in style.css. This function exists only as an initialization marker.
}

function startLightningUiClock() {
  clearInterval(lightningUiTimer);
  lightningUiTimer = setInterval(() => {
    renderPublicLightning();
    if (loggedInAdmin) renderAdminLightning();
  }, 1000);
}

function initialize() {
  addStyleSupport();
  installImageFallbacks();
  bindEvents();
  initFirebase();
  renderPublic();
  refreshPublicData();
  startLightningUiClock();
}

initialize();
