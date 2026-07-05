import { extension_settings, saveSettingsDebounced, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

const EXTENSION_NAME = 'audience-view';

const DEFAULT_SETTINGS = {
    enabled: false,
    autoGenerate: false,
    commentCount: 6,
    recentMessageCount: 12,
    activeTemplateId: 'novel-audience',
    apiMode: 'custom',
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.9,
    maxTokens: 800,
    templates: [],
    comments: []
};

const FALLBACK_TEMPLATES = [
    {
        id: 'novel-audience',
        name: '小说读者弹幕',
        content: `你正在扮演一群正在以上帝视角阅读聊天内容的小说读者。请根据最近剧情生成观众评论。

要求：
- 评论要像读者在章节评论区、弹幕、论坛里发言。
- 可以吐槽剧情、分析角色动机、磕 CP、预测后续、心疼角色、发疯、阴阳怪气。
- 不要改写原剧情，不要替角色继续对话。
- 每条评论要有一个观众昵称。
- 输出 JSON 数组，不要输出 Markdown。

输出格式：
[
  {"name":"观众昵称","type":"吐槽/磕CP/分析/震惊/心疼/预测/发疯","text":"评论内容"}
]

最近剧情：
{{chat}}`
    },
    {
        id: 'manga-barrage',
        name: '漫画弹幕吐槽',
        content: `你正在扮演一群正在观看漫画分镜的观众。聊天记录就是漫画剧情。请生成即时弹幕评论。

风格：
- 短句为主，像漫画平台弹幕。
- 可以玩梗、吐槽、嗑 CP、尖叫、震惊、心疼。
- 有些观众可以互相接话，但不要形成长篇对话。
- 不要剧透聊天记录以外的内容。
- 输出 JSON 数组，不要输出 Markdown。

输出格式：
[
  {"name":"观众昵称","type":"弹幕","text":"评论内容"}
]

当前漫画剧情：
{{chat}}`
    }
];

let isGenerating = false;

function getSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[EXTENSION_NAME];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }

    if (!Array.isArray(settings.templates) || settings.templates.length === 0) {
        settings.templates = structuredClone(FALLBACK_TEMPLATES);
    }

    if (!Array.isArray(settings.comments)) {
        settings.comments = [];
    }

    return settings;
}

function saveSettings() {
    saveSettingsDebounced();
}

function htmlEscape(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function uid(prefix = 'id') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveTemplate() {
    const settings = getSettings();
    return settings.templates.find(template => template.id === settings.activeTemplateId) || settings.templates[0];
}

function getRecentChatText() {
    const settings = getSettings();
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const recent = chat.slice(-Number(settings.recentMessageCount || 12));

    return recent.map(message => {
        const name = message.name || message.sender || (message.is_user ? 'User' : 'Character');
        const text = message.mes || message.message || '';
        return `${name}: ${text}`;
    }).join('\n\n');
}

function buildPrompt() {
    const settings = getSettings();
    const template = getActiveTemplate();
    const chat = getRecentChatText();

    return template.content
        .replaceAll('{{chat}}', chat)
        .replaceAll('{{commentCount}}', String(settings.commentCount));
}

function normalizeApiUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return '';

    if (trimmed.endsWith('/chat/completions')) {
        return trimmed;
    }

    return trimmed.replace(/\/$/, '') + '/chat/completions';
}

async function callCustomApi(prompt) {
    const settings = getSettings();
    const url = normalizeApiUrl(settings.apiUrl);

    if (!url) {
        throw new Error('请先填写独立 API 地址。');
    }

    if (!settings.model) {
        throw new Error('请先填写模型名称。');
    }

    const headers = {
        'Content-Type': 'application/json'
    };

    if (settings.apiKey) {
        headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: settings.model,
            temperature: Number(settings.temperature || 0.9),
            max_tokens: Number(settings.maxTokens || 800),
            messages: [
                {
                    role: 'system',
                    content: '你是一个只输出有效 JSON 的观众评论生成器。'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ]
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API 请求失败：${response.status} ${text}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || '';
}

function parseComments(rawText) {
    const cleaned = String(rawText || '')
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            return parsed.map(item => ({
                id: uid('comment'),
                name: String(item.name || '匿名观众'),
                type: String(item.type || '评论'),
                text: String(item.text || item.comment || ''),
                createdAt: new Date().toISOString()
            })).filter(item => item.text.trim());
        }
    } catch {
        // Fall through to line parser.
    }

    return cleaned
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => ({
            id: uid('comment'),
            name: '匿名观众',
            type: '评论',
            text: line.replace(/^[-*]\s*/, ''),
            createdAt: new Date().toISOString()
        }));
}

async function generateAudienceComments() {
    const settings = getSettings();

    if (!settings.enabled || isGenerating) {
        return;
    }

    const chatText = getRecentChatText();
    if (!chatText.trim()) {
        renderStatus('当前聊天为空，无法生成观众评论。', true);
        return;
    }

    isGenerating = true;
    renderStatus('正在生成观众评论...', false);
    renderPanel();

    try {
        const prompt = buildPrompt();
        const raw = await callCustomApi(prompt);
        const comments = parseComments(raw).slice(0, Number(settings.commentCount || 6));

        if (comments.length === 0) {
            throw new Error('API 没有返回可用评论。');
        }

        settings.comments.unshift(...comments);
        settings.comments = settings.comments.slice(0, 200);
        saveSettings();

        renderStatus(`已生成 ${comments.length} 条观众评论。`, false);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}]`, error);
        renderStatus(error.message || '生成失败。', true);
    } finally {
        isGenerating = false;
        renderPanel();
    }
}

function renderStatus(message, isError) {
    const node = document.querySelector('#av-status');
    if (!node) return;

    node.textContent = message || '';
    node.classList.toggle('av-error', Boolean(isError));
}

function renderCommentList() {
    const settings = getSettings();

    if (settings.comments.length === 0) {
        return '<div class="av-empty">暂无观众评论</div>';
    }

    return settings.comments.map(comment => `
        <div class="av-comment">
            <div class="av-comment-head">
                <span class="av-comment-name">${htmlEscape(comment.name)}</span>
                <span class="av-comment-type">${htmlEscape(comment.type)}</span>
            </div>
            <div class="av-comment-text">${htmlEscape(comment.text)}</div>
        </div>
    `).join('');
}

function renderTemplateOptions() {
    const settings = getSettings();

    return settings.templates.map(template => `
        <option value="${htmlEscape(template.id)}" ${template.id === settings.activeTemplateId ? 'selected' : ''}>
            ${htmlEscape(template.name)}
        </option>
    `).join('');
}

function renderPanel() {
    const settings = getSettings();
    const activeTemplate = getActiveTemplate();

    $('#audience-view-panel').html(`
        <div class="av-shell">
            <div class="av-header">
                <div>
                    <div class="av-title">Audience View</div>
                    <div class="av-subtitle">上帝视角观众评论区</div>
                </div>
                <label class="av-switch">
                    <input id="av-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    <span>启用</span>
                </label>
            </div>

            <div class="av-grid">
                <section class="av-section">
                    <div class="av-section-title">生成</div>

                    <label class="av-row">
                        <span>自动生成</span>
                        <input id="av-auto-generate" type="checkbox" ${settings.autoGenerate ? 'checked' : ''}>
                    </label>

                    <label class="av-row">
                        <span>评论数量</span>
                        <input id="av-comment-count" type="number" min="1" max="20" value="${htmlEscape(settings.commentCount)}">
                    </label>

                    <label class="av-row">
                        <span>读取最近消息数</span>
                        <input id="av-recent-count" type="number" min="2" max="80" value="${htmlEscape(settings.recentMessageCount)}">
                    </label>

                    <button id="av-generate" class="menu_button" ${isGenerating ? 'disabled' : ''}>
                        ${isGenerating ? '生成中...' : '生成观众评论'}
                    </button>

                    <button id="av-clear-comments" class="menu_button danger">
                        清空评论
                    </button>

                    <div id="av-status" class="av-status"></div>
                </section>

                <section class="av-section">
                    <div class="av-section-title">独立 API</div>

                    <label class="av-field">
                        <span>API 地址</span>
                        <input id="av-api-url" type="text" placeholder="https://api.openai.com/v1" value="${htmlEscape(settings.apiUrl)}">
                    </label>

                    <label class="av-field">
                        <span>API Key</span>
                        <input id="av-api-key" type="password" placeholder="sk-..." value="${htmlEscape(settings.apiKey)}">
                    </label>

                    <label class="av-field">
                        <span>模型</span>
                        <input id="av-model" type="text" placeholder="gpt-4o-mini" value="${htmlEscape(settings.model)}">
                    </label>

                    <div class="av-two">
                        <label class="av-field">
                            <span>Temperature</span>
                            <input id="av-temperature" type="number" min="0" max="2" step="0.1" value="${htmlEscape(settings.temperature)}">
                        </label>

                        <label class="av-field">
                            <span>Max tokens</span>
                            <input id="av-max-tokens" type="number" min="100" max="4000" step="50" value="${htmlEscape(settings.maxTokens)}">
                        </label>
                    </div>
                </section>
            </div>

            <section class="av-section av-template-section">
                <div class="av-section-head">
                    <div class="av-section-title">回复模板</div>
                    <div class="av-actions">
                        <button id="av-add-template" class="menu_button">新增模板</button>
                        <button id="av-delete-template" class="menu_button danger">删除模板</button>
                    </div>
                </div>

                <label class="av-field">
                    <span>当前模板</span>
                    <select id="av-template-select">
                        ${renderTemplateOptions()}
                    </select>
                </label>

                <label class="av-field">
                    <span>模板名称</span>
                    <input id="av-template-name" type="text" value="${htmlEscape(activeTemplate?.name || '')}">
                </label>

                <label class="av-field">
                    <span>模板内容</span>
                    <textarea id="av-template-content" spellcheck="false">${htmlEscape(activeTemplate?.content || '')}</textarea>
                </label>

                <div class="av-hint">
                    可用变量：{{chat}} 当前聊天片段，{{commentCount}} 评论数量。
                </div>
            </section>

            <section class="av-section">
                <div class="av-section-title">观众评论</div>
                <div class="av-comments">
                    ${renderCommentList()}
                </div>
            </section>
        </div>
    `);

    bindPanelEvents();
}

function bindPanelEvents() {
    const settings = getSettings();

    $('#av-enabled').on('change', function () {
        settings.enabled = this.checked;
        saveSettings();
    });

    $('#av-auto-generate').on('change', function () {
        settings.autoGenerate = this.checked;
        saveSettings();
    });

    $('#av-comment-count').on('change', function () {
        settings.commentCount = Math.max(1, Math.min(20, Number(this.value || 6)));
        saveSettings();
    });

    $('#av-recent-count').on('change', function () {
        settings.recentMessageCount = Math.max(2, Math.min(80, Number(this.value || 12)));
        saveSettings();
    });

    $('#av-api-url').on('input', function () {
        settings.apiUrl = this.value;
        saveSettings();
    });

    $('#av-api-key').on('input', function () {
        settings.apiKey = this.value;
        saveSettings();
    });

    $('#av-model').on('input', function () {
        settings.model = this.value;
        saveSettings();
    });

    $('#av-temperature').on('change', function () {
        settings.temperature = Number(this.value || 0.9);
        saveSettings();
    });

    $('#av-max-tokens').on('change', function () {
        settings.maxTokens = Number(this.value || 800);
        saveSettings();
    });

    $('#av-generate').on('click', generateAudienceComments);

    $('#av-clear-comments').on('click', function () {
        settings.comments = [];
        saveSettings();
        renderPanel();
    });

    $('#av-template-select').on('change', function () {
        settings.activeTemplateId = this.value;
        saveSettings();
        renderPanel();
    });

    $('#av-template-name').on('input', function () {
        const template = getActiveTemplate();
        if (!template) return;

        template.name = this.value;
        saveSettings();
    });

    $('#av-template-content').on('input', function () {
        const template = getActiveTemplate();
        if (!template) return;

        template.content = this.value;
        saveSettings();
    });

    $('#av-add-template').on('click', function () {
        const template = {
            id: uid('template'),
            name: '新观众模板',
            content: `请根据以下聊天内容生成观众评论。

要求：
- 输出 JSON 数组。
- 每项包含 name、type、text。
- 不要继续原聊天。

聊天内容：
{{chat}}`
        };

        settings.templates.push(template);
        settings.activeTemplateId = template.id;
        saveSettings();
        renderPanel();
    });

    $('#av-delete-template').on('click', function () {
        if (settings.templates.length <= 1) {
            renderStatus('至少需要保留一个模板。', true);
            return;
        }

        const index = settings.templates.findIndex(template => template.id === settings.activeTemplateId);
        if (index >= 0) {
            settings.templates.splice(index, 1);
            settings.activeTemplateId = settings.templates[0].id;
            saveSettings();
            renderPanel();
        }
    });
}

function createDrawer() {
    if ($('#audience-view-panel').length) {
        return;
    }

    const panel = $(`
        <div id="audience-view-panel" class="audience-view-panel">
        </div>
    `);

    const button = $(`
        <div id="audience-view-button" class="list-group-item flex-container flexGap5">
            <span>Audience View</span>
        </div>
    `);

    button.on('click', function () {
        panel.toggleClass('open');
    });

    $('body').append(panel);

    const extensionsMenu = $('#extensionsMenu');
    if (extensionsMenu.length) {
        extensionsMenu.append(button);
    } else {
        $('body').append(button);
    }

    renderPanel();
}

function setupAutoGeneration() {
    const handler = async () => {
        const settings = getSettings();

        if (!settings.enabled || !settings.autoGenerate) {
            return;
        }

        await generateAudienceComments();
    };

    eventSource.on(event_types.MESSAGE_RECEIVED, handler);
    eventSource.on(event_types.MESSAGE_SENT, handler);
}

jQuery(async () => {
    getSettings();
    createDrawer();
    setupAutoGeneration();
});