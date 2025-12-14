// ==UserScript==
// @name         amoCRM - Promo Codes & Bonus Manager
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  Управление промокодами и бонусными баллами в amoCRM с интеграцией Google Таблиц, аналитикой кэшбека и защитой паролем
// @author       Вы
// @match        https://*.amocrm.ru/*
// @match        https://*.kommo.com/*
// @updateURL    https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20Promo%20Codes%20Manager.user.js
// @downloadURL  https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20Promo%20Codes%20Manager.user.js
// @grant        GM.xmlHttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      *.amocrm.ru
// @connect      *.kommo.com
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const PROMO_FIELD_ID = 3025067;
    const BONUS_FIELD_ID = 2959149;
    const CACHE_DURATION = 10 * 60 * 1000;
    const ADMIN_PASSWORD = '4567';

    // URL Google Apps Script по умолчанию (можно изменить в настройках)
    const DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxfm0ub6u8oTDiDtuPKhYK_QImCliHXFhlQ4i5iVHB6zR17SF6erkl5DN85X2z828jQ/exec';
    
    let promoCodesCache = [];
    let amoCRMPromoCodes = [];
    let webAppUrl = '';
    let currentLeadBudget = 0;
    let isAdminAuthorized = false;
    let currentContactId = null;
    let currentContactName = '';
    let currentBonusPoints = 0;
    let bonusRequestsCache = [];

    function createPromoButton() {
        if (!window.location.href.includes('/leads/detail/')) return;

        const existingBtn = document.getElementById('promo-codes-main-btn');
        if (existingBtn) return;

        const button = document.createElement('button');
        button.id = 'promo-codes-main-btn';
        button.innerHTML = 'Промокоды';
        button.style.cssText = `
            position: fixed;
            bottom: 160px;
            right: 20px;
            padding: 12px 20px;
            background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: bold;
            font-family: "Gotham Rounded", "Avenir", "Century Gothic", "Trebuchet MS", "Arial Rounded MT Bold", sans-serif;
            box-shadow: 0 4px 15px rgba(255, 184, 209, 0.4);
            z-index: 9998;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        `;

        button.onmouseover = () => {
            button.style.transform = 'translateY(-2px)';
            button.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
            button.style.background = 'linear-gradient(135deg, #FFC2D4 0%, #FFB8D1 100%)';
        };
        button.onmouseout = () => {
            button.style.transform = 'translateY(0)';
            button.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.4)';
            button.style.background = 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)';
        };

        button.onclick = async () => await openPromoModal();
        document.body.appendChild(button);
    }

    function createPromoModal() {
        const overlay = document.createElement('div');
        overlay.id = 'promo-codes-overlay';
        overlay.style.cssText = `
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 9999;
            backdrop-filter: blur(5px);
        `;
        overlay.onclick = (e) => {
            if (e.target === overlay) closePromoModal();
        };

        const modal = document.createElement('div');
        modal.id = 'promo-codes-modal';
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 800px;
            max-height: 85vh;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            padding: 20px 25px;
            background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
            color: white;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <h2 style="margin: 0; font-size: 20px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Управление промокодами</h2>
            <button id="close-promo-modal-btn" style="
                background: transparent;
                border: none;
                color: white;
                font-size: 28px;
                cursor: pointer;
                line-height: 1;
                transition: all 0.2s;
            ">&times;</button>
        `;

        const tabs = document.createElement('div');
        tabs.style.cssText = `
            display: flex;
            background: #f5f5f5;
            border-bottom: 2px solid #e0e0e0;
        `;
        tabs.innerHTML = `
            <button class="promo-tab active" data-tab="check" style="
                flex: 1;
                padding: 15px;
                background: white;
                border: none;
                border-bottom: 3px solid #FFB8D1;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                color: #FFB8D1;
                transition: all 0.2s;
            ">Проверка промокода</button>
            <button class="promo-tab" data-tab="list" style="
                flex: 1;
                padding: 15px;
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                color: #666;
                transition: all 0.2s;
            ">Список промокодов</button>
            <button class="promo-tab" data-tab="bonus" style="
                flex: 1;
                padding: 15px;
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                color: #666;
                transition: all 0.2s;
            ">Бонусы</button>
            <button class="promo-tab" data-tab="add" style="
                flex: 1;
                padding: 15px;
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                color: #666;
                transition: all 0.2s;
            ">Добавить промокод</button>
            <button class="promo-tab" data-tab="analytics" style="
                flex: 1;
                padding: 15px;
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                color: #666;
                transition: all 0.2s;
            ">Аналитика</button>
            <button class="promo-tab" data-tab="settings" style="
                flex: 1;
                padding: 15px;
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                color: #666;
                transition: all 0.2s;
            ">Настройки</button>
        `;

        const content = document.createElement('div');
        content.id = 'promo-modal-content';
        content.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 25px;
        `;

        modal.appendChild(header);
        modal.appendChild(tabs);
        modal.appendChild(content);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('close-promo-modal-btn').onclick = closePromoModal;

        const tabButtons = tabs.querySelectorAll('.promo-tab');
        tabButtons.forEach(btn => {
            btn.onclick = () => switchTab(btn.dataset.tab);
        });
    }

    function switchTab(tabName) {
        // Проверка прав администратора для вкладок "Добавить промокод" и "Аналитика"
        if ((tabName === 'add' || tabName === 'analytics') && !isAdminAuthorized) {
            showNotification('🔒 Доступ запрещён. Требуется авторизация администратора в разделе "Настройки"', 'warning');
            switchTab('settings');
            return;
        }

        const tabs = document.querySelectorAll('.promo-tab');
        tabs.forEach(tab => {
            if (tab.dataset.tab === tabName) {
                tab.style.background = 'white';
                tab.style.borderBottom = '3px solid #FFB8D1';
                tab.style.color = '#FFB8D1';
                tab.classList.add('active');
            } else {
                tab.style.background = 'transparent';
                tab.style.borderBottom = 'none';
                tab.style.color = '#666';
                tab.classList.remove('active');
            }
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
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокод:</label>
                    <input type="text" id="promo-code-input" placeholder="Введите промокод" 
                        style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Телефон клиента:</label>
                    <input type="text" id="client-phone-input" placeholder="+7 (999) 123-45-67" 
                        style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <div id="phone-hint" style="font-size: 12px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Телефон подтягивается автоматически из карточки контакта</div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Сумма заказа (опционально):</label>
                    <input type="number" id="order-amount-input" placeholder="5000" value="${currentLeadBudget}"
                        style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <div style="font-size: 12px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Бюджет автоматически подставлен из сделки</div>
                </div>

                <div id="employee-referral-block" style="display: none; margin-bottom: 20px; background: linear-gradient(135deg, #FFF0F5 0%, #FFE4EC 100%); padding: 15px; border-radius: 8px; border: 2px solid #FFB8D1;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #FF69B4; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">🎁 От кого пришёл клиент:</label>
                    <select id="employee-referral-select" style="width: 100%; padding: 12px; border: 2px solid #FFB8D1; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; background: white;">
                        <option value="">-- Выберите сотрудника --</option>
                    </select>
                    <div style="font-size: 12px; color: #FF69B4; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Укажите сотрудника, чей друг использует промокод</div>
                </div>

                <button id="check-promo-btn" style="
                    width: 100%;
                    padding: 15px;
                    background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    margin-bottom: 20px;
                    box-shadow: 0 4px 15px rgba(255, 184, 209, 0.3);
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Проверить промокод</button>
                
                <div id="promo-result" style="
                    padding: 20px;
                    border-radius: 8px;
                    display: none;
                "></div>
            </div>
        `;

        const checkBtn = document.getElementById('check-promo-btn');
        checkBtn.onclick = checkPromoCode;
        checkBtn.onmouseover = () => {
            checkBtn.style.transform = 'translateY(-2px)';
            checkBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
        };
        checkBtn.onmouseout = () => {
            checkBtn.style.transform = 'translateY(0)';
            checkBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.3)';
        };
        
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
                phoneHint.textContent = '✓ Телефон подтянут автоматически из карточки контакта';
                phoneHint.style.color = '#28a745';
            }
            console.log('[Промокоды] Телефон автоматически заполнен:', phone);
        } else {
            if (phoneHint) {
                phoneHint.textContent = 'Телефон не найден в карточке контакта. Введите вручную';
                phoneHint.style.color = '#999';
            }
            console.log('[Промокоды] Телефон не найден в карточке контакта');
        }
    }

    function renderAddTab(container) {
        container.innerHTML = `
            <div style="max-width: 600px; margin: 0 auto;">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокод:*</label>
                    <input type="text" id="new-promo-code" placeholder="MAMA3" 
                        style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; text-transform: uppercase; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Тип промокода:*</label>
                    <select id="new-promo-type" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        <option value="многоразовый">Многоразовый</option>
                        <option value="одноразовый">Одноразовый</option>
                        <option value="персонализированный">Персонализированный</option>
                        <option value="условный">Условный</option>
                        <option value="сотрудника">Сотрудника</option>
                    </select>
                </div>
                
                <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom: 15px;">
                    <div>
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Скидка:*</label>
                        <input type="number" id="new-promo-discount" placeholder="10" 
                            style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    </div>
                    <div>
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Тип:</label>
                        <select id="new-promo-discount-type" style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            <option value="процент">%</option>
                            <option value="сумма">₽</option>
                        </select>
                    </div>
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Минимальная сумма заказа:</label>
                    <input type="number" id="new-promo-min-amount" placeholder="3000" 
                        style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Срок действия:</label>
                    <input type="date" id="new-promo-expiry" 
                        style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; background: white; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; color: #333;">
                </div>
                
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Максимальное количество использований:</label>
                    <input type="number" id="new-promo-max-usage" placeholder="100" 
                        style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                </div>
                
                <div style="margin-bottom: 15px; display: none;" id="phone-binding-block">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Привязка к телефонам:</label>
                    <div id="phone-bindings-list" style="margin-bottom: 10px;"></div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: end;">
                        <div>
                            <input type="text" id="new-phone-input" placeholder="+7 999 123-45-67"
                                style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        </div>
                        <div>
                            <input type="text" id="new-phone-name-input" placeholder="Имя (опционально)"
                                style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        </div>
                        <button type="button" id="add-phone-btn" style="
                            padding: 10px 15px;
                            background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
                            color: white;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            white-space: nowrap;
                        ">+ Добавить</button>
                    </div>
                    <div style="font-size: 12px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Добавьте телефоны сотрудников, которым разрешено использовать этот промокод</div>
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Описание:</label>
                    <textarea id="new-promo-description" placeholder="Описание промокода" rows="3"
                        style="width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; resize: vertical; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"></textarea>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
                    <button id="add-promo-google-btn" style="
                        padding: 15px;
                        background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        box-shadow: 0 4px 15px rgba(255, 184, 209, 0.4);
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        opacity: 1;
                    ">Сохранить в Google Таблицу</button>
                    
                    <button id="add-promo-amocrm-btn" style="
                        padding: 15px;
                        background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        box-shadow: 0 4px 15px rgba(255, 184, 209, 0.4);
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        opacity: 1;
                    ">Сохранить в amoCRM</button>
                </div>
                
                <div id="add-promo-result" style="margin-top: 15px; padding: 15px; border-radius: 6px; display: none;"></div>

                <hr style="border: none; border-top: 2px solid #FFB8D1; margin: 30px 0;">

                <div style="background: linear-gradient(135deg, #FFF0F5 0%, #FFE4EC 100%); padding: 20px; border-radius: 8px; border: 2px solid #FFB8D1;">
                    <h3 style="margin: 0 0 20px 0; font-size: 16px; color: #FF69B4; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        🎁 Промокод для друзей сотрудников
                    </h3>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Код промокода:</label>
                        <input type="text" id="friends-promo-code-input" placeholder="ДРУЗЬЯ15"
                            style="width: 100%; padding: 12px; border: 2px solid #FFB8D1; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        <div style="font-size: 12px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокод который выдаётся друзьям сотрудников (15% скидка)</div>
                    </div>

                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Список сотрудников (по одному на строку):</label>
                        <textarea id="employees-list-input" rows="6" placeholder="Иванов Иван
Петрова Мария
Сидоров Алексей"
                            style="width: 100%; padding: 12px; border: 2px solid #FFB8D1; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; resize: vertical;"></textarea>
                    </div>

                    <button id="save-friends-settings-btn" style="
                        width: 100%;
                        padding: 12px;
                        background: linear-gradient(135deg, #FF69B4 0%, #FF1493 100%);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        box-shadow: 0 4px 15px rgba(255, 105, 180, 0.3);
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    ">💾 Сохранить настройки друзей</button>
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
        addGoogleBtn.onmouseover = () => {
            addGoogleBtn.style.transform = 'translateY(-2px)';
            addGoogleBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
            addGoogleBtn.style.background = 'linear-gradient(135deg, #FFC2D4 0%, #FFB8D1 100%)';
        };
        addGoogleBtn.onmouseout = () => {
            addGoogleBtn.style.transform = 'translateY(0)';
            addGoogleBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.4)';
            addGoogleBtn.style.background = 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)';
        };

        const addAmoCRMBtn = document.getElementById('add-promo-amocrm-btn');
        addAmoCRMBtn.onclick = () => addPromoCode('amocrm');
        addAmoCRMBtn.onmouseover = () => {
            addAmoCRMBtn.style.transform = 'translateY(-2px)';
            addAmoCRMBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
            addAmoCRMBtn.style.background = 'linear-gradient(135deg, #FFC2D4 0%, #FFB8D1 100%)';
        };
        addAmoCRMBtn.onmouseout = () => {
            addAmoCRMBtn.style.transform = 'translateY(0)';
            addAmoCRMBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.4)';
            addAmoCRMBtn.style.background = 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)';
        };

        // Обработчик кнопки сохранения друзей
        const saveFriendsBtn = document.getElementById('save-friends-settings-btn');
        if (saveFriendsBtn) {
            saveFriendsBtn.onclick = saveFriendsSettings;
            saveFriendsBtn.onmouseover = () => {
                saveFriendsBtn.style.transform = 'translateY(-2px)';
                saveFriendsBtn.style.boxShadow = '0 8px 25px rgba(255, 105, 180, 0.5)';
                saveFriendsBtn.style.background = 'linear-gradient(135deg, #FF85C1 0%, #FF69B4 100%)';
            };
            saveFriendsBtn.onmouseout = () => {
                saveFriendsBtn.style.transform = 'translateY(0)';
                saveFriendsBtn.style.boxShadow = '0 4px 15px rgba(255, 105, 180, 0.3)';
                saveFriendsBtn.style.background = 'linear-gradient(135deg, #FF69B4 0%, #FF1493 100%)';
            };
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
            container.innerHTML = '<div style="color: #999; font-size: 13px; padding: 10px; text-align: center; font-family: \'Gotham Rounded\', \'Avenir\', \'Century Gothic\', \'Trebuchet MS\', \'Arial Rounded MT Bold\', sans-serif;">Телефоны не добавлены</div>';
            return;
        }

        container.innerHTML = window.promoPhoneBindings.map((binding, index) => `
            <div style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #f9f9f9; border-radius: 6px; margin-bottom: 6px; border: 1px solid #e0e0e0;">
                <div style="flex: 1; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <span style="font-weight: 600; color: #333;">${binding.phone}</span>
                    ${binding.name ? `<span style="color: #666; margin-left: 8px;">— ${binding.name}</span>` : ''}
                </div>
                <button type="button" class="remove-phone-btn" data-index="${index}" style="
                    background: #ff4444;
                    color: white;
                    border: none;
                    border-radius: 50%;
                    width: 24px;
                    height: 24px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
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
        const statusColor = promo.status === 'активен' ? '#4CAF50' : '#999';
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
                        <div style="display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: #666;">
                            <span>• ${u.date}</span>
                            ${u.leadUrl ? `<a href="${u.leadUrl}" target="_blank" style="color: #FFB8D1; text-decoration: none;">Сделка 🔗</a>` : ''}
                        </div>
                    `).join('')
                    : '<div style="font-size: 12px; color: #999; padding: 4px 0;">Нет использований</div>';

                return `
                    <div class="phone-binding-item" data-phone-index="${idx}" style="background: #f9f9f9; border-radius: 8px; padding: 12px; margin-bottom: 8px; border: 1px solid #e0e0e0;">
                        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                            <div>
                                <div style="font-weight: 600; color: #333; font-size: 14px; font-family: 'Gotham Rounded', sans-serif;">
                                    ${binding.name || 'Без имени'}
                                </div>
                                <div style="color: #666; font-size: 13px; font-family: 'Gotham Rounded', sans-serif;">
                                    ${binding.phone}
                                </div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="background: #FFB8D1; color: white; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: bold;">
                                    ${usagesCount} исп.
                                </span>
                                <button class="remove-binding-btn" data-phone="${binding.phone}" style="
                                    background: #ff4444;
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
                        <div style="border-top: 1px solid #e0e0e0; padding-top: 8px; margin-top: 8px;">
                            <div style="font-size: 11px; color: #999; margin-bottom: 4px; font-family: 'Gotham Rounded', sans-serif;">История использований:</div>
                            ${usagesHtml}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            phonesHtml = '<div style="text-align: center; color: #999; padding: 20px; font-family: \'Gotham Rounded\', sans-serif;">Телефоны не привязаны</div>';
        }

        modal.innerHTML = `
            <div style="background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%); padding: 20px; color: white;">
                <div style="display: flex; justify-content: space-between; align-items: start;">
                    <div>
                        <div style="font-size: 24px; font-weight: bold; font-family: 'Gotham Rounded', sans-serif; margin-bottom: 5px;">${promo.code}</div>
                        <div style="font-size: 14px; opacity: 0.9; font-family: 'Gotham Rounded', sans-serif;">
                            <span style="background: rgba(255,255,255,0.2); padding: 2px 10px; border-radius: 4px; margin-right: 8px;">${promo.type}</span>
                            <span style="font-weight: 600;">● ${promo.status}</span>
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
                    <div style="text-align: center; background: #f9f9f9; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 24px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', sans-serif;">${discountText}</div>
                        <div style="font-size: 12px; color: #999; font-family: 'Gotham Rounded', sans-serif;">Скидка</div>
                    </div>
                    <div style="text-align: center; background: #f9f9f9; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 24px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', sans-serif;">${phoneBindings.length}</div>
                        <div style="font-size: 12px; color: #999; font-family: 'Gotham Rounded', sans-serif;">Телефонов</div>
                    </div>
                    <div style="text-align: center; background: #f9f9f9; padding: 15px; border-radius: 8px;">
                        <div style="font-size: 24px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', sans-serif;">${totalUsages}</div>
                        <div style="font-size: 12px; color: #999; font-family: 'Gotham Rounded', sans-serif;">Использований</div>
                    </div>
                </div>

                ${promo.description ? `
                    <div style="background: #f0f0f0; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 13px; color: #666; font-family: 'Gotham Rounded', sans-serif;">
                        ${promo.description}
                    </div>
                ` : ''}

                <div style="margin-bottom: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <h3 style="margin: 0; font-size: 16px; color: #333; font-family: 'Gotham Rounded', sans-serif;">Привязанные телефоны</h3>
                        <button id="add-phone-to-promo-btn" style="
                            background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
                            color: white;
                            border: none;
                            border-radius: 6px;
                            padding: 8px 15px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', sans-serif;
                        ">+ Добавить телефон</button>
                    </div>
                    <div id="add-phone-form" style="display: none; background: #e8f5e9; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                            <input type="text" id="modal-new-phone" placeholder="+7 999 123-45-67" style="
                                padding: 10px;
                                border: 2px solid #ddd;
                                border-radius: 6px;
                                font-size: 14px;
                                font-family: 'Gotham Rounded', sans-serif;
                            ">
                            <input type="text" id="modal-new-name" placeholder="Имя (опционально)" style="
                                padding: 10px;
                                border: 2px solid #ddd;
                                border-radius: 6px;
                                font-size: 14px;
                                font-family: 'Gotham Rounded', sans-serif;
                            ">
                        </div>
                        <div style="display: flex; gap: 10px;">
                            <button id="save-new-phone-btn" style="
                                flex: 1;
                                background: #4CAF50;
                                color: white;
                                border: none;
                                border-radius: 6px;
                                padding: 10px;
                                cursor: pointer;
                                font-weight: bold;
                                font-family: 'Gotham Rounded', sans-serif;
                            ">Сохранить</button>
                            <button id="cancel-new-phone-btn" style="
                                background: #f5f5f5;
                                color: #666;
                                border: none;
                                border-radius: 6px;
                                padding: 10px;
                                cursor: pointer;
                                font-family: 'Gotham Rounded', sans-serif;
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
                <div style="background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%); padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 30px; box-shadow: 0 4px 15px rgba(255, 184, 209, 0.3);">
                    <div style="font-size: 14px; color: white; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.9;">Текущий баланс баллов</div>
                    <div id="current-bonus-display" style="font-size: 48px; font-weight: bold; color: white; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        ${currentBonusPoints.toFixed(2)}
                    </div>
                    <div style="font-size: 12px; color: white; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.8;" id="contact-info">
                        ${currentContactId ? currentContactName : 'Контакт не определен'}
                    </div>
                </div>
                
                ${isAdminAuthorized ? `
                    <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; border: 2px solid #4CAF50;">
                        <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #4CAF50; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Прямое начисление/списание (Админ)</h3>
                        
                        <div style="margin-bottom: 20px;">
                            <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Количество баллов:</label>
                            <input type="number" id="bonus-points-input" placeholder="100" step="0.01"
                                style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 16px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        </div>
                        
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <button id="add-bonus-btn" style="
                                padding: 15px;
                                background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
                                color: white;
                                border: none;
                                border-radius: 8px;
                                cursor: pointer;
                                font-size: 16px;
                                font-weight: bold;
                                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                                box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
                                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                            ">➕ Начислить</button>
                            
                            <button id="subtract-bonus-btn" style="
                                padding: 15px;
                                background: linear-gradient(135deg, #FF5252 0%, #E53935 100%);
                                color: white;
                                border: none;
                                border-radius: 8px;
                                cursor: pointer;
                                font-size: 16px;
                                font-weight: bold;
                                font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                                box-shadow: 0 4px 15px rgba(255, 82, 82, 0.3);
                                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                            ">➖ Списать</button>
                        </div>
                        
                        <div id="bonus-result" style="
                            padding: 15px;
                            border-radius: 8px;
                            display: none;
                            margin-top: 15px;
                        "></div>
                    </div>
                ` : ''}
                
                <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 30px; border: 2px solid #FFB8D1;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #FFB8D1; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">📝 Создать заявку на начисление</h3>
                    
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Количество баллов для начисления:</label>
                        <input type="number" id="request-points-input" placeholder="100" step="0.01"
                            style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    </div>
                    
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Причина начисления:</label>
                        <textarea id="request-reason-input" placeholder="Например: Опоздали с доставкой, завял букет, забыли открытку..." rows="3"
                            style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; resize: vertical; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"></textarea>
                    </div>
                    
                    <button id="create-request-btn" style="
                        width: 100%;
                        padding: 15px;
                        background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 16px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        box-shadow: 0 4px 15px rgba(255, 184, 209, 0.3);
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    ">Отправить заявку</button>
                    
                    <div id="request-result" style="
                        padding: 15px;
                        border-radius: 8px;
                        display: none;
                        margin-top: 15px;
                    "></div>
                </div>
                
                <div style="background: white; padding: 20px; border-radius: 12px; border: 2px solid #e0e0e0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h3 style="margin: 0; font-size: 18px; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">📋 Заявки на начисление</h3>
                        <button id="sync-requests-btn" style="
                            padding: 8px 16px;
                            background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                            color: white;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 13px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            transition: all 0.2s;
                        ">🔄 Синхронизировать</button>
                    </div>
                    
                    <div id="bonus-requests-list" style="max-height: 500px; overflow-y: auto;">
                        ${renderBonusRequestsList()}
                    </div>
                </div>
            </div>
        `;

        if (isAdminAuthorized) {
            const addBtn = document.getElementById('add-bonus-btn');
            const subtractBtn = document.getElementById('subtract-bonus-btn');
            
            addBtn.onclick = () => modifyBonusPoints('add');
            addBtn.onmouseover = () => {
                addBtn.style.transform = 'translateY(-2px)';
                addBtn.style.boxShadow = '0 8px 25px rgba(76, 175, 80, 0.5)';
            };
            addBtn.onmouseout = () => {
                addBtn.style.transform = 'translateY(0)';
                addBtn.style.boxShadow = '0 4px 15px rgba(76, 175, 80, 0.3)';
            };
            
            subtractBtn.onclick = () => modifyBonusPoints('subtract');
            subtractBtn.onmouseover = () => {
                subtractBtn.style.transform = 'translateY(-2px)';
                subtractBtn.style.boxShadow = '0 8px 25px rgba(255, 82, 82, 0.5)';
            };
            subtractBtn.onmouseout = () => {
                subtractBtn.style.transform = 'translateY(0)';
                subtractBtn.style.boxShadow = '0 4px 15px rgba(255, 82, 82, 0.3)';
            };
        }
        
        const createRequestBtn = document.getElementById('create-request-btn');
        createRequestBtn.onclick = createBonusRequest;
        createRequestBtn.onmouseover = () => {
            createRequestBtn.style.transform = 'translateY(-2px)';
            createRequestBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
        };
        createRequestBtn.onmouseout = () => {
            createRequestBtn.style.transform = 'translateY(0)';
            createRequestBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.3)';
        };
        
        const syncRequestsBtn = document.getElementById('sync-requests-btn');
        if (syncRequestsBtn) {
            syncRequestsBtn.onclick = () => syncBonusRequests(false);
            syncRequestsBtn.onmouseover = () => {
                syncRequestsBtn.style.transform = 'scale(1.05)';
                syncRequestsBtn.style.background = 'linear-gradient(135deg, #FFC2D4 0%, #FFB8D1 100%)';
            };
            syncRequestsBtn.onmouseout = () => {
                syncRequestsBtn.style.transform = 'scale(1)';
                syncRequestsBtn.style.background = 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)';
            };
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
                    background: #f5f5f5;
                    border-radius: 4px;
                }
                #google-promos-list::-webkit-scrollbar-thumb {
                    background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                    border-radius: 4px;
                }
                #amocrm-promos-list::-webkit-scrollbar-thumb {
                    background: linear-gradient(135deg, #FFD4E5 0%, #FFC2D4 100%);
                    border-radius: 4px;
                }
                #google-promos-list::-webkit-scrollbar-thumb:hover,
                #amocrm-promos-list::-webkit-scrollbar-thumb:hover {
                    background: #FF9EC4;
                }
            </style>
        `;
        
        container.innerHTML = scrollbarStyles + `
            <div style="max-width: 900px; margin: 0 auto;">
                <div style="margin-bottom: 30px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; display: flex; align-items: center; justify-content: space-between;">
                        <span>Промокоды из Google Таблицы</span>
                        <span style="font-size: 16px; background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%); color: white; padding: 5px 15px; border-radius: 20px;">${promoCodesCache.length}</span>
                    </h3>
                    <div id="google-promos-list" style="max-height: 400px; overflow-y: auto; padding-right: 5px;">
                        ${renderGooglePromosList()}
                    </div>
                </div>
                
                <hr style="border: none; border-top: 2px solid #e0e0e0; margin: 30px 0;">
                
                <div style="margin-bottom: 30px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 18px; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; display: flex; align-items: center; justify-content: space-between;">
                        <span>Промокоды из amoCRM</span>
                        <span style="font-size: 16px; background: linear-gradient(135deg, #FFD4E5 0%, #FFC2D4 100%); color: #FF9EC4; padding: 5px 15px; border-radius: 20px;">${amoCRMPromoCodes.length}</span>
                    </h3>
                    <div id="amocrm-promos-list" style="max-height: 400px; overflow-y: auto; padding-right: 5px;">
                        ${renderAmoCRMPromosList()}
                    </div>
                </div>

                <hr style="border: none; border-top: 2px solid #FFB8D1; margin: 30px 0;">

                <div id="friends-stats-section" style="background: linear-gradient(135deg, #FFF0F5 0%, #FFE4EC 100%); border-radius: 12px; padding: 20px; border: 2px solid #FFB8D1;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #FF69B4; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; display: flex; align-items: center; gap: 10px;">
                        🎁 Промокоды от сотрудников
                        <button id="refresh-friends-stats-btn" style="
                            padding: 5px 12px;
                            background: linear-gradient(135deg, #FF69B4 0%, #FF1493 100%);
                            color: white;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 12px;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            margin-left: auto;
                        ">🔄 Обновить</button>
                    </h3>
                    <div id="friends-promo-code-display" style="font-size: 14px; color: #666; margin-bottom: 15px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        Промокод: <strong style="color: #FF69B4;">загрузка...</strong>
                    </div>
                    <div id="friends-stats-content" style="min-height: 100px;">
                        <div style="text-align: center; padding: 30px; color: #FF69B4; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            <div style="font-size: 24px; margin-bottom: 10px;">⏳</div>
                            <div>Загрузка статистики...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        attachDeleteButtonsListeners();

        // Загружаем статистику друзей сотрудников
        loadAndRenderFriendsStats();
    }

    function renderGooglePromosList() {
        if (promoCodesCache.length === 0) {
            return `<div style="text-align: center; padding: 40px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокоды не загружены. Загрузите их в разделе "Настройки"</div>`;
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
            const statusColor = promo.status === 'активен' ? '#4CAF50' : '#999';
            const expiryText = promo.expiryDate ? `до ${formatDate(promo.expiryDate)}` : 'Без срока';

            // Парсим привязанные телефоны
            const phoneBindings = promo.phoneBindings || parsePhoneBindings(promo.phoneBinding);
            const phonesCount = phoneBindings.length;
            const totalUsages = phoneBindings.reduce((sum, b) => sum + (b.usages ? b.usages.length : 0), 0);

            // Проверяем, есть ли промокод в amoCRM
            const isInAmoCRM = amoCRMCodesSet.has(promo.code.toUpperCase());
            const missingBadge = !isInAmoCRM ? `
                <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 10px; background: #fff3e0; border-radius: 6px; border-left: 3px solid #FF9800;">
                    <span style="font-size: 12px; color: #E65100; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; font-weight: 600;">⚠️ Нет в amoCRM</span>
                    <button class="add-to-amocrm-btn" data-promo-code="${promo.code}" style="
                        padding: 4px 10px;
                        background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 11px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        transition: all 0.2s;
                        margin-left: auto;
                    " onmouseover="this.style.background='linear-gradient(135deg, #42A5F5 0%, #2196F3 100%)'; this.style.transform='scale(1.05)'" onmouseout="this.style.background='linear-gradient(135deg, #2196F3 0%, #1976D2 100%)'; this.style.transform='scale(1)'">+ Добавить в amoCRM</button>
                </div>
            ` : '';

            return `
                <div class="promo-card" data-promo-index="${index}" style="background: white; border: 2px solid ${isInAmoCRM ? '#f0f0f0' : '#FF9800'}; border-radius: 8px; padding: 15px; margin-bottom: 10px; transition: all 0.2s; position: relative; cursor: pointer;"
                     onmouseover="this.style.borderColor='#FFB8D1'; this.style.boxShadow='0 4px 12px rgba(255, 184, 209, 0.3)'"
                     onmouseout="this.style.borderColor='${isInAmoCRM ? '#f0f0f0' : '#FF9800'}'; this.style.boxShadow='none'">
                    <button class="delete-google-promo-btn" data-promo-code="${promo.code}" style="
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: #ff4444;
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
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        font-weight: bold;
                        line-height: 1;
                        padding: 0;
                        z-index: 10;
                    " onmouseover="this.style.background='#cc0000'; this.style.transform='scale(1.1)'" onmouseout="this.style.background='#ff4444'; this.style.transform='scale(1)'">×</button>
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px; padding-right: 30px;">
                        <div>
                            <div style="font-size: 18px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; margin-bottom: 5px;">${promo.code}</div>
                            <div style="font-size: 12px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                                <span style="display: inline-block; padding: 2px 8px; background: #f0f0f0; border-radius: 4px; margin-right: 5px;">${promo.type}</span>
                                <span style="color: ${statusColor}; font-weight: 600;">● ${promo.status}</span>
                                ${isInAmoCRM ? '<span style="display: inline-block; padding: 2px 8px; background: #e8f5e9; color: #2e7d32; border-radius: 4px; margin-left: 5px; font-size: 10px;">✓ amoCRM</span>' : ''}
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 20px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">${discountText}</div>
                            <div style="font-size: 11px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">${expiryText}</div>
                        </div>
                    </div>
                    ${promo.minOrderAmount ? `<div style="font-size: 12px; color: #666; margin-top: 8px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">💰 Мин. сумма: ${promo.minOrderAmount} ₽</div>` : ''}
                    ${promo.maxUsages ? `<div style="font-size: 12px; color: #666; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">📊 Использовано: ${promo.currentUsages || 0} из ${promo.maxUsages}</div>` : ''}
                    ${phonesCount > 0 ? `<div style="font-size: 12px; color: #666; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">📱 Привязано телефонов: <strong>${phonesCount}</strong> ${totalUsages > 0 ? `(использований: ${totalUsages})` : ''}</div>` : ''}
                    ${promo.description ? `<div style="font-size: 12px; color: #666; margin-top: 10px; padding-top: 10px; border-top: 1px solid #f0f0f0; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">${promo.description}</div>` : ''}
                    ${missingBadge}
                    <div style="font-size: 11px; color: #999; margin-top: 8px; text-align: center; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Нажмите для просмотра деталей</div>
                </div>
            `;
        }).join('');
    }

    function renderAmoCRMPromosList() {
        if (amoCRMPromoCodes.length === 0) {
            return `<div style="text-align: center; padding: 40px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокоды не загружены. Загрузите их в разделе "Настройки"</div>`;
        }

        return amoCRMPromoCodes.map(promo => {
            return `
                <div class="amocrm-promo-card" style="background: white; border: 2px solid #FFD4E5; border-radius: 8px; padding: 15px; margin-bottom: 10px; transition: all 0.2s; position: relative;" 
                     onmouseover="this.style.borderColor='#FF9EC4'; this.style.boxShadow='0 4px 12px rgba(255, 158, 196, 0.3)'" 
                     onmouseout="this.style.borderColor='#FFD4E5'; this.style.boxShadow='none'">
                    <button class="delete-amocrm-promo-btn" data-promo-code="${promo.value}" data-promo-id="${promo.id}" style="
                        position: absolute;
                        top: 10px;
                        right: 10px;
                        background: #ff4444;
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
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        font-weight: bold;
                        line-height: 1;
                        padding: 0;
                    " onmouseover="this.style.background='#cc0000'; this.style.transform='scale(1.1)'" onmouseout="this.style.background='#ff4444'; this.style.transform='scale(1)'">×</button>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding-right: 30px;">
                        <div style="font-size: 16px; font-weight: bold; color: #FF9EC4; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">${promo.value}</div>
                        <div style="font-size: 12px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">ID: ${promo.id}</div>
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

        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'GET',
                url: webAppUrl + '?action=getFriendsStats',
                onload: (response) => {
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

        return new Promise((resolve, reject) => {
            GM.xmlHttpRequest({
                method: 'POST',
                url: webAppUrl,
                data: JSON.stringify({
                    action: 'addFriendsUsage',
                    employee: employee,
                    leadUrl: leadUrl
                }),
                headers: { 'Content-Type': 'application/json' },
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
                ? `Промокод: <strong style="color: #FF69B4; font-size: 16px;">${friendsPromoCode}</strong> (15%)`
                : `<span style="color: #999;">Промокод не настроен. Настройте в разделе "Настройки"</span>`;
        }

        // Обработчик кнопки обновления
        if (refreshBtn) {
            refreshBtn.onclick = () => loadAndRenderFriendsStats();
        }

        try {
            const stats = await loadFriendsStats();

            if (stats.total === 0) {
                statsContent.innerHTML = `
                    <div style="text-align: center; padding: 30px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        <div style="font-size: 32px; margin-bottom: 10px;">📭</div>
                        <div>Пока нет использований промокода друзей</div>
                    </div>
                `;
                return;
            }

            // Формируем таблицу статистики
            const employees = Object.entries(stats.byEmployee).sort((a, b) => b[1].count - a[1].count);

            let tableHTML = `
                <table style="width: 100%; border-collapse: collapse; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <thead>
                        <tr style="background: rgba(255, 105, 180, 0.1);">
                            <th style="text-align: left; padding: 12px; border-bottom: 2px solid #FFB8D1; color: #FF69B4; font-size: 14px;">Сотрудник</th>
                            <th style="text-align: center; padding: 12px; border-bottom: 2px solid #FFB8D1; color: #FF69B4; font-size: 14px;">Клиентов</th>
                            <th style="text-align: left; padding: 12px; border-bottom: 2px solid #FFB8D1; color: #FF69B4; font-size: 14px;">Сделки</th>
                        </tr>
                    </thead>
                    <tbody>
            `;

            employees.forEach(([employee, data], index) => {
                const leadsLinks = data.leads.map((url, i) => {
                    if (url) {
                        return `<a href="${url}" target="_blank" style="display: inline-block; margin: 2px; padding: 3px 8px; background: #FF69B4; color: white; text-decoration: none; border-radius: 4px; font-size: 11px;" title="${url}">🔗 ${i + 1}</a>`;
                    }
                    return '';
                }).filter(l => l).join('');

                tableHTML += `
                    <tr style="background: ${index % 2 === 0 ? 'white' : 'rgba(255, 240, 245, 0.5)'};">
                        <td style="padding: 12px; border-bottom: 1px solid #FFE4EC; font-weight: 600; color: #333;">${employee}</td>
                        <td style="padding: 12px; border-bottom: 1px solid #FFE4EC; text-align: center;">
                            <span style="display: inline-block; background: linear-gradient(135deg, #FF69B4 0%, #FF1493 100%); color: white; padding: 4px 12px; border-radius: 12px; font-weight: bold;">${data.count}</span>
                        </td>
                        <td style="padding: 12px; border-bottom: 1px solid #FFE4EC;">${leadsLinks || '<span style="color: #999;">—</span>'}</td>
                    </tr>
                `;
            });

            tableHTML += `
                    </tbody>
                </table>
                <div style="margin-top: 15px; padding-top: 15px; border-top: 2px solid #FFB8D1; text-align: center; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <span style="font-size: 14px; color: #666;">Всего клиентов: </span>
                    <span style="font-size: 20px; font-weight: bold; color: #FF69B4;">${stats.total}</span>
                </div>
            `;

            statsContent.innerHTML = tableHTML;

        } catch (error) {
            console.error('[Промокоды] Ошибка загрузки статистики друзей:', error);
            statsContent.innerHTML = `
                <div style="text-align: center; padding: 30px; color: #ff4444; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <div style="font-size: 32px; margin-bottom: 10px;">❌</div>
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
                    <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">URL Google Apps Script Web App:</label>
                    <input type="text" id="webapp-url-input" value="${webAppUrl}" placeholder="https://script.google.com/macros/s/..." 
                        style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <div style="font-size: 12px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">После деплоя Google Apps Script скопируйте сюда URL Web App</div>
                </div>
                
                <button id="save-webapp-url-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    margin-bottom: 20px;
                ">Сохранить URL</button>
                
                <hr style="border: none; border-top: 2px solid #e0e0e0; margin: 30px 0;">
                
                <button id="sync-google-sheet-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    margin-bottom: 15px;
                    box-shadow: 0 4px 15px rgba(255, 184, 209, 0.3);
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Загрузить промокоды из Google Таблицы</button>
                
                <button id="sync-amocrm-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    margin-bottom: 15px;
                    box-shadow: 0 4px 15px rgba(255, 184, 209, 0.3);
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">Загрузить промокоды из amoCRM</button>
                
                <button id="sync-amocrm-to-google-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: linear-gradient(135deg, #9C27B0 0%, #7B1FA2 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    margin-bottom: 15px;
                    box-shadow: 0 4px 15px rgba(156, 39, 176, 0.3);
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">↔ Синхронизировать amoCRM → Google Таблица</button>

                <button id="sync-google-to-amocrm-btn" style="
                    width: 100%;
                    padding: 12px;
                    background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    margin-bottom: 20px;
                    box-shadow: 0 4px 15px rgba(33, 150, 243, 0.3);
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ">↔ Синхронизировать Google Таблица → amoCRM</button>

                <div style="background: #f5f5f5; padding: 20px; border-radius: 8px;">
                    <h3 style="margin: 0 0 15px 0; font-size: 16px; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Статистика</h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div>
                            <div style="font-size: 12px; color: #999; margin-bottom: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокодов в Google:</div>
                            <div style="font-size: 24px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="google-promo-count">0</div>
                        </div>
                        <div>
                            <div style="font-size: 12px; color: #999; margin-bottom: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Промокодов в amoCRM:</div>
                            <div style="font-size: 24px; font-weight: bold; color: #FFB8D1; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="amocrm-promo-count">0</div>
                        </div>
                    </div>
                    <div style="margin-top: 15px; font-size: 12px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="last-sync-time">Последняя синхронизация: никогда</div>
                </div>
                
                <hr style="border: none; border-top: 2px solid #e0e0e0; margin: 30px 0;">
                
                <div style="background: ${isAdminAuthorized ? '#d4edda' : '#fff3e0'}; padding: 20px; border-radius: 8px; border-left: 4px solid ${isAdminAuthorized ? '#4CAF50' : '#FF9800'};">
                    <h3 style="margin: 0 0 15px 0; font-size: 16px; color: ${isAdminAuthorized ? '#155724' : '#E65100'}; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        ${isAdminAuthorized ? '✅ Режим администратора' : '🔒 Защита данных'}
                    </h3>
                    <p style="margin: 0 0 15px 0; font-size: 13px; color: ${isAdminAuthorized ? '#155724' : '#E65100'}; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                        ${isAdminAuthorized ? 'Вы авторизованы. Разрешено добавлять и удалять промокоды.' : 'Для добавления и удаления промокодов требуется код администратора.'}
                    </p>
                    ${isAdminAuthorized ? `
                        <button id="admin-logout-btn" style="
                            width: 100%;
                            padding: 12px;
                            background: linear-gradient(135deg, #FF5252 0%, #E53935 100%);
                            color: white;
                            border: none;
                            border-radius: 8px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            box-shadow: 0 4px 15px rgba(255, 82, 82, 0.3);
                            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        ">🚪 Выйти из режима администратора</button>
                    ` : `
                        <button id="admin-auth-btn" style="
                            width: 100%;
                            padding: 12px;
                            background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%);
                            color: white;
                            border: none;
                            border-radius: 8px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            box-shadow: 0 4px 15px rgba(255, 152, 0, 0.3);
                            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                        ">🔑 Ввести код администратора</button>
                    `}
                </div>

            </div>
        `;

        document.getElementById('save-webapp-url-btn').onclick = saveWebAppUrl;
        
        const syncGoogleBtn = document.getElementById('sync-google-sheet-btn');
        syncGoogleBtn.onclick = () => syncWithGoogleSheet(false);
        syncGoogleBtn.onmouseover = () => {
            syncGoogleBtn.style.transform = 'translateY(-2px)';
            syncGoogleBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
        };
        syncGoogleBtn.onmouseout = () => {
            syncGoogleBtn.style.transform = 'translateY(0)';
            syncGoogleBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.3)';
        };
        
        const syncAmoCRMBtn = document.getElementById('sync-amocrm-btn');
        syncAmoCRMBtn.onclick = () => syncWithAmoCRM(false);
        syncAmoCRMBtn.onmouseover = () => {
            syncAmoCRMBtn.style.transform = 'translateY(-2px)';
            syncAmoCRMBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
        };
        syncAmoCRMBtn.onmouseout = () => {
            syncAmoCRMBtn.style.transform = 'translateY(0)';
            syncAmoCRMBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.3)';
        };

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
        syncAmoCRMToGoogleBtn.onmouseover = () => {
            syncAmoCRMToGoogleBtn.style.transform = 'translateY(-2px)';
            syncAmoCRMToGoogleBtn.style.boxShadow = '0 8px 25px rgba(156, 39, 176, 0.5)';
            syncAmoCRMToGoogleBtn.style.background = 'linear-gradient(135deg, #AB47BC 0%, #9C27B0 100%)';
        };
        syncAmoCRMToGoogleBtn.onmouseout = () => {
            syncAmoCRMToGoogleBtn.style.transform = 'translateY(0)';
            syncAmoCRMToGoogleBtn.style.boxShadow = '0 4px 15px rgba(156, 39, 176, 0.3)';
            syncAmoCRMToGoogleBtn.style.background = 'linear-gradient(135deg, #9C27B0 0%, #7B1FA2 100%)';
        };

        const syncGoogleToAmoCRMBtn = document.getElementById('sync-google-to-amocrm-btn');
        syncGoogleToAmoCRMBtn.onclick = async () => {
            if (promoCodesCache.length === 0) {
                showNotification('Сначала загрузите промокоды из Google Таблицы', 'warning');
                return;
            }
            await syncGoogleToAmoCRM();
        };
        syncGoogleToAmoCRMBtn.onmouseover = () => {
            syncGoogleToAmoCRMBtn.style.transform = 'translateY(-2px)';
            syncGoogleToAmoCRMBtn.style.boxShadow = '0 8px 25px rgba(33, 150, 243, 0.5)';
            syncGoogleToAmoCRMBtn.style.background = 'linear-gradient(135deg, #42A5F5 0%, #2196F3 100%)';
        };
        syncGoogleToAmoCRMBtn.onmouseout = () => {
            syncGoogleToAmoCRMBtn.style.transform = 'translateY(0)';
            syncGoogleToAmoCRMBtn.style.boxShadow = '0 4px 15px rgba(33, 150, 243, 0.3)';
            syncGoogleToAmoCRMBtn.style.background = 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)';
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
                adminLogoutBtn.onmouseover = () => {
                    adminLogoutBtn.style.transform = 'translateY(-2px)';
                    adminLogoutBtn.style.boxShadow = '0 8px 25px rgba(255, 82, 82, 0.5)';
                    adminLogoutBtn.style.background = 'linear-gradient(135deg, #FF6B6B 0%, #FF5252 100%)';
                };
                adminLogoutBtn.onmouseout = () => {
                    adminLogoutBtn.style.transform = 'translateY(0)';
                    adminLogoutBtn.style.boxShadow = '0 4px 15px rgba(255, 82, 82, 0.3)';
                    adminLogoutBtn.style.background = 'linear-gradient(135deg, #FF5252 0%, #E53935 100%)';
                };
            }
        } else {
            const adminAuthBtn = document.getElementById('admin-auth-btn');
            if (adminAuthBtn) {
                adminAuthBtn.onclick = () => {
                    showAdminPasswordModal();
                };
                adminAuthBtn.onmouseover = () => {
                    adminAuthBtn.style.transform = 'translateY(-2px)';
                    adminAuthBtn.style.boxShadow = '0 8px 25px rgba(255, 152, 0, 0.5)';
                    adminAuthBtn.style.background = 'linear-gradient(135deg, #FFA726 0%, #FF9800 100%)';
                };
                adminAuthBtn.onmouseout = () => {
                    adminAuthBtn.style.transform = 'translateY(0)';
                    adminAuthBtn.style.boxShadow = '0 4px 15px rgba(255, 152, 0, 0.3)';
                    adminAuthBtn.style.background = 'linear-gradient(135deg, #FF9800 0%, #F57C00 100%)';
                };
            }
        }

        updateStatistics();
    }

    function showAdminPasswordModal() {
        const overlay = document.createElement('div');
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
            z-index: 10001;
            backdrop-filter: blur(5px);
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            max-width: 400px;
            width: 90%;
        `;

        modal.innerHTML = `
            <h3 style="margin: 0 0 20px 0; font-size: 20px; color: #333; text-align: center; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                🔐 Код администратора
            </h3>
            <input type="password" id="admin-password-input" placeholder="Введите код" 
                style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 16px; box-sizing: border-box; margin-bottom: 20px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; text-align: center; letter-spacing: 3px;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <button id="cancel-password-btn" style="
                    padding: 12px;
                    background: #f5f5f5;
                    color: #666;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    transition: all 0.2s;
                ">Отмена</button>
                <button id="submit-password-btn" style="
                    padding: 12px;
                    background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                    box-shadow: 0 4px 15px rgba(255, 152, 0, 0.3);
                    transition: all 0.2s;
                ">Войти</button>
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
                showNotification('✅ Авторизация успешна! Разрешено добавлять и удалять промокоды', 'success');
                switchTab('settings');
            } else {
                passwordInput.value = '';
                passwordInput.style.borderColor = '#f44336';
                showNotification('❌ Неверный код администратора', 'error');
                setTimeout(() => {
                    passwordInput.style.borderColor = '#ddd';
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
                    <div style="font-size: 16px; font-weight: bold; margin-bottom: 15px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; color: #FFB8D1;">Промокод активен!</div>
                    <div style="margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"><strong>Скидка:</strong> ${discountText}</div>
                    <div style="margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"><strong>Тип:</strong> ${promo.type}</div>
                `;

                if (promo.minOrderAmount) {
                    detailsHtml += `<div style="margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"><strong>Минимальная сумма заказа:</strong> ${promo.minOrderAmount} ₽</div>`;
                }

                if (promo.expiryDate) {
                    detailsHtml += `<div style="margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"><strong>Срок действия:</strong> до ${formatDate(promo.expiryDate)}</div>`;
                }

                if (promo.maxUsages) {
                    const remaining = promo.maxUsages - (promo.currentUsages || 0);
                    detailsHtml += `<div style="margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;"><strong>Осталось использований:</strong> ${remaining} из ${promo.maxUsages}</div>`;
                }

                if (promo.description) {
                    detailsHtml += `<div style="margin-top: 15px; padding: 10px; background: #f9f9f9; border-radius: 4px; font-size: 13px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">${promo.description}</div>`;
                }

                detailsHtml += `
                    <button id="apply-promo-btn" style="
                        width: 100%;
                        padding: 12px;
                        background: #4CAF50;
                        color: white;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
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
            showResult(resultDiv, '🔒 Для добавления промокодов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
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

    function makeGoogleScriptRequest(method, data = null) {
        return new Promise((resolve, reject) => {
            if (!webAppUrl) {
                reject(new Error('Web App URL не настроен'));
                return;
            }

            const config = {
                method: method,
                url: webAppUrl + (method === 'GET' && data ? '?' + new URLSearchParams(data).toString() : ''),
                onload: function(response) {
                    try {
                        if (response.status === 200) {
                            const result = JSON.parse(response.responseText);
                            resolve(result);
                        } else {
                            reject(new Error(`HTTP ${response.status}`));
                        }
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: function(error) {
                    reject(new Error('Ошибка соединения с Google Apps Script'));
                }
            };

            if (method === 'POST' && data) {
                config.headers = { 'Content-Type': 'application/json' };
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
            if (!silent) showNotification('Ошибка загрузки промокодов', 'error');
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
            showNotification('🔒 Для удаления промокодов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
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
            showNotification('🔒 Для удаления промокодов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
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

    async function modifyBonusPoints(action) {
        const resultDiv = document.getElementById('bonus-result');
        
        if (!isAdminAuthorized) {
            showResult(resultDiv, '🔒 Для начисления и списания баллов требуется авторизация. Перейдите в раздел "Настройки"', 'warning');
            return;
        }

        if (!currentContactId) {
            showResult(resultDiv, 'Контакт не определен. Откройте сделку с привязанным контактом.', 'error');
            return;
        }

        const pointsInput = document.getElementById('bonus-points-input');
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

    function renderBonusRequestsList() {
        if (bonusRequestsCache.length === 0) {
            return `<div style="text-align: center; padding: 40px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                <div style="font-size: 48px; margin-bottom: 15px;">📋</div>
                <div style="font-size: 16px; margin-bottom: 10px;">Заявок пока нет</div>
                <div style="font-size: 14px;">Нажмите "Синхронизировать" чтобы загрузить заявки из Google Таблицы</div>
            </div>`;
        }
        
        return bonusRequestsCache.map(request => {
            const statusColors = {
                'ожидает': { bg: '#fff3cd', text: '#856404', icon: '⏳' },
                'одобрено': { bg: '#d4edda', text: '#155724', icon: '✅' },
                'отклонено': { bg: '#f8d7da', text: '#721c24', icon: '❌' }
            };
            
            const statusStyle = statusColors[request.status] || statusColors['ожидает'];
            
            return `
                <div style="background: #f9f9f9; border: 2px solid #e0e0e0; border-radius: 8px; padding: 15px; margin-bottom: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
                        <div style="flex: 1;">
                            <div style="font-size: 16px; font-weight: bold; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; margin-bottom: 5px;">
                                ${request.contactName || 'Без имени'} 
                                <span style="font-size: 20px; color: #FFB8D1; margin-left: 10px;">+${request.points}</span>
                            </div>
                            <div style="font-size: 12px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                                ${request.createdAt} • ${request.manager || 'Неизвестный менеджер'}
                            </div>
                        </div>
                        <div style="display: inline-block; padding: 5px 12px; background: ${statusStyle.bg}; color: ${statusStyle.text}; border-radius: 15px; font-size: 12px; font-weight: 600; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            ${statusStyle.icon} ${request.status}
                        </div>
                    </div>
                    
                    <div style="background: white; padding: 10px; border-radius: 6px; margin-bottom: 10px;">
                        <div style="font-size: 13px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            <strong>Причина:</strong> ${request.reason}
                        </div>
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <a href="${request.leadUrl}" target="_blank" style="
                            font-size: 12px;
                            color: #FFB8D1;
                            text-decoration: none;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            font-weight: 600;
                        ">🔗 Перейти в сделку</a>
                        
                        ${isAdminAuthorized && request.status === 'ожидает' ? `
                            <div style="display: flex; gap: 10px;">
                                <button class="approve-request-btn" data-request-id="${request.requestId}" data-contact-id="${request.contactId}" data-points="${request.points}" style="
                                    padding: 8px 16px;
                                    background: #4CAF50;
                                    color: white;
                                    border: none;
                                    border-radius: 6px;
                                    cursor: pointer;
                                    font-size: 13px;
                                    font-weight: bold;
                                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                                    transition: all 0.2s;
                                ">✅ Одобрить</button>
                                
                                <button class="reject-request-btn" data-request-id="${request.requestId}" style="
                                    padding: 8px 16px;
                                    background: #FF5252;
                                    color: white;
                                    border: none;
                                    border-radius: 6px;
                                    cursor: pointer;
                                    font-size: 13px;
                                    font-weight: bold;
                                    font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                                    transition: all 0.2s;
                                ">❌ Отклонить</button>
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
                <div style="background: white; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 2px solid #e0e0e0;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Выберите период и фильтры</h3>
                    
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 15px;">
                        <button class="period-btn" data-period="today" style="
                            padding: 12px;
                            background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                            color: white;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            transition: all 0.2s;
                        ">Сегодня</button>
                        
                        <button class="period-btn" data-period="week" style="
                            padding: 12px;
                            background: #f5f5f5;
                            color: #666;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            transition: all 0.2s;
                        ">Неделя</button>
                        
                        <button class="period-btn" data-period="month" style="
                            padding: 12px;
                            background: #f5f5f5;
                            color: #666;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            transition: all 0.2s;
                        ">Месяц</button>
                        
                        <button class="period-btn" data-period="custom" style="
                            padding: 12px;
                            background: #f5f5f5;
                            color: #666;
                            border: none;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            font-weight: bold;
                            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                            transition: all 0.2s;
                        ">Произвольный</button>
                    </div>
                    
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Источник:</label>
                        <select id="source-filter" style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            <option value="all">Все источники</option>
                            <option value="F5">⚡ Автоматические (Триггеры F5)</option>
                            <option value="админ">👤 Ручные (Администратор)</option>
                        </select>
                    </div>
                    
                    <div id="custom-period-block" style="display: none; margin-bottom: 20px;">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div>
                                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Начало периода:</label>
                                <input type="date" id="custom-start-date" value="${todayStr}"
                                    style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            </div>
                            <div>
                                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">Конец периода:</label>
                                <input type="date" id="custom-end-date" value="${todayStr}"
                                    style="width: 100%; padding: 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            </div>
                        </div>
                    </div>
                    
                    <button id="load-analytics-btn" style="
                        width: 100%;
                        padding: 15px;
                        background: linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%);
                        color: white;
                        border: none;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 16px;
                        font-weight: bold;
                        font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
                        box-shadow: 0 4px 15px rgba(255, 184, 209, 0.3);
                        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    ">Загрузить аналитику</button>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-bottom: 20px;">
                    <div style="background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); padding: 25px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);">
                        <div style="font-size: 14px; color: white; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.9;">Начислено</div>
                        <div id="total-added-display" style="font-size: 36px; font-weight: bold; color: white; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            0
                        </div>
                        <div style="font-size: 14px; color: white; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.8;" id="total-added-rub">0 ₽</div>
                    </div>
                    
                    <div style="background: linear-gradient(135deg, #FF5252 0%, #E53935 100%); padding: 25px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(255, 82, 82, 0.3);">
                        <div style="font-size: 14px; color: white; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.9;">Списано</div>
                        <div id="total-subtracted-display" style="font-size: 36px; font-weight: bold; color: white; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            0
                        </div>
                        <div style="font-size: 14px; color: white; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.8;" id="total-subtracted-rub">0 ₽</div>
                    </div>
                    
                    <div style="background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%); padding: 25px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(33, 150, 243, 0.3);">
                        <div style="font-size: 14px; color: white; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.9;">Итого баллов</div>
                        <div id="total-balance-display" style="font-size: 36px; font-weight: bold; color: white; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            0
                        </div>
                        <div style="font-size: 14px; color: white; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; opacity: 0.8;" id="total-balance-rub">0 ₽</div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px;">
                    <div style="background: white; padding: 20px; border-radius: 12px; border: 2px solid #9C27B0;">
                        <div style="font-size: 13px; color: #666; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">⚡ Автоматические начисления (F5)</div>
                        <div id="f5-added-display" style="font-size: 28px; font-weight: bold; color: #9C27B0; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">0</div>
                        <div style="font-size: 12px; color: #999; margin-top: 3px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="f5-added-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="count-f5">Транзакций: 0</div>
                    </div>
                    
                    <div style="background: white; padding: 20px; border-radius: 12px; border: 2px solid #FF9800;">
                        <div style="font-size: 13px; color: #666; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">👤 Ручные операции (Админ)</div>
                        <div id="admin-operations-display" style="font-size: 28px; font-weight: bold; color: #FF9800; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">0</div>
                        <div style="font-size: 12px; color: #999; margin-top: 3px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="admin-operations-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="count-admin">Транзакций: 0</div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 30px;">
                    <div style="background: white; padding: 20px; border-radius: 12px; border: 2px solid #4CAF50;">
                        <div style="font-size: 13px; color: #666; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">📊 Среднее начисление</div>
                        <div id="avg-added-display" style="font-size: 28px; font-weight: bold; color: #4CAF50; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">0</div>
                        <div style="font-size: 12px; color: #999; margin-top: 3px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="avg-added-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="count-added">Транзакций: 0</div>
                    </div>
                    
                    <div style="background: white; padding: 20px; border-radius: 12px; border: 2px solid #FF5252;">
                        <div style="font-size: 13px; color: #666; margin-bottom: 10px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">📊 Среднее списание</div>
                        <div id="avg-subtracted-display" style="font-size: 28px; font-weight: bold; color: #FF5252; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">0</div>
                        <div style="font-size: 12px; color: #999; margin-top: 3px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="avg-subtracted-rub">0 ₽</div>
                        <div style="font-size: 11px; color: #999; margin-top: 5px; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;" id="count-subtracted">Транзакций: 0</div>
                    </div>
                </div>
                
                <div style="background: white; padding: 20px; border-radius: 12px; border: 2px solid #e0e0e0;">
                    <h3 style="margin: 0 0 20px 0; font-size: 18px; color: #333; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">История транзакций</h3>
                    
                    <div id="analytics-transactions-list" style="max-height: 500px; overflow-y: auto;">
                        <div style="text-align: center; padding: 40px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            <div style="font-size: 48px; margin-bottom: 15px;">📊</div>
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
                    b.style.background = '#f5f5f5';
                    b.style.color = '#666';
                });
                btn.style.background = 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)';
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
        loadAnalyticsBtn.onmouseover = () => {
            loadAnalyticsBtn.style.transform = 'translateY(-2px)';
            loadAnalyticsBtn.style.boxShadow = '0 8px 25px rgba(255, 184, 209, 0.5)';
        };
        loadAnalyticsBtn.onmouseout = () => {
            loadAnalyticsBtn.style.transform = 'translateY(0)';
            loadAnalyticsBtn.style.boxShadow = '0 4px 15px rgba(255, 184, 209, 0.3)';
        };
        
        loadAnalytics();
    }

    async function loadAnalytics() {
        if (!webAppUrl) {
            showNotification('Настройте URL Google Apps Script', 'warning');
            return;
        }
        
        const activePeriod = document.querySelector('.period-btn[style*="linear-gradient"]');
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
            
            if (response) {
                if (response.debug) {
                    console.log('Debug info:', response.debug);
                }
                if (response.debugDates) {
                    console.log('Даты транзакций:', response.debugDates);
                }
                analyticsCache = response;
                updateAnalyticsDisplay();
                const transCount = response.transactions ? response.transactions.length : 0;
                showNotification(`Аналитика загружена: ${transCount} транзакций`, 'success');
            }
        } catch (error) {
            console.error('Ошибка загрузки аналитики:', error);
            showNotification('Ошибка загрузки аналитики', 'error');
        }
    }

    function updateAnalyticsDisplay() {
        const addedDisplay = document.getElementById('total-added-display');
        const subtractedDisplay = document.getElementById('total-subtracted-display');
        const balanceDisplay = document.getElementById('total-balance-display');
        const addedRubDisplay = document.getElementById('total-added-rub');
        const subtractedRubDisplay = document.getElementById('total-subtracted-rub');
        const balanceRubDisplay = document.getElementById('total-balance-rub');
        
        if (addedDisplay) addedDisplay.textContent = analyticsCache.totalAdded.toFixed(2);
        if (subtractedDisplay) subtractedDisplay.textContent = analyticsCache.totalSubtracted.toFixed(2);
        if (balanceDisplay) {
            const balance = analyticsCache.totalAdded - analyticsCache.totalSubtracted;
            balanceDisplay.textContent = balance.toFixed(2);
        }
        if (addedRubDisplay) addedRubDisplay.textContent = `${analyticsCache.totalAddedRub.toFixed(2)} ₽`;
        if (subtractedRubDisplay) subtractedRubDisplay.textContent = `${analyticsCache.totalSubtractedRub.toFixed(2)} ₽`;
        if (balanceRubDisplay) {
            const balanceRub = analyticsCache.totalAddedRub - analyticsCache.totalSubtractedRub;
            balanceRubDisplay.textContent = `${balanceRub.toFixed(2)} ₽`;
        }
        
        const f5AddedDisplay = document.getElementById('f5-added-display');
        const f5AddedRubDisplay = document.getElementById('f5-added-rub');
        const adminOpsDisplay = document.getElementById('admin-operations-display');
        const adminOpsRubDisplay = document.getElementById('admin-operations-rub');
        
        if (f5AddedDisplay && analyticsCache.f5Added !== undefined) {
            f5AddedDisplay.textContent = analyticsCache.f5Added.toFixed(2);
        }
        if (f5AddedRubDisplay && analyticsCache.f5AddedRub !== undefined) {
            f5AddedRubDisplay.textContent = `${analyticsCache.f5AddedRub.toFixed(2)} ₽`;
        }
        if (adminOpsDisplay && analyticsCache.adminOperations !== undefined) {
            adminOpsDisplay.textContent = analyticsCache.adminOperations.toFixed(2);
        }
        if (adminOpsRubDisplay && analyticsCache.adminOperationsRub !== undefined) {
            adminOpsRubDisplay.textContent = `${analyticsCache.adminOperationsRub.toFixed(2)} ₽`;
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
            avgAddedDisplay.textContent = analyticsCache.avgAdded.toFixed(2);
        }
        if (avgAddedRubDisplay && analyticsCache.avgAddedRub !== undefined) {
            avgAddedRubDisplay.textContent = `${analyticsCache.avgAddedRub.toFixed(2)} ₽`;
        }
        if (countAddedDisplay && analyticsCache.countAdded !== undefined) {
            countAddedDisplay.textContent = `Транзакций: ${analyticsCache.countAdded}`;
        }
        if (avgSubtractedDisplay && analyticsCache.avgSubtracted !== undefined) {
            avgSubtractedDisplay.textContent = analyticsCache.avgSubtracted.toFixed(2);
        }
        if (avgSubtractedRubDisplay && analyticsCache.avgSubtractedRub !== undefined) {
            avgSubtractedRubDisplay.textContent = `${analyticsCache.avgSubtractedRub.toFixed(2)} ₽`;
        }
        if (countSubtractedDisplay && analyticsCache.countSubtracted !== undefined) {
            countSubtractedDisplay.textContent = `Транзакций: ${analyticsCache.countSubtracted}`;
        }
        
        const transactionsList = document.getElementById('analytics-transactions-list');
        if (transactionsList) {
            transactionsList.innerHTML = renderAnalyticsTransactions();
        }
    }

    function renderAnalyticsTransactions() {
        if (!analyticsCache.transactions || analyticsCache.transactions.length === 0) {
            return `
                <div style="text-align: center; padding: 40px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                    <div style="font-size: 48px; margin-bottom: 15px;">📋</div>
                    <div style="font-size: 16px;">Транзакций за выбранный период не найдено</div>
                </div>
            `;
        }

        const domain = window.location.hostname;

        return analyticsCache.transactions.map(transaction => {
            const isAddition = transaction.type === 'начисление';
            const bgColor = isAddition ? '#e8f5e9' : '#ffebee';
            const textColor = isAddition ? '#2e7d32' : '#c62828';
            const icon = isAddition ? '➕' : '➖';
            const sourceIcon = transaction.source === 'F5' ? '⚡' : transaction.source === 'админ' ? '👤' : '📝';

            // Формируем ссылку на контакт
            let contactHtml = '';
            if (transaction.contactName || transaction.contactId) {
                const contactName = transaction.contactName || `Контакт ${transaction.contactId}`;
                if (transaction.contactId) {
                    const contactUrl = `https://${domain}/contacts/detail/${transaction.contactId}`;
                    contactHtml = `
                        <div style="font-size: 13px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            👤 <a href="${contactUrl}" target="_blank" style="color: #FFB8D1; text-decoration: none; font-weight: 600; transition: all 0.2s;" onmouseover="this.style.color='#FF69B4'; this.style.textDecoration='underline'" onmouseout="this.style.color='#FFB8D1'; this.style.textDecoration='none'">${contactName}</a>
                        </div>
                    `;
                } else {
                    contactHtml = `
                        <div style="font-size: 13px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                            👤 ${contactName}
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
                        <div style="font-size: 13px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; margin-top: 3px;">
                            💼 <a href="${leadUrl}" target="_blank" style="color: #FFB8D1; text-decoration: none; font-weight: 600; transition: all 0.2s;" onmouseover="this.style.color='#FF69B4'; this.style.textDecoration='underline'" onmouseout="this.style.color='#FFB8D1'; this.style.textDecoration='none'">${leadName}</a>
                        </div>
                    `;
                } else {
                    leadHtml = `
                        <div style="font-size: 13px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; margin-top: 3px;">
                            💼 ${leadName}
                        </div>
                    `;
                }
            }

            return `
                <div style="background: ${bgColor}; border-left: 4px solid ${textColor}; border-radius: 8px; padding: 15px; margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
                        <div style="flex: 1;">
                            <div style="font-size: 16px; font-weight: bold; color: ${textColor}; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                                ${icon} ${transaction.type} • ${transaction.points} баллов (${transaction.points} ₽)
                            </div>
                            <div style="font-size: 12px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; margin-top: 5px;">
                                ${transaction.date}
                            </div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 12px; color: #666; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;">
                                ${sourceIcon} ${transaction.source}
                            </div>
                        </div>
                    </div>
                    ${contactHtml}
                    ${leadHtml}
                    ${transaction.manager ? `
                        <div style="font-size: 12px; color: #999; font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif; margin-top: 5px;">
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
        const reasonInput = document.getElementById('request-reason-input');
        const resultDiv = document.getElementById('request-result');
        
        const points = parseFloat(pointsInput.value);
        const reason = reasonInput.value.trim();
        
        if (!points || points <= 0) {
            showResult(resultDiv, 'Введите корректное количество баллов', 'warning');
            return;
        }
        
        if (!reason) {
            showResult(resultDiv, 'Укажите причину начисления баллов', 'warning');
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
                manager: managerName
            };
            
            const response = await makeGoogleScriptRequest('POST', requestData);
            
            if (response.success) {
                showResult(resultDiv, 'Заявка успешно создана! Ожидайте одобрения администратора.', 'success');
                pointsInput.value = '';
                reasonInput.value = '';
                
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

    function saveWebAppUrl() {
        const url = document.getElementById('webapp-url-input').value.trim();
        
        if (!url) {
            showNotification('Введите URL', 'warning');
            return;
        }

        if (!url.includes('script.google.com')) {
            showNotification('Неверный формат URL', 'warning');
            return;
        }

        webAppUrl = url;
        localStorage.setItem('promo_webapp_url', url);
        showNotification('URL сохранен', 'success');
    }

    function loadSettings() {
        webAppUrl = localStorage.getItem('promo_webapp_url') || DEFAULT_WEBAPP_URL;
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
            success: { bg: '#d4edda', border: '#c3e6cb', text: '#155724' },
            error: { bg: '#f8d7da', border: '#f5c6cb', text: '#721c24' },
            warning: { bg: '#fff3cd', border: '#ffeeba', text: '#856404' },
            info: { bg: '#d1ecf1', border: '#bee5eb', text: '#0c5460' }
        };

        const color = colors[type] || colors.info;
        container.style.background = color.bg;
        container.style.borderLeft = `4px solid ${color.border}`;
        container.style.color = color.text;
    }

    function showNotification(message, type) {
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            background: ${type === 'success' ? 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)' : type === 'error' ? 'linear-gradient(135deg, #FFB8D1 0%, #FF9EC4 100%)' : type === 'warning' ? 'linear-gradient(135deg, #FFD4E5 0%, #FFC2D4 100%)' : 'linear-gradient(135deg, #FFD4E5 0%, #FFC2D4 100%)'};
            color: white;
            border-radius: 8px;
            z-index: 10002;
            box-shadow: 0 6px 20px rgba(255, 184, 209, 0.4);
            font-size: 14px;
            font-family: 'Gotham Rounded', 'Avenir', 'Century Gothic', 'Trebuchet MS', 'Arial Rounded MT Bold', sans-serif;
            font-weight: 600;
            animation: slideIn 0.3s ease-out;
        `;

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
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
        loadSettings();
        createPromoButton();
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

