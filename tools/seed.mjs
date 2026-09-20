// 所有探针共用的「进页面前先塞好 localStorage」脚本。
//
// 为什么需要：首访会弹一张「夜馆规矩」入馆引导（.tour），它是全屏浮层。
// 探针要是没跳过它，截图量到的全是那张卡片，量布局也被浮层挡着看不出问题。
// 用 Page.addScriptToEvaluateOnNewDocument 注入，跑在 app.js 之前，
// 所以 app.js 起来时 tourSeen() 已经是 true，浮层根本不会出现。
//
// 顺带把声音关掉：headless 里 Web Audio 起不来，省得留一堆 console 噪音。
export const SEED = `
(function () {
  try {
    localStorage.setItem('fengcun.tour', '1');
    localStorage.setItem('fengcun.sound', '0');
  } catch (_) {}
})();`;
