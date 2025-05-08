// js/controllers/tab-controller.js
const uiController = require('../modules/ui-controller.js');

/**
 * 탭 메뉴 클릭 이벤트 바인딩
 */
function bindTabs() {
  document.querySelectorAll('.tab-button').forEach(tab => {
    tab.addEventListener('click', () => {
      uiController.showTab(tab.dataset.target);
    });
  });
}

module.exports = { bindTabs };
