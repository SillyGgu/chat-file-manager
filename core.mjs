export const FORMAT = 'st-chat-bundle';
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_FILES = 500;
export function safeName(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim()
        || /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) || /[. ]$/u.test(name)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(name)
        || new TextEncoder().encode(name + '.jsonl').length > 240) {
        throw new Error('이름에는 경로·금지 문자·끝의 공백/점을 사용할 수 없습니다. 최대 UTF-8 234바이트입니다.');
    }
    return name;
}
export function safeAvatar(avatar) {
    if (typeof avatar !== 'string' || !avatar.endsWith('.png') || /[/\\\x00-\x1f]/u.test(avatar) || avatar === '..png') {
        throw new Error('안전한 캐릭터 파일 경로를 확인할 수 없습니다.');
    }
    return avatar;
}
export const groupLabel = name => /^\[([^\]]+)\]/u.exec(name)?.[1].trim() || '미분류';
export const nameKey = name => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function renamePlan(rows, drafts, active) {
    const changes = rows.filter(r => drafts.has(r.file_name) && drafts.get(r.file_name) !== r.file_name)
        .map(r => ({ from: safeName(r.file_name), to: safeName(drafts.get(r.file_name)) }));
    const occupied = new Set(rows.map(r => nameKey(r.file_name)));
    const targets = new Set();
    for (const item of changes) {
        if (item.from === active) throw new Error('현재 열린 채팅은 기본 ST 기능으로 이름을 변경해 주세요.');
        const key = nameKey(item.to);
        if (occupied.has(key) || targets.has(key)) throw new Error(`이름 충돌: ${item.to} (교환·대소문자만 변경도 차단)`);
        targets.add(key);
    }
    return changes;
}
export function parseChat(raw, kind = 'character') {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('비어 있거나 읽을 수 없는 채팅입니다.');
    const lines = raw.replace(/^\uFEFF/u, '').split(/\r?\n/u);
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    const records = lines.map((line, i) => {
        try {
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
            return value;
        } catch { throw new Error(`${i + 1}번째 줄의 JSON이 손상되었습니다. 원문 백업만 가능합니다.`); }
    });
    if (kind === 'character') {
        const head = records[0];
        if (!('user_name' in head || 'name' in head || 'chat_metadata' in head)) throw new Error('ST 채팅 헤더가 없습니다.');
    }
    return records;
}
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
    return value;
}
export function sameChat(a, b, kind = 'character') {
    return JSON.stringify(stable(parseChat(a, kind))) === JSON.stringify(stable(parseChat(b, kind)));
}
export function restorable(raw) {
    const records = parseChat(raw);
    for (const row of records.slice(1)) {
        if (typeof row.mes !== 'string' || (row.swipes !== undefined && (!Array.isArray(row.swipes) || row.swipes.some(s => typeof s !== 'string')))) {
            throw new Error('변환이 필요한 메시지 형식입니다. ST 기본 가져오기를 이용해 주세요.');
        }
    }
    return records;
}
export async function sha256(raw) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function validateBundle(bundle, owner) {
    if (bundle?.format !== FORMAT || bundle.version !== 1 || !Array.isArray(bundle.entries)
        || !bundle.entries.length || bundle.entries.length > MAX_FILES) throw new Error('지원하지 않는 묶음 백업입니다.');
    if (bundle.owner?.kind !== 'character' || owner.kind !== 'character' || bundle.owner.avatar !== owner.avatar) {
        throw new Error('이 백업과 같은 캐릭터 카드에서만 복원할 수 있습니다. 그룹 백업은 현재 조회용입니다.');
    }
    const names = new Set();
    let bytes = 0;
    for (const e of bundle.entries) {
        safeName(e.name);
        if (typeof e.raw !== 'string' || names.has(e.name)) throw new Error('중복 이름 또는 잘못된 원문입니다.');
        names.add(e.name);
        bytes += new TextEncoder().encode(e.raw).length;
        if (bytes > MAX_BYTES) throw new Error('백업 원문 합계가 100 MiB를 초과합니다.');
        if (await sha256(e.raw) !== e.sha256) throw new Error(`체크섬 불일치: ${e.name}`);
        restorable(e.raw);
    }
    return bundle.entries;
}
