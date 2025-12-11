// ==UserScript==
// @name         amoCRM - Каталог Orange (YML)
// @namespace    http://tampermonkey.net/
// @version      9.8.0
// @description  Загрузка каталога через настраиваемый YML-фид с пользовательскими категориями и отправка в чат amoCRM
// @author       Вы
// @match        https://*.amocrm.ru/*
// @match        https://*.kommo.com/*
// @updateURL    https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20catalog%20ORANGE.user.js
// @downloadURL  https://raw.githubusercontent.com/vaytmukhambetov95-creator/tampermonkey-scripts/main/amoCRM%20-%20catalog%20ORANGE.user.js
// @grant        GM.xmlHttpRequest
// @connect      orangesmr.ru
// @connect      static.tildacdn.com
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const DEFAULT_YML_FEED_URL = 'https://orangesmr.ru/tstore/yml/66dc84e275574e304f6e3711a1aff17e.yml';
    const SCRIPT_VERSION = '9.8.0';

    // Сбрасываем кэш при обновлении версии скрипта
    (function checkVersionUpdate() {
        const savedVersion = localStorage.getItem('orange_catalog_version');
        if (savedVersion !== SCRIPT_VERSION) {
            console.log(`🔄 Обновление версии ${savedVersion} → ${SCRIPT_VERSION}, сбрасываем кэш...`);
            localStorage.removeItem('orange_yml_feed_url');
            localStorage.removeItem('orange_tilda_catalog');
            localStorage.removeItem('orange_tilda_catalog_timestamp');
            localStorage.setItem('orange_catalog_version', SCRIPT_VERSION);
        }
    })();

    let productsCache = [];

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

    // Единый шрифт для всего интерфейса - стандартный жирный
    const FONT_FAMILY = 'Arial, Helvetica, sans-serif';

    function createMainButton() {
        if (!window.location.href.includes('/leads/detail/')) return;

        // Добавляем CSS стили
        if (!document.getElementById('catalog-button-styles')) {
            const style = document.createElement('style');
            style.id = 'catalog-button-styles';
            style.textContent = `
                #tilda-catalog-main-btn {
                    background: linear-gradient(135deg, #FF69B4 0%, #FF85C8 50%, #FF69B4 100%);
                    box-shadow: 0 4px 15px rgba(255, 105, 180, 0.4);
                    cursor: pointer;
                }
                #tilda-catalog-main-btn:hover {
                    box-shadow: 0 2px 10px rgba(255, 105, 180, 0.5);
                }
                #tilda-catalog-main-btn.dragging {
                    cursor: move !important;
                    opacity: 0.9;
                }
                #tilda-catalog-overlay, #tilda-catalog-overlay * {
                    font-family: Arial, Helvetica, sans-serif !important;
                }
                #category-editor-overlay, #category-editor-overlay * {
                    font-family: Arial, Helvetica, sans-serif !important;
                }
            `;
            document.head.appendChild(style);
        }

        // Проверяем, не существует ли уже кнопка
        if (document.getElementById('tilda-catalog-main-btn')) return;

        const button = document.createElement('button');
        button.id = 'tilda-catalog-main-btn';
        button.textContent = 'Каталог';
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

        button.style.cssText = `
            position: fixed;
            left: ${posX}px;
            top: ${posY}px;
            padding: 12px 20px;
            border: none;
            border-radius: 10px;
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: bold;
            font-family: Arial, Helvetica, sans-serif;
            color: white;
            white-space: nowrap;
        `;

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
        const overlay = document.createElement('div');
        overlay.id = 'tilda-catalog-overlay';
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
            if (e.target === overlay) closeCatalogModal();
        };

        const modal = document.createElement('div');
        modal.id = 'tilda-catalog-modal';
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 1200px;
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
            background: linear-gradient(135deg, #FF6B9D 0%, #C06C84 100%);
            color: white;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        header.innerHTML = `
            <h2 style="margin: 0; font-size: 20px; font-weight: bold; font-family: Arial, Helvetica, sans-serif;">Выберите букеты для отправки</h2>
            <button id="close-modal-btn" style="
                background: transparent;
                border: none;
                color: white;
                font-size: 28px;
                cursor: pointer;
                line-height: 1;
            ">&times;</button>
        `;

        const filters = document.createElement('div');
        filters.style.cssText = `
            padding: 15px 25px;
            background: #f5f5f5;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            gap: 15px;
            align-items: center;
            flex-wrap: wrap;
        `;
        filters.innerHTML = `
            <input type="text" id="filter-search" placeholder="Поиск по названию..."
                style="flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-family: ${FONT_FAMILY}; font-size: 14px; font-weight: 600;">

            <input type="number" id="filter-price-min" placeholder="Цена от..."
                style="width: 120px; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-family: ${FONT_FAMILY}; font-size: 14px; font-weight: 600;">

            <input type="number" id="filter-price-max" placeholder="Цена до..."
                style="width: 120px; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-family: ${FONT_FAMILY}; font-size: 14px; font-weight: 600;">

            <div style="position: relative;">
                <button id="custom-category-btn" style="
                    padding: 8px 16px;
                    background: linear-gradient(135deg, #FF6B9D 0%, #C06C84 100%);
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-weight: 600;
                    font-family: ${FONT_FAMILY};
                ">📁 Мои категории <span style="font-size: 10px;">▼</span></button>
                <div id="custom-category-dropdown" style="
                    display: none;
                    position: absolute;
                    top: 100%;
                    right: 0;
                    margin-top: 5px;
                    background: white;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    padding: 10px;
                    min-width: 300px;
                    max-height: 400px;
                    overflow-y: auto;
                    z-index: 10001;
                    font-family: ${FONT_FAMILY};
                    font-weight: 600;
                "></div>
            </div>

            <button id="reset-filter-btn" style="
                padding: 8px 20px;
                background: #999;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                font-family: ${FONT_FAMILY};
                font-weight: 600;
            ">Сбросить</button>
        `;

        const galleryContainer = document.createElement('div');
        galleryContainer.id = 'tilda-gallery-container';
        galleryContainer.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 25px;
        `;

        const gallery = document.createElement('div');
        gallery.id = 'tilda-gallery';
        gallery.style.cssText = `
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 20px;
        `;

        galleryContainer.appendChild(gallery);

        const footer = document.createElement('div');
        footer.style.cssText = `
            padding: 20px 25px;
            background: #f9f9f9;
            border-top: 1px solid #e0e0e0;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        footer.innerHTML = `
            <div id="selected-count" style="font-size: 14px; color: #666; font-family: ${FONT_FAMILY}; font-weight: 600;">
                Выбрано: <strong>0</strong> товаров
            </div>
            <div style="display: flex; gap: 10px;">
                <button id="cancel-btn" style="
                    padding: 10px 20px;
                    background: #999;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-family: ${FONT_FAMILY};
                    font-weight: 600;
                ">Отмена</button>
                <button id="send-selected-btn" style="
                    padding: 10px 30px;
                    background: linear-gradient(135deg, #FF6B9D 0%, #C06C84 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    font-family: ${FONT_FAMILY};
                ">Отправить в чат</button>
            </div>
        `;

        modal.appendChild(header);
        modal.appendChild(filters);
        modal.appendChild(galleryContainer);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('close-modal-btn').onclick = closeCatalogModal;
        document.getElementById('cancel-btn').onclick = closeCatalogModal;
        document.getElementById('send-selected-btn').onclick = sendSelectedProducts;
        document.getElementById('reset-filter-btn').onclick = resetFilters;
        document.getElementById('filter-search').oninput = applyFilters;
        document.getElementById('filter-price-min').oninput = applyFilters;
        document.getElementById('filter-price-max').oninput = applyFilters;
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
            gallery.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #999; padding: 40px; font-family: ${FONT_FAMILY}; font-weight: 600;">Товары не найдены</p>`;
            return;
        }

        products.forEach(product => {
            const card = document.createElement('div');
            card.className = 'product-card';
            card.style.cssText = `
                border: 2px solid #e0e0e0;
                border-radius: 12px;
                overflow: hidden;
                transition: all 0.3s;
                cursor: pointer;
                background: white;
            `;

            card.innerHTML = `
                <div style="position: relative; padding-top: 100%; overflow: hidden; background: linear-gradient(135deg, #FFE5EC 0%, #FFC2D4 100%);">
                    <img src="${product.image}"
                         style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;">
                    <input type="checkbox"
                           data-product-id="${product.id}"
                           style="position: absolute; top: 10px; right: 10px; width: 24px; height: 24px; cursor: pointer; z-index: 2; accent-color: #FF6B9D;">
                </div>
                <div style="padding: 15px; font-family: ${FONT_FAMILY}; font-weight: 600;">
                    <h3 style="margin: 0 0 8px 0; font-size: 16px; color: #333; line-height: 1.3; font-weight: 600; font-family: ${FONT_FAMILY};">${product.title}</h3>
                    <p style="margin: 0 0 10px 0; font-size: 20px; font-weight: 600; color: #FF6B9D; font-family: ${FONT_FAMILY};">${product.price.toLocaleString('ru-RU')} ₽</p>
                    <p style="margin: 0; font-size: 12px; color: #666; line-height: 1.4; font-family: ${FONT_FAMILY}; font-weight: 600;">${product.description || ''}</p>
                </div>
            `;

            card.onmouseover = () => {
                card.style.borderColor = '#FF6B9D';
                card.style.transform = 'translateY(-4px)';
            };
            card.onmouseout = () => {
                const checkbox = card.querySelector('input[type="checkbox"]');
                card.style.borderColor = checkbox.checked ? '#FF6B9D' : '#e0e0e0';
                card.style.transform = 'translateY(0)';
            };

            card.onclick = (e) => {
                if (e.target.tagName !== 'INPUT') {
                    const checkbox = card.querySelector('input[type="checkbox"]');
                    checkbox.checked = !checkbox.checked;
                    toggleProductSelection(product.id, checkbox.checked);
                    card.style.borderColor = checkbox.checked ? '#FF6B9D' : '#e0e0e0';
                }
            };

            const checkbox = card.querySelector('input[type="checkbox"]');
            checkbox.onclick = (e) => {
                e.stopPropagation();
                toggleProductSelection(product.id, checkbox.checked);
                card.style.borderColor = checkbox.checked ? '#FF6B9D' : '#e0e0e0';
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
        if (countEl) {
            countEl.innerHTML = `Выбрано: <strong>${selectedProducts.size}</strong> ${pluralize(selectedProducts.size, 'товар', 'товара', 'товаров')}`;
        }
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
        if (dropdown.style.display === 'none' || dropdown.style.display === '') {
            renderCustomCategoryDropdown();
            dropdown.style.display = 'block';
        } else {
            dropdown.style.display = 'none';
        }
    }
    
    function renderCustomCategoryDropdown() {
        const dropdown = document.getElementById('custom-category-dropdown');
        if (!dropdown) return;
        
        loadCustomCategories();
        
        dropdown.innerHTML = '';
        
        if (customCategories.length > 0) {
            const listContainer = document.createElement('div');
            listContainer.style.cssText = 'margin-bottom: 10px; max-height: 300px; overflow-y: auto;';
            
            customCategories.forEach((cat, index) => {
                const catItem = document.createElement('div');
                catItem.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px; border-bottom: 1px solid #f0f0f0; gap: 10px;';
                
                const catInfo = document.createElement('div');
                catInfo.style.cssText = 'flex: 1; cursor: pointer;';
                catInfo.innerHTML = `
                    <div style="font-weight: 600; color: #333; margin-bottom: 2px;">${cat.name}</div>
                    <div style="font-size: 12px; color: #999;">${cat.productIds.length} ${pluralize(cat.productIds.length, 'товар', 'товара', 'товаров')}</div>
                `;
                catInfo.onclick = () => loadCategoryProducts(index);
                
                const btnContainer = document.createElement('div');
                btnContainer.style.cssText = 'display: flex; gap: 5px;';
                
                const editBtn = document.createElement('button');
                editBtn.textContent = '✏️';
                editBtn.style.cssText = 'padding: 4px 8px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
                editBtn.onclick = () => editCategory(index);
                
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '🗑️';
                deleteBtn.style.cssText = 'padding: 4px 8px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;';
                deleteBtn.onclick = () => deleteCategory(index);
                
                btnContainer.appendChild(editBtn);
                btnContainer.appendChild(deleteBtn);
                
                catItem.appendChild(catInfo);
                catItem.appendChild(btnContainer);
                listContainer.appendChild(catItem);
            });
            
            dropdown.appendChild(listContainer);
        } else {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding: 10px; text-align: center; color: #999;';
            emptyMsg.textContent = 'Нет сохранённых категорий';
            dropdown.appendChild(emptyMsg);
        }
        
        const addBtn = document.createElement('button');
        addBtn.id = 'add-category-btn';
        addBtn.textContent = '➕ Добавить категорию';
        addBtn.style.cssText = 'width: 100%; padding: 10px; background: linear-gradient(135deg, #FF6B9D 0%, #C06C84 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold; margin-top: 10px; font-family: Arial, Helvetica, sans-serif;';
        addBtn.onclick = (e) => {
            e.stopPropagation();
            openCategoryEditor();
        };
        
        const exportBtn = document.createElement('button');
        exportBtn.textContent = '📥 Экспортировать категории';
        exportBtn.style.cssText = 'width: 100%; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold; margin-top: 5px; font-family: Arial, Helvetica, sans-serif;';
        exportBtn.onclick = (e) => {
            e.stopPropagation();
            exportCategories();
        };
        
        const importBtn = document.createElement('button');
        importBtn.textContent = '📤 Импортировать категории';
        importBtn.style.cssText = 'width: 100%; padding: 10px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold; margin-top: 5px; font-family: Arial, Helvetica, sans-serif;';
        importBtn.onclick = (e) => {
            e.stopPropagation();
            importCategories();
        };
        
        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = '🔄 Обновить каталог';
        refreshBtn.style.cssText = 'width: 100%; padding: 10px; background: #FF9800; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: bold; margin-top: 10px; font-family: Arial, Helvetica, sans-serif;';
        refreshBtn.onclick = (e) => {
            e.stopPropagation();
            refreshCatalog();
        };

        dropdown.appendChild(addBtn);
        dropdown.appendChild(exportBtn);
        dropdown.appendChild(importBtn);
        dropdown.appendChild(refreshBtn);
    }
    
    function loadCategoryProducts(index) {
        const category = customCategories[index];
        if (!category) return;
        
        const filtered = productsCache.filter(p => category.productIds.includes(p.id));
        renderGallery(filtered);
        
        const dropdown = document.getElementById('custom-category-dropdown');
        if (dropdown) dropdown.style.display = 'none';
        
        showNotification(`📁 Загружена категория: ${category.name}`, 'info');
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
            showNotification('✅ Категория удалена', 'success');
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
        showNotification('✅ Категории экспортированы!', 'success');
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
        if (!confirm('Обновить каталог товаров из YML-фида?\n\nТекущий кэш будет очищен и загружены актуальные данные.')) {
            return;
        }
        
        showNotification('🔄 Обновление каталога...', 'info');
        
        localStorage.removeItem('orange_tilda_catalog');
        localStorage.removeItem('orange_tilda_catalog_timestamp');
        
        try {
            const products = await loadYMLFeed();
            
            if (products && products.length > 0) {
                productsCache = products;
                saveCatalogToCache(products);
                
                renderGallery(products);
                
                const dropdown = document.getElementById('custom-category-dropdown');
                if (dropdown) dropdown.style.display = 'none';
                
                showNotification(`✅ Каталог обновлён! Загружено ${products.length} ${pluralize(products.length, 'товар', 'товара', 'товаров')}`, 'success');
            } else {
                showNotification('⚠️ Не удалось загрузить товары', 'error');
            }
        } catch (error) {
            console.error('Ошибка обновления каталога:', error);
            showNotification('❌ Ошибка обновления: ' + error.message, 'error');
        }
    }

    function applyFilters() {
        const searchText = document.getElementById('filter-search')?.value.toLowerCase() || '';
        const priceMin = parseFloat(document.getElementById('filter-price-min')?.value) || 0;
        const priceMax = parseFloat(document.getElementById('filter-price-max')?.value) || Infinity;
        
        const filtered = productsCache.filter(p => {
            const matchesSearch = p.title.toLowerCase().includes(searchText);
            const matchesPrice = p.price >= priceMin && p.price <= priceMax;
            
            return matchesSearch && matchesPrice;
        });
        
        renderGallery(filtered);
    }

    function resetFilters() {
        document.getElementById('filter-search').value = '';
        document.getElementById('filter-price-min').value = '';
        document.getElementById('filter-price-max').value = '';
        
        renderGallery(productsCache);
    }

    function openCatalogModal() {
        let overlay = document.getElementById('tilda-catalog-overlay');

        if (!overlay) {
            createModal();
            overlay = document.getElementById('tilda-catalog-overlay');
        }

        overlay.style.display = 'block';
        selectedProducts.clear();
        updateSelectedCount();
        renderGallery(productsCache);
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
            showNotification('❌ Откройте чат в сделке перед отправкой!', 'error');
            return;
        }

        const selectedItems = productsCache.filter(p => selectedProducts.has(p.id));

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
            showNotification('✅ Все товары отправлены!', 'success');
        } catch (error) {
            console.error('Ошибка отправки:', error);
            showNotification('❌ Ошибка: ' + error.message, 'error');
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
                const price = `${product.price.toLocaleString('ru-RU')} ₽`;
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
                
                ctx.font = `bold ${titleFontSize}px Arial, Helvetica, sans-serif`;
                ctx.fillText(title, titleX, titleY);

                ctx.font = `bold ${priceFontSize}px Arial, Helvetica, sans-serif`;
                ctx.fillText(price, titleX, priceY);

                ctx.font = `bold ${deliveryFontSize}px Arial, Helvetica, sans-serif`;
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
        currentCategoryEdit = editIndex;
        
        const isEdit = editIndex !== null;
        const category = isEdit ? customCategories[editIndex] : null;
        
        const editorOverlay = document.createElement('div');
        editorOverlay.id = 'category-editor-overlay';
        editorOverlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10003;
            backdrop-filter: blur(5px);
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        
        const editor = document.createElement('div');
        editor.style.cssText = `
            background: white;
            border-radius: 12px;
            padding: 30px;
            width: 90%;
            max-width: 900px;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        `;
        
        editor.innerHTML = `
            <h2 style="margin: 0 0 20px 0; color: #333;">${isEdit ? 'Редактирование категории' : 'Создание категории'}</h2>
            
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333;">Название категории:</label>
                <input type="text" id="category-name-input" value="${isEdit ? category.name : ''}" 
                    placeholder="Введите название..."
                    style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px;">
            </div>
            
            <div style="margin-bottom: 20px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 600; color: #333;">Выберите товары:</label>
                <input type="text" id="category-product-search" placeholder="Поиск товаров..."
                    style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; margin-bottom: 10px;">
                <div id="category-products-grid" style="
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                    gap: 15px;
                    max-height: 400px;
                    overflow-y: auto;
                    padding: 10px;
                    border: 1px solid #e0e0e0;
                    border-radius: 6px;
                "></div>
            </div>
            
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
                <button id="category-cancel-btn" style="
                    padding: 10px 20px;
                    background: #999;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                ">Отмена</button>
                <button id="category-save-btn" style="
                    padding: 10px 30px;
                    background: linear-gradient(135deg, #FF6B9D 0%, #C06C84 100%);
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                ">Сохранить</button>
            </div>
        `;
        
        editorOverlay.appendChild(editor);
        document.body.appendChild(editorOverlay);
        
        const selectedProductIds = isEdit ? new Set(category.productIds) : new Set();
        
        function renderProductGrid(searchText = '') {
            const grid = document.getElementById('category-products-grid');
            const filtered = productsCache.filter(p => 
                p.title.toLowerCase().includes(searchText.toLowerCase())
            );
            
            grid.innerHTML = filtered.map(p => `
                <div style="
                    border: 2px solid ${selectedProductIds.has(p.id) ? '#FF6B9D' : '#e0e0e0'};
                    border-radius: 8px;
                    overflow: hidden;
                    cursor: pointer;
                    transition: all 0.2s;
                    position: relative;
                " data-product-id="${p.id}">
                    <div style="position: relative; padding-top: 100%; overflow: hidden; background: #f5f5f5;">
                        <img src="${p.image}" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;">
                        <div style="
                            position: absolute;
                            top: 5px;
                            right: 5px;
                            width: 20px;
                            height: 20px;
                            background: ${selectedProductIds.has(p.id) ? '#FF6B9D' : 'white'};
                            border: 2px solid ${selectedProductIds.has(p.id) ? '#FF6B9D' : '#ddd'};
                            border-radius: 4px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: white;
                            font-size: 14px;
                            font-weight: bold;
                        ">${selectedProductIds.has(p.id) ? '✓' : ''}</div>
                    </div>
                    <div style="padding: 8px;">
                        <div style="font-size: 12px; font-weight: 600; color: #333; line-height: 1.2;">${p.title}</div>
                        <div style="font-size: 12px; font-weight: bold; color: #FF6B9D; margin-top: 4px;">${p.price.toLocaleString('ru-RU')} ₽</div>
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
                showNotification('✅ Категория обновлена!', 'success');
            } else {
                customCategories.push(categoryData);
                showNotification('✅ Категория создана!', 'success');
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

    function getCachedCatalog() {
        try {
            const cached = localStorage.getItem('orange_tilda_catalog');
            const timestamp = localStorage.getItem('orange_tilda_catalog_timestamp');
            
            if (cached && timestamp) {
                const age = Date.now() - parseInt(timestamp);
                const maxAge = 1 * 60 * 60 * 1000; // 1 час

                if (age < maxAge) {
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

    function saveCatalogToCache(products) {
        try {
            localStorage.setItem('orange_tilda_catalog', JSON.stringify(products));
            localStorage.setItem('orange_tilda_catalog_timestamp', Date.now().toString());
            console.log(`Каталог сохранен в кэш (${products.length} товаров)`);
        } catch (error) {
            console.error('Ошибка сохранения кэша:', error);
        }
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
            id: key,  // Стабильный ID из YML-фида
            title: product.title,
            price: product.price,
            image: product.image,
            description: product.description,
            url: product.url,
            category: product.category
        }));

        console.log(`После удаления дублей осталось ${products.length} товаров`);

        // Сортируем по названию для стабильного порядка отображения
        return products.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    }
    
    function cleanProductTitle(title) {
        let cleanTitle = title;
        
        cleanTitle = cleanTitle.replace(/\s*-\s*Как на фото\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-?\s*Роскошный\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-?\s*VIP\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-?\s*Вы наш герой\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-\s*Роскошный\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*-\s*VIP\s*/gi, '');
        cleanTitle = cleanTitle.replace(/\s*\(на \d+% (больше )?цветов( больше)?\)\s*/gi, '');
        
        cleanTitle = cleanTitle.trim();
        
        return cleanTitle;
    }

    async function loadTildaCatalog() {
        try {
            return await loadYMLFeed();
                            } catch (error) {
            console.error('❌ Ошибка загрузки YML-фида:', error);
            throw error;
        }
    }

    function showNotification(message, type) {
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 25px;
            background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#2196F3'};
            color: white;
            border-radius: 6px;
            z-index: 10002;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            font-size: 14px;
            font-weight: bold;
            font-family: Arial, Helvetica, sans-serif;
            animation: slideIn 0.3s ease-out;
        `;

        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    }

    async function initCatalog() {
        console.log('Инициализация каталога...');
        
        const cached = getCachedCatalog();
        
        if (cached && cached.length > 0) {
            productsCache = cached;
            console.log(`✅ Каталог загружен из кэша: ${productsCache.length} товаров`);
            return;
        }
        
        console.log('Кэш пуст или устарел, загружаем YML-фид...');
        showNotification('🔄 Загрузка каталога из YML-фида...', 'info');
        
        try {
            const products = await loadTildaCatalog();
            
            if (products && products.length > 0) {
                productsCache = products;
                saveCatalogToCache(products);
                console.log(`✅ Каталог обновлен: ${products.length} товаров`);
                showNotification(`✅ Каталог обновлен! Загружено ${products.length} товаров`, 'success');
            } else {
                console.warn('⚠️ Получен пустой каталог, используем локальные данные');
                showNotification('⚠️ Используется локальный каталог', 'info');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки каталога:', error);
            showNotification(`⚠️ Ошибка загрузки YML: ${error.message}. Используются локальные данные.`, 'info');
        }
    }

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
