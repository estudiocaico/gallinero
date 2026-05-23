const STORAGE_KEY = "gallinero-control-v1";
const FLOCKS = ["Gallinas", "Pigmeas"];
const initialState = {
  hens: 183,
  flocks: {
    Gallinas: 183,
    Pigmeas: 0,
  },
  daily: [],
  stock: [],
  health: [],
  flockEvents: [],
};

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

const $ = (selector) => document.querySelector(selector);
const today = () => new Date().toISOString().slice(0, 10);
const number = (value) => Number(value || 0);
const monthKey = (year, month) => `${year}-${String(month + 1).padStart(2, "0")}`;

let state = loadState();
let selectedMonth = new Date().getMonth();
let selectedYear = new Date().getFullYear();
let selectedDailyFlock = "Gallinas";
let activeEntryTab = "production";
let activeHistoryTab = "production";
let activeIncomeMode = "eggs";
let selectedHistoryDate = "";
let activeFlockSubtab = "plantel";
let previewSelection = null;
let editingEntryId = null;
let lowStockAlertShown = false;
let supabaseClient = null;
let isApplyingRemoteState = false;
let lastSyncedState = structuredClone(state);
let hasSyncedOnce = false;
let isSyncingToSupabase = false;
let pendingSupabaseSync = false;

function uid() {
  return `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ── Income entries are independent records ─────────────────────────────────
function isIncomeEntry(entry) {
  return entry.entryType === "income";
}

function getIncomeEntries(date, flock) {
  return state.daily.filter(
    (e) => e.date === date && flockOf(e) === flock && isIncomeEntry(e),
  );
}
// ──────────────────────────────────────────────────────────────────────────

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(initialState);
  try {
    return migrateState(JSON.parse(saved));
  } catch {
    return structuredClone(initialState);
  }
}

function migrateState(saved) {
  const next = { ...structuredClone(initialState), ...saved };
  next.flocks = {
    ...structuredClone(initialState.flocks),
    ...(saved.flocks || {}),
  };
  if (!saved.flocks && typeof saved.hens === "number") {
    next.flocks.Gallinas = saved.hens;
  }
  next.daily = (saved.daily || []).map((entry) => {
    // Keep income entries as-is
    if (entry.entryType === "income") {
      return {
        id: entry.id || uid(),
        date: entry.date,
        flock: entry.flock || "Gallinas",
        entryType: "income",
        incomeKind: entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs"),
        eggCrates: number(entry.eggCrates),
        eggCratePrice: number(entry.eggCratePrice),
        soldBirds: number(entry.soldBirds),
        birdPrice: number(entry.birdPrice),
        incomeEggs: number(entry.incomeEggs),
        incomeBirds: number(entry.incomeBirds),
        incomeNotes: entry.incomeNotes || "",
        updatedSections: { income: true },
      };
    }
    const updatedSections = entry.updatedSections || {
      production: true,
      consumption: true,
      income: true,
      expense: true,
    };
    if (updatedSections.finance) {
      updatedSections.income = true;
      updatedSections.expense = true;
    }
    return {
      id: entry.id || uid(),
      entryType: entry.entryType || "",
      incomeKind: entry.incomeKind || (number(entry.soldBirds) ? "birds" : number(entry.eggCrates) ? "eggs" : ""),
      flock: entry.flock || "Gallinas",
      eggCrates: number(entry.eggCrates),
      eggCratePrice: number(entry.eggCratePrice),
      soldBirds: number(entry.soldBirds),
      birdPrice: number(entry.birdPrice),
      incomeEggs: number(entry.incomeEggs ?? entry.income),
      incomeBirds: number(entry.incomeBirds),
      productionNotes: entry.productionNotes ?? entry.notes ?? "",
      consumptionNotes: entry.consumptionNotes ?? "",
      incomeNotes: entry.incomeNotes ?? entry.financeNotes ?? "",
      expenseNotes: entry.expenseNotes ?? entry.financeNotes ?? "",
      ...entry,
      updatedSections,
    };
  });
  next.stock = (saved.stock || []).map((item) => ({
    ...item,
    kg: number(item.kg),
    costPerKg: number(item.costPerKg ?? (number(item.kg) ? number(item.cost) / number(item.kg) : 0)),
    cost: number(item.cost),
  }));
  next.health = saved.health || [];
  next.flockEvents = saved.flockEvents || [];
  next.hens = next.flocks.Gallinas;
  return next;
}

function saveState(message = "Guardado") {
  state.hens = state.flocks.Gallinas;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
  showToast(message);
  syncStateToSupabase();
}

function supabaseSettings() {
  return window.GALLINERO_SUPABASE || {};
}

function isSupabaseConfigured() {
  const settings = supabaseSettings();
  return Boolean(settings.url && settings.anonKey && settings.rowId && window.supabase);
}

function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!supabaseClient) {
    const settings = supabaseSettings();
    supabaseClient = window.supabase.createClient(settings.url, settings.anonKey);
  }
  return supabaseClient;
}

function sameStatePart(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function syncEntryKey(entry) {
  return isIncomeEntry(entry) ? `income:${entry.id}` : `main:${entry.date}:${flockOf(entry)}`;
}

function mergeNumberDelta(baseEntry, remoteEntry, localEntry, field) {
  return number(baseEntry?.[field]) + (number(remoteEntry?.[field]) - number(baseEntry?.[field])) + (number(localEntry?.[field]) - number(baseEntry?.[field]));
}

function mergeMainEntry(baseEntry = {}, remoteEntry = {}, localEntry = {}) {
  // Merge: local always overwrites remote for fields the local changed.
  // If only remote changed a field (e.g., another device), keep remote value.
  // Never sum numeric fields — always use replacement semantics.
  const merged = { ...remoteEntry };
  ["morningEggs", "afternoonEggs", "lostEggs", "cornKg", "feedKg", "waterLiters", "dailyCost"].forEach((field) => {
    const remoteChanged = number(remoteEntry[field]) !== number(baseEntry[field]);
    const localChanged = number(localEntry[field]) !== number(baseEntry[field]);
    if (localChanged || remoteChanged) {
      // Prefer local value when local changed; otherwise keep remote
      merged[field] = localChanged ? number(localEntry[field]) : number(remoteEntry[field]);
    }
  });
  merged.updatedSections = {
    ...(remoteEntry.updatedSections || {}),
    ...(localEntry.updatedSections || {}),
  };
  ["productionNotes", "consumptionNotes", "expenseNotes"].forEach((field) => {
    const remoteNote = remoteEntry[field] || "";
    const localNote = localEntry[field] || "";
    const baseNote = baseEntry[field] || "";
    if (localNote !== baseNote) {
      merged[field] = localNote;
    } else if (remoteNote !== baseNote) {
      merged[field] = remoteNote;
    }
  });
  return merged;
}

function mergeUniqueArray(remoteItems = [], localItems = []) {
  const map = new Map();
  [...remoteItems, ...localItems].forEach((item) => {
    const key = item.id || JSON.stringify(item);
    map.set(key, item);
  });
  return [...map.values()];
}

async function syncDailyDeltaToSupabase(delta) {
  const client = getSupabaseClient();
  if (!client) return false;
  const { data, error } = await client.rpc("gallinero_add_daily_delta", {
    p_row_id: supabaseSettings().rowId,
    p_date: delta.date,
    p_flock: delta.flock,
    p_tab: delta.tab,
    p_delta: delta.values,
    p_notes: delta.notes,
  });
  if (error || !data) return false;
  isApplyingRemoteState = true;
  state = migrateState(data);
  lastSyncedState = structuredClone(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
  isApplyingRemoteState = false;
  hasSyncedOnce = true;
  return true;
}

function mergeStateForSync(remoteRaw, localRaw, baseRaw) {
  const remote = migrateState(remoteRaw || structuredClone(initialState));
  const local = migrateState(localRaw || structuredClone(initialState));
  const base = migrateState(baseRaw || structuredClone(initialState));
  const merged = structuredClone(remote);
  const remoteEntries = new Map(remote.daily.map((entry) => [syncEntryKey(entry), entry]));
  const baseEntries = new Map(base.daily.map((entry) => [syncEntryKey(entry), entry]));
  const localEntries = new Map(local.daily.map((entry) => [syncEntryKey(entry), entry]));

  local.daily.forEach((localEntry) => {
    const key = syncEntryKey(localEntry);
    const baseEntry = baseEntries.get(key);
    const remoteEntry = remoteEntries.get(key);
    const localChanged = !sameStatePart(localEntry, baseEntry);
    if (!localChanged) return;
    if (!remoteEntry || isIncomeEntry(localEntry)) {
      remoteEntries.set(key, localEntry);
      return;
    }
    if (!baseEntry) {
      remoteEntries.set(key, mergeMainEntry(emptyEntry(localEntry.date, flockOf(localEntry)), remoteEntry, localEntry));
      return;
    }
    const remoteChanged = !sameStatePart(remoteEntry, baseEntry);
    remoteEntries.set(key, remoteChanged ? mergeMainEntry(baseEntry, remoteEntry, localEntry) : localEntry);
  });

  remote.daily.forEach((remoteEntry) => {
    const key = syncEntryKey(remoteEntry);
    if (localEntries.has(key)) return;
    const baseEntry = baseEntries.get(key);
    if (baseEntry) {
      // Entry was in base AND in remote but local deleted it → trust the deletion, don't re-add
      return;
    }
    // Entry is new on remote (wasn't in base at all) → add it locally
    remoteEntries.set(key, remoteEntry);
  });

  merged.daily = [...remoteEntries.values()];
  merged.stock = mergeUniqueArray(remote.stock, local.stock);
  merged.health = mergeUniqueArray(remote.health, local.health);
  merged.flockEvents = mergeUniqueArray(remote.flockEvents, local.flockEvents);
  merged.flocks = { ...remote.flocks, ...local.flocks };
  merged.hens = merged.flocks.Gallinas;
  return migrateState(merged);
}

async function loadStateFromSupabase() {
  const client = getSupabaseClient();
  if (!client) return;
  const { data, error } = await client
    .from("gallinero_state")
    .select("data, updated_at")
    .eq("id", supabaseSettings().rowId)
    .maybeSingle();
  if (error) {
    showToast("No se pudo sincronizar");
    return;
  }
  if (!data?.data) {
    await syncStateToSupabase({ silent: true });
    return;
  }
  isApplyingRemoteState = true;
  const localSnapshot = structuredClone(state);
  state = mergeStateForSync(data.data, localSnapshot, lastSyncedState);
  const shouldUploadMergedState = !sameStatePart(state, data.data);
  lastSyncedState = structuredClone(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
  isApplyingRemoteState = false;
  hasSyncedOnce = true;
  if (shouldUploadMergedState) await syncStateToSupabase({ silent: true });
  showToast("Datos sincronizados");
}

async function syncStateToSupabase(options = {}) {
  if (isApplyingRemoteState) return;
  const client = getSupabaseClient();
  if (!client) return;
  if (isSyncingToSupabase) {
    pendingSupabaseSync = true;
    return;
  }
  isSyncingToSupabase = true;
  let error = null;
  const localSnapshot = structuredClone(state);
  let desiredState = structuredClone(localSnapshot);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data: remoteRow, error: readError } = await client
        .from("gallinero_state")
        .select("data, updated_at")
        .eq("id", supabaseSettings().rowId)
        .maybeSingle();
      if (readError) {
        error = readError;
        break;
      }

      if (remoteRow?.data) {
        desiredState = mergeStateForSync(remoteRow.data, localSnapshot, lastSyncedState);
      } else {
        desiredState = structuredClone(localSnapshot);
      }

      const nextUpdatedAt = new Date().toISOString();
      if (!remoteRow) {
        const { error: insertError } = await client.from("gallinero_state").insert({
          id: supabaseSettings().rowId,
          data: desiredState,
          updated_at: nextUpdatedAt,
        });
        if (!insertError) {
          error = null;
          break;
        }
        error = insertError;
        continue;
      }

      const { data: updatedRow, error: updateError } = await client
        .from("gallinero_state")
        .update({
          data: desiredState,
          updated_at: nextUpdatedAt,
        })
        .eq("id", supabaseSettings().rowId)
        .eq("updated_at", remoteRow.updated_at)
        .select("updated_at")
        .maybeSingle();
      if (!updateError && updatedRow) {
        error = null;
        break;
      }
      error = updateError || new Error("La nube cambio durante el guardado");
    }

    if (!error) {
      state = migrateState(desiredState);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
      lastSyncedState = structuredClone(state);
      hasSyncedOnce = true;
    }
  } finally {
    isSyncingToSupabase = false;
  }
  if (error && !options.silent) showToast("Guardado local, sin sincronizar");
  if (pendingSupabaseSync) {
    pendingSupabaseSync = false;
    syncStateToSupabase({ silent: options.silent });
  }
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function flockOf(entry) {
  return entry.flock || "Gallinas";
}

function totalEggs(entry) {
  return number(entry.morningEggs) + number(entry.afternoonEggs);
}

function feedTotal(entry) {
  return number(entry.cornKg) + number(entry.feedKg);
}

function entryIncome(entry) {
  if (entry?.incomeKind === "eggs") return number(entry.incomeEggs ?? entry.income);
  if (entry?.incomeKind === "birds") return number(entry.incomeBirds);
  return number(entry.incomeEggs ?? entry.income) + number(entry.incomeBirds);
}

function calculateEggIncome(entry) {
  if (entry?.incomeKind === "birds") return 0;
  if (entry && (number(entry.eggCrates) || number(entry.eggCratePrice))) {
    return number(entry.eggCrates) * number(entry.eggCratePrice);
  }
  return number(entry?.incomeEggs ?? entry?.income);
}

function calculateBirdIncome(entry) {
  if (entry?.incomeKind === "eggs") return 0;
  if (entry && (number(entry.soldBirds) || number(entry.birdPrice))) {
    return number(entry.soldBirds) * number(entry.birdPrice);
  }
  return number(entry?.incomeBirds);
}

function money(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(number(value));
}

function parseMoney(value) {
  if (typeof value === "number") return value;
  return Number(String(value || "").replace(/[^\d,-]/g, "").replace(",", ".")) || 0;
}

function formatMoneyInput(input) {
  input.value = money(parseMoney(input.value));
}

function compactMeasure(value, unit, decimals = 1) {
  const parsed = number(value);
  const display = Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(decimals);
  return `${display} ${unit}`;
}

function sortedDaily() {
  return [...state.daily].sort((a, b) => b.date.localeCompare(a.date) || flockOf(a).localeCompare(flockOf(b)));
}

function getEntryById(id) {
  return state.daily.find((entry) => entry.id === id);
}

function getEntry(date, flock = selectedDailyFlock) {
  return state.daily.find((entry) => entry.date === date && flockOf(entry) === flock && !entry.entryType);
}

function upsertDaily(entry) {
  let index = -1;
  if (isIncomeEntry(entry)) {
    // Income entries are individual records — find strictly by ID
    index = entry.id ? state.daily.findIndex((item) => item.id === entry.id) : -1;
  } else {
    // Main entries: one per date+flock. First try by ID, then fall back to date+flock
    // to avoid duplicates when IDs differ (e.g. between devices or after migration)
    if (entry.id) {
      index = state.daily.findIndex((item) => item.id === entry.id);
    }
    if (index < 0) {
      index = state.daily.findIndex((item) => !isIncomeEntry(item) && item.date === entry.date && flockOf(item) === entry.flock);
    }
  }
  if (index >= 0) state.daily[index] = entry;
  else state.daily.push(entry);
}

function isInSelectedMonth(item) {
  return item.date?.startsWith(monthKey(selectedYear, selectedMonth));
}

function selectedDaily(flock) {
  return sortedDaily().filter((entry) => isInSelectedMonth(entry) && (!flock || flockOf(entry) === flock));
}

function selectedStock() {
  return state.stock.filter(isInSelectedMonth);
}

function selectedHealth() {
  return state.health.filter(isInSelectedMonth);
}

function selectedFlockEvents(flock) {
  return state.flockEvents.filter((event) => isInSelectedMonth(event) && (!flock || event.flock === flock));
}

function setSegmentGroup(containerId, flock) {
  document.querySelectorAll(`#${containerId} .segment`).forEach((button) => {
    button.classList.toggle("active", button.dataset.flock === flock);
  });
}

function setEntryTab(tabName) {
  activeEntryTab = tabName;
  document.querySelectorAll("#entryTypeTabs .movement-type").forEach((button) => {
    button.classList.toggle("active", button.dataset.entryTab === tabName);
  });
  document.querySelectorAll("[data-entry-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.entryPanel === tabName);
  });
  const labels = {
    production: "Guardar producción",
    consumption: "Guardar consumo",
    income: "Agregar ingreso",
    expense: "Guardar gasto",
  };
  $("#saveEntryBtn").textContent = labels[tabName];
  if (tabName === "income") {
    setIncomeMode(activeIncomeMode);
    renderCurrentIncomeEntries();
  }
}

function setIncomeMode(mode) {
  activeIncomeMode = mode === "birds" ? "birds" : "eggs";
  document.querySelectorAll("#incomeModeTabs .income-mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.incomeMode === activeIncomeMode);
  });
  document.querySelectorAll("[data-income-fields]").forEach((field) => {
    field.classList.toggle("income-field-hidden", field.dataset.incomeFields !== activeIncomeMode);
  });
  // Show/hide the matching preview line
  const eggLine = document.getElementById("eggIncomeLine");
  const birdLine = document.getElementById("birdIncomeLine");
  if (eggLine) eggLine.hidden = activeIncomeMode !== "eggs";
  if (birdLine) birdLine.hidden = activeIncomeMode !== "birds";
}

function setHistoryTab(tabName) {
  activeHistoryTab = tabName;
  document.querySelectorAll("#historyTypeTabs .history-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.historyTab === tabName);
  });
  renderHistory();
}

function setHistoryDateFilter(date) {
  selectedHistoryDate = date;
  const input = document.getElementById("historyDateFilter");
  if (input) input.value = date;
  renderHistory();
}

function setFlockSubtab(tabName) {
  activeFlockSubtab = tabName;
  document.querySelectorAll("#flockSubtabs .flock-subtab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.flockTab === tabName);
  });
  document.querySelectorAll(".flock-subpanel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `flockSubPanel${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`);
  });
}

// ── Income form helpers ────────────────────────────────────────────────────
function clearIncomeFormFields() {
  $("#eggCrates").value = "";
  $("#eggCratePrice").value = "";
  $("#soldBirds").value = "";
  $("#birdPrice").value = "";
  $("#incomeNotes").value = "";
  renderIncomePreview({ eggCrates: 0, eggCratePrice: 0, soldBirds: 0, birdPrice: 0 });
}

function setIncomeBtnLabel() {
  const isEditing = editingEntryId && isIncomeEntry(getEntryById(editingEntryId));
  $("#saveEntryBtn").textContent = isEditing ? "Actualizar ingreso" : "Agregar ingreso";
  const cancelBtn = $("#cancelIncomeEditBtn");
  if (cancelBtn) cancelBtn.hidden = !isEditing;
}

function renderCurrentIncomeEntries() {
  const container = $("#currentIncomeEntries");
  if (!container) return;
  const date = $("#date").value;
  const entries = getIncomeEntries(date, selectedDailyFlock).filter(
    (e) => !editingEntryId || e.id !== editingEntryId,
  );
  if (!entries.length) {
    container.innerHTML = "";
    return;
  }
  const totalDay = entries.reduce((sum, e) => sum + entryIncome(e), 0);
  container.innerHTML = `
    <div class="income-entries-list">
      <p class="income-entries-label">Ingresos cargados para este día</p>
      ${entries
        .map((e) => {
          const kind = e.incomeKind || (number(e.soldBirds) ? "birds" : "eggs");
          const icon = kind === "eggs" ? "maple.png" : "gallina.png";
          const label =
            kind === "eggs"
              ? `${number(e.eggCrates)} maple${number(e.eggCrates) !== 1 ? "s" : ""} · ${money(e.eggCratePrice)} c/u`
              : `${number(e.soldBirds)} gallina${number(e.soldBirds) !== 1 ? "s" : ""} · ${money(e.birdPrice)} c/u`;
          return `
          <div class="income-entry-row">
            <span class="income-entry-icon"><img src="${icon}" alt="" /></span>
            <div class="income-entry-info">
              <strong>${label}</strong>
              <span>${money(entryIncome(e))}${e.incomeNotes ? ` · ${e.incomeNotes}` : ""}</span>
            </div>
            <div class="income-entry-actions">
              <button class="income-entry-edit icon-button" data-income-id="${e.id}" type="button" aria-label="Editar">
                <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="income-entry-delete icon-button danger-icon" data-income-id="${e.id}" type="button" aria-label="Eliminar">
                <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M8 6V4h8v2"/></svg>
              </button>
            </div>
          </div>`;
        })
        .join("")}
      <div class="income-entries-total">
        <span>Total del día</span>
        <strong>${money(totalDay)}</strong>
      </div>
    </div>`;
}
// ──────────────────────────────────────────────────────────────────────────

function fillDailyForm(entry) {
  const inputValue = (value) => (number(value) ? value : "");
  const moneyValue = (value) => (number(value) ? money(value) : "");
  const nextFlock = entry?.flock || selectedDailyFlock || "Gallinas";
  selectedDailyFlock = nextFlock;
  setSegmentGroup("dailyFlockButtons", nextFlock);
  $("#date").value = entry?.date || today();
  $("#morningEggs").value = inputValue(entry?.morningEggs);
  $("#afternoonEggs").value = inputValue(entry?.afternoonEggs);
  $("#lostEggs").value = inputValue(entry?.lostEggs);
  $("#productionNotes").value = entry?.productionNotes ?? entry?.notes ?? "";
  $("#cornKg").value = inputValue(entry?.cornKg);
  $("#feedKg").value = inputValue(entry?.feedKg);
  $("#waterLiters").value = inputValue(entry?.waterLiters);
  $("#consumptionNotes").value = entry?.consumptionNotes || "";
  // Income is handled separately as independent entries
  clearIncomeFormFields();
  $("#dailyCost").value = moneyValue(entry?.dailyCost);
  $("#expenseNotes").value = entry?.expenseNotes ?? entry?.financeNotes ?? "";
  if (activeEntryTab === "income") renderCurrentIncomeEntries();
}

function resetDailyFormForNextEntry() {
  const flock = selectedDailyFlock;
  const date = today();
  editingEntryId = null;
  fillDailyForm({ date, flock });
  setIncomeMode("eggs");
  setIncomeBtnLabel();
  renderCurrentIncomeEntries();
}

function currentIncomeDraft() {
  return {
    incomeKind: activeIncomeMode,
    eggCrates: number($("#eggCrates").value),
    eggCratePrice: parseMoney($("#eggCratePrice").value),
    soldBirds: number($("#soldBirds").value),
    birdPrice: parseMoney($("#birdPrice").value),
  };
}

function renderIncomePreview(entry = currentIncomeDraft()) {
  const eggIncome = calculateEggIncome(entry);
  const birdIncome = calculateBirdIncome(entry);
  $("#eggIncomePreview").textContent = money(eggIncome);
  $("#birdIncomePreview").textContent = money(birdIncome);
  $("#totalIncomePreview").textContent = money(eggIncome + birdIncome);
}

function populateMonthControls() {
  $("#monthSelect").innerHTML = MONTHS.map((month, index) => `<option value="${index}">${month}</option>`).join("");
  $("#monthSelect").value = selectedMonth;

  const currentYear = new Date().getFullYear();
  const years = new Set([selectedYear, currentYear, currentYear - 1]);
  state.daily.forEach((entry) => years.add(Number(entry.date.slice(0, 4))));
  state.stock.forEach((entry) => years.add(Number(entry.date.slice(0, 4))));
  state.health.forEach((entry) => years.add(Number(entry.date.slice(0, 4))));
  const sortedYears = [...years].filter(Boolean).sort((a, b) => b - a);
  $("#yearSelect").innerHTML = sortedYears.map((year) => `<option value="${year}">${year}</option>`).join("");
  $("#yearSelect").value = selectedYear;
}

function totalsForFlock(flock) {
  const daily = selectedDaily(flock);
  // Separate main entries (production/consumption/expense) from independent income entries
  const mainEntries = daily.filter((e) => !isIncomeEntry(e));
  const incomeEntries = daily.filter((e) => isIncomeEntry(e));

  const eggs = mainEntries.reduce((sum, entry) => sum + totalEggs(entry), 0);
  const food = mainEntries.reduce((sum, entry) => sum + feedTotal(entry), 0);
  const water = mainEntries.reduce((sum, entry) => sum + number(entry.waterLiters), 0);
  const deaths =
    mainEntries.reduce((sum, entry) => sum + number(entry.deaths), 0) +
    selectedFlockEvents(flock)
      .filter((event) => event.action === "Baja")
      .reduce((sum, event) => sum + number(event.quantity), 0);
  // Income = independent income entries + backward-compat embedded income in main entries
  const income =
    incomeEntries.reduce((sum, entry) => sum + entryIncome(entry), 0) +
    mainEntries.reduce((sum, entry) => sum + entryIncome(entry), 0);
  const costs = mainEntries.reduce((sum, entry) => sum + number(entry.dailyCost), 0);
  const current = number(state.flocks?.[flock]);
  const daysWithData = mainEntries.length;
  const averageCount = daysWithData
    ? mainEntries.reduce((sum, entry) => sum + number(entry.hensAfter ?? current), 0) / daysWithData
    : current;
  const layRate = averageCount && daysWithData ? Math.round((eggs / (averageCount * daysWithData)) * 100) : 0;
  return { daily, eggs, food, water, deaths, income, costs, result: income - costs, layRate, current };
}

function monthlyTotals() {
  const byFlock = Object.fromEntries(FLOCKS.map((flock) => [flock, totalsForFlock(flock)]));
  const stockCosts = selectedStock().reduce((sum, item) => sum + number(item.cost), 0);
  const healthCosts = selectedHealth().reduce((sum, item) => sum + number(item.cost), 0);
  byFlock.Gallinas.costs += stockCosts + healthCosts;
  byFlock.Gallinas.result = byFlock.Gallinas.income - byFlock.Gallinas.costs;
  return byFlock;
}

function renderSplit(id, gallinas, pigmeas) {
  $(`#${id}`).innerHTML = `
    <div>
      <small>Gallinas</small>
      <strong>${gallinas}</strong>
    </div>
    <div>
      <small>Pigmeas</small>
      <strong>${pigmeas}</strong>
    </div>
  `;
}

function entryIcon(entry) {
  if (isIncomeEntry(entry)) {
    return entry.incomeKind === "birds" ? "gallina.png" : "maple.png";
  }
  if (totalEggs(entry)) return "huevos.png";
  if (feedTotal(entry)) return "maiz.png";
  if (number(entry.dailyCost)) return "factura.png";
  return "huevos.png";
}

function renderDashboard() {
  const totals = monthlyTotals();
  renderSplit("dashEggs", totals.Gallinas.eggs, totals.Pigmeas.eggs);
  renderSplit("dashFood", compactMeasure(totals.Gallinas.food, "kg"), compactMeasure(totals.Pigmeas.food, "kg"));
  renderSplit("dashIncome", money(totals.Gallinas.income), money(totals.Pigmeas.income));
  renderSplit("dashCosts", money(totals.Gallinas.costs), money(totals.Pigmeas.costs));
  renderSplit("dashResult", money(totals.Gallinas.result), money(totals.Pigmeas.result));
  renderSplit("dashWater", compactMeasure(totals.Gallinas.water, "L"), compactMeasure(totals.Pigmeas.water, "L"));
  renderSplit("dashLayRate", `${totals.Gallinas.layRate}%`, `${totals.Pigmeas.layRate}%`);
  renderSplit("dashHens", totals.Gallinas.current, totals.Pigmeas.current);
  renderSplit("dashDeaths", totals.Gallinas.deaths, totals.Pigmeas.deaths);

  const recent = sortedDaily().filter(isInSelectedMonth).slice(0, 6);
  $("#recentEntries").innerHTML =
    recent
      .map((entry) => {
        const icon = entryIcon(entry);
        let title, detail, value;
        if (isIncomeEntry(entry)) {
          const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
          title = kind === "eggs"
            ? `${number(entry.eggCrates)} maples · ${flockOf(entry)}`
            : `${number(entry.soldBirds)} gallinas · ${flockOf(entry)}`;
          detail = entry.incomeNotes || "Venta";
          value = money(entryIncome(entry));
        } else {
          title = `${entry.date} · ${flockOf(entry)}`;
          detail = `${number(entry.cornKg).toFixed(2)} kg maíz · ${number(entry.feedKg).toFixed(2)} kg bal. · ${number(entry.waterLiters).toFixed(1)} L`;
          value = `${totalEggs(entry)} huevos`;
        }
        return `
          <article class="recent-item" data-id="${entry.id}" data-date="${entry.date}" data-flock="${flockOf(entry)}">
            <span class="recent-icon"><img src="${icon}" alt="" /></span>
            <div>
              <strong>${title}</strong>
              <span>${detail}</span>
            </div>
            <span class="recent-value">${value}</span>
          </article>`;
      })
      .join("") || `<div class="empty-state">Todavía no hay entradas cargadas para ${MONTHS[selectedMonth]} ${selectedYear}.</div>`;
}

function renderHistory() {
  const flockTag = (entry) => `<b class="history-flock">${flockOf(entry)}</b>`;
  const historyConfig = {
    production: {
      icon: '<img src="huevos.png" alt="" />',
      title: (entry) => `${totalEggs(entry)} huevos`,
      detail: (entry) => `${number(entry.morningEggs)} mañana · ${number(entry.afternoonEggs)} tarde · ${flockTag(entry)}`,
      amount: (entry) => `${number(entry.lostEggs)} perdidos`,
      date: (entry) => entry.date,
      tone: "",
    },
    consumption: {
      icon: '<img src="maiz.png" alt="" />',
      title: (entry) => `${feedTotal(entry).toFixed(2)} kg alimento`,
      detail: (entry) => `${number(entry.cornKg).toFixed(2)} kg maíz · ${number(entry.feedKg).toFixed(2)} kg bal. · ${flockTag(entry)}`,
      amount: (entry) => `${number(entry.waterLiters).toFixed(1)} L`,
      date: (entry) => entry.date,
      tone: "",
    },
    income: {
      icon: (entry) => {
        const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
        return kind === "birds" ? '<img src="gallina.png" alt="" />' : '<img src="maple.png" alt="" />';
      },
      title: (entry) => {
        const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
        if (kind === "birds") return `${number(entry.soldBirds)} gallinas`;
        return `${number(entry.eggCrates)} maples`;
      },
      detail: (entry) => {
        const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
        if (kind === "birds") return `${flockTag(entry)} · ${money(entry.birdPrice)} por gallina`;
        return `${flockTag(entry)} · ${money(entry.eggCratePrice)} por maple`;
      },
      amount: (entry) => `+${money(entryIncome(entry))}`,
      date: (entry) => entry.date,
      tone: "positive",
    },
    expense: {
      icon: '<img src="factura.png" alt="" />',
      title: () => "Gasto",
      detail: (entry) => flockTag(entry),
      amount: (entry) => `-${money(entry.dailyCost)}`,
      date: (entry) => entry.date,
      tone: "negative",
    },
  };
  const config = historyConfig[activeHistoryTab];

  // Render date filter control
  const filterEl = document.getElementById("historyDateFilter");
  if (filterEl) filterEl.value = selectedHistoryDate;

  // Filter by month and optionally by a specific day
  const rows = sortedDaily()
    .filter((entry) => {
      if (selectedHistoryDate) return entry.date === selectedHistoryDate;
      return isInSelectedMonth(entry);
    })
    .filter((entry) => {
      if (activeHistoryTab === "income") {
        if (isIncomeEntry(entry)) return sectionHasData(entry, "income");
        return entry.updatedSections?.income && sectionHasData(entry, "income");
      }
      return !isIncomeEntry(entry) && entry.updatedSections?.[activeHistoryTab] && sectionHasData(entry, activeHistoryTab);
    })
    .map(
      (entry) => `
        <article class="history-item" data-id="${entry.id}" data-date="${entry.date}" data-flock="${flockOf(entry)}" data-entry-tab="${activeHistoryTab}">
          <span class="history-icon">${typeof config.icon === "function" ? config.icon(entry) : config.icon}</span>
          <div class="history-main">
            <strong>${config.title(entry)}</strong>
            <span>${config.detail(entry)}</span>
          </div>
          <div class="history-side ${config.tone}">
            <strong>${config.amount(entry)}</strong>
            <span>${config.date(entry)}</span>
          </div>
        </article>`,
    )
    .join("");
  $("#historyRows").innerHTML = rows || `<div class="empty-state">Todavía no hay movimientos en esta pestaña.</div>`;
}

function normalizeFeedType(type) {
  return type === "Maíz" ? "Maiz" : type;
}

function stockAvailable(type) {
  const bought = state.stock
    .filter((item) => normalizeFeedType(item.type) === type)
    .reduce((sum, item) => sum + number(item.kg), 0);
  const usedField = type === "Maiz" ? "cornKg" : "feedKg";
  const used = state.daily.filter((e) => !isIncomeEntry(e)).reduce((sum, item) => sum + number(item[usedField]), 0);
  return bought - used;
}

function renderStock() {
  $("#cornStock").innerHTML = `<small>Maíz</small><strong>${stockAvailable("Maiz").toFixed(2)} kg</strong>`;
  $("#feedStock").innerHTML = `<small>Balanceado</small><strong>${stockAvailable("Balanceado").toFixed(2)} kg</strong>`;
  const purchases = [...state.stock].sort((a, b) => b.date.localeCompare(a.date));
  $("#stockPurchases").innerHTML =
    purchases
      .map((item, index) => {
        const costPerKg = number(item.costPerKg ?? (number(item.kg) ? number(item.cost) / number(item.kg) : 0));
        return `
          <article class="stock-purchase-item" data-stock-index="${index}">
            <strong>${item.date} · ${normalizeFeedType(item.type)}</strong>
            <span>${number(item.kg).toFixed(2)} kg · ${money(costPerKg)} por kg · ${money(item.cost)} total</span>
            ${item.notes ? `<p>${item.notes}</p>` : ""}
          </article>`;
      })
      .join("") || "<p>Todavía no hay compras de alimento.</p>";
}

function renderStockTotalPreview() {
  $("#stockTotalPreview").textContent = money(number($("#stockKg").value) * parseMoney($("#stockCost").value));
}

function showLowStockAlert() {
  if (lowStockAlertShown) return;
  const low = [
    ["maíz", stockAvailable("Maiz")],
    ["balanceado", stockAvailable("Balanceado")],
  ].filter(([, kg]) => kg <= 50);
  if (!low.length) return;
  lowStockAlertShown = true;
  $("#stockAlertText").textContent = low
    .map(([type, kg]) => `Quedan ${Math.max(0, kg).toFixed(2)} kg de ${type}.`)
    .join(" ");
  $("#stockAlertModal").hidden = false;
}

function renderHealth() {
  const events = [...state.health].sort((a, b) => b.date.localeCompare(a.date));
  $("#healthList").innerHTML =
    events
      .map(
        (event) => `
          <article>
            <strong>${event.date} · ${event.type}</strong>
            <span>${number(event.affectedHens)} aves afectadas · ${money(event.cost)}</span>
            <p>${event.notes || "Sin detalle"}</p>
          </article>`,
      )
      .join("") || "<p>Todavía no hay eventos sanitarios.</p>";
}

function renderFlock() {
  $("#flockGallinas").innerHTML = `<small>Gallinas</small><strong>${number(state.flocks.Gallinas)}</strong>`;
  $("#flockPigmeas").innerHTML = `<small>Pigmeas</small><strong>${number(state.flocks.Pigmeas)}</strong>`;
  const events = [...state.flockEvents].sort((a, b) => b.date.localeCompare(a.date));
  $("#flockEvents").innerHTML =
    events
      .map(
        (event) => `
          <article>
            <strong>${event.date} · ${event.flock} · ${event.action}</strong>
            <span>${number(event.quantity)} aves · Plantel final: ${number(event.after)}</span>
            <p>${event.notes || "Sin detalle"}</p>
          </article>`,
      )
      .join("") || "<p>Todavía no hay movimientos de plantel.</p>";
}

function render() {
  populateMonthControls();
  renderDashboard();
  renderHistory();
  renderStock();
  renderHealth();
  renderFlock();
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ── Excel export (SpreadsheetML con estilos y colores) ────────────────────
function xmlEscape(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xlCell(value, styleId, type = "String") {
  const t = type === "Number" ? 'ss:Type="Number"' : 'ss:Type="String"';
  return `<Cell ss:StyleID="${styleId}"><Data ${t}>${xmlEscape(value)}</Data></Cell>`;
}

function xlRow(cells) {
  return `<Row>${cells.join("")}</Row>`;
}

function xlHeaderRow(labels, styleId = "Header") {
  return xlRow(labels.map((l) => xlCell(l, styleId)));
}

function xlSectionTitle(label, colSpan) {
  return `<Row><Cell ss:StyleID="SectionTitle" ss:MergeAcross="${colSpan - 1}"><Data ss:Type="String">${xmlEscape(label)}</Data></Cell></Row>`;
}

function xlEmptyRow() {
  return "<Row ss:AutoFitHeight='0' ss:Height='8'/>";
}

function exportExcel() {
  const mainEntries = [...state.daily]
    .filter((e) => !isIncomeEntry(e))
    .sort((a, b) => b.date.localeCompare(a.date));
  const incomeEntries = [...state.daily]
    .filter(isIncomeEntry)
    .sort((a, b) => b.date.localeCompare(a.date));

  // ── Styles ──
  const styles = `
  <Styles>
    <Style ss:ID="Default">
      <Alignment ss:Vertical="Center" ss:WrapText="1"/>
      <Font ss:FontName="Calibri" ss:Size="10"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
      </Borders>
    </Style>
    <Style ss:ID="Header">
      <Alignment ss:Vertical="Center" ss:Horizontal="Left" ss:WrapText="0"/>
      <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#16A34A" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#14783A"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
      </Borders>
    </Style>
    <Style ss:ID="SectionTitle">
      <Alignment ss:Vertical="Center" ss:Horizontal="Left"/>
      <Font ss:FontName="Calibri" ss:Size="12" ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#111827" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="DataEven">
      <Alignment ss:Vertical="Center" ss:WrapText="1"/>
      <Font ss:FontName="Calibri" ss:Size="10"/>
      <Interior ss:Color="#F0FDF4" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
      </Borders>
    </Style>
    <Style ss:ID="DataOdd">
      <Alignment ss:Vertical="Center" ss:WrapText="1"/>
      <Font ss:FontName="Calibri" ss:Size="10"/>
      <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
      </Borders>
    </Style>
    <Style ss:ID="NumEven">
      <Alignment ss:Vertical="Center" ss:Horizontal="Right"/>
      <Font ss:FontName="Calibri" ss:Size="10"/>
      <Interior ss:Color="#F0FDF4" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
      </Borders>
    </Style>
    <Style ss:ID="NumOdd">
      <Alignment ss:Vertical="Center" ss:Horizontal="Right"/>
      <Font ss:FontName="Calibri" ss:Size="10"/>
      <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="#,##0.00"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
      </Borders>
    </Style>
    <Style ss:ID="MoneyEven">
      <Alignment ss:Vertical="Center" ss:Horizontal="Right"/>
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#14783A"/>
      <Interior ss:Color="#F0FDF4" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="[$-C0A]#.##0"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1FAE5"/>
      </Borders>
    </Style>
    <Style ss:ID="MoneyOdd">
      <Alignment ss:Vertical="Center" ss:Horizontal="Right"/>
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#14783A"/>
      <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="[$-C0A]#.##0"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
      </Borders>
    </Style>
    <Style ss:ID="NegMoney">
      <Alignment ss:Vertical="Center" ss:Horizontal="Right"/>
      <Font ss:FontName="Calibri" ss:Size="10" ss:Color="#F97316" ss:Bold="1"/>
      <Interior ss:Color="#FFF7ED" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="[$-C0A]#.##0"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FED7AA"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FED7AA"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FED7AA"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FED7AA"/>
      </Borders>
    </Style>
    <Style ss:ID="TotalRow">
      <Alignment ss:Vertical="Center" ss:Horizontal="Right"/>
      <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#14783A"/>
      <Interior ss:Color="#DCFCE7" ss:Pattern="Solid"/>
      <NumberFormat ss:Format="[$-C0A]#.##0"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#14783A"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#14783A"/>
      </Borders>
    </Style>
    <Style ss:ID="TotalLabel">
      <Alignment ss:Vertical="Center" ss:Horizontal="Left"/>
      <Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#14783A"/>
      <Interior ss:Color="#DCFCE7" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#14783A"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#14783A"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#14783A"/>
      </Borders>
    </Style>
    <Style ss:ID="Notes">
      <Alignment ss:Vertical="Top" ss:WrapText="1" ss:Horizontal="Left"/>
      <Font ss:FontName="Calibri" ss:Size="9" ss:Color="#6B7280"/>
      <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
      <Borders>
        <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Left"   ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Right"  ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
        <Border ss:Position="Top"    ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E5E7EB"/>
      </Borders>
    </Style>
  </Styles>`;

  const ds = (i) => (i % 2 === 0 ? "DataEven" : "DataOdd");
  const ns = (i) => (i % 2 === 0 ? "NumEven" : "NumOdd");
  const ms = (i) => (i % 2 === 0 ? "MoneyEven" : "MoneyOdd");

  // ── Hoja 1: Producción diaria ──
  const prodHeaders = [
    "Fecha","Grupo","Huevos mañana","Huevos tarde","Total huevos",
    "Perdidos","Maíz (kg)","Balanceado (kg)","Agua (L)","Notas",
  ];
  const prodRows = mainEntries
    .filter((e) => e.updatedSections?.production)
    .map((e, i) =>
      xlRow([
        xlCell(e.date, ds(i)),
        xlCell(flockOf(e), ds(i)),
        xlCell(number(e.morningEggs), ns(i), "Number"),
        xlCell(number(e.afternoonEggs), ns(i), "Number"),
        xlCell(totalEggs(e), ns(i), "Number"),
        xlCell(number(e.lostEggs), ns(i), "Number"),
        xlCell(number(e.cornKg), ns(i), "Number"),
        xlCell(number(e.feedKg), ns(i), "Number"),
        xlCell(number(e.waterLiters), ns(i), "Number"),
        xlCell(e.productionNotes || "", "Notes"),
      ]),
    );
  const totalHuevos = mainEntries.reduce((s, e) => s + totalEggs(e), 0);
  const prodTotals = xlRow([
    xlCell("TOTAL", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell(totalHuevos, "TotalRow", "Number"),
    xlCell("", "TotalLabel"),
    xlCell(mainEntries.reduce((s, e) => s + number(e.cornKg), 0).toFixed(2), "TotalRow", "Number"),
    xlCell(mainEntries.reduce((s, e) => s + number(e.feedKg), 0).toFixed(2), "TotalRow", "Number"),
    xlCell(mainEntries.reduce((s, e) => s + number(e.waterLiters), 0).toFixed(1), "TotalRow", "Number"),
    xlCell("", "TotalLabel"),
  ]);

  // ── Hoja 2: Ingresos individuales ──
  const incHeaders = ["Fecha","Grupo","Tipo","Cantidad","Precio unitario","Total","Notas"];
  const incRows = incomeEntries.map((e, i) => {
    const kind = e.incomeKind || (number(e.soldBirds) ? "birds" : "eggs");
    const qty   = kind === "eggs" ? number(e.eggCrates)   : number(e.soldBirds);
    const price = kind === "eggs" ? number(e.eggCratePrice) : number(e.birdPrice);
    return xlRow([
      xlCell(e.date, ds(i)),
      xlCell(flockOf(e), ds(i)),
      xlCell(kind === "eggs" ? "Maples" : "Gallinas", ds(i)),
      xlCell(qty, ns(i), "Number"),
      xlCell(price, ms(i), "Number"),
      xlCell(entryIncome(e), ms(i), "Number"),
      xlCell(e.incomeNotes || "", "Notes"),
    ]);
  });
  const totalIngresos = incomeEntries.reduce((s, e) => s + entryIncome(e), 0)
    + mainEntries.reduce((s, e) => s + entryIncome(e), 0);
  const incTotals = xlRow([
    xlCell("TOTAL", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell(totalIngresos, "TotalRow", "Number"),
    xlCell("", "TotalLabel"),
  ]);

  // ── Hoja 3: Gastos ──
  const gasHeaders = ["Fecha","Grupo","Gastos","Notas"];
  const gasRows = mainEntries
    .filter((e) => e.updatedSections?.expense && number(e.dailyCost))
    .map((e, i) =>
      xlRow([
        xlCell(e.date, ds(i)),
        xlCell(flockOf(e), ds(i)),
        xlCell(number(e.dailyCost), "NegMoney", "Number"),
        xlCell(e.expenseNotes || "", "Notes"),
      ]),
    );
  const totalGastos = mainEntries.reduce((s, e) => s + number(e.dailyCost), 0)
    + state.stock.reduce((s, i) => s + number(i.cost), 0)
    + state.health.reduce((s, i) => s + number(i.cost), 0);
  const gasTotals = xlRow([
    xlCell("TOTAL", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell(totalGastos, "TotalRow", "Number"),
    xlCell("", "TotalLabel"),
  ]);

  // ── Hoja 4: Stock de alimento ──
  const stHeaders = ["Fecha","Tipo","Kilos","Costo por kg","Total","Disponible actual","Notas"];
  const stRows = [...state.stock]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((item, i) => {
      const cpk = number(item.costPerKg ?? (number(item.kg) ? number(item.cost) / number(item.kg) : 0));
      return xlRow([
        xlCell(item.date, ds(i)),
        xlCell(normalizeFeedType(item.type), ds(i)),
        xlCell(number(item.kg), ns(i), "Number"),
        xlCell(cpk, ms(i), "Number"),
        xlCell(number(item.cost), ms(i), "Number"),
        xlCell("", ds(i)),
        xlCell(item.notes || "", "Notes"),
      ]);
    });
  // Available stock summary rows
  const stockSummary = xlRow([
    xlCell("Maíz disponible", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell(stockAvailable("Maiz").toFixed(2), "TotalRow", "Number"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
  ]);
  const stockSummary2 = xlRow([
    xlCell("Balanceado disponible", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell(stockAvailable("Balanceado").toFixed(2), "TotalRow", "Number"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
    xlCell("", "TotalLabel"),
  ]);

  // ── Hoja 5: Plantel y Sanidad ──
  const plHeaders = ["Fecha","Grupo","Movimiento","Cantidad","Plantel antes","Plantel después","Notas"];
  const plRows = [...state.flockEvents]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((ev, i) =>
      xlRow([
        xlCell(ev.date, ds(i)),
        xlCell(ev.flock, ds(i)),
        xlCell(ev.action, ds(i)),
        xlCell(number(ev.quantity), ns(i), "Number"),
        xlCell(number(ev.before), ns(i), "Number"),
        xlCell(number(ev.after), ns(i), "Number"),
        xlCell(ev.notes || "", "Notes"),
      ]),
    );
  const saHeaders = ["Fecha","Tipo","Aves afectadas","Costo","Detalle"];
  const saRows = [...state.health]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((ev, i) =>
      xlRow([
        xlCell(ev.date, ds(i)),
        xlCell(ev.type, ds(i)),
        xlCell(number(ev.affectedHens), ns(i), "Number"),
        xlCell(number(ev.cost), "NegMoney", "Number"),
        xlCell(ev.notes || "", "Notes"),
      ]),
    );

  // ── Build workbook ──
  const wb = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:x="urn:schemas-microsoft-com:office:excel">
  <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel">
    <ActiveSheet>0</ActiveSheet>
  </ExcelWorkbook>
  ${styles}

  <Worksheet ss:Name="Producción">
    <Table ss:DefaultRowHeight="20">
      <Column ss:Width="80"/><Column ss:Width="70"/><Column ss:Width="80"/>
      <Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="60"/>
      <Column ss:Width="70"/><Column ss:Width="80"/><Column ss:Width="60"/>
      <Column ss:Width="180"/>
      ${xlSectionTitle("🥚 Producción diaria — Gallinero", 10)}
      ${xlHeaderRow(prodHeaders)}
      ${prodRows.join("\n")}
      ${prodTotals}
    </Table>
  </Worksheet>

  <Worksheet ss:Name="Ingresos">
    <Table ss:DefaultRowHeight="20">
      <Column ss:Width="80"/><Column ss:Width="70"/><Column ss:Width="70"/>
      <Column ss:Width="70"/><Column ss:Width="90"/><Column ss:Width="90"/>
      <Column ss:Width="200"/>
      ${xlSectionTitle("💰 Ingresos — Ventas de huevos y aves", 7)}
      ${xlHeaderRow(incHeaders)}
      ${incRows.join("\n")}
      ${incTotals}
    </Table>
  </Worksheet>

  <Worksheet ss:Name="Gastos">
    <Table ss:DefaultRowHeight="20">
      <Column ss:Width="80"/><Column ss:Width="70"/>
      <Column ss:Width="100"/><Column ss:Width="220"/>
      ${xlSectionTitle("📋 Gastos operativos", 4)}
      ${xlHeaderRow(gasHeaders)}
      ${gasRows.join("\n")}
      ${gasTotals}
    </Table>
  </Worksheet>

  <Worksheet ss:Name="Stock alimento">
    <Table ss:DefaultRowHeight="20">
      <Column ss:Width="80"/><Column ss:Width="80"/><Column ss:Width="70"/>
      <Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="90"/>
      <Column ss:Width="180"/>
      ${xlSectionTitle("🌽 Stock de alimento", 7)}
      ${xlHeaderRow(stHeaders)}
      ${stRows.join("\n")}
      ${xlEmptyRow()}
      ${stockSummary}
      ${stockSummary2}
    </Table>
  </Worksheet>

  <Worksheet ss:Name="Plantel y Sanidad">
    <Table ss:DefaultRowHeight="20">
      <Column ss:Width="80"/><Column ss:Width="70"/><Column ss:Width="90"/>
      <Column ss:Width="70"/><Column ss:Width="90"/><Column ss:Width="90"/>
      <Column ss:Width="180"/>
      ${xlSectionTitle("🐔 Movimientos de plantel", 7)}
      ${xlHeaderRow(plHeaders)}
      ${plRows.join("\n")}
      ${xlEmptyRow()}
      ${xlSectionTitle("🩺 Eventos sanitarios", 5)}
      ${xlHeaderRow(saHeaders)}
      ${saRows.join("\n")}
    </Table>
  </Worksheet>

</Workbook>`;

  downloadFile(`gallinero-${today()}.xls`, wb, "application/vnd.ms-excel");
  showToast("Excel exportado");
}
// ─────────────────────────────────────────────────────────────────────────

function backupJson() {
  downloadFile(`respaldo-gallinero-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
  showToast("Respaldo creado");
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === tabName));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === tabName));
  document.body.dataset.activeTab = tabName;
  if (location.hash !== `#${tabName}`) history.replaceState(null, "", `#${tabName}`);
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  window.setTimeout(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }), 0);
}

function updateFlockCount(flock, deaths) {
  if (deaths !== 0) state.flocks[flock] = Math.max(0, number(state.flocks[flock]) - deaths);
  state.hens = state.flocks.Gallinas;
}

function currentFormEntry() {
  if (editingEntryId) return getEntryById(editingEntryId);
  if (activeEntryTab === "income") return null;
  return getEntry($("#date").value, selectedDailyFlock);
}

function sectionHasData(entry, tabName) {
  if (!entry) return false;
  if (tabName === "production") {
    return Boolean(totalEggs(entry) || number(entry.lostEggs) || number(entry.deaths) || entry.productionNotes);
  }
  if (tabName === "consumption") {
    return Boolean(feedTotal(entry) || number(entry.waterLiters) || entry.consumptionNotes);
  }
  if (tabName === "income") {
    return Boolean(entryIncome(entry) || number(entry.eggCrates) || number(entry.soldBirds) || entry.incomeNotes);
  }
  if (tabName === "expense") {
    return Boolean(number(entry.dailyCost) || entry.expenseNotes);
  }
  return Boolean(entry.updatedSections?.[tabName]);
}

function firstEntryTabWithData(entry) {
  return ["production", "consumption", "income", "expense"].find((tabName) => sectionHasData(entry, tabName)) || "production";
}

function incomeModeWithData(entry) {
  if (number(entry?.soldBirds) || number(entry?.birdPrice) || number(entry?.incomeBirds)) return "birds";
  return "eggs";
}

function previewRows(entry, tabName) {
  if (tabName === "day") {
    const sections = [];
    if (sectionHasData(entry, "production")) sections.push(["Huevos", `${totalEggs(entry)} huevos · ${number(entry.lostEggs)} perdidos`]);
    if (sectionHasData(entry, "consumption")) sections.push(["Consumo", `${feedTotal(entry).toFixed(2)} kg alimento · ${number(entry.waterLiters).toFixed(1)} L agua`]);
    if (sectionHasData(entry, "expense")) sections.push(["Gastos", money(entry.dailyCost)]);
    return {
      title: "Detalle del día",
      rows: sections.length ? sections : [["Entrada", "Sin datos cargados"]],
      noteLabel: "Observaciones",
      note: [entry.productionNotes, entry.consumptionNotes, entry.expenseNotes].filter(Boolean).join(" · "),
    };
  }

  const config = {
    production: {
      title: "Producción",
      rows: [
        ["Huevos mañana", number(entry.morningEggs)],
        ["Huevos tarde", number(entry.afternoonEggs)],
        ["Huevos perdidos/rotos", number(entry.lostEggs)],
      ],
      noteLabel: "Notas de producción",
      note: entry.productionNotes,
    },
    consumption: {
      title: "Consumo",
      rows: [
        ["Maíz consumido", `${number(entry.cornKg).toFixed(2)} kg`],
        ["Balanceado consumido", `${number(entry.feedKg).toFixed(2)} kg`],
        ["Agua consumida", `${number(entry.waterLiters).toFixed(1)} L`],
      ],
      noteLabel: "Notas de consumo",
      note: entry.consumptionNotes,
    },
    income: {
      title: "Ingreso",
      rows: [
        ["Maples vendidos", number(entry.eggCrates)],
        ["Valor del maple", money(entry.eggCratePrice)],
        ["Venta de huevos", money(calculateEggIncome(entry))],
        ["Gallinas vendidas", number(entry.soldBirds)],
        ["Valor por gallina", money(entry.birdPrice)],
        ["Venta de gallinas", money(calculateBirdIncome(entry))],
        ["Total", money(entryIncome(entry))],
      ],
      noteLabel: "Notas de ingresos",
      note: entry.incomeNotes,
    },
    expense: {
      title: "Gasto",
      rows: [["Gastos", money(entry.dailyCost)]],
      noteLabel: "Notas de gastos",
      note: entry.expenseNotes,
    },
  };
  return config[tabName];
}

function openEntryPreview(date, flock, tabName) {
  const entry = getEntry(date, flock);
  if (!entry) return;
  const viewTab = tabName || firstEntryTabWithData(entry);
  previewSelection = {
    date,
    flock,
    tabName: viewTab,
    editTab: viewTab === "day" ? firstEntryTabWithData(entry) : viewTab,
    deleteMode: viewTab === "day" ? "day" : "section",
    isIncomeEntry: false,
  };
  const details = previewRows(entry, viewTab);
  $("#previewMeta").textContent = `${date} · ${flock}`;
  $("#previewTitle").textContent = details.title;
  $("#previewBody").innerHTML = `
    ${details.rows.map(([label, value]) => `<div class="preview-row"><span>${label}</span><strong>${value}</strong></div>`).join("")}
    <div class="preview-note"><strong>${details.noteLabel}</strong><span>${details.note || "Sin notas"}</span></div>
  `;
  $("#deleteConfirmBox strong").textContent = viewTab === "day" ? "¿Eliminar este día?" : "¿Eliminar esta entrada?";
  setDeleteConfirmMode(false);
  $("#deletePreviewBtn").hidden = false;
  $("#editPreviewBtn").hidden = false;
  $("#entryPreviewModal").hidden = false;
}

// Preview for independent income entries
function openIncomeEntryPreview(entry) {
  const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
  previewSelection = {
    date: entry.date,
    flock: flockOf(entry),
    tabName: "income",
    editTab: "income",
    deleteMode: "income-entry",
    entryId: entry.id,
    isIncomeEntry: true,
  };
  const rows = [];
  if (kind === "eggs") {
    rows.push(["Maples vendidos", number(entry.eggCrates)]);
    rows.push(["Valor por maple", money(entry.eggCratePrice)]);
    rows.push(["Total venta huevos", money(calculateEggIncome(entry))]);
  } else {
    rows.push(["Gallinas vendidas", number(entry.soldBirds)]);
    rows.push(["Valor por gallina", money(entry.birdPrice)]);
    rows.push(["Total venta gallinas", money(calculateBirdIncome(entry))]);
  }
  $("#previewMeta").textContent = `${entry.date} · ${flockOf(entry)}`;
  $("#previewTitle").textContent = kind === "eggs" ? "Venta de maples" : "Venta de gallinas";
  $("#previewBody").innerHTML = `
    ${rows.map(([label, value]) => `<div class="preview-row"><span>${label}</span><strong>${value}</strong></div>`).join("")}
    <div class="preview-note"><strong>Notas</strong><span>${entry.incomeNotes || "Sin notas"}</span></div>
  `;
  $("#deleteConfirmBox strong").textContent = "¿Eliminar este ingreso?";
  setDeleteConfirmMode(false);
  $("#deletePreviewBtn").hidden = false;
  $("#editPreviewBtn").hidden = false;
  $("#entryPreviewModal").hidden = false;
}

function openStockPreview(stockIndex) {
  const purchases = [...state.stock].sort((a, b) => b.date.localeCompare(a.date));
  const item = purchases[stockIndex];
  if (!item) return;
  const costPerKg = number(item.costPerKg ?? (number(item.kg) ? number(item.cost) / number(item.kg) : 0));
  previewSelection = null;
  $("#previewMeta").textContent = `${item.date} · ${normalizeFeedType(item.type)}`;
  $("#previewTitle").textContent = "Compra de alimento";
  $("#previewBody").innerHTML = `
    <div class="preview-row"><span>Kilos comprados</span><strong>${number(item.kg).toFixed(2)} kg</strong></div>
    <div class="preview-row"><span>Costo por kilo</span><strong>${money(costPerKg)}</strong></div>
    <div class="preview-row"><span>Total</span><strong>${money(item.cost)}</strong></div>
    <div class="preview-note"><strong>Notas</strong><span>${item.notes || "Sin notas"}</span></div>
  `;
  $("#deleteConfirmBox strong").textContent = "¿Eliminar esta compra?";
  setDeleteConfirmMode(false);
  $("#deletePreviewBtn").hidden = true;
  $("#editPreviewBtn").hidden = true;
  $("#entryPreviewModal").hidden = false;
}

function closeEntryPreview() {
  $("#entryPreviewModal").hidden = true;
  setDeleteConfirmMode(false);
}

function setDeleteConfirmMode(isConfirming) {
  $("#deleteConfirmBox").hidden = !isConfirming;
  $("#deletePreviewBtn").hidden = isConfirming;
  $("#editPreviewBtn").hidden = isConfirming;
  $("#cancelDeleteBtn").hidden = !isConfirming;
  $("#confirmDeleteBtn").hidden = !isConfirming;
  document.querySelector(".preview-actions").classList.toggle("confirming", isConfirming);
}

function deleteEntrySection(date, flock, tabName) {
  const entry = getEntry(date, flock);
  if (!entry) return;
  if (tabName === "production") {
    entry.morningEggs = 0;
    entry.afternoonEggs = 0;
    entry.lostEggs = 0;
    entry.deaths = 0;
    entry.productionNotes = "";
    entry.hensAfter = state.flocks[flock];
  }
  if (tabName === "consumption") {
    entry.cornKg = 0;
    entry.feedKg = 0;
    entry.waterLiters = 0;
    entry.consumptionNotes = "";
  }
  if (tabName === "income") {
    // Legacy: clear embedded income from main entry
    entry.eggCrates = 0;
    entry.eggCratePrice = 0;
    entry.soldBirds = 0;
    entry.birdPrice = 0;
    entry.incomeEggs = 0;
    entry.incomeBirds = 0;
    entry.incomeNotes = "";
  }
  if (tabName === "expense") {
    entry.dailyCost = 0;
    entry.expenseNotes = "";
  }
  entry.updatedSections = { ...(entry.updatedSections || {}), [tabName]: false };
  if (!Object.values(entry.updatedSections).some(Boolean)) {
    state.daily = state.daily.filter((item) => !(item.date === date && flockOf(item) === flock && !isIncomeEntry(item)));
  }
  saveState("Entrada eliminada");
}

function deleteEntryDay(date, flock) {
  state.daily = state.daily.filter((item) => !(item.date === date && flockOf(item) === flock && !isIncomeEntry(item)));
  saveState("Día eliminado");
}

function emptyEntry(date, flock) {
  return {
    date,
    flock,
    morningEggs: 0,
    afternoonEggs: 0,
    lostEggs: 0,
    deaths: 0,
    productionNotes: "",
    cornKg: 0,
    feedKg: 0,
    waterLiters: 0,
    consumptionNotes: "",
    dailyCost: 0,
    expenseNotes: "",
    hensAfter: state.flocks[flock] || 0,
    updatedSections: {},
  };
}

document.addEventListener("DOMContentLoaded", () => {
  $("#date").value = today();
  $("#stockDate").value = today();
  $("#healthDate").value = today();
  $("#flockDate").value = today();
  fillDailyForm(getEntry(today(), selectedDailyFlock));
  setEntryTab(activeEntryTab);
  setIncomeMode(activeIncomeMode);
  setHistoryTab(activeHistoryTab);
  renderStockTotalPreview();
  render();
  const initialTab = location.hash.replace("#", "");
  if (initialTab && document.getElementById(initialTab)) setActiveTab(initialTab);
  loadStateFromSupabase();
  window.setTimeout(showLowStockAlert, 250);

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setActiveTab(tab.dataset.tab));
  });

  $("#monthSelect").addEventListener("change", (event) => {
    selectedMonth = Number(event.target.value);
    selectedHistoryDate = "";
    render();
  });

  $("#yearSelect").addEventListener("change", (event) => {
    selectedYear = Number(event.target.value);
    selectedHistoryDate = "";
    render();
  });

  $("#dailyFlockButtons").addEventListener("click", (event) => {
    const button = event.target.closest(".segment[data-flock]");
    if (!button) return;
    selectedDailyFlock = button.dataset.flock;
    editingEntryId = null;
    setIncomeBtnLabel();
    fillDailyForm(getEntry($("#date").value, selectedDailyFlock) || { date: $("#date").value, flock: selectedDailyFlock });
    if (activeEntryTab === "income") renderCurrentIncomeEntries();
  });

  $("#entryTypeTabs").addEventListener("click", (event) => {
    const button = event.target.closest(".movement-type[data-entry-tab]");
    if (!button) return;
    setEntryTab(button.dataset.entryTab);
  });

  $("#incomeModeTabs").addEventListener("click", (event) => {
    const button = event.target.closest(".income-mode[data-income-mode]");
    if (!button) return;
    setIncomeMode(button.dataset.incomeMode);
  });

  $("#historyTypeTabs").addEventListener("click", (event) => {
    const button = event.target.closest(".history-tab[data-history-tab]");
    if (!button) return;
    setHistoryTab(button.dataset.historyTab);
  });

  document.getElementById("historyDateFilter")?.addEventListener("change", (e) => {
    setHistoryDateFilter(e.target.value);
  });
  document.getElementById("historyDateClearBtn")?.addEventListener("click", () => {
    setHistoryDateFilter("");
  });

  $("#date").addEventListener("change", (event) => {
    const newDate = event.target.value;
    if (!isIncomeEntry(getEntryById(editingEntryId) || {})) {
      editingEntryId = null;
    }
    fillDailyForm(getEntry(newDate, selectedDailyFlock) || { date: newDate, flock: selectedDailyFlock });
    if (activeEntryTab === "income") {
      clearIncomeFormFields();
      setIncomeBtnLabel();
      renderCurrentIncomeEntries();
    }
  });

  ["eggCrates", "eggCratePrice", "soldBirds", "birdPrice"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => renderIncomePreview());
  });
  ["eggCratePrice", "birdPrice", "dailyCost", "healthCost"].forEach((id) => {
    $(`#${id}`).addEventListener("blur", (event) => {
      formatMoneyInput(event.target);
      renderIncomePreview();
    });
  });

  ["stockKg", "stockCost"].forEach((id) => {
    $(`#${id}`).addEventListener("input", () => renderStockTotalPreview());
  });
  $("#stockCost").addEventListener("blur", (event) => {
    formatMoneyInput(event.target);
    renderStockTotalPreview();
  });

  $("#backHomeBtn").addEventListener("click", () => setActiveTab("home"));

  // ── Income panel: edit/delete buttons inside the entries list ─────────────
  document.querySelector("[data-entry-panel='income']").addEventListener("click", (event) => {
    const editBtn = event.target.closest(".income-entry-edit[data-income-id]");
    const deleteBtn = event.target.closest(".income-entry-delete[data-income-id]");

    if (editBtn) {
      const id = editBtn.dataset.incomeId;
      const entry = getEntryById(id);
      if (!entry) return;
      editingEntryId = entry.id;
      const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
      setIncomeMode(kind);
      if (kind === "eggs") {
        $("#eggCrates").value = number(entry.eggCrates) || "";
        $("#eggCratePrice").value = number(entry.eggCratePrice) ? money(entry.eggCratePrice) : "";
      } else {
        $("#soldBirds").value = number(entry.soldBirds) || "";
        $("#birdPrice").value = number(entry.birdPrice) ? money(entry.birdPrice) : "";
      }
      $("#incomeNotes").value = entry.incomeNotes || "";
      renderIncomePreview(entry);
      setIncomeBtnLabel();
      renderCurrentIncomeEntries();
      // Scroll to form
      document.querySelector("[data-entry-panel='income'] .income-mode-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    if (deleteBtn) {
      const id = deleteBtn.dataset.incomeId;
      state.daily = state.daily.filter((e) => e.id !== id);
      if (editingEntryId === id) {
        editingEntryId = null;
        clearIncomeFormFields();
        setIncomeBtnLabel();
      }
      saveState("Ingreso eliminado");
      renderCurrentIncomeEntries();
    }
  });

  // Cancel income edit
  const cancelIncomeEditBtn = $("#cancelIncomeEditBtn");
  if (cancelIncomeEditBtn) {
    cancelIncomeEditBtn.addEventListener("click", () => {
      editingEntryId = null;
      clearIncomeFormFields();
      setIncomeBtnLabel();
      renderCurrentIncomeEntries();
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  $("#dailyForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    // ── Independent income entries ──────────────────────────────────────────
    if (activeEntryTab === "income") {
      const kind = activeIncomeMode;
      const isEditing = editingEntryId && isIncomeEntry(getEntryById(editingEntryId));
      const incomeEntry = {
        id: isEditing ? editingEntryId : uid(),
        date: $("#date").value,
        flock: selectedDailyFlock,
        entryType: "income",
        incomeKind: kind,
        eggCrates: kind === "eggs" ? number($("#eggCrates").value) : 0,
        eggCratePrice: kind === "eggs" ? parseMoney($("#eggCratePrice").value) : 0,
        soldBirds: kind === "birds" ? number($("#soldBirds").value) : 0,
        birdPrice: kind === "birds" ? parseMoney($("#birdPrice").value) : 0,
        incomeNotes: $("#incomeNotes").value.trim(),
        updatedSections: { income: true },
      };
      incomeEntry.incomeEggs = calculateEggIncome(incomeEntry);
      incomeEntry.incomeBirds = calculateBirdIncome(incomeEntry);

      if (isEditing) {
        const idx = state.daily.findIndex((e) => e.id === editingEntryId);
        if (idx >= 0) state.daily[idx] = incomeEntry;
      } else {
        state.daily.push(incomeEntry);
      }
      editingEntryId = null;
      selectedYear = Number(incomeEntry.date.slice(0, 4));
      selectedMonth = Number(incomeEntry.date.slice(5, 7)) - 1;
      state.hens = state.flocks.Gallinas;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
      showToast(isEditing ? "Ingreso actualizado" : "Ingreso guardado");
      syncStateToSupabase();
      // Stay on income tab, clear fields to add more
      clearIncomeFormFields();
      setIncomeMode(kind); // keep same mode
      setIncomeBtnLabel();
      renderCurrentIncomeEntries();
      return;
    }
    // ────────────────────────────────────────────────────────────────────────

    const previous = currentFormEntry();
    // Always replace values (never accumulate) — prevents double-counting on re-saves
    const entry = {
      ...emptyEntry($("#date").value, selectedDailyFlock),
      ...(previous || {}),
      date: $("#date").value,
      flock: selectedDailyFlock,
    };
    if (activeEntryTab === "production") {
      entry.morningEggs = number($("#morningEggs").value);
      entry.afternoonEggs = number($("#afternoonEggs").value);
      entry.lostEggs = number($("#lostEggs").value);
      entry.productionNotes = $("#productionNotes").value.trim();
      entry.hensAfter = state.flocks[entry.flock];
    }

    if (activeEntryTab === "consumption") {
      entry.cornKg = number($("#cornKg").value);
      entry.feedKg = number($("#feedKg").value);
      entry.waterLiters = number($("#waterLiters").value);
      entry.consumptionNotes = $("#consumptionNotes").value.trim();
    }

    if (activeEntryTab === "expense") {
      entry.dailyCost = parseMoney($("#dailyCost").value);
      entry.expenseNotes = $("#expenseNotes").value.trim();
    }

    const hasSavedData = sectionHasData(entry, activeEntryTab);
    entry.updatedSections = {
      ...(previous?.updatedSections || {}),
      [activeEntryTab]: hasSavedData,
    };
    entry.hensAfter = state.flocks[entry.flock];
    if (!entry.id) entry.id = uid();
    upsertDaily(entry);
    selectedYear = Number(entry.date.slice(0, 4));
    selectedMonth = Number(entry.date.slice(5, 7)) - 1;
    state.hens = state.flocks.Gallinas;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
    showToast("Guardado");
    syncStateToSupabase();
    editingEntryId = null;
    resetDailyFormForNextEntry();
    setActiveTab("home");
  });

  $("#stockForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const kg = number($("#stockKg").value);
    const costPerKg = parseMoney($("#stockCost").value);
    state.stock.push({
      date: $("#stockDate").value,
      type: $("#stockType").value,
      kg,
      costPerKg,
      cost: kg * costPerKg,
      notes: $("#stockNotes").value.trim(),
    });
    event.target.reset();
    $("#stockDate").value = today();
    $("#stockCost").value = "";
    $("#stockNotes").value = "";
    renderStockTotalPreview();
    saveState("Compra agregada");
  });

  $("#healthForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.health.push({
      date: $("#healthDate").value,
      type: $("#healthType").value,
      affectedHens: number($("#affectedHens").value),
      cost: parseMoney($("#healthCost").value),
      notes: $("#healthNotes").value.trim(),
    });
    event.target.reset();
    $("#healthDate").value = today();
    $("#healthCost").value = "";
    saveState("Evento guardado");
  });

  $("#flockForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const flock = $("#flockGroup").value;
    const action = $("#flockAction").value;
    const quantity = number($("#flockQuantity").value);
    if (!quantity && action !== "Ajuste") return;
    const before = number(state.flocks[flock]);
    const after = action === "Ajuste" ? quantity : Math.max(0, before + (action === "Baja" ? -quantity : quantity));
    state.flocks[flock] = after;
    state.hens = state.flocks.Gallinas;
    state.flockEvents.push({
      date: $("#flockDate").value,
      flock,
      action,
      quantity,
      before,
      after,
      notes: $("#flockNotes").value.trim(),
    });
    event.target.reset();
    $("#flockDate").value = today();
    saveState("Plantel actualizado");
  });

  $("#historyRows").addEventListener("click", (event) => {
    const row = event.target.closest(".history-item[data-date][data-flock]");
    if (!row) return;
    const entryId = row.dataset.id;
    const found = entryId ? getEntryById(entryId) : null;
    if (found && isIncomeEntry(found)) {
      openIncomeEntryPreview(found);
    } else {
      openEntryPreview(row.dataset.date, row.dataset.flock, row.dataset.entryTab || activeHistoryTab);
    }
  });

  $("#recentEntries").addEventListener("click", (event) => {
    const item = event.target.closest(".recent-item[data-date][data-flock]");
    if (!item) return;
    const entryId = item.dataset.id;
    const found = entryId ? getEntryById(entryId) : null;
    if (found && isIncomeEntry(found)) {
      openIncomeEntryPreview(found);
    } else {
      openEntryPreview(item.dataset.date, item.dataset.flock, "day");
    }
  });

  $("#stockPurchases").addEventListener("click", (event) => {
    const item = event.target.closest(".stock-purchase-item[data-stock-index]");
    if (!item) return;
    openStockPreview(Number(item.dataset.stockIndex));
  });

  function openDailyFormForToday() {
    const existing = getEntry(today(), selectedDailyFlock);
    if (existing) {
      // Pre-fill with existing entry so user edits in-place (not accumulates)
      editingEntryId = existing.id;
      fillDailyForm(existing);
    } else {
      editingEntryId = null;
      fillDailyForm({ date: today(), flock: selectedDailyFlock });
    }
    setActiveTab("daily");
  }
  $("#addTodayBtn").addEventListener("click", openDailyFormForToday);
  $("#floatingAddBtn").addEventListener("click", openDailyFormForToday);
  // Reports button in topbar
  $("#openReportsBtn").addEventListener("click", () => setActiveTab("reports"));

  // Excel export inside reports panel
  $("#exportExcelBtn").addEventListener("click", exportExcel);

  // Flock sub-tab switching (Plantel / Sanidad)
  document.getElementById("flockSubtabs").addEventListener("click", (event) => {
    const btn = event.target.closest(".flock-subtab[data-flock-tab]");
    if (btn) setFlockSubtab(btn.dataset.flockTab);
  });
  $("#backupBtn").addEventListener("click", backupJson);
  $("#closePreviewBtn").addEventListener("click", closeEntryPreview);
  $("#entryPreviewModal").addEventListener("click", (event) => {
    if (event.target.id === "entryPreviewModal") closeEntryPreview();
  });

  $("#editPreviewBtn").addEventListener("click", () => {
    if (!previewSelection) return;
    const { date, flock, editTab, isIncomeEntry: isIncome, entryId } = previewSelection;

    if (isIncome) {
      const entry = getEntryById(entryId);
      if (!entry) { closeEntryPreview(); return; }
      closeEntryPreview();
      editingEntryId = entry.id;
      const kind = entry.incomeKind || (number(entry.soldBirds) ? "birds" : "eggs");
      setActiveTab("daily");
      setEntryTab("income");
      setIncomeMode(kind);
      $("#date").value = entry.date;
      selectedDailyFlock = flockOf(entry);
      setSegmentGroup("dailyFlockButtons", flockOf(entry));
      if (kind === "eggs") {
        $("#eggCrates").value = number(entry.eggCrates) || "";
        $("#eggCratePrice").value = number(entry.eggCratePrice) ? money(entry.eggCratePrice) : "";
      } else {
        $("#soldBirds").value = number(entry.soldBirds) || "";
        $("#birdPrice").value = number(entry.birdPrice) ? money(entry.birdPrice) : "";
      }
      $("#incomeNotes").value = entry.incomeNotes || "";
      renderIncomePreview(entry);
      setIncomeBtnLabel();
      renderCurrentIncomeEntries();
    } else {
      const entry = getEntry(date, flock);
      closeEntryPreview();
      editingEntryId = entry?.id || null;
      fillDailyForm(entry);
      setActiveTab("daily");
      setEntryTab(editTab);
      if (editTab === "income") {
        setIncomeMode(incomeModeWithData(entry));
        renderCurrentIncomeEntries();
      }
    }
  });

  $("#deletePreviewBtn").addEventListener("click", () => {
    setDeleteConfirmMode(true);
  });
  $("#cancelDeleteBtn").addEventListener("click", () => {
    setDeleteConfirmMode(false);
  });

  $("#confirmDeleteBtn").addEventListener("click", () => {
    if (!previewSelection) return;
    const { date, flock, tabName, deleteMode, entryId } = previewSelection;
    closeEntryPreview();
    if (deleteMode === "income-entry") {
      state.daily = state.daily.filter((e) => e.id !== entryId);
      saveState("Ingreso eliminado");
    } else if (deleteMode === "day") {
      deleteEntryDay(date, flock);
    } else {
      deleteEntrySection(date, flock, tabName);
    }
  });

  $("#closeStockAlertBtn").addEventListener("click", () => {
    $("#stockAlertModal").hidden = true;
  });

  $("#importBackup").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      state = migrateState(imported);
      saveState("Respaldo importado");
      fillDailyForm(getEntry($("#date").value, selectedDailyFlock) || { date: today(), flock: selectedDailyFlock });
    } catch {
      showToast("Error: el archivo no es válido");
    }
    event.target.value = "";
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }

  window.addEventListener("focus", () => {
    loadStateFromSupabase();
  });
});
