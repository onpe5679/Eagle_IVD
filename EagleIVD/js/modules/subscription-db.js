const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let db;

/**
 * 데이터베이스 초기화
 * @param {string} pluginPath - 플러그인 경로, DB 파일 위치 결정에 사용
 */
async function initDatabase(pluginPath) {
  // AppData/Local/EagleIVD 디렉토리 생성
  const appDataPath = path.join(process.env.LOCALAPPDATA, 'EagleIVD');
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }
  
  const dbPath = path.join(appDataPath, 'ivd.db');
  // 기존 DB에 library_id 컬럼 누락 시 초기화
  if (fs.existsSync(dbPath)) {
    const tempDb = await open({ filename: dbPath, driver: sqlite3.Database });
    const cols = await tempDb.all('PRAGMA table_info(videos);');
    await tempDb.close();
    if (!cols.some(c => c.name === 'library_id')) {
      // library_id 컬럼 없으면 파일 삭제하여 재생성
      fs.unlinkSync(dbPath);
    }
  }
  db = await open({ filename: dbPath, driver: sqlite3.Database });

  // playlists 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_title TEXT,
      youtube_title TEXT,
      videos_from_yt INTEGER,
      videos INTEGER,
      url TEXT,
      format TEXT,
      quality TEXT,
      first_created DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME,
      auto_download INTEGER DEFAULT 0,
      skip INTEGER DEFAULT 0,
      library_id INTEGER
    );
  `);

  // videos 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER,
      video_id TEXT,
      title TEXT,
      status TEXT,
      downloaded INTEGER DEFAULT 0,
      auto_download INTEGER DEFAULT 0,
      skip INTEGER DEFAULT 0,
      eagle_linked INTEGER DEFAULT 0,
      failed_reason TEXT,
      first_attempt DATETIME,
      downloaded_at DATETIME,
      is_duplicate INTEGER DEFAULT 0,
      duplicate_check_date DATETIME,
      master_video_id TEXT,
      source_playlist_url TEXT,
      library_id INTEGER,
      UNIQUE(playlist_id, video_id)
    );
  `);

  // libraries 테이블 생성 및 라이브러리 컬럼 마이그레이션
  await db.exec(`
    CREATE TABLE IF NOT EXISTS libraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      path TEXT,
      modificationTime DATETIME
    );
  `);
  const playlistCols = await db.all("PRAGMA table_info(playlists);");
  if (!playlistCols.some(col => col.name === "library_id")) {
    await db.exec("ALTER TABLE playlists ADD COLUMN library_id INTEGER;");
  }
  const videoCols = await db.all("PRAGMA table_info(videos);");
  if (!videoCols.some(col => col.name === "library_id")) {
    await db.exec("ALTER TABLE videos ADD COLUMN library_id INTEGER;");
  }

  // 참고: 기존 DB 스키마에 문제가 있다면 (예: video_id에 UNIQUE 제약 조건이 남아있는 경우),
  // DB 파일을 삭제하거나 수동으로 수정해야 할 수 있습니다.
  // ALTER TABLE로는 SQLite에서 제약 조건 수정이 제한적입니다.
}

/**
 * 모든 플레이리스트를 조회합니다.
 * @returns {Promise<Array>}
 */
async function getAllPlaylists() {
  return await db.all('SELECT * FROM playlists ORDER BY id');
}

/**
 * URL로 플레이리스트 조회
 */
async function getPlaylistByUrl(url) {
  return await db.get('SELECT * FROM playlists WHERE url = ?', url);
}

/**
 * 새 플레이리스트 추가
 * @param {object} p - playlist 객체
 */
async function addPlaylist(p) {
  // 신규 플레이리스트 추가
  const stmt = await db.run(
    `INSERT INTO playlists (user_title, youtube_title, videos_from_yt, videos, url, format, quality, auto_download, skip, library_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.user_title, p.youtube_title, p.videos_from_yt, p.videos, p.url,
    p.format, p.quality, p.auto_download ? 1 : 0, p.skip ? 1 : 0, p.library_id
  );
  return stmt.lastID;
}

/**
 * 플레이리스트 업데이트
 */
async function updatePlaylist(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  values.push(id);
  await db.run(
    `UPDATE playlists SET ${sets} WHERE id = ?`,
    ...values
  );
}

/**
 * 재생목록 삭제
 * @param {number} id - 재생목록 ID
 * @param {boolean} deleteVideos - 관련 영상도 함께 삭제할지 여부
 */
async function deletePlaylist(id, deleteVideos = false) {
  try {
    if (deleteVideos) {
      // 재생목록에 속한 모든 영상 ID 가져오기
      const videoIds = await db.all(
        'SELECT video_id FROM videos WHERE playlist_id = ?',
        [id]
      );
      
      // 영상 삭제
      for (const { video_id } of videoIds) {
        await db.run(
          'DELETE FROM videos WHERE id = ?',
          [video_id]
        );
      }
    }

    // 재생목록-영상 관계 삭제
    await db.run(
      'DELETE FROM videos WHERE playlist_id = ?',
      [id]
    );

    // 재생목록 삭제
    await db.run(
      'DELETE FROM playlists WHERE id = ?',
      [id]
    );
  } catch (error) {
    console.error('Error deleting playlist:', error);
    throw error;
  }
}

/**
 * 특정 플레이리스트의 모든 비디오 조회
 */
async function getVideosByPlaylist(playlistId) {
  return await db.all(
    'SELECT * FROM videos WHERE playlist_id = ? ORDER BY id',
    playlistId
  );
}

/**
 * 비디오 레코드 추가
 */
async function addVideo(v) {
  // UNIQUE(playlist_id, video_id) 제약 조건에 따라 중복 시 무시됨
  const stmt = await db.run(
    `INSERT OR IGNORE INTO videos (
      playlist_id, video_id, title, status, downloaded, auto_download,
      skip, eagle_linked, failed_reason, first_attempt, downloaded_at,
      is_duplicate, duplicate_check_date, master_video_id, source_playlist_url, library_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.playlist_id, v.video_id, v.title, v.status,
    v.downloaded ? 1 : 0, v.auto_download ? 1 : 0, v.skip ? 1 : 0,
    v.eagle_linked ? 1 : 0, v.failed_reason || null,
    v.first_attempt || null, v.downloaded_at || null,
    v.is_duplicate ? 1 : 0, v.duplicate_check_date || null,
    v.master_video_id || null, v.source_playlist_url || null,
    v.library_id || null
  );
  return stmt.lastID; // INSERT 성공 시 lastID 반환, IGNORE 시 0 또는 undefined 반환
}

/**
 * 비디오 업데이트
 */
async function updateVideo(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  values.push(id);
  await db.run(`UPDATE videos SET ${sets} WHERE id = ?`, ...values);
}

/**
 * 모든 비디오 ID 목록 조회
 * @returns {Promise<Array<string>>}
 */
async function getAllVideoIds() {
  const rows = await db.all('SELECT video_id FROM videos');
  return rows.map(row => row.video_id);
}

/**
 * video_id로 비디오 레코드 삭제
 * @param {string} videoId 
 */
async function deleteVideoByVideoId(videoId) {
  await db.run('DELETE FROM videos WHERE video_id = ?', videoId);
}

/**
 * video_id로 모든 관련 비디오 레코드 조회
 * @param {string} videoId 
 * @returns {Promise<Array>}
 */
async function getVideosByVideoId(videoId) {
  return await db.all('SELECT * FROM videos WHERE video_id = ?', videoId);
}

/**
 * video_id를 사용하여 영상의 eagle_linked 상태를 1로 업데이트합니다.
 * @param {string} videoId
 */
async function markVideoAsEagleLinked(videoId) {
  await db.run('UPDATE videos SET eagle_linked = 1 WHERE video_id = ?', videoId);
}

// 라이브러리 추가
async function addLibrary(lib) {
  const stmt = await db.run(
    `INSERT OR IGNORE INTO libraries (name, path, modificationTime) VALUES (?, ?, ?)`,
    lib.name, lib.path, lib.modificationTime || null
  );
  if (stmt.lastID) return stmt.lastID;
  const row = await db.get(`SELECT id FROM libraries WHERE name = ?`, lib.name);
  return row.id;
}

// 라이브러리 조회 (이름 기준)
async function getLibraryByName(name) {
  return await db.get(`SELECT * FROM libraries WHERE name = ?`, name);
}

// 라이브러리 경로 기준 조회
async function getLibraryByPath(path) {
  return await db.get(`SELECT * FROM libraries WHERE path = ?`, path);
}

// 특정 라이브러리의 플레이리스트 조회
async function getPlaylistsByLibrary(libraryId) {
  return await db.all(
    `SELECT * FROM playlists WHERE library_id = ? ORDER BY id`,
    libraryId
  );
}

// 기존 플레이리스트/비디오에 라이브러리 할당 (초기 마이그레이션)
async function assignItemsToLibrary(libraryId) {
  await db.run(`UPDATE playlists SET library_id = ? WHERE library_id IS NULL`, libraryId);
  await db.run(`UPDATE videos SET library_id = ? WHERE library_id IS NULL`, libraryId);
}

module.exports = {
  initDatabase,
  getAllPlaylists,
  getPlaylistByUrl,
  addPlaylist,
  updatePlaylist,
  deletePlaylist,
  getVideosByPlaylist,
  addVideo,
  updateVideo,
  getAllVideoIds,
  deleteVideoByVideoId,
  getVideosByVideoId,
  markVideoAsEagleLinked,
  addLibrary,
  getLibraryByName,
  getLibraryByPath,
  getPlaylistsByLibrary,
  assignItemsToLibrary
}; 