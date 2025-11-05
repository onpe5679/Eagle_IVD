// js/controllers/maintenance-controller.js
/**
 * 유지 관리(중복/일치성 검사) 탭 UI 이벤트 바인딩
 */
module.exports.bindMaintenanceUI = function() {
  // === Eagle Sync 관련 ===
  const syncEagleToDbBtn = document.getElementById('syncEagleToDbBtn');
  if (syncEagleToDbBtn) {
    syncEagleToDbBtn.addEventListener('click', () => window.syncEagleToDb());
  }
  
  const viewTempPlaylistsBtn = document.getElementById('viewTempPlaylistsBtn');
  if (viewTempPlaylistsBtn) {
    viewTempPlaylistsBtn.addEventListener('click', () => window.viewTempPlaylists());
  }
  
  // 임시 플레이리스트 모달 관련
  const closeTempPlaylistModal = document.getElementById('closeTempPlaylistModal');
  if (closeTempPlaylistModal) {
    closeTempPlaylistModal.addEventListener('click', () => {
      const modal = document.getElementById('tempPlaylistModal');
      if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
      }
    });
  }
  
  const clearTempDataBtn = document.getElementById('clearTempDataBtn');
  if (clearTempDataBtn) {
    clearTempDataBtn.addEventListener('click', () => window.clearTempData());
  }
  
  const clearSyncedTempDataBtn = document.getElementById('clearSyncedTempDataBtn');
  if (clearSyncedTempDataBtn) {
    clearSyncedTempDataBtn.addEventListener('click', () => window.clearSyncedTempData());
  }
  
  // === 기존 기능 ===
  const checkDuplicatesBtn = document.getElementById('checkDuplicatesBtn');
  if (checkDuplicatesBtn) {
    checkDuplicatesBtn.addEventListener('click', () => window.checkDuplicates());
  }
  
  const checkConsistencyBtn = document.getElementById('checkConsistencyBtn');
  if (checkConsistencyBtn) {
    checkConsistencyBtn.addEventListener('click', () => window.checkConsistency());
  }
  
  const removeInconsistenciesBtn = document.getElementById('removeInconsistenciesBtn');
  if (removeInconsistenciesBtn) {
    removeInconsistenciesBtn.addEventListener('click', async () => {
      if (!confirm('정말로 DB에서 불일치 항목을 삭제하시겠습니까?')) return;
      if (window.removeInconsistenciesFromDB) {
        await window.removeInconsistenciesFromDB();
      }
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
