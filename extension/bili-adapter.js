// B站专栏 站点适配器（member.bilibili.com，编辑器可能嵌在iframe里，all_frames注入）
// 新版编辑器内核是Tiptap/ProseMirror（2026-06实测DOM）：
//   正文 = .tiptap.ProseMirror（contenteditable，eva3-editor）
//   标题 = .title-input__inner textarea（placeholder「请输入标题（建议30字以内）」，maxlength=50）
// 旧版Quill（.rql-editor / .bre-title-input）作为兜底保留
// 封面不填：B站专栏头图在发布设置里选，可直接从文中图片挑

window.WX2X = {
  key: 'bili',
  siteName: 'B站专栏',
  hint: '确认这是专栏编辑页（能看到正文输入区），再点「填入」。封面请在发布设置里从文中图片选。',
  maxTitleLen: 50,

  // 编辑器可能在iframe里：只在能看到编辑器/标题框的frame里显示面板
  gate() {
    return !!document.querySelector(
      '.tiptap.ProseMirror, .eva3-editor, .rql-editor, .title-input__inner, .bre-title-input'
    );
  },

  findTitleField() {
    return (
      document.querySelector('.title-input__inner') ||
      document.querySelector('.title-input textarea') ||
      document.querySelector('.bre-title-input textarea') ||
      findTitleFieldHeuristic()
    );
  },

  findBodyEditor() {
    return (
      document.querySelector('.tiptap.ProseMirror[contenteditable="true"]') ||
      document.querySelector('.eva3-editor[contenteditable="true"]') ||
      document.querySelector('.rql-editor[contenteditable="true"], .ql-editor') ||
      findBodyEditorHeuristic()
    );
  },
};
