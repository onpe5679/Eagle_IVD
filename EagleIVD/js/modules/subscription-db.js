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

  // WAL 모드 활성화 (동시성 향상)
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA synchronous = NORMAL');
  await db.exec('PRAGMA cache_size = 10000');
  await db.exec('PRAGMA temp_store = MEMORY');

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
      status TEXT DEFAULT 'pending',
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
      processing_lock INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

  // 먼저 컬럼 체크 및 추가
  const playlistCols = await db.all("PRAGMA table_info(playlists);");
  if (!playlistCols.some(col => col.name === "library_id")) {
    await db.exec("ALTER TABLE playlists ADD COLUMN library_id INTEGER;");
  }
  
  const videoCols = await db.all("PRAGMA table_info(videos);");
  if (!videoCols.some(col => col.name === "library_id")) {
    await db.exec("ALTER TABLE videos ADD COLUMN library_id INTEGER;");
  }
  if (!videoCols.some(col => col.name === "processing_lock")) {
    await db.exec("ALTER TABLE videos ADD COLUMN processing_lock INTEGER DEFAULT 0;");
  }
  if (!videoCols.some(col => col.name === "created_at")) {
    await db.exec("ALTER TABLE videos ADD COLUMN created_at DATETIME;");
    // Set current timestamp for existing records
    await db.exec("UPDATE videos SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;");
  }
  if (!videoCols.some(col => col.name === "updated_at")) {
    await db.exec("ALTER TABLE videos ADD COLUMN updated_at DATETIME;");
    // Set current timestamp for existing records
    await db.exec("UPDATE videos SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;");
  }

  // 컬럼 추가 후 인덱스 생성 (성능 최적화)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_playlist_id ON videos(playlist_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_video_id ON videos(video_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_downloaded ON videos(downloaded);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_eagle_linked ON videos(eagle_linked);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_processing_lock ON videos(processing_lock);`);

  // 업데이트 트리거 생성 (updated_at 자동 업데이트)
  await db.exec(`
    CREATE TRIGGER IF NOT EXISTS update_videos_timestamp 
    AFTER UPDATE ON videos 
    BEGIN 
      UPDATE videos SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; 
    END;
  `);

  // 기존 'done' 상태를 'completed'로 마이그레이션 (중복 다운로드 문제 해결)
  try {
    const doneCount = await db.get("SELECT COUNT(*) as count FROM videos WHERE status = 'done'");
    if (doneCount && doneCount.count > 0) {
      console.log(`[DB Migration] Updating ${doneCount.count} videos from 'done' to 'completed' status`);
      await db.run("UPDATE videos SET status = 'completed' WHERE status = 'done'");
      console.log(`[DB Migration] Successfully updated video statuses for consistency`);
    }
  } catch (migrationError) {
    console.error(`[DB Migration] Error updating video statuses:`, migrationError);
  }
}

/**
 * 트랜잭션 실행 헬퍼
 * @param {Function} callback - 트랜잭션 내에서 실행할 콜백
 * @returns {Promise<any>} 콜백 결과
 */
async function withTransaction(callback) {
  await db.exec('BEGIN TRANSACTION');
  try {
    const result = await callback(db);
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
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
  return await withTransaction(async (db) => {
    const stmt = await db.run(
      `INSERT INTO playlists (user_title, youtube_title, videos_from_yt, videos, url, format, quality, auto_download, skip, library_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.user_title, p.youtube_title, p.videos_from_yt, p.videos, p.url,
      p.format, p.quality, p.auto_download ? 1 : 0, p.skip ? 1 : 0, p.library_id
    );
    return stmt.lastID;
  });
}

/**
 * 플레이리스트 업데이트
 */
async function updatePlaylist(id, fields) {
  return await withTransaction(async (db) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const values = Object.values(fields);
    values.push(id);
    await db.run(
      `UPDATE playlists SET ${sets} WHERE id = ?`,
      ...values
    );
  });
}

/**
 * 재생목록 삭제
 * @param {number} id - 재생목록 ID
 * @param {boolean} deleteVideos - 관련 영상도 함께 삭제할지 여부
 */
async function deletePlaylist(id, deleteVideos = false) {
  return await withTransaction(async (db) => {
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
  });
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
 * 비디오 레코드 안전하게 추가 (중복 방지 및 처리 락 적용)
 * @param {object} v - video 객체
 * @returns {Promise<number|null>} 새로 추가된 비디오 ID 또는 null (중복인 경우)
 */
async function addVideo(v) {
  return await withTransaction(async (db) => {
    // 먼저 중복 확인
    const existing = await db.get(
      'SELECT id, status, downloaded, eagle_linked, processing_lock FROM videos WHERE playlist_id = ? AND video_id = ?',
      [v.playlist_id, v.video_id]
    );
    
    if (existing) {
      console.log(`[DB] Video ${v.video_id} already exists with status: ${existing.status}, downloaded: ${existing.downloaded}, eagle_linked: ${existing.eagle_linked}`);
      
      // 이미 완전히 처리된 비디오인지 확인
      if (existing.downloaded && existing.eagle_linked) {
        console.log(`[DB] Video ${v.video_id} is already fully processed, skipping`);
        return null; // 이미 완전 처리된 경우
      }
      
      // 처리 중인 비디오인지 확인
      if (existing.processing_lock) {
        console.log(`[DB] Video ${v.video_id} is currently being processed, skipping`);
        return null;
      }
      
      // 기존 레코드가 있지만 완전 처리되지 않은 경우 업데이트
      const updateFields = {
        status: v.status || existing.status,
        downloaded: v.downloaded !== undefined ? (v.downloaded ? 1 : 0) : existing.downloaded,
        title: v.title || existing.title,
        failed_reason: v.failed_reason || null,
        first_attempt: v.first_attempt || existing.first_attempt,
        downloaded_at: v.downloaded_at || existing.downloaded_at,
        processing_lock: 1 // 처리 중으로 마킹
      };
      
      const sets = Object.keys(updateFields).map(k => `${k} = ?`).join(', ');
      const values = Object.values(updateFields);
      values.push(existing.id);
      
      await db.run(`UPDATE videos SET ${sets} WHERE id = ?`, ...values);
      console.log(`[DB] Updated existing video ${v.video_id} with processing lock`);
      return existing.id;
    }
    
    // 새 비디오 추가 (처리 락과 함께)
    const stmt = await db.run(
      `INSERT INTO videos (
        playlist_id, video_id, title, status, downloaded, auto_download,
        skip, eagle_linked, failed_reason, first_attempt, downloaded_at,
        is_duplicate, duplicate_check_date, master_video_id, source_playlist_url, 
        library_id, processing_lock
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.playlist_id, v.video_id, v.title, v.status || 'pending',
      v.downloaded ? 1 : 0, v.auto_download ? 1 : 0, v.skip ? 1 : 0,
      v.eagle_linked ? 1 : 0, v.failed_reason || null,
      v.first_attempt || null, v.downloaded_at || null,
      v.is_duplicate ? 1 : 0, v.duplicate_check_date || null,
      v.master_video_id || null, v.source_playlist_url || null,
      v.library_id || null, 1 // 처리 중으로 시작
    );
    
    console.log(`[DB] Added new video ${v.video_id} with processing lock`);
    return stmt.lastID;
  });
}

/**
 * 비디오 업데이트 (안전한 업데이트)
 */
async function updateVideo(id, fields) {
  return await withTransaction(async (db) => {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const values = Object.values(fields);
    values.push(id);
    await db.run(`UPDATE videos SET ${sets} WHERE id = ?`, ...values);
  });
}

/**
 * 비디오 처리 락 해제
 * @param {string} videoId - 비디오 ID
 */
async function releaseVideoProcessingLock(videoId) {
  try {
    await db.run('UPDATE videos SET processing_lock = 0 WHERE video_id = ?', [videoId]);
    console.log(`[DB] Released processing lock for video ${videoId}`);
  } catch (error) {
    console.error(`[DB] Error releasing processing lock for video ${videoId}:`, error);
  }
}

/**
 * 비디오 다운로드 완료로 마킹 (안전한 업데이트)
 * @param {string} videoId - 비디오 ID
 * @param {string} status - 새 상태 ('completed', 'failed' 등)
 * @param {string} failedReason - 실패 이유 (선택적)
 */
async function markVideoDownloadComplete(videoId, status = 'completed', failedReason = null) {
  return await withTransaction(async (db) => {
    const fields = {
      status: status,
      downloaded: status === 'completed' ? 1 : 0,
      downloaded_at: status === 'completed' ? new Date().toISOString() : null,
      failed_reason: failedReason,
      processing_lock: 0 // 처리 완료로 락 해제
    };
    
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const values = Object.values(fields);
    values.push(videoId);
    
    const result = await db.run(`UPDATE videos SET ${sets} WHERE video_id = ?`, ...values);
    console.log(`[DB] Marked video ${videoId} as ${status} (affected rows: ${result.changes})`);
    return result.changes > 0;
  });
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
  return await withTransaction(async (db) => {
    await db.run('DELETE FROM videos WHERE video_id = ?', videoId);
  });
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
 * video_id를 사용하여 특정 라이브러리의 영상의 eagle_linked 상태를 1로 업데이트합니다.
 * @param {string} videoId
 * @param {number} libraryId - 라이브러리 ID (선택적, 없으면 모든 라이브러리)
 */
async function markVideoAsEagleLinked(videoId, libraryId = null) {
  return await withTransaction(async (db) => {
    let query, params;
    
    if (libraryId !== null) {
      // 특정 라이브러리의 영상만 업데이트
      query = 'UPDATE videos SET eagle_linked = 1, processing_lock = 0 WHERE video_id = ? AND library_id = ?';
      params = [videoId, libraryId];
    } else {
      // 모든 라이브러리의 해당 영상 업데이트 (기존 동작 유지)
      query = 'UPDATE videos SET eagle_linked = 1, processing_lock = 0 WHERE video_id = ?';
      params = [videoId];
    }
    
    const result = await db.run(query, params);
    console.log(`[DB] Marked video ${videoId} as eagle_linked ${libraryId ? `(library: ${libraryId})` : '(all libraries)'} (affected rows: ${result.changes})`);
    return result.changes > 0;
  });
}

/**
 * 완전히 처리된 비디오 ID 목록 조회 (다운로드됨 + Eagle 연결됨)
 * @param {number} playlistId - 플레이리스트 ID
 * @returns {Promise<Array<string>>} 처리 완료된 비디오 ID 목록
 */
async function getCompletedVideoIds(playlistId) {
  try {
    // 디버깅: 전체 상태 확인
    const allVideos = await db.all(
      'SELECT video_id, status, downloaded, eagle_linked FROM videos WHERE playlist_id = ?',
      [playlistId]
    );
    console.log(`[DB Debug] Playlist ${playlistId} - 전체 영상 상태:`, allVideos);
    
    // 완전 처리된 영상만 조회
    const completedRows = await db.all(
      'SELECT video_id FROM videos WHERE playlist_id = ? AND downloaded = 1 AND eagle_linked = 1',
      [playlistId]
    );
    console.log(`[DB Debug] Playlist ${playlistId} - 완전 처리된 영상:`, completedRows.map(r => r.video_id));
    
    return completedRows.map(row => row.video_id);
  } catch (error) {
    console.error(`[DB Error] getCompletedVideoIds failed for playlist ${playlistId}:`, error);
    return [];
  }
}

/**
 * 처리 중이 아닌(락이 해제된) 비디오만 조회
 * @param {number} playlistId - 플레이리스트 ID
 * @returns {Promise<Array>} 처리 가능한 비디오 목록
 */
async function getProcessableVideos(playlistId) {
  return await db.all(
    'SELECT * FROM videos WHERE playlist_id = ? AND processing_lock = 0 ORDER BY id',
    [playlistId]
  );
}

/**
 * 데이터베이스 상태 정리 (오래된 처리 락 해제)
 * @param {number} olderThanHours - 몇 시간 이상 오래된 락을 해제할지 (기본 2시간)
 */
async function cleanupStaleProcessingLocks(olderThanHours = 2) {
  return await withTransaction(async (db) => {
    const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
    const result = await db.run(
      'UPDATE videos SET processing_lock = 0 WHERE processing_lock = 1 AND updated_at < ?',
      [cutoffTime]
    );
    if (result.changes > 0) {
      console.log(`[DB Cleanup] Released ${result.changes} stale processing locks older than ${olderThanHours} hours`);
    }
    return result.changes;
  });
}

// --- Added helpers for simplified flow ---
/**
 * 플레이리스트의 videos 카운트를 증분 업데이트합니다.
 * @param {number} playlistId
 * @param {number} delta
 */
async function incrementPlaylistVideos(playlistId, delta = 1) {
  return await withTransaction(async (db) => {
    await db.run('UPDATE playlists SET videos = COALESCE(videos, 0) + ? WHERE id = ?', [delta, playlistId]);
  });
}

/**
 * 플레이리스트 요약 필드를 업데이트합니다.
 * @param {number} id
 * @param {{last_checked?: string, videos_from_yt?: number}} fields
 */
async function updatePlaylistSummary(id, { last_checked, videos_from_yt } = {}) {
  const fields = {};
  if (last_checked !== undefined) fields.last_checked = last_checked;
  if (videos_from_yt !== undefined) fields.videos_from_yt = videos_from_yt;
  if (Object.keys(fields).length === 0) return;
  return updatePlaylist(id, fields);
}

// 라이브러리 추가
async function addLibrary(lib) {
  return await withTransaction(async (db) => {
    const stmt = await db.run(
      `INSERT OR IGNORE INTO libraries (name, path, modificationTime) VALUES (?, ?, ?)`,
      lib.name, lib.path, lib.modificationTime || null
    );
    if (stmt.lastID) return stmt.lastID;
    const row = await db.get(`SELECT id FROM libraries WHERE name = ?`, lib.name);
    return row.id;
  });
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
  return await withTransaction(async (db) => {
    await db.run(`UPDATE playlists SET library_id = ? WHERE library_id IS NULL`, libraryId);
    await db.run(`UPDATE videos SET library_id = ? WHERE library_id IS NULL`, libraryId);
  });
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
  assignItemsToLibrary,
  withTransaction,
  releaseVideoProcessingLock,
  markVideoDownloadComplete,
  getCompletedVideoIds,
  getProcessableVideos,
  cleanupStaleProcessingLocks,
  // added helpers
  incrementPlaylistVideos,
  updatePlaylistSummary
};
