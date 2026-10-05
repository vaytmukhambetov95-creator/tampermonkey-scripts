// ==UserScript==
// @name         amoCRM - Promo Codes & Bonus Manager
// @namespace    http://tampermonkey.net/
// @version      3.6.1
// @description  Управление промокодами, бонусными баллами, подарочными сертификатами и подписками в amoCRM: проверка, списание, аналитика кэшбека, применения промокодов и замен по флористам
// @author       Вы
// @match        https://*.amocrm.ru/*
// @match        https://*.kommo.com/*
// @updateURL    https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20Promo%20Codes%20Manager.user.js
// @downloadURL  https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20Promo%20Codes%20Manager.user.js
// @grant        GM.xmlHttpRequest
// @connect      fonts.gstatic.com
// @connect      raw.githubusercontent.com
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      myskladandamocrm.ru
// @connect      *.amocrm.ru
// @connect      *.kommo.com
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const PROMO_FIELD_ID = 3025067;
    const BONUS_FIELD_ID = 2959149;
    const FLORIST_FIELD_ID = 2952775;          // списковое поле «Флорист» в сделке
    const REPLACEMENT_CODE = 'замена';         // код-маркер замены (сравнение регистронезависимо)
    const CACHE_DURATION = 10 * 60 * 1000;
    const ADMIN_PASSWORD = '4567';
    const SCRIPT_VERSION = '3.4.0';

    // Категории причин для начисления бонусов
    const REASON_CATEGORIES = {
        delivery: { key: 'delivery', label: 'Проблемы с доставкой' },
        quality: { key: 'quality', label: 'Завял букет, проблема с качеством' },
        card: { key: 'card', label: 'Жалобы на подпись в открытке и прочие моменты' },
        other_problems: { key: 'other_problems', label: 'Прочие проблемы' },
        custom: { key: 'custom', label: 'Другое' }
    };

    // URL Google Apps Script по умолчанию (можно изменить в настройках)
    const DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxgjarqYaSwLNQPt0jXnBp3HbFZtjbhVwJxxn0_Pfy7eIVjxbEZnHlWHlaEERZFmvUj/exec';
    
    let promoCodesCache = [];
    let amoCRMPromoCodes = [];
    let webAppUrl = '';
    let currentLeadBudget = 0;
    let isAdminAuthorized = false;
    let currentContactId = null;
    let currentContactName = '';
    let currentBonusPoints = 0;
    let bonusRequestsCache = [];

    // ==== Оформление интерфейса ====

    const FONT_FAMILY = "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    // Вариативный Manrope: два woff2 (кириллица + латиница) на все начертания.
    // Вшиваем как data-URI - внешний <link> на Google Fonts не пропустит CSP amoCRM.
    const FONT_SOURCES = [
        { range: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
          url: 'https://fonts.gstatic.com/s/manrope/v20/xn7gYHE41ni1AdIRggOxSvfedN62Zw.woff2' },
        { range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
          url: 'https://fonts.gstatic.com/s/manrope/v20/xn7gYHE41ni1AdIRggexSvfedN4.woff2' }
    ];
    const FONT_CACHE_KEY = 'orange_font_manrope_v1';   // общий кэш с юзерскриптом каталога

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function fetchFontAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                onload: (response) => {
                    if (response.status !== 200) { reject(new Error(String(response.status))); return; }
                    try { resolve(arrayBufferToBase64(response.response)); } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('сеть')),
                timeout: 20000
            });
        });
    }

    async function injectFont() {
        if (document.getElementById('pcx-font') || document.getElementById('ocx-font')) return;

        let payload = null;
        try {
            payload = JSON.parse(localStorage.getItem(FONT_CACHE_KEY) || 'null');
        } catch (error) {
            payload = null;
        }

        if (!payload || payload.length !== FONT_SOURCES.length) {
            try {
                payload = await Promise.all(FONT_SOURCES.map(src => fetchFontAsBase64(src.url)));
                localStorage.setItem(FONT_CACHE_KEY, JSON.stringify(payload));
            } catch (error) {
                console.warn('Manrope не загрузился, используем системный шрифт:', error);
                return;
            }
        }

        const style = document.createElement('style');
        style.id = 'pcx-font';
        style.textContent = payload.map((base64, i) => `
            @font-face {
                font-family: 'Manrope';
                font-style: normal;
                font-weight: 400 800;
                font-display: swap;
                src: url(data:font/woff2;base64,${base64}) format('woff2');
                unicode-range: ${FONT_SOURCES[i].range};
            }
        `).join('');
        document.head.appendChild(style);
    }

    // Раз в час сверяем свою версию с той, что лежит на GitHub: менеджеру не надо
    // ни лезть в панель Tampermonkey, ни ждать суточной автопроверки.
    const SCRIPT_RAW_URL = 'https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20Promo%20Codes%20Manager.user.js';
    const UPDATE_CHECKED_KEY = 'promo_manager_update_checked_at';
    const UPDATE_SNOOZED_KEY = 'promo_manager_update_snoozed';
    const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;   // не чаще раза в час
    const UPDATE_SNOOZE_TIME = 24 * 60 * 60 * 1000; // «Позже» - молчим сутки про эту версию

    // Сравнение версий вида 3.1.0: >0 если a новее b
    function compareVersions(a, b) {
        const pa = String(a).split('.').map(n => parseInt(n) || 0);
        const pb = String(b).split('.').map(n => parseInt(n) || 0);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const diff = (pa[i] || 0) - (pb[i] || 0);
            if (diff !== 0) return diff;
        }
        return 0;
    }

    function fetchLatestVersion() {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: `${SCRIPT_RAW_URL}?t=${Date.now()}`,
                headers: { 'Range': 'bytes=0-2047' },   // шапки хватает, файл целиком не тянем
                onload: (response) => {
                    const match = /@version\s+([\d.]+)/.exec(response.responseText || '');
                    match ? resolve(match[1]) : reject(new Error('версия не найдена'));
                },
                onerror: () => reject(new Error('сеть')),
                timeout: 15000
            });
        });
    }

    function showUpdateBanner(latest) {
        if (document.getElementById('pcx-update-banner')) return;

        injectStyles();
        const banner = document.createElement('div');
        banner.id = 'pcx-update-banner';
        banner.className = 'pcx pcx-update';
        banner.innerHTML = `
            <div class="pcx-update__title">Вышла новая версия промокодов</div>
            <div class="pcx-update__text">Установлена ${SCRIPT_VERSION}, доступна ${latest}. Нажмите «Обновить» - откроется вкладка Tampermonkey, там нажмите кнопку обновления.</div>
            <div class="pcx-update__actions">
                <button class="pcx-btn pcx-btn--ghost" data-act="later">Позже</button>
                <button class="pcx-btn pcx-btn--primary" data-act="update">Обновить</button>
            </div>
        `;

        banner.querySelector('[data-act="update"]').onclick = () => {
            window.open(SCRIPT_RAW_URL, '_blank');
            banner.remove();
        };
        banner.querySelector('[data-act="later"]').onclick = () => {
            try {
                localStorage.setItem(UPDATE_SNOOZED_KEY, JSON.stringify({ version: latest, until: Date.now() + UPDATE_SNOOZE_TIME }));
            } catch (error) { /* не критично */ }
            banner.remove();
        };

        document.body.appendChild(banner);
    }

    async function checkForScriptUpdate() {
        try {
            const checkedAt = parseInt(localStorage.getItem(UPDATE_CHECKED_KEY)) || 0;
            if (Date.now() - checkedAt < UPDATE_CHECK_INTERVAL) return;
            localStorage.setItem(UPDATE_CHECKED_KEY, String(Date.now()));

            const latest = await fetchLatestVersion();
            if (compareVersions(latest, SCRIPT_VERSION) <= 0) return;

            const snoozed = JSON.parse(localStorage.getItem(UPDATE_SNOOZED_KEY) || 'null');
            if (snoozed && snoozed.version === latest && Date.now() < snoozed.until) return;

            console.log(`Промокоды: доступна версия ${latest}, установлена ${SCRIPT_VERSION}`);
            showUpdateBanner(latest);
        } catch (error) {
            console.warn('Проверка обновлений не удалась:', error);
        }
    }

    // Тонкие иконки вместо эмодзи
    const ICONS = {
        close: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
        plus: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
        minus: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
        refresh: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9"/><path d="M13.5 2.5V5H11"/></svg>',
        save: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5a1 1 0 011-1h7.6L13.5 5v7.5a1 1 0 01-1 1h-9a1 1 0 01-1-1z"/><path d="M5.5 2.5v4h5v-4M5.5 13.5v-3.5h5v3.5"/></svg>',
        chart: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5h11"/><path d="M4.5 11V7M8 11V3.5M11.5 11V8.5"/></svg>',
        lock: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>',
        unlock: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 014.9-.7"/></svg>',
        exit: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 13.5h-3a1 1 0 01-1-1v-9a1 1 0 011-1h3"/><path d="M10 11l3-3-3-3M13 8H6"/></svg>',
        sync: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5h9L9 4"/><path d="M13.5 9.5h-9L7 12"/></svg>',
        link: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3"/><path d="M7.5 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M8.5 11.5l-1 1a2.5 2.5 0 01-3.5-3.5l1-1"/></svg>',
        check: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
        cross: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
        gift: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="11" height="7" rx="1"/><path d="M2 6.5h12M8 6.5v7"/><path d="M8 6.5S7 2.5 5.2 3.1C4 3.5 4.4 6 8 6.5zM8 6.5s1-4 2.8-3.4C12 3.5 11.6 6 8 6.5z"/></svg>',
        clock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.2"/></svg>'
    };

    function injectStyles() {
        if (document.getElementById('pcx-styles')) return;

        const style = document.createElement('style');
        style.id = 'pcx-styles';
        style.textContent = `
            :root {
                --pcx-accent: #E6407A;
                --pcx-accent-hover: #CF356B;
                --pcx-accent-soft: #FDEFF4;
                --pcx-text: #16161A;
                --pcx-text-2: #6E6E7A;
                --pcx-text-3: #9C9CA8;
                --pcx-border: #E7E7EC;
                --pcx-border-strong: #D6D6DE;
                --pcx-surface: #FFFFFF;
                --pcx-surface-2: #F7F7F9;
                --pcx-ok: #2E9E63;
                --pcx-warn: #C77A18;
                --pcx-danger: #D64545;
            }

            /* Общий док для кнопок обоих юзерскриптов - чтобы стояли строго друг под другом */
            #orange-userscript-dock {
                position: fixed;
                z-index: 9998;
                display: flex;
                flex-direction: column;
                align-items: stretch;
                gap: 10px;
            }
            #orange-userscript-dock.dragging { cursor: grabbing; }
            #orange-userscript-dock.dragging button { pointer-events: none; }

            /* Плавающая кнопка */
            #promo-codes-main-btn {
                order: 1;
                min-width: 152px;
                justify-content: center;
                display: inline-flex;
                align-items: center;
                gap: 8px;
                height: 40px;
                padding: 0 18px;
                border: none;
                border-radius: 12px;
                background: var(--pcx-accent);
                color: #fff;
                font-family: ${FONT_FAMILY};
                font-size: 14px;
                font-weight: 600;
                letter-spacing: -0.01em;
                cursor: pointer;
                box-shadow: 0 6px 20px rgba(230, 64, 122, 0.28);
                transition: background 0.15s ease, box-shadow 0.15s ease;
            }
            #promo-codes-main-btn:hover { background: var(--pcx-accent-hover); box-shadow: 0 8px 24px rgba(230, 64, 122, 0.34); }

            /* Общая типографика внутри окон скрипта */
            #promo-codes-overlay, #promo-codes-overlay *,
            .pcx, .pcx * {
                font-family: ${FONT_FAMILY} !important;
                box-sizing: border-box;
                -webkit-font-smoothing: antialiased;
            }

            #promo-codes-overlay {
                position: fixed; inset: 0; z-index: 9999;
                background: rgba(18, 18, 26, 0.55);
            }
            #promo-codes-modal {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: min(960px, 94vw); max-height: 88vh;
                background: var(--pcx-surface);
                border-radius: 18px;
                box-shadow: 0 30px 80px rgba(16, 16, 28, 0.28);
                z-index: 10000;
                display: flex; flex-direction: column; overflow: hidden;
                isolation: isolate;
                color: var(--pcx-text);
            }

            .pcx-head {
                flex: 0 0 auto;
                display: flex; align-items: center; justify-content: space-between; gap: 16px;
                padding: 20px 24px; border-bottom: 1px solid var(--pcx-border);
                background: var(--pcx-surface); position: relative; z-index: 2;
            }
            .pcx-head__title { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.02em; color: var(--pcx-text); }
            .pcx-head__sub { margin: 3px 0 0; font-size: 13px; font-weight: 500; color: var(--pcx-text-3); }
            .pcx-iconbtn {
                display: inline-flex; align-items: center; justify-content: center;
                width: 34px; height: 34px; border: none; border-radius: 10px;
                background: transparent; color: var(--pcx-text-2); cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease;
            }
            .pcx-iconbtn:hover { background: var(--pcx-surface-2); color: var(--pcx-text); }

            /* Вкладки */
            .pcx-tabs {
                flex: 0 0 auto;
                display: flex; justify-content: center; flex-wrap: wrap; gap: 4px; padding: 8px 16px;
                border-bottom: 1px solid var(--pcx-border);
                background: var(--pcx-surface); position: relative; z-index: 2;
                box-shadow: 0 4px 10px rgba(18, 18, 30, 0.05);
                overflow-x: auto;
            }
            .promo-tab {
                flex: 0 0 auto;
                height: 36px; padding: 0 14px;
                border: none; border-radius: 9px; background: transparent;
                font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
                color: var(--pcx-text-2); cursor: pointer; white-space: nowrap;
                transition: background 0.15s ease, color 0.15s ease;
            }
            .promo-tab:hover { background: var(--pcx-surface-2); color: var(--pcx-text); }
            .promo-tab:focus { outline: none; }
            .promo-tab:focus-visible { outline: 2px solid var(--pcx-accent); outline-offset: 2px; }
            #promo-codes-overlay button:focus, #promo-codes-overlay input:focus,
            #promo-codes-overlay select:focus, #promo-codes-overlay textarea:focus { outline: none !important; }
            #promo-codes-overlay button:focus-visible { outline: 2px solid var(--pcx-accent) !important; outline-offset: 2px; }
            .promo-tab.active { background: var(--pcx-accent-soft); color: var(--pcx-accent); }

            #promo-modal-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 22px 24px 26px;
                position: relative; z-index: 0; contain: paint; }

            /* Приводим к общему виду то, что внутри вкладок собрано инлайновыми стилями */
            #promo-codes-overlay input[type="text"],
            #promo-codes-overlay input[type="number"],
            #promo-codes-overlay input[type="password"],
            #promo-codes-overlay input[type="date"],
            #promo-codes-overlay input[type="tel"],
            #promo-codes-overlay select,
            #promo-codes-overlay textarea {
                border: 1px solid var(--pcx-border) !important;
                border-radius: 10px !important;
                padding: 9px 12px !important;
                font-size: 14px !important;
                font-weight: 500 !important;
                color: var(--pcx-text) !important;
                background: var(--pcx-surface) !important;
                outline: none !important;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            #promo-codes-overlay input:focus,
            #promo-codes-overlay select:focus,
            #promo-codes-overlay textarea:focus {
                border-color: var(--pcx-accent) !important;
                box-shadow: 0 0 0 3px var(--pcx-accent-soft) !important;
            }
            #promo-codes-overlay input::placeholder,
            #promo-codes-overlay textarea::placeholder { color: var(--pcx-text-3) !important; font-weight: 500 !important; }

            #promo-codes-overlay button:not(.pcx-iconbtn):not(.promo-tab) {
                border-radius: 10px !important;
                border-width: 1px !important;
                font-size: 14px !important;
                font-weight: 600 !important;
                letter-spacing: -0.01em !important;
                box-shadow: none !important;
                transition: filter 0.15s ease, background 0.15s ease, border-color 0.15s ease !important;
            }
            #promo-codes-overlay button:not(.pcx-iconbtn):not(.promo-tab):hover { filter: brightness(0.94); }

            #promo-codes-overlay h2 { font-size: 17px !important; font-weight: 700 !important; letter-spacing: -0.02em !important; }
            #promo-codes-overlay h3 { font-size: 15px !important; font-weight: 600 !important; letter-spacing: -0.01em !important; color: var(--pcx-text) !important; }
            #promo-codes-overlay h4 { font-size: 14px !important; font-weight: 600 !important; color: var(--pcx-text) !important; }
            #promo-codes-overlay label { font-weight: 500 !important; }

            .pcx-btn {
                display: inline-flex; align-items: center; justify-content: center; gap: 7px;
                height: 38px; padding: 0 16px; border: 1px solid transparent; border-radius: 10px;
                font-size: 14px; font-weight: 600; letter-spacing: -0.01em; cursor: pointer;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            .pcx-btn--primary { background: var(--pcx-accent); color: #fff; }
            .pcx-btn--primary:hover { background: var(--pcx-accent-hover); }
            .pcx-btn--ghost { background: var(--pcx-surface); border-color: var(--pcx-border); color: var(--pcx-text-2); }
            .pcx-btn--ghost:hover { border-color: var(--pcx-border-strong); color: var(--pcx-text); }

            /* Плашка «вышла новая версия» */
            .pcx-update {
                position: fixed; right: 20px; top: 20px; z-index: 9997;
                width: 320px; padding: 16px 18px;
                background: var(--pcx-surface); border: 1px solid var(--pcx-border);
                border-radius: 14px; box-shadow: 0 18px 44px rgba(18, 18, 30, 0.18);
                animation: pcx-slide 0.22s ease-out;
            }
            .pcx-update__title { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; color: var(--pcx-text); margin-bottom: 4px; }
            .pcx-update__text { font-size: 12.5px; font-weight: 500; line-height: 1.45; color: var(--pcx-text-2); margin-bottom: 14px; }
            .pcx-update__actions { display: flex; gap: 8px; }
            .pcx-update__actions .pcx-btn { flex: 1; height: 34px; font-size: 13px; }

            /* Уведомления */
            .pcx-toast {
                position: fixed; top: 20px; right: 20px; z-index: 10005;
                display: flex; align-items: center; gap: 10px;
                max-width: 400px; padding: 13px 16px;
                border-radius: 12px; background: #17171C; color: #fff;
                font-size: 13.5px; font-weight: 500; line-height: 1.4;
                box-shadow: 0 16px 40px rgba(16, 16, 28, 0.28);
                animation: pcx-slide 0.22s ease-out;
            }
            .pcx-toast::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #4ECB8D; }
            .pcx-toast--error::before { background: #FF6B6B; }
            .pcx-toast--warning::before { background: #FFB454; }
            .pcx-toast--info::before { background: #6BA8FF; }
            @keyframes pcx-slide { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }

            /* ---------- Подписки и сертификаты (pcx-vx) ---------- */
            .pcx-vx { display: flex; flex-direction: column; gap: 16px; color: var(--pcx-text); }
            .pcx-vx-block { background: var(--pcx-surface-2); border-radius: 14px; padding: 16px 18px; }
            .pcx-vx-block > * + * { margin-top: 12px; }
            .pcx-vx-block__title { display: flex; align-items: center; justify-content: space-between; gap: 10px;
                margin: 0; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; color: var(--pcx-text); }
            .pcx-vx-subtitle { margin: 14px 0 8px; font-size: 13px; font-weight: 700; color: var(--pcx-text); }
            .pcx-vx-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            .pcx-vx-row > input { flex: 1 1 180px; min-width: 0; }
            .pcx-vx-between { justify-content: space-between; }
            .pcx-vx-muted { font-size: 12.5px; font-weight: 500; color: var(--pcx-text-3); line-height: 1.45; }
            .pcx-vx-hint { margin-top: 6px; }
            .pcx-vx-danger { color: var(--pcx-danger); }
            .pcx-vx-nowrap { white-space: nowrap; }
            .pcx-vx-note { padding: 10px 12px; border-radius: 10px; font-size: 13px; font-weight: 500; line-height: 1.45; }
            .pcx-vx-note--info { background: var(--pcx-surface); border: 1px solid var(--pcx-border); color: var(--pcx-text-2); }
            .pcx-vx-note--ok { background: #E6F4EC; color: #1E6B44; }
            .pcx-vx-note--warn { background: #FCF4E8; color: #A85F0F; }
            .pcx-vx-note--err { background: #FBECEC; color: #B23636; }

            .pcx-vx-pills { display: flex; flex-wrap: wrap; gap: 4px; }
            #promo-codes-overlay .pcx-vx button.pcx-vx-pill {
                height: 32px; padding: 0 12px; border: none; border-radius: 8px !important; background: transparent;
                font-size: 13px !important; color: var(--pcx-text-2); cursor: pointer; }
            #promo-codes-overlay .pcx-vx .pcx-vx-kinds button.pcx-vx-pill { height: 36px; padding: 0 14px; font-size: 13.5px !important; }
            #promo-codes-overlay .pcx-vx button.pcx-vx-pill:hover { background: var(--pcx-surface-2); color: var(--pcx-text); }
            #promo-codes-overlay .pcx-vx .pcx-vx-block button.pcx-vx-pill:hover { background: var(--pcx-surface); }
            #promo-codes-overlay .pcx-vx button.pcx-vx-pill.is-active { background: var(--pcx-accent-soft); color: var(--pcx-accent); }

            .pcx-vx-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
            .pcx-vx-stat { min-width: 0; padding: 12px 14px; background: var(--pcx-surface); border: 1px solid var(--pcx-border); border-radius: 12px; }
            .pcx-vx-stat__label { font-size: 12px; font-weight: 600; color: var(--pcx-text-3); }
            .pcx-vx-stat__value { margin-top: 4px; font-size: 19px; font-weight: 700; letter-spacing: -0.02em; color: var(--pcx-text); white-space: nowrap; }
            .pcx-vx-stat__value--accent { color: var(--pcx-accent); }
            .pcx-vx-stat__value--ok { color: var(--pcx-ok); }
            .pcx-vx-stat__sub { margin-top: 2px; font-size: 12px; font-weight: 500; color: var(--pcx-text-2); }

            .pcx-vx-card { padding: 16px 18px; background: var(--pcx-surface); border: 1px solid var(--pcx-border); border-radius: 12px; }
            .pcx-vx-card > * + * { margin-top: 14px; }
            .pcx-vx-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
            .pcx-vx-card__code { font-size: 22px; font-weight: 800; letter-spacing: 0.06em; color: var(--pcx-text); }
            .pcx-vx-card .pcx-vx-stat { background: var(--pcx-surface-2); border-color: transparent; }
            .pcx-vx-kv { display: grid; grid-template-columns: 150px 1fr; gap: 6px 14px; margin-left: 0; margin-right: 0; margin-bottom: 0; font-size: 13px; }
            .pcx-vx-modal .pcx-vx-card { padding: 0; border: none; }
            .pcx-vx-modal .pcx-vx-card__head { padding-right: 44px; } /* место под крестик окна */
            .pcx-vx-kv dt { color: var(--pcx-text-3); font-weight: 600; }
            .pcx-vx-kv dd { margin: 0; color: var(--pcx-text); font-weight: 500; word-break: break-word; }
            .pcx-vx-kv a, .pcx-vx-table a { color: var(--pcx-accent); font-weight: 600; text-decoration: none; }
            .pcx-vx-kv a:hover, .pcx-vx-table a:hover { text-decoration: underline; }
            .pcx-vx-action { padding: 12px 14px; background: var(--pcx-surface-2); border-radius: 12px; }
            .pcx-vx-action > * + * { margin-top: 10px; }
            .pcx-vx-action__title { font-size: 13.5px; font-weight: 700; color: var(--pcx-text); }
            #promo-codes-overlay .pcx-vx input.pcx-vx-amount { flex: 0 0 140px; }
            #promo-codes-overlay .pcx-vx input.pcx-vx-lead { flex: 0 0 120px; }
            #promo-codes-overlay .pcx-vx input.pcx-vx-code-input {
                font-size: 16px !important; font-weight: 700 !important; letter-spacing: 0.08em; text-transform: uppercase; }
            /* Строка фильтров: список и поиск одной высоты. У списка своя стрелка вместо системной -
               системная на macOS выглядела чужой и делала поле на 2px выше поиска. */
            .pcx-vx-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            #promo-codes-overlay .pcx-vx .pcx-vx-filters select,
            #promo-codes-overlay .pcx-vx .pcx-vx-filters input { height: 38px; margin: 0; }
            #promo-codes-overlay .pcx-vx .pcx-vx-filters input { flex: 1 1 220px; min-width: 0; }
            #promo-codes-overlay .pcx-vx select {
                -webkit-appearance: none; -moz-appearance: none; appearance: none;
                flex: 0 0 180px; cursor: pointer; line-height: 18px;
                padding: 0 34px 0 12px !important;
                background: var(--pcx-surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%239C9CA8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 12px center / 14px 14px !important;
            }
            /* Пустое состояние - белая карточка на серой подложке, как и остальное содержимое блока */
            .pcx-vx-empty { padding: 22px 16px; text-align: center; background: var(--pcx-surface);
                border: 1px solid var(--pcx-border); border-radius: 12px; }
            .pcx-vx-empty__title { font-size: 13.5px; font-weight: 600; color: var(--pcx-text-2); }
            .pcx-vx-empty__text { margin-top: 4px; font-size: 12.5px; font-weight: 500; color: var(--pcx-text-3); }

            .pcx-vx-tablewrap { overflow-x: auto; background: var(--pcx-surface); border: 1px solid var(--pcx-border); border-radius: 12px; }
            .pcx-vx-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .pcx-vx-table th { padding: 9px 12px; text-align: left; font-size: 12px; font-weight: 600; color: var(--pcx-text-3);
                border-bottom: 1px solid var(--pcx-border); white-space: nowrap; }
            .pcx-vx-table td { padding: 9px 12px; border-bottom: 1px solid var(--pcx-border); vertical-align: top;
                color: var(--pcx-text); font-weight: 500; }
            .pcx-vx-table tbody tr:last-child td { border-bottom: none; }
            .pcx-vx-table tr.is-click { cursor: pointer; }
            .pcx-vx-table tr.is-click:hover td { background: var(--pcx-surface-2); }
            .pcx-vx-num { text-align: right !important; white-space: nowrap; font-variant-numeric: tabular-nums; }
            .pcx-vx-plus { color: var(--pcx-ok) !important; }
            .pcx-vx-code { font-weight: 700; letter-spacing: 0.04em; white-space: nowrap; }
            .pcx-vx-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px;
                font-size: 12px; font-weight: 600; white-space: nowrap; }
            .pcx-vx-badge--active { background: #E6F4EC; color: #1E6B44; }
            .pcx-vx-badge--exhausted { background: #EEEEF2; color: var(--pcx-text-2); }
            .pcx-vx-badge--blocked { background: #FBECEC; color: #B23636; }

            .pcx-vx-minilist { display: flex; flex-direction: column; gap: 6px; }
            #promo-codes-overlay .pcx-vx button.pcx-vx-mini {
                display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; height: auto;
                padding: 10px 12px; background: var(--pcx-surface); border: 1px solid var(--pcx-border); color: var(--pcx-text);
                text-align: left; font-size: 13px !important; font-weight: 500 !important; cursor: pointer; }
            .pcx-vx-mini b { margin-left: 8px; font-weight: 700; }
            #promo-codes-overlay .pcx-vx button.pcx-vx-more { width: 100%; margin-top: 10px; }
            .pcx-btn--danger { background: var(--pcx-surface); border-color: var(--pcx-border); color: var(--pcx-danger); }

            .pcx-vx-modal-overlay { position: fixed; inset: 0; z-index: 10002; display: flex; align-items: center; justify-content: center;
                background: rgba(18, 18, 26, 0.45); }
            .pcx-vx-modal { position: relative; width: min(760px, 94vw); max-height: 88vh; overflow-y: auto; padding: 22px 24px 24px;
                background: var(--pcx-surface); border-radius: 16px; box-shadow: 0 30px 80px rgba(16, 16, 28, 0.3); }
            .pcx-vx-modal__close { position: absolute; top: 14px; right: 14px; }
            .pcx-vx-modal__title { margin: 0 40px 0 0; font-size: 17px; font-weight: 700; letter-spacing: -0.02em; color: var(--pcx-text); }
            .pcx-vx-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
            .pcx-vx-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
            .pcx-vx-field--wide { grid-column: 1 / -1; }
            #promo-codes-overlay .pcx-vx-field label { font-size: 12.5px; font-weight: 600 !important; color: var(--pcx-text-2); }
            .pcx-vx-field input, .pcx-vx-field textarea, .pcx-vx-field select { width: 100%; }
            .pcx-vx-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
            .pcx-vx-codebig { padding: 18px; border-radius: 12px; background: var(--pcx-surface-2); text-align: center;
                font-size: 28px; font-weight: 800; letter-spacing: 0.08em; color: var(--pcx-text); }
            @media (max-width: 640px) {
                .pcx-vx-form, .pcx-vx-kv { grid-template-columns: 1fr; }
            }
        `;
        document.head.appendChild(style);
    }

    // Общий док для плавающих кнопок: его создаёт тот скрипт, который загрузился первым,
    // второй просто добавляет свою кнопку. Так «Промокоды» и «Каталог» всегда друг под другом.
    const DOCK_ID = 'orange-userscript-dock';
    const DOCK_POSITION_KEY = 'orange_dock_position';

    function ensureButtonDock() {
        let dock = document.getElementById(DOCK_ID);
        if (dock) return dock;

        injectStyles();

        dock = document.createElement('div');
        dock.id = DOCK_ID;
        dock.className = 'pcx';
        document.body.appendChild(dock);

        // Возвращаем сохранённую позицию (её пишет тот скрипт, за чью кнопку перетащили док)
        const place = () => {
            let pos = null;
            try {
                pos = JSON.parse(localStorage.getItem(DOCK_POSITION_KEY) || 'null');
            } catch (error) {
                pos = null;
            }
            const width = dock.offsetWidth || 152;
            const height = dock.offsetHeight || 90;
            const x = pos ? Math.min(Math.max(pos.x, 0), window.innerWidth - width) : window.innerWidth - width - 20;
            const y = pos ? Math.min(Math.max(pos.y, 0), window.innerHeight - height) : window.innerHeight - height - 20;
            dock.style.left = `${x}px`;
            dock.style.top = `${y}px`;
        };
        place();
        window.addEventListener('resize', place);

        // Перетаскивается док целиком, за любую кнопку
        let isDragging = false;
        let hasMoved = false;
        let startX = 0, startY = 0, initialX = 0, initialY = 0;

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
                hasMoved = true;
                dock.classList.add('dragging');
            }
            const x = Math.max(0, Math.min(initialX + deltaX, window.innerWidth - dock.offsetWidth));
            const y = Math.max(0, Math.min(initialY + deltaY, window.innerHeight - dock.offsetHeight));
            dock.style.left = `${x}px`;
            dock.style.top = `${y}px`;
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            dock.classList.remove('dragging');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (hasMoved) {
                try {
                    localStorage.setItem(DOCK_POSITION_KEY, JSON.stringify({ x: dock.offsetLeft, y: dock.offsetTop }));
                } catch (error) { /* не критично */ }
            }
        };

        dock.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            initialX = dock.offsetLeft;
            initialY = dock.offsetTop;
            e.preventDefault();
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // После перетаскивания клик по кнопке не должен открывать окно
        dock.addEventListener('click', (e) => {
            if (hasMoved) {
                e.stopPropagation();
                e.preventDefault();
                hasMoved = false;
            }
        }, true);

        return dock;
    }

    function createPromoButton() {
        if (!window.location.href.includes('/leads/detail/')) return;

        injectStyles();

        if (document.getElementById('promo-codes-main-btn')) return;

        const button = document.createElement('button');
        button.id = 'promo-codes-main-btn';
        button.innerHTML = `${ICONS.gift}<span>Промокоды</span>`;
        button.onclick = async () => await openPromoModal();

        ensureButtonDock().appendChild(button);
    }

    const PROMO_TABS = [
        { key: 'check', label: 'Проверка' },
        { key: 'list', label: 'Промокоды' },
        { key: 'bonus', label: 'Бонусы' },
        { key: 'vouchers', label: 'Подписки и сертификаты' },
        { key: 'add', label: 'Добавить промокод' },
        { key: 'analytics', label: 'Аналитика' },
        { key: 'settings', label: 'Настройки' }
    ];

    function createPromoModal() {
        injectStyles();

        const overlay = document.createElement('div');
        overlay.id = 'promo-codes-overlay';
        overlay.style.display = 'none';
        overlay.onclick = (e) => {
            if (e.target === overlay) closePromoModal();
        };

        const modal = document.createElement('div');
        modal.id = 'promo-codes-modal';
        modal.innerHTML = `
            <div class="pcx-head">
                <div>
                    <h2 class="pcx-head__title">Промокоды и бонусы</h2>
                    <p class="pcx-head__sub">Проверка кодов, начисление баллов и аналитика</p>
                </div>
                <button id="close-promo-modal-btn" class="pcx-iconbtn" title="Закрыть">${ICONS.close}</button>
            </div>

            <div class="pcx-tabs">
                ${PROMO_TABS.map((tab, i) => `
                    <button class="promo-tab${i === 0 ? ' active' : ''}" data-tab="${tab.key}">${tab.label}</button>
                `).join('')}
            </div>

            <div id="promo-modal-content"></div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('close-promo-modal-btn').onclick = closePromoModal;

        modal.querySelectorAll('.promo-tab').forEach(btn => {
            btn.onclick = () => switchTab(btn.dataset.tab);
        });
    }

    function switchTab(tabName) {
        // Проверка прав администратора для вкладок "Добавить промокод" и "Аналитика"
        if ((tabName === 'add' || tabName === 'analytics') && !isAdminAuthorized) {
            showNotification('Доступ запрещён. Требуется авторизация администратора в разделе "Настройки"', 'warning');
            switchTab('settings');
            return;
        }

        document.querySelectorAll('.promo-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        const content = document.getElementById('promo-modal-content');
        if (tabName === 'check') {
            renderCheckTab(content);
        } else if (tabName === 'add') {
            renderAddTab(content);
        } else if (tabName === 'list') {
            renderListTab(content);
        } else if (tabName === 'bonus') {
            renderBonusTab(content);
        } else if (tabName === 'vouchers') {
            renderVouchersTab(content);
        } else if (tabName === 'analytics') {
            renderAnalyticsTab(content);
        } else if (tabName === 'settings') {
            renderSettingsTab(content);
        }
    }

    function renderCheckTab(container) {
        container.innerHTML = `
            <div style="max-width: 600px; margin: 0 auto;">
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокод:</label>
                    <input type="text" id="promo-code-input" placeholder="Введите промокод" 
                        style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Телефон клиента:</label>
                    <input type="text" id="client-phone-input" placeholder="+7 (999) 123-45-67" 
                        style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <div id="phone-hint" style="font-size: 12px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Телефон подтягивается автоматически из карточки контакта</div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Сумма заказа (опционально):</label>
                    <input type="number" id="order-amount-input" placeholder="5000" value="${currentLeadBudget}"
                        style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <div style="font-size: 12px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Бюджет автоматически подставлен из сделки</div>
                </div>

                <div id="employee-referral-block" style="display: none; margin-bottom: 20px; background: #F7F7F9; padding: 15px; border-radius: 10px; border: 1px solid #E7E7EC;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">От кого пришёл клиент:</label>
                    <select id="employee-referral-select" style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; background: white;">
                        <option value="">-- Выберите сотрудника --</option>
                    </select>
                    <div style="font-size: 12px; color: #E6407A; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Укажите сотрудника, чей друг использует промокод</div>
                </div>

                <button id="check-promo-btn" style="
                    width: 100%;
                    padding: 15px;
                    background: #E6407A;
                    color: white;
                    border: none;
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: 600;
                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                    margin-bottom: 20px;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Проверить промокод</button>
                
                <div id="promo-result" style="
                    padding: 20px;
                    border-radius: 10px;
                    display: none;
                "></div>
            </div>
        `;

        const checkBtn = document.getElementById('check-promo-btn');
        checkBtn.onclick = checkPromoCode;
        
        document.getElementById('promo-code-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') checkPromoCode();
        });

        // Обработчик для показа/скрытия блока "От кого пришёл"
        const promoCodeInput = document.getElementById('promo-code-input');
        const employeeReferralBlock = document.getElementById('employee-referral-block');
        const employeeReferralSelect = document.getElementById('employee-referral-select');

        promoCodeInput.addEventListener('input', async () => {
            const inputCode = promoCodeInput.value.trim().toUpperCase();
            const friendsCode = await GM.getValue('friendsPromoCode', '');

            if (friendsCode && inputCode === friendsCode.toUpperCase()) {
                // Показываем блок и заполняем список сотрудников
                employeeReferralBlock.style.display = 'block';

                // Загружаем список сотрудников из настроек
                const employeesList = await GM.getValue('employeesList', '');
                const employees = employeesList.split('\n').map(e => e.trim()).filter(e => e);

                // Очищаем и заполняем select
                employeeReferralSelect.innerHTML = '<option value="">-- Выберите сотрудника --</option>';
                employees.forEach(emp => {
                    const option = document.createElement('option');
                    option.value = emp;
                    option.textContent = emp;
                    employeeReferralSelect.appendChild(option);
                });
            } else {
                employeeReferralBlock.style.display = 'none';
            }
        });

        // Автозаполнение телефона из карточки контакта
        autoFillClientPhone();
    }

    function getContactPhoneFromPage() {
        // Ищем телефон в карточке контакта по селектору
        const phoneInput = document.querySelector('input.control-phone__formatted');
        if (phoneInput && phoneInput.value) {
            return phoneInput.value.trim();
        }

        // Альтернативный поиск по другим возможным селекторам
        const phoneInputAlt = document.querySelector('.linked-form__cf[type="text"][value*="+7"]');
        if (phoneInputAlt && phoneInputAlt.value) {
            return phoneInputAlt.value.trim();
        }

        // Поиск телефона в блоке контактов
        const contactPhone = document.querySelector('.card-cf-table__text_phone');
        if (contactPhone && contactPhone.textContent) {
            return contactPhone.textContent.trim();
        }

        return null;
    }

    function autoFillClientPhone() {
        const phoneInput = document.getElementById('client-phone-input');
        const phoneHint = document.getElementById('phone-hint');

        if (!phoneInput) return;

        const phone = getContactPhoneFromPage();

        if (phone) {
            phoneInput.value = phone;
            if (phoneHint) {
                phoneHint.textContent = 'Телефон подтянут автоматически из карточки контакта';
                phoneHint.style.color = '#28a745';
            }
            console.log('[Промокоды] Телефон автоматически заполнен:', phone);
        } else {
            if (phoneHint) {
                phoneHint.textContent = 'Телефон не найден в карточке контакта. Введите вручную';
                phoneHint.style.color = '#9C9CA8';
            }
            console.log('[Промокоды] Телефон не найден в карточке контакта');
        }
    }

    function renderAddTab(container) {
        container.innerHTML = `
            <div style="max-width: 600px; margin: 0 auto;">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокод:*</label>
                    <input type="text" id="new-promo-code" placeholder="MAMA3" 
                        style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; text-transform: uppercase; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Тип промокода:*</label>
                    <select id="new-promo-type" style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        <option value="многоразовый">Многоразовый</option>
                        <option value="одноразовый">Одноразовый</option>
                        <option value="персонализированный">Персонализированный</option>
                        <option value="условный">Условный</option>
                        <option value="сотрудника">Сотрудника</option>
                    </select>
                </div>
                
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom: 15px;">
                    <div>
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Скидка:*</label>
                        <input type="number" id="new-promo-discount" placeholder="10" 
                            style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Тип:</label>
                        <select id="new-promo-discount-type" style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            <option value="процент">%</option>
                            <option value="сумма">₽</option>
                        </select>
                    </div>
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Минимальная сумма заказа:</label>
                    <input type="number" id="new-promo-min-amount" placeholder="3000" 
                        style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Срок действия:</label>
                    <input type="date" id="new-promo-expiry" 
                        style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; background: white; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #16161A;">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Максимальное количество использований:</label>
                    <input type="number" id="new-promo-max-usage" placeholder="100" 
                        style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                </div>
                
                <div style="margin-bottom: 15px; display: none;" id="phone-binding-block">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Привязка к телефонам:</label>
                    <div id="phone-bindings-list" style="margin-bottom: 10px;"></div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end;">
                        <div>
                            <input type="text" id="new-phone-input" placeholder="+7 999 123-45-67"
                                style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        </div>
                        <div>
                            <input type="text" id="new-phone-name-input" placeholder="Имя (опционально)"
                                style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        </div>
                        <button type="button" id="add-phone-btn" style="
                            padding: 10px 15px;
                            background: #2E9E63;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            white-space: nowrap;
                        ">+ Добавить</button>
                    </div>
                    <div style="font-size: 12px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Добавьте телефоны сотрудников, которым разрешено использовать этот промокод</div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Описание:</label>
                    <textarea id="new-promo-description" placeholder="Описание промокода" rows="3"
                        style="width: 100%; padding: 10px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; resize: vertical; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"></textarea>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                    <button id="add-promo-google-btn" style="
                        padding: 15px;
                        background: #E6407A;
                        color: white;
                        border: none;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        opacity: 1;
                    ">Сохранить в Google Таблицу</button>
                    
                    <button id="add-promo-amocrm-btn" style="
                        padding: 15px;
                        background: #E6407A;
                        color: white;
                        border: none;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        opacity: 1;
                    ">Сохранить в amoCRM</button>
                </div>
                
                <div id="add-promo-result" style="margin-top: 15px; padding: 15px; border-radius: 10px; display: none;"></div>

                <hr style="border: none; border-top: 1px solid #E7E7EC; margin: 30px 0;">

                <div style="background: #F7F7F9; padding: 20px; border-radius: 10px; border: 1px solid #E7E7EC;">
                    <h3 style="margin: 0 0 20px 0; font-size: 16px; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                         Промокод для друзей сотрудников
                    </h3>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Код промокода:</label>
                        <input type="text" id="friends-promo-code-input" placeholder="ДРУЗЬЯ15"
                            style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        <div style="font-size: 12px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокод который выдаётся друзьям сотрудников (15% скидка)</div>
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Список сотрудников (по одному на строку):</label>
                        <textarea id="employees-list-input" rows="6" placeholder="Иванов Иван
Петрова Мария
Сидоров Алексей"
                            style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; resize: vertical;"></textarea>
                    </div>

                    <button id="save-friends-settings-btn" style="
                        width: 100%;
                        padding: 12px;
                        background: #E6407A;
                        color: white;
                        border: none;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        box-shadow: 0 4px 15px rgba(255, 105, 180, 0.3);
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    ">Сохранить настройки друзей</button>
                </div>
            </div>
        `;

        // Массив для хранения привязанных телефонов
        window.promoPhoneBindings = [];

        // Загружаем настройки друзей
        loadFriendsSettings();

        document.getElementById('new-promo-type').onchange = (e) => {
            const type = e.target.value;
            const phoneBlock = document.getElementById('phone-binding-block');

            // Показываем блок телефонов для персонализированных и сотрудников
            if (type === 'персонализированный' || type === 'сотрудника') {
                phoneBlock.style.display = 'block';
            } else {
                phoneBlock.style.display = 'none';
            }
        };

        // Обработчик кнопки добавления телефона
        document.getElementById('add-phone-btn').onclick = () => {
            const phoneInput = document.getElementById('new-phone-input');
            const nameInput = document.getElementById('new-phone-name-input');
            const phone = phoneInput.value.trim();
            const name = nameInput.value.trim();

            if (!phone) {
                showNotification('Введите номер телефона', 'warning');
                return;
            }

            // Проверяем что телефон еще не добавлен
            const cleanPhone = phone.replace(/\D/g, '');
            const exists = window.promoPhoneBindings.find(b => b.phone.replace(/\D/g, '') === cleanPhone);
            if (exists) {
                showNotification('Этот телефон уже добавлен', 'warning');
                return;
            }

            window.promoPhoneBindings.push({ phone, name });
            phoneInput.value = '';
            nameInput.value = '';
            renderPhoneBindingsList();
        };

        // Разрешаем добавление по Enter
        document.getElementById('new-phone-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('add-phone-btn').click();
            }
        });
        document.getElementById('new-phone-name-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('add-phone-btn').click();
            }
        });

        const addGoogleBtn = document.getElementById('add-promo-google-btn');
        addGoogleBtn.onclick = () => addPromoCode('google');

        const addAmoCRMBtn = document.getElementById('add-promo-amocrm-btn');
        addAmoCRMBtn.onclick = () => addPromoCode('amocrm');

        // Обработчик кнопки сохранения друзей
        const saveFriendsBtn = document.getElementById('save-friends-settings-btn');
        if (saveFriendsBtn) {
            saveFriendsBtn.onclick = saveFriendsSettings;
        }
    }

    // Загрузка настроек друзей в форму
    async function loadFriendsSettings() {
        const friendsPromoCodeInput = document.getElementById('friends-promo-code-input');
        const employeesListInput = document.getElementById('employees-list-input');

        if (friendsPromoCodeInput) {
            const savedCode = await GM.getValue('friendsPromoCode', '');
            friendsPromoCodeInput.value = savedCode;
        }

        if (employeesListInput) {
            const savedList = await GM.getValue('employeesList', '');
            employeesListInput.value = savedList;
        }
    }

    // Сохранение настроек друзей и автоматическое добавление в Google Таблицу
    async function saveFriendsSettings() {
        const friendsPromoCodeInput = document.getElementById('friends-promo-code-input');
        const employeesListInput = document.getElementById('employees-list-input');

        const promoCode = friendsPromoCodeInput ? friendsPromoCodeInput.value.trim().toUpperCase() : '';
        const employeesList = employeesListInput ? employeesListInput.value.trim() : '';

        // Сохраняем локально
        await GM.setValue('friendsPromoCode', promoCode);
        await GM.setValue('employeesList', employeesList);

        // Автоматически добавляем промокод в Google Sheets
        if (promoCode && webAppUrl) {
            try {
                showNotification('Сохраняю настройки и добавляю промокод в Google Таблицу...', 'info');

                // Проверяем, существует ли уже такой промокод
                await syncWithGoogleSheet(true);
                const existingPromo = promoCodesCache.find(p => p.code.toUpperCase() === promoCode.toUpperCase());

                if (!existingPromo) {
                    // Добавляем новый промокод
                    const promoData = {
                        action: 'add',
                        code: promoCode,
                        type: 'многоразовый',
                        discount: 15,
                        discountType: 'процент',
                        status: 'активен',
                        description: 'Промокод для друзей сотрудников (15%)'
                    };

                    const response = await makeGoogleScriptRequest('POST', promoData);

                    if (response.success) {
                        await syncWithGoogleSheet(true, true);
                        showNotification('Настройки сохранены и промокод добавлен в Google Таблицу!', 'success');
                    } else if (response.error && response.error.includes('already exists')) {
                        showNotification('Настройки промокода друзей сохранены!', 'success');
                    } else {
                        showNotification('Настройки сохранены, но не удалось добавить промокод: ' + (response.error || 'Неизвестная ошибка'), 'warning');
                    }
                } else {
                    showNotification('Настройки промокода друзей сохранены!', 'success');
                }
            } catch (error) {
                console.error('Ошибка добавления промокода друзей:', error);
                showNotification('Настройки сохранены локально, но не удалось добавить промокод в Google Таблицу', 'warning');
            }
        } else if (!webAppUrl) {
            showNotification('Настройки сохранены локально. Настройте URL Google Apps Script для синхронизации', 'warning');
        } else {
            showNotification('Настройки промокода друзей сохранены!', 'success');
        }
    }

    // Функция для отображения списка добавленных телефонов
    function renderPhoneBindingsList() {
        const container = document.getElementById('phone-bindings-list');
        if (!container) return;

        if (!window.promoPhoneBindings || window.promoPhoneBindings.length === 0) {
            container.innerHTML = '<div style="color: #9C9CA8; font-size: 13px; padding: 10px; text-align: center; font-family: Manrope, -apple-system, sans-serif;">Телефоны не добавлены</div>';
            return;
        }

        container.innerHTML = window.promoPhoneBindings.map((binding, index) => `
            <div style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #FAFAFB; border-radius: 10px; margin-bottom: 6px; border: 1px solid #E7E7EC;">
                <div style="flex: 1; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <span style="font-weight: 600; color: #16161A;">${binding.phone}</span>
                    ${binding.name ? `<span style="color: #6E6E7A; margin-left: 8px;">- ${binding.name}</span>` : ''}
                </div>
                <button type="button" class="remove-phone-btn" data-index="${index}" style="
                    background: #D64545;
                    color: white;
                    border: none;
                    border-radius: 50%;
                    width: 24px;
                    height: 24px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    line-height: 1;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                ">×</button>
            </div>
        `).join('');

        // Добавляем обработчики удаления
        container.querySelectorAll('.remove-phone-btn').forEach(btn => {
            btn.onclick = () => {
                const index = parseInt(btn.dataset.index);
                window.promoPhoneBindings.splice(index, 1);
                renderPhoneBindingsList();
            };
        });
    }

    /**
     * Парсит поле phoneBinding - поддерживает как старый формат (строка), так и новый (JSON)
     * @param {string|Array} phoneBinding - значение из API
     * @returns {Array} массив объектов {phone, name, usages}
     */
    function parsePhoneBindings(phoneBinding) {
        if (!phoneBinding) return [];

        // Если уже массив - возвращаем как есть
        if (Array.isArray(phoneBinding)) {
            return phoneBinding.map(item => ({
                phone: item.phone || '',
                name: item.name || '',
                usages: Array.isArray(item.usages) ? item.usages : []
            }));
        }

        const str = phoneBinding.toString().trim();
        if (!str) return [];

        // Пробуем распарсить как JSON
        try {
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed)) {
                return parsed.map(item => ({
                    phone: item.phone || '',
                    name: item.name || '',
                    usages: Array.isArray(item.usages) ? item.usages : []
                }));
            }
        } catch (e) {
            // Не JSON - это старый формат
        }

        // Старый формат - один телефон как строка
        return [{
            phone: str,
            name: '',
            usages: []
        }];
    }

    /**
     * Показывает модальное окно с деталями промокода
     */
    function showPromoDetailsModal(promo) {
        // Удаляем старое окно если есть (иначе getElementById найдёт элементы из старого окна)
        const existingOverlay = document.getElementById('promo-details-overlay');
        if (existingOverlay) {
            existingOverlay.remove();
        }

        const phoneBindings = promo.phoneBindings || parsePhoneBindings(promo.phoneBinding);
        const discountText = promo.discountType === 'процент' ? `${promo.discount}%` : `${promo.discount} ₽`;
        const statusColor = promo.status === 'активен' ? '#2E9E63' : '#9C9CA8';
        const totalUsages = phoneBindings.reduce((sum, b) => sum + (b.usages ? b.usages.length : 0), 0);

        const overlay = document.createElement('div');
        overlay.id = 'promo-details-overlay';
        overlay.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10002;
            backdrop-filter: blur(5px);
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: white;
            border-radius: 16px;
            padding: 0;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            max-width: 600px;
            width: 90%;
            max-height: 80vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        `;

        // Генерируем HTML для списка телефонов
        let phonesHtml = '';
        if (phoneBindings.length > 0) {
            phonesHtml = phoneBindings.map((binding, idx) => {
                const usagesCount = binding.usages ? binding.usages.length : 0;
                const usagesHtml = binding.usages && binding.usages.length > 0
                    ? binding.usages.map(u => `
                        <div style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: #6E6E7A;">
                            <span>• ${u.date}</span>
                            ${u.leadUrl ? `<a href="${u.leadUrl}" target="_blank" style="color: #E6407A; text-decoration: none;">Сделка </a>`: ''}
                        </div>
                    `).join('')
                    : '<div style="font-size: 12px; color: #9C9CA8; padding: 4px 0;">Нет использований</div>';

                return `
                    <div class="phone-binding-item" data-phone-index="${idx}" style="background: #FAFAFB; border-radius: 10px; padding: 12px; margin-bottom: 8px; border: 1px solid #E7E7EC;">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                            <div>
                                <div style="font-weight: 600; color: #16161A; font-size: 14px; font-family: Manrope, -apple-system, sans-serif;">
                                    ${binding.name || 'Без имени'}
                                </div>
                                <div style="color: #6E6E7A; font-size: 13px; font-family: Manrope, -apple-system, sans-serif;">
                                    ${binding.phone}
                                </div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #E6407A; color: white; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">
                                    ${usagesCount} исп.
                                </span>
                                <button class="remove-binding-btn" data-phone="${binding.phone}" style="
                                    background: #D64545;
                                    color: white;
                                    border: none;
                                    border-radius: 50%;
                                    width: 22px;
                                    height: 22px;
                                    cursor: pointer;
                                    font-size: 12px;
                                    display: flex;
                                    align-items: center;
                                    justify-content: center;
                                ">×</button>
                            </div>
                        </div>
                        <div style="border-top: 1px solid #E7E7EC; padding-top: 8px; margin-top: 8px;">
                            <div style="font-size: 11px; color: #9C9CA8; margin-bottom: 4px; font-family: Manrope, -apple-system, sans-serif;">История использований:</div>
                            ${usagesHtml}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            phonesHtml = '<div style="text-align: center; color: #9C9CA8; padding: 20px; font-family: Manrope, -apple-system, sans-serif;">Телефоны не привязаны</div>';
        }

        modal.innerHTML = `
            <div style="background: #E6407A; padding: 20px; color: white;">
                <div style="display: flex; justify-content: space-between; align-items: start;">
                    <div>
                        <div style="font-size: 24px; font-weight: 600; font-family: Manrope, -apple-system, sans-serif; margin-bottom: 5px;">${promo.code}</div>
                        <div style="font-size: 14px; opacity: 0.9; font-family: Manrope, -apple-system, sans-serif;">
                            <span style="background: rgba(255,255,255,0.2); padding: 2px 10px; border-radius: 4px; margin-right: 8px;">${promo.type}</span>
                            <span style="font-weight: 600;">${promo.status}</span>
                        </div>
                    </div>
                    <button id="close-promo-details-btn" style="
                        background: rgba(255,255,255,0.2);
                        color: white;
                        border: none;
                        border-radius: 50%;
                        width: 36px;
                        height: 36px;
                        cursor: pointer;
                        font-size: 20px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    ">×</button>
                </div>
            </div>
            <div style="padding: 20px; overflow-y: auto; flex: 1;">
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px;">
                    <div style="text-align: center; background: #FAFAFB; padding: 15px; border-radius: 10px;">
                        <div style="font-size: 24px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, sans-serif;">${discountText}</div>
                        <div style="font-size: 12px; color: #9C9CA8; font-family: Manrope, -apple-system, sans-serif;">Скидка</div>
                    </div>
                    <div style="text-align: center; background: #FAFAFB; padding: 15px; border-radius: 10px;">
                        <div style="font-size: 24px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, sans-serif;">${phoneBindings.length}</div>
                        <div style="font-size: 12px; color: #9C9CA8; font-family: Manrope, -apple-system, sans-serif;">Телефонов</div>
                    </div>
                    <div style="text-align: center; background: #FAFAFB; padding: 15px; border-radius: 10px;">
                        <div style="font-size: 24px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, sans-serif;">${totalUsages}</div>
                        <div style="font-size: 12px; color: #9C9CA8; font-family: Manrope, -apple-system, sans-serif;">Использований</div>
                    </div>
                </div>

                ${promo.description ? `
                    <div style="background: #F1F1F4; padding: 12px; border-radius: 10px; margin-bottom: 20px; font-size: 13px; color: #6E6E7A; font-family: Manrope, -apple-system, sans-serif;">
                        ${promo.description}
                    </div>
                ` : ''}

                <div style="margin-bottom: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <h3 style="margin: 0; font-size: 16px; color: #16161A; font-family: Manrope, -apple-system, sans-serif;">Привязанные телефоны</h3>
                        <button id="add-phone-to-promo-btn" style="
                            background: #2E9E63;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            padding: 8px 15px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, sans-serif;
                        ">+ Добавить телефон</button>
                    </div>
                    <div id="add-phone-form" style="display: none; background: #EAF6F0; padding: 15px; border-radius: 10px; margin-bottom: 15px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                            <input type="text" id="modal-new-phone" placeholder="+7 999 123-45-67" style="
                                padding: 10px;
                                border: 1px solid #E7E7EC;
                                border-radius: 10px;
                                font-size: 14px;
                                font-family: Manrope, -apple-system, sans-serif;
                            ">
                            <input type="text" id="modal-new-name" placeholder="Имя (опционально)" style="
                                padding: 10px;
                                border: 1px solid #E7E7EC;
                                border-radius: 10px;
                                font-size: 14px;
                                font-family: Manrope, -apple-system, sans-serif;
                            ">
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <button id="save-new-phone-btn" style="
                                flex: 1;
                                background: #2E9E63;
                                color: white;
                                border: none;
                                border-radius: 10px;
                                padding: 10px;
                                cursor: pointer;
                                font-weight: 600;
                                font-family: Manrope, -apple-system, sans-serif;
                            ">Сохранить</button>
                            <button id="cancel-new-phone-btn" style="
                                background: #F7F7F9;
                                color: #6E6E7A;
                                border: none;
                                border-radius: 10px;
                                padding: 10px;
                                cursor: pointer;
                                font-family: Manrope, -apple-system, sans-serif;
                            ">Отмена</button>
                        </div>
                    </div>
                    <div id="phone-bindings-container">
                        ${phonesHtml}
                    </div>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Обработчики
        document.getElementById('close-promo-details-btn').onclick = () => overlay.remove();
        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        // Показать форму добавления телефона
        document.getElementById('add-phone-to-promo-btn').onclick = () => {
            document.getElementById('add-phone-form').style.display = 'block';
        };

        // Отменить добавление
        document.getElementById('cancel-new-phone-btn').onclick = () => {
            document.getElementById('add-phone-form').style.display = 'none';
            document.getElementById('modal-new-phone').value = '';
            document.getElementById('modal-new-name').value = '';
        };

        // Сохранить новый телефон
        document.getElementById('save-new-phone-btn').onclick = async () => {
            const phone = document.getElementById('modal-new-phone').value.trim();
            const name = document.getElementById('modal-new-name').value.trim();

            if (!phone) {
                showNotification('Введите номер телефона', 'warning');
                return;
            }

            await addPhoneToPromo(promo.code, phone, name);
            overlay.remove();
        };

        // Обработчики удаления телефонов
        modal.querySelectorAll('.remove-binding-btn').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const phone = btn.getAttribute('data-phone');
                if (confirm(`Удалить телефон ${phone} из промокода?`)) {
                    await removePhoneFromPromo(promo.code, phone);
                    overlay.remove();
                }
            };
        });
    }

    /**
     * Добавляет телефон к промокоду через API
     */
    async function addPhoneToPromo(code, phone, name) {
        if (!webAppUrl) {
            showNotification('URL Google Apps Script не настроен', 'error');
            return;
        }

        try {
            showNotification('Добавляю телефон...', 'info');

            const response = await makeGoogleScriptRequest('POST', {
                action: 'updatePhones',
                code: code,
                phoneAction: 'add',
                phone: phone,
                name: name
            });

            if (response.success) {
                showNotification('Телефон успешно добавлен', 'success');

                // Обновляем локальный кэш напрямую из ответа API
                const promoIndex = promoCodesCache.findIndex(p => p.code.toUpperCase() === code.toUpperCase());
                if (promoIndex !== -1 && response.phoneBindings) {
                    promoCodesCache[promoIndex].phoneBindings = response.phoneBindings;
                    promoCodesCache[promoIndex].phoneBinding = JSON.stringify(response.phoneBindings);
                    cachePromoCodes(promoCodesCache);
                }

                // Переоткрыть модальное окно с обновлёнными данными
                const updatedPromo = promoCodesCache.find(p => p.code.toUpperCase() === code.toUpperCase());
                if (updatedPromo) {
                    showPromoDetailsModal(updatedPromo);
                }
            } else {
                showNotification(`Ошибка: ${response.error}`, 'error');
            }
        } catch (error) {
            console.error('Ошибка добавления телефона:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    /**
     * Удаляет телефон из промокода через API
     */
    async function removePhoneFromPromo(code, phone) {
        if (!webAppUrl) {
            showNotification('URL Google Apps Script не настроен', 'error');
            return;
        }

        try {
            showNotification('Удаляю телефон...', 'info');

            const response = await makeGoogleScriptRequest('POST', {
                action: 'updatePhones',
                code: code,
                phoneAction: 'remove',
                phone: phone
            });

            if (response.success) {
                showNotification('Телефон успешно удалён', 'success');

                // Обновляем локальный кэш напрямую из ответа API
                const promoIndex = promoCodesCache.findIndex(p => p.code.toUpperCase() === code.toUpperCase());
                if (promoIndex !== -1 && response.phoneBindings) {
                    promoCodesCache[promoIndex].phoneBindings = response.phoneBindings;
                    promoCodesCache[promoIndex].phoneBinding = JSON.stringify(response.phoneBindings);
                    cachePromoCodes(promoCodesCache);
                }

                // Переоткрыть модальное окно с обновлёнными данными
                const updatedPromo = promoCodesCache.find(p => p.code.toUpperCase() === code.toUpperCase());
                if (updatedPromo) {
                    showPromoDetailsModal(updatedPromo);
                }
            } else {
                showNotification(`Ошибка: ${response.error}`, 'error');
            }
        } catch (error) {
            console.error('Ошибка удаления телефона:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    function renderBonusTab(container) {
        loadCurrentBonusPoints();
        
        const currentLeadUrl = window.location.href;
        
        container.innerHTML = `
            <div style="max-width: 900px; margin: 0 auto;">
                <div style="background: #E6407A; padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 30px;">
                    <div style="font-size: 14px; color: white; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.9;">Текущий баланс баллов</div>
                    <div id="current-bonus-display" style="font-size: 48px; font-weight: 600; color: white; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        ${currentBonusPoints.toFixed(2)}
                    </div>
                    <div style="font-size: 12px; color: white; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.8;" id="contact-info">
                        ${currentContactId ? currentContactName : 'Контакт не определен'}
                    </div>
                </div>
                
                ${isAdminAuthorized ? `
                    <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; border: 1px solid #E7E7EC;">
                        <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #2E9E63; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Прямое начисление/списание (Админ)</h3>
                        
                        <div style="margin-bottom: 20px;">
                            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Количество баллов:</label>
                            <input type="number" id="bonus-points-input" placeholder="100" step="0.01"
                                style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 16px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <button id="add-bonus-btn" style="
                                padding: 15px;
                                background: #2E9E63;
                                color: white;
                                border: none;
                                border-radius: 10px;
                                cursor: pointer;
                                font-size: 16px;
                                font-weight: 600;
                                font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                                box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
                                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                            ">Начислить</button>
                            
                            <button id="subtract-bonus-btn" style="
                                padding: 15px;
                                background: #D64545;
                                color: white;
                                border: none;
                                border-radius: 10px;
                                cursor: pointer;
                                font-size: 16px;
                                font-weight: 600;
                                font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                                box-shadow: 0 4px 15px rgba(255, 82, 82, 0.3);
                                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                            ">Списать</button>
                        </div>
                        
                        <div id="bonus-result" style="
                            padding: 15px;
                            border-radius: 10px;
                            display: none;
                            margin-top: 15px;
                        "></div>
                    </div>
                ` : ''}

                ${!isAdminAuthorized ? `
                    <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; border: 1px solid #E7E7EC;">
                        <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #D64545; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Списание баллов</h3>

                        <div style="margin-bottom: 20px;">
                            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Количество баллов для списания:</label>
                            <input type="number" id="subtract-points-input" placeholder="100" step="0.01"
                                style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 16px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        </div>

                        <button id="subtract-bonus-btn-public" style="
                            width: 100%;
                            padding: 15px;
                            background: #D64545;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 16px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            box-shadow: 0 4px 15px rgba(255, 82, 82, 0.3);
                            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        ">Списать баллы</button>

                        <div id="subtract-result" style="
                            padding: 15px;
                            border-radius: 10px;
                            display: none;
                            margin-top: 15px;
                        "></div>
                    </div>
                ` : ''}

                <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; border: 1px solid #E7E7EC;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Создать заявку на начисление</h3>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Количество баллов для начисления:</label>
                        <input type="number" id="request-points-input" placeholder="100" step="0.01"
                            style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 10px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Причина начисления (можно выбрать несколько):</label>
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            ${Object.values(REASON_CATEGORIES).filter(cat => cat.key !== 'custom').map(cat => `
                                <label style="display: flex; align-items: center; cursor: pointer; padding: 10px; background: #FAFAFB; border-radius: 10px; border: 1px solid #E7E7EC; transition: all 0.2s;">
                                    <input type="checkbox" name="reason-category" value="${cat.key}"
                                        style="width: 18px; height: 18px; margin-right: 10px; cursor: pointer; accent-color: #E6407A;">
                                    <span style="font-size: 14px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${cat.label}</span>
                                </label>
                            `).join('')}
                            <label style="display: flex; align-items: center; cursor: pointer; padding: 10px; background: #FAFAFB; border-radius: 10px; border: 1px solid #E7E7EC; transition: all 0.2s;">
                                <input type="checkbox" name="reason-category" value="custom" id="custom-reason-checkbox"
                                    style="width: 18px; height: 18px; margin-right: 10px; cursor: pointer; accent-color: #E6407A;">
                                <span style="font-size: 14px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Другое:</span>
                                <input type="text" id="custom-reason-input" placeholder="Укажите свою причину..."
                                    style="flex: 1; margin-left: 10px; padding: 8px; border: 1px solid #E7E7EC; border-radius: 4px; font-size: 13px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            </label>
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Примечание (опционально):</label>
                        <textarea id="request-note-input" placeholder="Опишите ситуацию подробнее..." rows="2"
                            style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; resize: vertical; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"></textarea>
                    </div>

                    <button id="create-request-btn" style="
                        width: 100%;
                        padding: 15px;
                        background: #E6407A;
                        color: white;
                        border: none;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 16px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    ">Отправить заявку</button>
                    
                    <div id="request-result" style="
                        padding: 15px;
                        border-radius: 10px;
                        display: none;
                        margin-top: 15px;
                    "></div>
                </div>
                
                <div style="background: white; padding: 20px; border-radius: 12px; border: 1px solid #E7E7EC;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h3 style="margin: 0; font-size: 18px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Заявки на начисление</h3>
                        <button id="sync-requests-btn" style="
                            padding: 8px 16px;
                            background: #E6407A;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            transition: all 0.2s;
                        ">Синхронизировать</button>
                    </div>
                    
                    <div id="bonus-requests-list" style="max-height: 500px; overflow-y: auto;">
                        ${renderBonusRequestsList()}
                    </div>
                </div>

                <div style="background: #F7F7F9; padding: 20px; border-radius: 14px; margin-top: 30px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h3 style="margin: 0; font-size: 18px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Аналитика по причинам начисления</h3>
                        <button id="load-category-analytics-btn" style="
                            padding: 8px 16px;
                            background: #E6407A;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            transition: all 0.2s;
                        ">Загрузить аналитику</button>
                    </div>

                    <div id="category-analytics-container" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div style="background: #FFFFFF; border: 1px solid #E7E7EC; padding: 20px; border-radius: 14px;">
                            <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Проблемы с доставкой</div>
                            <div id="category-delivery-count" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="category-delivery-points">0 баллов</div>
                        </div>

                        <div style="background: #FFFFFF; border: 1px solid #E7E7EC; padding: 20px; border-radius: 14px;">
                            <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Проблема с качеством</div>
                            <div id="category-quality-count" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="category-quality-points">0 баллов</div>
                        </div>

                        <div style="background: #FFFFFF; border: 1px solid #E7E7EC; padding: 20px; border-radius: 14px;">
                            <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Жалобы на открытку</div>
                            <div id="category-card-count" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="category-card-points">0 баллов</div>
                        </div>

                        <div style="background: #FFFFFF; border: 1px solid #E7E7EC; padding: 20px; border-radius: 14px;">
                            <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Прочие проблемы</div>
                            <div id="category-other_problems-count" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="category-other_problems-points">0 баллов</div>
                        </div>

                        <div style="background: #FFFFFF; border: 1px solid #E7E7EC; padding: 20px; border-radius: 14px; grid-column: span 2;">
                            <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Другое (своя причина)</div>
                            <div id="category-custom-count" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="category-custom-points">0 баллов</div>
                        </div>
                    </div>

                    <div style="margin-top: 20px; padding: 15px; background: #FFFFFF; border: 1px solid #E7E7EC; border-radius: 14px; text-align: center;">
                        <div style="font-size: 12px; color: #6E6E7A; margin-bottom: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Всего заявок</div>
                        <div id="category-total-requests" style="font-size: 24px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                        <div id="category-total-points" style="font-size: 14px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0 баллов</div>
                    </div>
                </div>
            </div>
        `;

        if (isAdminAuthorized) {
            const addBtn = document.getElementById('add-bonus-btn');
            const subtractBtn = document.getElementById('subtract-bonus-btn');
            
            addBtn.onclick = () => modifyBonusPoints('add');
            
            subtractBtn.onclick = () => modifyBonusPoints('subtract');
        }

        // Обработчик для публичной кнопки списания (без админа)
        const publicSubtractBtn = document.getElementById('subtract-bonus-btn-public');
        if (publicSubtractBtn) {
            publicSubtractBtn.onclick = () => modifyBonusPoints('subtract', 'subtract-points-input', 'subtract-result');
        }

        const createRequestBtn = document.getElementById('create-request-btn');
        createRequestBtn.onclick = createBonusRequest;
        
        const syncRequestsBtn = document.getElementById('sync-requests-btn');
        if (syncRequestsBtn) {
            syncRequestsBtn.onclick = () => syncBonusRequests(false);
        }

        // Обработчик для кнопки загрузки аналитики по категориям
        const loadCategoryAnalyticsBtn = document.getElementById('load-category-analytics-btn');
        if (loadCategoryAnalyticsBtn) {
            loadCategoryAnalyticsBtn.onclick = loadCategoryAnalytics;
        }

        attachBonusRequestsButtonsListeners();
    }

    function renderListTab(container) {
        const scrollbarStyles = `
            <style>
                #google-promos-list::-webkit-scrollbar,
                #amocrm-promos-list::-webkit-scrollbar {
                    width: 8px;
                }
                #google-promos-list::-webkit-scrollbar-track,
                #amocrm-promos-list::-webkit-scrollbar-track {
                    background: #F7F7F9;
                    border-radius: 4px;
                }
                #google-promos-list::-webkit-scrollbar-thumb {
                    background: #E6407A;
                    border-radius: 4px;
                }
                #amocrm-promos-list::-webkit-scrollbar-thumb {
                    background: #F7F7F9;
                    border-radius: 4px;
                }
                #google-promos-list::-webkit-scrollbar-thumb:hover,
                #amocrm-promos-list::-webkit-scrollbar-thumb:hover {
                    background: #E6407A;
                }
            </style>
        `;
        
        container.innerHTML = scrollbarStyles + `
            <div style="max-width: 900px; margin: 0 auto;">
                <div style="margin-bottom: 30px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; display: flex; align-items: center; justify-content: space-between;">
                        <span>Промокоды из Google Таблицы</span>
                        <span style="font-size: 16px; background: #E6407A; color: white; padding: 5px 15px; border-radius: 20px;">${promoCodesCache.length}</span>
                    </h3>
                    <div id="google-promos-list" style="max-height: 400px; overflow-y: auto; padding-right: 5px;">
                        ${renderGooglePromosList()}
                    </div>
                </div>
                
                <hr style="border: none; border-top: 2px solid #E7E7EC; margin: 30px 0;">
                
                <div style="margin-bottom: 30px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; display: flex; align-items: center; justify-content: space-between;">
                        <span>Промокоды из amoCRM</span>
                        <span style="font-size: 16px; background: #F7F7F9; color: #E6407A; padding: 5px 15px; border-radius: 20px;">${amoCRMPromoCodes.length}</span>
                    </h3>
                    <div id="amocrm-promos-list" style="max-height: 400px; overflow-y: auto; padding-right: 5px;">
                        ${renderAmoCRMPromosList()}
                    </div>
                </div>

                ${isAdminAuthorized ? renderPromoAnalyticsBlockHtml() : ''}

                <hr style="border: none; border-top: 1px solid #E7E7EC; margin: 30px 0;">

                <div id="friends-stats-section" style="background: #F7F7F9; border-radius: 12px; padding: 20px; border: 1px solid #E7E7EC;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; display: flex; align-items: center; gap: 10px;">
                         Промокоды от сотрудников
                        <button id="refresh-friends-stats-btn" style="
                            padding: 5px 12px;
                            background: #E6407A;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 12px;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            margin-left: auto;
                        ">Обновить</button>
                    </h3>
                    <div id="friends-promo-code-display" style="font-size: 14px; color: #6E6E7A; margin-bottom: 15px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        Промокод: <strong style="color: #E6407A;">загрузка...</strong>
                    </div>
                    <div id="friends-stats-content" style="min-height: 100px;">
                        <div style="text-align: center; padding: 30px; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            <div style="font-size: 24px; margin-bottom: 10px;"></div>
                            <div>Загрузка статистики...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        attachDeleteButtonsListeners();

        // Загружаем статистику друзей сотрудников
        loadAndRenderFriendsStats();

        // Инициализируем блок аналитики применения промокодов (только для админа)
        if (isAdminAuthorized) {
            initPromoAnalyticsBlock();
        }
    }

    function renderGooglePromosList() {
        if (promoCodesCache.length === 0) {
            return `<div style="text-align: center; padding: 40px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокоды не загружены. Загрузите их в разделе "Настройки"</div>`;
        }

        // Создаём Set кодов из amoCRM для быстрой проверки
        const amoCRMCodesSet = new Set(
            amoCRMPromoCodes.map(p => {
                const parsed = parseAmoCRMPromoCode(p.value);
                return parsed.code.toUpperCase();
            })
        );

        return promoCodesCache.map((promo, index) => {
            const discountText = promo.discountType === 'процент' ? `${promo.discount}%` : `${promo.discount} ₽`;
            const statusColor = promo.status === 'активен' ? '#2E9E63' : '#9C9CA8';
            const expiryText = promo.expiryDate ? `до ${formatDate(promo.expiryDate)}` : 'Без срока';

            // Парсим привязанные телефоны
            const phoneBindings = promo.phoneBindings || parsePhoneBindings(promo.phoneBinding);
            const phonesCount = phoneBindings.length;
            const totalUsages = phoneBindings.reduce((sum, b) => sum + (b.usages ? b.usages.length : 0), 0);

            // Проверяем, есть ли промокод в amoCRM
            const isInAmoCRM = amoCRMCodesSet.has(promo.code.toUpperCase());
            const missingBadge = !isInAmoCRM ? `
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 10px; background: #FCF4E8; border-radius: 10px;">
                    <span style="font-size: 12px; color: #A85F0F; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; font-weight: 600;">Нет в amoCRM</span>
                    <button class="add-to-amocrm-btn" data-promo-code="${promo.code}" style="
                        padding: 4px 10px;
                        background: #E6407A;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 11px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        transition: all 0.2s;
                        margin-left: auto;
                    ">+ Добавить в amoCRM</button>
                </div>
            ` : '';

            return `
                <div class="promo-card" data-promo-index="${index}" style="background: white; border: 2px solid ${isInAmoCRM ? '#F1F1F4' : '#C77A18'}; border-radius: 10px; padding: 15px; margin-bottom: 10px; transition: all 0.2s; position: relative; cursor: pointer;"
                     onmouseover="this.style.borderColor='#E6407A'; this.style.boxShadow='0 4px 12px rgba(255, 184, 209, 0.3)'"
                     onmouseout="this.style.borderColor='${isInAmoCRM ? '#F1F1F4' : '#C77A18'}'; this.style.boxShadow='none'">
                    <button class="delete-google-promo-btn" data-promo-code="${promo.code}" style="
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: #D64545;
                        color: white;
                        border: none;
                        border-radius: 50%;
                        width: 28px;
                        height: 28px;
                        cursor: pointer;
                        font-size: 16px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        transition: all 0.2s;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        font-weight: 600;
                        line-height: 1;
                        padding: 0;
                        z-index: 10;
                    ">×</button>
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px; padding-right: 30px;">
                        <div>
                            <div style="font-size: 18px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin-bottom: 5px;">${promo.code}</div>
                            <div style="font-size: 12px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                                <span style="display: inline-block; padding: 2px 8px; background: #F1F1F4; border-radius: 4px; margin-right: 5px;">${promo.type}</span>
                                <span style="color: ${statusColor}; font-weight: 600;">${promo.status}</span>
                                ${isInAmoCRM ? '<span style="display: inline-block; padding: 2px 8px; background: #EAF6F0; color: #237A4C; border-radius: 4px; margin-left: 5px; font-size: 10px;">amoCRM</span>': ''}
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 20px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${discountText}</div>
                            <div style="font-size: 11px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${expiryText}</div>
                        </div>
                    </div>
                    ${promo.minOrderAmount ? `<div style="font-size: 12px; color: #6E6E7A; margin-top: 8px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Мин. сумма: ${promo.minOrderAmount} ₽</div>`: ''}
                    ${promo.maxUsages ? `<div style="font-size: 12px; color: #6E6E7A; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Использовано: ${promo.currentUsages || 0} из ${promo.maxUsages}</div>`: ''}
                    ${phonesCount >0 ? `<div style="font-size: 12px; color: #6E6E7A; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Привязано телефонов: <strong>${phonesCount}</strong>${totalUsages >0 ? `(использований: ${totalUsages})`: ''}</div>`: ''}
                    ${promo.description ? `<div style="font-size: 12px; color: #6E6E7A; margin-top: 10px; padding-top: 10px; border-top: 1px solid #F1F1F4; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${promo.description}</div>` : ''}
                    ${missingBadge}
                    <div style="font-size: 11px; color: #9C9CA8; margin-top: 8px; text-align: center; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Нажмите для просмотра деталей</div>
                </div>
            `;
        }).join('');
    }

    function renderAmoCRMPromosList() {
        if (amoCRMPromoCodes.length === 0) {
            return `<div style="text-align: center; padding: 40px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокоды не загружены. Загрузите их в разделе "Настройки"</div>`;
        }

        return amoCRMPromoCodes.map(promo => {
            return `
                <div class="amocrm-promo-card" style="background: white; border: 1px solid #E7E7EC; border-radius: 10px; padding: 15px; margin-bottom: 10px; transition: all 0.2s; position: relative;" 
                     onmouseover="this.style.borderColor='#E6407A'; this.style.boxShadow='0 4px 12px rgba(255, 158, 196, 0.3)'" 
                     onmouseout="this.style.borderColor='#FDEFF4'; this.style.boxShadow='none'">
                    <button class="delete-amocrm-promo-btn" data-promo-code="${promo.value}" data-promo-id="${promo.id}" style="
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: #D64545;
                        color: white;
                        border: none;
                        border-radius: 50%;
                        width: 28px;
                        height: 28px;
                        cursor: pointer;
                        font-size: 16px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        transition: all 0.2s;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        font-weight: 600;
                        line-height: 1;
                        padding: 0;
                    ">×</button>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding-right: 30px;">
                        <div style="font-size: 16px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${promo.value}</div>
                        <div style="font-size: 12px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">ID: ${promo.id}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ==================== Статистика друзей сотрудников ====================

    async function loadFriendsStats() {
        if (!webAppUrl) {
            return { total: 0, byEmployee: {} };
        }

        const headers = await promoBackendHeaders();
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: webAppUrl + '?action=getFriendsStats',
                headers,
                onload: (response) => {
                    // GAS всегда отвечал 200; сервис лояльности без токена отвечает 401
                    if (response.status !== 200) {
                        console.error('[Промокоды] Статистика друзей:', promoBackendHttpError(response.status).message);
                        resolve({ total: 0, byEmployee: {} });
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch (e) {
                        console.error('[Промокоды] Ошибка парсинга статистики друзей:', e);
                        resolve({ total: 0, byEmployee: {} });
                    }
                },
                onerror: (error) => {
                    console.error('[Промокоды] Ошибка загрузки статистики друзей:', error);
                    resolve({ total: 0, byEmployee: {} });
                }
            });
        });
    }

    async function logFriendsUsage(employee, leadUrl) {
        if (!webAppUrl) {
            console.warn('[Промокоды] URL веб-приложения не настроен');
            return { success: false };
        }

        const headers = await promoBackendHeaders({ 'Content-Type': 'application/json' });
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'POST',
                url: webAppUrl,
                data: JSON.stringify({
                    action: 'addFriendsUsage',
                    employee: employee,
                    leadUrl: leadUrl
                }),
                headers,
                onload: (response) => {
                    try {
                        const data = JSON.parse(response.responseText);
                        console.log('[Промокоды] Использование друзей записано:', data);
                        resolve(data);
                    } catch (e) {
                        console.error('[Промокоды] Ошибка записи использования друзей:', e);
                        resolve({ success: false });
                    }
                },
                onerror: (error) => {
                    console.error('[Промокоды] Ошибка записи использования друзей:', error);
                    resolve({ success: false });
                }
            });
        });
    }

    async function loadAndRenderFriendsStats() {
        const statsContent = document.getElementById('friends-stats-content');
        const promoCodeDisplay = document.getElementById('friends-promo-code-display');
        const refreshBtn = document.getElementById('refresh-friends-stats-btn');

        if (!statsContent) return;

        // Показываем промокод из настроек
        const friendsPromoCode = await GM.getValue('friendsPromoCode', '');
        if (promoCodeDisplay) {
            promoCodeDisplay.innerHTML = friendsPromoCode
                ? `Промокод: <strong style="color: #E6407A; font-size: 16px;">${friendsPromoCode}</strong> (15%)`
                : `<span style="color: #9C9CA8;">Промокод не настроен. Настройте в разделе "Настройки"</span>`;
        }

        // Обработчик кнопки обновления
        if (refreshBtn) {
            refreshBtn.onclick = () => loadAndRenderFriendsStats();
        }

        try {
            const stats = await loadFriendsStats();

            if (stats.total === 0) {
                statsContent.innerHTML = `
                    <div style="text-align: center; padding: 30px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        <div style="font-size: 32px; margin-bottom: 10px;"></div>
                        <div>Пока нет использований промокода друзей</div>
                    </div>
                `;
                return;
            }

            // Формируем таблицу статистики
            const employees = Object.entries(stats.byEmployee).sort((a, b) => b[1].count - a[1].count);

            let tableHTML = `
                <table style="width: 100%; border-collapse: collapse; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <thead>
                        <tr style="background: rgba(255, 105, 180, 0.1);">
                            <th style="text-align: left; padding: 12px; border-bottom: 2px solid #E6407A; color: #E6407A; font-size: 14px;">Сотрудник</th>
                            <th style="text-align: center; padding: 12px; border-bottom: 2px solid #E6407A; color: #E6407A; font-size: 14px;">Клиентов</th>
                            <th style="text-align: left; padding: 12px; border-bottom: 2px solid #E6407A; color: #E6407A; font-size: 14px;">Сделки</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            employees.forEach(([employee, data], index) => {
                const leadsLinks = data.leads.map((url, i) => {
                    if (url) {
                        return `<a href="${url}" target="_blank" style="display: inline-block; margin: 2px; padding: 3px 8px; background: #E6407A; color: white; text-decoration: none; border-radius: 4px; font-size: 11px;" title="${url}">${i + 1}</a>`;
                    }
                    return '';
                }).filter(l => l).join('');

                tableHTML += `
                    <tr style="background: ${index % 2 === 0 ? 'white' : 'rgba(255, 240, 245, 0.5)'};">
                        <td style="padding: 12px; border-bottom: 1px solid #FDEFF4; font-weight: 600; color: #16161A;">${employee}</td>
                        <td style="padding: 12px; border-bottom: 1px solid #FDEFF4; text-align: center;">
                            <span style="display: inline-block; background: #E6407A; color: white; padding: 4px 12px; border-radius: 12px; font-weight: 600;">${data.count}</span>
                        </td>
                        <td style="padding: 12px; border-bottom: 1px solid #FDEFF4;">${leadsLinks || '<span style="color: #9C9CA8;">-</span>'}</td>
                    </tr>
                `;
            });

            tableHTML += `
                    </tbody>
                </table>
                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #E7E7EC; text-align: center; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <span style="font-size: 14px; color: #6E6E7A;">Всего клиентов: </span>
                    <span style="font-size: 20px; font-weight: 600; color: #E6407A;">${stats.total}</span>
                </div>
            `;

            statsContent.innerHTML = tableHTML;

        } catch (error) {
            console.error('[Промокоды] Ошибка загрузки статистики друзей:', error);
            statsContent.innerHTML = `
                <div style="text-align: center; padding: 30px; color: #D64545; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <div style="font-size: 32px; margin-bottom: 10px;"></div>
                    <div>Ошибка загрузки статистики</div>
                </div>
            `;
        }
    }

    function attachDeleteButtonsListeners() {
        const googleDeleteButtons = document.querySelectorAll('.delete-google-promo-btn');
        console.log('Найдено кнопок удаления Google:', googleDeleteButtons.length);

        googleDeleteButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const code = btn.getAttribute('data-promo-code');
                console.log('Нажата кнопка удаления Google промокода:', code);
                deleteGooglePromoCode(code);
            });
        });

        const amoCRMDeleteButtons = document.querySelectorAll('.delete-amocrm-promo-btn');
        console.log('Найдено кнопок удаления amoCRM:', amoCRMDeleteButtons.length);

        amoCRMDeleteButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const code = btn.getAttribute('data-promo-code');
                const id = parseInt(btn.getAttribute('data-promo-id'));
                console.log('Нажата кнопка удаления amoCRM промокода:', code, 'ID:', id);
                deleteAmoCRMPromoCode(code, id);
            });
        });

        // Обработчик клика на карточки промокодов для открытия деталей
        const promoCards = document.querySelectorAll('.promo-card[data-promo-index]');
        promoCards.forEach(card => {
            card.addEventListener('click', (e) => {
                // Игнорируем клик если это кнопка удаления или добавления в amoCRM
                if (e.target.closest('.delete-google-promo-btn')) return;
                if (e.target.closest('.add-to-amocrm-btn')) return;

                const index = parseInt(card.getAttribute('data-promo-index'));
                const promo = promoCodesCache[index];
                if (promo) {
                    showPromoDetailsModal(promo);
                }
            });
        });

        // Обработчик кнопок "Добавить в amoCRM"
        const addToAmoCRMButtons = document.querySelectorAll('.add-to-amocrm-btn');
        console.log('Найдено кнопок добавления в amoCRM:', addToAmoCRMButtons.length);

        addToAmoCRMButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const code = btn.getAttribute('data-promo-code');
                console.log('Нажата кнопка добавления в amoCRM:', code);

                btn.disabled = true;
                btn.textContent = 'Добавляю...';

                try {
                    await addPromoCodeToAmoCRM(code);
                    showNotification(`Промокод "${code}" добавлен в amoCRM`, 'success');

                    // Обновляем список
                    await syncWithAmoCRM(true);
                    const googleList = document.getElementById('google-promos-list');
                    if (googleList) {
                        googleList.innerHTML = renderGooglePromosList();
                        attachDeleteButtonsListeners();
                    }
                } catch (error) {
                    console.error('Ошибка добавления в amoCRM:', error);
                    showNotification(`Ошибка: ${error.message}`, 'error');
                    btn.disabled = false;
                    btn.textContent = '+ Добавить в amoCRM';
                }
            });
        });
    }

    function renderSettingsTab(container) {
        loadSettings();
        
        container.innerHTML = `
            <div style="max-width: 600px; margin: 0 auto;">
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">URL бэкенда промокодов (Google Apps Script или сервис лояльности):</label>
                    <input type="text" id="webapp-url-input" value="${webAppUrl}" placeholder="https://script.google.com/macros/s/... или https://.../loyalty/gas" 
                        style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <div style="font-size: 12px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">После деплоя Google Apps Script скопируйте сюда URL Web App</div>
                </div>
                
                <button id="save-webapp-url-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: #E6407A;
                    color: white;
                    border: none;
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                    margin-bottom: 20px;
                ">Сохранить URL</button>
                
                <hr style="border: none; border-top: 2px solid #E7E7EC; margin: 30px 0;">
                
                <button id="sync-google-sheet-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: #FFFFFF;
                    color: #16161A;
                    border: 1px solid #E7E7EC;
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                    margin-bottom: 15px;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Загрузить промокоды из Google Таблицы</button>
                
                <button id="sync-amocrm-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: #FFFFFF;
                    color: #16161A;
                    border: 1px solid #E7E7EC;
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                    margin-bottom: 15px;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Загрузить промокоды из amoCRM</button>
                
                <button id="sync-amocrm-to-google-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: #FFFFFF;
                    color: #16161A;
                    border: 1px solid #E7E7EC;
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                    margin-bottom: 15px;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Выгрузить: amoCRM → Google Таблица</button>

                <button id="sync-google-to-amocrm-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: #FFFFFF;
                    color: #16161A;
                    border: 1px solid #E7E7EC;
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                    margin-bottom: 20px;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Загрузить: Google Таблица → amoCRM</button>

                <div style="background: #F7F7F9; padding: 20px; border-radius: 10px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Статистика</h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-bottom: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокодов в Google:</div>
                            <div style="font-size: 24px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="google-promo-count">0</div>
                        </div>
                        <div>
                            <div style="font-size: 12px; color: #9C9CA8; margin-bottom: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Промокодов в amoCRM:</div>
                            <div style="font-size: 24px; font-weight: 600; color: #E6407A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="amocrm-promo-count">0</div>
                        </div>
                    </div>
                    <div style="margin-top: 15px; font-size: 12px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="last-sync-time">Последняя синхронизация: никогда</div>
                </div>

                <hr style="border: none; border-top: 2px solid #E7E7EC; margin: 30px 0;">

                <div id="loyalty-settings-box"></div>

                <hr style="border: none; border-top: 2px solid #E7E7EC; margin: 30px 0;">
                
                <div style="background: ${isAdminAuthorized ? '#E6F4EC' : '#FCF4E8'}; padding: 20px; border-radius: 14px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 16px; color: ${isAdminAuthorized ? '#1E6B44' : '#A85F0F'}; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        ${isAdminAuthorized ? 'Режим администратора': 'Защита данных'}
                    </h3>
                    <p style="margin: 0 0 15px 0; font-size: 13px; color: ${isAdminAuthorized ? '#1E6B44' : '#A85F0F'}; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                        ${isAdminAuthorized ? 'Вы авторизованы. Разрешено добавлять и удалять промокоды.' : 'Для добавления и удаления промокодов требуется код администратора.'}
                    </p>
                    ${isAdminAuthorized ? `
                        <button id="admin-logout-btn" style="
                            width: 100%;
                            padding: 12px;
                            background: #D64545;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            box-shadow: 0 4px 15px rgba(255, 82, 82, 0.3);
                            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        ">Выйти из режима администратора</button>
                    ` : `
                        <button id="admin-auth-btn" style="
                            width: 100%;
                            padding: 12px;
                            background: #C77A18;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            box-shadow: 0 4px 15px rgba(255, 152, 0, 0.3);
                            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        ">Ввести код администратора</button>
                    `}
                </div>

            </div>
        `;

        document.getElementById('save-webapp-url-btn').onclick = saveWebAppUrl;
        
        const syncGoogleBtn = document.getElementById('sync-google-sheet-btn');
        syncGoogleBtn.onclick = () => syncWithGoogleSheet(false);
        
        const syncAmoCRMBtn = document.getElementById('sync-amocrm-btn');
        syncAmoCRMBtn.onclick = () => syncWithAmoCRM(false);

        const syncAmoCRMToGoogleBtn = document.getElementById('sync-amocrm-to-google-btn');
        syncAmoCRMToGoogleBtn.onclick = async () => {
            if (!webAppUrl) {
                showNotification('Сначала настройте URL Google Apps Script', 'warning');
                return;
            }
            if (amoCRMPromoCodes.length === 0) {
                showNotification('Сначала загрузите промокоды из amoCRM', 'warning');
                return;
            }
            await syncAmoCRMToGoogleSheets();
        };

        const syncGoogleToAmoCRMBtn = document.getElementById('sync-google-to-amocrm-btn');
        syncGoogleToAmoCRMBtn.onclick = async () => {
            if (promoCodesCache.length === 0) {
                showNotification('Сначала загрузите промокоды из Google Таблицы', 'warning');
                return;
            }
            await syncGoogleToAmoCRM();
        };

        if (isAdminAuthorized) {
            const adminLogoutBtn = document.getElementById('admin-logout-btn');
            if (adminLogoutBtn) {
                adminLogoutBtn.onclick = () => {
                    if (confirm('Выйти из режима администратора?')) {
                        isAdminAuthorized = false;
                        localStorage.removeItem('promo_admin_authorized');
                        showNotification('Вы вышли из режима администратора', 'success');
                        switchTab('settings');
                    }
                };
            }
        } else {
            const adminAuthBtn = document.getElementById('admin-auth-btn');
            if (adminAuthBtn) {
                adminAuthBtn.onclick = () => {
                    showAdminPasswordModal();
                };
            }
        }

        updateStatistics();
        renderLoyaltySettings(document.getElementById('loyalty-settings-box'));
    }

    function showAdminPasswordModal() {
        injectStyles();

        const overlay = document.createElement('div');
        overlay.className = 'pcx';
        overlay.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            position: fixed;
            inset: 0;
            background: rgba(18, 18, 26, 0.55);
            z-index: 10001;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            width: min(380px, 92vw);
            padding: 26px;
            background: #fff;
            border-radius: 16px;
            box-shadow: 0 30px 80px rgba(16, 16, 28, 0.3);
        `;

        modal.innerHTML = `
            <h3 style="margin: 0 0 6px; font-size: 17px; font-weight: 700; letter-spacing: -0.02em; color: #16161A;">Код администратора</h3>
            <p style="margin: 0 0 18px; font-size: 13px; font-weight: 500; color: #9C9CA8;">Нужен для добавления промокодов и аналитики</p>
            <input type="password" id="admin-password-input" placeholder="Введите код"
                style="width: 100%; height: 42px; padding: 0 14px; border: 1px solid #E7E7EC; border-radius: 10px;
                       font-size: 15px; font-weight: 600; letter-spacing: 3px; text-align: center;
                       color: #16161A; outline: none; margin-bottom: 16px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <button id="cancel-password-btn" class="pcx-btn pcx-btn--ghost">Отмена</button>
                <button id="submit-password-btn" class="pcx-btn pcx-btn--primary">Войти</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const passwordInput = document.getElementById('admin-password-input');
        const submitBtn = document.getElementById('submit-password-btn');
        const cancelBtn = document.getElementById('cancel-password-btn');

        passwordInput.focus();

        const checkPassword = () => {
            const enteredPassword = passwordInput.value;
            if (enteredPassword === ADMIN_PASSWORD) {
                isAdminAuthorized = true;
                localStorage.setItem('promo_admin_authorized', 'true');
                overlay.remove();
                showNotification('Авторизация успешна! Разрешено добавлять и удалять промокоды', 'success');
                switchTab('settings');
            } else {
                passwordInput.value = '';
                passwordInput.style.borderColor = '#D64545';
                showNotification('Неверный код администратора', 'error');
                setTimeout(() => {
                    passwordInput.style.borderColor = '#E7E7EC';
                }, 2000);
            }
        };

        submitBtn.onclick = checkPassword;
        cancelBtn.onclick = () => overlay.remove();
        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') checkPassword();
        });
    }

    async function checkPromoCode() {
        const code = document.getElementById('promo-code-input').value.trim().toUpperCase();
        const phone = document.getElementById('client-phone-input').value.trim();
        const orderAmount = parseFloat(document.getElementById('order-amount-input').value) || 0;
        const resultDiv = document.getElementById('promo-result');

        if (!code) {
            showResult(resultDiv, 'Введите промокод', 'warning');
            return;
        }

        showResult(resultDiv, 'Проверяю промокод...', 'info');

        try {
            await syncWithGoogleSheet(true);
            
            const promo = promoCodesCache.find(p => p.code.toUpperCase() === code);

            if (!promo) {
                showResult(resultDiv, `Промокод "${code}" не найден`, 'error');
                return;
            }

            const validation = validatePromoCode(promo, phone, orderAmount);

            if (validation.valid) {
                const discountText = promo.discountType === 'процент' 
                    ? `${promo.discount}%` 
                    : `${promo.discount} ₽`;
                
                let detailsHtml = `
                    <div style="font-size: 16px; font-weight: 600; margin-bottom: 15px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #E6407A;">Промокод активен!</div>
                    <div style="margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"><strong>Скидка:</strong> ${discountText}</div>
                    <div style="margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"><strong>Тип:</strong> ${promo.type}</div>
                `;

                if (promo.minOrderAmount) {
                    detailsHtml += `<div style="margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"><strong>Минимальная сумма заказа:</strong> ${promo.minOrderAmount} ₽</div>`;
                }

                if (promo.expiryDate) {
                    detailsHtml += `<div style="margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"><strong>Срок действия:</strong> до ${formatDate(promo.expiryDate)}</div>`;
                }

                if (promo.maxUsages) {
                    const remaining = promo.maxUsages - (promo.currentUsages || 0);
                    detailsHtml += `<div style="margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;"><strong>Осталось использований:</strong> ${remaining} из ${promo.maxUsages}</div>`;
                }

                if (promo.description) {
                    detailsHtml += `<div style="margin-top: 15px; padding: 10px; background: #FAFAFB; border-radius: 4px; font-size: 13px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">${promo.description}</div>`;
                }

                detailsHtml += `
                    <button id="apply-promo-btn" style="
                        width: 100%;
                        padding: 12px;
                        background: #2E9E63;
                        color: white;
                        border: none;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        margin-top: 15px;
                    ">Применить промокод</button>
                `;

                showResult(resultDiv, detailsHtml, 'success');

                document.getElementById('apply-promo-btn').onclick = () => applyPromoCode(promo, phone);
            } else {
                showResult(resultDiv, validation.reason, 'error');
            }
        } catch (error) {
            console.error('Ошибка проверки промокода:', error);
            showResult(resultDiv, `Ошибка: ${error.message}`, 'error');
        }
    }

    function validatePromoCode(promo, phone, orderAmount) {
        if (promo.status !== 'активен') {
            return { valid: false, reason: 'Промокод неактивен' };
        }

        if (promo.expiryDate) {
            const expiry = new Date(promo.expiryDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            if (expiry < today) {
                return { valid: false, reason: `Срок действия истек ${formatDate(promo.expiryDate)}` };
            }
        }

        if (promo.maxUsages && promo.currentUsages >= promo.maxUsages) {
            return { valid: false, reason: 'Превышен лимит использований' };
        }

        if (promo.type === 'одноразовый') {
            if (promo.currentUsages > 0) {
                return { valid: false, reason: 'Одноразовый промокод уже использован' };
            }
        }

        // Проверка привязки телефонов для всех типов с привязкой (персонализированный, сотрудника и др.)
        const phoneBindings = promo.phoneBindings || parsePhoneBindings(promo.phoneBinding);
        if (phoneBindings && phoneBindings.length > 0) {
            if (!phone) {
                return { valid: false, reason: 'Введите номер телефона для проверки промокода' };
            }
            const cleanPhone = phone.replace(/\D/g, '');
            const found = phoneBindings.find(b => b.phone.replace(/\D/g, '') === cleanPhone);
            if (!found) {
                return { valid: false, reason: 'Промокод не доступен для этого номера телефона' };
            }
        }

        if (promo.minOrderAmount && orderAmount > 0 && orderAmount < promo.minOrderAmount) {
            return { valid: false, reason: `Минимальная сумма заказа: ${promo.minOrderAmount} ₽` };
        }

        return { valid: true };
    }

    async function applyPromoCode(promo, phone) {
        console.log('[Промокоды] applyPromoCode вызван:', {
            promoCode: promo.code,
            promoType: promo.type,
            phone: phone,
            phoneClean: phone ? phone.replace(/\D/g, '') : null,
            phoneBindingsCount: promo.phoneBindings ? promo.phoneBindings.length : 0,
            phoneBindings: promo.phoneBindings
        });

        try {
            showNotification('Применяю промокод...', 'info');

            const leadIdMatch = window.location.href.match(/\/leads\/detail\/(\d+)/);
            if (!leadIdMatch) {
                throw new Error('Не удалось определить ID сделки');
            }
            const leadId = leadIdMatch[1];

            const promoEnumItem = amoCRMPromoCodes.find(p => 
                p.value.toUpperCase() === promo.code.toUpperCase() || 
                p.value.toUpperCase().startsWith(promo.code.toUpperCase())
            );

            if (!promoEnumItem) {
                throw new Error('Промокод не найден в списке amoCRM. Синхронизируйте промокоды в настройках.');
            }

            const domain = window.location.hostname;
            const apiUrl = `https://${domain}/api/v4/leads/${leadId}`;
            const leadPageUrl = `https://${domain}/leads/detail/${leadId}`;

            const payload = {
                custom_fields_values: [
                    {
                        field_id: PROMO_FIELD_ID,
                        values: [
                            {
                                enum_id: promoEnumItem.id
                            }
                        ]
                    }
                ]
            };

            const response = await fetch(apiUrl, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Ошибка обновления сделки: HTTP ${response.status}`);
            }

            await updateUsageCounter(promo.code, phone, leadPageUrl);

            // Проверяем, это промокод для друзей сотрудников?
            const friendsCode = await GM.getValue('friendsPromoCode', '');
            if (friendsCode && promo.code.toUpperCase() === friendsCode.toUpperCase()) {
                const employeeSelect = document.getElementById('employee-referral-select');
                const selectedEmployee = employeeSelect ? employeeSelect.value : '';

                if (selectedEmployee) {
                    console.log('[Промокоды] Записываем использование промокода друзей:', selectedEmployee);
                    await logFriendsUsage(selectedEmployee, leadPageUrl);
                    showNotification(`Промокод успешно применен! Записан от сотрудника: ${selectedEmployee}`, 'success');
                } else {
                    showNotification('Промокод применен, но сотрудник не выбран!', 'warning');
                }
            } else {
                showNotification('Промокод успешно применен!', 'success');
            }

            setTimeout(() => {
                document.getElementById('promo-code-input').value = '';
                document.getElementById('order-amount-input').value = '';
                document.getElementById('promo-result').style.display = 'none';
                // Скрываем блок выбора сотрудника
                const employeeBlock = document.getElementById('employee-referral-block');
                if (employeeBlock) employeeBlock.style.display = 'none';
            }, 2000);
        } catch (error) {
            console.error('Ошибка применения промокода:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    async function addPromoCode(target) {
        const resultDiv = document.getElementById('add-promo-result');

        if (!isAdminAuthorized) {
            showResult(resultDiv, 'Для добавления промокодов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
            return;
        }

        const code = document.getElementById('new-promo-code').value.trim().toUpperCase();
        const type = document.getElementById('new-promo-type').value;
        const discount = document.getElementById('new-promo-discount').value;
        const discountType = document.getElementById('new-promo-discount-type').value;
        const minAmount = document.getElementById('new-promo-min-amount').value;
        const expiry = document.getElementById('new-promo-expiry').value;
        const maxUsage = document.getElementById('new-promo-max-usage').value;
        const description = document.getElementById('new-promo-description').value.trim();

        // Получаем список привязанных телефонов
        const phoneBindings = window.promoPhoneBindings || [];

        if (!code || !discount) {
            showResult(resultDiv, 'Заполните обязательные поля: Промокод и Скидка', 'warning');
            return;
        }

        if (target === 'google') {
            if (!webAppUrl) {
                showResult(resultDiv, 'Сначала настройте URL Google Apps Script в разделе "Настройки"', 'warning');
                return;
            }

            showResult(resultDiv, 'Добавляю промокод в Google Таблицу...', 'info');

            try {
                const promoData = {
                    action: 'add',
                    code: code,
                    type: type,
                    discount: parseFloat(discount),
                    discountType: discountType,
                    minOrderAmount: minAmount ? parseFloat(minAmount) : '',
                    expiryDate: expiry,
                    maxUsages: maxUsage ? parseInt(maxUsage) : '',
                    status: 'активен',
                    phoneBindings: phoneBindings.length > 0 ? phoneBindings : undefined,
                    description: description
                };

                const response = await makeGoogleScriptRequest('POST', promoData);

                if (response.success) {
                    showResult(resultDiv, 'Промокод успешно добавлен в Google Таблицу!', 'success');
                    await syncWithGoogleSheet(true);
                    clearPromoForm();
                } else {
                    showResult(resultDiv, `Ошибка: ${response.error || 'Не удалось добавить промокод'}`, 'error');
                }
            } catch (error) {
                console.error('Ошибка добавления промокода:', error);
                showResult(resultDiv, `Ошибка: ${error.message}`, 'error');
            }
        } else if (target === 'amocrm') {
            showResult(resultDiv, 'Добавляю промокод в amoCRM...', 'info');
            
            try {
                await addPromoCodeToAmoCRM(code);
                showResult(resultDiv, 'Промокод успешно добавлен в amoCRM!', 'success');
                await syncWithAmoCRM();
                clearPromoForm();
            } catch (error) {
                console.error('Ошибка добавления в amoCRM:', error);
                showResult(resultDiv, `Ошибка: ${error.message}`, 'error');
            }
        }
    }

    function clearPromoForm() {
        setTimeout(() => {
            document.getElementById('new-promo-code').value = '';
            document.getElementById('new-promo-discount').value = '';
            document.getElementById('new-promo-min-amount').value = '';
            document.getElementById('new-promo-expiry').value = '';
            document.getElementById('new-promo-max-usage').value = '';
            document.getElementById('new-promo-description').value = '';
            document.getElementById('add-promo-result').style.display = 'none';

            // Очищаем список телефонов
            window.promoPhoneBindings = [];
            renderPhoneBindingsList();
        }, 2000);
    }

    async function addPromoCodeToAmoCRM(code) {
        console.log('addPromoCodeToAmoCRM вызвана с кодом:', code);
        const domain = window.location.hostname;
        const fieldUrl = `https://${domain}/api/v4/leads/custom_fields/${PROMO_FIELD_ID}`;

        console.log('Получаю текущие значения поля...');
        const getResponse = await fetch(fieldUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!getResponse.ok) {
            const errorText = await getResponse.text();
            console.error('Ошибка получения поля:', errorText);
            throw new Error(`Ошибка получения поля: HTTP ${getResponse.status}`);
        }

        const fieldData = await getResponse.json();
        console.log('Текущие данные поля:', fieldData);

        const existingEnums = fieldData.enums || [];
        console.log('Существующие промокоды:', existingEnums.length);
        
        const enumExists = existingEnums.some(e => e.value.toUpperCase() === code.toUpperCase());
        if (enumExists) {
            console.warn('Промокод уже существует');
            throw new Error('Промокод уже существует в amoCRM');
        }

        const maxSort = existingEnums.length > 0 
            ? Math.max(...existingEnums.map(e => e.sort || 0)) 
            : 0;

        const newEnums = [
            ...existingEnums,
            {
                value: code,
                sort: maxSort + 10
            }
        ];

        console.log('Отправляю обновление с новыми значениями:', newEnums.length);
        const updatePayload = { enums: newEnums };
        console.log('Payload:', JSON.stringify(updatePayload));

        const updateResponse = await fetch(fieldUrl, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
        });

        if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error('Ошибка обновления поля:', errorText);
            throw new Error(`Ошибка добавления промокода: HTTP ${updateResponse.status} - ${errorText}`);
        }

        console.log('Промокод успешно добавлен в amoCRM');
        await syncWithAmoCRM();

        return await updateResponse.json();
    }

    // Бэкенд промокодов - GAS или его перенос в сервисе лояльности (адрес .../loyalty/gas).
    // Сервис пускает скрипт по тому же токену, что и вкладку сертификатов: секретный адрес
    // в скрипт класть нельзя, репозиторий скриптов публичный.
    function isLoyaltyGasUrl(url) {
        return /^https:\/\/[^/]+\/loyalty\/gas\/?$/.test(String(url || '').trim());
    }

    async function promoBackendHeaders(extra = {}) {
        if (!isLoyaltyGasUrl(webAppUrl)) return extra;
        const token = String((await GM.getValue(LOYALTY_TOKEN_KEY, '')) || '').trim();
        return token ? { ...extra, 'Authorization': 'Bearer ' + token } : extra;
    }

    function promoBackendHttpError(status) {
        if (isLoyaltyGasUrl(webAppUrl) && (status === 401 || status === 403)) {
            return new Error(status === 401
                ? 'Нужен токен доступа - укажите его во вкладке «Настройки», раздел сервиса сертификатов'
                : 'Токен не подходит для промокодов - нужен токен менеджера или администратора');
        }
        return new Error(`HTTP ${status}`);
    }

    function makeGoogleScriptRequest(method, data = null) {
        return new Promise(async (resolve, reject) => {
            if (!webAppUrl) {
                reject(new Error('Web App URL не настроен'));
                return;
            }

            const config = {
                method: method,
                url: webAppUrl + (method === 'GET' && data ? '?' + new URLSearchParams(data).toString() : ''),
                timeout: 120000,
                headers: await promoBackendHeaders(),
                onload: function(response) {
                    if (response.status !== 200) {
                        reject(promoBackendHttpError(response.status));
                        return;
                    }
                    const text = response.responseText || '';
                    try {
                        resolve(JSON.parse(text));
                    } catch (error) {
                        // Чаще всего сюда попадает оборванный или слишком большой ответ -
                        // без длины и начала текста причину не отличить от сбоя сети
                        console.error('Не разобран ответ Google Apps Script:', text.slice(0, 300));
                        reject(new Error(`ответ не разобран (получено ${text.length} символов)`));
                    }
                },
                ontimeout: function() {
                    reject(new Error('Google Apps Script не ответил за 2 минуты'));
                },
                onerror: function(error) {
                    reject(new Error('Ошибка соединения с Google Apps Script'));
                }
            };

            if (method === 'POST' && data) {
                config.headers = { ...config.headers, 'Content-Type': 'application/json' };
                config.data = JSON.stringify(data);
            }

            GM.xmlHttpRequest(config);
        });
    }

    async function syncWithGoogleSheet(silent = false, forceRefresh = false) {
        if (!webAppUrl) {
            if (!silent) showNotification('Настройте URL Google Apps Script', 'warning');
            return;
        }

        // Загружаем кэш (всегда, для отображения)
        const cachedData = getCachedPromoCodes();
        // Проверяем, устарел ли кэш
        const freshCacheData = getCachedPromoCodes(true);

        // Если кэш свежий и это тихая загрузка без принудительного обновления
        if (freshCacheData && silent && !forceRefresh) {
            promoCodesCache = freshCacheData;
            updateStatistics();
            return;
        }

        // Если кэш устарел, но данные есть - сначала показываем их
        if (cachedData && !promoCodesCache.length) {
            promoCodesCache = cachedData;
            updateStatistics();
        }

        if (!silent) showNotification('Загружаю промокоды из Google Таблицы...', 'info');

        try {
            const response = await makeGoogleScriptRequest('GET', { action: 'getAll' });

            if (response.promoCodes) {
                promoCodesCache = response.promoCodes;
                cachePromoCodes(promoCodesCache);
                updateStatistics();
                
                const activeTab = document.querySelector('.promo-tab.active');
                if (activeTab && activeTab.dataset.tab === 'list') {
                    const googleList = document.getElementById('google-promos-list');
                    if (googleList) {
                        googleList.innerHTML = renderGooglePromosList();
                        attachDeleteButtonsListeners();
                    }
                }
                
                if (!silent) showNotification(`Загружено ${promoCodesCache.length} промокодов из Google Таблицы`, 'success');
            }
        } catch (error) {
            console.error('Ошибка синхронизации:', error);
            if (!silent) showNotification('Ошибка загрузки промокодов: ' + error.message, 'error');
        }
    }

    function parseAmoCRMPromoCode(value) {
        const bracketMatch = value.match(/^(.+?)\s*\((.+)\)$/);
        
        if (bracketMatch) {
            return {
                code: bracketMatch[1].trim(),
                description: bracketMatch[2].trim()
            };
        }
        
        return {
            code: value.trim(),
            description: ''
        };
    }

    async function syncWithAmoCRM(silent = false) {
        if (!silent) showNotification('Загружаю промокоды из amoCRM...', 'info');

        try {
            const domain = window.location.hostname;
            const apiUrl = `https://${domain}/api/v4/leads/custom_fields/${PROMO_FIELD_ID}`;

            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.enums && Array.isArray(data.enums)) {
                amoCRMPromoCodes = data.enums.map(e => ({
                    id: e.id,
                    value: e.value,
                    sort: e.sort
                }));
                
                cacheAmoCRMPromoCodes(amoCRMPromoCodes);
                
                if (!silent) showNotification(`Загружено ${amoCRMPromoCodes.length} промокодов из amoCRM`, 'success');
                updateStatistics();
                
                const activeTab = document.querySelector('.promo-tab.active');
                if (activeTab && activeTab.dataset.tab === 'list') {
                    const amoCRMList = document.getElementById('amocrm-promos-list');
                    if (amoCRMList) {
                        amoCRMList.innerHTML = renderAmoCRMPromosList();
                        attachDeleteButtonsListeners();
                    }
                }
                
                if (webAppUrl && amoCRMPromoCodes.length > 0 && !silent) {
                    await syncAmoCRMToGoogleSheets();
                }
            } else {
                if (!silent) showNotification('Не удалось получить список промокодов', 'warning');
            }
        } catch (error) {
            console.error('Ошибка загрузки из amoCRM:', error);
            if (!silent) showNotification('Ошибка загрузки из amoCRM', 'error');
        }
    }

    async function syncAmoCRMToGoogleSheets() {
        if (!webAppUrl) return;

        try {
            showNotification('Синхронизирую промокоды с Google Таблицей...', 'info');
            
            const formattedPromoCodes = amoCRMPromoCodes.map(promo => {
                const parsed = parseAmoCRMPromoCode(promo.value);
                return {
                    code: parsed.code,
                    type: 'многоразовый',
                    discount: 0,
                    discountType: 'процент',
                    minOrderAmount: '',
                    expiryDate: '',
                    maxUsages: '',
                    status: 'активен',
                    phoneBinding: '',
                    employee: '',
                    description: parsed.description
                };
            });

            const response = await makeGoogleScriptRequest('POST', {
                action: 'syncFromAmoCRM',
                promoCodes: formattedPromoCodes
            });

            if (response.success) {
                showNotification(
                    `${response.message}`, 
                    'success'
                );
                
                await syncWithGoogleSheet(true);
            } else {
                showNotification('Ошибка синхронизации с Google Таблицей', 'warning');
            }
        } catch (error) {
            console.error('Ошибка синхронизации с Google:', error);
        }
    }

    /**
     * Синхронизирует промокоды из Google Таблицы в amoCRM
     * Добавляет только те промокоды, которых нет в amoCRM
     */
    async function syncGoogleToAmoCRM() {
        try {
            // Сначала обновим данные из обоих источников
            await syncWithGoogleSheet(true);
            await syncWithAmoCRM(true);

            // Получаем список промокодов из amoCRM (только коды, в верхнем регистре)
            const amoCRMCodesSet = new Set(
                amoCRMPromoCodes.map(p => {
                    const parsed = parseAmoCRMPromoCode(p.value);
                    return parsed.code.toUpperCase();
                })
            );

            // Находим промокоды, которые есть в Google, но нет в amoCRM
            const missingInAmoCRM = promoCodesCache.filter(promo =>
                !amoCRMCodesSet.has(promo.code.toUpperCase())
            );

            if (missingInAmoCRM.length === 0) {
                showNotification('Все промокоды из Google Таблицы уже есть в amoCRM', 'success');
                return;
            }

            // Показываем подтверждение
            const confirmMessage = `Найдено ${missingInAmoCRM.length} промокодов в Google Таблице, которых нет в amoCRM:\n\n${missingInAmoCRM.map(p => p.code).join(', ')}\n\nДобавить их в amoCRM?`;

            if (!confirm(confirmMessage)) {
                showNotification('Синхронизация отменена', 'info');
                return;
            }

            showNotification(`Добавляю ${missingInAmoCRM.length} промокодов в amoCRM...`, 'info');

            let addedCount = 0;
            let errorCount = 0;

            for (const promo of missingInAmoCRM) {
                try {
                    await addPromoCodeToAmoCRM(promo.code);
                    addedCount++;
                    console.log(`[Синхронизация] Добавлен промокод: ${promo.code}`);
                } catch (error) {
                    errorCount++;
                    console.error(`[Синхронизация] Ошибка добавления промокода ${promo.code}:`, error);
                }
            }

            // Обновляем список промокодов amoCRM
            await syncWithAmoCRM(true);

            if (errorCount === 0) {
                showNotification(`Успешно добавлено ${addedCount} промокодов в amoCRM`, 'success');
            } else {
                showNotification(`Добавлено ${addedCount} промокодов, ошибок: ${errorCount}`, 'warning');
            }

            // Обновляем статистику
            updateStatistics();
        } catch (error) {
            console.error('Ошибка синхронизации Google → amoCRM:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    function cacheAmoCRMPromoCodes(promoCodes) {
        try {
            localStorage.setItem('amocrm_promo_codes_cache', JSON.stringify(promoCodes));
            console.log('amoCRM промокоды закэшированы:', promoCodes.length);
        } catch (error) {
            console.error('Ошибка кэширования amoCRM промокодов:', error);
        }
    }

    function getCachedAmoCRMPromoCodes() {
        try {
            const cached = localStorage.getItem('amocrm_promo_codes_cache');
            if (cached) {
                const promoCodes = JSON.parse(cached);
                console.log('Загружено из кэша amoCRM промокодов:', promoCodes.length);
                return promoCodes;
            }
        } catch (error) {
            console.error('Ошибка чтения кэша amoCRM:', error);
        }
        return null;
    }

    // ==================== Аналитика применения промокодов ====================
    // Источник данных - живой поиск сделок в amoCRM по значению поля промокода
    // (PROMO_FIELD_ID). Ничего не пишем в Google Sheets, только читаем API amoCRM.

    // Единый шрифт интерфейса (как в остальном скрипте)
    const AN_FONT = `Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`;
    // Системные статусы amoCRM: 142 - успешно реализовано, 143 - закрыто и не реализовано
    const AMO_STATUS_WON = 142;
    const AMO_STATUS_LOST = 143;

    // --- Кэш воронок (соответствие status_id -> название этапа, основная воронка)
    function cachePipelines(obj) {
        try {
            localStorage.setItem('promo_pipelines_cache_v1', JSON.stringify({ ts: Date.now(), data: obj }));
        } catch (e) {
            console.error('Ошибка кэширования воронок:', e);
        }
    }

    function getCachedPipelines() {
        try {
            const raw = localStorage.getItem('promo_pipelines_cache_v1');
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && (Date.now() - parsed.ts < CACHE_DURATION)) return parsed.data;
        } catch (e) {
            console.error('Ошибка чтения кэша воронок:', e);
        }
        return null;
    }

    // --- Кэш результатов аналитики промокодов
    function cachePromoAnalytics(obj) {
        try {
            localStorage.setItem('promo_analytics_cache_v2', JSON.stringify(obj));
        } catch (e) {
            console.error('Ошибка кэширования аналитики промокодов:', e);
        }
    }

    function getCachedPromoAnalytics() {
        try {
            const raw = localStorage.getItem('promo_analytics_cache_v2');
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.error('Ошибка чтения кэша аналитики промокодов:', e);
        }
        return null;
    }

    // Получаем основную воронку и карту статусов (одним запросом, кэш 10 мин)
    async function getMainPipelineAndStatuses() {
        const cached = getCachedPipelines();
        if (cached) return cached;

        const domain = window.location.hostname;
        const resp = await fetch(`https://${domain}/api/v4/leads/pipelines`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} (воронки)`);
        const data = await resp.json();
        const pipelines = (data && data._embedded && data._embedded.pipelines) || [];
        const main = pipelines.find(p => p.is_main) || pipelines[0];

        const statusMap = {};
        if (main && main._embedded && main._embedded.statuses) {
            main._embedded.statuses.forEach(s => { statusMap[s.id] = s.name; });
        }
        // Подписываем системные статусы, если их нет в карте воронки
        if (!statusMap[AMO_STATUS_WON]) statusMap[AMO_STATUS_WON] = 'Успешно реализовано';
        if (!statusMap[AMO_STATUS_LOST]) statusMap[AMO_STATUS_LOST] = 'Закрыто и не реализовано';

        const result = {
            mainPipelineId: main ? main.id : null,
            pipelineName: main ? main.name : '',
            statusMap
        };
        cachePipelines(result);
        return result;
    }

    // Проходим все страницы выдачи /api/v4/leads по baseUrl
    async function fetchLeadsPaged(baseUrl, onPage) {
        const leads = [];
        let page = 1;
        while (true) {
            const url = baseUrl + `&page=${page}`;
            const resp = await fetch(url, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });
            if (resp.status === 204) break;            // нет данных
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const batch = (data && data._embedded && data._embedded.leads) || [];
            leads.push(...batch);
            if (typeof onPage === 'function') onPage(page, leads.length);
            if (!data || !data._links || !data._links.next) break;   // последняя страница
            page++;
            if (page > 60) break;                       // предохранитель (60*250=15000)
        }
        return leads;
    }

    // Основной способ: один проход по основной воронке за период,
    // чтение поля промокода у каждой сделки и группировка по enum_id.
    // Это ровно то, что делает фильтр по промокоду в интерфейсе amoCRM (надёжно,
    // в отличие от точечного filter[custom_fields_values], который для списковых
    // полей отдаёт часть значений некорректно).
    async function fetchAllMainPipelineLeadsGrouped(period, mainId) {
        const domain = window.location.hostname;
        let base = `https://${domain}/api/v4/leads?limit=250`;
        if (mainId) base += `&filter[pipeline_id]=${mainId}`;
        if (period && period.from) base += `&filter[created_at][from]=${period.from}`;
        if (period && period.to) base += `&filter[created_at][to]=${period.to}`;
        base += `&order[created_at]=desc`;

        const leads = await fetchLeadsPaged(base, (page, total) => {
            updateAnalyticsProgress(0, 0, `Обхожу основную воронку: загружено ${total} сделок`);
        });

        const grouped = {};
        let withPromo = 0;
        leads.forEach(lead => {
            const cf = (lead.custom_fields_values || []).find(f => f.field_id === PROMO_FIELD_ID);
            if (!cf || !cf.values || !cf.values.length) return;
            const val = cf.values[0];
            const enumId = val.enum_id;
            if (enumId == null) return;
            withPromo++;
            // Название промокода берём прямо из сделки (не зависим от кэша enum-значений)
            if (!grouped[enumId]) grouped[enumId] = { value: val.value || '', leads: [] };
            grouped[enumId].leads.push(lead);
        });
        console.log(`[Аналитика промокодов] Воронка ${mainId}: всего сделок ${leads.length}, с промокодом ${withPromo}, различных промокодов ${Object.keys(grouped).length}`);
        return grouped;
    }

    // Оставляем в кэше только нужные поля сделки
    function pickLeadFields(lead) {
        // Флорист - списковое поле сделки, достаём по образцу поля промокода
        const ff = (lead.custom_fields_values || []).find(f => f.field_id === FLORIST_FIELD_ID);
        const florist = (ff && ff.values && ff.values[0] && ff.values[0].value) || '';
        return {
            id: lead.id,
            name: lead.name || ('Сделка ' + lead.id),
            price: Number(lead.price) || 0,
            created_at: lead.created_at,
            status_id: lead.status_id,
            pipeline_id: lead.pipeline_id,
            florist: florist
        };
    }

    // Метрики по одному коду
    function computeCodeMetrics(leads) {
        const count = leads.length;
        const sumBudget = leads.reduce((s, l) => s + (Number(l.price) || 0), 0);
        const won = leads.filter(l => l.status_id === AMO_STATUS_WON).length;
        const conversion = count ? (won / count) * 100 : 0;
        return { count, sumBudget, won, conversion };
    }

    // Строит аналитику по всем промокодам: один обход основной воронки за период
    // и группировка сделок по значению поля промокода (enum_id).
    async function buildPromoAnalytics(period) {
        // Обновляем список значений поля промокода, чтобы перечень «без применений»
        // был полным и актуальным. Ошибки внутри проглатываются самой функцией.
        await syncWithAmoCRM(true);
        const pinfo = await getMainPipelineAndStatuses();
        const mainId = pinfo.mainPipelineId;
        const codes = amoCRMPromoCodes || [];
        const result = {
            ts: Date.now(),
            period,
            mainPipelineId: mainId,
            pipelineName: pinfo.pipelineName,
            statusMap: pinfo.statusMap,
            byCode: {},
            totalCodes: codes.length
        };

        // Карта enum_id -> текст промокода (для подписи строк)
        const nameByEnum = {};
        codes.forEach(c => { nameByEnum[c.id] = c.value; });

        const grouped = await fetchAllMainPipelineLeadsGrouped(period, mainId);

        const byCode = {};
        Object.keys(grouped).forEach(enumId => {
            const g = grouped[enumId];
            byCode[enumId] = {
                code: g.value || nameByEnum[enumId] || ('Промокод #' + enumId),
                enumId: Number(enumId),
                leads: g.leads.map(pickLeadFields)
            };
        });

        result.byCode = byCode;
        cachePromoAnalytics(result);
        return result;
    }

    // Определяем активный период фильтра -> строки дат и unix-границы (секунды)
    function getPromoAnalyticsPeriod() {
        const active = document.querySelector('.promo-an-period-btn.active');
        const key = active ? active.dataset.period : 'month';
        let startStr, endStr;
        const today = new Date();

        if (key === 'today') {
            startStr = formatDateForInput(today);
            endStr = startStr;
        } else if (key === 'week') {
            const d = new Date(today);
            d.setDate(today.getDate() - 7);
            startStr = formatDateForInput(d);
            endStr = formatDateForInput(today);
        } else if (key === 'custom') {
            startStr = document.getElementById('promo-an-start')?.value;
            endStr = document.getElementById('promo-an-end')?.value;
        } else {
            // month (по умолчанию)
            const d = new Date(today);
            d.setMonth(today.getMonth() - 1);
            startStr = formatDateForInput(d);
            endStr = formatDateForInput(today);
        }

        const from = startStr ? Math.floor(new Date(startStr + 'T00:00:00').getTime() / 1000) : null;
        const to = endStr ? Math.floor(new Date(endStr + 'T23:59:59').getTime() / 1000) : null;
        return { key, startStr, endStr, from, to };
    }

    // HTML блока аналитики (вставляется в renderListTab только для админа)
    function renderPromoAnalyticsBlockHtml() {
        const today = new Date();
        const todayStr = formatDateForInput(today);
        const monthAgo = new Date(today);
        monthAgo.setMonth(today.getMonth() - 1);
        const monthAgoStr = formatDateForInput(monthAgo);

        const mkPeriodBtn = (key, label, active) => `
            <button class="promo-an-period-btn${active ? ' active' : ''}" data-period="${key}" style="
                padding: 10px; border: none; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 600; font-family: ${AN_FONT}; transition: all 0.2s;
                background: ${active ? '#E6407A' : '#fff'};
                color: ${active ? 'white' : '#6E6E7A'};">${label}</button>`;

        return `
            <hr style="border: none; border-top: 1px solid #E7E7EC; margin: 30px 0;">
            <div id="promo-analytics-section" style="background: #F7F7F9; border-radius: 12px; padding: 20px; border: 1px solid #E7E7EC;">
                <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #E6407A; font-family: ${AN_FONT}; display: flex; align-items: center; gap: 10px;">
                     Аналитика применения промокодов
                    <button id="refresh-promo-analytics-btn" style="padding: 5px 12px; background: #E6407A; color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 12px; font-family: ${AN_FONT}; margin-left: auto;">Обновить</button>
                </h3>
                <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 12px; font-family: ${AN_FONT};">Поднимает сделки по значению поля промокода прямо из amoCRM.</div>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px;">
                    ${mkPeriodBtn('today', 'Сегодня', false)}
                    ${mkPeriodBtn('week', 'Неделя', false)}
                    ${mkPeriodBtn('month', 'Месяц', true)}
                    ${mkPeriodBtn('custom', 'Произвольный', false)}
                </div>
                <div id="promo-an-custom-block" style="display: none; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                    <div>
                        <label style="display:block; margin-bottom:5px; font-size:12px; color:#6E6E7A; font-family:${AN_FONT};">Начало:</label>
                        <input type="date" id="promo-an-start" value="${monthAgoStr}" style="width:100%; padding:10px; border:2px solid #FDEFF4; border-radius:6px; font-size:13px; box-sizing:border-box; font-family:${AN_FONT};">
                    </div>
                    <div>
                        <label style="display:block; margin-bottom:5px; font-size:12px; color:#6E6E7A; font-family:${AN_FONT};">Конец:</label>
                        <input type="date" id="promo-an-end" value="${todayStr}" style="width:100%; padding:10px; border:2px solid #FDEFF4; border-radius:6px; font-size:13px; box-sizing:border-box; font-family:${AN_FONT};">
                    </div>
                </div>
                <button id="load-promo-analytics-btn" style="width:100%; padding:12px; background: #E6407A; color:white; border:none; border-radius:8px; cursor:pointer; font-size:15px; font-weight:bold; font-family:${AN_FONT};">Загрузить аналитику</button>
                <div id="promo-analytics-progress" style="margin-top:12px; font-size:13px; color:#E6407A; font-family:${AN_FONT}; text-align:center;"></div>
                <div id="promo-analytics-summary" style="margin-top:15px;"></div>
                <div id="promo-analytics-details" style="margin-top:15px;"></div>
                <div id="promo-florist-summary" style="margin-top:20px;"></div>
                <div id="promo-florist-details" style="margin-top:15px;"></div>
            </div>`;
    }

    // Подсветка активной кнопки периода (используется при отрисовке из кэша)
    function setActivePromoPeriodButton(key) {
        const buttons = document.querySelectorAll('.promo-an-period-btn');
        buttons.forEach(b => {
            const on = b.dataset.period === key;
            b.classList.toggle('active', on);
            b.style.background = on ? '#E6407A' : '#fff';
            b.style.color = on ? 'white' : '#6E6E7A';
        });
        const customBlock = document.getElementById('promo-an-custom-block');
        if (customBlock) customBlock.style.display = (key === 'custom') ? 'grid' : 'none';
    }

    // Навешиваем обработчики блока аналитики
    function initPromoAnalyticsBlock() {
        const section = document.getElementById('promo-analytics-section');
        if (!section) return;

        const periodButtons = section.querySelectorAll('.promo-an-period-btn');
        periodButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                periodButtons.forEach(b => {
                    b.classList.remove('active');
                    b.style.background = '#fff';
                    b.style.color = '#6E6E7A';
                });
                btn.classList.add('active');
                btn.style.background = '#E6407A';
                btn.style.color = 'white';
                const customBlock = document.getElementById('promo-an-custom-block');
                if (customBlock) customBlock.style.display = (btn.dataset.period === 'custom') ? 'grid' : 'none';
            });
        });

        const loadBtn = document.getElementById('load-promo-analytics-btn');
        if (loadBtn) loadBtn.onclick = () => loadPromoAnalytics(true);
        const refreshBtn = document.getElementById('refresh-promo-analytics-btn');
        if (refreshBtn) refreshBtn.onclick = () => loadPromoAnalytics(true);

        // При наличии свежего кэша сразу показываем данные (без запроса)
        loadPromoAnalytics(false);
    }

    // Обновление строки прогресса
    function updateAnalyticsProgress(done, total, label) {
        const el = document.getElementById('promo-analytics-progress');
        if (!el) return;
        if (!total && !label) { el.textContent = ''; return; }
        if (total) el.textContent = `${label || 'Загрузка'}: ${done} из ${total}...`;
        else el.textContent = `${label || 'Загрузка'}...`;
    }

    // Главная точка входа блока: грузит из кэша или запрашивает заново
    async function loadPromoAnalytics(forceRefresh) {
        const summaryEl = document.getElementById('promo-analytics-summary');
        const detailsEl = document.getElementById('promo-analytics-details');
        const floristDetailsEl = document.getElementById('promo-florist-details');
        if (!summaryEl) return;
        if (detailsEl) detailsEl.innerHTML = '';
        if (floristDetailsEl) floristDetailsEl.innerHTML = '';

        const period = getPromoAnalyticsPeriod();
        if (period.key === 'custom' && (!period.from || !period.to)) {
            showNotification('Укажите даты произвольного периода', 'warning');
            return;
        }

        // Попытка отдать из кэша (только если период совпадает и кэш свежий)
        if (!forceRefresh) {
            const cached = getCachedPromoAnalytics();
            if (cached && (Date.now() - cached.ts < CACHE_DURATION) && cached.period &&
                cached.period.key === period.key && cached.period.startStr === period.startStr &&
                cached.period.endStr === period.endStr) {
                setActivePromoPeriodButton(cached.period.key);
                renderPromoSummaryTable(cached);
                renderFloristReplacements(cached);
                updateAnalyticsProgress(0, 0);
                return;
            }
            summaryEl.innerHTML = `<div style="text-align:center; padding:25px; color:#9C9CA8; font-family:${AN_FONT}; font-size:14px;">Нажмите «Загрузить аналитику» для просмотра статистики по промокодам</div>`;
            return;
        }

        if (!amoCRMPromoCodes || amoCRMPromoCodes.length === 0) {
            summaryEl.innerHTML = `<div style="text-align:center; padding:25px; color:#A85F0F; font-family:${AN_FONT}; font-size:14px;">Промокоды из amoCRM не загружены. Откройте «Настройки» и синхронизируйте промокоды.</div>`;
            return;
        }

        updateAnalyticsProgress(0, 0, 'Обхожу основную воронку');
        try {
            const analytics = await buildPromoAnalytics(period);
            updateAnalyticsProgress(0, 0);
            renderPromoSummaryTable(analytics);
            renderFloristReplacements(analytics);
            const totalLeads = Object.values(analytics.byCode).reduce((s, c) => s + c.leads.length, 0);
            showNotification(`Аналитика промокодов загружена: сделок ${totalLeads}`, 'success');
        } catch (e) {
            console.error('[Аналитика промокодов] Ошибка:', e);
            updateAnalyticsProgress(0, 0);
            summaryEl.innerHTML = `<div style="text-align:center; padding:25px; color:#B23B3B; font-family:${AN_FONT}; font-size:14px;">Ошибка загрузки: ${e.message}</div>`;
            showNotification('Ошибка загрузки аналитики промокодов', 'error');
        }
    }

    // Сводная таблица по всем кодам (строки кликабельны -> детализация)
    function renderPromoSummaryTable(analytics) {
        const summaryEl = document.getElementById('promo-analytics-summary');
        if (!summaryEl) return;

        const rows = Object.values(analytics.byCode)
            .map(c => ({ ...c, metrics: computeCodeMetrics(c.leads) }))
            .filter(c => c.metrics.count > 0)
            .sort((a, b) => b.metrics.count - a.metrics.count);

        // Промокоды без применений за период = значения поля, которых нет среди применённых
        const appliedEnumIds = new Set(rows.map(c => String(c.enumId)));
        const zeroCodes = (amoCRMPromoCodes || [])
            .filter(c => !appliedEnumIds.has(String(c.id)))
            .map(c => parseAmoCRMPromoCode(c.value));
        const zeroCount = zeroCodes.length;
        const totalApplies = rows.reduce((s, c) => s + c.metrics.count, 0);
        const totalBudget = rows.reduce((s, c) => s + c.metrics.sumBudget, 0);

        if (rows.length === 0) {
            summaryEl.innerHTML = `<div style="text-align:center; padding:25px; color:#9C9CA8; font-family:${AN_FONT}; font-size:14px;">За выбранный период сделок с промокодами не найдено</div>`;
            return;
        }

        const rowsHtml = rows.map(c => {
            const m = c.metrics;
            const parsed = parseAmoCRMPromoCode(c.code);
            return `
                <tr class="promo-an-row" data-enum-id="${c.enumId}" style="cursor:pointer; border-bottom:1px solid #FDEFF4; transition:background 0.15s;">
                    <td style="padding:10px 8px; font-family:${AN_FONT}; font-size:13px; color:#16161A; font-weight:600;">${parsed.code}${parsed.description ? ` <span style="color:#9C9CA8; font-weight:400;">(${parsed.description})</span>` : ''}</td>
                    <td style="padding:10px 8px; text-align:center; font-family:${AN_FONT}; font-size:14px; color:#CF356B; font-weight:bold;">${m.count}</td>
                    <td style="padding:10px 8px; text-align:right; font-family:${AN_FONT}; font-size:13px; color:#16161A;">${m.sumBudget.toLocaleString('ru-RU')} ₽</td>
                    <td style="padding:10px 8px; text-align:center; font-family:${AN_FONT}; font-size:13px; color:#237A4C;">${m.conversion.toFixed(1)}% <span style="color:#9C9CA8; font-size:11px;">(${m.won}/${m.count})</span></td>
                </tr>`;
        }).join('');

        summaryEl.innerHTML = `
            <div style="background:white; border-radius:10px; padding:12px; border:2px solid #FDEFF4;">
                <div style="display:flex; gap:15px; flex-wrap:wrap; margin-bottom:10px; font-family:${AN_FONT}; font-size:12px; color:#6E6E7A;">
                    <span>Воронка: <strong style="color:#E6407A;">${analytics.pipelineName || '-'}</strong></span>
                    <span>Промокодов с применением: <strong style="color:#E6407A;">${rows.length}</strong></span>
                    <span>Всего применений: <strong style="color:#E6407A;">${totalApplies}</strong></span>
                    <span>Сумма бюджетов: <strong style="color:#E6407A;">${totalBudget.toLocaleString('ru-RU')} ₽</strong></span>
                </div>
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:2px solid #E6407A;">
                            <th style="padding:8px; text-align:left; font-family:${AN_FONT}; font-size:12px; color:#E6407A;">Промокод</th>
                            <th style="padding:8px; text-align:center; font-family:${AN_FONT}; font-size:12px; color:#E6407A;">Применений</th>
                            <th style="padding:8px; text-align:right; font-family:${AN_FONT}; font-size:12px; color:#E6407A;">Сумма бюджетов</th>
                            <th style="padding:8px; text-align:center; font-family:${AN_FONT}; font-size:12px; color:#E6407A;">Конверсия</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                ${zeroCount > 0 ? `
                <div style="margin-top:10px;">
                    <button id="promo-an-zero-toggle" style="background:none; border:none; cursor:pointer; padding:0; font-family:${AN_FONT}; font-size:12px; color:#E6407A; text-decoration:underline;">Промокодов без применений за период: ${zeroCount} - показать</button>
                    <div id="promo-an-zero-list" style="display:none; margin-top:8px; padding:10px; background:#FFF7FA; border:1px dashed #E6407A; border-radius:8px;">
                        ${zeroCodes.map(p => `<span style="display:inline-block; margin:3px 5px 3px 0; padding:3px 8px; background:#fff; border:1px solid #FDEFF4; border-radius:12px; font-size:12px; font-family:${AN_FONT}; color:#6E6E7A;">${p.code}${p.description ? ` <span style="color:#C6C6D0;">(${p.description})</span>` : ''}</span>`).join('')}
                    </div>
                </div>` : ''}
                <div style="margin-top:8px; font-size:11px; color:#C6C6D0; font-family:${AN_FONT};">Нажмите на строку, чтобы увидеть сделки конкретного промокода</div>
            </div>`;

        summaryEl.querySelectorAll('.promo-an-row').forEach(row => {
            row.addEventListener('click', () => renderPromoCodeDetails(row.dataset.enumId, analytics));
        });

        // Кнопка «показать/скрыть» список промокодов без применений
        const zeroToggle = document.getElementById('promo-an-zero-toggle');
        if (zeroToggle) {
            zeroToggle.addEventListener('click', () => {
                const list = document.getElementById('promo-an-zero-list');
                if (!list) return;
                const shown = list.style.display !== 'none';
                list.style.display = shown ? 'none' : 'block';
                zeroToggle.textContent = `Промокодов без применений за период: ${zeroCount} - ${shown ? 'показать' : 'скрыть'}`;
            });
        }
    }

    // Детализация: список сделок конкретного кода со ссылками
    function renderPromoCodeDetails(enumId, analytics) {
        const detailsEl = document.getElementById('promo-analytics-details');
        if (!detailsEl) return;

        const entry = analytics.byCode[enumId];
        if (!entry) { detailsEl.innerHTML = ''; return; }

        const domain = window.location.hostname;
        const statusMap = analytics.statusMap || {};
        const parsed = parseAmoCRMPromoCode(entry.code);
        const leads = (entry.leads || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        if (leads.length === 0) {
            detailsEl.innerHTML = `<div style="text-align:center; padding:20px; color:#9C9CA8; font-family:${AN_FONT}; font-size:13px;">Сделок не найдено</div>`;
            return;
        }

        const items = leads.map(l => {
            const url = `https://${domain}/leads/detail/${l.id}`;
            const stage = statusMap[l.status_id] || ('Этап ' + l.status_id);
            const isWon = l.status_id === AMO_STATUS_WON;
            const isLost = l.status_id === AMO_STATUS_LOST;
            const stageColor = isWon ? '#237A4C' : isLost ? '#B23B3B' : '#C77A18';
            const dateStr = l.created_at ? formatDate(l.created_at * 1000) : '';
            return `
                <div style="background:#fff; border-left:4px solid ${stageColor}; border-radius:8px; padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:10px;">
                        <div style="flex:1;">
                            <div style="font-size:14px; font-family:${AN_FONT};"><a href="${url}" target="_blank" style="color:#E6407A; text-decoration:none; font-weight:600;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${l.name}</a></div>
                            <div style="font-size:12px; color:#6E6E7A; font-family:${AN_FONT}; margin-top:4px;">${stage} • ${analytics.pipelineName || ''}</div>
                            <div style="font-size:11px; color:#9C9CA8; font-family:${AN_FONT}; margin-top:3px;">${dateStr}</div>
                        </div>
                        <div style="text-align:right; font-size:14px; font-weight:bold; color:#16161A; font-family:${AN_FONT}; white-space:nowrap;">${(Number(l.price) || 0).toLocaleString('ru-RU')} ₽</div>
                    </div>
                </div>`;
        }).join('');

        detailsEl.innerHTML = `
            <div style="background:#FDEFF4; border-radius:10px; padding:15px; border:2px solid #E6407A;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h4 style="margin:0; font-size:15px; color:#E6407A; font-family:${AN_FONT};">Сделки по промокоду «${parsed.code}» (${leads.length})</h4>
                    <button id="promo-an-close-details" style="background:#E6407A; color:white; border:none; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:12px; font-family:${AN_FONT};">Скрыть</button>
                </div>
                <div style="max-height:400px; overflow-y:auto;">${items}</div>
            </div>`;

        const closeBtn = document.getElementById('promo-an-close-details');
        if (closeBtn) closeBtn.onclick = () => { detailsEl.innerHTML = ''; };
        detailsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Отдельный блок «Замены по флористам»: берёт сделки промокода «замена»
    // и группирует их по флористу, который изначально собирал букет.
    function renderFloristReplacements(analytics) {
        const summaryEl = document.getElementById('promo-florist-summary');
        const detailsEl = document.getElementById('promo-florist-details');
        if (!summaryEl) return;
        if (detailsEl) detailsEl.innerHTML = '';

        // Находим запись промокода «замена» среди применённых кодов (регистронезависимо)
        const entry = Object.values(analytics.byCode).find(c => {
            const parsed = parseAmoCRMPromoCode(c.code);
            return (parsed.code || '').trim().toLowerCase() === REPLACEMENT_CODE;
        });

        const wrap = (inner) => `
            <div style="background:#FCF4E8; border-radius:12px; padding:20px; border:2px solid #F0D8B0;">
                <h3 style="margin:0 0 12px 0; font-size:17px; color:#C77A18; font-family:${AN_FONT}; display:flex; align-items:center; gap:8px;">Замены по флористам</h3>
                ${inner}
            </div>`;

        if (!entry || !entry.leads || entry.leads.length === 0) {
            summaryEl.innerHTML = wrap(`<div style="text-align:center; padding:15px; color:#9C9CA8; font-family:${AN_FONT}; font-size:14px;">За выбранный период сделок с промокодом «замена» не найдено</div>`);
            return;
        }

        // Группируем сделки-замены по флористу
        const byFlorist = {};
        entry.leads.forEach(l => {
            const name = (l.florist && String(l.florist).trim()) || 'Не указан';
            if (!byFlorist[name]) byFlorist[name] = [];
            byFlorist[name].push(l);
        });

        const rows = Object.keys(byFlorist)
            .map(name => ({ name, leads: byFlorist[name], metrics: computeCodeMetrics(byFlorist[name]) }))
            .sort((a, b) => b.metrics.count - a.metrics.count);

        const totalReplacements = entry.leads.length;
        const totalBudget = rows.reduce((s, r) => s + r.metrics.sumBudget, 0);

        const rowsHtml = rows.map(r => {
            const isUnknown = r.name === 'Не указан';
            return `
                <tr class="promo-florist-row" data-florist="${encodeURIComponent(r.name)}" style="cursor:pointer; border-bottom:1px solid #FFE0B2; transition:background 0.15s;">
                    <td style="padding:10px 8px; font-family:${AN_FONT}; font-size:13px; color:${isUnknown ? '#9C9CA8' : '#16161A'}; font-weight:600;">${r.name}</td>
                    <td style="padding:10px 8px; text-align:center; font-family:${AN_FONT}; font-size:14px; color:#C77A18; font-weight:bold;">${r.metrics.count}</td>
                    <td style="padding:10px 8px; text-align:right; font-family:${AN_FONT}; font-size:13px; color:#16161A;">${r.metrics.sumBudget.toLocaleString('ru-RU')} ₽</td>
                </tr>`;
        }).join('');

        summaryEl.innerHTML = wrap(`
            <div style="display:flex; gap:15px; flex-wrap:wrap; margin-bottom:10px; font-family:${AN_FONT}; font-size:12px; color:#6E6E7A;">
                <span>Флористов с заменами: <strong style="color:#C77A18;">${rows.length}</strong></span>
                <span>Всего замен: <strong style="color:#C77A18;">${totalReplacements}</strong></span>
                <span>Сумма бюджетов: <strong style="color:#C77A18;">${totalBudget.toLocaleString('ru-RU')} ₽</strong></span>
            </div>
            <table style="width:100%; border-collapse:collapse; background:#fff; border-radius:8px;">
                <thead>
                    <tr style="border-bottom:2px solid #F0D8B0;">
                        <th style="padding:8px; text-align:left; font-family:${AN_FONT}; font-size:12px; color:#C77A18;">Флорист</th>
                        <th style="padding:8px; text-align:center; font-family:${AN_FONT}; font-size:12px; color:#C77A18;">Замен</th>
                        <th style="padding:8px; text-align:right; font-family:${AN_FONT}; font-size:12px; color:#C77A18;">Сумма бюджетов</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            <div style="margin-top:8px; font-size:11px; color:#C6C6D0; font-family:${AN_FONT};">Нажмите на флориста, чтобы увидеть сделки, по которым были замены</div>`);

        summaryEl.querySelectorAll('.promo-florist-row').forEach(row => {
            row.addEventListener('click', () => {
                const name = decodeURIComponent(row.dataset.florist);
                renderFloristDetails(name, byFlorist[name] || [], analytics);
            });
        });
    }

    // Детализация: список сделок-замен конкретного флориста со ссылками
    function renderFloristDetails(floristName, leads, analytics) {
        const detailsEl = document.getElementById('promo-florist-details');
        if (!detailsEl) return;

        const domain = window.location.hostname;
        const statusMap = analytics.statusMap || {};
        const sorted = (leads || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        if (sorted.length === 0) {
            detailsEl.innerHTML = `<div style="text-align:center; padding:20px; color:#9C9CA8; font-family:${AN_FONT}; font-size:13px;">Сделок не найдено</div>`;
            return;
        }

        const items = sorted.map(l => {
            const url = `https://${domain}/leads/detail/${l.id}`;
            const stage = statusMap[l.status_id] || ('Этап ' + l.status_id);
            const isWon = l.status_id === AMO_STATUS_WON;
            const isLost = l.status_id === AMO_STATUS_LOST;
            const stageColor = isWon ? '#237A4C' : isLost ? '#B23B3B' : '#C77A18';
            const dateStr = l.created_at ? formatDate(l.created_at * 1000) : '';
            return `
                <div style="background:#fff; border-left:4px solid ${stageColor}; border-radius:8px; padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:10px;">
                        <div style="flex:1;">
                            <div style="font-size:14px; font-family:${AN_FONT};"><a href="${url}" target="_blank" style="color:#C77A18; text-decoration:none; font-weight:600;" onmouseover="this.style.textDecoration='underline'" onmouseout="this.style.textDecoration='none'">${l.name}</a></div>
                            <div style="font-size:12px; color:#6E6E7A; font-family:${AN_FONT}; margin-top:4px;">${stage} • ${analytics.pipelineName || ''}</div>
                            <div style="font-size:11px; color:#9C9CA8; font-family:${AN_FONT}; margin-top:3px;">${dateStr}</div>
                        </div>
                        <div style="text-align:right; font-size:14px; font-weight:bold; color:#16161A; font-family:${AN_FONT}; white-space:nowrap;">${(Number(l.price) || 0).toLocaleString('ru-RU')} ₽</div>
                    </div>
                </div>`;
        }).join('');

        detailsEl.innerHTML = `
            <div style="background:#FCF4E8; border-radius:10px; padding:15px; border:2px solid #F0D8B0;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h4 style="margin:0; font-size:15px; color:#C77A18; font-family:${AN_FONT};">Замены флориста «${floristName}» (${sorted.length})</h4>
                    <button id="promo-florist-close-details" style="background:#C77A18; color:white; border:none; border-radius:6px; padding:4px 10px; cursor:pointer; font-size:12px; font-family:${AN_FONT};">Скрыть</button>
                </div>
                <div style="max-height:400px; overflow-y:auto;">${items}</div>
            </div>`;

        const closeBtn = document.getElementById('promo-florist-close-details');
        if (closeBtn) closeBtn.onclick = () => { detailsEl.innerHTML = ''; };
        detailsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function updateUsageCounter(code, phone, leadUrl) {
        if (!webAppUrl) {
            console.warn('[Промокоды] updateUsageCounter: webAppUrl не настроен');
            return;
        }

        console.log('[Промокоды] updateUsageCounter вызван:', {
            code: code,
            phone: phone,
            phoneClean: phone ? phone.replace(/\D/g, '') : null,
            leadUrl: leadUrl
        });

        try {
            const response = await makeGoogleScriptRequest('POST', {
                action: 'updateUsage',
                code: code,
                phone: phone,
                leadUrl: leadUrl || ''
            });

            console.log('[Промокоды] Ответ от сервера updateUsage:', response);

            if (response.success) {
                if (response.bindingFound) {
                    console.log('[Промокоды] Использование привязано к телефону');
                } else {
                    console.warn('[Промокоды] Телефон НЕ найден в привязках!', response.debug);
                    showNotification('Внимание: телефон не найден в списке сотрудников промокода', 'warning');
                }
                // forceRefresh=true чтобы загрузить актуальные данные после обновления счётчика
                await syncWithGoogleSheet(true, true);
            } else {
                console.error('[Промокоды] Ошибка от сервера:', response);
            }
        } catch (error) {
            console.error('[Промокоды] Ошибка обновления счетчика:', error);
            throw error;
        }
    }

    async function deleteGooglePromoCode(code) {
        console.log('deleteGooglePromoCode вызвана с кодом:', code);
        
        if (!isAdminAuthorized) {
            showNotification('Для удаления промокодов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
            return;
        }
        
        if (!confirm(`Вы уверены, что хотите удалить промокод "${code}" из Google Таблицы?`)) {
            console.log('Пользователь отменил удаление');
            return;
        }

        if (!webAppUrl) {
            console.error('Web App URL не настроен');
            showNotification('Настройте URL Google Apps Script', 'warning');
            return;
        }

        console.log('Отправляю запрос на удаление...');
        showNotification('Удаляю промокод...', 'info');

        try {
            const response = await makeGoogleScriptRequest('POST', {
                action: 'delete',
                code: code
            });

            console.log('Ответ от сервера:', response);

            if (response.success) {
                promoCodesCache = promoCodesCache.filter(p => p.code.toUpperCase() !== code.toUpperCase());
                cachePromoCodes(promoCodesCache);
                
                showNotification('Промокод удален из Google Таблицы!', 'success');
                
                switchTab('list');
            } else {
                console.error('Ошибка от сервера:', response.error);
                showNotification(`Ошибка: ${response.error || 'Не удалось удалить промокод'}`, 'error');
            }
        } catch (error) {
            console.error('Ошибка удаления промокода:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    async function deleteAmoCRMPromoCode(code, enumId) {
        if (!isAdminAuthorized) {
            showNotification('Для удаления промокодов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
            return;
        }
        
        if (!confirm(`Вы уверены, что хотите удалить промокод "${code}"?\n\nВнимание: Промокод будет удален из amoCRM и Google Таблицы.`)) {
            return;
        }

        showNotification('Удаляю промокод...', 'info');

        try {
            const domain = window.location.hostname;
            const fieldUrl = `https://${domain}/api/v4/leads/custom_fields/${PROMO_FIELD_ID}`;

            const getResponse = await fetch(fieldUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!getResponse.ok) {
                throw new Error(`Ошибка получения поля: HTTP ${getResponse.status}`);
            }

            const fieldData = await getResponse.json();
            const existingEnums = fieldData.enums || [];

            const updatedEnums = existingEnums.filter(e => e.id !== enumId);

            const updateResponse = await fetch(fieldUrl, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    enums: updatedEnums
                })
            });

            if (!updateResponse.ok) {
                throw new Error(`Ошибка удаления промокода: HTTP ${updateResponse.status}`);
            }

            amoCRMPromoCodes = amoCRMPromoCodes.filter(p => p.id !== enumId);
            cacheAmoCRMPromoCodes(amoCRMPromoCodes);

            if (webAppUrl) {
                const parsed = parseAmoCRMPromoCode(code);
                const cleanCode = parsed.code;
                
                try {
                    const deleteFromGoogleResponse = await makeGoogleScriptRequest('POST', {
                        action: 'delete',
                        code: cleanCode
                    });
                    
                    if (deleteFromGoogleResponse.success) {
                        console.log('Промокод также удален из Google Таблицы');
                        promoCodesCache = promoCodesCache.filter(p => p.code.toUpperCase() !== cleanCode.toUpperCase());
                        cachePromoCodes(promoCodesCache);
                    }
                } catch (googleError) {
                    console.warn('Не удалось удалить промокод из Google Таблицы:', googleError);
                }
            }
            
            showNotification('Промокод удален из amoCRM и Google Таблицы!', 'success');
            
            switchTab('list');

        } catch (error) {
            console.error('Ошибка удаления из amoCRM:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    function loadCurrentBonusPoints() {
        const bonusInput = document.querySelector(`input[name="CFV[${BONUS_FIELD_ID}]"]`);
        
        if (bonusInput && bonusInput.value) {
            currentBonusPoints = parseFloat(bonusInput.value) || 0;
        } else {
            currentBonusPoints = 0;
        }
        
        const firstNameInput = document.querySelector('input[name="contact[FN]"]');
        const lastNameInput = document.querySelector('input[name="contact[LN]"]');
        
        if (firstNameInput || lastNameInput) {
            const firstName = firstNameInput?.value || '';
            const lastName = lastNameInput?.value || '';
            currentContactName = `${firstName} ${lastName}`.trim() || 'Без имени';
        } else {
            currentContactName = 'Без имени';
        }
        
        const leadIdMatch = window.location.href.match(/\/leads\/detail\/(\d+)/);
        if (leadIdMatch) {
            const leadId = leadIdMatch[1];
            fetchContactIdFromLead(leadId);
        }
    }

    async function fetchContactIdFromLead(leadId) {
        try {
            const domain = window.location.hostname;
            const apiUrl = `https://${domain}/api/v4/leads/${leadId}?with=contacts`;
            
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data._embedded && data._embedded.contacts && data._embedded.contacts.length > 0) {
                    const contact = data._embedded.contacts[0];
                    currentContactId = contact.id;
                    await fetchBonusPointsFromAPI();
                }
            }
        } catch (error) {
            console.error('Ошибка получения ID контакта:', error);
        }
    }

    async function fetchBonusPointsFromAPI() {
        if (!currentContactId) return;

        try {
            const domain = window.location.hostname;
            const apiUrl = `https://${domain}/api/v4/contacts/${currentContactId}`;
            
            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.custom_fields_values) {
                    const bonusField = data.custom_fields_values.find(field => field.field_id === BONUS_FIELD_ID);
                    if (bonusField && bonusField.values && bonusField.values.length > 0) {
                        currentBonusPoints = parseFloat(bonusField.values[0].value) || 0;
                    }
                }
            }
        } catch (error) {
            console.error('Ошибка получения баллов из API:', error);
        }
    }

    async function modifyBonusPoints(action, inputId = 'bonus-points-input', resultId = 'bonus-result') {
        const resultDiv = document.getElementById(resultId);

        // Проверка авторизации: начисление требует админа, списание - нет
        if (!isAdminAuthorized && action === 'add') {
            showResult(resultDiv, 'Для начисления баллов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
            return;
        }

        if (!currentContactId) {
            showResult(resultDiv, 'Контакт не определен. Откройте сделку с привязанным контактом.', 'error');
            return;
        }

        const pointsInput = document.getElementById(inputId);
        const points = parseFloat(pointsInput.value);

        if (!points || points <= 0) {
            showResult(resultDiv, 'Введите корректное количество баллов', 'warning');
            return;
        }

        let newBalance;
        if (action === 'add') {
            newBalance = currentBonusPoints + points;
        } else if (action === 'subtract') {
            newBalance = currentBonusPoints - points;
            if (newBalance < 0) {
                showResult(resultDiv, 'Недостаточно баллов для списания', 'error');
                return;
            }
        }

        showResult(resultDiv, 'Обновляю баланс баллов...', 'info');

        try {
            const domain = window.location.hostname;
            const apiUrl = `https://${domain}/api/v4/contacts/${currentContactId}`;
            
            const payload = {
                custom_fields_values: [
                    {
                        field_id: BONUS_FIELD_ID,
                        values: [
                            {
                                value: newBalance.toFixed(2)
                            }
                        ]
                    }
                ]
            };

            const response = await fetch(apiUrl, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                currentBonusPoints = newBalance;
                
                const displayElement = document.getElementById('current-bonus-display');
                if (displayElement) {
                    displayElement.textContent = newBalance.toFixed(2);
                }
                
                const contactInfoElement = document.getElementById('contact-info');
                if (contactInfoElement && currentContactName) {
                    contactInfoElement.textContent = currentContactName;
                }
                
                const domInput = document.querySelector(`input[name="CFV[${BONUS_FIELD_ID}]"]`);
                if (domInput) {
                    domInput.value = newBalance.toFixed(2);
                }
                
                pointsInput.value = '';
                
                const actionText = action === 'add' ? 'начислено' : 'списано';
                showResult(resultDiv, `Успешно ${actionText} ${points.toFixed(2)} баллов. Новый баланс: ${newBalance.toFixed(2)}`, 'success');
                
                showNotification(`Баллы успешно ${actionText}!`, 'success');
                
                const transactionType = action === 'add' ? 'начисление' : 'списание';
                const leadIdMatch = window.location.href.match(/\/leads\/detail\/(\d+)/);
                const leadId = leadIdMatch ? leadIdMatch[1] : '';
                const leadName = document.querySelector('.card-name__name')?.textContent || '';
                
                await logBonusTransaction(transactionType, points, currentContactId, currentContactName, leadId, leadName, 'админ');
            } else {
                const errorText = await response.text();
                console.error('Ошибка обновления баллов:', errorText);
                showResult(resultDiv, `Ошибка обновления баллов: HTTP ${response.status}`, 'error');
            }
        } catch (error) {
            console.error('Ошибка изменения баллов:', error);
            showResult(resultDiv, `Ошибка: ${error.message}`, 'error');
        }
    }

    // Дата заявки приходит из таблицы ISO-строкой ("2026-09-11T11:22:25.000Z"),
    // показывать её как есть нельзя - переводим в привычный вид
    function formatRequestDate(value) {
        const ts = parseTransactionDate(value);
        if (!isFinite(ts)) return value || '';
        return new Date(ts).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    }

    function renderBonusRequestsList() {
        if (bonusRequestsCache.length === 0) {
            return `<div style="text-align: center; padding: 40px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                <div style="font-size: 48px; margin-bottom: 15px;"></div>
                <div style="font-size: 16px; margin-bottom: 10px;">Заявок пока нет</div>
                <div style="font-size: 14px;">Нажмите "Синхронизировать" чтобы загрузить заявки из Google Таблицы</div>
            </div>`;
        }
        
        // Новые заявки сверху: в Google Таблице строки идут в порядке добавления,
        // поэтому свежие заявки оказывались в самом низу списка
        const requests = bonusRequestsCache
            .slice()
            .sort((a, b) => parseTransactionDate(b.createdAt) - parseTransactionDate(a.createdAt));

        return requests.map(request => {
            const statusColors = {
                'ожидает': { bg: '#FCF4E8', text: '#856404' },
                'одобрено': { bg: '#E6F4EC', text: '#1E6B44' },
                'отклонено': { bg: '#FBECEC', text: '#721c24' }
            };
            
            const statusStyle = statusColors[request.status] || statusColors['ожидает'];
            
            return `
                <div style="background: #FAFAFB; border: 1px solid #E7E7EC; border-radius: 10px; padding: 15px; margin-bottom: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
                        <div style="flex: 1;">
                            <div style="font-size: 16px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin-bottom: 5px;">
                                ${request.contactName || 'Без имени'} 
                                <span style="font-size: 20px; color: #E6407A; margin-left: 10px;">+${request.points}</span>
                            </div>
                            <div style="font-size: 12px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                                ${formatRequestDate(request.createdAt)} • ${request.manager || 'Неизвестный менеджер'}
                            </div>
                        </div>
                        <div style="display: inline-block; padding: 5px 12px; background: ${statusStyle.bg}; color: ${statusStyle.text}; border-radius: 15px; font-size: 12px; font-weight: 600; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            ${request.status}
                        </div>
                    </div>
                    
                    <div style="background: white; padding: 10px; border-radius: 10px; margin-bottom: 10px;">
                        <div style="font-size: 13px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            <strong>Причина:</strong> ${request.reason}
                        </div>
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <a href="${request.leadUrl}" target="_blank" style="
                            font-size: 12px;
                            color: #E6407A;
                            text-decoration: none;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            font-weight: 600;
                        ">Перейти в сделку</a>
                        
                        ${isAdminAuthorized && request.status === 'ожидает' ? `
                            <div style="display: flex; gap: 10px;">
                                <button class="approve-request-btn" data-request-id="${request.requestId}" data-contact-id="${request.contactId}" data-points="${request.points}" style="
                                    padding: 8px 16px;
                                    background: #2E9E63;
                                    color: white;
                                    border: none;
                                    border-radius: 10px;
                                    cursor: pointer;
                                    font-size: 13px;
                                    font-weight: 600;
                                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                                    transition: all 0.2s;
                                ">Одобрить</button>
                                
                                <button class="reject-request-btn" data-request-id="${request.requestId}" style="
                                    padding: 8px 16px;
                                    background: #D64545;
                                    color: white;
                                    border: none;
                                    border-radius: 10px;
                                    cursor: pointer;
                                    font-size: 13px;
                                    font-weight: 600;
                                    font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                                    transition: all 0.2s;
                                ">Отклонить</button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }
    
    function attachBonusRequestsButtonsListeners() {
        const approveButtons = document.querySelectorAll('.approve-request-btn');
        const rejectButtons = document.querySelectorAll('.reject-request-btn');
        
        approveButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const requestId = btn.getAttribute('data-request-id');
                const contactId = btn.getAttribute('data-contact-id');
                const points = parseFloat(btn.getAttribute('data-points'));
                await approveBonusRequest(requestId, contactId, points);
            });
        });
        
        rejectButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const requestId = btn.getAttribute('data-request-id');
                await rejectBonusRequest(requestId);
            });
        });
    }

    let analyticsCache = {
        totalAdded: 0,
        totalSubtracted: 0,
        totalAddedRub: 0,
        totalSubtractedRub: 0,
        avgAdded: 0,
        avgAddedRub: 0,
        avgSubtracted: 0,
        avgSubtractedRub: 0,
        countAdded: 0,
        countSubtracted: 0,
        f5Added: 0,
        f5AddedRub: 0,
        adminOperations: 0,
        adminOperationsRub: 0,
        transactions: []
    };

    function renderAnalyticsTab(container) {
        const today = new Date();
        const todayStr = formatDateForInput(today);
        
        container.innerHTML = `
            <div style="max-width: 1000px; margin: 0 auto;">
                <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #E7E7EC;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Выберите период и фильтры</h3>
                    
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px;">
                        <button class="period-btn is-active" data-period="today" style="
                            padding: 12px;
                            background: #E6407A;
                            color: white;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            transition: all 0.2s;
                        ">Сегодня</button>
                        
                        <button class="period-btn" data-period="week" style="
                            padding: 12px;
                            background: #F7F7F9;
                            color: #6E6E7A;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            transition: all 0.2s;
                        ">Неделя</button>
                        
                        <button class="period-btn" data-period="month" style="
                            padding: 12px;
                            background: #F7F7F9;
                            color: #6E6E7A;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            transition: all 0.2s;
                        ">Месяц</button>
                        
                        <button class="period-btn" data-period="custom" style="
                            padding: 12px;
                            background: #F7F7F9;
                            color: #6E6E7A;
                            border: none;
                            border-radius: 10px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: 600;
                            font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                            transition: all 0.2s;
                        ">Произвольный</button>
                    </div>
                    
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Источник:</label>
                        <select id="source-filter" style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            <option value="all">Все источники</option>
                            <option value="F5">Автоматические (Триггеры F5)</option>
                            <option value="админ">Ручные (Администратор)</option>
                        </select>
                    </div>
                    
                    <div id="custom-period-block" style="display: none; margin-bottom: 20px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div>
                                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Начало периода:</label>
                                <input type="date" id="custom-start-date" value="${todayStr}"
                                    style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            </div>
                            <div>
                                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Конец периода:</label>
                                <input type="date" id="custom-end-date" value="${todayStr}"
                                    style="width: 100%; padding: 12px; border: 1px solid #E7E7EC; border-radius: 10px; font-size: 14px; box-sizing: border-box; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            </div>
                        </div>
                    </div>
                    
                    <button id="load-analytics-btn" style="
                        width: 100%;
                        padding: 15px;
                        background: #E6407A;
                        color: white;
                        border: none;
                        border-radius: 10px;
                        cursor: pointer;
                        font-size: 16px;
                        font-weight: 600;
                        font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    ">Загрузить аналитику</button>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-bottom: 20px;">
                    <div style="background: #EAF6F0; padding: 22px; border-radius: 14px; text-align: center;">
                        <div style="font-size: 14px; color: #237A4C; margin-bottom: 8px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.9;">Начислено</div>
                        <div id="total-added-display" style="font-size: 32px; font-weight: 700; color: #237A4C; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            0
                        </div>
                        <div style="font-size: 14px; color: #237A4C; margin-top: 4px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.8;" id="total-added-rub">0 ₽</div>
                    </div>
                    
                    <div style="background: #FBECEC; padding: 22px; border-radius: 14px; text-align: center;">
                        <div style="font-size: 14px; color: #B23B3B; margin-bottom: 8px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.9;">Списано</div>
                        <div id="total-subtracted-display" style="font-size: 32px; font-weight: 700; color: #B23B3B; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            0
                        </div>
                        <div style="font-size: 14px; color: #B23B3B; margin-top: 4px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.8;" id="total-subtracted-rub">0 ₽</div>
                    </div>
                    
                    <div style="background: #EDF3FC; padding: 22px; border-radius: 14px; text-align: center;">
                        <div style="font-size: 14px; color: #3169BC; margin-bottom: 8px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.9;">Итого баллов</div>
                        <div id="total-balance-display" style="font-size: 32px; font-weight: 700; color: #3169BC; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            0
                        </div>
                        <div style="font-size: 14px; color: #3169BC; margin-top: 4px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; opacity: 0.8;" id="total-balance-rub">0 ₽</div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px;">
                    <div style="background: #F7F7F9; padding: 20px; border-radius: 14px;">
                        <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Автоматические начисления (F5)</div>
                        <div id="f5-added-display" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                        <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="f5-added-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="count-f5">Транзакций: 0</div>
                    </div>
                    
                    <div style="background: #F7F7F9; padding: 20px; border-radius: 14px;">
                        <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Ручные операции (Админ)</div>
                        <div id="admin-operations-display" style="font-size: 28px; font-weight: 700; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                        <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="admin-operations-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="count-admin">Транзакций: 0</div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px;">
                    <div style="background: #F7F7F9; padding: 20px; border-radius: 14px;">
                        <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Среднее начисление</div>
                        <div id="avg-added-display" style="font-size: 28px; font-weight: 600; color: #2E9E63; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                        <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="avg-added-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="count-added">Транзакций: 0</div>
                    </div>
                    
                    <div style="background: #F7F7F9; padding: 20px; border-radius: 14px;">
                        <div style="font-size: 13px; color: #6E6E7A; margin-bottom: 10px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">Среднее списание</div>
                        <div id="avg-subtracted-display" style="font-size: 28px; font-weight: 600; color: #D64545; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">0</div>
                        <div style="font-size: 12px; color: #9C9CA8; margin-top: 3px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="avg-subtracted-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #9C9CA8; margin-top: 5px; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;" id="count-subtracted">Транзакций: 0</div>
                    </div>
                </div>
                
                <div style="background: white; padding: 20px; border-radius: 12px; border: 1px solid #E7E7EC;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #16161A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">История транзакций</h3>
                    
                    <div id="analytics-transactions-list" style="max-height: 500px; overflow-y: auto;">
                        <div style="text-align: center; padding: 40px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            <div style="font-size: 48px; margin-bottom: 15px;"></div>
                            <div style="font-size: 16px;">Нажмите "Загрузить аналитику" для просмотра данных</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        const periodButtons = container.querySelectorAll('.period-btn');
        periodButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                periodButtons.forEach(b => {
                    b.classList.remove('is-active');
                    b.style.background = '#F7F7F9';
                    b.style.color = '#6E6E7A';
                });
                btn.classList.add('is-active');
                btn.style.background = '#E6407A';
                btn.style.color = 'white';
                
                const customBlock = document.getElementById('custom-period-block');
                if (btn.dataset.period === 'custom') {
                    customBlock.style.display = 'block';
                } else {
                    customBlock.style.display = 'none';
                }
            });
        });
        
        const loadAnalyticsBtn = document.getElementById('load-analytics-btn');
        loadAnalyticsBtn.onclick = loadAnalytics;

        
        loadAnalytics();
    }

    async function loadAnalytics() {
        if (!webAppUrl) {
            showNotification('Настройте URL Google Apps Script', 'warning');
            return;
        }
        
        const activePeriod = document.querySelector('.period-btn.is-active');
        const period = activePeriod ? activePeriod.dataset.period : 'today';
        
        let startDate, endDate;
        const today = new Date();
        
        if (period === 'today') {
            startDate = formatDateForInput(today);
            endDate = formatDateForInput(today);
        } else if (period === 'week') {
            const weekAgo = new Date(today);
            weekAgo.setDate(today.getDate() - 7);
            startDate = formatDateForInput(weekAgo);
            endDate = formatDateForInput(today);
        } else if (period === 'month') {
            const monthAgo = new Date(today);
            monthAgo.setMonth(today.getMonth() - 1);
            startDate = formatDateForInput(monthAgo);
            endDate = formatDateForInput(today);
        } else if (period === 'custom') {
            startDate = document.getElementById('custom-start-date').value;
            endDate = document.getElementById('custom-end-date').value;
        }
        
        const sourceFilter = document.getElementById('source-filter')?.value || 'all';
        
        console.log('Загружаю аналитику за период:', startDate, '-', endDate, 'Источник:', sourceFilter);
        showNotification('Загружаю аналитику...', 'info');
        
        try {
            const response = await makeGoogleScriptRequest('GET', { 
                action: 'getAnalytics',
                startDate: startDate,
                endDate: endDate,
                source: sourceFilter
            });
            
            console.log('Ответ от сервера:', response);
            
            if (!response) {
                showNotification('Аналитика: пустой ответ сервера', 'error');
                return;
            }

            // Google Apps Script отдаёт свои сбои как {error: "..."} с кодом 200,
            // раньше такой ответ превращался в безымянную «Ошибку загрузки аналитики»
            if (response.error) {
                console.error('Бэкенд вернул ошибку:', response.error);
                showNotification(`Аналитика: ${response.error}`, 'error');
                return;
            }

            if (response.debug) {
                console.log('Debug info:', response.debug);
            }
            analyticsCache = response;
            updateAnalyticsDisplay();
            const transCount = response.transactions ? response.transactions.length : 0;
            showNotification(`Аналитика загружена: ${transCount} транзакций`, 'success');
        } catch (error) {
            console.error('Ошибка загрузки аналитики:', error);
            const reason = error && error.message ? error.message : String(error);
            showNotification(`Ошибка загрузки аналитики: ${reason}`, 'error');
        }
    }

    function updateAnalyticsDisplay() {
        // Любое поле ответа может не прийти - тогда показываем 0,
        // иначе падал весь блок аналитики целиком
        const num = value => {
            const parsed = typeof value === 'number' ? value : parseFloat(value);
            return isFinite(parsed) ? parsed : 0;
        };

        const addedDisplay = document.getElementById('total-added-display');
        const subtractedDisplay = document.getElementById('total-subtracted-display');
        const balanceDisplay = document.getElementById('total-balance-display');
        const addedRubDisplay = document.getElementById('total-added-rub');
        const subtractedRubDisplay = document.getElementById('total-subtracted-rub');
        const balanceRubDisplay = document.getElementById('total-balance-rub');
        
        if (addedDisplay) addedDisplay.textContent = num(analyticsCache.totalAdded).toFixed(2);
        if (subtractedDisplay) subtractedDisplay.textContent = num(analyticsCache.totalSubtracted).toFixed(2);
        if (balanceDisplay) {
            const balance = num(analyticsCache.totalAdded) - num(analyticsCache.totalSubtracted);
            balanceDisplay.textContent = balance.toFixed(2);
        }
        if (addedRubDisplay) addedRubDisplay.textContent = `${num(analyticsCache.totalAddedRub).toFixed(2)} ₽`;
        if (subtractedRubDisplay) subtractedRubDisplay.textContent = `${num(analyticsCache.totalSubtractedRub).toFixed(2)} ₽`;
        if (balanceRubDisplay) {
            const balanceRub = num(analyticsCache.totalAddedRub) - num(analyticsCache.totalSubtractedRub);
            balanceRubDisplay.textContent = `${balanceRub.toFixed(2)} ₽`;
        }
        
        const f5AddedDisplay = document.getElementById('f5-added-display');
        const f5AddedRubDisplay = document.getElementById('f5-added-rub');
        const adminOpsDisplay = document.getElementById('admin-operations-display');
        const adminOpsRubDisplay = document.getElementById('admin-operations-rub');
        
        if (f5AddedDisplay && analyticsCache.f5Added !== undefined) {
            f5AddedDisplay.textContent = num(analyticsCache.f5Added).toFixed(2);
        }
        if (f5AddedRubDisplay && analyticsCache.f5AddedRub !== undefined) {
            f5AddedRubDisplay.textContent = `${num(analyticsCache.f5AddedRub).toFixed(2)} ₽`;
        }
        if (adminOpsDisplay && analyticsCache.adminOperations !== undefined) {
            adminOpsDisplay.textContent = num(analyticsCache.adminOperations).toFixed(2);
        }
        if (adminOpsRubDisplay && analyticsCache.adminOperationsRub !== undefined) {
            adminOpsRubDisplay.textContent = `${num(analyticsCache.adminOperationsRub).toFixed(2)} ₽`;
        }

        const countF5Display = document.getElementById('count-f5');
        const countAdminDisplay = document.getElementById('count-admin');

        if (countF5Display && analyticsCache.countF5 !== undefined) {
            countF5Display.textContent = `Транзакций: ${analyticsCache.countF5}`;
        }
        if (countAdminDisplay && analyticsCache.countAdmin !== undefined) {
            countAdminDisplay.textContent = `Транзакций: ${analyticsCache.countAdmin}`;
        }

        const avgAddedDisplay = document.getElementById('avg-added-display');
        const avgAddedRubDisplay = document.getElementById('avg-added-rub');
        const countAddedDisplay = document.getElementById('count-added');
        const avgSubtractedDisplay = document.getElementById('avg-subtracted-display');
        const avgSubtractedRubDisplay = document.getElementById('avg-subtracted-rub');
        const countSubtractedDisplay = document.getElementById('count-subtracted');
        
        if (avgAddedDisplay && analyticsCache.avgAdded !== undefined) {
            avgAddedDisplay.textContent = num(analyticsCache.avgAdded).toFixed(2);
        }
        if (avgAddedRubDisplay && analyticsCache.avgAddedRub !== undefined) {
            avgAddedRubDisplay.textContent = `${num(analyticsCache.avgAddedRub).toFixed(2)} ₽`;
        }
        if (countAddedDisplay && analyticsCache.countAdded !== undefined) {
            countAddedDisplay.textContent = `Транзакций: ${analyticsCache.countAdded}`;
        }
        if (avgSubtractedDisplay && analyticsCache.avgSubtracted !== undefined) {
            avgSubtractedDisplay.textContent = num(analyticsCache.avgSubtracted).toFixed(2);
        }
        if (avgSubtractedRubDisplay && analyticsCache.avgSubtractedRub !== undefined) {
            avgSubtractedRubDisplay.textContent = `${num(analyticsCache.avgSubtractedRub).toFixed(2)} ₽`;
        }
        if (countSubtractedDisplay && analyticsCache.countSubtracted !== undefined) {
            countSubtractedDisplay.textContent = `Транзакций: ${analyticsCache.countSubtracted}`;
        }
        
        const transactionsList = document.getElementById('analytics-transactions-list');
        if (transactionsList) {
            transactionsList.innerHTML = renderAnalyticsTransactions();
        }
    }

    // Разбор даты транзакции из таблицы: "07.09.2026, 12:57:42" (секунды необязательны).
    // Штатный new Date() такой формат не понимает, поэтому разбираем вручную.
    // Нераспознанная дата уходит в конец списка, а не всплывает наверх.
    function parseTransactionDate(dateStr) {
        if (!dateStr) return -Infinity;

        const match = String(dateStr).match(/(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
        if (match) {
            const parsed = new Date(
                parseInt(match[3], 10),
                parseInt(match[2], 10) - 1,
                parseInt(match[1], 10),
                parseInt(match[4], 10),
                parseInt(match[5], 10),
                match[6] ? parseInt(match[6], 10) : 0
            );
            if (!isNaN(parsed.getTime())) return parsed.getTime();
        }

        // Запасной вариант на случай ISO-строки
        const fallback = new Date(dateStr);
        return isNaN(fallback.getTime()) ? -Infinity : fallback.getTime();
    }

    function renderAnalyticsTransactions() {
        if (!analyticsCache.transactions || analyticsCache.transactions.length === 0) {
            return `
                <div style="text-align: center; padding: 40px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                    <div style="font-size: 48px; margin-bottom: 15px;"></div>
                    <div style="font-size: 16px;">Транзакций за выбранный период не найдено</div>
                </div>
            `;
        }

        const domain = window.location.hostname;

        // Новые события сверху: порядок строк в таблице хронологию не гарантирует,
        // поэтому сортируем копию массива по фактической дате
        const transactions = analyticsCache.transactions
            .slice()
            .sort((a, b) => parseTransactionDate(b.date) - parseTransactionDate(a.date));

        return transactions.map(transaction => {
            const isAddition = transaction.type === 'начисление';
            const bgColor = isAddition ? '#EAF6F0' : '#ffebee';
            const textColor = isAddition ? '#237A4C' : '#B23B3B';
            const icon = isAddition ? '+': '';
            

            // Формируем ссылку на контакт
            let contactHtml = '';
            if (transaction.contactName || transaction.contactId) {
                const contactName = transaction.contactName || `Контакт ${transaction.contactId}`;
                if (transaction.contactId) {
                    const contactUrl = `https://${domain}/contacts/detail/${transaction.contactId}`;
                    contactHtml = `
                        <div style="font-size: 13px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            <a href="${contactUrl}" target="_blank" style="color: #E6407A; text-decoration: none; font-weight: 600; transition: all 0.2s;" onmouseover="this.style.color='#E6407A'; this.style.textDecoration='underline'" onmouseout="this.style.color='#E6407A'; this.style.textDecoration='none'">${contactName}</a>
                        </div>
                    `;
                } else {
                    contactHtml = `
                        <div style="font-size: 13px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                            ${contactName}
                        </div>
                    `;
                }
            }

            // Формируем ссылку на сделку
            let leadHtml = '';
            if (transaction.leadName || transaction.leadId) {
                const leadName = transaction.leadName || `Сделка ${transaction.leadId}`;
                if (transaction.leadId) {
                    const leadUrl = `https://${domain}/leads/detail/${transaction.leadId}`;
                    leadHtml = `
                        <div style="font-size: 13px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin-top: 3px;">
                            <a href="${leadUrl}" target="_blank" style="color: #E6407A; text-decoration: none; font-weight: 600; transition: all 0.2s;" onmouseover="this.style.color='#E6407A'; this.style.textDecoration='underline'" onmouseout="this.style.color='#E6407A'; this.style.textDecoration='none'">${leadName}</a>
                        </div>
                    `;
                } else {
                    leadHtml = `
                        <div style="font-size: 13px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin-top: 3px;">
                            ${leadName}
                        </div>
                    `;
                }
            }

            return `
                <div style="background: ${bgColor}; border-radius: 12px; padding: 15px; margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                        <div style="flex: 1;">
                            <div style="font-size: 16px; font-weight: 600; color: ${textColor}; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                                ${icon} ${transaction.type} • ${transaction.points} баллов (${transaction.points} ₽)
                            </div>
                            <div style="font-size: 12px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin-top: 5px;">
                                ${transaction.date}
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 12px; color: #6E6E7A; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;">
                                ${transaction.source}
                            </div>
                        </div>
                    </div>
                    ${contactHtml}
                    ${leadHtml}
                    ${transaction.manager ? `
                        <div style="font-size: 12px; color: #9C9CA8; font-family: Manrope, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; margin-top: 5px;">
                            Менеджер: ${transaction.manager}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    function formatDateForInput(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    async function createBonusRequest() {
        const pointsInput = document.getElementById('request-points-input');
        const noteInput = document.getElementById('request-note-input');
        const customReasonInput = document.getElementById('custom-reason-input');
        const resultDiv = document.getElementById('request-result');

        const points = parseFloat(pointsInput.value);
        const note = noteInput ? noteInput.value.trim() : '';
        const customReason = customReasonInput ? customReasonInput.value.trim() : '';

        // Собираем выбранные категории
        const selectedCheckboxes = document.querySelectorAll('input[name="reason-category"]:checked');
        const selectedCategories = [];

        selectedCheckboxes.forEach(checkbox => {
            const key = checkbox.value;
            if (key === 'custom') {
                if (customReason) {
                    selectedCategories.push({
                        key: key,
                        label: REASON_CATEGORIES[key].label,
                        customText: customReason
                    });
                }
            } else if (REASON_CATEGORIES[key]) {
                selectedCategories.push({
                    key: key,
                    label: REASON_CATEGORIES[key].label
                });
            }
        });

        if (!points || points <= 0) {
            showResult(resultDiv, 'Введите корректное количество баллов', 'warning');
            return;
        }

        if (selectedCategories.length === 0) {
            showResult(resultDiv, 'Выберите хотя бы одну причину начисления', 'warning');
            return;
        }

        // Проверяем, что если выбрано "Другое", то указан текст
        const customCheckbox = document.getElementById('custom-reason-checkbox');
        if (customCheckbox && customCheckbox.checked && !customReason) {
            showResult(resultDiv, 'Укажите текст для причины "Другое"', 'warning');
            return;
        }

        if (!currentContactId) {
            showResult(resultDiv, 'Контакт не определен. Откройте сделку с привязанным контактом.', 'error');
            return;
        }

        if (!webAppUrl) {
            showResult(resultDiv, 'Настройте URL Google Apps Script в разделе "Настройки"', 'warning');
            return;
        }

        // Формируем текстовое описание причины
        const reasonParts = [];

        // Добавляем выбранные категории
        const categoryLabels = selectedCategories.map(cat => {
            if (cat.customText) {
                return `${cat.label}: ${cat.customText}`;
            }
            return `${cat.label}`;
        });
        if (categoryLabels.length > 0) {
            reasonParts.push(categoryLabels.join('; '));
        }

        // Добавляем примечание если есть
        if (note) {
            reasonParts.push(`Примечание: ${note}`);
        }

        const reason = reasonParts.join(' | ');

        showResult(resultDiv, 'Создаю заявку...', 'info');

        try {
            const managerName = document.querySelector('.user-link__name')?.textContent || 'Неизвестный менеджер';
            const currentLeadUrl = window.location.href;

            const requestData = {
                action: 'addBonusRequest',
                contactId: currentContactId,
                contactName: currentContactName,
                leadUrl: currentLeadUrl,
                points: points,
                reason: reason,
                categories: selectedCategories,
                manager: managerName
            };
            
            const response = await makeGoogleScriptRequest('POST', requestData);
            
            if (response.success) {
                showResult(resultDiv, 'Заявка успешно создана! Ожидайте одобрения администратора.', 'success');
                // Очищаем все поля формы
                pointsInput.value = '';
                if (noteInput) noteInput.value = '';
                if (customReasonInput) customReasonInput.value = '';
                // Снимаем все чекбоксы
                document.querySelectorAll('input[name="reason-category"]:checked').forEach(cb => {
                    cb.checked = false;
                });

                await syncBonusRequests(false);
            } else {
                showResult(resultDiv, `Ошибка: ${response.error || 'Не удалось создать заявку'}`, 'error');
            }
        } catch (error) {
            console.error('Ошибка создания заявки:', error);
            showResult(resultDiv, `Ошибка: ${error.message}`, 'error');
        }
    }
    
    async function syncBonusRequests(silent = false) {
        if (!webAppUrl) {
            if (!silent) showNotification('Настройте URL Google Apps Script', 'warning');
            return;
        }
        
        if (!silent) showNotification('Загружаю заявки из Google Таблицы...', 'info');
        
        try {
            const response = await makeGoogleScriptRequest('GET', { action: 'getBonusRequests' });
            
            if (response.bonusRequests) {
                bonusRequestsCache = response.bonusRequests;
                localStorage.setItem('bonus_requests_cache', JSON.stringify(bonusRequestsCache));
                
                const requestsList = document.getElementById('bonus-requests-list');
                if (requestsList) {
                    requestsList.innerHTML = renderBonusRequestsList();
                    attachBonusRequestsButtonsListeners();
                }
                
                if (!silent) showNotification(`Загружено ${bonusRequestsCache.length} заявок`, 'success');
            }
        } catch (error) {
            console.error('Ошибка синхронизации заявок:', error);
            if (!silent) showNotification('Ошибка загрузки заявок', 'error');
        }
    }

    async function loadCategoryAnalytics() {
        if (!webAppUrl) {
            showNotification('Настройте URL Google Apps Script', 'warning');
            return;
        }

        showNotification('Загружаю аналитику по категориям...', 'info');

        try {
            const response = await makeGoogleScriptRequest('GET', { action: 'getCategoryAnalytics' });

            if (response.categories) {
                const categories = response.categories;

                // Обновляем значения в блоках
                const categoryKeys = ['delivery', 'quality', 'card', 'other_problems', 'custom'];

                categoryKeys.forEach(key => {
                    const countEl = document.getElementById(`category-${key}-count`);
                    const pointsEl = document.getElementById(`category-${key}-points`);

                    if (countEl && categories[key]) {
                        countEl.textContent = categories[key].count || 0;
                    }
                    if (pointsEl && categories[key]) {
                        pointsEl.textContent = `${(categories[key].points || 0).toFixed(2)} баллов`;
                    }
                });

                // Обновляем итого
                const totalRequestsEl = document.getElementById('category-total-requests');
                const totalPointsEl = document.getElementById('category-total-points');

                if (totalRequestsEl) {
                    totalRequestsEl.textContent = response.totalRequests || 0;
                }
                if (totalPointsEl) {
                    totalPointsEl.textContent = `${(response.totalPoints || 0).toFixed(2)} баллов`;
                }

                showNotification('Аналитика загружена', 'success');
            } else {
                showNotification('Не удалось загрузить аналитику', 'error');
            }
        } catch (error) {
            console.error('Ошибка загрузки аналитики по категориям:', error);
            showNotification('Ошибка загрузки аналитики', 'error');
        }
    }

    async function approveBonusRequest(requestId, contactId, points) {
        if (!confirm(`Одобрить начисление ${points} баллов?`)) {
            return;
        }
        
        showNotification('Начисляю баллы...', 'info');
        
        try {
            const domain = window.location.hostname;
            const apiUrl = `https://${domain}/api/v4/contacts/${contactId}`;
            
            const getResponse = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!getResponse.ok) {
                throw new Error('Не удалось получить данные контакта');
            }
            
            const contactData = await getResponse.json();
            let currentPoints = 0;
            
            if (contactData.custom_fields_values) {
                const bonusField = contactData.custom_fields_values.find(field => field.field_id === BONUS_FIELD_ID);
                if (bonusField && bonusField.values && bonusField.values.length > 0) {
                    currentPoints = parseFloat(bonusField.values[0].value) || 0;
                }
            }
            
            const newBalance = currentPoints + points;
            
            const payload = {
                custom_fields_values: [
                    {
                        field_id: BONUS_FIELD_ID,
                        values: [{ value: newBalance.toFixed(2) }]
                    }
                ]
            };
            
            const updateResponse = await fetch(apiUrl, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            
            if (!updateResponse.ok) {
                throw new Error('Не удалось начислить баллы');
            }
            
            await makeGoogleScriptRequest('POST', {
                action: 'updateBonusRequestStatus',
                requestId: requestId,
                status: 'одобрено'
            });
            
            const request = bonusRequestsCache.find(r => r.requestId === requestId);
            if (request) {
                await logBonusTransaction(
                    'начисление',
                    points,
                    contactId,
                    request.contactName || '',
                    request.leadUrl ? request.leadUrl.match(/\/leads\/detail\/(\d+)/)?.[1] : '',
                    '',
                    'админ'
                );
            }
            
            showNotification('Баллы успешно начислены!', 'success');
            await syncBonusRequests(false);
        } catch (error) {
            console.error('Ошибка одобрения заявки:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }
    
    async function rejectBonusRequest(requestId) {
        if (!confirm('Отклонить эту заявку?')) {
            return;
        }
        
        showNotification('Обновляю статус заявки...', 'info');
        
        try {
            const response = await makeGoogleScriptRequest('POST', {
                action: 'updateBonusRequestStatus',
                requestId: requestId,
                status: 'отклонено'
            });
            
            if (response.success) {
                showNotification('Заявка отклонена', 'success');
                await syncBonusRequests(false);
            } else {
                showNotification('Ошибка обновления статуса', 'error');
            }
        } catch (error) {
            console.error('Ошибка отклонения заявки:', error);
            showNotification(`Ошибка: ${error.message}`, 'error');
        }
    }

    async function logBonusTransaction(type, points, contactId, contactName, leadId, leadName, source) {
        if (!webAppUrl) return;
        
        try {
            const managerName = document.querySelector('.user-link__name')?.textContent || 'Неизвестный менеджер';
            
            const transactionData = {
                action: 'logBonusTransaction',
                type: type,
                points: points,
                contactId: contactId || '',
                contactName: contactName || '',
                leadId: leadId || '',
                leadName: leadName || '',
                source: source || 'админ',
                manager: managerName
            };
            
            await makeGoogleScriptRequest('POST', transactionData);
        } catch (error) {
            console.error('Ошибка логирования транзакции:', error);
        }
    }

    // ===================== Подписки и сертификаты =====================
    // Бэкенд - сервис лояльности на Go (папка loyalty-service, сервер int109), а не GAS.
    // Права задаёт токен из «Настроек»: менеджер проверяет и списывает, администратор ещё
    // выпускает, возвращает, пополняет и блокирует. Сервер проверяет права сам, поэтому
    // скрытие кнопок по роли здесь - только удобство. Токен лежит в хранилище Tampermonkey,
    // а не в localStorage страницы amoCRM.

    const LOYALTY_DEFAULT_URL = 'https://myskladandamocrm.ru/loyalty';
    const LOYALTY_URL_KEY = 'loyalty_api_url';
    const LOYALTY_TOKEN_KEY = 'loyalty_api_token';
    const VOUCHER_KINDS = [
        { key: 'certificate', label: 'Сертификаты', title: 'Сертификат', issueTitle: 'Новый сертификат', nominal: 'Номинал' },
        { key: 'flower_subscription', label: 'Цветочные подписки', title: 'Цветочная подписка', issueTitle: 'Новая цветочная подписка', nominal: 'Внесено' },
        { key: 'wedding_subscription', label: 'Свадебные подписки', title: 'Свадебная подписка', issueTitle: 'Новая свадебная подписка', nominal: 'Внесено' }
    ];
    const VOUCHER_OPS = { issue: 'Выпуск', topup: 'Пополнение', redeem: 'Списание', refund: 'Возврат', block: 'Блокировка', unblock: 'Разблокировка', link: 'Точка СБП' };
    const VOUCHER_SOURCES = { amo: 'amoCRM', site: 'сайт', paykeeper: 'PayKeeper', api: 'API', sbp: 'оплата по QR' };
    const LOYALTY_ROLES = { admin: 'администратор', manager: 'менеджер', server: 'сервер сайта' };
    const VX_PERIODS = [
        { key: 'week', label: 'Неделя', days: 7 },
        { key: 'month', label: 'Месяц', days: 30 },
        { key: 'year', label: 'Год', days: 365 },
        { key: 'all', label: 'Всё время', days: 0 }
    ];

    let loyaltyMe = null;        // ответ /api/v1/me: роль и права текущего токена
    let vxSubtab = 'certificate';
    let vxPeriod = 'month';
    let vxLeadCtxCache = null;   // телефон, имя, бюджет и промокод открытой сделки
    let vxList = { items: [], total: 0 };
    let vxListSeq = 0;

    // ---------- связь с сервисом ----------

    async function getLoyaltySettings() {
        const url = (await GM.getValue(LOYALTY_URL_KEY, '')) || LOYALTY_DEFAULT_URL;
        const token = await GM.getValue(LOYALTY_TOKEN_KEY, '');
        return { url: String(url).replace(/\/+$/, ''), token: String(token || '').trim() };
    }

    // Скачивание файла из сервиса (PDF сертификата) с токеном: ответ - blob, сохраняем через ссылку.
    async function loyaltyDownload(path, filename) {
        const { url, token } = await getLoyaltySettings();
        if (!token) {
            throw new Error('Не задан токен доступа - укажите его во вкладке «Настройки»');
        }
        const blob = await new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: url + path,
                headers: { 'Authorization': 'Bearer ' + token },
                responseType: 'blob',
                timeout: 60000,
                onload: async (res) => {
                    if (res.status === 200 && res.response) {
                        resolve(res.response);
                        return;
                    }
                    let message = `Сервис ответил ошибкой ${res.status}`;
                    try {
                        const text = res.response && res.response.text ? await res.response.text() : (res.responseText || '');
                        const data = JSON.parse(text);
                        if (data && data.error && data.error.message) message = data.error.message;
                    } catch (e) { /* не JSON - оставляем общий текст */ }
                    reject(new Error(message));
                },
                onerror: () => reject(new Error('Нет связи с сервисом сертификатов')),
                ontimeout: () => reject(new Error('Сервис не ответил за минуту'))
            });
        });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 10000);
    }

    async function loyaltyRequest(method, path, body) {
        const { url, token } = await getLoyaltySettings();
        if (!token) {
            throw new Error('Не задан токен доступа - укажите его во вкладке «Настройки»');
        }
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method,
                url: url + path,
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                data: body ? JSON.stringify(body) : undefined,
                timeout: 20000,
                onload: (res) => {
                    let data = null;
                    try {
                        data = JSON.parse(res.responseText || 'null');
                    } catch (e) { /* не JSON - ниже будет общая ошибка */ }
                    if (res.status >= 200 && res.status < 300 && data) {
                        resolve(data);
                        return;
                    }
                    const apiErr = data && data.error;
                    const err = new Error((apiErr && apiErr.message) || `Сервис сертификатов ответил ошибкой ${res.status}`);
                    err.status = res.status;
                    err.code = apiErr && apiErr.code;
                    err.details = apiErr || null;
                    reject(err);
                },
                onerror: () => reject(new Error('Нет связи с сервисом сертификатов')),
                ontimeout: () => reject(new Error('Сервис сертификатов не ответил за 20 секунд'))
            });
        });
    }

    async function loadLoyaltyMe(force) {
        if (loyaltyMe && !force) return loyaltyMe;
        loyaltyMe = await loyaltyRequest('GET', '/api/v1/me');
        return loyaltyMe;
    }

    function canLoyalty(perm) {
        return !!(loyaltyMe && Array.isArray(loyaltyMe.perms) && loyaltyMe.perms.includes(perm));
    }

    // ---------- мелочи ----------

    function escHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function rubToKop(value) {
        const n = parseFloat(String(value == null ? '' : value).replace(/[\s ]/g, '').replace(',', '.'));
        return isFinite(n) ? Math.round(n * 100) : NaN;
    }

    function formatKop(kop) {
        const rub = (kop || 0) / 100;
        const hasKop = Math.round(Math.abs(kop || 0)) % 100 !== 0;
        return rub.toLocaleString('ru-RU', { minimumFractionDigits: hasKop ? 2 : 0, maximumFractionDigits: 2 }) + ' ₽';
    }

    function vxPhone(phone) {
        const d = String(phone || '').replace(/\D/g, '');
        if (d.length === 11 && d[0] === '7') return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
        return phone || '';
    }

    function vxPlural(n, one, few, many) {
        const a = Math.abs(n) % 100, b = a % 10;
        if (a > 10 && a < 20) return `${n} ${many}`;
        if (b === 1) return `${n} ${one}`;
        if (b >= 2 && b <= 4) return `${n} ${few}`;
        return `${n} ${many}`;
    }

    function vxDate(iso, withTime) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return escHtml(iso);
        return withTime ? formatDateTime(d) : d.toLocaleDateString('ru-RU');
    }

    function vxKindDef(key) {
        return VOUCHER_KINDS.find(k => k.key === key) || VOUCHER_KINDS[0];
    }

    function vxUuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }

    function getCurrentLeadId() {
        const m = window.location.href.match(/\/leads\/detail\/(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
    }

    function getCurrentManagerName() {
        return (document.querySelector('.user-link__name')?.textContent || '').trim() || 'Менеджер';
    }

    function vxLeadLink(id) {
        if (!id) return '';
        return `<a href="https://${window.location.hostname}/leads/detail/${id}" target="_blank" rel="noopener">№${id}</a>`;
    }

    function vxNote(type, html) {
        return `<div class="pcx-vx-note pcx-vx-note--${type}">${html}</div>`;
    }

    function vxStat(label, value, sub, tone) {
        return `
            <div class="pcx-vx-stat">
                <div class="pcx-vx-stat__label">${label}</div>
                <div class="pcx-vx-stat__value${tone ? ' pcx-vx-stat__value--' + tone : ''}">${value}</div>
                ${sub ? `<div class="pcx-vx-stat__sub">${sub}</div>` : ''}
            </div>`;
    }

    // Подписи без рода: «сертификат» мужского рода, «подписка» - женского.
    function vxBadge(v) {
        let label = { active: 'Действует', exhausted: 'Остаток 0', blocked: 'Блокировка' }[v.state] || v.state;
        if (v.state === 'exhausted' && !v.spent_kop) label = 'Без баланса';
        return `<span class="pcx-vx-badge pcx-vx-badge--${escHtml(v.state)}">${label}</span>`;
    }

    async function vxCopy(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position: fixed; opacity: 0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showNotification('Скопировано', 'success');
    }

    // Текст для клиента после выпуска - менеджер вставляет его в переписку.
    function vxClientText(v) {
        const lines = [];
        if (v.kind === 'certificate') {
            lines.push(`Подарочный сертификат на ${formatKop(v.nominal_kop)}`);
            lines.push(`Номер: ${v.code}`);
            lines.push('Сертификат бессрочный, его можно тратить частями - остаток не сгорает.');
        } else {
            lines.push(v.kind_title);
            lines.push(`Номер: ${v.code}`);
            if (v.balance_kop) lines.push(`Баланс: ${formatKop(v.balance_kop)}`);
        }
        lines.push('При заказе назовите этот номер менеджеру.');
        return lines.join('\n');
    }

    // Данные открытой сделки: бюджет, промокод, контакт. Телефон и имя сначала из карточки,
    // если их там нет - через API amoCRM.
    async function getVxLeadContext(force) {
        const leadId = getCurrentLeadId();
        if (!leadId) return { leadId: 0, budget: 0, phone: '', contactName: '', contactId: 0, promoCode: '' };
        if (!force && vxLeadCtxCache && vxLeadCtxCache.leadId === leadId) return vxLeadCtxCache;

        const fn = document.querySelector('input[name="contact[FN]"]')?.value || '';
        const ln = document.querySelector('input[name="contact[LN]"]')?.value || '';
        const ctx = {
            leadId,
            budget: getLeadBudget(),
            phone: getContactPhoneFromPage() || '',
            contactName: `${fn} ${ln}`.trim(),
            contactId: 0,
            promoCode: ''
        };
        try {
            const base = `${window.location.origin}/api/v4`;
            const res = await fetch(`${base}/leads/${leadId}?with=contacts`, { headers: { 'Content-Type': 'application/json' } });
            if (res.ok) {
                const lead = await res.json();
                if (!ctx.budget && lead.price) ctx.budget = lead.price;
                const promo = (lead.custom_fields_values || []).find(f => f.field_id === PROMO_FIELD_ID);
                if (promo && promo.values && promo.values[0]) ctx.promoCode = String(promo.values[0].value || '').trim();
                const contacts = (lead._embedded && lead._embedded.contacts) || [];
                const main = contacts.find(c => c.is_main) || contacts[0];
                if (main) {
                    ctx.contactId = main.id;
                    if (!ctx.phone || !ctx.contactName) {
                        const cr = await fetch(`${base}/contacts/${main.id}`, { headers: { 'Content-Type': 'application/json' } });
                        if (cr.ok) {
                            const contact = await cr.json();
                            if (!ctx.contactName) ctx.contactName = contact.name || '';
                            const phoneField = (contact.custom_fields_values || []).find(f => f.field_code === 'PHONE');
                            if (!ctx.phone && phoneField && phoneField.values && phoneField.values[0]) {
                                ctx.phone = String(phoneField.values[0].value || '');
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('[Сертификаты] Не удалось получить данные сделки:', error);
        }
        vxLeadCtxCache = ctx;
        return ctx;
    }

    // ---------- вкладка ----------

    async function renderVouchersTab(container) {
        container.innerHTML = `<div class="pcx-vx">${vxNote('info', 'Подключаюсь к сервису сертификатов...')}</div>`;
        try {
            await loadLoyaltyMe(true);
        } catch (error) {
            container.innerHTML = `
                <div class="pcx-vx"><section class="pcx-vx-block">
                    <h3 class="pcx-vx-block__title">Подписки и сертификаты</h3>
                    ${vxNote(error.status ? 'err' : 'warn', escHtml(error.message))}
                    <div class="pcx-vx-muted">Токен доступа выдаёт администратор. Вставьте его во вкладке «Настройки», в блоке «Подписки и сертификаты».</div>
                    <button class="pcx-btn pcx-btn--primary" data-vx="to-settings">Открыть настройки</button>
                </section></div>`;
            container.querySelector('[data-vx="to-settings"]').onclick = () => switchTab('settings');
            return;
        }

        container.innerHTML = `
            <div class="pcx-vx">
                <section class="pcx-vx-block">
                    <h3 class="pcx-vx-block__title">Проверка по номеру</h3>
                    <div class="pcx-vx-row">
                        <input type="text" id="vx-code-input" class="pcx-vx-code-input" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
                        <button id="vx-find-btn" class="pcx-btn pcx-btn--primary">Найти</button>
                    </div>
                    <div id="vx-find-result"></div>
                </section>

                <section class="pcx-vx-block">
                    <h3 class="pcx-vx-block__title">В этой сделке</h3>
                    <div id="vx-lead-content"><div class="pcx-vx-muted">Загружаю...</div></div>
                </section>

                <div class="pcx-vx-pills pcx-vx-kinds" id="vx-kinds">
                    ${VOUCHER_KINDS.map(k => `<button class="pcx-vx-pill${k.key === vxSubtab ? ' is-active' : ''}" data-kind="${k.key}">${k.label}</button>`).join('')}
                </div>
                <div id="vx-kind-panel"></div>
            </div>`;

        const codeInput = document.getElementById('vx-code-input');
        document.getElementById('vx-find-btn').onclick = () => vxFind(codeInput.value);
        codeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') vxFind(codeInput.value);
        });
        document.querySelectorAll('#vx-kinds [data-kind]').forEach(btn => {
            btn.onclick = () => {
                vxSubtab = btn.dataset.kind;
                document.querySelectorAll('#vx-kinds [data-kind]').forEach(b => b.classList.toggle('is-active', b === btn));
                renderVxKindPanel();
            };
        });

        renderVxLeadBlock();
        renderVxKindPanel();
    }

    async function vxFind(raw) {
        const out = document.getElementById('vx-find-result');
        if (!out) return;
        const code = String(raw || '').trim();
        if (!code) {
            document.getElementById('vx-code-input')?.focus();
            return;
        }
        out.innerHTML = '<div class="pcx-vx-muted">Ищу...</div>';
        try {
            const data = await loyaltyRequest('GET', '/api/v1/vouchers/' + encodeURIComponent(code));
            out.dataset.code = data.voucher.code;
            renderVoucherCard(out, data, vxRefreshAll);
        } catch (error) {
            delete out.dataset.code;
            out.innerHTML = vxNote(error.code === 'not_found' || error.code === 'bad_code' ? 'warn' : 'err', escHtml(error.message));
        }
    }

    // После любой операции обновляем всё, что могло измениться.
    function vxRefreshAll() {
        renderVxLeadBlock();
        const panel = document.getElementById('vx-kind-panel');
        if (panel && panel.firstElementChild) {
            loadVxStats(panel);
            loadVxList(panel, false);
        }
        const found = document.getElementById('vx-find-result');
        if (found && found.dataset.code) vxFind(found.dataset.code);
    }

    function vxBindOpen(root) {
        root.querySelectorAll('[data-vx-open]').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('a[target="_blank"]')) return; // ссылка на сделку открывается сама
                e.preventDefault();
                openVoucherModal(el.dataset.vxOpen);
            });
        });
    }

    async function renderVxLeadBlock() {
        const box = document.getElementById('vx-lead-content');
        if (!box) return;
        const leadId = getCurrentLeadId();
        if (!leadId) {
            box.innerHTML = '<div class="pcx-vx-muted">Откройте сделку, чтобы видеть её списания и сертификаты клиента</div>';
            return;
        }
        const ctx = await getVxLeadContext();
        const [opsRes, clientRes] = await Promise.all([
            loyaltyRequest('GET', `/api/v1/operations?lead_id=${leadId}&limit=100`).catch(error => ({ error })),
            ctx.phone
                ? loyaltyRequest('GET', '/api/v1/vouchers?limit=20&phone=' + encodeURIComponent(ctx.phone)).catch(error => ({ error }))
                : Promise.resolve({ items: [] })
        ]);
        if (opsRes.error) {
            box.innerHTML = vxNote('err', escHtml(opsRes.error.message));
            return;
        }

        const parts = [];
        if (ctx.promoCode) {
            parts.push(vxNote('warn', `В сделке указан промокод «${escHtml(ctx.promoCode)}». Сертификаты и подписки с промокодом не совмещаются.`));
        }
        const ops = opsRes.items || [];
        const spent = ops.reduce((sum, o) => sum + (o.type === 'redeem' || o.type === 'refund' ? -o.amount_kop : 0), 0);
        ctx.leadPaidKop = spent; // карточка учитывает это в подсказке «к оплате по сделке»
        if (ops.length) {
            parts.push(`<div class="pcx-vx-subtitle">Операции по сделке${spent ? ' - списано ' + formatKop(spent) : ''}</div>${vxOpsTable(ops, true)}`);
        }
        const clientItems = (clientRes && clientRes.items) || [];
        if (clientItems.length) {
            parts.push(`<div class="pcx-vx-subtitle">У клиента ${escHtml(vxPhone(ctx.phone))}</div>
                <div class="pcx-vx-minilist">${clientItems.map(v => `
                    <button class="pcx-vx-mini" data-vx-open="${escHtml(v.code)}">
                        <span><span class="pcx-vx-code">${escHtml(v.code)}</span> <span class="pcx-vx-muted">${escHtml(v.kind_title)}</span></span>
                        <span>${vxBadge(v)}<b>${formatKop(v.balance_kop)}</b></span>
                    </button>`).join('')}
                </div>`);
        } else if (clientRes && clientRes.error) {
            parts.push(vxNote('err', escHtml(clientRes.error.message)));
        }
        if (!ops.length && !clientItems.length) {
            parts.push(`<div class="pcx-vx-muted">По этой сделке операций не было${ctx.phone ? ', у клиента нет сертификатов и подписок' : ''}.</div>`);
        }
        box.innerHTML = parts.join('');
        vxBindOpen(box);
    }

    function vxOpsTable(ops, showCode) {
        return `
            <div class="pcx-vx-tablewrap"><table class="pcx-vx-table">
                <thead><tr>
                    <th>Дата</th>${showCode ? '<th>Номер</th>' : ''}<th>Операция</th>
                    <th class="pcx-vx-num">Сумма</th><th class="pcx-vx-num">Остаток</th><th>Сделка</th><th>Кто</th>
                </tr></thead>
                <tbody>${ops.map(o => `
                    <tr>
                        <td class="pcx-vx-nowrap">${vxDate(o.created_at, true)}</td>
                        ${showCode ? `<td><a href="#" class="pcx-vx-code" data-vx-open="${escHtml(o.code)}">${escHtml(o.code)}</a></td>` : ''}
                        <td>${VOUCHER_OPS[o.type] || escHtml(o.type)}${o.comment ? `<div class="pcx-vx-muted">${escHtml(o.comment)}</div>` : ''}</td>
                        <td class="pcx-vx-num${o.amount_kop > 0 ? ' pcx-vx-plus' : ''}">${o.amount_kop ? (o.amount_kop > 0 ? '+' : '-') + formatKop(Math.abs(o.amount_kop)) : ''}</td>
                        <td class="pcx-vx-num">${formatKop(o.balance_after_kop)}</td>
                        <td>${o.lead_id ? vxLeadLink(o.lead_id) : escHtml(o.order_ref || '')}</td>
                        <td>${escHtml(o.actor || '')}<div class="pcx-vx-muted">${VOUCHER_SOURCES[o.source] || escHtml(o.source || '')}</div></td>
                    </tr>`).join('')}
                </tbody>
            </table></div>`;
    }

    // ---------- карточка носителя ----------

    function renderVoucherCard(container, data, onChange) {
        const v = data.voucher;
        const opsDesc = (data.operations || []).slice().reverse();
        const meta = v.meta || {};
        const leadId = getCurrentLeadId();
        const ctx = (vxLeadCtxCache && vxLeadCtxCache.leadId === leadId) ? vxLeadCtxCache : { budget: getLeadBudget(), promoCode: '' };
        const budgetKop = Math.round((ctx.budget || 0) * 100);
        const canRedeemHere = canLoyalty('redeem') && v.state === 'active' && leadId > 0;
        // Сколько в этой сделке уже оплачено сертификатами и подписками: этим носителем
        // (свежие данные карточки) или всеми сразу (сводка блока «В этой сделке»).
        let paidHereKop = 0;
        opsDesc.forEach(o => {
            if (o.lead_id === leadId && (o.type === 'redeem' || o.type === 'refund')) paidHereKop -= o.amount_kop;
        });
        paidHereKop = Math.max(paidHereKop, ctx.leadPaidKop || 0);
        const dueKop = Math.max(0, budgetKop - paidHereKop);
        const defaultKop = dueKop > 0 ? Math.min(dueKop, v.balance_kop) : 0;

        const rows = [];
        const addRow = (label, value) => {
            if (value) rows.push(`<dt>${label}</dt><dd>${value}</dd>`);
        };
        addRow('Покупатель', [escHtml(v.buyer_name), escHtml(vxPhone(v.buyer_phone))].filter(Boolean).join(', '));
        addRow(v.kind === 'wedding_subscription' ? 'Пара' : 'Получатель', escHtml(v.recipient_name));
        addRow('Пожелание', escHtml(v.message));
        addRow('График доставок', escHtml(meta.schedule || ''));
        addRow('Дата свадьбы', meta.wedding_date ? vxDate(meta.wedding_date) : '');
        addRow('Точка СБП', v.sbp_merchant_id ? escHtml(v.sbp_merchant_id) + ' - оплаты по её QR зачисляются сами' : '');
        addRow('Выпущен', [vxDate(v.created_at, true), escHtml(v.created_by), v.lead_id ? 'сделка ' + vxLeadLink(v.lead_id) : ''].filter(Boolean).join(', '));
        addRow('Последнее списание', v.last_used_at ? vxDate(v.last_used_at, true) : '');
        addRow('Комментарий', escHtml(v.comment));

        const adminBtns = [];
        if (canLoyalty('refund') && v.spent_kop > 0) {
            adminBtns.push('<button class="pcx-btn pcx-btn--ghost" data-vx-admin="refund">Вернуть на баланс</button>');
        }
        if (canLoyalty('topup') && v.kind !== 'certificate' && v.status !== 'blocked') {
            adminBtns.push('<button class="pcx-btn pcx-btn--ghost" data-vx-admin="topup">Пополнить</button>');
        }
        if (canLoyalty('issue') && v.kind !== 'certificate') {
            adminBtns.push(`<button class="pcx-btn pcx-btn--ghost" data-vx-admin="link">${v.sbp_merchant_id ? 'Сменить точку СБП' : 'Привязать точку СБП'}</button>`);
        }
        if (canLoyalty('block')) {
            adminBtns.push(v.status === 'blocked'
                ? '<button class="pcx-btn pcx-btn--ghost" data-vx-admin="unblock">Разблокировать</button>'
                : '<button class="pcx-btn pcx-btn--danger" data-vx-admin="block">Заблокировать</button>');
        }

        container.innerHTML = `
            <div class="pcx-vx-card">
                <div class="pcx-vx-card__head">
                    <div>
                        <div class="pcx-vx-muted">${escHtml(v.kind_title)}</div>
                        <div class="pcx-vx-card__code">${escHtml(v.code)}</div>
                    </div>
                    ${vxBadge(v)}
                </div>
                <div class="pcx-vx-stats">
                    ${vxStat('Остаток', formatKop(v.balance_kop), '', v.state === 'active' ? 'ok' : '')}
                    ${vxStat(v.kind === 'certificate' ? 'Номинал' : 'Начальный взнос', formatKop(v.nominal_kop), v.topup_kop ? 'пополнено на ' + formatKop(v.topup_kop) : '')}
                    ${vxStat('Потрачено', formatKop(v.spent_kop), v.uses ? vxPlural(v.uses, 'списание', 'списания', 'списаний') : '')}
                </div>
                <dl class="pcx-vx-kv">${rows.join('')}</dl>
                ${canRedeemHere ? `
                    <div class="pcx-vx-action">
                        <div class="pcx-vx-action__title">Списать в этой сделке №${leadId}</div>
                        ${ctx.promoCode ? vxNote('warn', `В сделке указан промокод «${escHtml(ctx.promoCode)}» - с ним списывать нельзя.`) : ''}
                        <div class="pcx-vx-row">
                            <input type="text" inputmode="decimal" class="pcx-vx-amount" data-vx="amount" placeholder="Сумма, ₽" value="${defaultKop ? defaultKop / 100 : ''}">
                            <input type="text" data-vx="comment" placeholder="Комментарий (необязательно)">
                            <button class="pcx-btn pcx-btn--primary" data-vx="redeem">Списать</button>
                        </div>
                        <div class="pcx-vx-muted" data-vx="hint"></div>
                        <div class="pcx-vx-muted">Сертификаты и подписки не совмещаются с бонусными баллами и промокодами.</div>
                    </div>` : ''}
                ${!leadId && v.state === 'active' && canLoyalty('redeem') ? vxNote('info', 'Списывать можно только из карточки сделки') : ''}
                ${v.kind === 'certificate' && canLoyalty('read') ? `<div class="pcx-vx-row"><button class="pcx-btn pcx-btn--ghost" data-vx="pdf">Скачать PDF</button><span class="pcx-vx-muted">евро 210×99 мм, QR ведёт на проверку остатка</span></div>` : ''}
                ${adminBtns.length ? `<div class="pcx-vx-row">${adminBtns.join('')}</div>` : ''}
                <div data-vx="admin-form"></div>
                <div>
                    <div class="pcx-vx-subtitle">История операций</div>
                    ${opsDesc.length ? vxOpsTable(opsDesc, false) : '<div class="pcx-vx-muted">Операций нет</div>'}
                </div>
            </div>`;

        const pdfBtn = container.querySelector('[data-vx="pdf"]');
        if (pdfBtn) {
            pdfBtn.onclick = async () => {
                pdfBtn.disabled = true;
                const label = pdfBtn.textContent;
                pdfBtn.textContent = 'Готовим PDF...';
                try {
                    await loyaltyDownload('/api/v1/vouchers/' + encodeURIComponent(v.code) + '/pdf', 'Сертификат ' + v.code + '.pdf');
                } catch (e) {
                    showNotification('PDF не получился: ' + e.message, 'error');
                } finally {
                    pdfBtn.disabled = false;
                    pdfBtn.textContent = label;
                }
            };
        }

        if (canRedeemHere) {
            const amountInput = container.querySelector('[data-vx="amount"]');
            const commentInput = container.querySelector('[data-vx="comment"]');
            const hint = container.querySelector('[data-vx="hint"]');
            const redeemBtn = container.querySelector('[data-vx="redeem"]');
            // Один ключ на одну попытку: двойной клик и повтор после обрыва связи не спишут дважды.
            let redeemKey = 'amo:redeem:' + vxUuid();

            const paidNote = paidHereKop > 0 ? `В этой сделке уже оплачено сертификатами и подписками: ${formatKop(paidHereKop)}. ` : '';
            const updateHint = () => {
                const kop = rubToKop(amountInput.value);
                if (!kop || kop <= 0) {
                    hint.textContent = paidNote + `Доступно ${formatKop(v.balance_kop)}` +
                        (budgetKop ? `, к оплате по сделке ${formatKop(dueKop)}` : '');
                    return;
                }
                if (kop > v.balance_kop) {
                    hint.innerHTML = `<span class="pcx-vx-danger">Больше остатка - списать можно не больше ${formatKop(v.balance_kop)}</span>`;
                    return;
                }
                let text = paidNote + `Останется ${formatKop(v.balance_kop - kop)}`;
                if (budgetKop && dueKop > kop) text += `. Доплата клиента: ${formatKop(dueKop - kop)}`;
                if (budgetKop && kop > dueKop) text += `. Это больше, чем осталось оплатить по сделке (${formatKop(dueKop)})`;
                hint.textContent = text;
            };
            amountInput.addEventListener('input', updateHint);
            updateHint();

            redeemBtn.onclick = async () => {
                const kop = rubToKop(amountInput.value);
                if (!kop || kop <= 0) {
                    showNotification('Укажите сумму списания', 'warning');
                    amountInput.focus();
                    return;
                }
                if (kop > v.balance_kop) {
                    showNotification(`Списать можно не больше ${formatKop(v.balance_kop)}`, 'warning');
                    return;
                }
                const question = `Списать ${formatKop(kop)} (${v.kind_title.toLowerCase()} ${v.code}) в сделке №${leadId}?\n` +
                    `Останется ${formatKop(v.balance_kop - kop)}.` +
                    (ctx.promoCode ? `\n\nВнимание: в сделке указан промокод «${ctx.promoCode}».` : '');
                if (!confirm(question)) return;
                redeemBtn.disabled = true;
                try {
                    await loyaltyRequest('POST', `/api/v1/vouchers/${encodeURIComponent(v.code)}/redeem`, {
                        amount_kop: kop,
                        lead_id: leadId,
                        comment: commentInput.value.trim(),
                        actor: getCurrentManagerName(),
                        idempotency_key: redeemKey
                    });
                    showNotification(`Списано ${formatKop(kop)}. Остаток ${formatKop(v.balance_kop - kop)}`, 'success');
                    if (onChange) onChange();
                } catch (error) {
                    // Отказ сервиса (4xx) - операции не было, следующая попытка с новым ключом.
                    // Обрыв связи или 5xx - ключ сохраняем: если списание прошло, повтор его не задвоит.
                    if (error.status && error.status < 500) redeemKey = 'amo:redeem:' + vxUuid();
                    showNotification(error.message, 'error');
                    redeemBtn.disabled = false;
                }
            };
        }

        container.querySelectorAll('[data-vx-admin]').forEach(btn => {
            btn.onclick = () => showVxAdminForm(container, v, opsDesc, btn.dataset.vxAdmin, onChange);
        });
    }

    function showVxAdminForm(container, v, opsDesc, action, onChange) {
        const box = container.querySelector('[data-vx="admin-form"]');
        const leadId = getCurrentLeadId();
        // Сколько списано в открытой сделке и ещё не возвращено - по умолчанию возвращаем это.
        let leadNet = 0;
        opsDesc.forEach(o => {
            if (leadId && o.lead_id === leadId && (o.type === 'redeem' || o.type === 'refund')) leadNet -= o.amount_kop;
        });

        const cfg = {
            refund: {
                title: 'Возврат на баланс', submit: 'Вернуть', path: 'refund', amount: true, lead: true,
                defaultKop: leadNet > 0 ? leadNet : v.spent_kop,
                note: 'Вернуть можно не больше, чем списано. Если указана сделка - не больше, чем списано в ней.'
            },
            topup: {
                title: 'Пополнение', submit: 'Пополнить', path: 'topup', amount: true,
                note: 'Ручное пополнение, например при оплате наличными.'
            },
            block: {
                title: 'Блокировка', submit: 'Заблокировать', path: 'block',
                note: 'Пока номер заблокирован, списать с него нельзя. Например, если клиент сообщил, что номер увидели посторонние.'
            },
            unblock: { title: 'Разблокировка', submit: 'Разблокировать', path: 'block' },
            link: {
                title: 'Торговая точка СБП', submit: 'Сохранить', path: 'sbp', merchant: true, noComment: true,
                note: 'ID точки из интернет-банка Точки: «QR-платежи» -> точка «Для фамилия», номер под названием, ' +
                    'например MA0004772653. Оплаты гостей по QR этой точки будут сами зачисляться на подписку. ' +
                    'Пустое поле - отвязать точку.'
            }
        }[action];
        if (!cfg) return;

        box.innerHTML = `
            <div class="pcx-vx-action">
                <div class="pcx-vx-action__title">${cfg.title}</div>
                ${cfg.note ? `<div class="pcx-vx-muted">${cfg.note}</div>` : ''}
                <div class="pcx-vx-row">
                    ${cfg.amount ? `<input type="text" inputmode="decimal" class="pcx-vx-amount" data-f="amount" placeholder="Сумма, ₽" value="${cfg.defaultKop ? cfg.defaultKop / 100 : ''}">` : ''}
                    ${cfg.lead ? `<input type="text" inputmode="numeric" class="pcx-vx-lead" data-f="lead" placeholder="№ сделки" value="${leadNet > 0 ? leadId : ''}">` : ''}
                    ${cfg.merchant ? `<input type="text" data-f="merchant" placeholder="MA0004772653" autocomplete="off" spellcheck="false" value="${escHtml(v.sbp_merchant_id || '')}">` : ''}
                    ${cfg.noComment ? '' : '<input type="text" data-f="comment" placeholder="Причина (обязательно)">'}
                </div>
                <div class="pcx-vx-actions">
                    <button class="pcx-btn pcx-btn--ghost" data-f="cancel">Отмена</button>
                    <button class="pcx-btn pcx-btn--primary" data-f="submit">${cfg.submit}</button>
                </div>
            </div>`;

        let key = `amo:${action}:${vxUuid()}`;
        box.querySelector('[data-f="cancel"]').onclick = () => { box.innerHTML = ''; };
        const submitBtn = box.querySelector('[data-f="submit"]');
        submitBtn.onclick = async () => {
            const commentInput = box.querySelector('[data-f="comment"]');
            const comment = commentInput ? commentInput.value.trim() : '';
            if (commentInput && !comment) {
                showNotification('Укажите причину', 'warning');
                commentInput.focus();
                return;
            }
            const body = { comment, actor: getCurrentManagerName() };
            let question = `${cfg.submit}: ${v.kind_title.toLowerCase()} ${v.code}?`;
            if (cfg.merchant) {
                const merchant = box.querySelector('[data-f="merchant"]').value.replace(/\s+/g, '').toUpperCase();
                if (merchant && !/^[A-Z]{2}[0-9]{6,14}$/.test(merchant)) {
                    showNotification('ID точки выглядит как MA0004772653 - две латинские буквы и цифры', 'warning');
                    return;
                }
                body.merchant_id = merchant;
                question = merchant
                    ? `Привязать точку ${merchant} к подписке ${v.code}? Оплаты по её QR будут зачисляться сюда.`
                    : `Отвязать торговую точку от подписки ${v.code}? Оплаты по её QR перестанут зачисляться.`;
            }
            if (cfg.amount) {
                const kop = rubToKop(box.querySelector('[data-f="amount"]').value);
                if (!kop || kop <= 0) {
                    showNotification('Укажите сумму', 'warning');
                    return;
                }
                body.amount_kop = kop;
                body.idempotency_key = key;
                question = `${cfg.submit} ${formatKop(kop)} (${v.kind_title.toLowerCase()} ${v.code})?`;
            }
            if (cfg.lead) {
                const lead = parseInt(box.querySelector('[data-f="lead"]').value, 10);
                if (lead > 0) body.lead_id = lead;
            }
            if (cfg.path === 'block') body.blocked = action === 'block';
            if (!confirm(question)) return;

            submitBtn.disabled = true;
            try {
                await loyaltyRequest('POST', `/api/v1/vouchers/${encodeURIComponent(v.code)}/${cfg.path}`, body);
                showNotification('Готово', 'success');
                if (onChange) onChange();
            } catch (error) {
                if (error.status && error.status < 500) key = `amo:${action}:${vxUuid()}`;
                showNotification(error.message, 'error');
                submitBtn.disabled = false;
            }
        };
    }

    // ---------- окна поверх вкладки ----------

    function openVxModal() {
        const host = document.getElementById('promo-codes-overlay') || document.body;
        const wrap = document.createElement('div');
        wrap.className = 'pcx-vx-modal-overlay';
        wrap.innerHTML = `
            <div class="pcx-vx-modal">
                <button class="pcx-iconbtn pcx-vx-modal__close" title="Закрыть">${ICONS.close}</button>
                <div class="pcx-vx" data-vx="modal-body"></div>
            </div>`;
        host.appendChild(wrap);
        const close = () => wrap.remove();
        wrap.querySelector('.pcx-vx-modal__close').onclick = close;
        wrap.addEventListener('click', (e) => {
            if (e.target === wrap) close();
        });
        return { body: wrap.querySelector('[data-vx="modal-body"]'), close };
    }

    async function openVoucherModal(code) {
        const { body } = openVxModal();
        const load = async () => {
            body.innerHTML = '<div class="pcx-vx-muted">Загружаю...</div>';
            try {
                const data = await loyaltyRequest('GET', '/api/v1/vouchers/' + encodeURIComponent(code));
                renderVoucherCard(body, data, () => {
                    load();
                    vxRefreshAll();
                });
            } catch (error) {
                body.innerHTML = vxNote('err', escHtml(error.message));
            }
        };
        await load();
    }

    async function openIssueModal(kindKey) {
        const kind = vxKindDef(kindKey);
        const leadId = getCurrentLeadId();
        const ctx = await getVxLeadContext();
        const idemKey = 'amo:issue:' + vxUuid(); // повторный клик не выпустит второй номер
        const { body, close } = openVxModal();
        const isWedding = kind.key === 'wedding_subscription';

        body.innerHTML = `
            <div>
                <h3 class="pcx-vx-modal__title">${kind.issueTitle}</h3>
                <div class="pcx-vx-muted">${leadId ? 'Сделка №' + leadId + '. ' : ''}Номер сгенерируется автоматически.</div>
            </div>
            <div class="pcx-vx-form">
                <div class="pcx-vx-field">
                    <label>${isWedding ? 'Начальная сумма, ₽' : 'Сумма, ₽'}</label>
                    <input type="text" inputmode="decimal" data-f="amount" placeholder="${isWedding ? '0' : '3000'}">
                    ${isWedding ? '<div class="pcx-vx-muted">Можно оставить 0 - подписку пополнят гости</div>' : ''}
                </div>
                <div class="pcx-vx-field">
                    <label>Телефон покупателя</label>
                    <input type="tel" data-f="phone" value="${escHtml(ctx.phone)}" placeholder="+7 900 000-00-00">
                </div>
                <div class="pcx-vx-field">
                    <label>Имя покупателя</label>
                    <input type="text" data-f="name" value="${escHtml(ctx.contactName)}">
                </div>
                <div class="pcx-vx-field">
                    <label>${isWedding ? 'Пара' : 'Кому (получатель)'}</label>
                    <input type="text" data-f="recipient" placeholder="${isWedding ? 'Анна и Сергей' : 'Необязательно'}">
                </div>
                ${kind.key === 'flower_subscription' ? `
                    <div class="pcx-vx-field pcx-vx-field--wide">
                        <label>График доставок</label>
                        <input type="text" data-f="schedule" placeholder="Например, букет раз в неделю по пятницам">
                    </div>` : ''}
                ${isWedding ? `
                    <div class="pcx-vx-field">
                        <label>Дата свадьбы</label>
                        <input type="date" data-f="wedding_date">
                    </div>` : ''}
                ${kind.key !== 'certificate' ? `
                    <div class="pcx-vx-field pcx-vx-field--wide">
                        <label>Торговая точка СБП (для оплат по QR)</label>
                        <input type="text" data-f="merchant" placeholder="MA0004772653" autocomplete="off" spellcheck="false">
                        <div class="pcx-vx-muted">Интернет-банк Точки: «QR-платежи» -> точка «Для фамилия», номер под названием. Оплаты гостей по её QR будут сами зачисляться на подписку. Можно добавить позже.</div>
                    </div>` : ''}
                <div class="pcx-vx-field pcx-vx-field--wide">
                    <label>Пожелание</label>
                    <textarea rows="2" data-f="message" placeholder="Текст для получателя, необязательно"></textarea>
                </div>
                <div class="pcx-vx-field pcx-vx-field--wide">
                    <label>Служебный комментарий</label>
                    <input type="text" data-f="comment" placeholder="Например, оплачен переводом, видит только команда">
                </div>
            </div>
            <div data-f="error"></div>
            <div class="pcx-vx-actions">
                <button class="pcx-btn pcx-btn--ghost" data-f="cancel">Отмена</button>
                <button class="pcx-btn pcx-btn--primary" data-f="submit">Выпустить</button>
            </div>`;

        const field = (name) => body.querySelector(`[data-f="${name}"]`);
        field('cancel').onclick = close;
        field('amount').focus();

        field('submit').onclick = async () => {
            const errBox = field('error');
            const rawAmount = field('amount').value.trim();
            const kop = rawAmount === '' && isWedding ? 0 : rubToKop(rawAmount);
            if (!isFinite(kop) || kop < 0 || (!isWedding && kop === 0)) {
                errBox.innerHTML = vxNote('warn', 'Укажите сумму больше нуля');
                field('amount').focus();
                return;
            }
            if (!field('phone').value.trim()) {
                errBox.innerHTML = vxNote('warn', 'Укажите телефон покупателя - по нему сертификат найдётся у клиента');
                field('phone').focus();
                return;
            }
            const merchant = field('merchant') ? field('merchant').value.replace(/\s+/g, '').toUpperCase() : '';
            if (merchant && !/^[A-Z]{2}[0-9]{6,14}$/.test(merchant)) {
                errBox.innerHTML = vxNote('warn', 'ID торговой точки выглядит как MA0004772653 - две латинские буквы и цифры');
                field('merchant').focus();
                return;
            }
            const meta = {};
            if (field('schedule') && field('schedule').value.trim()) meta.schedule = field('schedule').value.trim();
            if (field('wedding_date') && field('wedding_date').value) meta.wedding_date = field('wedding_date').value;

            if (!confirm(`Выпустить: ${kind.title.toLowerCase()} на ${formatKop(kop)}?`)) return;

            field('submit').disabled = true;
            errBox.innerHTML = '';
            try {
                const res = await loyaltyRequest('POST', '/api/v1/vouchers', {
                    kind: kind.key,
                    nominal_kop: kop,
                    buyer_phone: field('phone').value.trim(),
                    buyer_name: field('name').value.trim(),
                    contact_id: ctx.contactId || 0,
                    lead_id: leadId || 0,
                    sbp_merchant_id: merchant,
                    recipient_name: field('recipient').value.trim(),
                    message: field('message').value.trim(),
                    comment: field('comment').value.trim(),
                    meta: Object.keys(meta).length ? meta : null,
                    actor: getCurrentManagerName(),
                    idempotency_key: idemKey
                });
                const v = res.voucher;
                body.innerHTML = `
                    <div>
                        <h3 class="pcx-vx-modal__title">${escHtml(v.kind_title)} выпущен${kind.key === 'certificate' ? '' : 'а'}</h3>
                        <div class="pcx-vx-muted">${formatKop(v.nominal_kop)}${v.buyer_name ? ', ' + escHtml(v.buyer_name) : ''}${v.buyer_phone ? ', ' + escHtml(vxPhone(v.buyer_phone)) : ''}</div>
                    </div>
                    <div class="pcx-vx-codebig">${escHtml(v.code)}</div>
                    <div class="pcx-vx-actions">
                        <button class="pcx-btn pcx-btn--ghost" data-f="copy-code">Скопировать номер</button>
                        <button class="pcx-btn pcx-btn--ghost" data-f="copy-text">Скопировать текст для клиента</button>
                        <button class="pcx-btn pcx-btn--primary" data-f="open">Открыть карточку</button>
                    </div>`;
                field('copy-code').onclick = () => vxCopy(v.code);
                field('copy-text').onclick = () => vxCopy(vxClientText(v));
                field('open').onclick = () => {
                    close();
                    openVoucherModal(v.code);
                };
                showNotification(`Выпущен номер ${v.code}`, 'success');
                vxRefreshAll();
            } catch (error) {
                errBox.innerHTML = vxNote('err', escHtml(error.message));
                field('submit').disabled = false;
            }
        };
    }

    // ---------- разделы по видам: сводка и список ----------

    function renderVxKindPanel() {
        const panel = document.getElementById('vx-kind-panel');
        if (!panel) return;
        const kind = vxKindDef(vxSubtab);
        panel.innerHTML = `
            <section class="pcx-vx-block">
                <div class="pcx-vx-block__title">
                    <span>${kind.label}</span>
                    ${canLoyalty('issue') ? `<button class="pcx-btn pcx-btn--primary" data-vx="issue">${ICONS.plus}<span>Выпустить</span></button>` : ''}
                </div>
                <div class="pcx-vx-row pcx-vx-between">
                    <div class="pcx-vx-pills" data-vx="periods">
                        ${VX_PERIODS.map(p => `<button class="pcx-vx-pill${p.key === vxPeriod ? ' is-active' : ''}" data-period="${p.key}">${p.label}</button>`).join('')}
                    </div>
                    <button class="pcx-iconbtn" data-vx="refresh" title="Обновить">${ICONS.refresh}</button>
                </div>
                <div class="pcx-vx-stats" data-vx="stats"></div>
                <div class="pcx-vx-filters">
                    <select data-vx="state">
                        <option value="">Все состояния</option>
                        <option value="active">Действуют</option>
                        <option value="exhausted">Остаток 0</option>
                        <option value="blocked">Заблокированы</option>
                    </select>
                    <input type="text" data-vx="q" placeholder="Поиск: номер, телефон, имя или № сделки">
                </div>
                <div data-vx="list"></div>
            </section>`;

        const issueBtn = panel.querySelector('[data-vx="issue"]');
        if (issueBtn) issueBtn.onclick = () => openIssueModal(vxSubtab);
        panel.querySelectorAll('[data-period]').forEach(btn => {
            btn.onclick = () => {
                vxPeriod = btn.dataset.period;
                panel.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('is-active', b === btn));
                loadVxStats(panel);
            };
        });
        panel.querySelector('[data-vx="refresh"]').onclick = () => {
            loadVxStats(panel);
            loadVxList(panel, false);
        };
        panel.querySelector('[data-vx="state"]').onchange = () => loadVxList(panel, false);
        let searchTimer = null;
        panel.querySelector('[data-vx="q"]').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => loadVxList(panel, false), 400);
        });

        loadVxStats(panel);
        loadVxList(panel, false);
    }

    async function loadVxStats(panel) {
        const box = panel.querySelector('[data-vx="stats"]');
        if (!box) return;
        const kindKey = vxSubtab;
        const period = VX_PERIODS.find(p => p.key === vxPeriod) || VX_PERIODS[1];
        const from = period.days ? new Date(Date.now() - period.days * 864e5) : new Date('2020-01-01T00:00:00Z');
        box.innerHTML = '<div class="pcx-vx-muted">Считаю...</div>';
        try {
            const res = await loyaltyRequest('GET', '/api/v1/stats?from=' + encodeURIComponent(from.toISOString()));
            if (kindKey !== vxSubtab) return; // пока считали, переключили раздел
            const s = (res.kinds || []).find(k => k.kind === kindKey) || {};
            const isSub = kindKey !== 'certificate';
            box.innerHTML = [
                vxStat('Остаток у клиентов', formatKop(s.balance_kop), vxPlural(s.active || 0, 'действует', 'действуют', 'действуют'), 'accent'),
                vxStat('Выпущено за период', formatKop(s.period_issued_kop),
                    `${s.period_issued_count || 0} шт.` + (isSub && s.period_topup_kop ? `, пополнено на ${formatKop(s.period_topup_kop)}` : '')),
                vxStat('Потрачено за период', formatKop(s.period_spent_kop)),
                vxStat('За всё время', formatKop((s.issued_kop || 0) + (s.topup_kop || 0)), `${s.count || 0} шт., потрачено ${formatKop(s.spent_kop)}`),
                vxStat('Не действуют', String((s.exhausted || 0) + (s.blocked || 0)),
                    `${s.exhausted || 0} пустых, ${s.blocked || 0} в блоке`)
            ].join('');
        } catch (error) {
            box.innerHTML = vxNote('err', escHtml(error.message));
        }
    }

    async function loadVxList(panel, more) {
        const box = panel.querySelector('[data-vx="list"]');
        if (!box) return;
        const kindKey = vxSubtab;
        const state = panel.querySelector('[data-vx="state"]').value;
        const q = panel.querySelector('[data-vx="q"]').value.trim();
        const seq = ++vxListSeq;
        const params = new URLSearchParams({ kind: kindKey, limit: '50', offset: String(more ? vxList.items.length : 0) });
        if (state) params.set('state', state);
        if (q) params.set('q', q);
        if (!more) box.innerHTML = '<div class="pcx-vx-muted">Загружаю...</div>';
        try {
            const res = await loyaltyRequest('GET', '/api/v1/vouchers?' + params.toString());
            if (seq !== vxListSeq) return; // уже пришёл более свежий запрос
            vxList = { items: more ? vxList.items.concat(res.items || []) : (res.items || []), total: res.total || 0 };
            if (!vxList.items.length) {
                const kindDef = vxKindDef(kindKey);
                box.innerHTML = (q || state)
                    ? `<div class="pcx-vx-empty"><div class="pcx-vx-empty__title">Ничего не нашлось</div>
                        <div class="pcx-vx-empty__text">Попробуйте другой номер, телефон или уберите фильтр</div></div>`
                    : `<div class="pcx-vx-empty"><div class="pcx-vx-empty__title">${kindDef.label}: пока ни одного</div>
                        <div class="pcx-vx-empty__text">${canLoyalty('issue')
                            ? 'Нажмите «Выпустить» - номер появится здесь'
                            : 'Выпускает администратор, выпущенные появятся здесь'}</div></div>`;
                return;
            }
            const kind = vxKindDef(kindKey);
            const rest = vxList.total - vxList.items.length;
            box.innerHTML = `
                <div class="pcx-vx-tablewrap"><table class="pcx-vx-table">
                    <thead><tr>
                        <th>Номер</th><th>Покупатель</th><th>Выпущен</th>
                        <th class="pcx-vx-num">${kind.nominal}</th><th class="pcx-vx-num">Потрачено</th><th class="pcx-vx-num">Остаток</th><th>Состояние</th>
                    </tr></thead>
                    <tbody>${vxList.items.map(v => `
                        <tr class="is-click" data-vx-open="${escHtml(v.code)}">
                            <td class="pcx-vx-code">${escHtml(v.code)}</td>
                            <td>${escHtml(v.buyer_name || '')}<div class="pcx-vx-muted">${escHtml(vxPhone(v.buyer_phone))}</div></td>
                            <td class="pcx-vx-nowrap">${vxDate(v.created_at)}${v.lead_id ? `<div class="pcx-vx-muted">${vxLeadLink(v.lead_id)}</div>` : ''}</td>
                            <td class="pcx-vx-num">${formatKop(v.nominal_kop + (v.topup_kop || 0))}</td>
                            <td class="pcx-vx-num">${formatKop(v.spent_kop)}</td>
                            <td class="pcx-vx-num"><b>${formatKop(v.balance_kop)}</b></td>
                            <td>${vxBadge(v)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table></div>
                ${rest > 0 ? `<button class="pcx-btn pcx-btn--ghost pcx-vx-more" data-vx="more">Показать ещё ${rest}</button>` : ''}
                <div class="pcx-vx-muted pcx-vx-hint">Показано ${vxList.items.length} из ${vxList.total}</div>`;
            vxBindOpen(box);
            const moreBtn = box.querySelector('[data-vx="more"]');
            if (moreBtn) moreBtn.onclick = () => loadVxList(panel, true);
        } catch (error) {
            if (seq === vxListSeq) box.innerHTML = vxNote('err', escHtml(error.message));
        }
    }

    // ---------- блок в «Настройках» ----------

    async function renderLoyaltySettings(box) {
        if (!box) return;
        const { url, token } = await getLoyaltySettings();
        box.innerHTML = `
            <section class="pcx-vx pcx-vx-block">
                <h3 class="pcx-vx-block__title">Подписки и сертификаты</h3>
                <div class="pcx-vx-muted">Токен выдаёт администратор. От него зависят права: менеджер проверяет и списывает, администратор ещё выпускает, возвращает и блокирует.</div>
                <div class="pcx-vx-field">
                    <label>Адрес сервиса</label>
                    <input type="text" data-vx="url" value="${escHtml(url)}">
                </div>
                <div class="pcx-vx-field">
                    <label>Токен доступа</label>
                    <input type="password" data-vx="token" value="${escHtml(token)}" placeholder="Вставьте токен" autocomplete="off">
                </div>
                <div class="pcx-vx-row">
                    <button class="pcx-btn pcx-btn--primary" data-vx="save">Сохранить и проверить</button>
                    ${token ? '<button class="pcx-btn pcx-btn--ghost" data-vx="forget">Удалить токен</button>' : ''}
                </div>
                <div data-vx="status"></div>
            </section>`;

        const status = box.querySelector('[data-vx="status"]');
        const check = async () => {
            status.innerHTML = vxNote('info', 'Проверяю подключение...');
            try {
                const me = await loadLoyaltyMe(true);
                status.innerHTML = vxNote('ok', `Подключено. Роль: ${escHtml(LOYALTY_ROLES[me.role] || me.role)}.`);
            } catch (error) {
                status.innerHTML = vxNote('err', escHtml(error.message));
            }
        };

        box.querySelector('[data-vx="save"]').onclick = async () => {
            const newUrl = box.querySelector('[data-vx="url"]').value.trim().replace(/\/+$/, '') || LOYALTY_DEFAULT_URL;
            const newToken = box.querySelector('[data-vx="token"]').value.trim();
            if (!/^https:\/\//.test(newUrl)) {
                showNotification('Адрес должен начинаться с https://', 'warning');
                return;
            }
            await GM.setValue(LOYALTY_URL_KEY, newUrl === LOYALTY_DEFAULT_URL ? '' : newUrl);
            await GM.setValue(LOYALTY_TOKEN_KEY, newToken);
            loyaltyMe = null;
            await refreshPromoBackend();
            if (!newToken) {
                status.innerHTML = vxNote('warn', 'Токен не указан');
                return;
            }
            renderLoyaltySettings(box); // перерисовка покажет «Удалить токен» и сама проверит связь
        };
        const forgetBtn = box.querySelector('[data-vx="forget"]');
        if (forgetBtn) {
            forgetBtn.onclick = async () => {
                if (!confirm('Удалить токен доступа с этого компьютера?')) return;
                await GM.setValue(LOYALTY_TOKEN_KEY, '');
                loyaltyMe = null;
                await refreshPromoBackend();
                renderLoyaltySettings(box);
            };
        }
        if (token) check();
    }

    async function saveWebAppUrl() {
        const url = document.getElementById('webapp-url-input').value.trim();
        
        if (!url) {
            showNotification('Введите URL', 'warning');
            return;
        }

        if (!url.includes('script.google.com') && !isLoyaltyGasUrl(url)) {
            showNotification('Неверный формат URL: нужен адрес Google Apps Script или https://.../loyalty/gas', 'warning');
            return;
        }

        webAppUrl = url;
        localStorage.setItem('promo_webapp_url', url);
        if (isLoyaltyGasUrl(url) && !(await GM.getValue(LOYALTY_TOKEN_KEY, ''))) {
            showNotification('URL сохранен. Для сервиса лояльности укажите ниже токен доступа', 'warning');
            return;
        }
        showNotification('URL сохранен', 'success');
    }

    // Бэкенд промокодов по умолчанию (с 3.5.1): с токеном сервиса лояльности - сам сервис
    // (.../loyalty/gas), без токена - прежний адрес GAS, который сам пересылает запросы
    // в сервис. Сохранённый вручную прежний адрес GAS считается «по умолчанию».
    let promoBackendHasToken = false;
    let promoBackendLoyaltyBase = 'https://myskladandamocrm.ru/loyalty';

    function resolvePromoBackendUrl() {
        const saved = localStorage.getItem('promo_webapp_url');
        if (saved && saved !== DEFAULT_WEBAPP_URL) return saved;
        return promoBackendHasToken ? promoBackendLoyaltyBase + '/gas' : DEFAULT_WEBAPP_URL;
    }

    async function refreshPromoBackend() {
        try {
            const { url, token } = await getLoyaltySettings();
            promoBackendHasToken = !!token;
            promoBackendLoyaltyBase = url;
        } catch (e) {
            promoBackendHasToken = false;
        }
        webAppUrl = resolvePromoBackendUrl();
    }

    function loadSettings() {
        webAppUrl = resolvePromoBackendUrl();
        isAdminAuthorized = localStorage.getItem('promo_admin_authorized') === 'true';
        const cachedPromos = getCachedPromoCodes();
        if (cachedPromos) {
            promoCodesCache = cachedPromos;
        }
        const cachedAmoCRMPromos = getCachedAmoCRMPromoCodes();
        if (cachedAmoCRMPromos) {
            amoCRMPromoCodes = cachedAmoCRMPromos;
        }
        const cachedRequests = localStorage.getItem('bonus_requests_cache');
        if (cachedRequests) {
            try {
                bonusRequestsCache = JSON.parse(cachedRequests);
            } catch (error) {
                console.error('Ошибка загрузки кэша заявок:', error);
            }
        }
    }

    function cachePromoCodes(promoCodes) {
        const cacheData = {
            promoCodes: promoCodes,
            timestamp: Date.now()
        };
        localStorage.setItem('promo_codes_cache', JSON.stringify(cacheData));
        localStorage.setItem('promo_last_sync', new Date().toISOString());
    }

    function getCachedPromoCodes(checkExpiration = false) {
        try {
            const cached = localStorage.getItem('promo_codes_cache');
            if (!cached) return null;

            const cacheData = JSON.parse(cached);

            // Если checkExpiration=true, проверяем время жизни кэша
            if (checkExpiration) {
                const age = Date.now() - cacheData.timestamp;
                if (age >= CACHE_DURATION) {
                    return null; // Кэш устарел, нужна синхронизация
                }
            }

            // Всегда возвращаем кэшированные данные для отображения
            // Это предотвращает исчезновение промокодов при обновлении страницы
            return cacheData.promoCodes;
        } catch (error) {
            console.error('Ошибка чтения кэша:', error);
        }
        return null;
    }

    function updateStatistics() {
        const googleCount = document.getElementById('google-promo-count');
        const amoCRMCount = document.getElementById('amocrm-promo-count');
        const lastSync = document.getElementById('last-sync-time');

        if (googleCount) googleCount.textContent = promoCodesCache.length;
        if (amoCRMCount) amoCRMCount.textContent = amoCRMPromoCodes.length;

        if (lastSync) {
            const lastSyncTime = localStorage.getItem('promo_last_sync');
            if (lastSyncTime) {
                const date = new Date(lastSyncTime);
                lastSync.textContent = `Последняя синхронизация: ${formatDateTime(date)}`;
            }
        }
    }

    function getLeadBudget() {
        const budgetInput = document.getElementById('lead_card_budget');
        if (budgetInput && budgetInput.value) {
            const budget = parseFloat(budgetInput.value.replace(/\s/g, ''));
            return isNaN(budget) ? 0 : budget;
        }
        return 0;
    }

    async function openPromoModal() {
        let overlay = document.getElementById('promo-codes-overlay');

        if (!overlay) {
            createPromoModal();
            overlay = document.getElementById('promo-codes-overlay');
        }

        currentLeadBudget = getLeadBudget();
        overlay.style.display = 'block';
        switchTab('check');
        
        if (amoCRMPromoCodes.length === 0) {
            await syncWithAmoCRM(true);
        }
    }

    function closePromoModal() {
        const overlay = document.getElementById('promo-codes-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    function showResult(container, message, type) {
        container.style.display = 'block';
        container.innerHTML = message;
        
        const colors = {
            success: { bg: '#E6F4EC', border: '#c3e6cb', text: '#1E6B44' },
            error: { bg: '#FBECEC', border: '#f5c6cb', text: '#721c24' },
            warning: { bg: '#FCF4E8', border: '#ffeeba', text: '#856404' },
            info: { bg: '#d1ecf1', border: '#bee5eb', text: '#0c5460' }
        };

        const color = colors[type] || colors.info;
        container.style.background = color.bg;
        container.style.borderRadius = '12px';
        container.style.color = color.text;
    }

    function showNotification(message, type) {
        injectStyles();

        // Одновременно висит только одно уведомление - предыдущее заменяем
        document.querySelectorAll('.pcx-toast').forEach(el => el.remove());

        const notification = document.createElement('div');
        notification.className = `pcx pcx-toast${type === 'error' ? ' pcx-toast--error' : type === 'warning' ? ' pcx-toast--warning' : type === 'info' ? ' pcx-toast--info' : ''}`;
        notification.textContent = message;

        // Если висит плашка обновления - становимся под неё, а не поверх
        const banner = document.getElementById('pcx-update-banner');
        if (banner) notification.style.top = `${banner.offsetHeight + 32}px`;

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), type === 'error' ? 5000 : 3000);
    }

    function formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        return date.toLocaleDateString('ru-RU');
    }

    function formatDateTime(date) {
        return date.toLocaleString('ru-RU', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function init() {
        console.log('Инициализация Promo Codes Manager...');
        injectStyles();
        injectFont();
        loadSettings();
        refreshPromoBackend();
        createPromoButton();
        setTimeout(checkForScriptUpdate, 8000);   // не мешаем загрузке страницы сделки
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            const oldButton = document.getElementById('promo-codes-main-btn');
            if (oldButton) oldButton.remove();
            setTimeout(createPromoButton, 1000);
        }
    }).observe(document, {subtree: true, childList: true});

})();

