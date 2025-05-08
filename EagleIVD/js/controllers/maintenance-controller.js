// js/controllers/maintenance-controller.js
/**
 * 유지 관리(중복/일치성 검사) 탭 UI 이벤트 바인딩
 */
module.exports.bindMaintenanceUI = function() {
  const checkDuplicatesBtn = document.getElementById('checkDuplicatesBtn');
  if (checkDuplicatesBtn) {
    checkDuplicatesBtn.addEventListener('click', () => window.checkDuplicates());
  }
  const checkConsistencyBtn = document.getElementById('checkConsistencyBtn');
  if (checkConsistencyBtn) {
    checkConsistencyBtn.addEventListener('click', () => window.checkConsistency());
  }
  const fixInconsistenciesBtn = document.getElementById('fixInconsistenciesBtn');
  if (fixInconsistenciesBtn) {
    fixInconsistenciesBtn.addEventListener('click', () => window.fixInconsistencies());
  }
  const removeInconsistenciesBtn = document.getElementById('removeInconsistenciesBtn');
  if (removeInconsistenciesBtn) {
    removeInconsistenciesBtn.addEventListener('click', async () => {
      if (!confirm('정말로 DB에서 불일치 항목을 삭제하시겠습니까?')) return;
      await libraryMaintenance.removeInconsistenciesFromDB();
    });
  }
  const cancelMaintenanceBtn = document.getElementById('cancelMaintenanceBtn');
  if (cancelMaintenanceBtn) {
    cancelMaintenanceBtn.addEventListener('click', () => window.cancelMaintenance());
  }
  const viewDuplicateReportBtn = document.getElementById('viewDuplicateReportBtn');
  if (viewDuplicateReportBtn) {
    viewDuplicateReportBtn.addEventListener('click', () => window.viewDuplicateReport());
  }
  const viewConsistencyReportBtn = document.getElementById('viewConsistencyReportBtn');
  if (viewConsistencyReportBtn) {
    viewConsistencyReportBtn.addEventListener('click', () => window.viewConsistencyReport());
  }
};
