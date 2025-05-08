// js/controllers/subscription-controller.js
/**
 * 구독 관련 UI 이벤트 바인딩
 */
module.exports.bindSubscriptionUI = function(subscriptionManager, uiController) {
  const addSubscriptionBtn = document.getElementById('addSubscriptionBtn');
  if (addSubscriptionBtn) {
    addSubscriptionBtn.addEventListener('click', () => {
      const subType = document.querySelector('input[name="subType"]:checked').value;
      const url = document.getElementById('newSubUrl').value;
      const folder = document.getElementById('newSubFolder').value;
      const format = document.getElementById('newSubFormat').value;
      const quality = document.getElementById('newSubQuality').value;
      const subscriptionData = { url, folderName: folder, format, quality };
      if (subType === 'channel') {
        window.addChannelSubscription(subscriptionData);
      } else {
        window.addSubscription(subscriptionData);
      }
    });
  }

  const checkNewBtn = document.getElementById('checkNewBtn');
  if (checkNewBtn) {
    checkNewBtn.addEventListener('click', () => {
      window.checkAllSubscriptions();
    });
  }

  const startAutoCheckBtn = document.getElementById('startAutoCheckBtn');
  if (startAutoCheckBtn) {
    startAutoCheckBtn.addEventListener('click', () => {
      window.startAutoCheck(30);
    });
  }

  const stopAutoCheckBtn = document.getElementById('stopAutoCheckBtn');
  if (stopAutoCheckBtn) {
    stopAutoCheckBtn.addEventListener('click', () => {
      window.stopAutoCheck();
    });
  }
};
