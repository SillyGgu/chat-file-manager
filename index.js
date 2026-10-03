import { getRequestHeaders, is_send_press, isChatSaving, saveChatConditional, displayPastChats } from '../../../../script.js';
import { is_group_generating } from '../../../group-chats.js';
import { getContext } from '../../../st-context.js';
import { MAX_BYTES, safeName, groupLabel, renamePlan, parseChat, validateBundle } from './core.mjs';
import { ChatService } from './operations.mjs';
import { previewMessage, displayPlainText } from './preview.mjs';
import { handleDialogCancel, handleFileCancel } from './dialog-events.mjs';

const el = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
};
const button = (text, action, className = '') => {
    const node = el('button', `cfm-button ${className}`, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
};
function ownerNow() {
    const c = getContext();
    if (c.groupId) return { kind: 'group', groupId: c.groupId, label: c.groups.find(g => g.id === c.groupId)?.name || '그룹' };
    const char = c.characters[c.characterId];
    if (!char?.avatar) throw new Error('먼저 캐릭터 또는 그룹 채팅을 열어 주세요.');
    return { kind: 'character', avatar: char.avatar, label: char.name };
}
const sameOwner = (a, b) => a.kind === b.kind && (a.kind === 'character' ? a.avatar === b.avatar : a.groupId === b.groupId);
async function request(url, body) {
    const form = body instanceof FormData;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
        const response = await fetch(url, {
            method: 'POST', headers: getRequestHeaders({ omitContentType: form }), signal: controller.signal,
            body: form ? body : JSON.stringify(body), cache: 'no-store',
        });
        if (!response.ok) throw new Error(`요청 실패 (${response.status}). 변경 요청은 자동 재시도하지 않습니다.`);
        const result = await response.json();
        if (result?.error) throw new Error('ST가 요청을 거절했습니다. 목록을 다시 확인해 주세요.');
        return result;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('45초 내 응답이 없어 중단했습니다. 서버에서는 처리되었을 수 있습니다. 자동 재시도하지 마세요.');
        throw error;
    } finally { clearTimeout(timer); }
}
function download(bundle, reason = 'backup') {
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat-${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}.stcb.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function review(title, lines, { backup = false, phrase = '', note = '' } = {}) {
    return new Promise(resolve => {
        const modal = el('dialog', 'cfm-review');
        modal.append(el('h3', '', title), el('p', 'cfm-note', note));
        const list = el('ul', 'cfm-review-list');
        for (const line of lines) list.append(el('li', '', line));
        modal.append(list);
        let ack, input;
        if (backup) {
            const label = el('label', 'cfm-ack');
            ack = el('input'); ack.type = 'checkbox';
            label.append(ack, document.createTextNode(' 내려받은 백업 파일이 실제 저장되었음을 확인했습니다.'));
            modal.append(label);
        }
        if (phrase) {
            const label = el('label', 'cfm-phrase', `아래에 정확히 입력: ${phrase}`);
            input = el('input', 'text_pole'); input.autocomplete = 'off'; input.spellcheck = false;
            label.append(input); modal.append(label);
        }
        const actions = el('div', 'cfm-actions');
        const finish = value => { modal.close(); modal.remove(); resolve(value); };
        const confirm = button(phrase ? '영구 삭제' : '확인 후 실행', () => finish(true), phrase ? 'cfm-danger' : 'cfm-primary');
        const update = () => { confirm.disabled = (!!ack && !ack.checked) || (!!input && input.value !== phrase); };
        ack?.addEventListener('change', update); input?.addEventListener('input', update);
        actions.append(button('취소', () => finish(false)), confirm);
        modal.append(actions); update();
        modal.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
        document.body.append(modal); modal.showModal();
    });
}

let manager;
class Manager {
    constructor(owner) {
        this.owner = owner;
        this.rows = []; this.selected = new Set(); this.drafts = new Map(); this.closedGroups = new Set();
        this.selectMode = false; this.busy = false; this.versionOK = false; this.previewToken = 0;
        this.useDisplayText = true;
        this.dialog = el('dialog', 'cfm-dialog');
        this.dialog.setAttribute('aria-label', '채팅 파일 관리');
        const head = el('header', 'cfm-head');
        const heading = el('div');
        heading.append(el('h2', '', '채팅 파일 관리'), el('div', 'cfm-subtitle', owner.label));
        head.append(heading, button('닫기', () => this.close()));
        this.search = el('input', 'text_pole cfm-search');
        this.search.placeholder = '제목 · 마지막 메시지 검색'; this.search.setAttribute('aria-label', '채팅 검색');
        this.search.addEventListener('input', () => this.render());
        this.modeBtn = button('선택', () => { this.selectMode = !this.selectMode; this.render(); });
        this.allBtn = button('전체 선택', () => { this.rows.forEach(r => this.selected.add(r.file_name)); this.render(); });
        this.noneBtn = button('선택 해제', () => { this.selected.clear(); this.render(); });
        this.backupBtn = button('묶음 백업', () => this.run(() => this.backup()));
        this.deleteBtn = button('삭제', () => this.run(() => this.deleteSelected()), 'cfm-danger');
        this.renameBtn = button('제목 변경 적용', () => this.run(() => this.applyNames()), 'cfm-primary');
        this.restoreBtn = button('묶음 가져오기', () => this.file.click());
        this.refreshBtn = button('새로고침', () => this.run(() => this.refresh()));
        this.file = el('input'); this.file.type = 'file'; this.file.accept = '.json,.stcb.json'; this.file.hidden = true;
        this.file.addEventListener('cancel', e => handleFileCancel(e, this.file, text => this.message(text)));
        this.file.addEventListener('change', e => {
            e.stopPropagation();
            const file = this.file.files[0]; this.file.value = '';
            if (file) this.run(() => this.restore(file));
        });
        const toolbar = el('div', 'cfm-toolbar');
        toolbar.append(this.search, this.modeBtn, this.allBtn, this.noneBtn, this.backupBtn, this.deleteBtn, this.restoreBtn, this.renameBtn, this.refreshBtn, this.file);
        this.count = el('div', 'cfm-count');
        this.status = el('div', 'cfm-status', '읽는 중…'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        this.list = el('div', 'cfm-list');
        this.preview = el('aside', 'cfm-preview');
        this.preview.append(el('div', 'cfm-empty', '행의 미리보기를 눌러 대화 내용을 확인하세요.'));
        const content = el('div', 'cfm-content'); content.append(this.list, this.preview);
        const replace = el('div', 'cfm-replace');
        this.find = el('input', 'text_pole'); this.find.placeholder = '제목에서 찾을 문자열'; this.find.setAttribute('aria-label', '제목 교체 원문');
        this.replacement = el('input', 'text_pole'); this.replacement.placeholder = '바꿀 문자열'; this.replacement.setAttribute('aria-label', '제목 교체 결과');
        this.replaceBtn = button('제목 교체 초안', () => {
            if (!this.find.value) return this.message('찾을 문자열을 입력하세요.', true);
            const rows = this.rows.filter(r => (!this.selectMode || this.selected.has(r.file_name)) && r.file_name !== getContext().chatId);
            for (const r of rows) this.drafts.set(r.file_name, (this.drafts.get(r.file_name) ?? r.file_name).split(this.find.value).join(this.replacement.value));
            this.render();
        });
        this.resetBtn = button('초안 취소', () => { this.drafts.clear(); this.render(); });
        replace.append(this.find, this.replacement, this.replaceBtn, this.resetBtn);
        this.dialog.append(head, toolbar, replace, this.count, content, this.status);
        this.dialog.addEventListener('cancel', e => handleDialogCancel(e, this.dialog, () => this.close()));
        this.service = new ChatService({ owner, request, guard: (write, name) => this.guard(write, name),
            emit: (type, data) => getContext().eventSource.emit(getContext().eventTypes[type], data),
            progress: text => this.message(text) });
        this.onChanged = () => {
            if (!sameOwner(this.owner, ownerNowSafe())) {
                this.previewToken++; this.preview.replaceChildren();
                this.message('캐릭터가 변경되었습니다. 이 창을 닫고 다시 열어 주세요.', true);
            }
            this.updateControls();
        };
        getContext().eventSource.on(getContext().eventTypes.CHAT_CHANGED, this.onChanged);
    }
    guard(write, name) {
        if (!sameOwner(this.owner, ownerNowSafe())) throw new Error('대상 캐릭터가 바뀌어 작업을 중단했습니다.');
        if (write) {
            if (!this.versionOK || this.owner.kind !== 'character') throw new Error('변경 작업은 ST 1.19.x의 캐릭터 채팅에서 지원합니다.');
            if (is_send_press || is_group_generating || isChatSaving) throw new Error('생성·저장 중입니다. 완료 후 다시 시도해 주세요.');
            if (name && name === getContext().chatId) throw new Error('현재 열린 채팅은 삭제·일괄 이름 변경에서 보호됩니다.');
        }
    }
    message(text, error = false) {
        this.status.textContent = text; this.status.classList.toggle('cfm-error', error);
    }
    async open() {
        document.body.append(this.dialog); this.dialog.showModal();
        await this.run(async () => {
            const response = await fetch('/version', { cache: 'no-store' });
            if (!response.ok) throw new Error('ST 버전을 확인할 수 없습니다.');
            const version = (await response.json()).pkgVersion;
            this.versionOK = /^1\.19\.\d+$/u.test(version);
            await this.refresh();
            this.message(this.owner.kind === 'group' ? '그룹: 조회·미리보기·백업만 지원합니다.'
                : this.versionOK ? '현재 열린 채팅 보호 · 제목 편집 후 한 번에 적용 · 원문은 이 창의 메모리에만 유지'
                    : `ST ${version}: 검증된 1.19.x 외 버전은 조회·백업만 제공합니다.`, !this.versionOK);
        });
    }
    close() {
        if (this.busy) return this.message('작업이 끝난 뒤 닫아 주세요.');
        if (this.drafts.size && !window.confirm('적용하지 않은 제목 초안을 버리고 닫을까요?')) return;
        this.previewToken++;
        getContext().eventSource.removeListener(getContext().eventTypes.CHAT_CHANGED, this.onChanged);
        this.dialog.close(); this.dialog.remove(); this.rows = []; this.drafts.clear(); this.selected.clear(); this.preview.replaceChildren(); manager = null;
    }
    async run(fn) {
        if (this.busy) return;
        this.busy = true; this.updateControls();
        try { await fn(); } catch (error) { this.message(error.message, true); }
        finally { this.busy = false; this.updateControls(); }
    }
    updateControls() {
        const write = this.versionOK && this.owner.kind === 'character' && sameOwner(this.owner, ownerNowSafe());
        for (const control of [this.search, this.modeBtn, this.allBtn, this.noneBtn, this.backupBtn, this.refreshBtn, this.find, this.replacement, this.resetBtn]) control.disabled = this.busy;
        for (const control of [this.deleteBtn, this.renameBtn, this.restoreBtn, this.replaceBtn]) control.disabled = this.busy || !write;
        this.deleteBtn.disabled ||= !this.selected.size;
        this.backupBtn.disabled ||= !this.selected.size;
        this.renameBtn.disabled ||= !this.drafts.size;
        this.modeBtn.textContent = this.selectMode ? '선택 완료' : '선택';
        this.allBtn.hidden = this.noneBtn.hidden = !this.selectMode;
        this.dialog.querySelectorAll('.cfm-row input,.cfm-row textarea,.cfm-row button,.cfm-group button').forEach(n => {
            n.disabled = this.busy || (n.tagName === 'TEXTAREA' && (!write || n.dataset.name === getContext().chatId));
        });
        this.count.textContent = `${this.rows.length}개 파일 · ${this.selected.size}개 선택 (검색·접힘 포함) · ${this.drafts.size}개 제목 초안`;
    }
    async refresh() {
        this.guard(false);
        const rows = await this.service.list(); this.guard(false);
        const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;
        this.rows = rows.sort((a, b) => time(b.last_mes) - time(a.last_mes) || b.file_name.localeCompare(a.file_name));
        const names = new Set(rows.map(r => r.file_name));
        for (const n of this.selected) if (!names.has(n)) this.selected.delete(n);
        for (const n of this.drafts.keys()) if (!names.has(n)) this.drafts.delete(n);
        this.render();
    }
    render() {
        const focus = document.activeElement;
        const focusName = focus?.dataset?.name;
        const position = focus?.selectionStart;
        this.list.replaceChildren();
        const query = this.search.value.toLowerCase().trim();
        const groups = new Map();
        for (const row of this.rows) {
            if (query && !`${row.file_name} ${row.preview_message || ''}`.toLowerCase().includes(query)) continue;
            const label = groupLabel(row.file_name);
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push(row);
        }
        for (const [label, rows] of groups) {
            const group = el('section', 'cfm-group');
            const collapsed = this.closedGroups.has(label);
            const toggle = button(`${collapsed ? '▸' : '▾'} ${label} · ${rows.length}`, () => {
                if (collapsed) this.closedGroups.delete(label); else this.closedGroups.add(label);
                this.render();
            }, 'cfm-group-toggle');
            toggle.setAttribute('aria-expanded', String(!collapsed)); group.append(toggle);
            if (!collapsed) for (const row of rows) {
                const item = el('article', 'cfm-row');
                const check = el('input', 'cfm-check'); check.type = 'checkbox'; check.checked = this.selected.has(row.file_name); check.hidden = !this.selectMode;
                check.setAttribute('aria-label', `${row.file_name} 선택`);
                check.addEventListener('change', () => { if (check.checked) this.selected.add(row.file_name); else this.selected.delete(row.file_name); this.updateControls(); });
                const body = el('div', 'cfm-row-body');
                const title = el('textarea', 'text_pole cfm-title'); title.rows = 1; title.value = this.drafts.get(row.file_name) ?? row.file_name;
                title.dataset.name = row.file_name; title.setAttribute('aria-label', `${row.file_name} 제목`); title.spellcheck = false;
                title.addEventListener('input', () => {
                    if (title.value === row.file_name) this.drafts.delete(row.file_name); else this.drafts.set(row.file_name, title.value);
                    this.updateControls();
                });
                const meta = `${row.file_size || ''} · ${row.message_count ?? '?'} 메시지${row.file_name === getContext().chatId ? ' · 현재 채팅 🔒' : ''}`;
                const snippet = el('div', 'cfm-snippet', row.preview_message || '미리보기 없음');
                body.append(title, el('div', 'cfm-meta', meta), snippet);
                item.append(check, body, button('미리보기', () => this.showPreview(row.file_name))); group.append(item);
            }
            this.list.append(group);
        }
        if (!groups.size) this.list.append(el('p', 'cfm-empty', '표시할 채팅이 없습니다.'));
        this.updateControls();
        if (focusName) {
            const node = Array.from(this.list.querySelectorAll('textarea')).find(n => n.dataset.name === focusName);
            if (node && !node.disabled) { node.focus(); node.setSelectionRange(position, position); }
        }
    }
    async showPreview(name) {
        const token = ++this.previewToken;
        this.preview.replaceChildren(el('p', 'cfm-empty', '대화 원문을 읽는 중…'));
        try {
            this.guard(false);
            const raw = await this.service.raw(name);
            this.guard(false);
            const records = parseChat(raw, this.owner.kind);
            if (token !== this.previewToken || !this.dialog.isConnected) return;
            const messages = this.owner.kind === 'character' ? records.slice(1) : records;
            let page = Math.max(0, Math.ceil(messages.length / 40) - 1);
            const draw = () => {
                if (token !== this.previewToken) return;
                this.preview.replaceChildren(el('h3', 'cfm-preview-title', name));
                const nav = el('div', 'cfm-preview-nav');
                const prev = button('이전', () => { page--; draw(); }); prev.disabled = page <= 0;
                const next = button('다음', () => { page++; draw(); }); next.disabled = (page + 1) * 40 >= messages.length;
                nav.append(button('처음', () => { page = 0; draw(); }), prev, el('span', '', `${messages.length ? page + 1 : 0}/${Math.ceil(messages.length / 40)} · 40개씩`), next, button('끝', () => { page = Math.max(0, Math.ceil(messages.length / 40) - 1); draw(); }));
                const displayToggle = button(this.useDisplayText ? '표시: 저장된 번역/표시문' : '표시: 원문', () => {
                    this.useDisplayText = !this.useDisplayText; draw();
                });
                displayToggle.setAttribute('aria-pressed', String(this.useDisplayText));
                nav.append(displayToggle);
                this.preview.append(nav, el('p', 'cfm-note', '미리보기 전용 · 저장된 번역/표시문이 없으면 원문 · 번역 실행이나 파일 저장 없음'));
                for (const message of messages.slice(page * 40, (page + 1) * 40)) {
                    const block = el('section', `cfm-message ${message.is_user ? 'cfm-user' : ''}`);
                    const projected = previewMessage(message, this.useDisplayText);
                    const text = projected.display ? displayPlainText(projected.text, document) : projected.text;
                    const role = message.is_system ? '시스템' : message.is_user ? '유저' : '캐릭터';
                    block.append(el('strong', 'cfm-speaker', `${message.name || '메시지'} · ${role}${projected.display ? ' · 저장된 표시문' : ' · 원문'}`),
                        el('div', 'cfm-message-text', text));
                    this.preview.append(block);
                }
                if (!messages.length) this.preview.append(el('p', 'cfm-empty', '메시지가 없는 채팅입니다.'));
            };
            draw();
        } catch (error) { if (token === this.previewToken) this.preview.replaceChildren(el('p', 'cfm-error', error.message)); }
    }
    names() {
        const names = Array.from(this.selected);
        if (!names.length) throw new Error('선택 모드에서 파일을 선택해 주세요.');
        return names;
    }
    async saveForBackup() {
        this.guard(false);
        if (is_send_press || is_group_generating || isChatSaving) throw new Error('생성·저장 완료 후 백업해 주세요.');
        await saveChatConditional(); this.guard(false);
    }
    async backup() {
        const names = this.names();
        await this.saveForBackup();
        const bundle = await this.service.snapshot(names);
        download(bundle); this.message(`${names.length}개 묶음 백업 다운로드 요청 완료. 실제 파일 저장을 확인하세요.`);
    }
    async deleteSelected() {
        const names = this.names();
        for (const name of names) this.guard(true, name);
        const bundle = await this.service.snapshot(names);
        await this.service.preflight(bundle.entries);
        download(bundle, 'before-delete');
        const ok = await review(`${names.length}개 채팅 영구 삭제`, names, {
            backup: true, phrase: `${names.length}개 채팅 삭제`,
            note: '아래 전체 목록을 확인하세요. 백업 다운로드만 요청했으며 브라우저의 저장 완료는 직접 확인해야 합니다. 삭제 후 자동 되돌리기는 없습니다.',
        });
        if (!ok) return this.message('삭제 취소. 파일은 변경되지 않았습니다.');
        await this.service.preflight(bundle.entries);
        await this.batch(bundle.entries, e => this.service.remove(e), e => e.name, '삭제');
    }
    async applyNames() {
        this.guard(true);
        const fresh = await this.service.list();
        if (Array.from(this.drafts.keys()).some(n => !fresh.some(r => r.file_name === n))) throw new Error('편집한 파일이 없어졌습니다. 새로고침 후 확인해 주세요.');
        const plan = renamePlan(fresh, this.drafts, getContext().chatId);
        if (!plan.length) return this.message('변경할 제목이 없습니다.');
        const bundle = await this.service.snapshot(plan.map(p => p.from));
        await this.service.preflight(bundle.entries); download(bundle, 'before-rename');
        if (!await review(`${plan.length}개 제목 변경`, plan.map(p => `${p.from} → ${p.to}`), {
            backup: true, note: '적용 순서대로 처리합니다. 이름 충돌·원문 변경·오류가 있으면 그 자리에서 중단합니다. 현재 열린 채팅은 다시 로드하지 않습니다.',
        })) return this.message('이름 변경 취소. 초안은 유지됩니다.');
        await this.service.preflight(bundle.entries);
        const targets = new Map(plan.map(p => [p.from, p.to]));
        await this.batch(bundle.entries, async e => {
            await this.service.rename(e, targets.get(e.name)); this.drafts.delete(e.name);
        }, e => `${e.name} → ${targets.get(e.name)}`, '이름 변경');
    }
    async restore(file) {
        this.guard(true);
        if (file.size > MAX_BYTES) throw new Error('백업 파일은 최대 100 MiB입니다.');
        let bundle;
        try { bundle = JSON.parse(await file.text()); } catch { throw new Error('JSON 백업을 읽을 수 없습니다.'); }
        const entries = await validateBundle(bundle, this.owner);
        // Always create independent copies. Never silently replace a same-named file.
        const plans = entries.map(e => {
            const token = crypto.randomUUID();
            const suffix = ` (복원 ${token.slice(0, 8)})`;
            let base = e.name;
            while (new TextEncoder().encode(base + suffix + '.jsonl').length > 240) base = Array.from(base).slice(0, -1).join('');
            return { entry: e, target: safeName(base + suffix), token };
        });
        if (!await review(`${plans.length}개 채팅을 새 사본으로 가져오기`, plans.map(p => `${p.entry.name} → ${p.target}`), {
            note: '현재 캐릭터에 새 파일로 복원합니다. 기존 채팅은 덮어쓰지 않습니다. 채팅 JSONL만 복원하며 첨부파일·로어북 파일·캐릭터 카드 자체는 포함하지 않습니다.',
        })) return this.message('가져오기 취소.');
        await this.batch(plans, p => this.service.restore(p.entry, p.target, p.token), p => p.target, '복원');
    }
    async batch(items, operation, label, verb) {
        const completed = [];
        let failed = null;
        for (const item of items) {
            this.message(`${verb} ${completed.length + 1}/${items.length}`);
            try { await operation(item); completed.push(label(item)); }
            catch (error) { failed = { name: label(item), message: error.message }; break; }
        }
        // Keep the outcome visible even if refreshing fails; no automatic rollback or write retry.
        let refreshError = '';
        try { await this.refresh(); await displayPastChats(); }
        catch (error) { refreshError = ` 목록 갱신 실패: ${error.message}`; }
        const report = el('div', 'cfm-report');
        report.append(el('strong', '', `${verb}: ${completed.length}/${items.length}개 검증 완료`));
        for (const name of completed) report.append(el('div', '', `완료 · ${name}`));
        if (failed) {
            report.append(el('p', 'cfm-error', `중단 · ${failed.name}\n${failed.message}\n이 파일은 서버에서 이미 처리되었을 수 있습니다. 재시도 전에 새로고침하고 확인하세요.`));
            for (const item of items.slice(completed.length + 1)) report.append(el('div', '', `미실행 · ${label(item)}`));
        }
        if (refreshError) report.append(el('p', 'cfm-error', refreshError));
        this.status.replaceChildren(report); this.status.classList.toggle('cfm-error', !!failed || !!refreshError);
    }
}
function ownerNowSafe() { try { return ownerNow(); } catch { return {}; } }
function launch() {
    try {
        if (manager) { manager.dialog.focus(); return; }
        manager = new Manager(ownerNow()); manager.open();
    } catch (error) { globalThis.toastr?.error(error.message); }
}
function install() {
    const search = document.getElementById('select_chat_search');
    if (search && !document.getElementById('cfm-launch-chat')) {
        const node = button('파일 관리+', launch, 'menu_button'); node.id = 'cfm-launch-chat';
        search.parentElement.append(node);
    }
    const settings = document.getElementById('extensions_settings');
    if (settings && !document.getElementById('cfm-launch-settings')) {
        const node = button('채팅 파일 관리', launch, 'menu_button'); node.id = 'cfm-launch-settings';
        settings.append(node);
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
