export function handleDialogCancel(event, dialog, close) {
    // Input[type=file] cancel bubbles; only the dialog's own Escape closes it.
    if (event.target !== dialog) return;
    event.preventDefault();
    close();
}
export function handleFileCancel(event, input, notify) {
    event.stopPropagation();
    input.value = '';
    notify('가져오기 취소. 관리 창과 선택·제목 초안은 유지됩니다.');
}
