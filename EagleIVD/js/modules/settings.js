const fs = require('fs').promises;
const path = require('path');

const APP_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'EagleIVD');
const SETTINGS_FILE = 'settings.json';
const DEFAULT_SETTINGS = {
  // 기본 설정값
  prefixUploadDate: false,
  metadataBatchSize: 30,
  downloadBatchSize: 5,
  concurrentPlaylists: 3,
  rateLimit: 0,
  sourceAddress: '',
  randomUserAgent: false,
  multiNic: false,
  threadOptions: []
};

async function loadSettings() {
  await fs.mkdir(APP_DATA_DIR, { recursive: true });
  const filePath = path.join(APP_DATA_DIR, SETTINGS_FILE);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(data));
  } catch (e) {
    if (e.code === 'ENOENT') {
      // 파일이 없으면 기본값 반환
      return Object.assign({}, DEFAULT_SETTINGS);
    }
    throw e;
  }
}

async function saveSettings(settings) {
  await fs.mkdir(APP_DATA_DIR, { recursive: true });
  const filePath = path.join(APP_DATA_DIR, SETTINGS_FILE);
  const data = JSON.stringify(settings, null, 2);
  await fs.writeFile(filePath, data, 'utf8');
}

module.exports = {
  loadSettings,
  saveSettings
};
