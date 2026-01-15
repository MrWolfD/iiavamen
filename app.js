console.log("APP VERSION: 2026-01-13 (fastify api)");
'use strict';

// Конфигурация
const CONFIG = {
  DEBOUNCE_DELAY: 300,
  INIT_DELAY: 700,
  STORAGE_KEY: 'iiava_favorites',
  MIN_SWIPE_DISTANCE: 55,
  TUTORIAL_KEY: 'iiava_tutorial_seen_session'
};

const API_BASE = "https://api.iiava.koshelev.agency";

// ✅ ЖЕНСКИЙ БОТ
const BOT_PREFIX = "/women";

const TG_PROFILE_URL = `${API_BASE}${BOT_PREFIX}/tg/profile`;
const PROMPT_LIST_URL = `${API_BASE}${BOT_PREFIX}/prompt/list`;
const PROMPT_FAVORITE_URL = `${API_BASE}${BOT_PREFIX}/prompt/favorite`;
const PROMPT_COPY_URL = `${API_BASE}${BOT_PREFIX}/prompt/copy`;

let runtimeProfile = null;

function initTelegramWebApp() {
  try {
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
  } catch (e) {
    console.warn("Telegram WebApp init failed:", e);
  }
}

function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData || "";
}

/**
 * Нормализуем любой формат, который может прийти из Edge Function:
 * - { ok, uid, profile: {...} }
 * - { ok, uid, profile: [{...}] }
 * - { ... } (без обёртки)
 * - [{...}] (если вдруг вернули массив напрямую)
 */
function normalizeProfilePayload(payload) {
  if (payload == null) return null;

  // Если payload — строка (например, вернули текст), пытаемся распарсить
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }

  // если пришёл массив — берём первую строку
  if (Array.isArray(payload)) {
    return payload[0] ?? null;
  }

  // если пришёл объект с profile
  const p = payload.profile ?? payload.data ?? payload;

  if (Array.isArray(p)) return p[0] ?? null;
  if (p && typeof p === 'object') return p;

  return null;
}

async function fetchProfileFromAPI() {
  const initData = getTelegramInitData();

  if (!initData) {
    console.warn("No initData — opened outside Telegram WebApp");
    return null;
  }

  const res = await fetch(TG_PROFILE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-init-data": initData,
    },
    body: JSON.stringify({ initData })
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`tg_profile HTTP ${res.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("tg_profile returned non-JSON");
  }

  const profile = normalizeProfilePayload(json);

  return profile;
}

function getProfileOrNull() {
  return runtimeProfile || null; // никаких demoData
}

function isTelegramAuthorized() {
  return !!getTelegramInitData();
}

// Всегда возвращаем объект, чтобы UI/модалки спокойно рендерились,
// но без демо-данных (все значения нулевые/пустые до авторизации).
function getProfileForUI() {
  return getProfileOrNull() || {
    // генерации
    total_generations: 0,
    done_count: 0,
    not_finished_count: 0,
    cancel_count: 0,

    // бонусы/рефералы
    referrals_count: 0,
    referrals: 0,
    bonus_total: 0,
    earnedBonuses: 0,
    bonus_balance: 0,
    bonusBalance: 0,

    // реф-код
    ref_code: '',
    referralLink: ''
  };
}

// --- Prompts from Fastify API ---
function normalizePromptListPayload(payload) {
  if (payload == null) return [];
  const items = payload.items ?? payload.data ?? payload;
  return Array.isArray(items) ? items : [];
}

function mapPromptFromDb(p) {
  const categories = Array.isArray(p.categories) ? p.categories : [];
  const category = categories.length ? String(categories[0]) : 'без категории';

  return {
    id: Number(p.id),
    title: String(p.title ?? ''),
    description: String(p.description ?? ''),
    promptText: String(p.prompt_text ?? ''),
    image: String(p.image_url ?? ''),
    category,
    tags: categories,

    // UI-цифры (пока персональные, если сервер не даёт общие)
    copies: Number(p.copies_by_user ?? 0),
    favorites: Number(p.favorites_count ?? 0),

    is_favorite: Boolean(p.is_favorite ?? false),
  };
}

async function callEdge(url, payload) {
  const initData = getTelegramInitData();
  if (!initData) return { ok: false, message: "No initData" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-init-data": initData,
    },
    // initData дублируем в body для совместимости/логирования на бэке
    body: JSON.stringify({ initData, ...payload }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`API HTTP ${res.status}: ${text}`);

  try { return JSON.parse(text); } catch { throw new Error("API returned non-JSON"); }
}

async function fetchPromptsFromAPI() {
  const json = await callEdge(PROMPT_LIST_URL, { page: 1, limit: 200 });
  const items = normalizePromptListPayload(json);
  return items.map(mapPromptFromDb);
}


async function loadPrompts() {
  try {
    state.isLoading = true;
    // показываем лоадер, если есть
    if (dom.loadingState) dom.loadingState.style.display = 'flex';

    const prompts = await fetchPromptsFromAPI();

    // ✅ Никаких дефолтных промптов: если пусто — показываем пустое состояние
    state.prompts = Array.isArray(prompts) ? prompts : [];
    state.filteredPrompts = [];
    state.isLoading = false;

    // перерисовка категорий и списка
    renderCategories();
    updatePrompts();
    updateStats();
  } catch (e) {
    console.error("loadPrompts failed:", e);
    state.prompts = [];
    state.filteredPrompts = [];
    state.isLoading = false;
    renderCategories();
    updatePrompts();
    updateStats();
  } finally {
    if (dom.loadingState) dom.loadingState.style.display = 'none';
  }
}

function findPromptById(promptId) {
  return state.prompts.find(p => Number(p.id) === Number(promptId)) || null;
}

async function toggleFavoriteEdge(promptId) {
  const prompt = findPromptById(promptId);
  if (!prompt) return;

  try {
    const res = await callEdge(PROMPT_FAVORITE_URL, { prompt_id: Number(promptId) });

    // Ожидаемые варианты ответа:
    // { ok:true, is_favorite:true/false, favorites_count:number }
    // { ok:true, favorite:true/false, favorites:number }
    const isFav = Boolean(res?.is_favorite ?? res?.favorite ?? res?.active ?? !prompt.is_favorite);
    const favCount = res?.favorites_count ?? res?.favorites ?? null;

    prompt.is_favorite = isFav;
    if (typeof favCount === 'number') {
      prompt.favorites = favCount;
    } else {
      // если бэк не вернул число — обновляем локально (минимально корректно)
      prompt.favorites = Math.max(0, Number(prompt.favorites || 0) + (isFav ? 1 : -1));
    }

    // синхроним модалку, если открыта
    const favBtn = document.getElementById('promptModalFavBtn');
    const favCounter = document.getElementById('promptModalFavorites');
    if (dom.promptModalOverlay?.classList.contains('show')) {
      if (favBtn) favBtn.textContent = isFav ? '❤ В избранном' : '❤ В избранное';
      if (favCounter) favCounter.textContent = String(prompt.favorites || 0);
    }

    onPromptMetricsChanged(promptId);
    utils.showToast(isFav ? 'Добавлено в избранное' : 'Удалено из избранного');
  } catch (e) {
    console.warn("prompt-favorite failed:", e);
    utils.showToast('Не удалось обновить избранное', 'error');
  }
}


// --- /Prompts from Fastify API ---

// --- /Telegram WebApp + profile ---

// Состояние приложения
const state = {
  prompts: [],
  filteredPrompts: [],
  favorites: [],
  activeCategories: new Set(['все']),
  searchQuery: '',
  sortBy: 'default',
  isLoading: true,
  showOnlyFavorites: false,
  modalIndex: 0
};

// Демо-данные
const demoData = {
  profile: {
    userId: 224753455,
    registeredAt: "2025-11-03",
    tokenBalance: 1460,
    bonusBalance: 120,
    earnedBonuses: 340,
    referrals: 12,
    generations: { total: 98, success: 79, unfinished: 11, canceled: 8 },
    referralLink: "https://t.me/iiavabot?start=ref_224753455"
  },

  prompts: []
};

// Кэш DOM элементов
const dom = {
  cardsGrid: document.getElementById('cardsGrid'),
  filterTabs: document.getElementById('filterTabs'),
  visibleCount: document.getElementById('visibleCount'),
  totalCount: document.getElementById('totalCount'),
  sortSelect: document.getElementById('sortSelect'),
  loadingState: document.getElementById('loadingState'),
  appContainer: document.getElementById('appContainer'),
  toast: document.getElementById('toast'),
  searchInput: document.getElementById('searchInput'),
  favoritesBtn: document.getElementById('favoritesBtn'),
  generateBtn: document.getElementById('generateBtn'),
  mobileGenerateBtn: document.getElementById('mobileGenerateBtn'),
  tryFreeBtn: document.getElementById('tryFreeBtn'),
  invitedCount: document.getElementById('invitedCount'),
  earnedBonuses: document.getElementById('earnedBonuses'),
  bonusBalance: document.getElementById('bonusBalance'),
  referralLink: document.getElementById('referralLink'),
  copyReferralBtn: document.getElementById('copyReferralBtn'),
  profileBtn: document.getElementById('profileBtn'),
  promptModalOverlay: document.getElementById('promptModalOverlay'),
  profileModalOverlay: document.getElementById('profileModalOverlay'),
  constructorModalOverlay: document.getElementById('constructorModalOverlay'),
  tutorialModalOverlay: document.getElementById('tutorialModalOverlay'),
  tutorialGotItBtn: document.getElementById('tutorialGotItBtn')
};

// Утилиты
const utils = {
  debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  },

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },

  formatDate(dateStr) {
    const date = new Date(dateStr);
    return isNaN(date.getTime())
      ? dateStr
      : date.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });
  },

  showToast(message, type = 'success') {
    const icon = type === 'success'
      ? '<path d="M20 6L9 17l-5-5"></path>'
      : '<circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6M9 9l6 6"></path>';

    dom.toast.innerHTML = `
      <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icon}</svg>
      <span>${message}</span>
    `;

    dom.toast.classList.add('show');
    setTimeout(() => dom.toast.classList.remove('show'), 2600);
  }
};

// Основные функции
function renderCategories() {
  const categories = ['все', ...new Set(state.prompts.map(p => p.category))];

  dom.filterTabs.innerHTML = categories.map(cat => {
    const isActive = state.activeCategories.has(cat);
    const isAll = cat === 'все';
    const allActiveButOthers = isAll && state.activeCategories.size > 1;

    return `
      <div class="filter-tab ${isActive ? 'active' : ''} ${allActiveButOthers ? 'all-active' : ''}"
           data-category="${cat}">
        ${cat.charAt(0).toUpperCase() + cat.slice(1)}
      </div>
    `;
  }).join('');
}

function renderPrompts() {
  if (state.filteredPrompts.length === 0) {
    const emptyState = state.showOnlyFavorites
      ? {
        icon: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>',
        title: 'В избранном пока пусто',
        text: 'Открывайте промпты и нажимайте на сердечко, чтобы быстро находить их и копировать в бот'
      }
      : {
        icon: '<circle cx="12" cy="12" r="10"></circle><path d="M8 12h8"></path>',
        title: 'Промпты не найдены',
        text: 'Попробуйте изменить фильтры или поиск'
      };

    dom.cardsGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">${emptyState.icon}</svg>
        <h3>${emptyState.title}</h3>
        <p>${emptyState.text}</p>
      </div>
    `;
    return;
  }

  dom.cardsGrid.innerHTML = state.filteredPrompts.map(prompt => `
    <div class="prompt-card" data-id="${prompt.id}">
      <img src="${prompt.image}"
           alt="${prompt.title}"
           class="prompt-image"
           loading="lazy"
           onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;300&quot; height=&quot;400&quot;><rect width=&quot;100%&quot; height=&quot;100%&quot; fill=&quot;%23f3f4f6&quot;/></svg>'">
      <div class="prompt-content">
        <div class="prompt-meta">
          <div class="prompt-stats">
            <div class="stat-item" title="Копирований">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span data-stat="copies">${prompt.copies}</span>
            </div>
            <div class="stat-item" title="Добавлено в избранное">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
              </svg>
              <span data-stat="favorites">${prompt.favorites}</span>
            </div>
          </div>
          <div class="prompt-actions">
            <button class="action-btn copy-btn" data-id="${prompt.id}" title="Копировать промпт">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="action-btn favorite-btn ${prompt.is_favorite ? 'active' : ''}"
                    data-id="${prompt.id}"
                    title="${prompt.is_favorite ? 'Удалить из избранного' : 'Добавить в избранное'}">
              <svg width="18" height="18" viewBox="0 0 24 24"
                   fill="${prompt.is_favorite ? 'currentColor' : 'none'}"
                   stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `).join('');
}

function updatePrompts() {
  let filtered = [...state.prompts];

  if (state.showOnlyFavorites) {
    filtered = filtered.filter(p => p.is_favorite);
  }

  const categories = new Set(state.activeCategories);
  const onlyAll = categories.size === 1 && categories.has('все');

  if (!onlyAll) {
    categories.delete('все');
    if (categories.size > 0) {
      filtered = filtered.filter(p => categories.has(p.category));
    }
  }

  if (state.searchQuery) {
    const query = state.searchQuery.toLowerCase();
    filtered = filtered.filter(p =>
      p.title.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query) ||
      p.tags.some(tag => String(tag).toLowerCase().includes(query))
    );
  }

  filtered.sort((a, b) => {
    switch (state.sortBy) {
      case 'default': return (b.copies + b.favorites) - (a.copies + a.favorites);
      case 'new': return b.id - a.id;
      case 'copies': return b.copies - a.copies;
      case 'favorites': return b.favorites - a.favorites;
      default: return 0;
    }
  });

  state.filteredPrompts = filtered;
  renderPrompts();
  updateStats();
}

function updateStats() {
  dom.visibleCount.textContent = state.filteredPrompts.length;
  dom.totalCount.textContent = state.prompts.length;
  
  const statsInfo = document.querySelector('.stats-info');
  if (statsInfo) {
    statsInfo.innerHTML = `<strong id="visibleCount">${state.filteredPrompts.length}</strong> из <strong id="totalCount">${state.prompts.length}</strong>`;
  }

  const favCount = state.prompts.filter(p => p.is_favorite).length;

  dom.favoritesBtn.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24"
         fill="${(favCount > 0 || state.showOnlyFavorites) ? 'currentColor' : 'none'}"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
    </svg>
    ${favCount > 0 ? `<span class="fav-counter">${favCount}</span>` : ''}
  `;

  dom.favoritesBtn.classList.toggle('active', state.showOnlyFavorites);

  if (dom.profileBtn && !dom.profileBtn.innerHTML.trim()) {
    dom.profileBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21a8 8 0 0 0-16 0"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
    `;
  }
}


// ---- UI updates without full re-render (prevents flicker) ----
function applyFiltersAndSort(prompts) {
  let filtered = [...prompts];

  // только избранное
  if (state.showOnlyFavorites) {
    filtered = filtered.filter(p => !!p.is_favorite);
  }

  // категории (учитываем 'все' как отсутствие фильтра)
  const categories = new Set(state.activeCategories || []);
  const onlyAll = categories.size === 0 || (categories.size === 1 && categories.has('все'));
  if (!onlyAll) {
    categories.delete('все');
    if (categories.size > 0) {
      filtered = filtered.filter(p => categories.has(p.category));
    }
  }

  // поиск
  const query = (state.searchQuery || '').toLowerCase().trim();
  if (query) {
    filtered = filtered.filter(p =>
      String(p.title || '').toLowerCase().includes(query) ||
      String(p.description || '').toLowerCase().includes(query) ||
      (Array.isArray(p.tags) && p.tags.some(tag => String(tag).toLowerCase().includes(query)))
    );
  }

  // сортировка (как в updatePrompts)
  filtered.sort((a, b) => {
    switch (state.sortBy) {
      case 'default': return ((b.copies || 0) + (b.favorites || 0)) - ((a.copies || 0) + (a.favorites || 0));
      case 'new': return (b.id || 0) - (a.id || 0);
      case 'copies': return (b.copies || 0) - (a.copies || 0);
      case 'favorites': return (b.favorites || 0) - (a.favorites || 0);
      default: return 0;
    }
  });

  return filtered;
}


function updatePromptUI(promptId) {
  const id = String(promptId);
  const prompt = state.prompts.find(p => String(p.id) === id);
  if (!prompt) return;

  // карточка в списке
  const card = dom.cardsGrid?.querySelector?.(`.prompt-card[data-id="${id}"]`);
  if (card) {
    const copiesEl = card.querySelector('[data-stat="copies"]');
    if (copiesEl) copiesEl.textContent = String(prompt.copies || 0);

    const favEl = card.querySelector('[data-stat="favorites"]');
    if (favEl) favEl.textContent = String(prompt.favorites || 0);

    const favBtn = card.querySelector('.favorite-btn');
    if (favBtn) {
      favBtn.classList.toggle('active', !!prompt.is_favorite);
      favBtn.title = prompt.is_favorite ? 'Удалить из избранного' : 'Добавить в избранное';

      const svg = favBtn.querySelector('svg');
      if (svg) svg.setAttribute('fill', prompt.is_favorite ? 'currentColor' : 'none');
    }
  }

  // модалка (если открыта)
  if (dom.promptModalOverlay?.classList.contains('show')) {
    const list = state.filteredPrompts.length ? state.filteredPrompts : state.prompts;
    const openPrompt = list[modal.currentIndex];
    if (openPrompt && String(openPrompt.id) === id) {
      const mc = document.getElementById('promptModalCopies');
      if (mc) mc.textContent = String(prompt.copies || 0);

      const mf = document.getElementById('promptModalFavorites');
      if (mf) mf.textContent = String(prompt.favorites || 0);

      const mb = document.getElementById('promptModalFavBtn');
      if (mb) mb.textContent = prompt.is_favorite ? '❤ В избранном' : '❤ В избранное';
    }
  }
}


function moveCardToSortedPosition(promptId) {
  const id = String(promptId);
  state.filteredPrompts = applyFiltersAndSort(state.prompts);

  const container = dom.cardsGrid;
  if (!container) return;

  const card = container.querySelector(`.prompt-card[data-id="${id}"]`);
  if (!card) return;

  const ids = state.filteredPrompts.map(p => String(p.id));
  const idx = ids.indexOf(id);

  // если карточка больше не должна отображаться — убираем
  if (idx === -1) {
    card.remove();
    return;
  }

  // вставляем перед следующей карточкой в "идеальном" порядке
  const nextId = ids[idx + 1];
  if (nextId) {
    const nextEl = container.querySelector(`.prompt-card[data-id="${nextId}"]`);
    if (nextEl && nextEl !== card) {
      container.insertBefore(card, nextEl);
      return;
    }
  }
  // иначе — в конец
  if (container.lastElementChild !== card) container.appendChild(card);
}

function onPromptMetricsChanged(promptId) {
  updatePromptUI(promptId);

  // если сортировка зависит от копий/избранного или включен показ только избранного —
  // аккуратно переместим карточку, без пересоздания всего списка
  if (state.showOnlyFavorites || state.sortBy === 'copies' || state.sortBy === 'favorites' || state.sortBy === 'default') {
    moveCardToSortedPosition(promptId);
  }

  updateStats();
}
// ------------------------------------------------------------

function isMobileView() {
  return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

function initPrompts() {
  state.prompts = [];
  state.filteredPrompts = [];
  state.isLoading = true;
  if (dom.loadingState) dom.loadingState.style.display = 'flex';
}

function syncPromptModalStatsPlacement() {
  const stats = document.getElementById('promptModalStats');
  const dock = document.getElementById('promptModalStatsDock');
  const carousel = document.getElementById('promptCarousel');

  if (!stats || !dock || !carousel) return;

  if (isMobileView()) {
    if (stats.parentElement !== carousel) carousel.appendChild(stats);
  } else {
    if (stats.parentElement !== dock) dock.appendChild(stats);
  }
}

// Modal функции
const modal = {
  currentIndex: 0,

  open(el) {
    el.classList.add('show');
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    document.body.style.overflow = 'hidden';

    const focusable = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) {
      focusable[0].focus();
    }
  },

  close(el) {
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';

    if (el.lastFocusedElement) {
      el.lastFocusedElement.focus();
    }
  },

  openPrompt(promptId) {
    const list = state.filteredPrompts.length ? state.filteredPrompts : state.prompts;
    const idx = list.findIndex(p => p.id === promptId);

    if (idx < 0) return;

    this.currentIndex = idx;
    const prompt = list[idx];

    document.getElementById('promptModalSubtitle').textContent = prompt.category ? `Категория: ${prompt.category}` : '';

    const img = document.getElementById('promptModalImage');
    img.src = prompt.image;
    img.alt = prompt.title;

    document.getElementById('promptModalText').value = prompt.promptText || '';
    document.getElementById('promptModalCopies').textContent = prompt.copies || 0;
    document.getElementById('promptModalFavorites').textContent = prompt.favorites || 0;
    document.getElementById('promptModalFavBtn').textContent =
      prompt.is_favorite ? '❤ В избранном' : '❤ В избранное';
    document.getElementById('promptCarouselCounter').textContent = `${this.currentIndex + 1} / ${list.length}`;

    syncPromptModalStatsPlacement();
    this.open(dom.promptModalOverlay);
  },

  prev() {
    const list = state.filteredPrompts.length ? state.filteredPrompts : state.prompts;
    this.currentIndex = (this.currentIndex - 1 + list.length) % list.length;
    const prompt = list[this.currentIndex];
    if (prompt) this.openPrompt(prompt.id);
  },

  next() {
    const list = state.filteredPrompts.length ? state.filteredPrompts : state.prompts;
    this.currentIndex = (this.currentIndex + 1) % list.length;
    const prompt = list[this.currentIndex];
    if (prompt) this.openPrompt(prompt.id);
  },

  openProfile() {
    const p = getProfileForUI();

    const total = Number(p.total_generations ?? p.generations?.total ?? 0);
    const done = Number(p.done_count ?? p.generations?.success ?? 0);
    const notFinished = Number(p.not_finished_count ?? p.generations?.unfinished ?? 0);
    const cancel = Number(p.cancel_count ?? p.generations?.canceled ?? 0);
    const rate = Number(p.success_rate ?? (total ? Math.round((done / total) * 100) : 0));

    document.getElementById('profileTokenBalance').textContent = p.balance ?? p.tokenBalance ?? 0;
    document.getElementById('profileBonusBalance').textContent = p.bonus_balance ?? p.bonusBalance ?? 0;
    document.getElementById('profileEarnedBonuses').textContent = p.bonus_total ?? p.earnedBonuses ?? 0;
    document.getElementById('profileReferrals').textContent = p.referrals_count ?? p.referrals ?? 0;

    document.getElementById('profileGenTotal').textContent = total;
    document.getElementById('profileGenSuccess').textContent = done;
    document.getElementById('profileGenUnfinished').textContent = notFinished;
    document.getElementById('profileGenCanceled').textContent = cancel;
    document.getElementById('profileGenRate').textContent = `${rate}%`;
    document.getElementById('profileGenRateHint').textContent = `Успешных: ${done} из ${total}`;

    document.getElementById('profileRegisteredAt').textContent =
      utils.formatDate(p.created_at ?? p.registeredAt ?? '');

    const refCode = p.ref_code ?? '';
    document.getElementById('profileReferralLink').value =
      refCode ? `https://t.me/iiavabot?start=ref_${refCode}` : (p.referralLink ?? '');

    this.open(dom.profileModalOverlay);
  },

  openConstructor() {
    if (window.__promptBuilder && typeof window.__promptBuilder.resetOnOpen === 'function') {
      window.__promptBuilder.resetOnOpen();
    }
    this.open(dom.constructorModalOverlay);
  },

  openTutorial() {
    const hasSeenInSession = sessionStorage.getItem(CONFIG.TUTORIAL_KEY);
    if (!hasSeenInSession) {
      this.open(dom.tutorialModalOverlay);
    }
  },

  closeTutorial() {
    sessionStorage.setItem(CONFIG.TUTORIAL_KEY, 'true');
    this.close(dom.tutorialModalOverlay);
  }
};

// Вспомогательные функции
function toggleFavorite(promptId) {
  // legacy wrapper (keep calls working)
  toggleFavoriteEdge(promptId);
}


async function toggleCurrentFavorite() {
  const list = state.filteredPrompts.length ? state.filteredPrompts : state.prompts;
  const prompt = list[modal.currentIndex];
  if (!prompt) return;

  await toggleFavoriteEdge(prompt.id);
}


async function copyCurrentPrompt() {
  const list = state.filteredPrompts.length ? state.filteredPrompts : state.prompts;
  const prompt = list[modal.currentIndex];
  if (!prompt) return;

  const success = await utils.copyToClipboard(prompt.promptText || prompt.title);

  if (!success) {
    utils.showToast('Ошибка копирования', 'error');
    return;
  }

  utils.showToast('Промпт скопирован. Вставьте его в чат с ботом');

  // 🔒 Если пользователь уже копировал этот промпт раньше — не увеличиваем счётчик повторно
  if (Number(prompt.copies || 0) > 0) {
    return;
  }

  try {
    const res = await callEdge(PROMPT_COPY_URL, { prompt_id: prompt.id });
    const copiesByUser = Number(res?.copies_by_user ?? res?.copies ?? res?.count ?? 1) || 1;
    prompt.copies = copiesByUser;

    // синхроним модалку
    const el = document.getElementById('promptModalCopies');
    if (el) el.textContent = String(prompt.copies || 0);

    // синхроним карточку/статы без перерендера всего списка
    onPromptMetricsChanged(prompt.id);
  } catch (e) {
    console.warn("prompt_copy failed:", e);
  }
}

// НОВАЯ ФУНКЦИЯ: Копирование промпта напрямую из карточки
async function copyPromptDirectly(promptId) {
  const prompt = state.prompts.find(p => p.id === promptId);
  if (!prompt) return;

  const success = await utils.copyToClipboard(prompt.promptText || prompt.title);

  if (!success) {
    utils.showToast('Ошибка копирования', 'error');
    return;
  }

  utils.showToast('Промпт скопирован. Вставьте его в чат с ботом');

  // 🔒 Если пользователь уже копировал этот промпт раньше — не увеличиваем счётчик повторно
  if (Number(prompt.copies || 0) > 0) {
    return;
  }

  try {
    const res = await callEdge(PROMPT_COPY_URL, { prompt_id: prompt.id });
    const copiesByUser = Number(res?.copies_by_user ?? res?.copies ?? res?.count ?? 1) || 1;
    prompt.copies = copiesByUser;
  } catch (e) {
    console.warn("prompt_copy failed:", e);
  }

  onPromptMetricsChanged(promptId);
}

function setupCarouselSwipe() {
  const carousel = document.getElementById('promptCarousel');
  if (!carousel) return;

  let startX = 0;
  let isDown = false;

  carousel.addEventListener('touchstart', (e) => {
    isDown = true;
    startX = e.touches[0].clientX;
  }, { passive: true });

  carousel.addEventListener('touchend', (e) => {
    if (!isDown) return;

    isDown = false;
    const endX = e.changedTouches[0]?.clientX || startX;
    const distance = endX - startX;

    if (Math.abs(distance) > CONFIG.MIN_SWIPE_DISTANCE) {
      distance > 0 ? modal.prev() : modal.next();
    }
  }, { passive: true });
}

// Конструктор промптов (без изменений)
function initPromptBuilder() {
  const builderData = {
    pose: {
      key: 'pose',
      type: 'radio',
      title: 'Действие и поза',
      desc: 'Выберите основную позу персонажа',
      icon: '🧍',
      options: [
        { value: 'Стоит', icon: '🧍', text: 'Стоит' },
        { value: 'Сидит', icon: '🪑', text: 'Сидит' },
        { value: 'Идёт', icon: '🚶', text: 'Идёт' },
        { value: 'Держит предмет', icon: '✋', text: 'Держит предмет' },
        { value: 'Расслабленная поза', icon: '😌', text: 'Расслабленная поза' },
        { value: 'Динамичная поза', icon: '⚡', text: 'Динамичная поза' }
      ]
    },
    clothes: {
      key: 'clothes',
      type: 'multi',
      title: 'Одежда',
      desc: 'Можно выбрать несколько вариантов',
      icon: '👕',
      options: [
        { value: 'Классический костюм', icon: '🤵', text: 'Классический костюм' },
        { value: 'Смокинг', icon: '🎩', text: 'Смокинг' },
        { value: 'Блейзер с брюками', icon: '👔', text: 'Блейзер с брюками' },
        { value: 'Вечернее платье', icon: '👗', text: 'Вечернее платье' },
        { value: 'Худи', icon: '🧥', text: 'Худи' },
        { value: 'Кожаная куртка', icon: '🧥', text: 'Кожаная куртка' },
        { value: 'Джинсовка', icon: '🧢', text: 'Джинсовка' },
        { value: 'Футболка', icon: '👕', text: 'Футболка' },
        { value: 'Спортивная одежда', icon: '🏃', text: 'Спортивная одежда' },
        { value: 'Винтаж', icon: '🕰️', text: 'Винтаж' },
        { value: 'Бохо стиль', icon: '🌸', text: 'Бохо стиль' },
        { value: 'Минимализм', icon: '⚪', text: 'Минимализм' }
      ]
    },
    location: {
      key: 'location',
      type: 'multi',
      title: 'Локация',
      desc: 'Можно выбрать несколько',
      icon: '📍',
      options: [
        { value: 'Неоновая улица', icon: '🌃', text: 'Неоновая улица' },
        { value: 'Крыша с видом на город', icon: '🏙️', text: 'Крыша с видом на город' },
        { value: 'Стена с граффити', icon: '🎨', text: 'Стена с граффити' },
        { value: 'Современный офис', icon: '🏢', text: 'Современный офис' },
        { value: 'Люксовый лаунж', icon: '🛋️', text: 'Люксовый лаунж' },
        { value: 'Дождливая улица', icon: '🌧️', text: 'Дождливая улица' },
        { value: 'Мощёная улица', icon: '🧱', text: 'Мощёная улица' },
        { value: 'Индустриальный лофт', icon: '🏗️', text: 'Индустриальный лофт' }
      ]
    },
    time: {
      key: 'time',
      type: 'radio',
      title: 'Время суток',
      desc: 'Выберите время',
      icon: '🕒',
      options: [
        { value: 'Золотой час', icon: '🌅', text: 'Золотой час' },
        { value: 'Рассвет', icon: '🌄', text: 'Рассвет' },
        { value: 'Закат', icon: '🌇', text: 'Закат' },
        { value: 'Синий час (сумерки)', icon: '🌆', text: 'Синий час (сумерки)' },
        { value: 'Полдень', icon: '☀️', text: 'Полдень' },
        { value: 'Ночь', icon: '🌙', text: 'Ночь' }
      ]
    },
    lighting: {
      key: 'lighting',
      type: 'multi',
      title: 'Освещение',
      desc: 'Можно выбрать несколько',
      icon: '💡',
      options: [
        { value: 'Естественный свет', icon: '☀️', text: 'Естественный свет' },
        { value: 'Свет золотого часа', icon: '🌅', text: 'Свет золотого часа' },
        { value: 'Неоновый свет', icon: '💡', text: 'Неоновый свет' },
        { value: 'Студийное освещение', icon: '🎛️', text: 'Студийное освещение' },
        { value: 'Уличное освещение', icon: '🏙️', text: 'Уличное освещение' },
        { value: 'Свет свечей', icon: '🕯️', text: 'Свет свечей' },
        { value: 'Гирлянды', icon: '✨', text: 'Гирлянды' }
      ]
    }
  };

  const builderState = {
    pose: '',
    clothes: new Set(),
    location: new Set(),
    time: '',
    lighting: new Set()
  };

  const elements = {
    sections: document.getElementById('pbSections'),
    prompt: document.getElementById('pbPrompt'),
    progressFill: document.getElementById('pbProgressFill'),
    progressPercent: document.getElementById('pbProgressPercent'),
    charCount: document.getElementById('pbCharCount'),
    notification: document.getElementById('pbNotification'),
    copyBtn: document.getElementById('pbCopyBtn'),
    resetBtn: document.getElementById('pbResetBtn'),
    expandBtn: document.getElementById('pbExpandBtn'),
    collapseBtn: document.getElementById('pbCollapseAllBtn')
  };

  // Генерация секций
  elements.sections.innerHTML = Object.values(builderData).map(section => `
    <div class="pb-section" data-section>
      <button class="pb-section__head" type="button" data-toggle="${section.key}">
        <div class="pb-section__head-left">
          <span class="pb-section__icon">${section.icon}</span>
          <div class="pb-section__title-wrap">
            <div class="pb-section__title">${section.title}</div>
            <div class="pb-section__desc">${section.desc}</div>
          </div>
        </div>
        <div class="pb-section__head-right">
          ${section.type === 'radio' 
            ? `<span class="pb-section__current" data-key="${section.key}">${builderState[section.key] || 'Не выбрано'}</span>`
            : `<span class="pb-section__counter" data-key="${section.key}" style="display:${builderState[section.key].size > 0 ? 'flex' : 'none'}">${builderState[section.key].size}</span>`
          }
          <span class="pb-section__arrow">▼</span>
        </div>
      </button>
      <div class="pb-section__body" data-body="${section.key}">
        ${section.type === 'multi' ? '<div class="pb-section__note">Можно выбрать несколько</div>' : ''}
        <div class="pb-pills ${section.type === 'radio' ? 'pb-radio' : 'pb-multi'}" data-key="${section.key}">
          ${section.options.map(opt => `
            <button class="pb-pill ${(section.type === 'radio' && builderState[section.key] === opt.value) || 
                                    (section.type === 'multi' && builderState[section.key].has(opt.value)) ? 'is-active' : ''}" 
                    type="button" data-value="${opt.value}">
              <span class="pb-pill__icon">${opt.icon}</span>
              <span class="pb-pill__text">${opt.text}</span>
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `).join('');

  function updateProgress() {
    const sections = Object.keys(builderData);
    const filled = sections.filter(key => {
      const value = builderState[key];
      return value instanceof Set ? value.size > 0 : value && value.trim() !== '';
    }).length;
    
    const percentage = Math.round((filled / sections.length) * 100);
    elements.progressFill.style.width = `${percentage}%`;
    elements.progressPercent.textContent = `${percentage}%`;
    
    // Обновление счетчиков
    document.querySelectorAll('.pb-section__current[data-key="pose"]').forEach(el => {
      el.textContent = builderState.pose || 'Не выбрано';
    });
    
    document.querySelectorAll('.pb-section__current[data-key="time"]').forEach(el => {
      el.textContent = builderState.time || 'Не выбрано';
    });
    
    ['clothes', 'location', 'lighting'].forEach(key => {
      const counterEls = document.querySelectorAll(`.pb-section__counter[data-key="${key}"]`);
      const count = builderState[key].size;
      counterEls.forEach(el => {
        el.style.display = count > 0 ? 'flex' : 'none';
        el.textContent = String(count);
      });
    });
  }

  function buildPrompt() {
    const base = "Сгенерируй фотореалистичное фото по описанию.";
    const parts = [];
    
    if (builderState.pose) parts.push(`Поза/действие: ${builderState.pose}`);
    if (builderState.clothes.size) parts.push(`Одежда: ${Array.from(builderState.clothes).join(', ')}`);
    if (builderState.location.size) parts.push(`Локация: ${Array.from(builderState.location).join(', ')}`);
    if (builderState.time) parts.push(`Время суток: ${builderState.time}`);
    if (builderState.lighting.size) parts.push(`Освещение: ${Array.from(builderState.lighting).join(', ')}`);
    
    if (parts.length === 0) {
      elements.charCount.textContent = '0';
      elements.prompt.value = '';
      return '';
    }

    const result = `${base}\n\n${parts.map(p => `• ${p}`).join('\n')}\n\nКачество: high detail, sharp, natural skin texture.`;
    
    elements.charCount.textContent = result.length.toLocaleString();
    elements.prompt.value = result.trim();
    
    return result;
  }

  function showNotification(text, isError = false) {
    elements.notification.textContent = text;
    elements.notification.style.background = isError ? '#ef4444' : '#10B981';
    elements.notification.classList.add('show');
    
    setTimeout(() => {
      elements.notification.classList.remove('show');
    }, 2000);
  }

  function resetBuilder() {
    builderState.pose = '';
    builderState.time = '';
    builderState.clothes.clear();
    builderState.location.clear();
    builderState.lighting.clear();
    
    document.querySelectorAll('.pb-pill').forEach(pill => {
      pill.classList.remove('is-active');
    });
    
    buildPrompt();
    updateProgress();
    showNotification('Настройки конструктора сброшены');
  }

  function resetBuilderSilent(collapseAll = true) {
    builderState.pose = '';
    builderState.time = '';
    builderState.clothes.clear();
    builderState.location.clear();
    builderState.lighting.clear();

    // Обновляем UI после сброса
    document.querySelectorAll('.pb-pill.is-active').forEach(pill => {
      pill.classList.remove('is-active');
    });

    buildPrompt();
    updateProgress();
    elements.notification.classList.remove('show');

    if (collapseAll) {
      document.querySelectorAll('#pbSections [data-section]')
        .forEach((section) => section.classList.add('is-collapsed'));
    }
  }

  elements.sections.addEventListener('click', (e) => {
    const target = e.target;
    
    const toggleBtn = target.closest('[data-toggle]');
    if (toggleBtn) {
      const section = toggleBtn.closest('[data-section]');
      section.classList.toggle('is-collapsed');
      return;
    }
    
    const pill = target.closest('.pb-pill');
    if (pill) {
      const group = pill.closest('.pb-pills');
      const key = group.dataset.key;
      const value = pill.dataset.value;
      
      if (group.classList.contains('pb-radio')) {
        document.querySelectorAll(`.pb-pills[data-key="${key}"] .pb-pill`).forEach(p => {
          p.classList.remove('is-active');
        });
        pill.classList.add('is-active');
        builderState[key] = value;
      } else {
        if (pill.classList.contains('is-active')) {
          pill.classList.remove('is-active');
          builderState[key].delete(value);
        } else {
          pill.classList.add('is-active');
          builderState[key].add(value);
        }
      }
      
      buildPrompt();
      updateProgress();
    }
  });

  elements.copyBtn.addEventListener('click', async () => {
    const success = await utils.copyToClipboard(elements.prompt.value);
    
    if (success) {
      showNotification('Промпт скопирован. Вставьте его в чат с ботом');
    } else {
      showNotification('Не удалось скопировать', true);
    }
  });

  elements.resetBtn.addEventListener('click', resetBuilder);
  
  elements.expandBtn.addEventListener('click', () => {
    elements.prompt.style.minHeight = elements.prompt.style.minHeight === '320px' ? '140px' : '320px';
  });
  
  elements.collapseBtn.addEventListener('click', () => {
    document.querySelectorAll('[data-section]').forEach(section => {
      section.classList.add('is-collapsed');
    });
  });

  resetBuilderSilent(true);

  window.__promptBuilder = {
    resetOnOpen: () => resetBuilderSilent(true)
  };
}

// Инициализация приложения
function initApp() {
  setTimeout(async () => {
    initTelegramWebApp();
    initPrompts();

    // 1) СНАЧАЛА грузим промпты (иначе список пустой и запросов нет)
    await loadPrompts();

    // 2) Профиль — опционально (только в Telegram WebApp)
    try {
      runtimeProfile = await fetchProfileFromAPI();
    } catch (e) {
      runtimeProfile = null;
    }

    // Домашние цифры из профиля (если нет — будет демо, как и раньше)
    const p = getProfileForUI();
    dom.invitedCount.textContent = p.referrals_count ?? p.referrals ?? 0;
    dom.earnedBonuses.textContent = p.bonus_total ?? p.earnedBonuses ?? 0;
    dom.bonusBalance.textContent = p.bonus_balance ?? p.bonusBalance ?? 0;

    const refCode = (p.ref_code ?? '').toString().trim();
    // Реферальную ссылку показываем ТОЛЬКО при авторизации через Telegram WebApp
    if (isTelegramAuthorized() && refCode) {
      dom.referralLink.value = `https://t.me/iiavabot?start=ref_${refCode}`;
    } else {
      dom.referralLink.value = '';
    }

    initPromptBuilder();
  }, CONFIG.INIT_DELAY);
}


// Настройка обработчиков событий
function setupEventListeners() {
  // Поиск с debounce
  dom.searchInput.addEventListener('input', utils.debounce(() => {
    state.searchQuery = dom.searchInput.value.trim();
    updatePrompts();
  }, CONFIG.DEBOUNCE_DELAY));

  // Фильтры категорий
  dom.filterTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.filter-tab');
    if (!tab) return;

    const category = tab.dataset.category;
    state.activeCategories = new Set([category]);

    renderCategories();
    updatePrompts();
  });

  // Сортировка
  dom.sortSelect.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    updatePrompts();
  });

  // Кнопка избранного
  dom.favoritesBtn.addEventListener('click', () => {
    state.showOnlyFavorites = !state.showOnlyFavorites;
    updatePrompts();
    utils.showToast(
      state.showOnlyFavorites
        ? 'Показаны только избранные промпты'
        : 'Показаны все промпты'
    );
  });

  // Карточки промптов с обработкой кнопок копирования и избранного
  dom.cardsGrid.addEventListener('click', async (e) => {
    // Обработка кнопки копирования
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const id = parseInt(copyBtn.dataset.id);
      copyPromptDirectly(id);
      return;
    }

    // Обработка кнопки избранного
    const favBtn = e.target.closest('.favorite-btn');
    if (favBtn) {
      const id = parseInt(favBtn.dataset.id);
      await toggleFavoriteEdge(id);
      return;
    }

    // Обработка клика по карточке
    const card = e.target.closest('.prompt-card');
    if (card) {
      const id = parseInt(card.dataset.id);
      modal.openPrompt(id);
    }
  });

  // Копирование реферальной ссылки
  dom.copyReferralBtn.addEventListener('click', async () => {
    const link = (dom.referralLink.value || '').trim();

    if (!link) {
      utils.showToast('Реферальная ссылка доступна после входа через Telegram', 'error');
      return;
    }

    const success = await utils.copyToClipboard(link);

    if (success) {
      utils.showToast('Ссылка скопирована');
      dom.copyReferralBtn.classList.add('is-copied');
      setTimeout(() => dom.copyReferralBtn.classList.remove('is-copied'), 650);
    } else {
      utils.showToast('Ошибка копирования', 'error');
    }
  });

  // Профиль
  dom.profileBtn.addEventListener('click', () => {
    dom.profileModalOverlay.lastFocusedElement = dom.profileBtn;
    modal.openProfile();
  });

  document.getElementById('profileModalClose').addEventListener('click', () => modal.close(dom.profileModalOverlay));
  dom.profileModalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.profileModalOverlay) modal.close(dom.profileModalOverlay);
  });

  document.getElementById('profileCopyReferralBtn').addEventListener('click', async () => {
    const link = document.getElementById('profileReferralLink').value;
    const success = await utils.copyToClipboard(link);

    if (success) {
      utils.showToast('Ссылка скопирована');
    } else {
      utils.showToast('Ошибка копирования', 'error');
    }
  });

  // Модальное окно промпта
  document.getElementById('promptModalClose').addEventListener('click', () => modal.close(dom.promptModalOverlay));
  dom.promptModalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.promptModalOverlay) modal.close(dom.promptModalOverlay);
  });

  document.getElementById('promptPrevBtn').addEventListener('click', () => modal.prev());
  document.getElementById('promptNextBtn').addEventListener('click', () => modal.next());
  document.getElementById('promptModalCopyBtn').addEventListener('click', copyCurrentPrompt);
  document.getElementById('promptModalFavBtn').addEventListener('click', toggleCurrentFavorite);

  // Конструктор - обе кнопки (десктопная и мобильная)
  dom.generateBtn.addEventListener('click', () => {
    dom.constructorModalOverlay.lastFocusedElement = dom.generateBtn;
    modal.openConstructor();
  });

  dom.mobileGenerateBtn.addEventListener('click', () => {
    dom.constructorModalOverlay.lastFocusedElement = dom.mobileGenerateBtn;
    modal.openConstructor();
  });

  dom.tryFreeBtn.addEventListener('click', () => {
    dom.constructorModalOverlay.lastFocusedElement = dom.tryFreeBtn;
    modal.openConstructor();
  });

  document.getElementById('constructorModalClose').addEventListener('click', () => modal.close(dom.constructorModalOverlay));
  dom.constructorModalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.constructorModalOverlay) modal.close(dom.constructorModalOverlay);
  });

  // Туториал
  if (dom.tutorialGotItBtn) {
    dom.tutorialGotItBtn.addEventListener('click', () => modal.closeTutorial());
  }

  if (dom.tutorialModalOverlay) {
    dom.tutorialModalOverlay.addEventListener('click', (e) => {
      if (e.target === dom.tutorialModalOverlay) modal.closeTutorial();
    });
  }

  // Глобальные события клавиатуры
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dom.tutorialModalOverlay.classList.contains('show')) {
        modal.closeTutorial();
      } else if (dom.constructorModalOverlay.classList.contains('show')) {
        modal.close(dom.constructorModalOverlay);
      } else if (dom.profileModalOverlay.classList.contains('show')) {
        modal.close(dom.profileModalOverlay);
      } else if (dom.promptModalOverlay.classList.contains('show')) {
        modal.close(dom.promptModalOverlay);
      }
    }

    if (dom.promptModalOverlay.classList.contains('show')) {
      if (e.key === 'ArrowLeft') modal.prev();
      if (e.key === 'ArrowRight') modal.next();
    }
  });

  // Swipe для карусели
  setupCarouselSwipe();
}

// Функция для перемещения баннера на мобильных устройствах
function moveBannerForMobile() {
  const banner = document.querySelector('.hero-banner');
  const container = document.querySelector('.container');
  const header = document.querySelector('header');

  if (!banner || !container || !header) return;

  if (window.innerWidth <= 768) {
    if (!banner.classList.contains('moved-to-bottom')) {
      container.after(banner);
      banner.classList.add('moved-to-bottom');
      banner.style.marginTop = '0';
      banner.style.marginBottom = '24px';
    }
  } else {
    if (banner.classList.contains('moved-to-bottom')) {
      header.after(banner);
      banner.classList.remove('moved-to-bottom');
      banner.style.marginTop = '32px';
      banner.style.marginBottom = '';
    }
  }
}

// Запуск приложения
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  setupEventListeners();

  // Показать туториал при загрузке (с небольшой задержкой)
  setTimeout(() => {
    modal.openTutorial();
  }, 1000);

  window.addEventListener('resize', () => {
    if (dom.promptModalOverlay.classList.contains('show')) {
      syncPromptModalStatsPlacement();
    }
    moveBannerForMobile();
  });

  // Перенос баннера при загрузке
  moveBannerForMobile();
});


// --- debug exports ---
try {
  window.__app = {
    initApp,
    fetchPromptsFromAPI: (typeof fetchPromptsFromAPI === 'function') ? fetchPromptsFromAPI : null,
    loadPrompts: (typeof loadPrompts === 'function') ? loadPrompts : null,
    callEdge: (typeof callEdge === 'function') ? callEdge : null,
    getTelegramInitData: (typeof getTelegramInitData === 'function') ? getTelegramInitData : null,
  };
  console.log("window.__app ready", window.__app);
} catch (e) {
  console.warn("debug export failed", e);
}
