import { FORMAT, MAX_BYTES, MAX_FILES, safeName, safeAvatar, sha256, parseChat, sameChat, restorable } from './core.mjs';

// No write retries: a timeout can mean the server already committed the operation.
export class ChatService {
    constructor({ owner, request, guard, emit, progress = () => {} }) {
        Object.assign(this, { owner, request, guard, emit, progress });
        if (owner.kind === 'character') safeAvatar(owner.avatar);
    }
    async list() {
        const rows = await this.request('/api/chats/search', { query: '', avatar_url: this.owner.avatar || null, group_id: this.owner.groupId || null });
        if (!Array.isArray(rows) || rows.some(r => typeof r.file_name !== 'string')) throw new Error('채팅 목록 응답을 확인할 수 없습니다.');
        return rows;
    }
    async raw(name) {
        safeName(name);
        const data = await this.request('/api/chats/export', {
            is_group: this.owner.kind === 'group', avatar_url: this.owner.avatar,
            file: `${name}.jsonl`, exportfilename: `${name}.jsonl`, format: 'jsonl',
        });
        if (typeof data.result !== 'string') throw new Error('원문 내보내기 실패');
        return data.result;
    }
    async snapshot(names) {
        if (!names.length || names.length > MAX_FILES || new Set(names).size !== names.length) throw new Error('한 번에 1~500개를 선택해 주세요.');
        const entries = [];
        let total = 0;
        for (const name of names) {
            this.guard(false);
            this.progress(`원문 읽기 ${entries.length + 1}/${names.length}`);
            const raw = await this.raw(name);
            total += new TextEncoder().encode(raw).length;
            if (total > MAX_BYTES) throw new Error('원문 합계가 100 MiB를 초과합니다. 나누어 백업해 주세요.');
            entries.push({ name, raw, sha256: await sha256(raw) });
        }
        return { format: FORMAT, version: 1, createdAt: new Date().toISOString(), owner: this.owner, entries };
    }
    async check(entry) {
        if (this.owner.kind !== 'character') throw new Error('그룹 채팅 변경은 지원하지 않습니다.');
        this.guard(true, entry.name);
        if (await sha256(await this.raw(entry.name)) !== entry.sha256) throw new Error(`백업 이후 파일이 변경되었습니다: ${entry.name}`);
        parseChat(entry.raw, this.owner.kind);
        // Recheck after the read: context may change while awaiting the network.
        this.guard(true, entry.name);
    }
    async preflight(entries) {
        if (this.owner.kind !== 'character') throw new Error('그룹 채팅 변경은 지원하지 않습니다.');
        for (const entry of entries) await this.check(entry);
    }
    async rename(entry, target) {
        safeName(target);
        await this.check(entry);
        const rows = await this.list();
        if (rows.some(r => r.file_name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase() === target.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase())) throw new Error(`대상 이름이 이미 존재합니다: ${target}`);
        this.guard(true, entry.name);
        const result = await this.request('/api/chats/rename', {
            is_group: false, avatar_url: this.owner.avatar, original_file: `${entry.name}.jsonl`, renamed_file: `${target}.jsonl`,
        });
        if (result.ok !== true || result.sanitizedFileName !== target) throw new Error('이름 변경 응답이 예상과 다릅니다. 목록을 새로 확인해 주세요.');
        if (await sha256(await this.raw(target)) !== entry.sha256) throw new Error('변경 후 원문 검증 실패. 백업을 보관하고 작업을 중단하세요.');
        await this.emit('CHAT_RENAMED', { avatarId: this.owner.avatar, groupId: null, oldFileName: `${entry.name}.jsonl`, newFileName: `${target}.jsonl` });
    }
    async remove(entry) {
        await this.check(entry);
        const result = await this.request('/api/chats/delete', { avatar_url: this.owner.avatar, chatfile: `${entry.name}.jsonl` });
        if (result.ok !== true) throw new Error('삭제 결과를 확인할 수 없습니다.');
        if ((await this.list()).some(r => r.file_name === entry.name)) throw new Error('삭제 후 목록 검증 실패');
        await this.emit('CHAT_DELETED', entry.name);
    }
    async restore(entry, target, token) {
        if (this.owner.kind !== 'character') throw new Error('그룹 복원은 지원하지 않습니다.');
        safeName(target); restorable(entry.raw);
        this.guard(true);
        const before = await this.list();
        if (before.some(r => r.file_name === target)) throw new Error('복원 이름이 이미 존재합니다.');
        const form = new FormData();
        form.set('avatar_url', this.owner.avatar);
        // Core import filenames include character_name. A random prefix prevents timestamp collisions.
        form.set('character_name', `CFM-${token}`);
        form.set('user_name', 'User');
        form.set('file_type', 'jsonl');
        form.set('avatar', new Blob([entry.raw], { type: 'application/octet-stream' }), 'restore.jsonl');
        this.guard(true);
        const result = await this.request('/api/chats/import', form);
        const created = result.fileNames?.[0];
        if (!result.res || result.fileNames?.length !== 1 || typeof created !== 'string'
            || !created.startsWith(`CFM-${token} - `) || !created.endsWith('.jsonl')) {
            throw new Error('가져오기 응답 불확실. 재시도 전에 CFM 임시 파일을 확인하세요.');
        }
        const name = created.slice(0, -6);
        if (before.some(r => r.file_name === name)) throw new Error('가져온 파일이 기존 이름과 충돌했습니다. 즉시 중단합니다.');
        const raw = await this.raw(name);
        if (!sameChat(entry.raw, raw)) throw new Error(`복원 내용 검증 실패. 임시 파일 보존: ${name}`);
        await this.rename({ name, raw, sha256: await sha256(raw) }, target);
    }
}
