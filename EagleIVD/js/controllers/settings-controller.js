// js/controllers/settings-controller.js
const settings = require('../modules/settings.js');
const utils = require('../modules/utils.js');

// 초기 설정값 UI에 로드
async function initSettingsUI(subscriptionManager) {
  try {
    const loaded = await settings.loadSettings();
    const prefixChk = document.getElementById('prefixUploadDateChk');
    if (prefixChk) {
      prefixChk.checked = loaded.prefixUploadDate;
      if (subscriptionManager) subscriptionManager.prefixUploadDate = loaded.prefixUploadDate;
    }
    document.getElementById('metadataBatchSize').value = loaded.metadataBatchSize;
    document.getElementById('downloadBatchSize').value = loaded.downloadBatchSize;
    document.getElementById('concurrentPlaylists').value = loaded.concurrentPlaylists;
    document.getElementById('rateLimit').value = loaded.rateLimit;
    document.getElementById('sourceAddressSelect').value = loaded.sourceAddress;
    document.getElementById('randomUaChk').checked = loaded.randomUserAgent;
    document.getElementById('multiNicChk').checked = loaded.multiNic;
    // 스레드 옵션 UI 업데이트
    updateThreadOptions();
    if (Array.isArray(loaded.threadOptions)) {
      loaded.threadOptions.forEach((opt, idx) => {
        const i = idx + 1;
        const nicSel = document.getElementById(`threadNicSel${i}`);
        if (nicSel && opt.sourceAddress) nicSel.value = opt.sourceAddress;
        const cookieInp = document.getElementById(`threadCookieInput${i}`);
        if (cookieInp && opt.cookieFile) cookieInp.value = opt.cookieFile;
      });
    }
  } catch (err) {
    console.error('initSettingsUI failed:', err);
  }
}

// 스레드별 NIC 및 쿠키 입력 UI 동적 생성
function updateThreadOptions() {
  const count = Number(document.getElementById('concurrentPlaylists')?.value) || 0;
  const container = document.getElementById('threadOptionsContainer');
  if (!container) return;
  container.innerHTML = '';
  
  // 먼저 사용 가능한 NIC 목록 가져오기
  const nicOptions = utils.getNetworkInterfaces();
  
  // 각 스레드에 대한 옵션 UI 생성
  for (let i = 1; i <= count; i++) {
    const div = document.createElement('div');
    div.className = 'thread-option';
    div.innerHTML = `
      <div>
        <label for="threadNicSel${i}">Thread ${i} NIC:</label>
        <select id="threadNicSel${i}" class="thread-nic-select"></select>
      </div>
      <div>
        <label for="threadCookieInput${i}">Thread ${i} Cookie File:</label>
        <input id="threadCookieInput${i}" type="text" class="thread-cookie-input" />
      </div>
    `;
    container.appendChild(div);
    
    // NIC 목록을 셀렉트 박스에 채우기
    const nicSelect = document.getElementById(`threadNicSel${i}`);
    if (nicSelect) {
      nicOptions.forEach(nic => {
        const option = document.createElement('option');
        option.value = nic.address;
        option.textContent = nic.name;
        nicSelect.appendChild(option);
      });
    }
  }
}

// 설정 저장 버튼 바인딩
function bindSaveSettings() {
  const btn = document.getElementById('saveSettingsBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const obj = {
      prefixUploadDate: document.getElementById('prefixUploadDateChk').checked,
      metadataBatchSize: Number(document.getElementById('metadataBatchSize').value),
      downloadBatchSize: Number(document.getElementById('downloadBatchSize').value),
      concurrentPlaylists: Number(document.getElementById('concurrentPlaylists').value),
      rateLimit: Number(document.getElementById('rateLimit').value),
      sourceAddress: document.getElementById('sourceAddressSelect').value,
      randomUserAgent: document.getElementById('randomUaChk').checked,
      multiNic: document.getElementById('multiNicChk').checked,
      threadOptions: []
    };
    for (let i = 1; i <= obj.concurrentPlaylists; i++) {
      const nic = document.getElementById(`threadNicSel${i}`);
      const cookie = document.getElementById(`threadCookieInput${i}`);
      obj.threadOptions.push({
        sourceAddress: nic ? nic.value : '',
        cookieFile: cookie ? cookie.value : ''
      });
    }
    try {
      await settings.saveSettings(obj);
      const status = document.getElementById('statusArea');
      if (status) {
        status.textContent = '설정이 저장되었습니다.';
        setTimeout(() => { status.textContent = 'Waiting...'; }, 2000);
      }
    } catch (e) {
      const status = document.getElementById('statusArea');
      if (status) status.textContent = '설정 저장 실패: ' + e.message;
    }
  });
}

// 설정 탭 UI 바인딩
function bindSettingsUI() {
  const multiNicChk = document.getElementById('multiNicChk');
  const concurrentPlaylists = document.getElementById('concurrentPlaylists');
  const nicContainer = document.getElementById('threadOptionsContainer');
  
  if (multiNicChk) {
    multiNicChk.addEventListener('change', () => {
      if (nicContainer) {
        nicContainer.style.display = multiNicChk.checked ? 'block' : 'none';
      }
      updateThreadOptions();
    });
  }
  
  if (concurrentPlaylists) {
    concurrentPlaylists.addEventListener('change', updateThreadOptions);
  }
  
  // 초기 상태 설정
  if (multiNicChk && nicContainer) {
    nicContainer.style.display = multiNicChk.checked ? 'block' : 'none';
  }
  
  // NIC 목록 및 기본 셀렉트 박스 업데이트 
  const sourceAddressSelect = document.getElementById('sourceAddressSelect');
  if (sourceAddressSelect) {
    const nicOptions = utils.getNetworkInterfaces();
    sourceAddressSelect.innerHTML = '';
    nicOptions.forEach(nic => {
      const option = document.createElement('option');
      option.value = nic.address;
      option.textContent = nic.name;
      sourceAddressSelect.appendChild(option);
    });
  }
}

module.exports = { initSettingsUI, bindSaveSettings, updateThreadOptions, bindSettingsUI };
