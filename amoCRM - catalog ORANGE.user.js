// ==UserScript==
// @name         amoCRM - Каталог Orange
// @namespace    http://tampermonkey.net/
// @version      10.0.0
// @description  Каталог Orange из store-API Tilda (тот же источник, что и сайт): все товары, цены как на сайте, категории сайта, отправка в чат amoCRM
// @author       Вы
// @match        https://*.amocrm.ru/*
// @match        https://*.kommo.com/*
// @updateURL    https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20catalog%20ORANGE.user.js
// @downloadURL  https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20catalog%20ORANGE.user.js
// @grant        GM.xmlHttpRequest
// @connect      store.tildaapi.com
// @connect      orangesmr.ru
// @connect      static.tildacdn.com
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '10.0.0';

    // Основной источник - тот же store-API Tilda, из которого товары берёт сам сайт.
    // В отличие от YML-фида отдаёт ВСЕ товары (включая распроданные), цену карточки
    // (ровно как на сайте), остатки, дерево категорий сайта и всю галерею фото.
    const STORE_API_URL = 'https://store.tildaapi.com/api/getproductslist/';
    const DEFAULT_STORE_RECID = '1027275996';    // id блока каталога на сайте orangesmr.ru
    const DEFAULT_STORE_PART = '986423143961';   // категория «Все»
    const STORE_PAGE_SIZE = 100;                 // API отдаёт не больше ~300 за раз, ходим страницами

    // Резервный источник - старый YML-фид (используется, только если store-API недоступен)
    const DEFAULT_YML_FEED_URL = 'https://orangesmr.ru/tstore/yml/5a000cfb7af67e4e5d2e22d7edc7cf54.yml';

    // Ключи кэша
    const CACHE_KEY = 'orange_store_catalog_v10';
    const CACHE_TS_KEY = 'orange_store_catalog_v10_ts';
    const PARTS_KEY = 'orange_store_parts_v10';
    const CACHE_MAX_AGE = 15 * 60 * 1000;        // 15 минут: остатки на сайте меняются быстро

    // Сбрасываем кэш при обновлении версии скрипта
    (function checkVersionUpdate() {
        const savedVersion = localStorage.getItem('orange_catalog_version');
        if (savedVersion !== SCRIPT_VERSION) {
            console.log(`🔄 Обновление версии ${savedVersion} → ${SCRIPT_VERSION}, сбрасываем кэш...`);
            localStorage.removeItem('orange_yml_feed_url');
            localStorage.removeItem('orange_tilda_catalog');
            localStorage.removeItem('orange_tilda_catalog_timestamp');
            localStorage.removeItem(CACHE_KEY);
            localStorage.removeItem(CACHE_TS_KEY);
            localStorage.removeItem(PARTS_KEY);
            localStorage.setItem('orange_catalog_version', SCRIPT_VERSION);
        }
    })();

    let productsCache = [];
    let sitePartsCache = [];          // дерево категорий сайта
    let activeCustomCategory = null;  // индекс выбранной «моей категории» или null

    function getFeedUrl() {
        try {
            const saved = localStorage.getItem('orange_yml_feed_url');
            return saved || DEFAULT_YML_FEED_URL;
        } catch (error) {
            console.error('Ошибка чтения URL фида:', error);
            return DEFAULT_YML_FEED_URL;
        }
    }

    function saveFeedUrl(url) {
        try {
            localStorage.setItem('orange_yml_feed_url', url);
            console.log('URL фида сохранён:', url);
            return true;
        } catch (error) {
            console.error('Ошибка сохранения URL фида:', error);
            return false;
        }
    }
    let customCategories = [];

    let selectedProducts = new Set();
    let currentCategoryEdit = null;

    // Основной шрифт интерфейса: Manrope подгружается ниже, дальше - системный стек
    const FONT_FAMILY = "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

    // Вариативный Manrope с Google Fonts: два файла (кириллица + латиница) на все начертания.
    // Вшиваем их как data-URI, иначе CSP amoCRM может не пустить внешний шрифт.
    const FONT_SOURCES = [
        { range: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
          url: 'https://fonts.gstatic.com/s/manrope/v20/xn7gYHE41ni1AdIRggOxSvfedN62Zw.woff2' },
        { range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
          url: 'https://fonts.gstatic.com/s/manrope/v20/xn7gYHE41ni1AdIRggexSvfedN4.woff2' }
    ];
    const FONT_CACHE_KEY = 'orange_font_manrope_v1';

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
                onload: function(response) {
                    if (response.status !== 200) { reject(new Error(String(response.status))); return; }
                    try {
                        resolve(arrayBufferToBase64(response.response));
                    } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('сеть')),
                timeout: 20000
            });
        });
    }

    async function injectFont() {
        if (document.getElementById('ocx-font')) return;

        let cached = null;
        try {
            cached = JSON.parse(localStorage.getItem(FONT_CACHE_KEY) || 'null');
        } catch (error) {
            cached = null;
        }

        let payload = cached;
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
        style.id = 'ocx-font';
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

    // Тонкие иконки вместо эмодзи
    const ICONS = {
        chevron: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>',
        close: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
        plus: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
        upload: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V2.5M5 5.5L8 2.5l3 3"/><path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2"/></svg>',
        download: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M5 7.5l3 3 3-3"/><path d="M2.5 10.5v2a1 1 0 001 1h9a1 1 0 001-1v-2"/></svg>',
        refresh: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9"/><path d="M13.5 2.5V5H11"/></svg>',
        pencil: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.2 2.8l2 2L6 12H4v-2z"/><path d="M10 4l2 2"/></svg>',
        trash: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8a1 1 0 001 .9h2.8a1 1 0 001-.9l.6-8"/></svg>',
        folder: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5a1 1 0 011-1h3l1.2 1.5H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>',
        check: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6.5"/></svg>'
    };

    function injectStyles() {
        if (document.getElementById('ocx-styles')) return;

        const style = document.createElement('style');
        style.id = 'ocx-styles';
        style.textContent = `
            :root {
                --ocx-accent: #E6407A;
                --ocx-accent-hover: #CF356B;
                --ocx-accent-soft: #FDEFF4;
                --ocx-text: #16161A;
                --ocx-text-2: #6E6E7A;
                --ocx-text-3: #9C9CA8;
                --ocx-border: #E7E7EC;
                --ocx-border-strong: #D6D6DE;
                --ocx-surface: #FFFFFF;
                --ocx-surface-2: #F7F7F9;
                --ocx-danger: #D64545;
            }

            .ocx, .ocx * {
                box-sizing: border-box;
                font-family: ${FONT_FAMILY} !important;
                -webkit-font-smoothing: antialiased;
            }

            /* Плавающая кнопка */
            #tilda-catalog-main-btn {
                position: fixed;
                z-index: 9998;
                display: inline-flex;
                align-items: center;
                gap: 8px;
                height: 40px;
                padding: 0 18px;
                border: none;
                border-radius: 12px;
                background: var(--ocx-accent);
                color: #fff;
                font-size: 14px;
                font-weight: 600;
                letter-spacing: -0.01em;
                white-space: nowrap;
                cursor: pointer;
                box-shadow: 0 6px 20px rgba(230, 64, 122, 0.28);
                transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
            }
            #tilda-catalog-main-btn:hover { background: var(--ocx-accent-hover); box-shadow: 0 8px 24px rgba(230, 64, 122, 0.34); }
            #tilda-catalog-main-btn.dragging { cursor: grabbing !important; transform: scale(0.97); }

            /* Модальное окно */
            .ocx-overlay {
                position: fixed;
                inset: 0;
                z-index: 9999;
                background: rgba(18, 18, 26, 0.45);
                backdrop-filter: blur(3px);
            }
            .ocx-modal {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: min(1240px, 94vw);
                height: min(88vh, 900px);
                background: var(--ocx-surface);
                border-radius: 18px;
                box-shadow: 0 30px 80px rgba(16, 16, 28, 0.28);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                color: var(--ocx-text);
            }
            .ocx-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                padding: 20px 24px;
                border-bottom: 1px solid var(--ocx-border);
            }
            .ocx-head__title { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
            .ocx-head__sub { margin: 3px 0 0; font-size: 13px; font-weight: 500; color: var(--ocx-text-3); }
            .ocx-iconbtn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 34px;
                height: 34px;
                border: none;
                border-radius: 10px;
                background: transparent;
                color: var(--ocx-text-2);
                cursor: pointer;
                transition: background 0.15s ease, color 0.15s ease;
            }
            .ocx-iconbtn:hover { background: var(--ocx-surface-2); color: var(--ocx-text); }

            /* Панель фильтров */
            .ocx-filters {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-wrap: wrap;
                padding: 14px 24px;
                border-bottom: 1px solid var(--ocx-border);
                background: var(--ocx-surface);
            }
            .ocx-field {
                height: 38px;
                padding: 0 12px;
                border: 1px solid var(--ocx-border);
                border-radius: 10px;
                background: var(--ocx-surface);
                font-size: 14px;
                font-weight: 500;
                color: var(--ocx-text);
                outline: none;
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .ocx-field::placeholder { color: var(--ocx-text-3); font-weight: 500; }
            .ocx-field:focus { border-color: var(--ocx-accent); box-shadow: 0 0 0 3px var(--ocx-accent-soft); }
            .ocx-field--search { flex: 1 1 180px; min-width: 160px; max-width: 260px; }
            .ocx-field--num { width: 96px; }
            .ocx-field--select { min-width: 186px; cursor: pointer; appearance: none; padding-right: 32px;
                background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236E6E7A' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");
                background-repeat: no-repeat; background-position: right 10px center; background-size: 16px; }

            .ocx-check {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                height: 38px;
                padding: 0 11px;
                border: 1px solid var(--ocx-border);
                border-radius: 10px;
                font-size: 14px;
                font-weight: 500;
                color: var(--ocx-text-2);
                cursor: pointer;
                user-select: none;
                white-space: nowrap;
                transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
            }
            .ocx-check:hover { border-color: var(--ocx-border-strong); color: var(--ocx-text); }
            .ocx-check input { width: 16px; height: 16px; accent-color: var(--ocx-accent); cursor: pointer; margin: 0; }
            .ocx-check:has(input:checked) { border-color: var(--ocx-accent); color: var(--ocx-accent); background: var(--ocx-accent-soft); }

            /* Кнопки */
            .ocx-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 7px;
                height: 38px;
                padding: 0 16px;
                border: 1px solid transparent;
                border-radius: 10px;
                font-size: 14px;
                font-weight: 600;
                letter-spacing: -0.01em;
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            .ocx-btn--primary { background: var(--ocx-accent); color: #fff; }
            .ocx-btn--primary:hover { background: var(--ocx-accent-hover); }
            .ocx-btn--primary:disabled { background: #E9E9EE; color: var(--ocx-text-3); cursor: default; }
            .ocx-btn--ghost { background: var(--ocx-surface); border-color: var(--ocx-border); color: var(--ocx-text-2); }
            .ocx-btn--ghost:hover { border-color: var(--ocx-border-strong); color: var(--ocx-text); }
            .ocx-btn--quiet { background: transparent; color: var(--ocx-text-2); padding: 0 10px; }
            .ocx-btn--quiet:hover { background: var(--ocx-surface-2); color: var(--ocx-text); }
            .ocx-btn--wide { width: 100%; }

            .ocx-summary { padding: 12px 24px 0; font-size: 13px; font-weight: 500; color: var(--ocx-text-3); }

            /* Галерея */
            .ocx-body { flex: 1; overflow-y: auto; padding: 14px 24px 24px; }
            .ocx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 18px; }
            .ocx-empty { grid-column: 1/-1; padding: 60px 0; text-align: center; color: var(--ocx-text-3); font-size: 14px; font-weight: 500; }

            .ocx-card {
                position: relative;
                border: 1px solid var(--ocx-border);
                border-radius: 14px;
                background: var(--ocx-surface);
                overflow: hidden;
                cursor: pointer;
                transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
            }
            .ocx-card:hover { border-color: var(--ocx-border-strong); box-shadow: 0 10px 28px rgba(18, 18, 30, 0.10); transform: translateY(-2px); }
            .ocx-card.is-picked { border-color: var(--ocx-accent); box-shadow: 0 0 0 1px var(--ocx-accent); }
            .ocx-card__media { position: relative; padding-top: 100%; background: var(--ocx-surface-2); overflow: hidden; }
            .ocx-card__media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
            .ocx-card.is-out .ocx-card__media img { filter: grayscale(0.75); opacity: 0.65; }
            .ocx-card__pick {
                position: absolute;
                top: 10px;
                right: 10px;
                width: 24px;
                height: 24px;
                border-radius: 8px;
                border: 1.5px solid rgba(255,255,255,0.9);
                background: rgba(20, 20, 28, 0.28);
                backdrop-filter: blur(4px);
                display: flex;
                align-items: center;
                justify-content: center;
                color: transparent;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            .ocx-card.is-picked .ocx-card__pick { background: var(--ocx-accent); border-color: var(--ocx-accent); color: #fff; }
            .ocx-badge {
                position: absolute;
                top: 10px;
                left: 10px;
                padding: 4px 9px;
                border-radius: 8px;
                background: rgba(22, 22, 26, 0.78);
                color: #fff;
                font-size: 11px;
                font-weight: 600;
                letter-spacing: -0.01em;
                backdrop-filter: blur(4px);
            }
            .ocx-card__body { padding: 14px 14px 16px; }
            .ocx-card__title { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; color: var(--ocx-text); }
            .ocx-price { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; }
            .ocx-price__now { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; color: var(--ocx-text); }
            .ocx-price__now--ask { font-size: 14px; font-weight: 600; color: var(--ocx-text-2); }
            .ocx-price__old { font-size: 13px; font-weight: 500; color: var(--ocx-text-3); text-decoration: line-through; }
            .ocx-card__descr { margin: 0; font-size: 12.5px; font-weight: 400; line-height: 1.45; color: var(--ocx-text-2);
                display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }

            /* Низ окна */
            .ocx-foot {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                padding: 16px 24px;
                border-top: 1px solid var(--ocx-border);
                background: var(--ocx-surface);
            }
            .ocx-foot__count { font-size: 13px; font-weight: 500; color: var(--ocx-text-2); }
            .ocx-foot__actions { display: flex; gap: 10px; }

            /* Меню «Мои категории» */
            .ocx-filters__right { display: flex; align-items: center; gap: 8px; margin-left: auto; }
            .ocx-menu-wrap { position: relative; }
            .ocx-menu {
                display: none;
                position: absolute;
                top: calc(100% + 6px);
                width: 320px;
                max-height: 420px;
                overflow-y: auto;
                padding: 6px;
                border: 1px solid var(--ocx-border);
                border-radius: 14px;
                background: var(--ocx-surface);
                box-shadow: 0 18px 44px rgba(18, 18, 30, 0.16);
                z-index: 10001;
            }
            .ocx-menu__item { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 10px; transition: background 0.12s ease; }
            .ocx-menu__item:hover { background: var(--ocx-surface-2); }
            .ocx-menu__info { flex: 1; min-width: 0; cursor: pointer; }
            .ocx-menu__name { font-size: 14px; font-weight: 600; color: var(--ocx-text); margin-bottom: 2px; }
            .ocx-menu__meta { font-size: 12px; font-weight: 500; color: var(--ocx-text-3); }
            .ocx-menu__meta--warn { color: var(--ocx-danger); }
            .ocx-menu__empty { padding: 18px 10px; text-align: center; font-size: 13px; font-weight: 500; color: var(--ocx-text-3); }
            .ocx-menu__sep { height: 1px; margin: 6px 4px; background: var(--ocx-border); }
            .ocx-menu__action {
                display: flex; align-items: center; gap: 9px; width: 100%;
                padding: 9px 10px; border: none; border-radius: 10px; background: transparent;
                font-size: 13.5px; font-weight: 500; color: var(--ocx-text-2); cursor: pointer; text-align: left;
                transition: background 0.12s ease, color 0.12s ease;
            }
            .ocx-menu__action:hover { background: var(--ocx-surface-2); color: var(--ocx-text); }
            .ocx-menu__action--accent { color: var(--ocx-accent); }
            .ocx-menu__action--accent:hover { background: var(--ocx-accent-soft); color: var(--ocx-accent-hover); }
            .ocx-mini {
                display: inline-flex; align-items: center; justify-content: center;
                width: 30px; height: 30px; border: none; border-radius: 8px;
                background: transparent; color: var(--ocx-text-3); cursor: pointer;
                transition: background 0.12s ease, color 0.12s ease;
            }
            .ocx-mini:hover { background: #fff; color: var(--ocx-text); box-shadow: 0 1px 3px rgba(18,18,30,.12); }
            .ocx-mini--danger:hover { color: var(--ocx-danger); }

            /* Редактор категории */
            .ocx-editor {
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: min(1100px, 92vw); height: min(84vh, 820px);
                background: var(--ocx-surface); border-radius: 18px; overflow: hidden;
                box-shadow: 0 30px 80px rgba(16, 16, 28, 0.3);
                display: flex; flex-direction: column; color: var(--ocx-text);
            }
            .ocx-pickgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
            .ocx-pick {
                position: relative; border: 1px solid var(--ocx-border); border-radius: 12px;
                overflow: hidden; cursor: pointer; background: var(--ocx-surface);
                transition: border-color 0.15s ease, box-shadow 0.15s ease;
            }
            .ocx-pick:hover { border-color: var(--ocx-border-strong); }
            .ocx-pick.is-picked { border-color: var(--ocx-accent); box-shadow: 0 0 0 1px var(--ocx-accent); }
            .ocx-pick__media { position: relative; padding-top: 100%; background: var(--ocx-surface-2); }
            .ocx-pick__media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
            .ocx-pick.is-out .ocx-pick__media img { filter: grayscale(0.75); opacity: 0.65; }
            .ocx-pick__mark {
                position: absolute; top: 8px; right: 8px; width: 21px; height: 21px; border-radius: 7px;
                border: 1.5px solid rgba(255,255,255,0.9); background: rgba(20,20,28,0.28);
                display: flex; align-items: center; justify-content: center; color: transparent;
            }
            .ocx-pick.is-picked .ocx-pick__mark { background: var(--ocx-accent); border-color: var(--ocx-accent); color: #fff; }
            .ocx-pick__body { padding: 10px 10px 12px; }
            .ocx-pick__title { font-size: 13px; font-weight: 600; line-height: 1.25; color: var(--ocx-text); }
            .ocx-pick__price { margin-top: 4px; font-size: 13px; font-weight: 600; color: var(--ocx-text-2); }
            .ocx-pick__price span { color: var(--ocx-text-3); font-weight: 500; }

            /* Уведомления */
            .ocx-toast {
                position: fixed; top: 20px; right: 20px; z-index: 10002;
                display: flex; align-items: center; gap: 10px;
                max-width: 380px; padding: 13px 16px;
                border-radius: 12px; background: #17171C; color: #fff;
                font-size: 13.5px; font-weight: 500; line-height: 1.4;
                box-shadow: 0 16px 40px rgba(16, 16, 28, 0.28);
                animation: ocx-slide 0.22s ease-out;
            }
            .ocx-toast::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #4ECB8D; }
            .ocx-toast--error::before { background: #FF6B6B; }
            .ocx-toast--info::before { background: #6BA8FF; }
            @keyframes ocx-slide { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
        `;
        document.head.appendChild(style);
    }


    function createMainButton() {
        if (!window.location.href.includes('/leads/detail/')) return;

        injectStyles();

        // Проверяем, не существует ли уже кнопка
        if (document.getElementById('tilda-catalog-main-btn')) return;

        const button = document.createElement('button');
        button.id = 'tilda-catalog-main-btn';
        button.className = 'ocx';
        button.innerHTML = `${ICONS.folder}<span>Каталог</span>`;
        button.title = 'Каталог Orange';

        // Загружаем сохранённую позицию или используем дефолтную
        const savedPosition = localStorage.getItem('catalog_button_position');
        let posX = window.innerWidth - 120;
        let posY = window.innerHeight - 80;

        if (savedPosition) {
            try {
                const pos = JSON.parse(savedPosition);
                posX = Math.min(pos.x, window.innerWidth - 100);
                posY = Math.min(pos.y, window.innerHeight - 40);
            } catch (e) {}
        }

        button.style.left = `${posX}px`;
        button.style.top = `${posY}px`;

        // Drag & Drop функционал
        let isDragging = false;
        let startX, startY, initialX, initialY;
        let hasMoved = false;

        const onMouseMove = (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
                hasMoved = true;
            }

            let newX = initialX + deltaX;
            let newY = initialY + deltaY;

            // Ограничиваем пределами экрана
            const btnWidth = button.offsetWidth || 100;
            const btnHeight = button.offsetHeight || 40;
            newX = Math.max(0, Math.min(newX, window.innerWidth - btnWidth));
            newY = Math.max(0, Math.min(newY, window.innerHeight - btnHeight));

            button.style.left = newX + 'px';
            button.style.top = newY + 'px';
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                button.classList.remove('dragging');

                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                // Сохраняем позицию
                localStorage.setItem('catalog_button_position', JSON.stringify({
                    x: button.offsetLeft,
                    y: button.offsetTop
                }));

                // Если не двигали - открываем модалку
                if (!hasMoved) {
                    openCatalogModal();
                }
            }
        };

        button.onmousedown = (e) => {
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            initialX = button.offsetLeft;
            initialY = button.offsetTop;
            button.classList.add('dragging');
            e.preventDefault();

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };

        document.body.appendChild(button);
    }

    function createModal() {
        injectStyles();

        const overlay = document.createElement('div');
        overlay.id = 'tilda-catalog-overlay';
        overlay.className = 'ocx ocx-overlay';
        overlay.style.display = 'none';
        overlay.onclick = (e) => {
            if (e.target === overlay) closeCatalogModal();
        };

        const modal = document.createElement('div');
        modal.id = 'tilda-catalog-modal';
        modal.className = 'ocx-modal';

        modal.innerHTML = `
            <div class="ocx-head">
                <div>
                    <h2 class="ocx-head__title">Каталог Orange</h2>
                    <p class="ocx-head__sub" id="catalog-head-sub">Выберите букеты для отправки в чат</p>
                </div>
                <button id="close-modal-btn" class="ocx-iconbtn" title="Закрыть">${ICONS.close}</button>
            </div>

            <div class="ocx-filters">
                <input type="text" id="filter-search" class="ocx-field ocx-field--search" placeholder="Поиск по названию">
                <input type="number" id="filter-price-min" class="ocx-field ocx-field--num" placeholder="Цена от">
                <input type="number" id="filter-price-max" class="ocx-field ocx-field--num" placeholder="Цена до">
                <select id="filter-site-part" class="ocx-field ocx-field--select">
                    <option value="">Все категории сайта</option>
                </select>
                <label class="ocx-check">
                    <input type="checkbox" id="filter-in-stock">
                    Только в наличии
                </label>
                <div class="ocx-filters__right">
                    <button id="reset-filter-btn" class="ocx-btn ocx-btn--quiet">Сбросить</button>
                    <div class="ocx-menu-wrap">
                        <button id="custom-category-btn" class="ocx-btn ocx-btn--ghost">
                            ${ICONS.folder}<span>Мои категории</span>${ICONS.chevron}
                        </button>
                        <div id="custom-category-dropdown" class="ocx-menu"></div>
                    </div>
                </div>
            </div>

            <div class="ocx-summary" id="filter-summary"></div>

            <div class="ocx-body">
                <div class="ocx-grid" id="tilda-gallery"></div>
            </div>

            <div class="ocx-foot">
                <div class="ocx-foot__count" id="selected-count">Ничего не выбрано</div>
                <div class="ocx-foot__actions">
                    <button id="cancel-btn" class="ocx-btn ocx-btn--ghost">Отмена</button>
                    <button id="send-selected-btn" class="ocx-btn ocx-btn--primary">Отправить в чат</button>
                </div>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('close-modal-btn').onclick = closeCatalogModal;
        document.getElementById('cancel-btn').onclick = closeCatalogModal;
        document.getElementById('send-selected-btn').onclick = sendSelectedProducts;
        document.getElementById('reset-filter-btn').onclick = resetFilters;
        document.getElementById('filter-search').oninput = applyFilters;
        document.getElementById('filter-price-min').oninput = applyFilters;
        document.getElementById('filter-price-max').oninput = applyFilters;
        document.getElementById('filter-site-part').onchange = applyFilters;
        document.getElementById('filter-in-stock').onchange = applyFilters;
        document.getElementById('custom-category-btn').onclick = toggleCustomCategoryDropdown;

        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('custom-category-dropdown');
            const button = document.getElementById('custom-category-btn');
            if (dropdown && button && !dropdown.contains(e.target) && !button.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });
    }

    function renderGallery(products) {
        const gallery = document.getElementById('tilda-gallery');
        gallery.innerHTML = '';

        if (products.length === 0) {
            gallery.innerHTML = '<div class="ocx-empty">Ничего не найдено - попробуйте изменить фильтры</div>';
            return;
        }

        products.forEach(product => {
            const outOfStock = product.inStock === false;
            const picked = selectedProducts.has(product.id);

            // Варианты («Как на фото», «Роскошный» и т.д.) - подсказкой при наведении на цену
            const editionsHint = escapeAttr((product.editions || [])
                .map(e => `${e.name}: ${formatPrice(e.price)}${e.quantity > 0 ? '' : ' (нет в наличии)'}`)
                .join('\n'));

            const card = document.createElement('div');
            card.className = `ocx-card${picked ? ' is-picked' : ''}${outOfStock ? ' is-out' : ''}`;
            card.innerHTML = `
                <div class="ocx-card__media">
                    <img src="${escapeAttr(product.image)}" alt="" loading="lazy">
                    ${outOfStock ? '<div class="ocx-badge">Нет в наличии</div>' : ''}
                    <div class="ocx-card__pick">${ICONS.check}</div>
                </div>
                <div class="ocx-card__body">
                    <h3 class="ocx-card__title">${product.title}</h3>
                    <div class="ocx-price" title="${editionsHint}">
                        <span class="ocx-price__now${product.price > 0 ? '' : ' ocx-price__now--ask'}">${formatPrice(product.price)}</span>
                        ${product.oldPrice > product.price ? `<span class="ocx-price__old">${product.oldPrice.toLocaleString('ru-RU')} ₽</span>` : ''}
                    </div>
                    <p class="ocx-card__descr">${product.description || ''}</p>
                </div>
            `;

            card.onclick = () => {
                const isPicked = card.classList.toggle('is-picked');
                toggleProductSelection(product.id, isPicked);
            };

            gallery.appendChild(card);
        });
    }

    function toggleProductSelection(productId, isSelected) {
        if (isSelected) {
            selectedProducts.add(productId);
        } else {
            selectedProducts.delete(productId);
        }
        updateSelectedCount();
    }

    function updateSelectedCount() {
        const countEl = document.getElementById('selected-count');
        if (!countEl) return;

        countEl.textContent = selectedProducts.size === 0
            ? 'Ничего не выбрано'
            : `Выбрано ${selectedProducts.size} ${pluralize(selectedProducts.size, 'букет', 'букета', 'букетов')}`;

        const sendBtn = document.getElementById('send-selected-btn');
        if (sendBtn) sendBtn.disabled = selectedProducts.size === 0;
    }
    
    function pluralize(count, one, few, many) {
        const mod10 = count % 10;
        const mod100 = count % 100;
        
        if (mod10 === 1 && mod100 !== 11) {
            return one;
        } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
            return few;
        } else {
            return many;
        }
    }

    function toggleCustomCategoryDropdown() {
        const dropdown = document.getElementById('custom-category-dropdown');
        const button = document.getElementById('custom-category-btn');
        if (!dropdown || !button) return;

        if (dropdown.style.display === 'block') {
            dropdown.style.display = 'none';
            return;
        }

        renderCustomCategoryDropdown();

        // Прижимаем меню к тому краю кнопки, с которого оно помещается в окно
        const modal = document.getElementById('tilda-catalog-modal');
        const limit = modal ? modal.getBoundingClientRect().right - 12 : window.innerWidth - 12;
        const fitsLeft = button.getBoundingClientRect().left + 320 <= limit;
        dropdown.style.left = fitsLeft ? '0' : 'auto';
        dropdown.style.right = fitsLeft ? 'auto' : '0';

        dropdown.style.display = 'block';
    }

    function renderCustomCategoryDropdown() {
        const dropdown = document.getElementById('custom-category-dropdown');
        if (!dropdown) return;

        loadCustomCategories();
        dropdown.innerHTML = '';

        if (customCategories.length > 0) {
            customCategories.forEach((cat, index) => {
                // Категории, собранные до версии 9.8.1, хранят старые порядковые id и уже не находятся
                const catIds = cat.productIds.map(String);
                const found = productsCache.filter(p => catIds.includes(String(p.id))).length;
                const inStock = productsCache.filter(p => catIds.includes(String(p.id)) && p.inStock !== false).length;

                const item = document.createElement('div');
                item.className = 'ocx-menu__item';
                item.innerHTML = `
                    <div class="ocx-menu__info">
                        <div class="ocx-menu__name">${cat.name}</div>
                        <div class="ocx-menu__meta${found === 0 ? ' ocx-menu__meta--warn' : ''}">${
                            found === 0
                                ? 'Товары не найдены - пересоберите категорию'
                                : `${found} из ${cat.productIds.length}, в наличии ${inStock}`
                        }</div>
                    </div>
                    <button class="ocx-mini" data-act="edit" title="Изменить">${ICONS.pencil}</button>
                    <button class="ocx-mini ocx-mini--danger" data-act="delete" title="Удалить">${ICONS.trash}</button>
                `;

                item.querySelector('.ocx-menu__info').onclick = () => loadCategoryProducts(index);
                item.querySelector('[data-act="edit"]').onclick = (e) => { e.stopPropagation(); editCategory(index); };
                item.querySelector('[data-act="delete"]').onclick = (e) => { e.stopPropagation(); deleteCategory(index); };

                dropdown.appendChild(item);
            });

            const sep = document.createElement('div');
            sep.className = 'ocx-menu__sep';
            dropdown.appendChild(sep);
        } else {
            const empty = document.createElement('div');
            empty.className = 'ocx-menu__empty';
            empty.textContent = 'Своих категорий пока нет';
            dropdown.appendChild(empty);
        }

        const actions = [
            { icon: ICONS.plus, label: 'Создать категорию', accent: true, handler: () => openCategoryEditor() },
            { icon: ICONS.download, label: 'Экспортировать в файл', handler: exportCategories },
            { icon: ICONS.upload, label: 'Импортировать из файла', handler: importCategories },
            { icon: ICONS.refresh, label: 'Обновить каталог', handler: refreshCatalog }
        ];

        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = `ocx-menu__action${action.accent ? ' ocx-menu__action--accent' : ''}`;
            btn.innerHTML = `${action.icon}<span>${action.label}</span>`;
            btn.onclick = (e) => { e.stopPropagation(); action.handler(); };
            dropdown.appendChild(btn);
        });
    }

    function loadCategoryProducts(index) {
        const category = customCategories[index];
        if (!category) return;

        activeCustomCategory = index;
        applyFilters();

        const dropdown = document.getElementById('custom-category-dropdown');
        if (dropdown) dropdown.style.display = 'none';

        const found = productsCache.filter(p => category.productIds.map(String).includes(String(p.id))).length;
        if (found === 0) {
            showNotification(`В категории «${category.name}» не найден ни один товар - похоже, она собрана в старой версии скрипта, пересоберите её`, 'error');
        } else {
            showNotification(`Категория «${category.name}»: ${found} ${pluralize(found, 'товар', 'товара', 'товаров')}`, 'info');
        }
    }

    function editCategory(index) {
        openCategoryEditor(index);
    }

    function deleteCategory(index) {
        const category = customCategories[index];
        if (confirm(`Удалить категорию "${category.name}"?`)) {
            customCategories.splice(index, 1);
            saveCustomCategories();
            renderCustomCategoryDropdown();
            showNotification('Категория удалена', 'success');
        }
    }
    
    function exportCategories() {
        if (customCategories.length === 0) {
            alert('Нет категорий для экспорта');
            return;
        }
        
        const dataStr = JSON.stringify(customCategories, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = `orange_categories_${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        
        URL.revokeObjectURL(url);
        showNotification('Категории экспортированы', 'success');
    }
    
    function importCategories() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);
                    
                    if (!Array.isArray(imported)) {
                        throw new Error('Неверный формат файла');
                    }
                    
                    const existingNames = customCategories.map(c => c.name.toLowerCase());
                    let addedCount = 0;
                    let skippedCount = 0;
                    
                    imported.forEach(cat => {
                        if (cat.name && cat.productIds && Array.isArray(cat.productIds)) {
                            if (!existingNames.includes(cat.name.toLowerCase())) {
                                customCategories.push(cat);
                                existingNames.push(cat.name.toLowerCase());
                                addedCount++;
                            } else {
                                skippedCount++;
                            }
                        }
                    });
                    
                    saveCustomCategories();
                    renderCustomCategoryDropdown();
                    
                    showNotification(
                        `✅ Импорт завершен! Добавлено: ${addedCount}, пропущено дублей: ${skippedCount}`,
                        'success'
                    );
                } catch (error) {
                    alert('Ошибка импорта: ' + error.message);
                }
            };
            
            reader.readAsText(file);
        };
        
        input.click();
    }
    
    async function refreshCatalog() {
        if (!confirm('Обновить каталог товаров с сайта?\n\nТекущий кэш будет очищен и загружены актуальные цены и остатки.')) {
            return;
        }

        showNotification('Обновление каталога...', 'info');

        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(CACHE_TS_KEY);

        try {
            const { products, parts } = await loadTildaCatalog();

            if (products && products.length > 0) {
                productsCache = products;
                if (parts && parts.length) sitePartsCache = parts;
                saveCatalogToCache(products, sitePartsCache);

                renderSitePartsFilter();
                applyFilters();

                const dropdown = document.getElementById('custom-category-dropdown');
                if (dropdown) dropdown.style.display = 'none';

                showNotification(`Каталог обновлён: ${products.length} ${pluralize(products.length, 'товар', 'товара', 'товаров')}, в наличии ${products.filter(p => p.inStock).length}`, 'success');
            } else {
                showNotification('Не удалось загрузить товары', 'error');
            }
        } catch (error) {
            console.error('Ошибка обновления каталога:', error);
            showNotification('Ошибка обновления: '+ error.message, 'error');
        }
    }

    function applyFilters() {
        const searchText = document.getElementById('filter-search')?.value.toLowerCase() || '';
        const priceMin = parseFloat(document.getElementById('filter-price-min')?.value) || 0;
        const priceMax = parseFloat(document.getElementById('filter-price-max')?.value) || Infinity;
        const sitePart = document.getElementById('filter-site-part')?.value || '';
        const onlyInStock = document.getElementById('filter-in-stock')?.checked || false;

        // «Моя категория» - это ещё один фильтр, а не отдельный режим показа
        let allowedIds = null;
        if (activeCustomCategory !== null && customCategories[activeCustomCategory]) {
            allowedIds = customCategories[activeCustomCategory].productIds.map(String);
        }

        const filtered = productsCache.filter(p => {
            const matchesSearch = p.title.toLowerCase().includes(searchText);
            const matchesPrice = p.price >= priceMin && p.price <= priceMax;
            const matchesPart = !sitePart || (p.parts || []).includes(sitePart);
            const matchesStock = !onlyInStock || p.inStock !== false;
            const matchesCustom = !allowedIds || allowedIds.includes(String(p.id));

            return matchesSearch && matchesPrice && matchesPart && matchesStock && matchesCustom;
        });

        renderGallery(filtered);
        renderFilterSummary(filtered.length);
    }

    // Строка-подсказка под фильтрами: что именно сейчас показано
    function renderFilterSummary(shownCount) {
        const el = document.getElementById('filter-summary');
        if (!el) return;

        const parts = [`Показано ${shownCount} из ${productsCache.length}`];
        if (activeCustomCategory !== null && customCategories[activeCustomCategory]) {
            const cat = customCategories[activeCustomCategory];
            parts.push(`категория «${cat.name}»`);
            const missing = cat.productIds.length - shownCount;
            if (missing > 0) parts.push(`${missing} ${pluralize(missing, 'товар не найден', 'товара не найдено', 'товаров не найдено')} в каталоге`);
        }
        el.textContent = parts.join(' · ');
    }

    // Список категорий сайта в выпадающем фильтре
    function renderSitePartsFilter() {
        const select = document.getElementById('filter-site-part');
        if (!select) return;

        const current = select.value;
        select.innerHTML = '<option value="">Все категории сайта</option>';

        if (!sitePartsCache.length) {
            select.style.display = 'none';
            return;
        }
        select.style.display = '';

        const counts = {};
        productsCache.forEach(p => (p.parts || []).forEach(uid => {
            counts[uid] = (counts[uid] || 0) + 1;
        }));

        sitePartsCache
            .map(part => ({ uid: String(part.uid), title: part.title || '', sort: part.sort || 0 }))
            .filter(part => counts[part.uid])
            .sort((a, b) => a.sort - b.sort)
            .forEach(part => {
                const option = document.createElement('option');
                option.value = part.uid;
                option.textContent = `${part.title} (${counts[part.uid]})`;
                select.appendChild(option);
            });

        select.value = current;
    }

    function resetFilters() {
        document.getElementById('filter-search').value = '';
        document.getElementById('filter-price-min').value = '';
        document.getElementById('filter-price-max').value = '';
        document.getElementById('filter-site-part').value = '';
        document.getElementById('filter-in-stock').checked = false;
        activeCustomCategory = null;

        applyFilters();
    }

    function openCatalogModal() {
        let overlay = document.getElementById('tilda-catalog-overlay');

        if (!overlay) {
            createModal();
            overlay = document.getElementById('tilda-catalog-overlay');
        }

        overlay.style.display = 'block';
        selectedProducts.clear();
        activeCustomCategory = null;
        updateSelectedCount();
        loadCustomCategories();
        renderSitePartsFilter();
        resetFilters();

        // Кэш устарел - тихо обновляем цены и остатки, не заставляя менеджера ждать
        if (!getCachedCatalog()) {
            loadTildaCatalog().then(({ products, parts }) => {
                if (!products || !products.length) return;
                productsCache = products;
                if (parts && parts.length) sitePartsCache = parts;
                saveCatalogToCache(products, sitePartsCache);
                renderSitePartsFilter();
                applyFilters();
                console.log('♻️ Каталог обновлён в фоне');
            }).catch(error => console.error('Фоновое обновление не удалось:', error));
        }
    }

    function closeCatalogModal() {
        const overlay = document.getElementById('tilda-catalog-overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
        selectedProducts.clear();
    }

    async function sendSelectedProducts() {
        if (selectedProducts.size === 0) {
            alert('Выберите хотя бы один товар');
            return;
        }

        const chatOpened = isChatOpened();
        if (!chatOpened) {
            showNotification('Откройте чат в сделке перед отправкой', 'error');
            return;
        }

        const selectedItems = productsCache.filter(p => selectedProducts.has(p.id));

        const outOfStock = selectedItems.filter(p => p.inStock === false);
        if (outOfStock.length > 0) {
            const names = outOfStock.map(p => `• ${p.title}`).join('\n');
            if (!confirm(`Этих букетов сейчас нет в наличии на сайте:\n\n${names}\n\nВсё равно отправить клиенту?`)) {
                return;
            }
        }

        showNotification(`Отправка ${selectedItems.length} товаров...`, 'info');
        closeCatalogModal();

        try {
            for (let i = 0; i < selectedItems.length; i++) {
                const product = selectedItems[i];
                showNotification(`Отправка ${i + 1} из ${selectedItems.length}: ${product.title}`, 'info');
                await sendProductToChat(product);
                
                if (i < selectedItems.length - 1) {
                    console.log('Ждем перед отправкой следующего товара...');
                    await sleep(1500);
                }
            }
            showNotification('Букеты отправлены в чат', 'success');
        } catch (error) {
            console.error('Ошибка отправки:', error);
            showNotification('Ошибка: '+ error.message, 'error');
        }
    }

    function isChatOpened() {
        console.log('🔍 Проверяем наличие чата...');
        
        const chatInput = findChatMessageInput();
        const sendButton = findChatSendButton();
        const attachButton = findAttachButton();
        
        console.log('Результаты поиска:', {
            chatInput: chatInput ? 'найден' : 'НЕ найден',
            sendButton: sendButton ? 'найдена' : 'НЕ найдена',
            attachButton: attachButton ? 'найдена' : 'НЕ найдена'
        });
        
        if (chatInput && (sendButton || attachButton)) {
            console.log('✅ Чат найден: есть поле ввода и кнопки');
            return true;
        }

        const chatSelectors = [
            '.feed-compose',
            '.feed-amojo_actions',
            '.widget_talks__wrapper',
            '[data-entity="talks"]',
            '.messenger-wrapper',
            '.talks-block',
            '.talks__wrapper',
            '.messenger__wrapper',
            'div[class*="talks"]',
            'div[class*="messenger"]',
            'div[class*="feed-compose"]'
        ];

        for (const selector of chatSelectors) {
            const chat = document.querySelector(selector);
            if (chat && chat.offsetParent !== null) {
                const visibleInput = chat.querySelector('textarea, input[type="text"], [contenteditable="true"]');
                if (visibleInput && visibleInput.offsetParent !== null) {
                    console.log('✅ Чат найден через селектор:', selector);
                    return true;
                }
            }
        }
        
        console.log('❌ Чат не найден. Попробуйте открыть чат вручную в сделке.');
        return false;
    }

    async function sendProductToChat(product) {
        console.log('Начинаем отправку товара:', product.title);

        console.log('Скачиваем изображение...');
        const imageBlob = await downloadImage(product.image);
        console.log('Изображение скачано, размер:', imageBlob.size);

        console.log('Наносим текст на изображение...');
        const imageWithText = await addTextToImage(imageBlob, product);
        console.log('Текст нанесен на изображение');

        const fileInput = findChatFileInput();
        if (!fileInput) {
            throw new Error('Не найден input для загрузки файлов');
        }

        console.log('Найден file input');

        const fileName = `${product.title.replace(/[^a-zа-я0-9]/gi, '_')}.jpg`;
        const file = new File([imageWithText], fileName, { type: 'image/jpeg' });

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;

        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));

        console.log('Файл загружен, ждем обработки...');
        await sleep(1200);

        const sendButton = findChatSendButton();
        if (sendButton && sendButton.offsetParent !== null) {
            console.log('Нажимаем кнопку отправки');
            sendButton.click();
            await sleep(500);
        } else {
            const messageInput = findChatMessageInput();
            if (messageInput) {
                console.log('Отправляем через Enter');
                const enterEvent = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true
                });
                messageInput.dispatchEvent(enterEvent);
                await sleep(500);
            }
        }

        console.log('Товар отправлен:', product.title);
    }

    function downloadImage(url) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(response.response);
                    } else {
                        reject(new Error(`Ошибка загрузки: ${response.status}`));
                    }
                },
                onerror: function() {
                    reject(new Error('Ошибка соединения'));
                }
            });
        });
    }

    async function addTextToImage(imageBlob, product) {
        // Ждём шрифт, иначе canvas нарисует надпись системным
        try { await document.fonts.ready; } catch (error) { /* не критично */ }

        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(imageBlob);
            
            img.onload = function() {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                canvas.width = img.width;
                canvas.height = img.height;
                
                ctx.drawImage(img, 0, 0);
                
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                
                const titleFontSize = Math.max(Math.floor(img.width / 25), 20);
                const priceFontSize = Math.max(Math.floor(img.width / 16), 28);
                const deliveryFontSize = Math.max(Math.floor(img.width / 30), 16);
                const padding = Math.floor(titleFontSize * 0.8);
                
                const title = product.title.toUpperCase();
                const price = product.price > 0 ? `${product.price.toLocaleString('ru-RU')} ₽` : 'ЦЕНА ПО ЗАПРОСУ';
                const delivery = '+ БЕСПЛАТНАЯ ДОСТАВКА';
                
                ctx.fillStyle = '#FFFFFF';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                
                ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
                ctx.shadowBlur = 8;
                ctx.shadowOffsetX = 2;
                ctx.shadowOffsetY = 2;
                
                const titleX = padding;
                const deliveryY = img.height - padding;
                const priceY = deliveryY - deliveryFontSize - padding * 0.6;
                const titleY = priceY - priceFontSize - padding * 0.6;
                
                ctx.font = `700 ${titleFontSize}px Manrope, Arial, Helvetica, sans-serif`;
                ctx.fillText(title, titleX, titleY);

                ctx.font = `700 ${priceFontSize}px Manrope, Arial, Helvetica, sans-serif`;
                ctx.fillText(price, titleX, priceY);

                ctx.font = `700 ${deliveryFontSize}px Manrope, Arial, Helvetica, sans-serif`;
                ctx.fillText(delivery, titleX, deliveryY);
                
                URL.revokeObjectURL(url);
                
                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Не удалось создать изображение с текстом'));
                    }
                }, 'image/jpeg', 0.95);
            };
            
            img.onerror = function() {
                URL.revokeObjectURL(url);
                reject(new Error('Не удалось загрузить изображение для обработки'));
            };
            
            img.src = url;
        });
    }

    function findAttachButton() {
        const selectors = [
            'label.feed-amojo_actions-attach',
            'label.js-amojo-attach',
            'label[for*="attach"]',
            'button[title*="рикрепить"]',
            'button[title*="файл"]',
            'button.messenger-file-attach',
            '.talks button[data-type="file"]',
            'button.talks__file-attach',
            '.messenger__attach-button',
            'button[aria-label*="файл"]',
            'button[aria-label*="прикрепить"]'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                if (element.offsetParent !== null) {
                    return element;
                }
            }
        }

        const chatContainers = document.querySelectorAll('.talks, .messenger, .talks__wrapper, .messenger__wrapper, [data-entity="talks"], .feed-compose');
        for (const container of chatContainers) {
            if (container.offsetParent !== null) {
                const buttons = container.querySelectorAll('button, label');
                for (const button of buttons) {
                    if (button.offsetParent !== null && button.querySelector('svg')) {
                        const title = button.getAttribute('title') || '';
                        const ariaLabel = button.getAttribute('aria-label') || '';
                        const forAttr = button.getAttribute('for') || '';
                        if (title.includes('файл') || title.includes('рикреп') || ariaLabel.includes('файл') || ariaLabel.includes('рикреп') || forAttr.includes('attach')) {
                            return button;
                        }
                    }
                }
            }
        }

        return null;
    }

    function findChatFileInput() {
        const selectors = [
            'input#note-edit-attach-filenew',
            'input[id*="attach"]',
            'input[name="UserFile"]',
            'input[type="file"]',
            '.talks input[type="file"]',
            '[data-entity="talks"] input[type="file"]',
            '.messenger input[type="file"]',
            '.feed-compose input[type="file"]'
        ];

        for (const selector of selectors) {
            const inputs = document.querySelectorAll(selector);
            for (const input of inputs) {
                return input;
            }
        }

        return null;
    }

    function findChatMessageInput() {
        const selectors = [
            'textarea[name="NOTE[PARAMS][TEXT]"]',
            'textarea.feed-compose__message',
            'textarea.note-edit-message',
            'textarea.talks__message-input',
            '.talks textarea',
            '[data-entity="talks"] textarea',
            '.messenger textarea',
            '.talks__wrapper textarea',
            '.messenger__wrapper textarea',
            '.feed-compose textarea',
            'textarea[placeholder*="сообщение"]',
            'textarea[placeholder*="Сообщение"]',
            'textarea[placeholder*="введите"]',
            'div[contenteditable="true"]',
            '[contenteditable="true"][role="textbox"]'
        ];

        for (const selector of selectors) {
            const inputs = document.querySelectorAll(selector);
            for (const input of inputs) {
                if (input.offsetParent !== null || input.contentEditable === 'true') {
                    return input;
                }
            }
        }

        return null;
    }

    function findChatSendButton() {
        const selectors = [
            'button.button-input-submit',
            'button.feed-compose__send',
            'button[type="submit"].talks__send',
            '.talks button[type="submit"]',
            'button.messenger-send',
            '.talks__send-button',
            '.feed-compose button[type="submit"]',
            'button.js-feed-compose-submit'
        ];

        for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button && button.offsetParent !== null) {
                return button;
            }
        }

        return null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function loadCustomCategories() {
        try {
            const saved = localStorage.getItem('orange_custom_categories');
            if (saved) {
                customCategories = JSON.parse(saved);
            }
        } catch (error) {
            console.error('Ошибка загрузки категорий:', error);
            customCategories = [];
        }
    }

    function saveCustomCategories() {
        try {
            localStorage.setItem('orange_custom_categories', JSON.stringify(customCategories));
        } catch (error) {
            console.error('Ошибка сохранения категорий:', error);
        }
    }

    function openCategoryEditor(editIndex = null) {
        injectStyles();
        currentCategoryEdit = editIndex;

        const isEdit = editIndex !== null;
        const category = isEdit ? customCategories[editIndex] : null;

        const editorOverlay = document.createElement('div');
        editorOverlay.id = 'category-editor-overlay';
        editorOverlay.className = 'ocx ocx-overlay';
        editorOverlay.style.zIndex = '10003';

        const editor = document.createElement('div');
        editor.className = 'ocx-editor';

        editor.innerHTML = `
            <div class="ocx-head">
                <div>
                    <h2 class="ocx-head__title">${isEdit ? 'Изменение категории' : 'Новая категория'}</h2>
                    <p class="ocx-head__sub">Своя подборка букетов для быстрой отправки</p>
                </div>
                <button id="category-close-btn" class="ocx-iconbtn" title="Закрыть">${ICONS.close}</button>
            </div>

            <div class="ocx-filters">
                <input type="text" id="category-name-input" class="ocx-field ocx-field--search"
                    value="${escapeAttr(isEdit ? category.name : '')}" placeholder="Название категории">
                <input type="text" id="category-product-search" class="ocx-field ocx-field--search" placeholder="Поиск букета">
                <span class="ocx-foot__count" id="category-picked-count"></span>
            </div>

            <div class="ocx-body">
                <div class="ocx-pickgrid" id="category-products-grid"></div>
            </div>

            <div class="ocx-foot">
                <div class="ocx-foot__count">Нажимайте на карточки, чтобы добавить их в категорию</div>
                <div class="ocx-foot__actions">
                    <button id="category-cancel-btn" class="ocx-btn ocx-btn--ghost">Отмена</button>
                    <button id="category-save-btn" class="ocx-btn ocx-btn--primary">Сохранить</button>
                </div>
            </div>
        `;

        editorOverlay.appendChild(editor);
        document.body.appendChild(editorOverlay);

        document.getElementById('category-close-btn').onclick = () => editorOverlay.remove();

        const selectedProductIds = isEdit ? new Set((category.productIds || []).map(String)) : new Set();
        
        function renderProductGrid(searchText = '') {
            const grid = document.getElementById('category-products-grid');
            const query = searchText.toLowerCase();
            const filtered = productsCache.filter(p => p.title.toLowerCase().includes(query));

            const counter = document.getElementById('category-picked-count');
            if (counter) {
                counter.textContent = selectedProductIds.size === 0
                    ? 'Ничего не выбрано'
                    : `Выбрано ${selectedProductIds.size} ${pluralize(selectedProductIds.size, 'букет', 'букета', 'букетов')}`;
            }

            if (!filtered.length) {
                grid.innerHTML = '<div class="ocx-empty">Ничего не найдено</div>';
                return;
            }

            grid.innerHTML = filtered.map(p => `
                <div class="ocx-pick${selectedProductIds.has(String(p.id)) ? ' is-picked' : ''}${p.inStock === false ? ' is-out' : ''}" data-product-id="${p.id}">
                    <div class="ocx-pick__media">
                        <img src="${escapeAttr(p.image)}" alt="" loading="lazy">
                        <div class="ocx-pick__mark">${ICONS.check}</div>
                    </div>
                    <div class="ocx-pick__body">
                        <div class="ocx-pick__title">${p.title}</div>
                        <div class="ocx-pick__price">${formatPrice(p.price)}${p.inStock === false ? ' <span>· нет в наличии</span>' : ''}</div>
                    </div>
                </div>
            `).join('');

            grid.querySelectorAll('[data-product-id]').forEach(card => {
                card.onclick = () => {
                    const productId = card.dataset.productId;  // Строковый ID, не парсим в число
                    if (selectedProductIds.has(productId)) {
                        selectedProductIds.delete(productId);
                    } else {
                        selectedProductIds.add(productId);
                    }
                    renderProductGrid(document.getElementById('category-product-search').value);
                };
            });
        }

        renderProductGrid();
        
        document.getElementById('category-product-search').oninput = (e) => {
            renderProductGrid(e.target.value);
        };
        
        document.getElementById('category-cancel-btn').onclick = () => {
            editorOverlay.remove();
        };
        
        document.getElementById('category-save-btn').onclick = () => {
            const name = document.getElementById('category-name-input').value.trim();
            
            if (!name) {
                alert('Введите название категории');
                return;
            }
            
            if (selectedProductIds.size === 0) {
                alert('Выберите хотя бы один товар');
                return;
            }
            
            const categoryData = {
                name: name,
                productIds: Array.from(selectedProductIds)
            };
            
            if (isEdit) {
                customCategories[editIndex] = categoryData;
                showNotification('Категория обновлена', 'success');
            } else {
                customCategories.push(categoryData);
                showNotification('Категория создана', 'success');
            }
            
            saveCustomCategories();
            editorOverlay.remove();
            renderCustomCategoryDropdown();
        };
        
        editorOverlay.onclick = (e) => {
            if (e.target === editorOverlay) {
                editorOverlay.remove();
            }
        };
    }

    function getStoreConfig() {
        try {
            return {
                recid: localStorage.getItem('orange_store_recid') || DEFAULT_STORE_RECID,
                part: localStorage.getItem('orange_store_part') || DEFAULT_STORE_PART
            };
        } catch (error) {
            return { recid: DEFAULT_STORE_RECID, part: DEFAULT_STORE_PART };
        }
    }

    function getCachedCatalog() {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            const timestamp = localStorage.getItem(CACHE_TS_KEY);

            if (cached && timestamp) {
                const age = Date.now() - parseInt(timestamp);

                if (age < CACHE_MAX_AGE) {
                    console.log(`Каталог загружен из кэша (возраст: ${Math.floor(age / 60000)} минут)`);
                    return JSON.parse(cached);
                }
                console.log('Кэш устарел, требуется обновление');
            }
        } catch (error) {
            console.error('Ошибка чтения кэша:', error);
        }
        return null;
    }

    function getCachedParts() {
        try {
            const cached = localStorage.getItem(PARTS_KEY);
            return cached ? JSON.parse(cached) : [];
        } catch (error) {
            return [];
        }
    }

    function saveCatalogToCache(products, parts) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(products));
            localStorage.setItem(CACHE_TS_KEY, Date.now().toString());
            if (parts && parts.length) {
                localStorage.setItem(PARTS_KEY, JSON.stringify(parts));
            }
            console.log(`Каталог сохранён в кэш (${products.length} товаров)`);
        } catch (error) {
            console.error('Ошибка сохранения кэша:', error);
        }
    }

    // Универсальный GET с разбором JSON через GM.xmlHttpRequest
    function requestJSON(url) {
        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'application/json, */*' },
                onload: function(response) {
                    if (response.status !== 200) {
                        reject(new Error(`Ошибка загрузки: ${response.status}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (error) {
                        reject(new Error('Ответ store-API не разобрался как JSON'));
                    }
                },
                onerror: function() { reject(new Error('Ошибка соединения со store-API')); },
                ontimeout: function() { reject(new Error('Таймаут запроса к store-API')); },
                timeout: 30000
            });
        });
    }

    // Экранирование для подстановки в HTML-атрибут (в названиях встречаются кавычки)
    function escapeAttr(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Часть позиций (оформление зала и т.п.) идёт без цены - показываем это словами
    function formatPrice(price) {
        return price > 0 ? `${price.toLocaleString('ru-RU')} ₽` : 'Цена по запросу';
    }

    function stripHtml(text) {
        return String(text || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Товар store-API -> внутренний формат каталога.
    // id совпадает с group_id старого YML-фида, поэтому «мои категории» продолжают работать.
    function mapStoreProduct(item) {
        let gallery = [];
        try {
            gallery = (JSON.parse(item.gallery || '[]') || []).map(g => g.img).filter(Boolean);
        } catch (error) {
            gallery = [];
        }

        let parts = [];
        try {
            parts = (JSON.parse(item.partuids || '[]') || []).map(String);
        } catch (error) {
            parts = [];
        }

        const editions = (item.editions || []).map(e => {
            const sizeKey = Object.keys(e).find(k => !['uid', 'externalid', 'sku', 'price', 'priceold', 'quantity', 'img'].includes(k));
            return {
                name: sizeKey ? String(e[sizeKey]) : '',
                price: parseFloat(String(e.price).replace(/\s/g, '')) || 0,
                quantity: parseInt(e.quantity) || 0
            };
        });

        const quantity = parseInt(item.quantity);
        const description = stripHtml(item.text) || stripHtml(item.descr);

        return {
            id: String(item.uid),
            title: String(item.title || '').trim(),
            price: parseFloat(item.price) || 0,
            oldPrice: parseFloat(item.priceold) || 0,
            image: gallery[0] || '',
            gallery: gallery,
            description: description.substring(0, 200),
            url: item.url || '',
            quantity: isNaN(quantity) ? 0 : quantity,
            inStock: !isNaN(quantity) && quantity > 0,
            parts: parts,
            editions: editions,
            category: 'Каталог Orange'
        };
    }

    // Забираем весь каталог из store-API страницами (как это делает сам сайт)
    async function loadStoreCatalog() {
        const cfg = getStoreConfig();
        const products = [];
        let parts = [];
        let total = null;
        let slice = 1;

        while (slice <= 30) {
            const url = `${STORE_API_URL}?storepartuid=${cfg.part}&recid=${cfg.recid}` +
                        `&c=${Date.now()}&size=${STORE_PAGE_SIZE}&slice=${slice}` +
                        (slice === 1 ? '&getparts=true' : '');

            console.log(`🔄 store-API, страница ${slice}...`);
            const data = await requestJSON(url);

            if (slice === 1) {
                total = parseInt(data.total) || 0;
                parts = (data.parts || []).filter(part => !part.hideonpublic);
            }

            const page = data.products || [];
            page.forEach(item => products.push(mapStoreProduct(item)));

            if (!page.length || (total && products.length >= total)) break;
            slice++;
        }

        if (!products.length) {
            throw new Error('store-API вернул пустой каталог');
        }

        console.log(`✅ Загружено ${products.length} товаров из store-API (в наличии: ${products.filter(p => p.inStock).length})`);

        // Товары в наличии - первыми, дальше по названию
        products.sort((a, b) => {
            if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
            return a.title.localeCompare(b.title, 'ru');
        });

        return { products, parts };
    }

    function loadYMLFeed() {
        return new Promise((resolve, reject) => {
            const feedUrl = getFeedUrl();
            console.log('🔄 Загружаем YML-фид:', feedUrl);

            GM.xmlHttpRequest({
                method: 'GET',
                url: feedUrl,
                headers: {
                    'Accept': 'application/xml, text/xml, */*'
                },
                onload: function(response) {
                    console.log('📥 Ответ сервера:', response.status, response.statusText);

                    if (response.status === 200) {
                        try {
                            const text = response.responseText;
                            if (!text || text.trim().length === 0) {
                                reject(new Error('Получен пустой ответ от сервера'));
                                return;
                            }

                            const products = parseYMLProducts(text);
                            if (products.length > 0) {
                                console.log(`✅ Загружено ${products.length} товаров из YML`);
                                resolve(products);
                            } else {
                                reject(new Error('YML не содержит товаров'));
                            }
                        } catch (error) {
                            console.error('❌ Ошибка парсинга:', error);
                            reject(new Error('Ошибка парсинга YML: ' + error.message));
                        }
                    } else if (response.status === 404) {
                        reject(new Error('Фид не найден (404). Проверьте правильность URL.'));
                    } else {
                        reject(new Error(`Ошибка загрузки: ${response.status}`));
                    }
                },
                onerror: function() {
                    reject(new Error('Ошибка соединения'));
                },
                timeout: 30000
            });
        });
    }

    function parseYMLProducts(xmlText) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
        
        const parserError = xmlDoc.querySelector('parsererror');
        if (parserError) {
            throw new Error('Ошибка парсинга XML: ' + parserError.textContent);
        }
        
        const offers = xmlDoc.querySelectorAll('offer');
        const groupedProducts = new Map();
        
        console.log(`Найдено ${offers.length} товаров в YML`);
        
        offers.forEach((offer) => {
            try {
                const nameEl = offer.querySelector('name');
                const vendorCodeEl = offer.querySelector('vendorCode');  // Короткое название товара
                const priceEl = offer.querySelector('price');
                const pictureEl = offer.querySelector('picture');
                const descriptionEl = offer.querySelector('description');
                const urlEl = offer.querySelector('url');

                if (nameEl && priceEl) {
                    const groupId = offer.getAttribute('group_id');
                    // Берём название из vendorCode (короткое), если нет - из name
                    const rawTitle = (vendorCodeEl && vendorCodeEl.textContent.trim()) || nameEl.textContent.trim();
                    const price = parseFloat(priceEl.textContent) || 0;
                    const image = pictureEl ? pictureEl.textContent.trim() : '';
                    const description = descriptionEl ? descriptionEl.textContent.trim().replace(/<[^>]+>/g, '').substring(0, 200) : rawTitle;
                    const url = urlEl ? urlEl.textContent.trim() : '';
                    
                    const cleanTitle = cleanProductTitle(rawTitle);
                    const isBaseVersion = rawTitle.toLowerCase().includes('как на фото');
                    
                    if (groupId) {
                        if (!groupedProducts.has(groupId)) {
                            groupedProducts.set(groupId, {
                                title: cleanTitle,
                                price: price,
                                image: image,
                                description: description,
                                url: url,
                                category: 'Каталог Orange',
                                isBase: isBaseVersion
                            });
                        } else {
                            const existing = groupedProducts.get(groupId);
                            
                            if (isBaseVersion) {
                                existing.title = cleanTitle;
                                existing.price = price;
                                existing.image = image;
                                existing.description = description;
                                existing.url = url;
                                existing.isBase = true;
                            }
                        }
                    } else {
                        const offerId = offer.getAttribute('id');
                        const uniqueKey = offerId || `no_group_${cleanTitle}_${price}`;
                        
                        if (!groupedProducts.has(uniqueKey)) {
                            groupedProducts.set(uniqueKey, {
                                title: cleanTitle,
                        price: price,
                        image: image,
                                description: description,
                                url: url,
                                category: 'Каталог Orange',
                                isBase: true
                            });
                        }
                    }
                }
            } catch (error) {
                console.warn('Ошибка парсинга товара:', error);
            }
        });
        
        // Используем стабильные ID из YML (group_id или offer_id) вместо индекса
        const products = Array.from(groupedProducts.entries()).map(([key, product]) => ({
            id: key,  // Стабильный ID из YML-фида (совпадает с uid товара в store-API)
            title: product.title,
            price: product.price,
            oldPrice: 0,
            image: product.image,
            gallery: product.image ? [product.image] : [],
            description: product.description,
            url: product.url,
            quantity: 0,
            inStock: true,      // YML отдаёт только то, что в наличии
            parts: [],
            editions: [],
            category: product.category
        }));

        console.log(`После удаления дублей осталось ${products.length} товаров`);

        // Сортируем по названию для стабильного порядка отображения
        return products.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    }
    
    function cleanProductTitle(title) {
        let cleanTitle = title;

        // Убираем "Как на фото" в разных форматах (с дефисом, слэшем или без)
        cleanTitle = cleanTitle.replace(/\s*[\/\-]\s*Как на фото\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*Как на фото\s*/gi, '');

        cleanTitle = cleanTitle.replace(/\s*-?\s*Роскошный\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-?\s*VIP\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-?\s*Вы наш герой\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-\s*Роскошный\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-\s*VIP\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');

        cleanTitle = cleanTitle.trim();

        return cleanTitle;
    }

    // Основной источник - store-API. YML-фид остаётся резервом: он не отдаёт распроданные
    // товары и цены вариантов вместо цены карточки, но лучше, чем пустой каталог.
    async function loadTildaCatalog() {
        try {
            return await loadStoreCatalog();
        } catch (error) {
            console.error('❌ store-API недоступен, пробуем резервный YML-фид:', error);
            showNotification('store-API недоступен, каталог загружен из резервного YML-фида', 'info');
            const products = await loadYMLFeed();
            return { products, parts: [] };
        }
    }

    function showNotification(message, type) {
        injectStyles();

        // Одновременно висит только одно уведомление - предыдущее заменяем
        document.querySelectorAll('.ocx-toast').forEach(el => el.remove());

        const notification = document.createElement('div');
        notification.className = `ocx ocx-toast${type === 'error' ? ' ocx-toast--error' : type === 'info' ? ' ocx-toast--info' : ''}`;
        notification.textContent = message;

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), type === 'error' ? 5000 : 3000);
    }

    async function initCatalog() {
        console.log('Инициализация каталога...');

        const cached = getCachedCatalog();

        if (cached && cached.length > 0) {
            productsCache = cached;
            sitePartsCache = getCachedParts();
            console.log(`✅ Каталог загружен из кэша: ${productsCache.length} товаров`);
            return;
        }

        console.log('Кэш пуст или устарел, загружаем каталог из store-API...');
        showNotification('Загрузка каталога с сайта...', 'info');

        try {
            const { products, parts } = await loadTildaCatalog();

            if (products && products.length > 0) {
                productsCache = products;
                sitePartsCache = parts || [];
                saveCatalogToCache(products, sitePartsCache);
                console.log(`✅ Каталог обновлен: ${products.length} товаров`);
                showNotification(`Каталог обновлён: ${products.length} ${pluralize(products.length, 'товар', 'товара', 'товаров')}, в наличии ${products.filter(p => p.inStock).length}`, 'success');
            } else {
                console.warn('⚠️ Получен пустой каталог, используем локальные данные');
                showNotification('Используется локальный каталог', 'info');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки каталога:', error);
            showNotification(`Не удалось загрузить каталог: ${error.message}`, 'error');
        }
    }

    injectStyles();
    injectFont();
    initCatalog();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createMainButton);
    } else {
        createMainButton();
    }

    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            const oldButton = document.getElementById('tilda-catalog-main-btn');
            if (oldButton) oldButton.remove();
            setTimeout(createMainButton, 1000);
        }
    }).observe(document, {subtree: true, childList: true});

})();
