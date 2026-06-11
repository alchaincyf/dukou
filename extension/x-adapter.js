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

  // 封面（2026-06实测DOM）：cover input是 [data-testid="fileInput"]，页面加载完才挂出来；
  // 塞文件后X弹「Edit media」裁剪框，自动点 [data-testid="applyButton"] 确认
  async fillCover(article) {
    const input = await waitFor(() =>
      document.querySelector('input[data-testid="fileInput"]') ||
      [...document.querySelectorAll('input[type="file"]')].find((i) => !i.accept || /image/.test(i.accept)),
    6000);
    if (!input) throw new Error('没找到封面上传入口');
    const file = dataUrlToFile(article.coverDataUrl, 'cover');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const apply = await waitFor(() => document.querySelector('[role="dialog"] [data-testid="applyButton"]'), 8000);
    if (!apply) throw new Error('裁剪弹窗没出现，可能图片格式不被接受');
    apply.click();
  },
};
