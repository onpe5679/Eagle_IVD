const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

let db;

/**
 * 데이터베이스 초기화
 * @param {string} pluginPath - 플러그인 경로, DB 파일 위치 결정에 사용
 */
async function initDatabase(pluginPath) {
  const dbPath = path.join(pluginPath, 'subscriptions.db');
  db = await open({ filename: dbPath, driver: sqlite3.Database });

  // playlists 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_title TEXT,
      youtube_title TEXT,
      videos_from_yt INTEGER,
      videos INTEGER,
      url TEXT UNIQUE,
      format TEXT,
      quality TEXT,
      first_created DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_checked DATETIME,
      auto_download INTEGER DEFAULT 0,
      skip INTEGER DEFAULT 0
    );
  `);

  // videos 테이블
  await db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER,
      video_id TEXT UNIQUE,
      title TEXT,
      status TEXT,
      downloaded INTEGER DEFAULT 0,
      auto_download INTEGER DEFAULT 0,
      skip INTEGER DEFAULT 0,
      eagle_linked INTEGER DEFAULT 0,
      failed_reason TEXT,
      first_attempt DATETIME,
      downloaded_at DATETIME,
      FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    );
  `);
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
  const stmt = await db.run(
    `INSERT INTO playlists (user_title, youtube_title, videos_from_yt, videos, url, format, quality, auto_download, skip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.user_title, p.youtube_title, p.videos_from_yt, p.videos, p.url,
    p.format, p.quality, p.auto_download ? 1 : 0, p.skip ? 1 : 0
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
 * 플레이리스트 삭제
 */
async function deletePlaylist(id) {
  await db.run('DELETE FROM playlists WHERE id = ?', id);
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
  const stmt = await db.run(
    `INSERT OR IGNORE INTO videos (playlist_id, video_id, title, status, downloaded, auto_download, skip, eagle_linked, failed_reason, first_attempt, downloaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.playlist_id, v.video_id, v.title, v.status,
    v.downloaded ? 1 : 0, v.auto_download ? 1 : 0, v.skip ? 1 : 0,
    v.eagle_linked ? 1 : 0, v.failed_reason || null,
    v.first_attempt || null, v.downloaded_at || null
  );
  return stmt.lastID;
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
  deleteVideoByVideoId
}; 