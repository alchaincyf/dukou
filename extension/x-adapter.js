// X Articles 站点适配器（Draft.js编辑器）
// 在 fill-common.js 之前加载，提供站点差异化的定位与封面填充

window.WX2X = {
  key: 'x',
  siteName: 'X Article',
  hint: '先打开 Articles 的新草稿编辑页（有 Add a title 的页面），再点「填入」。头图会自动尝试上传。',
  // X单图限制约5MB，超限图片会在保存草稿时被静默丢弃；留余量压到4.5MB内
  maxImageBytes: 4.5 * 1024 * 1024,

  findTitleField() {
    return findTitleFieldHeuristic();
  },

  findBodyEditor() {
    return findBodyEditorHeuristic();
  },

  // 封面：找接受图片的 input[type=file]，直接塞文件
  async fillCover(article) {
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .filter((i) => !i.accept || /image/.test(i.accept));
    if (inputs.length === 0) throw new Error('no file input');
    const file = dataUrlToFile(article.coverDataUrl, 'cover');
    const dt = new DataTransfer();
    dt.items.add(file);
    inputs[0].files = dt.files;
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
  },
};
